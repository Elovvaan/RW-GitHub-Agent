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
const DEFAULT_MAX_STEPS = 5;
const TASK_HISTORY_FILE = '.agent.task-history.json';
const WORKFLOW_STATE_FILE = '.agent.workflow-state.json';

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

const TOOLS = Object.freeze({
  git_checkout_branch: {
    name: 'git_checkout_branch',
    description: 'Create and switch to a task branch.',
    risk: 'medium',
  },
  git_apply_patch: {
    name: 'git_apply_patch',
    description: 'Apply generated patch content to repository files.',
    risk: 'medium',
  },
  git_commit: {
    name: 'git_commit',
    description: 'Create a commit from staged changes.',
    risk: 'medium',
  },
  git_push: {
    name: 'git_push',
    description: 'Push local branch commits to remote origin.',
    risk: 'high',
  },
  file_delete: {
    name: 'file_delete',
    description: 'Delete files from the working tree during rollback cleanup.',
    risk: 'high',
  },
});

const PERMISSIONS = Object.freeze({
  low: 'allow',
  medium: 'allow',
  high: 'confirm',
});

function run(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function assertPermission(actionName, opts) {
  const action = TOOLS[actionName];
  if (!action) {
    throw new Error(`Unknown action "${actionName}". Add it to TOOLS registry.`);
  }

  const requiredApproval = PERMISSIONS[action.risk];
  if (!requiredApproval) {
    throw new Error(`No permission mapping defined for risk level "${action.risk}".`);
  }

  if (requiredApproval === 'block') {
    throw new Error(`Action blocked by policy: ${action.name}`);
  }

  if (requiredApproval === 'confirm') {
    if (opts?.dryRun) {
      throw new Error(`Action blocked in dry-run mode: ${action.name}`);
    }
    if (!(opts?.requireConfirm && opts?.confirmed)) {
      throw new Error(
        `Action "${action.name}" requires confirmation. Re-run with --confirm --yes to allow high-risk actions.`,
      );
    }
  }
}

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function parseArgs(argv) {
  const positionals = [];
  const opts = {
    evalMode: false,
    dryRun: false,
    requireConfirm: false,
    confirmed: false,
    overrideMaxFiles: false,
    maxFilesChanged: DEFAULT_MAX_CHANGED_FILES,
    overrideMaxSteps: false,
    maxSteps: DEFAULT_MAX_STEPS,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--eval') {
      opts.evalMode = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--confirm') {
      opts.requireConfirm = true;
    } else if (arg === '--yes') {
      opts.confirmed = true;
    } else if (arg === '--override-max-files') {
      opts.overrideMaxFiles = true;
    } else if (arg === '--override-max-steps') {
      opts.overrideMaxSteps = true;
    } else if (arg.startsWith('--max-files=')) {
      opts.maxFilesChanged = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--max-steps=')) {
      opts.maxSteps = Number(arg.split('=')[1]);
    } else if (arg === '--max-files') {
      opts.maxFilesChanged = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--max-steps') {
      opts.maxSteps = Number(argv[i + 1]);
      i += 1;
    } else {
      positionals.push(arg);
    }
  }

  if (!Number.isInteger(opts.maxFilesChanged) || opts.maxFilesChanged < 1) {
    throw new Error(`Invalid --max-files value: ${opts.maxFilesChanged}`);
  }
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1) {
    throw new Error(`Invalid --max-steps value: ${opts.maxSteps}`);
  }

  return { positionals, opts };
}

