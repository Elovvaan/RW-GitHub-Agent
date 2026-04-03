#!/usr/bin/env node

/**
 * Repo-aware Git executor.
 *
 * Usage:
 *   node agent.js "<plain english task>" /absolute/or/relative/path/to/repo
 *
 * Environment variables:
 *   OPENAI_API_KEY   required
 *   OPENAI_MODEL     optional (default: gpt-5)
 *   OPENAI_BASE_URL  optional (default: https://api.openai.com/v1)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MIN_TREE_FILES = 20;
const MAX_TREE_FILES = 50;
const MAX_SELECTED_FILES = 12;
const MAX_FILE_BYTES = 80_000;

function run(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
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
    '{"commit_message":"string","files":[{"path":"relative/path","content":"full file content"}]}',
    'Rules:',
    '- Change only files needed for the task.',
    '- Prefer touching as few files as possible.',
    '- Do not include files that are unchanged.',
    '- Paths must be relative and must already exist in the repository unless task explicitly asks to create files.',
    '- Do not include markdown fences.',
    '- commit_message should be concise and imperative.',
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

async function callModel(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY in environment.');
  }

  const response = await fetch(`${DEFAULT_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
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

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Model returned non-JSON content: ${content}`);
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.files)) {
    throw new Error('Invalid model JSON shape. Expected object with files array.');
  }

  const commitMessage =
    typeof parsed.commit_message === 'string' && parsed.commit_message.trim().length > 0
      ? parsed.commit_message.trim()
      : 'Apply automated code updates';

  const files = parsed.files
    .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ path: f.path.trim(), content: f.content }));

  return { commitMessage, files };
}

function sanitizeBranchName(task) {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  return `fix/${slug || 'task'}`;
}

function checkoutTaskBranch(repoPath, task) {
  const branchBase = sanitizeBranchName(task);
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

function applyChanges(repoPath, updates, selectedPathsSet, allowCreate) {
  const changedPaths = [];

  for (const update of updates) {
    const rel = update.path.replace(/^\/+/, '');
    if (!rel || rel.includes('..')) {
      throw new Error(`Rejected unsafe path: ${update.path}`);
    }

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
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
    }

    const before = exists ? fs.readFileSync(full, 'utf8') : null;
    if (before === update.content) continue;

    fs.writeFileSync(full, update.content, 'utf8');
    changedPaths.push(rel);
  }

  return changedPaths;
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
  const task = process.argv[2];
  const repoInput = process.argv[3];

  if (!task || !repoInput) {
    console.error('Usage: node agent.js "<task>" <repo-path>');
    process.exit(1);
  }

  const repoPath = path.resolve(repoInput);
  ensureGitRepo(repoPath);

  const { scored, treeSample } = collectRepoTree(repoPath, task);
  const selected = selectRelevantFiles(repoPath, scored);
  const selectedPathsSet = new Set(selected.map((f) => f.path));

  const prompt = buildPrompt(task, treeSample, selected);
  const modelOut = await callModel(prompt);

  const branch = checkoutTaskBranch(repoPath, task);
  const allowCreate = taskAllowsCreatingFiles(task);
  const changedPaths = applyChanges(repoPath, modelOut.files, selectedPathsSet, allowCreate);

  if (changedPaths.length === 0) {
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

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
