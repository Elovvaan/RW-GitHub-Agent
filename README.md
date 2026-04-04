# Private GitHub Coding Agent (Replit-ready)

A lean Node.js agent for a private workflow:
- accepts plain-English coding tasks
- reads your repo context
- plans edits
- applies **diff-based patches** (no full-file overwrite)
- creates a branch
- commits and pushes to GitHub
- exposes a tiny HTTP endpoint so you can trigger runs from your phone

## Control plane + worker deployment architecture
- **Control plane**: `phone-runner-server.js` keeps the existing agent contract (`POST /run`) and deployment routes (`/deployments/*`, `/route`).
- **Runtime worker**: `worker-server.js` runs on a Docker-enabled VPS and executes Docker build/run/stop/log/health actions.
- Shared auth: control plane calls worker endpoints using `Authorization: Bearer $WORKER_TOKEN`.

## Files
- `agent.js` – core repo-aware coding agent
- `phone-runner-server.js` – control plane HTTP runner and deployment router
- `worker-server.js` – VPS runtime worker for Docker operations
- `package.json` – scripts + runtime metadata
- `.replit` – Replit run/deploy config
- `replit.nix` – Node + git environment
- `.env.example` – required secrets/config variables

## Environment variables
Set these in Replit **Secrets** (control plane):

- `OPENAI_API_KEY` – OpenAI API key
- `OPENAI_MODEL` – model name (example: `gpt-4.1-mini`)
- `OPENAI_BASE_URL` – API base URL (default `https://api.openai.com/v1`)
- `GITHUB_TOKEN` – GitHub personal access token with repo write access
- `REPO_PATH` – absolute path to the local checked-out repo to edit
- `BASE_BRANCH` – base branch for agent branches (example: `main`)
- `PORT` – control plane port (default: `3000`)
- `WORKER_URL` – full base URL to worker (example: `http://10.0.0.42:3400`)
- `WORKER_TOKEN` – shared bearer token for worker auth

Set these on the worker VPS:
- `PORT` – worker port (default `3400`)
- `WORKER_TOKEN` – same shared bearer token

## Run locally in shell

### Start control plane
```bash
npm start
```

### Start worker
```bash
npm run worker
```

### Run agent directly
```bash
npm run agent -- "add a health check endpoint" "$REPO_PATH" --confirm --yes
```

## Control plane endpoints (unchanged)
- `POST /run`
- `POST /deployments/trigger`
- `GET /deployments/latest`
- `GET /deployments/:deploymentId/logs`
- `GET /route`
- `GET /health`

## Worker endpoints (new)
- `POST /build`
- `POST /run`
- `POST /stop`
- `POST /logs`
- `POST /health`
- `GET /health` (worker process health)

## Example curl tests

### Worker health
```bash
curl -sS "${WORKER_URL}/health"
```

### Worker build
```bash
curl -sS -X POST "${WORKER_URL}/build" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"repoPath":"/srv/app","branch":"main","commitSha":"<sha>","imageTag":"demo-main-<sha>","dockerfile":"Dockerfile"}'
```

### Worker run
```bash
curl -sS -X POST "${WORKER_URL}/run" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"imageTag":"demo-main-<sha>","containerName":"demo-service","assignedPort":4100,"containerInternalPort":3000,"labels":{"deployment_id":"dep_0001"}}'
```

### Worker stop
```bash
curl -sS -X POST "${WORKER_URL}/stop" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"containerName":"demo-service","remove":true}'
```

### Worker logs
```bash
curl -sS -X POST "${WORKER_URL}/logs" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"containerId":"<container-id>","tail":200}'
```

### Worker health probe to deployed service
```bash
curl -sS -X POST "${WORKER_URL}/health" \
  -H "Authorization: Bearer ${WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"assignedPort":4100,"path":"/health","timeoutMs":1500}'
```

### Trigger deployment from control plane
```bash
curl -sS -X POST "http://127.0.0.1:${PORT:-3000}/deployments/trigger" \
  -H "Content-Type: application/json" \
  -d '{"project":"demo","service":"api","branch":"main","commitSha":"<sha>"}'
```

### Trigger deployment from browser/Node fetch
```js
const latestCommitSha = "PASTE_YOUR_LATEST_COMMIT_SHA_HERE"; // e.g. output from: git rev-parse HEAD

fetch("https://rw-github-agent-production.up.railway.app/deployments/trigger", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    project: "RW-GitHub-Agent",
    service: "main",
    branch: "main",
    commitSha: latestCommitSha
  })
})
  .then((res) => res.json())
  .then(console.log);
```
