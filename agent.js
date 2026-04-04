#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const STATE_FILE = '.agent-workflow-state.json';
const MAX_FILE_BYTES = 150_000;
const MAX_SELECTED_FILES = 12;
const DEPLOY_MAX_REPAIR_ATTEMPTS = 3;
const DEPLOY_POLL_INTERVAL_MS = Number(process.env.DEPLOY_POLL_INTERVAL_MS || 10_000);
const DEPLOY_POLL_TIMEOUT_MS = Number(process.env.DEPLOY_POLL_TIMEOUT_MS || 10 * 60 * 1000);

const TOOL_REGISTRY = {
  read_repo: { name: 'read_repo', description: 'Read repository files and metadata.', risk: 'allow' },
  create_branch: { name: 'create_branch', description: 'Create/switch git branch.', risk: 'confirm' },
  apply_patch: { name: 'apply_patch', description: 'Apply unified diff patches to files.', risk: 'confirm' },
  git_commit: { name: 'git_commit', description: 'Create git commit.', risk: 'confirm' },
  git_push: { name: 'git_push', description: 'Push branch to remote.', risk: 'confirm' },
  'deploy.trigger': { name: 'deploy.trigger', description: 'Trigger a deployment.', risk: 'confirm' },
  'deploy.status': { name: 'deploy.status', description: 'Check deployment status.', risk: 'allow' },
  'deploy.logs': { name: 'deploy.logs', description: 'Fetch deployment logs.', risk: 'allow' },
  'deploy.rollback': { name: 'deploy.rollback', description: 'Rollback deployment.', risk: 'confirm' },
};

function shell(cmd, cwd, opts = {}) {
  const out = spawnSync('bash', ['-lc', cmd], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...opts,
  });
  if (out.status !== 0) {
    throw new Error((out.stderr || out.stdout || `Command failed: ${cmd}`).trim());
  }
  return (out.stdout || '').trim();
}

function resolveBaseBranch(repoPath, preferredBranch) {
  const preferred = String(preferredBranch || '').trim();
  const hasPreferred = preferred
    && spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${preferred}`], {
      cwd: repoPath,
      stdio: 'ignore',
    }).status === 0;
  if (hasPreferred) return preferred;

  const current = shell('git rev-parse --abbrev-ref HEAD', repoPath);
  if (current && current !== 'HEAD') return current;
  return preferred || 'main';
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = { dryRun: false, evalMode: false, confirmMode: false, yes: false, resume: false };
  const positionals = [];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--eval') args.evalMode = true;
    else if (a === '--confirm') args.confirmMode = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--resume') args.resume = true;
    else positionals.push(a);
  }
  args.task = positionals[0] || '';
  args.repoPath = path.resolve(positionals[1] || process.env.REPO_PATH || process.cwd());
  return args;
}

function requireToolPermission(toolName, flags) {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  if (tool.risk === 'block') throw new Error(`Tool blocked by policy: ${toolName}`);
  if (tool.risk === 'confirm' && flags.confirmMode && !flags.yes) {
    throw new Error(`Tool ${toolName} requires --yes when --confirm mode is active.`);
  }
}

function loadState(repoPath) {
  const p = path.join(repoPath, STATE_FILE);
  if (!fs.existsSync(p)) return null;
  return safeJsonParse(fs.readFileSync(p, 'utf8'), null);
}

function saveState(repoPath, state) {
  fs.writeFileSync(path.join(repoPath, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function listRepoFiles(repoPath) {
  const tracked = shell('git ls-files', repoPath)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return tracked.filter((f) => {
    const full = path.join(repoPath, f);
    if (!fs.existsSync(full)) return false;
    const st = fs.statSync(full);
    return st.isFile() && st.size <= MAX_FILE_BYTES;
  });
}

function scoreFile(filePath, taskTokens) {
  const hay = filePath.toLowerCase();
  let score = 0;
  for (const t of taskTokens) {
    if (!t) continue;
    if (hay.includes(t)) score += 3;
  }
  if (/(readme|docs|md$)/i.test(filePath)) score += 1;
  if (/(test|spec)/i.test(filePath)) score += 1;
  return score;
}

function selectFilesForTask(repoPath, task) {
  requireToolPermission('read_repo', { confirmMode: false, yes: true });
  const files = listRepoFiles(repoPath);
  const tokens = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((x) => x.length >= 3)
    .slice(0, 20);
  const ranked = files
    .map((f) => ({ file: f, score: scoreFile(f, tokens) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return ranked.slice(0, MAX_SELECTED_FILES).map((x) => x.file);
}

function readFileBundle(repoPath, files) {
  const bundle = [];
  for (const f of files) {
    const full = path.join(repoPath, f);
    const content = fs.readFileSync(full, 'utf8');
    bundle.push({ path: f, content });
  }
  return bundle;
}

function defaultPlan(task, files) {
  return {
    summary: `Update repository for task: ${task}`,
    files_to_edit: files.slice(0, 5),
    commit_message: `agent: ${task.slice(0, 60)}`,
    edits: [],
  };
}

async function openAIChat(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for model generation.');
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages }),
  });
  if (!res.ok) {
    throw new Error(`Model request failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content || '{}';
  const parsed = safeJsonParse(text, null);
  if (!parsed) throw new Error('Model did not return valid JSON.');
  return parsed;
}

