# Private GitHub Coding Agent (Replit-ready)

A lean Node.js agent for a private workflow:
- accepts plain-English coding tasks
- reads your repo context
- plans edits
- applies **diff-based patches** (no full-file overwrite)
- creates a branch
- commits and pushes to GitHub
- exposes a tiny HTTP endpoint so you can trigger runs from your phone

## Files
- `agent.js` – core repo-aware coding agent
- `phone-runner-server.js` – tiny HTTP runner (`POST /run`)
- `package.json` – scripts + runtime metadata
- `.replit` – Replit run/deploy config
- `replit.nix` – Node + git environment
- `.env.example` – required secrets/config variables

## Environment variables
Set these in Replit **Secrets**:

- `OPENAI_API_KEY` – OpenAI API key
- `OPENAI_MODEL` – model name (example: `gpt-4.1-mini`)
- `OPENAI_BASE_URL` – API base URL (default `https://api.openai.com/v1`)
- `GITHUB_TOKEN` – GitHub personal access token with repo write access
- `REPO_PATH` – absolute path to the local checked-out repo to edit
- `BASE_BRANCH` – base branch for agent branches (example: `main`)
- `PORT` – server port (default: `3000`)

## Replit setup (exact)
1. Create a Replit Node.js repl and upload these files.
2. Open **Shell** and run:
   ```bash
   npm install
   ```
   (No external dependencies are required, but this initializes lockfiles if wanted.)
3. Add all variables from `.env.example` into **Secrets**.
4. Ensure your target repo exists on disk at `REPO_PATH` and has `origin` configured to GitHub using the token.
   - Example remote with token:
     ```bash
     git -C "$REPO_PATH" remote set-url origin "https://$GITHUB_TOKEN@github.com/OWNER/REPO.git"
     ```
5. Click **Run**. Replit executes `npm start` (from `.replit`).

## Run locally in shell

### Start server
```bash
npm start
```

### Run agent directly
```bash
npm run agent -- "add a health check endpoint" "$REPO_PATH" --confirm --yes
```

### Evaluate agent capability checks
```bash
npm run eval
```

## Test `/run`
Use curl:
```bash
curl -sS -X POST "http://127.0.0.1:${PORT:-3000}/run" \
  -H "Content-Type: application/json" \
  -d '{"task":"add request logging to phone-runner-server.js"}'
```

Expected JSON shape:
```json
{
  "started": true,
  "success": true,
  "error": null,
  "branch": "agent/2026-04-03-add-request-logging-ab12",
  "commit_message": "agent: add request logging to phone-runner-server.js"
}
```

## Trigger from phone

### Option A: browser-based trigger (fastest)
Use a mobile HTTP client (or Shortcuts app web request) to send `POST /run` with JSON:
```json
{ "task": "your plain-English task" }
```

### Option B: iOS Shortcuts
1. New Shortcut → **Get Contents of URL**.
2. Method: `POST`.
3. URL: your Replit deployment URL + `/run`.
4. Request Body: JSON → key `task` value from an input prompt.
5. Show Result.

## GitHub token setup
1. GitHub → **Settings** → **Developer settings** → **Personal access tokens**.
2. Create fine-grained token with:
   - repository access to your private repo
   - permissions: **Contents: Read and write**
   - if needed, **Pull requests: Read and write**
3. Save token as Replit Secret: `GITHUB_TOKEN`.
4. Ensure your repo remote uses that token (see setup section).

## Agent behavior highlights
- **Repo-aware file selection** via keyword scoring over `git ls-files`.
- **Diff-based patching** using generated unified diffs and `git apply`.
- **Tool registry** with `name`, `description`, `risk` and policy checks.
- **Permission system** with allow/block/confirm behavior.
- **Workflow state persistence** in `.agent-workflow-state.json`.
- **Resumable multi-step execution** (`--resume`).
- **Rollback** (`git reset --hard` + `git clean -fd`) if patch apply fails.
- **Modes**:
  - `--dry-run` (plan only)
  - `--confirm --yes` (explicit approval flow)
  - `--eval` (capability self-check)
- **Structured JSON output** for reliable automation.

## Security note
This is for private internal use. Do not expose publicly without adding your own authentication and network restrictions.
