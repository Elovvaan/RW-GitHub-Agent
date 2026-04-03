#!/usr/bin/env node

const http = require('http');
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');

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

const deployments = [];
const servicePortMap = new Map();
let deploymentCounter = 1;

function nowIso() {
  return new Date().toISOString();
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
}

function setDeploymentStatus(deployment, status) {
  deployment.status = status;
  deployment.updatedAt = nowIso();
}

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
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
  const latestByRouteKey = new Map();

  for (const deployment of deployments) {
    if (!deployment.assignedPort) continue;
    if (deployment.status !== 'success' && deployment.status !== 'health_check' && deployment.status !== 'running') continue;
    const key = `${sanitizeName(deployment.project)}/${sanitizeName(deployment.service)}`;
    const current = latestByRouteKey.get(key);
    if (!current || new Date(deployment.updatedAt).getTime() >= new Date(current.updatedAt).getTime()) {
      latestByRouteKey.set(key, deployment);
    }
  }

  return Array.from(latestByRouteKey.values()).map((deployment) => ({
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
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, workerConfigured: !!(WORKER_URL && WORKER_TOKEN) });
    return;
  }

  if (req.method === 'GET' && req.url === '/deployments/latest') {
    const latest = deployments[deployments.length - 1];
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
    const deployment = deployments.find((item) => item.id === deploymentId);
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

      deployments.push(deployment);
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

server.listen(PORT, HOST, () => {
  console.log(`phone-runner-server listening on http://${HOST}:${PORT}`);
  console.log(`repo path: ${REPO_PATH}`);
  if (!WORKER_URL || !WORKER_TOKEN) {
    console.log('worker integration disabled until WORKER_URL and WORKER_TOKEN are configured.');
  }
});