function runEvaluation() {
  const source = fs.readFileSync(__filename, 'utf8');

  function has(pattern) {
    return pattern.test(source);
  }

  function finding({ category, check, present, severityIfMissing, risks, fixes, evidence }) {
    return {
      category,
      check,
      status: present ? 'present' : 'missing',
      severity: present ? 'none' : severityIfMissing,
      risks: present ? [] : risks,
      suggested_fixes: present ? [] : fixes,
      evidence,
    };
  }

  const primitiveFindings = [
    finding({
      category: 'state',
      check: 'workflow_state_tracking',
      present:
        has(/WORKFLOW_STATE_FILE/) &&
        has(/function loadWorkflowState\(/) &&
        has(/function saveWorkflowState\(/) &&
        has(/function createWorkflowState\(/),
      severityIfMissing: 'high',
      risks: ['Cannot resume interrupted workflows.', 'No reliable execution state for multi-step plans.'],
      fixes: [
        'Define a persistent workflow state file.',
        'Implement load/save helpers and initialize state before execution.',
      ],
      evidence: ['WORKFLOW_STATE_FILE', 'loadWorkflowState', 'saveWorkflowState', 'createWorkflowState'],
    }),
    finding({
      category: 'permissions',
      check: 'risk_mapped_permissions',
      present: has(/const TOOLS = Object\.freeze/) && has(/const PERMISSIONS = Object\.freeze/) && has(/function assertPermission\(/),
      severityIfMissing: 'critical',
      risks: ['Unsafe operations may execute without checks.', 'High-risk actions may bypass confirmation gates.'],
      fixes: [
        'Define a central tool registry with risk classifications.',
        'Enforce approval mapping in a shared permission assertion function.',
      ],
      evidence: ['TOOLS', 'PERMISSIONS', 'assertPermission'],
    }),
    finding({
      category: 'limits',
      check: 'operational_limits_defined',
      present:
        has(/MAX_PATCH_CHANGED_LINES/) &&
        has(/DEFAULT_MAX_CHANGED_FILES/) &&
        has(/DEFAULT_MAX_STEPS/) &&
        has(/countChangedPatchLines\(/),
      severityIfMissing: 'high',
      risks: ['Unbounded changes can create oversized patches.', 'Model output may touch too many files or steps.'],
      fixes: [
        'Add hard caps for changed lines, changed files, and plan steps.',
        'Validate limits before applying or committing changes.',
      ],
      evidence: ['MAX_PATCH_CHANGED_LINES', 'DEFAULT_MAX_CHANGED_FILES', 'DEFAULT_MAX_STEPS', 'countChangedPatchLines'],
    }),
    finding({
      category: 'recovery',
      check: 'rollback_and_resume_controls',
      present: has(/Patch apply failed\. Rolled back files from backup\./) && has(/loadWorkflowState\(/) && has(/completedSteps/),
      severityIfMissing: 'high',
      risks: ['Failed patch apply can leave repository in partial state.', 'Interrupted workflows cannot safely continue.'],
      fixes: [
        'Snapshot touched files and restore on apply failure.',
        'Persist progress markers for completed steps and current position.',
      ],
      evidence: ['backup/rollback logic in applyDiffChanges', 'workflow resume via completedSteps/currentStep'],
    }),
  ];

  const guardrailFindings = [
    finding({
      category: 'guardrail',
      check: 'destructive_actions_confirmation',
      present: has(/file_delete[\s\S]*risk:\s*'high'/) && has(/requiredApproval === 'confirm'/),
      severityIfMissing: 'critical',
      risks: ['Destructive cleanup may run without explicit user consent.'],
      fixes: ['Mark destructive actions as high risk and require --confirm --yes before execution.'],
      evidence: ['TOOLS.file_delete risk=high', 'assertPermission confirm gate'],
    }),
    finding({
      category: 'guardrail',
      check: 'patch_limits_enforced',
      present: has(/changedLineCount > MAX_PATCH_CHANGED_LINES/) && has(/modelOut\.files\.length > opts\.maxFilesChanged/),
      severityIfMissing: 'high',
      risks: ['Generated patches may exceed safe review/apply size.'],
      fixes: ['Reject oversized diffs by line count and cap files per step unless explicitly overridden.'],
      evidence: ['MAX_PATCH_CHANGED_LINES check', 'max files changed check'],
    }),
    finding({
      category: 'guardrail',
      check: 'git_safety_controls',
      present: has(/ensureGitRepo\(/) && has(/ensureNotProtectedBranch\(/) && has(/git apply --check/),
      severityIfMissing: 'high',
      risks: ['Commands may run outside a repository.', 'Commits may be created on protected branches.'],
      fixes: ['Validate git work-tree context.', 'Block commits on main/master.', 'Preflight patch validity with git apply --check.'],
      evidence: ['ensureGitRepo', 'ensureNotProtectedBranch', 'git apply --check'],
    }),
  ];

  const findings = [...primitiveFindings, ...guardrailFindings];
  const severityRank = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  const highestSeverity = findings.reduce((max, item) => {
    return severityRank[item.severity] > severityRank[max] ? item.severity : max;
  }, 'none');

  return {
    mode: 'evaluation',
    summary: {
      total_checks: findings.length,
      missing_checks: findings.filter((f) => f.status === 'missing').length,
      highest_severity: highestSeverity,
      guardrail_checks: guardrailFindings.length,
      primitive_checks: primitiveFindings.length,
    },
    findings,
  };
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

function getWorkflowStatePath(repoPath) {
  return path.join(repoPath, WORKFLOW_STATE_FILE);
}

function loadWorkflowState(repoPath) {
  const workflowPath = getWorkflowStatePath(repoPath);
  if (!fs.existsSync(workflowPath)) return null;
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.plan)) return null;
  if (!Array.isArray(parsed.completedSteps)) return null;
  return parsed;
}

function saveWorkflowState(repoPath, state) {
  const workflowPath = getWorkflowStatePath(repoPath);
  fs.writeFileSync(workflowPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function createWorkflowState(plan) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    status: 'planned',
    currentStep: 0,
    plan,
    completedSteps: [],
  };
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

function buildPlanPrompt(task, treeSample, selectedFiles, maxSteps) {
  return [
    'You are a senior software engineer planning a safe, incremental implementation.',
    'Return strict JSON with this exact shape and nothing else:',
    '{"plan":["step 1","step 2"],"branch":"string","commit_message":"string"}',
    'Rules:',
    `- Create an ordered plan with at most ${maxSteps} steps.`,
    '- Keep each step independently executable and testable.',
    '- Keep steps concrete and specific to this repository.',
    '- Do not include markdown fences.',
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

function normalizePlanResponse(parsed, fallbackTask) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plan)) {
    throw new Error('Invalid model JSON shape. Expected object with plan array.');
  }

  const plan = parsed.plan
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean);

  if (plan.length === 0) {
    return {
      plan: [fallbackTask],
      branch: null,
      commitMessage: 'Apply automated code updates',
    };
  }

  const branch =
    typeof parsed.branch === 'string' && parsed.branch.trim().length > 0 ? parsed.branch.trim() : null;

  const commitMessage =
    typeof parsed.commit_message === 'string' && parsed.commit_message.trim().length > 0
      ? parsed.commit_message.trim()
      : 'Apply automated code updates';

  return { plan, branch, commitMessage };
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

async function generatePlan(task, files, modelConfig, maxSteps) {
  const prompt = buildPlanPrompt(task, files.treeSample, files.selectedFiles, maxSteps);
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

  return normalizePlanResponse(parsed, task);
}

function sanitizeBranchName(task) {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  return `fix/${slug || 'task'}`;
}

function checkoutTaskBranch(repoPath, task, requestedBranch, opts) {
  assertPermission('git_checkout_branch', opts);
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

function applyDiffChanges(repoPath, updates, selectedPathsSet, allowCreate, allowLargeDiff, opts) {
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
    assertPermission('git_apply_patch', opts);
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
        assertPermission('file_delete', opts);
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

function commitAndPush(repoPath, commitMessage, opts) {
  ensureNotProtectedBranch(repoPath);
  run('git add .', repoPath);

  const staged = run('git diff --cached --name-only', repoPath)
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  if (staged.length === 0) {
    return null;
  }

  assertPermission('git_commit', opts);
  run(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, repoPath);

  const branch = run('git rev-parse --abbrev-ref HEAD', repoPath);
  assertPermission('git_push', opts);
  run(`git push -u origin '${branch}'`, repoPath);

  return {
    branch,
    commit_message: commitMessage,
    files: staged,
  };
}

async function main() {
  const { positionals, opts } = parseArgs(process.argv);
  if (opts.evalMode) {
    console.log(JSON.stringify(runEvaluation(), null, 2));
    return;
  }

  const task = positionals[0];
  const repoInput = positionals[1];

  if (!task || !repoInput) {
    console.error(
      'Usage: node agent.js [--eval] [--dry-run] [--confirm --yes] [--max-files N] [--override-max-files] [--max-steps N] [--override-max-steps] "<task>" <repo-path>',
    );
    process.exit(1);
  }

  const repoPath = path.resolve(repoInput);
  ensureGitRepo(repoPath);

  const modelConfig = loadModelConfig();
  let workflowState = loadWorkflowState(repoPath);
  let planOut = null;
  let branch = null;
  let plan = null;

  if (
    workflowState &&
    (workflowState.status === 'planned' || workflowState.status === 'executing') &&
    workflowState.currentStep < workflowState.plan.length
  ) {
    plan = workflowState.plan;
    branch = workflowState.branch || null;
    if (branch) {
      run(`git checkout '${branch}'`, repoPath);
    }
    console.log(
      `Resuming workflow ${workflowState.id} from step ${workflowState.currentStep + 1}/${workflowState.plan.length}`,
    );
    planOut = {
      commitMessage: workflowState.commitMessage || 'Apply automated code updates',
      branch,
    };
  } else {
    const { scored, treeSample } = collectRepoTree(repoPath, task);
    const selectedFiles = selectRelevantFiles(repoPath, scored);
    planOut = await generatePlan(task, { treeSample, selectedFiles }, modelConfig, opts.maxSteps);
    if (!opts.overrideMaxSteps && planOut.plan.length > opts.maxSteps) {
      throw new Error(
        `Plan has ${planOut.plan.length} steps, exceeding max ${opts.maxSteps}. Use --override-max-steps to allow.`,
      );
    }
    plan = opts.overrideMaxSteps ? planOut.plan : planOut.plan.slice(0, opts.maxSteps);
    branch = checkoutTaskBranch(repoPath, task, planOut.branch, opts);
    workflowState = createWorkflowState(plan);
    workflowState.branch = branch;
    workflowState.task = task;
    workflowState.commitMessage = planOut.commitMessage;
    saveWorkflowState(repoPath, workflowState);
  }

  const allowCreate = taskAllowsCreatingFiles(task);
  const allowLargeDiff = taskAllowsLargeDiff(task);
  const allChangedPaths = new Set();
  const stepResults = [];

  if (opts.requireConfirm && !opts.confirmed) {
    console.log('Confirmation required. Re-run with --confirm --yes to apply changes.');
    console.log('Planned steps (not applied):');
    for (let i = 0; i < plan.length; i += 1) {
      console.log(` ${i + 1}. ${plan[i]}`);
    }
    appendTaskHistory(repoPath, {
      task,
      branch,
      status: 'awaiting_confirmation',
      plan,
    });
    return;
  }

  workflowState.status = 'executing';
  saveWorkflowState(repoPath, workflowState);

  for (let index = 0; index < plan.length; index += 1) {
    if (workflowState.completedSteps.includes(index)) {
      stepResults.push({ step: plan[index], status: 'skipped_already_completed', files: [] });
      workflowState.currentStep = Math.max(workflowState.currentStep, index + 1);
      saveWorkflowState(repoPath, workflowState);
      continue;
    }
    if (index < workflowState.currentStep) {
      stepResults.push({ step: plan[index], status: 'skipped_previously_advanced', files: [] });
      continue;
    }

    const step = plan[index];
    const stepTask = `Overall task: ${task}\nCurrent step ${index + 1}/${plan.length}: ${step}`;
    const stepTree = collectRepoTree(repoPath, stepTask);
    const stepSelectedFiles = selectRelevantFiles(repoPath, stepTree.scored);
    const selectedPathsSet = new Set(stepSelectedFiles.map((f) => f.path));
    const modelOut = await generatePatch(stepTask, { treeSample: stepTree.treeSample, selectedFiles: stepSelectedFiles }, modelConfig);

    if (!opts.overrideMaxFiles && modelOut.files.length > opts.maxFilesChanged) {
      throw new Error(
        `Step ${index + 1} patch touches ${modelOut.files.length} files, exceeding max ${opts.maxFilesChanged}. Use --override-max-files to allow.`,
      );
    }

    const patchChunks = modelOut.files.map((f) =>
      ensureUnifiedPatchForFile(normalizeRelPath(f.path), f.diff).trimEnd(),
    );
    const patchPreview = patchChunks.length ? `${patchChunks.join('\n\n')}\n` : '';

    if (opts.dryRun) {
      console.log(`Dry-run mode enabled. Step ${index + 1} diff preview (no apply):`);
      console.log(patchPreview);
      stepResults.push({ step, status: 'dry_run', files: modelOut.files.map((f) => f.path) });
      workflowState.completedSteps.push(index);
      workflowState.currentStep = index + 1;
      saveWorkflowState(repoPath, workflowState);
      continue;
    }

    try {
      const changedPaths = applyDiffChanges(
        repoPath,
        modelOut.files,
        selectedPathsSet,
        allowCreate,
        allowLargeDiff,
        opts,
      );
      for (const changedPath of changedPaths) allChangedPaths.add(changedPath);
      stepResults.push({ step, status: changedPaths.length ? 'applied' : 'no_changes', files: changedPaths });
      workflowState.completedSteps.push(index);
      workflowState.currentStep = index + 1;
      saveWorkflowState(repoPath, workflowState);
      appendTaskHistory(repoPath, {
        task,
        branch,
        status: 'step_completed',
        step_index: index + 1,
        step,
        files: changedPaths,
      });
      for (const changedPath of changedPaths) {
        const fullPath = path.join(repoPath, changedPath);
        if (fs.existsSync(fullPath)) {
          fs.readFileSync(fullPath, 'utf8');
        }
      }
    } catch (err) {
      stepResults.push({ step, status: 'failed', error: err.message });
      workflowState.status = 'failed';
      workflowState.currentStep = index;
      saveWorkflowState(repoPath, workflowState);
      appendTaskHistory(repoPath, {
        task,
        branch,
        status: 'step_failed',
        step_index: index + 1,
        step,
        error: err.message,
      });
      throw err;
    }
  }

  const changedPaths = Array.from(allChangedPaths);

  if (changedPaths.length === 0) {
    workflowState.status = 'completed';
    workflowState.currentStep = plan.length;
    saveWorkflowState(repoPath, workflowState);
    appendTaskHistory(repoPath, {
      task,
      branch,
      status: 'no_changes',
      files: [],
      plan,
      step_results: stepResults,
    });
    console.log(
      JSON.stringify(
        {
          files: [],
          branch,
          commit_message: planOut.commitMessage,
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

  const result = commitAndPush(repoPath, planOut.commitMessage, opts);
  if (!result) {
    workflowState.status = 'completed';
    workflowState.currentStep = plan.length;
    saveWorkflowState(repoPath, workflowState);
    appendTaskHistory(repoPath, {
      task,
      branch,
      status: 'no_staged_changes',
      files: [],
      plan,
      step_results: stepResults,
    });
    console.log(
      JSON.stringify(
        {
          files: [],
          branch,
          commit_message: planOut.commitMessage,
        },
        null,
        2,
      ),
    );
    return;
  }

  workflowState.status = 'completed';
  workflowState.currentStep = plan.length;
  saveWorkflowState(repoPath, workflowState);
  appendTaskHistory(repoPath, {
    task,
    branch: result.branch,
    status: 'committed',
    files: result.files,
    commit_message: result.commit_message,
    plan,
    step_results: stepResults,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
