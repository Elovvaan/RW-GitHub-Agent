#!/usr/bin/env node

/**
 * Repo-aware Git executor.
 *
 * Usage:
 *   node agent.js "<plain english task>" /absolute/or/relative/path/to/repo
 *
 * Environment variables:
 *   AGENT_MODEL_CONFIG_JSON optional JSON blob with provider + model settings
 *   AGENT_MODEL_CONFIG_PATH optional path to JSON config file
 *   AGENT_MODEL_PROVIDER    optional provider name override
 *
 * This script keeps the output JSON schema fixed to:
 *   { files, branch, commit_message }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const MIN_TREE_FILES = 20;
const MAX_TREE_FILES = 50;
const MAX_SELECTED_FILES = 12;
const MAX_FILE_BYTES = 80_000;
const MAX_PATCH_CHANGED_LINES = 200;
const DEFAULT_MAX_CHANGED_FILES = 5;
const TASK_HISTORY_FILE = '.agent.task-history.json';

const DEFAULT_MODEL_CONFIG = {
  provider: 'openai',
  model: {
    name: 'gpt-5',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    baseUrlEnv: 'OPENAI_BASE_URL',
    modelEnv: 'OPENAI_MODEL',
    capabilities: {
      jsonOutput: true,
      chatCompletions: true,
    },
  },
};

function run(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function parseArgs(argv) {
  const positionals = [];
  const opts = {
    dryRun: false,
    requireConfirm: false,
    confirmed: false,
    overrideMaxFiles: false,
    maxFilesChanged: DEFAULT_MAX_CHANGED_FILES,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--confirm') {
      opts.requireConfirm = true;
    } else if (arg === '--yes') {
      opts.confirmed = true;
    } else if (arg === '--override-max-files') {
      opts.overrideMaxFiles = true;
    } else if (arg.startsWith('--max-files=')) {
      opts.maxFilesChanged = Number(arg.split('=')[1]);
    } else if (arg === '--max-files') {
      opts.maxFilesChanged = Number(argv[i + 1]);
      i += 1;
    } else {
      positionals.push(arg);
    }
  }

  if (!Number.isInteger(opts.maxFilesChanged) || opts.maxFilesChanged < 1) {
    throw new Error(`Invalid --max-files value: ${opts.maxFilesChanged}`);
  }

  return { positionals, opts };
}

function appendTaskHistory(repoPath, entry) {
  const historyPath = path.join(repoPath, TASK_HISTORY_FILE);
  let history = [];
  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (!Array.isArray(history)) history = [];
    } catch {
      history = [];
    }
  }

  history.push({ timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n', 'utf8');
}

function ensureGitRepo(repoPath) {
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }
  const isRepo = run('git rev-parse --is-inside-work-tree', repoPath);
  if (isRepo !== 'true') {
    throw new Error(`Not a git repository: ${repoPath}`);
  }
}

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9_\-/\.]+/g) || []).filter((t) => t.length > 2).slice(0, 100);
}

function isProbablyText(buffer) {
  for (let i = 0; i < Math.min(buffer.length, 2048); i += 1) {
    if (buffer[i] === 0) return false;
  }
  return true;
}

function scoreFilesForTask(files, task) {
  const taskTokens = tokenize(task);
  return files
    .map((file) => {
      const lower = file.toLowerCase();
      const base = path.basename(lower);
      let score = 0;

      for (const token of taskTokens) {
        if (lower.includes(token)) score += 2;
        if (base.includes(token)) score += 3;
      }

      if (base === 'readme.md') score += 1;
      if (base === 'package.json') score += 1;
      if (base.includes('agent')) score += 1;

      return { file, score };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

function collectRepoTree(repoPath, task) {
  const tracked = run('git ls-files', repoPath)
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  if (tracked.length === 0) {
    throw new Error('Repository has no tracked files.');
  }

  const scored = scoreFilesForTask(tracked, task);
  const cap = Math.min(MAX_TREE_FILES, tracked.length);
  const target = tracked.length >= MIN_TREE_FILES ? Math.max(MIN_TREE_FILES, cap) : cap;

  const topRelevant = scored.slice(0, Math.min(target, scored.length)).map((x) => x.file);
  const unique = new Set(topRelevant);

  for (const file of tracked) {
    if (unique.size >= target) break;
    unique.add(file);
  }

  return { tracked, scored, treeSample: Array.from(unique).slice(0, cap) };
}

function selectRelevantFiles(repoPath, scoredFiles) {
  const candidates = scoredFiles
    .filter((x) => x.score > 0)
    .slice(0, MAX_SELECTED_FILES)
    .map((x) => x.file);

  const selected = [];
  for (const rel of candidates) {
    const full = path.join(repoPath, rel);
    if (!fs.existsSync(full)) continue;

    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

    const buf = fs.readFileSync(full);
    if (!isProbablyText(buf)) continue;

    selected.push({ path: rel, content: buf.toString('utf8') });
  }

  if (selected.length === 0) {
    throw new Error('No relevant readable text files selected. Refine the task wording.');
  }

  return selected;
}

function buildPrompt(task, treeSample, selectedFiles) {
  return [
    'You are a senior software engineer making minimal, repo-aware edits.',
    'Return strict JSON with this exact shape and nothing else:',
    '{"files":[{"path":"relative/path","diff":"unified diff patch for this file"}],"branch":"string","commit_message":"string"}',
    'Rules:',
    '- Change only files needed for the task.',
    '- Prefer touching as few files as possible.',
    '- Do not include files that are unchanged.',
    '- Return unified diffs only, never full file contents.',
    '- Each diff must be line-based and patchable.',
    '- Paths must be relative and must already exist in the repository unless task explicitly asks to create files.',
    '- Do not include markdown fences.',
    '- commit_message should be concise and imperative.',
    '- branch should be a short branch name suggestion for this task.',
    '',
    `Task: ${task}`,
    '',
    `Repository tree sample (${treeSample.length} files):`,
    JSON.stringify(treeSample, null, 2),
    '',
    'Selected relevant files (full content):',
    JSON.stringify(selectedFiles, null, 2),
  ].join('\n');
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function mergeModelConfig(base, override) {
  const merged = {
    ...base,
    ...(override || {}),
    model: {
      ...base.model,
      ...((override && override.model) || {}),
      capabilities: {
        ...base.model.capabilities,
        ...((override && override.model && override.model.capabilities) || {}),
      },
    },
  };

  if (process.env.AGENT_MODEL_PROVIDER) {
    merged.provider = process.env.AGENT_MODEL_PROVIDER;
  }
  if (merged.model.modelEnv && process.env[merged.model.modelEnv]) {
    merged.model.name = process.env[merged.model.modelEnv];
  }
  if (merged.model.baseUrlEnv && process.env[merged.model.baseUrlEnv]) {
    merged.model.baseUrl = process.env[merged.model.baseUrlEnv];
  }

  return merged;
}

function loadModelConfig() {
  let override = null;

  if (process.env.AGENT_MODEL_CONFIG_JSON) {
    override = JSON.parse(process.env.AGENT_MODEL_CONFIG_JSON);
  } else if (process.env.AGENT_MODEL_CONFIG_PATH) {
    const configPath = path.resolve(process.env.AGENT_MODEL_CONFIG_PATH);
    override = readJsonFile(configPath);
  }

  return mergeModelConfig(DEFAULT_MODEL_CONFIG, override);
}

async function openAIChatCompletionsAdapter(prompt, modelConfig) {
  const apiKeyEnv = modelConfig.model.apiKeyEnv;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${apiKeyEnv} in environment.`);
  }

  const endpoint = `${modelConfig.model.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const payload = {
    model: modelConfig.model.name,
    temperature: 0,
    messages: [
      { role: 'system', content: 'You output strict JSON only.' },
      { role: 'user', content: prompt },
    ],
  };

  if (modelConfig.model.capabilities.jsonOutput) {
    payload.response_format = { type: 'json_object' };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Model API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Model response missing choices[0].message.content');
  }

  return content;
}

const MODEL_ADAPTERS = {
  openai: openAIChatCompletionsAdapter,
  openai_compatible: openAIChatCompletionsAdapter,
};

function normalizePatchResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.files)) {
    throw new Error('Invalid model JSON shape. Expected object with files array.');
  }

  const branch =
    typeof parsed.branch === 'string' && parsed.branch.trim().length > 0 ? parsed.branch.trim() : null;

  const commitMessage =
    typeof parsed.commit_message === 'string' && parsed.commit_message.trim().length > 0
      ? parsed.commit_message.trim()
      : 'Apply automated code updates';

  const files = parsed.files
    .filter((f) => f && typeof f.path === 'string' && typeof f.diff === 'string')
    .map((f) => ({ path: f.path.trim(), diff: f.diff }));

  return { branch, commitMessage, files };
}

async function generatePatch(task, files, modelConfig) {
  const prompt = buildPrompt(task, files.treeSample, files.selectedFiles);
  const providerKey = String(modelConfig.provider || '').toLowerCase();
  const adapter = MODEL_ADAPTERS[providerKey];

  if (!adapter) {
    const providers = Object.keys(MODEL_ADAPTERS).join(', ');
    throw new Error(`Unsupported provider "${modelConfig.provider}". Supported providers: ${providers}`);
  }

  const rawContent = await adapter(prompt, modelConfig);

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error(`Model returned non-JSON content: ${rawContent}`);
  }

  return normalizePatchResponse(parsed);
}

function sanitizeBranchName(task) {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  return `fix/${slug || 'task'}`;
}

function checkoutTaskBranch(repoPath, task, requestedBranch) {
  const branchBase = sanitizeBranchName(requestedBranch || task);
  let branch = branchBase;
  let counter = 2;

  while (true) {
    const exists = run(`git branch --list '${branch}'`, repoPath);
    if (!exists) break;
    branch = `${branchBase}-${counter}`;
    counter += 1;
  }

  run(`git checkout -b '${branch}'`, repoPath);
  return branch;
}

function taskAllowsCreatingFiles(task) {
  const lower = task.toLowerCase();
  return /\b(create|add|new file|new files|scaffold|generate)\b/.test(lower);
}

function taskAllowsLargeDiff(task) {
  const lower = task.toLowerCase();
  return /\b(allow large diff|allow big diff|more than 200 lines|> ?200 lines|over 200 lines)\b/.test(lower);
}

function normalizeRelPath(rawPath) {
  const rel = rawPath.replace(/^\/+/, '').replace(/\\/g, '/');
  if (!rel || rel.includes('..')) {
    throw new Error(`Rejected unsafe path: ${rawPath}`);
  }
  return rel;
}

function extractTouchedFilesFromPatch(diffText) {
  const touched = new Set();
  const lines = diffText.split('\n');
  for (const line of lines) {
    let match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      touched.add(normalizeRelPath(match[2]));
      continue;
    }
    match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) {
      touched.add(normalizeRelPath(match[1]));
      continue;
    }
    match = line.match(/^\+\+\+ (.+)$/);
    if (match && match[1] !== '/dev/null') {
      touched.add(normalizeRelPath(match[1]));
    }
  }
  return touched;
}

function countChangedPatchLines(diffText) {
  return diffText.split('\n').reduce((count, line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return count;
    if (line.startsWith('+') || line.startsWith('-')) return count + 1;
    return count;
  }, 0);
}

function ensureUnifiedPatchForFile(rel, diffText) {
  if (/^diff --git /m.test(diffText)) return diffText;
  if (/^--- /m.test(diffText) && /^\+\+\+ /m.test(diffText)) return diffText;
  return [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`, diffText].join('\n');
}

function applyDiffChanges(repoPath, updates, selectedPathsSet, allowCreate, allowLargeDiff) {
  const patchChunks = [];
  const changedPaths = new Set();

  for (const update of updates) {
    const rel = normalizeRelPath(update.path);
    if (!selectedPathsSet.has(rel)) {
      throw new Error(`Rejected path outside selected relevant files: ${rel}`);
    }

    const full = path.join(repoPath, rel);
    const exists = fs.existsSync(full);
    if (!exists && !allowCreate) {
      throw new Error(`Rejected new file without explicit request: ${rel}`);
    }
    if (exists) {
      const stat = fs.statSync(full);
      if (!stat.isFile()) {
        throw new Error(`Rejected non-file path: ${rel}`);
      }
    }

    const patchText = ensureUnifiedPatchForFile(rel, update.diff);
    const touchedFiles = extractTouchedFilesFromPatch(patchText);
    if (touchedFiles.size === 0) {
      throw new Error(`Diff for ${rel} does not include patch headers or file targets.`);
    }
    for (const touched of touchedFiles) {
      if (touched !== rel) {
        throw new Error(`Rejected diff touching extra file ${touched}; expected only ${rel}`);
      }
      if (!selectedPathsSet.has(touched)) {
        throw new Error(`Rejected diff touching unselected file: ${touched}`);
      }
    }

    const changedLineCount = countChangedPatchLines(patchText);
    if (!allowLargeDiff && changedLineCount > MAX_PATCH_CHANGED_LINES) {
      throw new Error(
        `Rejected diff for ${rel}: ${changedLineCount} changed lines exceeds limit ${MAX_PATCH_CHANGED_LINES}`,
      );
    }

    patchChunks.push(patchText.trimEnd());
    changedPaths.add(rel);
  }

  if (patchChunks.length === 0) return [];

  const combinedPatch = `${patchChunks.join('\n\n')}\n`;
  console.log('Diff preview (before apply):');
  console.log(combinedPatch);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-patch-'));
  const tmpPatch = path.join(tempDir, 'generated.patch');
  fs.writeFileSync(tmpPatch, combinedPatch, 'utf8');

  const changedPathsList = Array.from(changedPaths);
  const beforeHashes = {};
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-backup-'));
  const createdFiles = [];

  for (const rel of changedPathsList) {
    const full = path.join(repoPath, rel);
    if (fs.existsSync(full)) {
      const backupPath = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(full, backupPath);
      beforeHashes[rel] = hashFile(full);
    } else {
      beforeHashes[rel] = null;
      createdFiles.push(rel);
    }
  }

  console.log('File hashes before apply:');
  for (const rel of changedPathsList) {
    console.log(` - ${rel}: ${beforeHashes[rel] || '(new file)'}`);
  }

  let applySucceeded = false;
  try {
    run(`git apply --check --whitespace=nowarn '${tmpPatch}'`, repoPath);
    run(`git apply --whitespace=nowarn '${tmpPatch}'`, repoPath);
    applySucceeded = true;
  } catch (err) {
    for (const rel of changedPathsList) {
      const full = path.join(repoPath, rel);
      const backupPath = path.join(backupDir, rel);
      if (fs.existsSync(backupPath)) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.copyFileSync(backupPath, full);
      } else if (createdFiles.includes(rel) && fs.existsSync(full)) {
        fs.unlinkSync(full);
      }
    }
    console.error('Patch apply failed. Rolled back files from backup.');
    throw err;
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  }

  if (applySucceeded) {
    console.log('File hashes after apply:');
    for (const rel of changedPathsList) {
      const full = path.join(repoPath, rel);
      const after = fs.existsSync(full) ? hashFile(full) : '(deleted)';
      console.log(` - ${rel}: ${after}`);
    }
  }

  return changedPathsList;
}

function ensureNotProtectedBranch(repoPath) {
  const current = run('git rev-parse --abbrev-ref HEAD', repoPath);
  if (current === 'main' || current === 'master') {
    throw new Error(`Refusing to commit on protected branch: ${current}`);
  }
}

function commitAndPush(repoPath, commitMessage) {
  ensureNotProtectedBranch(repoPath);
  run('git add .', repoPath);

  const staged = run('git diff --cached --name-only', repoPath)
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  if (staged.length === 0) {
    return null;
  }

  run(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, repoPath);

  const branch = run('git rev-parse --abbrev-ref HEAD', repoPath);
  run(`git push -u origin '${branch}'`, repoPath);

  return {
    branch,
    commit_message: commitMessage,
    files: staged,
  };
}

async function main() {
  const { positionals, opts } = parseArgs(process.argv);
  const task = positionals[0];
  const repoInput = positionals[1];

  if (!task || !repoInput) {
    console.error(
      'Usage: node agent.js [--dry-run] [--confirm --yes] [--max-files N] [--override-max-files] "<task>" <repo-path>',
    );
    process.exit(1);
  }

  const repoPath = path.resolve(repoInput);
  ensureGitRepo(repoPath);

  const modelConfig = loadModelConfig();
  const { scored, treeSample } = collectRepoTree(repoPath, task);
  const selectedFiles = selectRelevantFiles(repoPath, scored);
  const selectedPathsSet = new Set(selectedFiles.map((f) => f.path));

  let branch = null;
  const modelOut = await generatePatch(task, { treeSample, selectedFiles }, modelConfig);

  if (!opts.overrideMaxFiles && modelOut.files.length > opts.maxFilesChanged) {
    throw new Error(
      `Patch touches ${modelOut.files.length} files, exceeding max ${opts.maxFilesChanged}. Use --override-max-files to allow.`,
    );
  }

  branch = checkoutTaskBranch(repoPath, task, modelOut.branch);
  const allowCreate = taskAllowsCreatingFiles(task);
  const allowLargeDiff = taskAllowsLargeDiff(task);
  const patchChunks = modelOut.files.map((f) => ensureUnifiedPatchForFile(normalizeRelPath(f.path), f.diff).trimEnd());
  const patchPreview = patchChunks.length ? `${patchChunks.join('\n\n')}\n` : '';

  if (opts.dryRun) {
    console.log('Dry-run mode enabled. Diff preview (no apply):');
    console.log(patchPreview);
    appendTaskHistory(repoPath, {
      task,
      branch,
      status: 'dry_run',
      files: modelOut.files.map((f) => f.path),
    });
    return;
  }

  if (opts.requireConfirm && !opts.confirmed) {
    console.log('Confirmation required. Re-run with --confirm --yes to apply changes.');
    console.log('Diff preview (not applied):');
    console.log(patchPreview);
    appendTaskHistory(repoPath, {
      task,
      branch,
      status: 'awaiting_confirmation',
      files: modelOut.files.map((f) => f.path),
    });
    return;
  }

  const changedPaths = applyDiffChanges(repoPath, modelOut.files, selectedPathsSet, allowCreate, allowLargeDiff);

  if (changedPaths.length === 0) {
    appendTaskHistory(repoPath, {
      task,
      branch,
      status: 'no_changes',
      files: [],
    });
    console.log(
      JSON.stringify(
        {
          files: [],
          branch,
          commit_message: modelOut.commitMessage,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('Changed files before commit:');
  for (const file of changedPaths) {
    console.log(` - ${file}`);
  }

  const result = commitAndPush(repoPath, modelOut.commitMessage);
  if (!result) {
    appendTaskHistory(repoPath, {
      task,
      branch,
      status: 'no_staged_changes',
      files: [],
    });
    console.log(
      JSON.stringify(
        {
          files: [],
          branch,
          commit_message: modelOut.commitMessage,
        },
        null,
        2,
      ),
    );
    return;
  }

  appendTaskHistory(repoPath, {
    task,
    branch: result.branch,
    status: 'committed',
    files: result.files,
    commit_message: result.commit_message,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
