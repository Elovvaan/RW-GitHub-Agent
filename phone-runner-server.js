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
  <title>RW GitHub → Railway Pipeline</title>
  <style>
    :root { color-scheme: dark; --bg:#07101f; --panel:#0f1b33; --border:#2b3e65; --text:#e6eeff; --muted:#9eb0d3; --accent:#4f8df6; --idle:#94a3b8; --run:#f59e0b; --ok:#22c55e; --err:#ef4444; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter,system-ui,sans-serif; background:radial-gradient(circle at top,#1b2c50 0%,var(--bg) 45%); color:var(--text); }
    .wrap { max-width:980px; margin:0 auto; padding:20px 14px 30px; }
    h1 { margin:0 0 8px; font-size:1.7rem; }
    .subtitle { margin:0 0 16px; color:var(--muted); }
    .topbar { display:flex; gap:8px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
    .pipeline { display:grid; gap:12px; }
    .step { background:linear-gradient(180deg,#152742,#0d172b); border:1px solid var(--border); border-radius:12px; padding:12px; display:grid; gap:10px; }
    .step.locked { opacity:.7; }
    .step h2 { margin:0; font-size:1rem; display:flex; justify-content:space-between; align-items:center; }
    .meta { color:var(--muted); font-size:.85rem; margin:0; }
    label { display:grid; gap:4px; font-size:.8rem; color:var(--muted); }
    input, textarea, select { width:100%; border-radius:8px; border:1px solid #314566; background:#091425; color:var(--text); padding:8px; }
    textarea { min-height:90px; resize:vertical; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    button { border:1px solid #3a5ea8; background:linear-gradient(180deg,#3f74d6,#355fb1); color:white; border-radius:10px; padding:8px 11px; font-weight:650; cursor:pointer; }
    button.secondary { border-color:#41506a; background:linear-gradient(180deg,#222e44,#172033); color:#d5e1f7; }
    button[disabled] { opacity:.6; cursor:not-allowed; }
    .badge { display:inline-flex; border-radius:999px; padding:4px 8px; border:1px solid transparent; font-size:.72rem; text-transform:uppercase; font-weight:700; }
    .badge.idle { color:#dbeafe; background:rgba(148,163,184,.18); border-color:rgba(148,163,184,.5); }
    .badge.running { color:#fde68a; background:rgba(245,158,11,.2); border-color:rgba(245,158,11,.5); }
    .badge.success { color:#bbf7d0; background:rgba(34,197,94,.2); border-color:rgba(34,197,94,.5); }
    .badge.error { color:#fecaca; background:rgba(239,68,68,.2); border-color:rgba(239,68,68,.5); }
    pre,.box { margin:0; background:#081326; border:1px solid #26406b; border-radius:10px; padding:9px; color:#cfe3ff; font-size:.78rem; white-space:pre-wrap; word-break:break-word; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>RW GitHub → Railway Pipeline</h1>
    <p class="subtitle">Strict top-down flow: Connect GitHub → Enter Prompt → Generate Code → Push to GitHub → Render Preview → Deploy to Railway → Open Live App.</p>
    <div class="topbar">
      <button id="btn-refresh" class="secondary" type="button">Refresh Status</button>
      <span id="global-status" class="badge idle">idle</span>
    </div>

    <section class="pipeline">
      <article id="step-1" class="step"><h2>1) Connect GitHub <span id="badge-1" class="badge idle">idle</span></h2><p class="meta">Required first step.</p>
        <label>Mode<select id="input-source-mode"><option value="existing">Existing Repo</option><option value="new">New Project</option></select></label>
        <label>Repository URL<input id="input-repo-url" placeholder="https://github.com/owner/repo.git" /></label>
        <label>Owner / Repo<input id="input-owner-repo" placeholder="owner/repo" /></label>
        <label>Branch<input id="input-source-branch" value="main" /></label>
        <div class="actions"><button id="btn-connect" type="button">Connect GitHub</button></div>
        <pre id="json-source">{}</pre>
      </article>

      <article id="step-2" class="step"><h2>2) Enter Prompt <span id="badge-2" class="badge idle">idle</span></h2><p class="meta">Save the exact generation prompt.</p>
        <label>Prompt<textarea id="input-task">Build a minimal app and return deploy status.</textarea></label>
        <div class="actions"><button id="btn-save-prompt" type="button">Save Prompt</button></div>
        <div id="summary-prompt" class="box">No prompt saved.</div>
      </article>

      <article id="step-3" class="step"><h2>3) Generate Code <span id="badge-3" class="badge idle">idle</span></h2><p class="meta">Runs /run and captures branch + commit.</p>
        <div class="actions"><button id="btn-generate" type="button">Generate Code</button></div>
        <pre id="json-generate">{}</pre>
      </article>

      <article id="step-4" class="step"><h2>4) Push to GitHub <span id="badge-4" class="badge idle">idle</span></h2><p class="meta">Push result from generated branch/commit.</p>
        <div class="actions"><button id="btn-push" type="button">Push to GitHub</button></div>
        <pre id="json-push">{}</pre>
      </article>

      <article id="step-5" class="step"><h2>5) Render Preview <span id="badge-5" class="badge idle">idle</span></h2><p class="meta">Preview unlocks only after push succeeds.</p>
        <div class="actions"><button id="btn-preview" type="button">Render Preview</button></div>
        <div id="preview-summary" class="box">Preview not rendered.</div>
        <pre id="json-preview">{}</pre>
      </article>

      <article id="step-6" class="step"><h2>6) Deploy to Railway <span id="badge-6" class="badge idle">idle</span></h2><p class="meta">Triggers real deployment endpoint.</p>
        <label>Project<input id="input-project" value="demo-project" /></label>
        <label>Service<input id="input-service" value="phone-runner" /></label>
        <label>Branch<input id="input-branch" value="main" /></label>
        <label>Commit SHA<input id="input-commitSha" value="" /></label>
        <div class="actions"><button id="btn-deploy" type="button">Deploy to Railway</button></div>
        <pre id="json-deployment">{}</pre>
      </article>

      <article id="step-7" class="step"><h2>7) Open Live App <span id="badge-7" class="badge idle">idle</span></h2><p class="meta">Enabled only after successful deploy + URL.</p>
        <div id="live-url" class="box">No live URL yet.</div>
        <div class="actions"><button id="btn-open" class="secondary" type="button" disabled>Open Live App</button></div>
        <pre id="json-route">{}</pre>
      </article>
    </section>
  </div>

  <script>
    function initDashboard(){
      const $ = (id) => document.getElementById(id);
      const steps = [1,2,3,4,5,6,7];
      const state = {
        source:null, prompt:'', generated:null, pushed:null, preview:null, deployment:null, liveUrl:'',
        statuses:{1:'idle',2:'idle',3:'idle',4:'idle',5:'idle',6:'idle',7:'idle'}
      };

      const pretty = (v) => JSON.stringify(v ?? null, null, 2);
      const setJson = (id,v) => { const el=$(id); if(el) el.textContent=pretty(v); };
      const setBadge = (n,status) => {
        const valid=['idle','running','success','error'];
        const s=valid.includes(status)?status:'idle';
        state.statuses[n]=s;
        const el=$('badge-'+n); if(el){ el.className='badge '+s; el.textContent=s; }
      };
      const setGlobal = (status,label) => { const el=$('global-status'); if(el){ el.className='badge '+status; el.textContent=label||status; } };
      const updateLocks = () => {
        const unlocked = {
          1:true,
          2:state.statuses[1]==='success',
          3:state.statuses[2]==='success',
          4:state.statuses[3]==='success',
          5:state.statuses[4]==='success',
          6:state.statuses[5]==='success',
          7:state.statuses[6]==='success' && !!state.liveUrl,
        };
        steps.forEach((n)=>{
          const step=$('step-'+n);
          if(step) step.classList.toggle('locked', !unlocked[n]);
          step && step.querySelectorAll('button,input,textarea,select').forEach((el)=>{
            if (el.id==='btn-refresh') return;
            if (el.id==='btn-open') { el.disabled = !unlocked[7]; return; }
            const isAction = el.tagName==='BUTTON';
            if (isAction) el.disabled = !unlocked[n];
          });
        });
      };
      const ownerRepoFromUrl = (repoUrl) => {
        const m = String(repoUrl||'').trim().match(/github\.com[:/](.+?)(?:\.git)?$/i);
        if(!m) return '';
        const parts=m[1].replace(/^\/+|\/+$/g,'').split('/').filter(Boolean);
        return parts.length>=2 ? (parts[0]+'/'+parts[1].replace(/\.git$/,'')) : '';
      };

      async function fetchJson(url, options){
        const res = await fetch(url, options);
        const data = await res.json().catch(()=>({}));
        return { ok:res.ok, data, status:res.status };
      }

      async function connectGithub(){
        setBadge(1,'running'); setGlobal('running','Connecting GitHub');
        const mode = $('input-source-mode').value;
        const repoUrl = $('input-repo-url').value.trim();
        const ownerRepo = ($('input-owner-repo').value.trim() || ownerRepoFromUrl(repoUrl)).replace(/^\/+|\/+$/g,'');
        const branch = $('input-source-branch').value.trim() || 'main';
        if(mode==='existing' && !ownerRepo){
          const err={ error:'Owner/repo required in Existing Repo mode.' };
          setJson('json-source', err); setBadge(1,'error'); setGlobal('error','Connect failed'); updateLocks(); return;
        }
        state.source={ mode, repoUrl:repoUrl||null, ownerRepo:ownerRepo||null, branch, connectedAt:new Date().toISOString() };
        $('input-owner-repo').value = ownerRepo;
        $('input-branch').value = branch;
        setJson('json-source', { ...state.source, status:'connected' });
        setBadge(1,'success'); setGlobal('success','GitHub connected'); updateLocks();
      }

      function savePrompt(){
        setBadge(2,'running');
        const prompt = $('input-task').value.trim();
        if(!prompt){ setBadge(2,'error'); setGlobal('error','Prompt required'); updateLocks(); return; }
        state.prompt = prompt;
        $('summary-prompt').textContent = prompt;
        setBadge(2,'success'); setGlobal('success','Prompt saved'); updateLocks();
      }

      async function generateCode(){
        setBadge(3,'running'); setGlobal('running','Generating code');
        const payload = { task: state.prompt };
        const result = await fetchJson('/run',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        setJson('json-generate', result.data);
        if(!result.ok || !result.data || result.data.success===false){ setBadge(3,'error'); setGlobal('error','Generation failed'); updateLocks(); return; }
        state.generated = result.data;
        const branch = String(result.data.branch || state.source?.branch || 'main');
        const commit = String(result.data.commit_sha || '').trim();
        $('input-branch').value = branch;
        if(commit) $('input-commitSha').value = commit;
        setBadge(3,'success'); setGlobal('success','Code generated'); updateLocks();
      }

      function pushGithub(){
        setBadge(4,'running'); setGlobal('running','Pushing to GitHub');
        if(!state.generated){ setBadge(4,'error'); setGlobal('error','Generate code first'); updateLocks(); return; }
        const pushedAt = new Date().toISOString();
        state.pushed = {
          repo: state.source?.ownerRepo || 'local-repo',
          branch: $('input-branch').value.trim() || 'main',
          commit: $('input-commitSha').value.trim() || state.generated.commit_sha || null,
          message: state.generated.commit_message || 'Generated by RW pipeline',
          pushedAt,
          status:'pushed'
        };
        setJson('json-push', state.pushed);
        setBadge(4,'success'); setGlobal('success','Push complete'); updateLocks();
      }

      async function renderPreview(){
        setBadge(5,'running'); setGlobal('running','Rendering preview');
        const summary = 'Preview from '+(state.pushed?.repo||'repo')+' @ '+(state.pushed?.branch||'main')+' • '+(state.prompt||'no prompt');
        await new Promise(r=>setTimeout(r,250));
        state.preview = { renderedAt:new Date().toISOString(), summary, commit:state.pushed?.commit || null, status:'ready' };
        $('preview-summary').textContent = summary;
        setJson('json-preview', state.preview);
        setBadge(5,'success'); setGlobal('success','Preview ready'); updateLocks();
      }

      async function deployRailway(){
        setBadge(6,'running'); setGlobal('running','Deploying to Railway');
        const payload = {
          project: $('input-project').value.trim(),
          service: $('input-service').value.trim(),
          branch: $('input-branch').value.trim(),
          commitSha: $('input-commitSha').value.trim(),
        };
        const result = await fetchJson('/deployments/trigger',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        setJson('json-deployment', result.data);
        if(!result.ok){ setBadge(6,'error'); setGlobal('error','Deploy failed'); state.liveUrl=''; $('live-url').textContent='No live URL yet.'; setBadge(7,'idle'); updateLocks(); return; }
        const route = await fetchJson('/route');
        setJson('json-route', route.data);
        const liveFromRoute = Array.isArray(route.data?.routes) && route.data.routes[0] ? ('http://' + route.data.routes[0].domain) : '';
        state.liveUrl = String(result.data?.url || liveFromRoute || '').trim();
        $('live-url').textContent = state.liveUrl || 'No live URL yet.';
        setBadge(6, state.liveUrl ? 'success' : 'error');
        setBadge(7, state.liveUrl ? 'success' : 'idle');
        setGlobal(state.liveUrl ? 'success' : 'error', state.liveUrl ? 'Deploy success' : 'Deploy missing URL');
        updateLocks();
      }

      function openLive(){
        if(!state.liveUrl) return;
        setBadge(7,'running');
        window.open(state.liveUrl, '_blank', 'noopener');
        setBadge(7,'success');
        setGlobal('success','Live app opened');
      }

      async function refreshStatus(){
        setGlobal('running','Refreshing');
        const route = await fetchJson('/route');
        setJson('json-route', route.data);
        if(!state.liveUrl){
          const liveFromRoute = Array.isArray(route.data?.routes) && route.data.routes[0] ? ('http://' + route.data.routes[0].domain) : '';
          if(liveFromRoute && state.statuses[6]==='success'){ state.liveUrl = liveFromRoute; $('live-url').textContent=liveFromRoute; }
        }
        updateLocks();
        setGlobal('idle','idle');
      }

      $('btn-connect').addEventListener('click', connectGithub);
      $('btn-save-prompt').addEventListener('click', savePrompt);
      $('btn-generate').addEventListener('click', generateCode);
      $('btn-push').addEventListener('click', pushGithub);
      $('btn-preview').addEventListener('click', renderPreview);
      $('btn-deploy').addEventListener('click', deployRailway);
      $('btn-open').addEventListener('click', openLive);
      $('btn-refresh').addEventListener('click', refreshStatus);

      updateLocks();
      refreshStatus().catch(()=>{});
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDashboard, { once:true });
    else initDashboard();
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
          commit_sha: parsed?.commit_sha || null,
        });
        return;
      }
      resolve({
        started: true,
        success: !!parsed?.success,
        error: parsed?.error || null,
        branch: parsed?.branch || null,
        commit_message: parsed?.commit_message || null,
        commit_sha: parsed?.commit_sha || null,
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
