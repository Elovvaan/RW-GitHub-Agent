#!/usr/bin/env node

const http = require('http');
const path = require('path');
const net = require('net');
const { URL } = require('url');
const { execFile, spawn } = require('child_process');

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
const HEALTHCHECK_TIMEOUT_MS = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 1500);
const DOCKER_LOG_TAIL = Number(process.env.DOCKER_LOG_TAIL || 250);

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

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd || REPO_PATH, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error((stderr || stdout || error.message || 'command_failed').trim());
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        err.command = [command, ...args].join(' ');
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), command: [command, ...args].join(' ') });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host: '0.0.0.0' }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function assignServicePort(serviceName) {
  const existing = servicePortMap.get(serviceName);
  if (existing && await checkPortAvailable(existing)) {
    return existing;
  }

  for (let port = DEPLOY_PORT_START; port <= DEPLOY_PORT_END; port += 1) {
    if (!await checkPortAvailable(port)) continue;
    servicePortMap.set(serviceName, port);
    return port;
  }
  throw new Error(`No available deployment ports in range ${DEPLOY_PORT_START}-${DEPLOY_PORT_END}`);
}

function httpPing(port, route) {
  return new Promise((resolve) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'GET',
      timeout: HEALTHCHECK_TIMEOUT_MS,
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 400);
    });

    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

async function captureDockerLogs(deployment, tail = DOCKER_LOG_TAIL) {
  if (!deployment.containerId) return;
  try {
    const out = await runCommand('docker', ['logs', '--tail', String(tail), deployment.containerId]);
    const text = out.stdout || out.stderr || '';
    if (!text.trim()) {
      writeDeploymentLog(deployment, 'docker logs: (no output)');
      return;
    }
    const lines = text.trimEnd().split('\n');
    for (const line of lines) {
      writeDeploymentLog(deployment, `[docker] ${line}`);
    }
  } catch (err) {
    writeDeploymentLog(deployment, `Unable to fetch docker logs: ${err.message}`);
  }
}

function monitorContainerLifecycle(deployment) {
  if (!deployment.containerId) return;

  runCommand('docker', ['wait', deployment.containerId])
    .then(async (result) => {
      const exitCode = Number(String(result.stdout || '').trim() || '1');
      deployment.lastExitCode = exitCode;
      if (deployment.status === 'success' || deployment.status === 'running' || deployment.status === 'health_check') {
        setDeploymentStatus(deployment, 'failed');
        deployment.errorSummary = `Container exited after deployment with code ${exitCode}.`;
        writeDeploymentLog(deployment, deployment.errorSummary);
        await captureDockerLogs(deployment);
      }
    })
    .catch((err) => {
      writeDeploymentLog(deployment, `Container monitor error: ${err.message}`);
    });
}

async function pullRepoForDeployment(deployment) {
  const commands = [
    ['git', ['-C', REPO_PATH, 'fetch', '--all', '--prune']],
    ['git', ['-C', REPO_PATH, 'checkout', deployment.branch]],
    ['git', ['-C', REPO_PATH, 'pull', '--ff-only', 'origin', deployment.branch]],
    ['git', ['-C', REPO_PATH, 'rev-parse', '--verify', deployment.commitSha]],
  ];

  for (const [cmd, args] of commands) {
    deployment.commands.push([cmd, ...args].join(' '));
    const out = await runCommand(cmd, args, { cwd: REPO_PATH });
    const output = `${out.stdout}${out.stderr}`.trim();
    if (output) {
      writeDeploymentLog(deployment, output.split('\n')[0]);
    }
  }
}