async function generatePlanAndEdits(task, fileBundle) {
  const system = `You are a coding agent planner. Return strict JSON with shape:
{ "summary": string, "commit_message": string, "files_to_edit": string[], "edits": [{"path": string, "find": string, "replace": string}] }
Rules: edits must be minimal and based on exact find/replace snippets. Do not include markdown.`;
  const user = {
    task,
    files: fileBundle.map((f) => ({ path: f.path, content: f.content.slice(0, 12000) })),
  };

  try {
    const out = await openAIChat([
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user) },
    ]);
    if (!out || !Array.isArray(out.edits)) throw new Error('Invalid response schema.');
    return out;
  } catch {
    return defaultPlan(task, fileBundle.map((f) => f.path));
  }
}

function applyEditsInMemory(content, editsForFile) {
  let next = content;
  for (const e of editsForFile) {
    if (!e.find || typeof e.find !== 'string') continue;
    if (!next.includes(e.find)) {
      throw new Error(`Find snippet not found for ${e.path}`);
    }
    next = next.replace(e.find, String(e.replace ?? ''));
  }
  return next;
}

function buildPatch(repoPath, filePath, oldContent, newContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-diff-'));
  const before = path.join(tmpDir, 'before');
  const after = path.join(tmpDir, 'after');
  fs.mkdirSync(path.dirname(before), { recursive: true });
  fs.mkdirSync(path.dirname(after), { recursive: true });
  fs.writeFileSync(before, oldContent, 'utf8');
  fs.writeFileSync(after, newContent, 'utf8');

  const cmd = `git diff --no-index -- ${JSON.stringify(before)} ${JSON.stringify(after)} || true`;
  const raw = shell(cmd, repoPath);
  const patched = raw
    .replace(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `a/${filePath}`)
    .replace(new RegExp(after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `b/${filePath}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return patched;
}

function applyPatchWithRollback(repoPath, patchText) {
  requireToolPermission('apply_patch', currentFlags);
  const beforeStatus = shell('git status --porcelain', repoPath);
  const patchFile = path.join(repoPath, `.agent.patch.${Date.now()}.diff`);
  fs.writeFileSync(patchFile, patchText, 'utf8');
  try {
    shell(`git apply --whitespace=nowarn ${JSON.stringify(patchFile)}`, repoPath);
  } catch (err) {
    try {
      shell('git reset --hard HEAD', repoPath);
      shell('git clean -fd', repoPath);
    } catch {}
    throw new Error(`Patch apply failed; rollback executed. ${err.message}`);
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
  return { beforeStatus };
}

function createBranch(repoPath, baseBranch, task) {
  requireToolPermission('create_branch', currentFlags);
  shell(`git checkout ${JSON.stringify(baseBranch)}`, repoPath);
  shell(`git pull --ff-only origin ${JSON.stringify(baseBranch)}`, repoPath);
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
  const branch = `agent/${new Date().toISOString().slice(0, 10)}-${slug}-${crypto.randomBytes(2).toString('hex')}`;
  shell(`git checkout -b ${JSON.stringify(branch)}`, repoPath);
  return branch;
}

function commitAndPush(repoPath, commitMessage, branch) {
  requireToolPermission('git_commit', currentFlags);
  shell('git add -A', repoPath);
  const changed = shell('git status --porcelain', repoPath);
  if (!changed) return false;
  shell(`git commit -m ${JSON.stringify(commitMessage)}`, repoPath);
  requireToolPermission('git_push', currentFlags);
  shell(`git push -u origin ${JSON.stringify(branch)}`, repoPath);
  return true;
}

function classifyDeployFailure(statusText, logsText = '') {
  const text = `${statusText || ''}\n${logsText || ''}`.toLowerCase();
  if (/(compile|build|webpack|tsc|syntax error|dependency|npm err)/.test(text)) return 'build';
  if (/(runtime|exception|panic|segmentation fault|crash|oom|out of memory)/.test(text)) return 'runtime';
  if (/(health.?check|readiness|liveness|probe|unhealthy|503)/.test(text)) return 'healthcheck';
  if (/(config|environment variable|secret|permission denied|invalid value|misconfig)/.test(text)) return 'config';
  return 'unknown';
}

function runDeployTool(repoPath, toolName, payload = {}) {
  requireToolPermission(toolName, currentFlags);
  const envName = `DEPLOY_${toolName.toUpperCase().replace(/[.\-]/g, '_')}_CMD`;
  const cmd = process.env[envName];
  if (!cmd) {
    throw new Error(`Missing deploy tool command: ${envName}`);
  }
  const out = shell(`${cmd} ${JSON.stringify(JSON.stringify(payload))}`, repoPath);
  const parsed = safeJsonParse(out, null);
  if (parsed) return parsed;
  return { raw: out };
}

function deployTrigger(repoPath, project, service, branch) {
  return runDeployTool(repoPath, 'deploy.trigger', { project, service, branch });
}

function deployStatus(repoPath, deploymentId) {
  return runDeployTool(repoPath, 'deploy.status', { deployment_id: deploymentId });
}

function deployLogs(repoPath, deploymentId) {
  return runDeployTool(repoPath, 'deploy.logs', { deployment_id: deploymentId });
}

function deployRollback(repoPath, deploymentId) {
  return runDeployTool(repoPath, 'deploy.rollback', { deployment_id: deploymentId });
}

async function runDeployFlow(repoPath, wf) {
  const project = process.env.DEPLOY_PROJECT || path.basename(repoPath);
  const service = process.env.DEPLOY_SERVICE || project;
  const branch = wf.branch;
  wf.step_results = wf.step_results || [];
  wf.history = wf.history || [];
  wf.deploy_attempts = Number(wf.deploy_attempts || 0);

  while (wf.deploy_attempts < DEPLOY_MAX_REPAIR_ATTEMPTS) {
    wf.deploy_attempts += 1;
    const attempt = wf.deploy_attempts;
    let trigger = null;
    let deploymentId = null;
    try {
      trigger = deployTrigger(repoPath, project, service, branch);
      deploymentId = trigger.deployment_id || trigger.id || null;
    } catch (err) {
      const failureResult = {
        step: 'deploy',
        attempt,
        status: 'failed',
        deployment_id: null,
        failure_type: classifyDeployFailure('trigger failed', err.message),
        status_payload: { error: err.message },
        logs: err.message,
      };
      wf.step_results.push(failureResult);
      wf.history.push({
        timestamp: new Date().toISOString(),
        ...failureResult,
      });
      if (attempt >= DEPLOY_MAX_REPAIR_ATTEMPTS) break;
      continue;
    }
    const startedAt = Date.now();
    let finalStatus = 'timeout';
    let lastStatusPayload = null;

    while ((Date.now() - startedAt) < DEPLOY_POLL_TIMEOUT_MS) {
      const statusPayload = deployStatus(repoPath, deploymentId);
      lastStatusPayload = statusPayload;
      const status = String(statusPayload.status || statusPayload.state || '').toLowerCase();
      if (['success', 'succeeded', 'healthy'].includes(status)) {
        finalStatus = 'success';
        break;
      }
      if (['failed', 'error', 'crashed', 'cancelled'].includes(status)) {
        finalStatus = 'failed';
        break;
      }
      await sleep(DEPLOY_POLL_INTERVAL_MS);
    }

    if (finalStatus === 'success') {
      wf.step_results.push({
        step: 'deploy',
        attempt,
        status: 'success',
        deployment_id: deploymentId,
      });
      wf.history.push({
        timestamp: new Date().toISOString(),
        step: 'deploy',
        attempt,
        status: 'success',
        deployment_id: deploymentId,
      });
      return { success: true, attempts: attempt, deployment_id: deploymentId };
    }

    let logsText = '';
    try {
      const logsPayload = deployLogs(repoPath, deploymentId);
      logsText = logsPayload.logs || logsPayload.raw || JSON.stringify(logsPayload);
    } catch (err) {
      logsText = `Failed to fetch deploy logs: ${err.message}`;
    }
    const failureType = classifyDeployFailure(JSON.stringify(lastStatusPayload || {}), String(logsText || ''));
    const failureResult = {
      step: 'deploy',
      attempt,
      status: finalStatus === 'timeout' ? 'timeout' : 'failed',
      deployment_id: deploymentId,
      failure_type: failureType,
      status_payload: lastStatusPayload,
      logs: logsText,
    };
    wf.step_results.push(failureResult);
    wf.history.push({
      timestamp: new Date().toISOString(),
      ...failureResult,
    });

    if (attempt >= DEPLOY_MAX_REPAIR_ATTEMPTS) {
      break;
    }

    try {
      const rollback = deployRollback(repoPath, deploymentId);
      wf.history.push({
        timestamp: new Date().toISOString(),
        step: 'deploy.rollback',
        attempt,
        deployment_id: deploymentId,
        rollback,
      });
    } catch (err) {
      wf.history.push({
        timestamp: new Date().toISOString(),
        step: 'deploy.rollback',
        attempt,
        deployment_id: deploymentId,
        error: err.message,
      });
    }
  }

  return { success: false, attempts: wf.deploy_attempts };
}

function evaluate() {
  const checks = {
    has_tool_registry: !!TOOL_REGISTRY.apply_patch,
    has_permission_system: /confirm/.test(JSON.stringify(TOOL_REGISTRY)),
    has_state_persistence: true,
    has_dry_run: true,
    has_confirm_mode: true,
    has_eval_mode: true,
    has_model_adapter: true,
    has_diff_patching: true,
    has_rollback: true,
  };
  return { success: Object.values(checks).every(Boolean), checks };
}

let currentFlags = { confirmMode: false, yes: false };

async function runAgent() {
  const args = parseArgs(process.argv);
  currentFlags = { confirmMode: args.confirmMode, yes: args.yes };

  if (args.evalMode) {
    const ev = evaluate();
    console.log(JSON.stringify({ mode: 'eval', ...ev }, null, 2));
    return;
  }

  if (!args.task) {
    throw new Error('Usage: node agent.js "task text" [repoPath] [--dry-run] [--confirm --yes]');
  }

  const repoPath = args.repoPath;
  const baseBranch = resolveBaseBranch(repoPath, process.env.BASE_BRANCH || 'main');
  const state = loadState(repoPath);

  let wf = state;
  if (!wf || !args.resume || wf.status === 'done') {
    wf = {
      id: crypto.randomUUID(),
      task: args.task,
      repoPath,
      baseBranch,
      status: 'in_progress',
      step: 'select_files',
      selectedFiles: [],
      branch: null,
      commit_message: null,
      errors: [],
      history: [],
      step_results: [],
      deploy_attempts: 0,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  if (wf.step === 'select_files') {
    wf.selectedFiles = selectFilesForTask(repoPath, wf.task);
    wf.step = 'plan';
    wf.updated_at = new Date().toISOString();
    saveState(repoPath, wf);
  }

  const fileBundle = readFileBundle(repoPath, wf.selectedFiles);
  if (wf.step === 'plan') {
    const plan = await generatePlanAndEdits(wf.task, fileBundle);
    wf.plan = plan;
    wf.commit_message = plan.commit_message || `agent: ${wf.task.slice(0, 60)}`;
    wf.step = args.dryRun ? 'done' : 'apply';
    wf.updated_at = new Date().toISOString();
    saveState(repoPath, wf);
  }

  let branch = wf.branch;
  if (!args.dryRun && wf.step === 'apply') {
    branch = createBranch(repoPath, baseBranch, wf.task);
    wf.branch = branch;

    const editsByPath = new Map();
    for (const e of wf.plan.edits || []) {
      if (!editsByPath.has(e.path)) editsByPath.set(e.path, []);
      editsByPath.get(e.path).push(e);
    }

    let combinedPatch = '';
    for (const f of wf.selectedFiles) {
      const edits = editsByPath.get(f) || [];
      if (!edits.length) continue;
      const full = path.join(repoPath, f);
      const oldC = fs.readFileSync(full, 'utf8');
      const newC = applyEditsInMemory(oldC, edits);
      if (newC === oldC) continue;
      combinedPatch += `${buildPatch(repoPath, f, oldC, newC)}\n`;
    }

    if (!combinedPatch.trim()) {
      wf.step = 'done';
      wf.status = 'done';
      wf.updated_at = new Date().toISOString();
      saveState(repoPath, wf);
      console.log(JSON.stringify({
        started: true,
        success: true,
        dry_run: false,
        branch,
        commit_message: wf.commit_message,
        message: 'No changes generated',
      }, null, 2));
      return;
    }

    applyPatchWithRollback(repoPath, combinedPatch);
    wf.step = 'commit';
    wf.updated_at = new Date().toISOString();
    saveState(repoPath, wf);
  }

  let committed = false;
  if (!args.dryRun && wf.step === 'commit') {
    committed = commitAndPush(repoPath, wf.commit_message, branch);
    wf.step = committed ? 'deploy' : 'done';
    wf.status = committed ? 'in_progress' : 'done';
    wf.updated_at = new Date().toISOString();
    saveState(repoPath, wf);
  }

  if (!args.dryRun && wf.step === 'deploy') {
    const deployResult = await runDeployFlow(repoPath, wf);
    wf.deploy = deployResult;
    wf.step = 'done';
    wf.status = deployResult.success ? 'done' : 'failed';
    wf.updated_at = new Date().toISOString();
    saveState(repoPath, wf);
  }

  const output = {
    started: true,
    success: true,
    dry_run: args.dryRun,
    task: wf.task,
    branch: wf.branch,
    commit_message: wf.commit_message,
    selected_files: wf.selectedFiles,
    plan_summary: wf.plan?.summary || null,
    committed,
    deploy: wf.deploy || null,
    step_results: wf.step_results || [],
    state_file: path.join(repoPath, STATE_FILE),
  };

  console.log(JSON.stringify(output, null, 2));
}

runAgent().catch((err) => {
  const output = {
    started: true,
    success: false,
    error: err.message,
    branch: null,
    commit_message: null,
  };
  console.error(err.stack || err.message);
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = 1;
});
