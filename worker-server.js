#!/usr/bin/env node

const http = require('http');
const net = require('net');
const path = require('path');
const { URL } = require('url');
const { execFile, spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3400);
const HOST = '0.0.0.0';
const MAX_BODY_BYTES = 256 * 1024;
const WORKER_TOKEN = String(process.env.WORKER_TOKEN || '').trim();

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function normalizeCommand(command) {
  const candidate = String(command || '').trim();
  const base = path.basename(candidate).toLowerCase();

  if (!candidate || base === 'node' || base === 'node.exe') {
    return process.execPath;
  }

  return candidate;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const executable = normalizeCommand(command);
    execFile(executable, args, { cwd: options.cwd || process.cwd(), maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error((stderr || stdout || error.message || 'command_failed').trim());
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function spawnCommand(command, args, options = {}) {
  return spawn(normalizeCommand(command), args, options);
}

function requireBearerAuth(req, res) {
  if (!WORKER_TOKEN) {
    sendJson(res, 500, { error: 'worker_token_not_configured' });
    return false;
  }

  const auth = String(req.headers.authorization || '');
  if (auth !== `Bearer ${WORKER_TOKEN}`) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }

  return true;
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

function httpPing(port, route, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'GET',
      timeout: timeoutMs,
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

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, service: 'worker' });
    return;
  }

  if (!['/build', '/run', '/stop', '/logs', '/health'].includes(new URL(req.url, 'http://localhost').pathname)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  if (!requireBearerAuth(req, res)) {
    return;
  }

  if (req.method === 'POST' && req.url === '/build') {
    readJsonBody(req, res, async (body) => {
      try {
        const repoPath = String(body.repoPath || '').trim();
        const branch = String(body.branch || '').trim();
        const commitSha = String(body.commitSha || '').trim();
        const imageTag = String(body.imageTag || '').trim();
        const dockerfile = String(body.dockerfile || 'Dockerfile').trim();

        if (!repoPath || !branch || !commitSha || !imageTag) {
          sendJson(res, 400, { error: 'missing_fields', required: ['repoPath', 'branch', 'commitSha', 'imageTag'] });
          return;
        }

        await runCommand('git', ['-C', repoPath, 'fetch', '--all', '--prune']);
        await runCommand('git', ['-C', repoPath, 'checkout', branch]);
        await runCommand('git', ['-C', repoPath, 'pull', '--ff-only', 'origin', branch]);
        await runCommand('git', ['-C', repoPath, 'rev-parse', '--verify', commitSha]);
        await runCommand('docker', ['build', '-f', dockerfile, '-t', imageTag, repoPath], { cwd: repoPath });

        sendJson(res, 200, { ok: true, imageTag });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    readJsonBody(req, res, async (body) => {
      try {
        const imageTag = String(body.imageTag || '').trim();
        const containerName = String(body.containerName || '').trim();
        const assignedPort = Number(body.assignedPort || 0);
        const containerInternalPort = Number(body.containerInternalPort || 3000);
        const labels = body.labels && typeof body.labels === 'object' ? body.labels : {};

        if (!imageTag || !containerName || !assignedPort) {
          sendJson(res, 400, { error: 'missing_fields', required: ['imageTag', 'containerName', 'assignedPort'] });
          return;
        }

        const portAvailable = await checkPortAvailable(assignedPort);
        if (!portAvailable) {
          sendJson(res, 409, { error: `assigned_port_unavailable:${assignedPort}` });
          return;
        }

        const labelArgs = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
        const runArgs = [
          'run', '-d',
          '--name', containerName,
          '-p', `${assignedPort}:${containerInternalPort}`,
          ...labelArgs,
          imageTag,
        ];
        const runResult = await runCommand('docker', runArgs);
        sendJson(res, 200, { ok: true, containerId: runResult.stdout.trim(), assignedPort });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/stop') {
    readJsonBody(req, res, async (body) => {
      try {
        const containerName = String(body.containerName || '').trim();
        const remove = body.remove !== false;
        if (!containerName) {
          sendJson(res, 400, { error: 'missing_fields', required: ['containerName'] });
          return;
        }

        const existing = (await runCommand('docker', ['ps', '-aq', '--filter', `name=^/${containerName}$`])).stdout.trim();
        if (!existing) {
          sendJson(res, 200, { ok: true, stopped: false, removed: false });
          return;
        }

        if (remove) {
          await runCommand('docker', ['rm', '-f', containerName]);
          sendJson(res, 200, { ok: true, stopped: true, removed: true });
          return;
        }

        await runCommand('docker', ['stop', containerName]);
        sendJson(res, 200, { ok: true, stopped: true, removed: false });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/logs')) {
    const parsed = new URL(req.url, 'http://localhost');
    const follow = parsed.searchParams.get('follow') === 'true';

    readJsonBody(req, res, async (body) => {
      const containerId = String(body.containerId || '').trim();
      const tail = Number(body.tail || 200);
      if (!containerId) {
        sendJson(res, 400, { error: 'missing_fields', required: ['containerId'] });
        return;
      }

      if (!follow) {
        try {
          const out = await runCommand('docker', ['logs', '--tail', String(tail), containerId]);
          sendJson(res, 200, { ok: true, logs: out.stdout || out.stderr || '' });
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const child = spawnCommand('docker', ['logs', '--timestamps', '--tail', String(tail), '-f', containerId]);
      child.stdout.on('data', (chunk) => res.write(chunk));
      child.stderr.on('data', (chunk) => res.write(chunk));

      child.on('close', () => {
        if (!res.writableEnded) res.end();
      });

      req.on('close', () => child.kill('SIGTERM'));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/health') {
    readJsonBody(req, res, async (body) => {
      const assignedPort = Number(body.assignedPort || 0);
      const path = String(body.path || '/health');
      const timeoutMs = Number(body.timeoutMs || 1500);

      if (!assignedPort) {
        sendJson(res, 400, { error: 'missing_fields', required: ['assignedPort'] });
        return;
      }

      const ok = await httpPing(assignedPort, path, timeoutMs);
      sendJson(res, 200, { ok, assignedPort, path });
    });
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});

server.listen(PORT, HOST, () => {
  console.log(`worker-server listening on http://${HOST}:${PORT}`);
});