async function startDockerDeployment(deployment) {
  const safeProject = sanitizeName(deployment.project);
  const safeService = sanitizeName(deployment.service);
  const imageTag = `${safeProject}-${safeService}-${deployment.commitSha.slice(0, 12)}`;
  const containerName = `${safeProject}-${safeService}`;

  deployment.imageTag = imageTag;
  deployment.containerName = containerName;

  setDeploymentStatus(deployment, 'building');
  writeDeploymentLog(deployment, `Preparing deployment for ${deployment.project}/${deployment.service}.`);

  await pullRepoForDeployment(deployment);

  const assignedPort = await assignServicePort(containerName);
  deployment.assignedPort = assignedPort;

  const buildArgs = ['build', '-f', 'Dockerfile', '-t', imageTag, REPO_PATH];
  deployment.commands.push(`docker ${buildArgs.join(' ')}`);
  await runCommand('docker', buildArgs, { cwd: REPO_PATH });
  writeDeploymentLog(deployment, `Built Docker image ${imageTag}.`);

  const existingArgs = ['ps', '-aq', '--filter', `name=^/${containerName}$`];
  deployment.commands.push(`docker ${existingArgs.join(' ')}`);
  const existing = (await runCommand('docker', existingArgs)).stdout.trim();
  if (existing) {
    const removeArgs = ['rm', '-f', containerName];
    deployment.commands.push(`docker ${removeArgs.join(' ')}`);
    await runCommand('docker', removeArgs);
    writeDeploymentLog(deployment, `Stopped existing container ${containerName}.`);
  }

  const runArgs = [
    'run', '-d',
    '--name', containerName,
    '-p', `${assignedPort}:${CONTAINER_INTERNAL_PORT}`,
    '--label', `deployment_id=${deployment.id}`,
    imageTag,
  ];
  deployment.commands.push(`docker ${runArgs.join(' ')}`);
  const runResult = await runCommand('docker', runArgs);
  deployment.containerId = runResult.stdout.trim();

  setDeploymentStatus(deployment, 'health_check');
  writeDeploymentLog(deployment, `Container started (${deployment.containerId}) on port ${assignedPort}.`);

  deployment.testCommands = [
    `curl -fsS http://127.0.0.1:${assignedPort}${HEALTHCHECK_PATH}`,
    `docker ps --filter name=^/${containerName}$`,
    `docker logs --tail 100 ${deployment.containerId}`,
  ];

  let healthy = false;
  for (let attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt += 1) {
    const isHealthy = await httpPing(assignedPort, HEALTHCHECK_PATH);
    writeDeploymentLog(deployment, `Health check attempt ${attempt}/${HEALTHCHECK_ATTEMPTS}: ${isHealthy ? 'ok' : 'not ready'}.`);
    if (isHealthy) {
      healthy = true;
      break;
    }

    try {
      const inspectArgs = ['inspect', '-f', '{{.State.Running}}', deployment.containerId];
      deployment.commands.push(`docker ${inspectArgs.join(' ')}`);
      const inspect = await runCommand('docker', inspectArgs);
      if (inspect.stdout.trim() !== 'true') {
        deployment.errorSummary = 'Container exited before becoming healthy.';
        writeDeploymentLog(deployment, deployment.errorSummary);
        break;
      }
    } catch (err) {
      deployment.errorSummary = `Unable to inspect container state: ${err.message}`;
      writeDeploymentLog(deployment, deployment.errorSummary);
      break;
    }

    await delay(HEALTHCHECK_INTERVAL_MS);
  }

  if (!healthy) {
    setDeploymentStatus(deployment, 'failed');
    deployment.errorSummary = deployment.errorSummary || `Health check failed for http://127.0.0.1:${assignedPort}${HEALTHCHECK_PATH}`;
    await captureDockerLogs(deployment);
    throw new Error(deployment.errorSummary);
  }

  setDeploymentStatus(deployment, 'success');
  deployment.url = `http://127.0.0.1:${assignedPort}`;
  writeDeploymentLog(deployment, `Deployment successful at ${deployment.url}.`);

  monitorContainerLifecycle(deployment);
}

function startDeploymentFlow(deployment) {
  writeDeploymentLog(deployment, `Deployment queued for ${deployment.project}/${deployment.service}.`);

  startDockerDeployment(deployment)
    .catch(async (err) => {
      setDeploymentStatus(deployment, 'failed');
      deployment.errorSummary = deployment.errorSummary || err.message || 'Deployment failed.';
      writeDeploymentLog(deployment, `Deployment failed: ${deployment.errorSummary}`);
      await captureDockerLogs(deployment);
    });
}

function streamDockerLogs(req, res, deployment) {
  if (!deployment.containerId) {
    sendText(res, 404, 'container_not_found\n');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const follow = parsed.searchParams.get('follow') !== 'false';
  const args = ['logs', '--timestamps', '--tail', '200'];
  if (follow) args.push('-f');
  args.push(deployment.containerId);

  const child = spawn('docker', args, { cwd: REPO_PATH });

  child.stdout.on('data', (chunk) => res.write(chunk));
  child.stderr.on('data', (chunk) => res.write(chunk));

  child.on('close', () => {
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    child.kill('SIGTERM');
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
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
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/deployments/') && req.url.includes('/logs')) {
    const parts = req.url.split('/');
    const deploymentId = parts[2];
    const deployment = deployments.find((item) => item.id === deploymentId);
    if (!deployment) {
      sendText(res, 404, 'deployment_not_found\n');
      return;
    }
    streamDockerLogs(req, res, deployment);
    return;
  }

  if (req.method === 'POST' && req.url === '/deployments/trigger') {
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
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }

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
        logs: [],
        commands: [],
        testCommands: [],
        lastExitCode: null,
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
    sendJson(res, 404, { error: 'not_found' });
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
});
