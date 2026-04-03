#!/usr/bin/env node

const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const AGENT_PATH = path.resolve(process.env.AGENT_PATH || path.join(__dirname, 'agent.js'));
const REPO_PATH = path.resolve(process.env.AGENT_REPO_PATH || process.cwd());
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function extractFinalJson(stdoutText) {
  for (let i = stdoutText.lastIndexOf('{'); i >= 0; i = stdoutText.lastIndexOf('{', i - 1)) {
    const candidate = stdoutText.slice(i).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return null;
}

function runAgentTask(task) {
  return new Promise((resolve) => {
    execFile(process.execPath, [AGENT_PATH, task, REPO_PATH], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const parsed = extractFinalJson(String(stdout || ''));

      if (error) {
        resolve({
          started: true,
          success: false,
          error: String((stderr || error.message || 'Agent execution failed')).trim(),
          branch: parsed?.branch || null,
          commit_message: parsed?.commit_message || null,
        });
        return;
      }

      resolve({
        started: true,
        success: true,
        error: null,
        branch: parsed?.branch || null,
        commit_message: parsed?.commit_message || null,
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/run') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  let body = '';
  let tooLarge = false;

  req.on('data', (chunk) => {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
    }
  });

  req.on('close', async () => {
    if (!tooLarge) return;
    sendJson(res, 413, {
      started: false,
      success: false,
      error: 'Request body too large',
      branch: null,
      commit_message: null,
    });
  });

  req.on('end', async () => {
    if (tooLarge) return;

    let payload;
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, {
        started: false,
        success: false,
        error: 'Invalid JSON body',
        branch: null,
        commit_message: null,
      });
      return;
    }

    const task = typeof payload.task === 'string' ? payload.task.trim() : '';
    if (!task) {
      sendJson(res, 400, {
        started: false,
        success: false,
        error: 'Body must include { "task": "..." }',
        branch: null,
        commit_message: null,
      });
      return;
    }

    const result = await runAgentTask(task);
    sendJson(res, result.success ? 200 : 500, result);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Phone runner listening on http://${HOST}:${PORT}`);
  console.log(`Using agent: ${AGENT_PATH}`);
  console.log(`Using repo:  ${REPO_PATH}`);
});
