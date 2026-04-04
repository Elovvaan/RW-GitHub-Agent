#!/usr/bin/env node

const http = require('http');
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const MAX_BODY_BYTES = 8 * 1024;
const AGENT_PATH = path.resolve(__dirname, 'agent.js');
const REPO_PATH = path.resolve(process.env.REPO_PATH || process.cwd());
const DEPLOYMENT_LOG_LIMIT = 400;
const DEPLOY_PORT_START = Number(process.env.DEPLOY_PORT_START || 4100);
const DEPLOY_PORT_END = Number(process.env.DEPLOY_PORT_END || 4999);
const CONTAINER_INTERNAL_PORT = Number(process.env.CONTAINER_INTERNAL_PORT || 3000);
const HEALTHCHECK_PATH = process.env.HEALTHCHECK_PATH || '/health';
const HEALTHCHECK_ATTEMPTS = Number(process.env.HEALTHCHECK_ATTEMPTS || 15);
const HEALTHCHECK_INTERVAL_MS = Number(process.env.HEALTHCHECK_INTERVAL_MS || 2000);
const DOCKER_LOG_TAIL = Number(process.env.DOCKER_LOG_TAIL || 250);
const WORKER_URL = String(process.env.WORKER_URL || '').trim().replace(/\/$/, '');
const WORKER_TOKEN = String(process.env.WORKER_TOKEN || '').trim();
const WORKER_TIMEOUT_MS = Number(process.env.WORKER_TIMEOUT_MS || 45_000);
const DEPLOYMENTS_DB_PATH = path.resolve(process.env.DEPLOYMENTS_DB_PATH || path.join(__dirname, 'deployments.sqlite'));

