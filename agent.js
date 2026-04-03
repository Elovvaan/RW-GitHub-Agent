#!/usr/bin/env node

/**
 * Minimal internal GitHub coding executor.
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
  return (s.toLowerCase().match(/[a-z0-9_\-/\.]+/g) || [])
    .filter((t) => t.length > 2)
    .slice(0, 80);
}

function isProbablyText(buffer) {
  for (let i = 0; i < Math.min(buffer.length, 2048); i += 1) {
    if (buffer[i] === 0) return false;
  }
  return true;
}

function pickFiles(repoPath, task) {
  const tracked = run('git ls-files', repoPath)
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  const taskTokens = tokenize(task);
  const scored = tracked.map((file) => {
    const l = file.toLowerCase();
    const base = path.basename(l);
    let score = 0;
    for (const t of taskTokens) {
      if (l.includes(t)) score += 2;
      if (base.includes(t)) score += 3;
    }
    if (base === 'readme.md') score += 1;
    return { file, score };
  });

  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const candidates = scored
    .filter((x) => x.score > 0)
    .map((x) => x.file)
    .slice(0, MAX_SELECTED_FILES);

  const fallback = tracked.slice(0, Math.max(1, Math.min(5, MAX_SELECTED_FILES)));
  const chosen = candidates.length > 0 ? candidates : fallback;

  const selected = [];
  for (const rel of chosen) {
    const full = path.join(repoPath, rel);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const buf = fs.readFileSync(full);
    if (!isProbablyText(buf)) continue;
    selected.push({ path: rel, content: buf.toString('utf8') });
  }

  if (selected.length === 0) {
    throw new Error('No readable text files selected from repository.');
  }

  return selected;
}

function buildPrompt(task, selectedFiles) {
  return [
    'You are a senior software engineer. Update only files needed for the task.',
    'Return strict JSON with this shape and nothing else:',
    '{"commitMessage":"string","files":[{"path":"relative/path","content":"full file content"}]}',
    'Rules:',
    '- Only include files that should be changed.',
    '- Keep paths relative to repository root.',
    '- Do not include markdown fences.',
    '- Commit message should be concise and imperative.',
    '',
    `Task: ${task}`,
    '',
    'Repository files provided for context:',
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
  } catch (e) {
    throw new Error(`Model returned non-JSON content: ${content}`);
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.files)) {
    throw new Error('Invalid model JSON shape. Expected object with files array.');
  }

  const commitMessage =
    typeof parsed.commitMessage === 'string' && parsed.commitMessage.trim().length > 0
      ? parsed.commitMessage.trim()
      : 'Apply automated code updates';

  return {
    commitMessage,
    files: parsed.files
      .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
      .map((f) => ({ path: f.path.trim(), content: f.content })),
  };
}

function checkoutBranchFromMain(repoPath) {
  run('git fetch origin main', repoPath);
  run('git checkout main', repoPath);
  run('git pull --ff-only origin main', repoPath);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const branch = `agent/${stamp}`;
  run(`git checkout -b ${branch}`, repoPath);
  return branch;
}

function applyChanges(repoPath, updates) {
  const changedPaths = [];
  for (const u of updates) {
    const rel = u.path.replace(/^\/+/, '');
    if (!rel || rel.includes('..')) {
      throw new Error(`Rejected unsafe path: ${u.path}`);
    }

    const full = path.join(repoPath, rel);
    const dir = path.dirname(full);
    fs.mkdirSync(dir, { recursive: true });

    const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    if (before === u.content) continue;

    fs.writeFileSync(full, u.content, 'utf8');
    changedPaths.push(rel);
  }
  return changedPaths;
}

function ensureNotMain(repoPath) {
  const current = run('git rev-parse --abbrev-ref HEAD', repoPath);
  if (current === 'main' || current === 'master') {
    throw new Error(`Refusing to commit on protected branch: ${current}`);
  }
}

function commitAndPush(repoPath, changedPaths, commitMessage) {
  ensureNotMain(repoPath);
  if (changedPaths.length === 0) return null;

  const quoted = changedPaths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
  run(`git add ${quoted}`, repoPath);
  run(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, repoPath);

  const branch = run('git rev-parse --abbrev-ref HEAD', repoPath);
  run(`git push -u origin ${branch}`, repoPath);
  const sha = run('git rev-parse HEAD', repoPath);

  return { branch, sha, commitMessage };
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

  const selected = pickFiles(repoPath, task);
  const prompt = buildPrompt(task, selected);
  const modelOut = await callModel(prompt);

  checkoutBranchFromMain(repoPath);
  const changedPaths = applyChanges(repoPath, modelOut.files);

  if (changedPaths.length === 0) {
    console.log('No file changes proposed by model.');
    return;
  }

  const result = commitAndPush(repoPath, changedPaths, modelOut.commitMessage);

  console.log('Changed files:');
  for (const f of changedPaths) console.log(` - ${f}`);
  console.log(`Branch: ${result.branch}`);
  console.log(`Commit: ${result.sha}`);
  console.log(`Message: ${result.commitMessage}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
