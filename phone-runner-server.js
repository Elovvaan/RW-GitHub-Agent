#!/usr/bin/env node

const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const MAX_BODY_BYTES = 8 * 1024;
const AGENT_PATH = path.resolve(__dirname, 'agent.js');
const REPO_PATH = path.resolve(process.env.REPO_PATH || process.cwd());

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
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

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
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