let db;
const latestDeploymentCache = new Map();
const servicePortMap = new Map();
let deploymentCounter = 1;

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(text, fallback) {
  try {
    const parsed = JSON.parse(String(text || ''));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function deploymentFromRow(row) {
  return {
    id: row.id,
    project: row.project,
    service: row.service,
    status: row.status,
    imageTag: row.imageTag || null,
    containerId: row.containerId || null,
    assignedPort: Number.isFinite(row.assignedPort) ? row.assignedPort : null,
    logs: safeJsonParse(row.logs, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    branch: null,
    commitSha: null,
    url: row.assignedPort ? `http://127.0.0.1:${row.assignedPort}` : null,
    errorSummary: null,
    containerName: row.project && row.service ? `${sanitizeName(row.project)}-${sanitizeName(row.service)}` : null,
    domain: buildRouteDomain(row.project, row.service),
    commands: [],
    testCommands: [],
    lastExitCode: null,
    worker: null,
  };
}

function writeDeploymentRow(deployment) {
  db.prepare(`
    INSERT INTO deployments (id, project, service, status, imageTag, containerId, assignedPort, logs, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      service = excluded.service,
      status = excluded.status,
      imageTag = excluded.imageTag,
      containerId = excluded.containerId,
      assignedPort = excluded.assignedPort,
      logs = excluded.logs,
      updatedAt = excluded.updatedAt
  `).run(
    deployment.id,
    deployment.project,
    deployment.service,
    deployment.status,
    deployment.imageTag,
    deployment.containerId,
    deployment.assignedPort,
    JSON.stringify(deployment.logs || []),
    deployment.createdAt,
    deployment.updatedAt,
  );
  latestDeploymentCache.set(`${deployment.project}/${deployment.service}`, deploymentFromRow({
    id: deployment.id,
    project: deployment.project,
    service: deployment.service,
    status: deployment.status,
    imageTag: deployment.imageTag,
    containerId: deployment.containerId,
    assignedPort: deployment.assignedPort,
    logs: JSON.stringify(deployment.logs || []),
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
  }));
}

function getDeploymentById(deploymentId) {
  const row = db.prepare(`
    SELECT id, project, service, status, imageTag, containerId, assignedPort, logs, createdAt, updatedAt
    FROM deployments
    WHERE id = ?
  `).get(deploymentId);
  return row ? deploymentFromRow(row) : null;
}

function getLatestDeployment() {
  const row = db.prepare(`
    SELECT id, project, service, status, imageTag, containerId, assignedPort, logs, createdAt, updatedAt
    FROM deployments
    ORDER BY updatedAt DESC
    LIMIT 1
  `).get();
  return row ? deploymentFromRow(row) : null;
}

function hydrateInMemoryState() {
  latestDeploymentCache.clear();
  servicePortMap.clear();
  const rows = db.prepare(`
    SELECT id, project, service, status, imageTag, containerId, assignedPort, logs, createdAt, updatedAt
    FROM deployments
    ORDER BY updatedAt DESC
  `).all();
  for (const row of rows) {
    const key = `${row.project}/${row.service}`;
    if (!latestDeploymentCache.has(key)) {
      latestDeploymentCache.set(key, deploymentFromRow(row));
    }
    if (row.assignedPort) {
      servicePortMap.set(`${sanitizeName(row.project)}-${sanitizeName(row.service)}`, row.assignedPort);
    }
  }
}

function initDatabase() {
  db = new Database(DEPLOYMENTS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      service TEXT NOT NULL,
      status TEXT NOT NULL,
      imageTag TEXT,
      containerId TEXT,
      assignedPort INTEGER,
      logs TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_deployments_project_service_updated
    ON deployments(project, service, updatedAt DESC);
  `);

  const counterRow = db.prepare(`
    SELECT id
    FROM deployments
    WHERE id LIKE 'dep_%'
    ORDER BY CAST(SUBSTR(id, 5) AS INTEGER) DESC
    LIMIT 1
  `).get();
  if (counterRow?.id) {
    const parsed = Number(counterRow.id.slice(4));
    if (Number.isFinite(parsed)) deploymentCounter = parsed + 1;
  }

  hydrateInMemoryState();
}

function makeDeploymentId() {
  const id = String(deploymentCounter).padStart(4, '0');
  deploymentCounter += 1;
  return `dep_${id}`;
}

function sanitizeName(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'service';
}

function writeDeploymentLog(deployment, line) {
  deployment.logs.push(`[${nowIso()}] ${line}`);
  if (deployment.logs.length > DEPLOYMENT_LOG_LIMIT) {
    deployment.logs.shift();
  }
  deployment.updatedAt = nowIso();
  writeDeploymentRow(deployment);
}

function setDeploymentStatus(deployment, status) {
  deployment.status = status;
  deployment.updatedAt = nowIso();
  writeDeploymentRow(deployment);
}

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RW → GitHub → Railway Pipeline</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07101f;
      --panel: #101c31;
      --panel-2: #0c1527;
      --panel-border: #24324b;
      --text: #e5ecfb;
      --muted: #9fb0d1;
      --accent: #60a5fa;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
      --idle: #94a3b8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: radial-gradient(circle at top, #1a2c50 0%, var(--bg) 45%);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1300px;
      margin: 0 auto;
      padding: 20px 16px 26px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(1.3rem, 1.5vw + 1rem, 2rem);
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    .subtitle {
      margin: 0 0 16px;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .top-actions {
      margin-bottom: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .pipeline {
      display: grid;
      grid-template-columns: repeat(5, minmax(210px, 1fr));
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .stage {
      background: linear-gradient(180deg, #13223d 0%, var(--panel-2) 100%);
      border: 1px solid var(--panel-border);
      border-radius: 12px;
      min-height: 340px;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 10px;
      padding: 12px;
      position: relative;
      box-shadow: 0 8px 22px rgba(0,0,0,0.2);
    }
    .stage:not(:last-child)::after {
      content: '→';
      position: absolute;
      right: -9px;
      top: 50%;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      color: #bfdbfe;
      background: #182845;
      border: 1px solid #2c4672;
      font-size: 12px;
      z-index: 2;
    }
    .stage-title {
      margin: 0;
      font-size: 0.98rem;
      font-weight: 700;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .stage-num {
      font-size: 0.72rem;
      color: #bfd5ff;
      background: #1b2f52;
      border: 1px solid #34558d;
      border-radius: 999px;
      padding: 2px 7px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .badge.idle { color: #dbeafe; background: rgba(148,163,184,0.18); border-color: rgba(148,163,184,0.5); }
    .badge.running { color: #fde68a; background: rgba(245,158,11,0.2); border-color: rgba(245,158,11,0.45); }
    .badge.success { color: #bbf7d0; background: rgba(34,197,94,0.18); border-color: rgba(34,197,94,0.45); }
    .badge.failed { color: #fecaca; background: rgba(239,68,68,0.18); border-color: rgba(239,68,68,0.45); }
    .meta {
      margin: 0;
      font-size: 0.78rem;
      color: var(--muted);
    }
    pre {
      margin: 0;
      overflow: auto;
      padding: 9px;
      border-radius: 8px;
      background: #091222;
      border: 1px solid #23334f;
      color: #c7f0ff;
      font-size: 0.74rem;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 130px;
    }
    .form {
      display: grid;
      gap: 8px;
    }
    .dual {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    label {
      display: grid;
      gap: 4px;
      font-size: 0.74rem;
      color: var(--muted);
    }
    input, textarea {
      width: 100%;
      border-radius: 8px;
      border: 1px solid #2b3a57;
      background: #0a1322;
      color: var(--text);
      padding: 8px 9px;
      font-size: 0.82rem;
      font-family: inherit;
    }
    textarea {
      min-height: 92px;
      resize: vertical;
    }
    button {
      appearance: none;
      border: 1px solid #3a5ea8;
      background: linear-gradient(180deg, #3f74d6, #355fb1);
      color: white;
      border-radius: 10px;
      padding: 9px 11px;
      font-weight: 650;
      font-size: 0.82rem;
      cursor: pointer;
    }
    button.secondary {
      border-color: #3f4a5f;
      background: linear-gradient(180deg, #202c44, #172036);
      color: #c8d5ef;
    }
    button:disabled { opacity: 0.55; cursor: progress; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .url-box {
      background: #081426;
      border: 1px solid #28436c;
      border-radius: 10px;
      padding: 9px;
      font-size: 0.81rem;
      color: #cfe4ff;
      word-break: break-all;
      min-height: 62px;
      display: flex;
      align-items: center;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>RW → GitHub → Railway Pipeline</h1>
    <p class="subtitle">Submit a build request, generate code, push to GitHub, deploy on Railway, and open the live app.</p>
    <div class="top-actions">
      <button id="btn-refresh" class="secondary">Refresh Pipeline Status</button>
      <span id="global-status" class="badge idle">Idle</span>
    </div>
    <section class="pipeline">
      <article class="stage">
        <h2 class="stage-title">Request <span class="stage-num">Stage 1</span></h2>
        <span id="badge-request" class="badge idle">idle</span>
        <p class="meta">Describe what RW should build.</p>
        <div class="form">
          <label>Build request
            <textarea id="input-task">Build a minimal app and return deploy status.</textarea>
          </label>
        </div>
        <div class="actions">
          <button id="btn-run">Start Flow</button>
        </div>
      </article>
      <article class="stage">
        <h2 class="stage-title">Generate Code <span class="stage-num">Stage 2</span></h2>
        <span id="badge-generate" class="badge idle">idle</span>
        <p class="meta">Run RW code generation and capture Git metadata.</p>
        <pre id="json-generate">{}</pre>
        <div class="meta" id="meta-generate">Repo: pending</div>
      </article>
      <article class="stage">
        <h2 class="stage-title">Push to GitHub <span class="stage-num">Stage 3</span></h2>
        <span id="badge-push" class="badge idle">idle</span>
        <p class="meta">Simulated push details from branch and commit SHA.</p>
        <pre id="json-github">{}</pre>
        <div class="meta" id="meta-github">Branch: pending · Commit: pending</div>
      </article>
      <article class="stage">
        <h2 class="stage-title">Deploy on Railway <span class="stage-num">Stage 4</span></h2>
        <span id="badge-railway" class="badge idle">idle</span>
        <p class="meta">Uses existing deployment trigger and status logic.</p>
        <div class="form dual">
          <label>Project
            <input id="input-project" value="demo-project" />
          </label>
          <label>Service
            <input id="input-service" value="phone-runner" />
          </label>
          <label>Branch
            <input id="input-branch" value="main" />
          </label>
          <label>Commit SHA
            <input id="input-commitSha" value="0000000000000000000000000000000000000000" />
          </label>
        </div>
        <pre id="json-deployment">{}</pre>
        <div class="actions">
          <button id="btn-trigger">Deploy on Railway</button>
        </div>
      </article>
      <article class="stage">
        <h2 class="stage-title">Live App <span class="stage-num">Stage 5</span></h2>
        <span id="badge-live" class="badge idle">idle</span>
        <p class="meta">Final URL from the latest successful deployment.</p>
        <div id="live-url" class="url-box">No live URL yet.</div>
        <pre id="json-route">{}</pre>
        <div class="actions">
          <button id="btn-open" class="secondary" disabled>Open Live App</button>
        </div>
      </article>
    </section>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    let latestLiveUrl = '';

    function pretty(value) {
      return JSON.stringify(value ?? null, null, 2);
    }
    function setJson(id, payload) {
      const el = $(id);
      if (el) el.textContent = pretty(payload);
    }
    function setStageState(id, state) {
      const el = $(id);
      if (!el) return;
      const normalized = ['idle', 'running', 'success', 'failed'].includes(state) ? state : 'idle';
      el.textContent = normalized;
      el.className = 'badge ' + normalized;
    }
    function setGlobalState(state, label) {
      const el = $('global-status');
      const normalized = ['idle', 'running', 'success', 'failed'].includes(state) ? state : 'idle';
      el.textContent = label || normalized;
      el.className = 'badge ' + normalized;
    }
    function setLiveUrl(url) {
      latestLiveUrl = String(url || '').trim();
      $('live-url').textContent = latestLiveUrl || 'No live URL yet.';
      $('btn-open').disabled = !latestLiveUrl;
      setStageState('badge-live', latestLiveUrl ? 'success' : 'idle');
    }
    async function fetchJson(url, options) {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    }
    function shortCommit(sha) {
      const text = String(sha || '').trim();
      return text ? text.slice(0, 7) : 'pending';
    }
    async function refreshRouteAndDeployment() {
      const routeResult = await fetchJson('/route');
      setJson('json-route', routeResult.data);
      const liveFromRoute = Array.isArray(routeResult.data.routes) && routeResult.data.routes[0]
        ? 'http://' + routeResult.data.routes[0].domain
        : '';

      const depResult = await fetchJson('/deployments/latest');
      setJson('json-deployment', depResult.data);
      const dep = depResult.data || {};
      const depStatus = String(dep.status || '').toLowerCase();
      if (depStatus === 'success') {
        setStageState('badge-railway', 'success');
      } else if (depStatus === 'failed') {
        setStageState('badge-railway', 'failed');
      } else if (depStatus) {
        setStageState('badge-railway', 'running');
      } else {
        setStageState('badge-railway', 'idle');
      }
      setLiveUrl(dep.url || liveFromRoute || '');
    }
    async function runGenerate() {
      setStageState('badge-request', 'success');
      setStageState('badge-generate', 'running');
      setStageState('badge-push', 'idle');
      setStageState('badge-live', 'idle');
      setGlobalState('running', 'Flow running');

      const payload = { task: $('input-task').value.trim() || 'Echo a short status update and exit.' };
      try {
        const result = await fetchJson('/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        setJson('json-generate', result.data);
        if (!result.ok || !result.data || result.data.success === false) {
          setStageState('badge-generate', 'failed');
          setStageState('badge-push', 'failed');
          setGlobalState('failed', 'Flow failed');
          return;
        }
        setStageState('badge-generate', 'success');
        const branch = String(result.data.branch || $('input-branch').value || 'main');
        $('input-branch').value = branch;
        const commitSha = String(($('input-commitSha').value || '').trim());
        $('meta-generate').textContent = 'Repo: ' + (location.hostname || 'local') + ' · Branch: ' + branch;

        const githubData = {
          repo: location.hostname || 'local-repo',
          branch,
          commit: commitSha,
          commitMessage: result.data.commit_message || 'Generated by RW pipeline',
          status: 'pushed',
        };
        setJson('json-github', githubData);
        $('meta-github').textContent = 'Branch: ' + branch + ' · Commit: ' + shortCommit(commitSha);
        setStageState('badge-push', 'success');
        setGlobalState('running', 'Ready to deploy');
      } catch (err) {
        setJson('json-generate', { error: String(err && err.message || err) });
        setStageState('badge-generate', 'failed');
        setStageState('badge-push', 'failed');
        setGlobalState('failed', 'Flow failed');
      }
    }
    async function triggerDeployment() {
      const button = $('btn-trigger');
      button.disabled = true;
      setStageState('badge-railway', 'running');
      setGlobalState('running', 'Deploying on Railway');
      const payload = {
        project: $('input-project').value.trim(),
        service: $('input-service').value.trim(),
        branch: $('input-branch').value.trim(),
        commitSha: $('input-commitSha').value.trim(),
      };
      try {
        const result = await fetchJson('/deployments/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        setJson('json-deployment', result.data);
        setStageState('badge-railway', result.ok ? 'success' : 'failed');
        await refreshRouteAndDeployment();
        setGlobalState(result.ok ? 'success' : 'failed', result.ok ? 'Pipeline ready' : 'Deploy failed');
      } catch (err) {
        setJson('json-deployment', { error: String(err && err.message || err) });
        setStageState('badge-railway', 'failed');
        setGlobalState('failed', 'Deploy failed');
      } finally {
        button.disabled = false;
      }
    }
    async function refreshAll() {
      setGlobalState('running', 'Refreshing');
      try {
        await refreshRouteAndDeployment();
        const health = await fetchJson('/health');
        const worker = !!(health.data && health.data.workerConfigured);
        if (!worker) setStageState('badge-request', 'idle');
        setGlobalState('idle', 'Idle');
      } catch (err) {
        setJson('json-github', { error: String(err && err.message || err) });
        setGlobalState('failed', 'Refresh failed');
      }
    }
    function openLiveApp() {
      if (latestLiveUrl) window.open(latestLiveUrl, '_blank', 'noopener');
    }

    $('btn-run').addEventListener('click', runGenerate);
    $('btn-trigger').addEventListener('click', triggerDeployment);
    $('btn-refresh').addEventListener('click', refreshAll);
    $('btn-open').addEventListener('click', openLiveApp);
    refreshAll();
  </script>
</body>
</html>`;
}

function buildRouteDomain(project, service) {
  return `${sanitizeName(service)}.${sanitizeName(project)}.local`;
}

function extractHostName(hostHeader) {
  const value = String(hostHeader || '').trim();
  if (!value) return '';
  return value.replace(/:\d+$/, '').toLowerCase();
}

function collectActiveRoutes() {
  return Array.from(latestDeploymentCache.values())
    .filter((deployment) => deployment.assignedPort)
    .filter((deployment) => deployment.status === 'success' || deployment.status === 'health_check' || deployment.status === 'running')
    .map((deployment) => ({
      domain: deployment.domain || buildRouteDomain(deployment.project, deployment.service),
      project: deployment.project,
      service: deployment.service,
      port: deployment.assignedPort,
      deploymentId: deployment.id,
      status: deployment.status,
      updatedAt: deployment.updatedAt,
    }));
}

function findRouteByHost(hostHeader) {
  const hostName = extractHostName(hostHeader);
  if (!hostName) return null;
  const routes = collectActiveRoutes();
  return routes.find((route) => route.domain === hostName) || null;
}

function extractJson(stdoutText) {
  const lines = String(stdoutText || '').trim();
  const idx = lines.lastIndexOf('{');
  if (idx < 0) return null;
  try {
    return JSON.parse(lines.slice(idx));
  } catch {
    return null;
  }
}

function runTask(task) {
  return new Promise((resolve) => {
    const args = [AGENT_PATH, task, REPO_PATH, '--confirm', '--yes'];
    execFile(process.execPath, args, { cwd: REPO_PATH, maxBuffer: 15 * 1024 * 1024 }, (error, stdout, stderr) => {
      const parsed = extractJson(stdout);
      if (error) {
        resolve({
          started: true,
          success: false,
          error: (parsed && parsed.error) || String(stderr || error.message || 'Agent failed').trim(),
          branch: parsed?.branch || null,
          commit_message: parsed?.commit_message || null,
        });
        return;
      }
      resolve({
        started: true,
        success: !!parsed?.success,
        error: parsed?.error || null,
        branch: parsed?.branch || null,
        commit_message: parsed?.commit_message || null,
      });
    });
  });
}

function readJsonBody(req, res, onBody) {
  let size = 0;
  const chunks = [];

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      sendJson(res, 413, { error: 'body_too_large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    try {
      onBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
    }
  });
}

function chooseAssignedPort(serviceName) {
  const existing = servicePortMap.get(serviceName);
  if (existing) return existing;

  for (let port = DEPLOY_PORT_START; port <= DEPLOY_PORT_END; port += 1) {
    if ([...servicePortMap.values()].includes(port)) continue;
    servicePortMap.set(serviceName, port);
    return port;
  }

  throw new Error(`No available deployment ports in range ${DEPLOY_PORT_START}-${DEPLOY_PORT_END}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkerHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${WORKER_TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8',
    ...extra,
  };
}

function ensureWorkerConfigured() {
  if (!WORKER_URL || !WORKER_TOKEN) {
    throw new Error('WORKER_URL and WORKER_TOKEN must both be configured for deployment operations.');
  }
}

function workerRequest(method, pathname, payload, options = {}) {
  return new Promise((resolve, reject) => {
    ensureWorkerConfigured();
    const endpoint = new URL(pathname, `${WORKER_URL}/`);
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload));

    const request = http.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: `${endpoint.pathname}${endpoint.search}`,
      method,
      timeout: options.timeoutMs || WORKER_TIMEOUT_MS,
      headers: buildWorkerHeaders(
        body
          ? { 'Content-Length': String(body.length) }
          : { 'Content-Length': '0' },
      ),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (text.trim()) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { message: text };
          }
        }

        if ((response.statusCode || 500) >= 400) {
          const message = parsed?.error || parsed?.message || `Worker request failed (${response.statusCode})`;
          const err = new Error(message);
          err.statusCode = response.statusCode;
          err.payload = parsed;
          reject(err);
          return;
        }

        resolve({ statusCode: response.statusCode || 200, payload: parsed || {} });
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error(`Worker request timeout: ${method} ${pathname}`));
    });

    if (body) request.write(body);
    request.end();
  });
}

async function startWorkerDeployment(deployment) {
  const safeProject = sanitizeName(deployment.project);
  const safeService = sanitizeName(deployment.service);
  const imageTag = `${safeProject}-${safeService}-${deployment.commitSha.slice(0, 12)}`;
  const containerName = `${safeProject}-${safeService}`;

  deployment.imageTag = imageTag;
  deployment.containerName = containerName;

  const assignedPort = chooseAssignedPort(containerName);
  deployment.assignedPort = assignedPort;

  deployment.worker = {
    baseUrl: WORKER_URL,
    containerName,
    imageTag,
    containerId: null,
    assignedPort,
    lastHealth: null,
    updatedAt: nowIso(),
  };

  setDeploymentStatus(deployment, 'building');
  writeDeploymentLog(deployment, `Preparing deployment for ${deployment.project}/${deployment.service}.`);

  const buildBody = {
    repoPath: REPO_PATH,
    branch: deployment.branch,
    commitSha: deployment.commitSha,
    imageTag,
    dockerfile: 'Dockerfile',
  };
  deployment.commands.push('POST /build');
  await workerRequest('POST', '/build', buildBody, { timeoutMs: 10 * 60_000 });
  writeDeploymentLog(deployment, `Built Docker image ${imageTag} via worker.`);

  deployment.commands.push('POST /stop');
  await workerRequest('POST', '/stop', { containerName, remove: true });

  deployment.commands.push('POST /run');
  const runResult = await workerRequest('POST', '/run', {
    imageTag,
    containerName,
    assignedPort,
    containerInternalPort: CONTAINER_INTERNAL_PORT,
    labels: { deployment_id: deployment.id },
  });
  deployment.containerId = runResult.payload.containerId || null;
  deployment.worker.containerId = deployment.containerId;
  deployment.worker.updatedAt = nowIso();

  setDeploymentStatus(deployment, 'health_check');
  writeDeploymentLog(deployment, `Container started (${deployment.containerId}) on port ${assignedPort}.`);

  deployment.testCommands = [
    `curl -fsS -X POST ${WORKER_URL}/health -H 'Authorization: Bearer ***' -H 'Content-Type: application/json' -d '{"assignedPort":${assignedPort},"path":"${HEALTHCHECK_PATH}"}'`,
    `curl -fsS -X POST ${WORKER_URL}/logs -H 'Authorization: Bearer ***' -H 'Content-Type: application/json' -d '{"containerId":"${deployment.containerId}","tail":100}'`,
  ];

  let healthy = false;
  for (let attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt += 1) {
    const healthResult = await workerRequest('POST', '/health', {
      assignedPort,
      path: HEALTHCHECK_PATH,
      timeoutMs: 1500,
    });
    const isHealthy = !!healthResult.payload.ok;
    deployment.worker.lastHealth = {
      attempt,
      ok: isHealthy,
      checkedAt: nowIso(),
      response: healthResult.payload,
    };
    deployment.worker.updatedAt = nowIso();

    writeDeploymentLog(deployment, `Health check attempt ${attempt}/${HEALTHCHECK_ATTEMPTS}: ${isHealthy ? 'ok' : 'not ready'}.`);
    if (isHealthy) {
      healthy = true;
      break;
    }

    await delay(HEALTHCHECK_INTERVAL_MS);
  }

  if (!healthy) {
    setDeploymentStatus(deployment, 'failed');
    deployment.errorSummary = `Health check failed for worker port ${assignedPort}${HEALTHCHECK_PATH}`;
    try {
      const logsResult = await workerRequest('POST', '/logs', {
        containerId: deployment.containerId,
        tail: DOCKER_LOG_TAIL,
      });
      const logLines = String(logsResult.payload.logs || '').split('\n').filter(Boolean);
      for (const line of logLines) {
        writeDeploymentLog(deployment, `[docker] ${line}`);
      }
    } catch (err) {
      writeDeploymentLog(deployment, `Unable to fetch worker logs: ${err.message}`);
    }
    throw new Error(deployment.errorSummary);
  }

  setDeploymentStatus(deployment, 'success');
  deployment.url = `http://127.0.0.1:${assignedPort}`;
  writeDeploymentLog(deployment, `Deployment successful at ${deployment.url}.`);
}

function startDeploymentFlow(deployment) {
  writeDeploymentLog(deployment, `Deployment queued for ${deployment.project}/${deployment.service}.`);

  startWorkerDeployment(deployment)
    .catch((err) => {
      setDeploymentStatus(deployment, 'failed');
      deployment.errorSummary = deployment.errorSummary || err.message || 'Deployment failed.';
      writeDeploymentLog(deployment, `Deployment failed: ${deployment.errorSummary}`);
    });
}

async function streamWorkerLogs(res, deployment, follow) {
  if (!deployment.containerId) {
    sendText(res, 404, 'container_not_found\n');
    return;
  }

  try {
    if (!follow) {
      const logs = await workerRequest('POST', '/logs', {
        containerId: deployment.containerId,
        tail: DOCKER_LOG_TAIL,
      });
      sendText(res, 200, `${logs.payload.logs || ''}`);
      return;
    }

    const endpoint = new URL('/logs?follow=true', `${WORKER_URL}/`);
    const body = Buffer.from(JSON.stringify({ containerId: deployment.containerId, tail: DOCKER_LOG_TAIL }));

    const workerReq = http.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      headers: buildWorkerHeaders({ 'Content-Length': String(body.length) }),
      timeout: WORKER_TIMEOUT_MS,
    }, (workerRes) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      workerRes.pipe(res);
      workerRes.on('close', () => {
        if (!res.writableEnded) res.end();
      });
    });

    workerReq.on('error', (err) => {
      if (!res.writableEnded) sendText(res, 502, `worker_log_stream_failed: ${err.message}\n`);
    });
    workerReq.on('timeout', () => workerReq.destroy(new Error('worker_log_stream_timeout')));
    workerReq.write(body);
    workerReq.end();

    res.on('close', () => workerReq.destroy());
  } catch (err) {
    sendText(res, 502, `worker_log_fetch_failed: ${err.message}\n`);
  }
}

function proxyToDeployment(req, res, route) {
  const proxyRequest = http.request({
    hostname: '127.0.0.1',
    port: route.port,
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      host: route.domain,
      connection: 'close',
    },
  }, (proxyResponse) => {
    res.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
    proxyResponse.pipe(res);
  });

  proxyRequest.on('error', (err) => {
    sendJson(res, 502, {
      error: 'route_proxy_failed',
      message: err.message,
      domain: route.domain,
      project: route.project,
      service: route.service,
      port: route.port,
    });
  });

  req.pipe(proxyRequest);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    sendHtml(res, 200, renderDashboardHtml());
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, workerConfigured: !!(WORKER_URL && WORKER_TOKEN) });
    return;
  }

  if (req.method === 'GET' && req.url === '/deployments/latest') {
    const latest = getLatestDeployment();
    if (!latest) {
      sendJson(res, 404, { error: 'not_found', message: 'No deployments exist yet.' });
      return;
    }
    sendJson(res, 200, {
      status: latest.status,
      url: latest.url,
      deploymentId: latest.id,
      errorSummary: latest.errorSummary,
      imageTag: latest.imageTag,
      containerId: latest.containerId,
      assignedPort: latest.assignedPort,
      commands: latest.commands,
      testCommands: latest.testCommands,
      worker: latest.worker,
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/deployments/') && req.url.includes('/logs')) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parts = parsed.pathname.split('/');
    const deploymentId = parts[2];
    const deployment = getDeploymentById(deploymentId);
    if (!deployment) {
      sendText(res, 404, 'deployment_not_found\n');
      return;
    }
    const follow = parsed.searchParams.get('follow') !== 'false';
    streamWorkerLogs(res, deployment, follow);
    return;
  }

  if (req.method === 'GET' && req.url === '/route') {
    sendJson(res, 200, { routes: collectActiveRoutes() });
    return;
  }

  if (req.method === 'POST' && req.url === '/deployments/trigger') {
    readJsonBody(req, res, (body) => {
      const project = typeof body.project === 'string' ? body.project.trim() : '';
      const service = typeof body.service === 'string' ? body.service.trim() : '';
      const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
      const commitSha = typeof body.commitSha === 'string' ? body.commitSha.trim() : '';

      if (!project || !service || !branch || !commitSha) {
        sendJson(res, 400, { error: 'missing_fields', required: ['project', 'service', 'branch', 'commitSha'] });
        return;
      }

      const deployment = {
        id: makeDeploymentId(),
        project,
        service,
        branch,
        commitSha,
        status: 'queued',
        url: null,
        errorSummary: null,
        imageTag: null,
        containerName: null,
        containerId: null,
        assignedPort: null,
        domain: buildRouteDomain(project, service),
        logs: [],
        commands: [],
        testCommands: [],
        lastExitCode: null,
        worker: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      writeDeploymentRow(deployment);
      startDeploymentFlow(deployment);

      sendJson(res, 202, {
        deploymentId: deployment.id,
        status: deployment.status,
        assignedPort: deployment.assignedPort,
      });
    });

    return;
  }

  if (req.method !== 'POST' || req.url !== '/run') {
    const route = findRouteByHost(req.headers.host);
    if (!route) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    console.log(`[router] host=${extractHostName(req.headers.host)} project=${route.project} service=${route.service} targetPort=${route.port} method=${req.method} path=${req.url}`);
    proxyToDeployment(req, res, route);
    return;
  }

  let size = 0;
  const chunks = [];

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      sendJson(res, 413, {
        started: false,
        success: false,
        error: 'body_too_large',
        branch: null,
        commit_message: null,
      });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      sendJson(res, 400, {
        started: false,
        success: false,
        error: 'invalid_json',
        branch: null,
        commit_message: null,
      });
      return;
    }

    const task = typeof body.task === 'string' ? body.task.trim() : '';
    if (!task) {
      sendJson(res, 400, {
        started: false,
        success: false,
        error: 'missing_task',
        branch: null,
        commit_message: null,
      });
      return;
    }

    const result = await runTask(task);
    sendJson(res, result.success ? 200 : 500, result);
  });
});

initDatabase();

server.listen(PORT, HOST, () => {
  console.log(`phone-runner-server listening on http://${HOST}:${PORT}`);
  console.log(`repo path: ${REPO_PATH}`);
  if (!WORKER_URL || !WORKER_TOKEN) {
    console.log('worker integration disabled until WORKER_URL and WORKER_TOKEN are configured.');
  }
});
