# 🚀 AutoShip — Production-Grade Custom CI/CD Engine

A lightweight, self-hosted, event-driven CI/CD automation engine engineered with **Node.js**, **Express**, **BullMQ**, **Redis**, and **Bash**.

AutoShip transforms incoming GitHub push webhooks into serialized, zero-downtime deployment pipelines featuring **constant-time cryptographic HMAC verification**, **queue-based race-condition elimination**, **cross-platform process streaming**, **intelligent change detection (Fast Deploy)**, **directory isolation & remote mismatch guards**, **Redis-backed True LKG rollback with Day 0 protection**, and **real-time ChatOps alerts via Slack Block Kit**.

---

## 🏗️ Architecture & Pipeline Flow

```
                     GitHub Webhook (Push / Ping)
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│  AutoShip Express Gateway (app.js)                                     │
│  ├── 1. Capture raw unparsed bytes via express.json({ verify })        │
│  ├── 2. Compute HMAC-SHA256 signature over raw buffer                  │
│  ├── 3. Guard against length mismatch attacks                          │
│  ├── 4. Constant-time validation via crypto.timingSafeEqual()          │
│  ├── 5. Inspect commit delta (package.json / package-lock.json)        │
│  └── 6. Enqueue BullMQ job & immediately respond HTTP 202 Accepted     │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│  BullMQ Queue (cicd-server-queue) backed by Redis                      │
│  - Decouples webhook delivery from long-running shell execution        │
│  - Prevents GitHub webhook timeout (HTTP 504)                          │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   │ (Strict concurrency: 1)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Worker (workers/deployWorker.js)                                      │
│  ├── 1. Query Redis for True LKG SHA (lkg:<repo>:<branch>)             │
│  ├── 2. Report GitHub Commit Status -> "pending" 🟡                    │
│  ├── 3. Auto-detect platform shell (Git Bash on Win32 vs /bin/bash)    │
│  ├── 4. Inject 12-factor environment variables into child process      │
│  └── 5. Spawn deploy.sh via streaming child_process.spawn              │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Deployment Execution (deploy.sh)                                      │
│  ├── [Phase 1] Directory Isolation & Remote Mismatch Guard             │
│  │   ├── Verify TARGET_DIR exists (prevents CI/CD self-corruption)     │
│  │   └── Validate remote.origin.url matches target repository          │
│  ├── [Phase 2] Git Synchronization                                     │
│  │   └── git fetch origin, checkout, and pull target branch            │
│  ├── [Phase 3] Intelligent Change Detection                            │
│  │   ├── Deps changed or node_modules missing: run 'npm ci --omit=dev' │
│  │   └── Deps unchanged: Skip install (⚡ Fast Deploy: ~3s vs ~45s)   │
│  ├── [Phase 4] Zero-Downtime Process Reload                            │
│  │   └── PM2 reload / restart ecosystem.config.js                      │
│  └── [Phase 5] Active Health Check Probe Loop                          │
│      └── HTTP GET http://127.0.0.1:TARGET_PORT/health (5 retries)      │
│               │                                          │
│        [200 OK: Healthy]                       [500 / Timeout: Failed]
│               │                                          │
│               ▼                                          ▼
│    Deploy Succeeded! 🟢                       Rollback / Teardown 🔴
│    - Exit code 0                              - If LKG exists:
│    - Worker updates Redis True LKG               git reset --hard ${LKG_COMMIT}
│    - GitHub Status: "success"                    npm ci & PM2 reload
│    - ChatOps: Green Slack Card                - If Day 0 (LKG is null):
│                                                  PM2 teardown & git reset HEAD
│                                               - GitHub Status: "failure"
│                                               - ChatOps: Red Alert Slack Card
└────────────────────────────────────────────────────────────────────────┘
```

---

## 💡 Why Build a Custom CI/CD Engine?

While hosted CI/CD services (GitHub Actions, CircleCI, AWS CodePipeline) are widely adopted, custom deployment engines provide significant competitive advantages:

1. **Edge & On-Premises Isolation**: Deploying to air-gapped VPCs, private clouds, or edge nodes where code cannot be uploaded to third-party shared runner infrastructure.
2. **Elimination of Queue & Billing Overhead**: Hosted runners introduce build spin-up delays (30s–2m) and per-minute billing fees. AutoShip initiates builds in **<15ms** on existing hardware.
3. **Deep Systems Architecture**: Exposes the low-level mechanics of process management, IPC, streaming I/O, Git working tree locking, rollback state machines, and cryptographic transport validation.

---

## ⚡ Core Engineering Pillars & Systems Design

### 1. Cryptographic HMAC-SHA256 & Constant-Time Verification
* **The Vulnerability**: Naive webhook receivers use `JSON.stringify(req.body)` to regenerate the HMAC digest. Because Node.js object key serialization does not guarantee identical whitespace, key ordering, or unicode escaping, signature checks frequently fail. Furthermore, standard equality operators (`===` or `==`) return early upon encountering the first mismatched character, creating an exploitable **timing side-channel vulnerability**.
* **The Solution**: 
  - Captures raw, unparsed request bytes directly via `express.json({ verify: (req, _, buf) => { req.rawBody = buf; } })`.
  - Computes the SHA256 HMAC using `crypto.createHmac()`.
  - Performs length validation before comparing buffers to prevent `RangeError` panics.
  - Validates signatures in constant time using `crypto.timingSafeEqual()`.

### 2. Queue Serialization & Race Condition Elimination (`concurrency: 1`)
* **The Problem**: When multiple commits or branches are pushed simultaneously, a naive server triggers concurrent shell processes inside the target repository. This causes immediate Git lockfile collisions:
  ```text
  fatal: Unable to create '.git/index.lock': File exists.
  Another git process seems to be running in this repository...
  ```
  Concurrent builds simultaneously overwrite `node_modules`, corrupting application state and leading to partial deployments.
* **The Solution**: AutoShip offloads all incoming jobs to a **BullMQ** queue backed by Redis. The worker runs with strict **`concurrency: 1`**, enforcing atomic, sequential deployments. The HTTP endpoint immediately acknowledges incoming webhooks with **`HTTP 202 Accepted`** in under 15ms, eliminating GitHub delivery timeouts.

### 3. Memory-Safe Event-Driven Process Streaming (`child_process.spawn`)
* **The Problem**: Node's `child_process.exec()` buffers an entire process’s stdout and stderr in memory with a default limit of 1MB (`maxBuffer`). Running `npm ci` or verbose build scripts quickly exceeds this threshold, abruptly crashing the deployment process.
* **The Solution**: AutoShip uses `child_process.spawn()` with streaming event handlers (`stdout.on("data")`, `stderr.on("data")`), maintaining flat memory consumption regardless of build log size.

### 4. Directory Isolation & Remote Mismatch Guard (Anti-Self-Corruption)
* **The Problem**: If an environment variable is omitted or misconfigured, shell scripts often default to the current working directory (`.`). Running `git pull` or `npm ci` inside the CI/CD server's own repository corrupts the deployment server itself.
* **The Solution**: [deploy.sh](deploy.sh) enforces defensive pre-flight validation:
  1. Validates that `TARGET_DIR` is non-empty and points to an existing directory.
  2. Queries `git config --get remote.origin.url` and asserts that the remote matches `REPOSITORY`. If there is a mismatch, execution halts immediately with exit code 1 before any Git or filesystem operations are performed.

### 5. 12-Factor Environment-Based Parameter Injection
* **The Problem**: Passing deployment parameters as positional shell arguments (`./deploy.sh $1 $2 $3...`) is brittle. Adding, removing, or reordering parameters breaks backward compatibility and creates shell injection vulnerabilities if commit messages contain spaces or quotes.
* **The Solution**: Follows the **Twelve-Factor App methodology**. [workers/deployWorker.js](workers/deployWorker.js) passes structured configuration via `process.env` during process spawn (`BRANCH`, `REPOSITORY`, `COMMIT_SHA`, `DEPS_CHANGED`, `LKG_COMMIT`). The shell script reads these using POSIX parameter expansion (e.g., `BRANCH="${BRANCH:-}"`), ensuring clean, safe, and easily extensible contracts.

### 6. Intelligent Change Detection (Fast Deploy: ~3s vs ~45s)
* During webhook intake, AutoShip inspects the commit payload delta (`added`, `modified`, and `removed` arrays across all pushed commits).
* If neither `package.json` nor `package-lock.json` was touched, `depsChanged` is set to `false`.
* [deploy.sh](deploy.sh) skips `npm ci --omit=dev`, cutting routine code-only deployment time from **~45 seconds down to under 3 seconds**.

### 7. Redis-Backed True LKG Rollback & Day 0 Teardown
* **The Problem with Naive `git rev-parse HEAD`**: Tutorial CI/CD implementations typically store whatever commit was in the working directory before pulling (`PREV_COMMIT`). This creates two catastrophic failure modes:
  1. **The Day 0 Problem**: On a repository's initial deployment, there is no previous commit. Rolling back to `HEAD` re-deploys the same broken code, locking ports (`EADDRINUSE`) and causing PM2 crash loops.
  2. **Cascading Failure Problem**: If commit A is healthy, commit B fails, and commit C is pushed and also fails, naive scripts record commit B as the "previous commit", rolling back into another broken state.
* **The Solution**:
  - AutoShip records a **True LKG** in Redis (`lkg:<repo>:<branch>`) **only after** the HTTP `/health` probe returns `200 OK`.
  - **Consecutive Failures**: If consecutive broken commits are pushed, AutoShip resets to the last verified healthy SHA (`git reset --hard ${LKG_COMMIT}`), re-runs `npm ci`, and reloads PM2.
  - **Day 0 Protection**: If an initial deployment fails when `LKG === null`, AutoShip executes a **Controlled Service Teardown** (`pm2 delete`, resets the working tree, and exits with code 1) to clean up server resources and prevent port collisions.

### 8. GitHub Commit Status API Integration
* Direct bidirectional integration with GitHub's REST Status API:
  - 🟡 **Pending**: Dispatched the instant the BullMQ worker begins processing the job.
  - 🟢 **Success**: Dispatched when PM2 successfully reloads and all `/health` probe attempts pass.
  - 🔴 **Failure**: Dispatched if build commands fail or if the health check fails (with auto-rollback context included in the status description).
* Statuses are displayed directly in GitHub commit badges and Pull Request merge checks.

### 9. Real-Time ChatOps Alerts (Slack Block Kit)
* AutoShip features an automated ChatOps notification service ([services/notifier.js](services/notifier.js)) formatted using enterprise **Slack Block Kit**:
  - **Success Notifications (Green `#2eb886`)**: Repository, branch, hyperlinked commit SHA, commit author, execution duration (e.g., `⏱️ 3.4s`), and the optimization used (`⚡ Fast Deploy` vs `📦 Full Install`).
  - **Failure / Rollback Alerts (Red `#e01e5a`)**: Root error diagnostics, rollback SHA details, and explicit Day 0 Teardown notifications for fast incident response.

### 10. Cross-Platform Process Runner
* Automatically discovers the platform execution environment:
  - **Windows**: Dynamically resolves Git Bash (`C:\Program Files\Git\bin\bash.exe`) to execute POSIX shell scripts with standard utilities (`curl`, `seq`, `sed`).
  - **Linux / macOS**: Natively resolves `/bin/bash` or `bash` from system `PATH`.

---

## 📁 Repository Structure

```
CICD-with-Github-Webhooks/
├── configs/
│   └── redis.js             # Redis client initialization (maxRetriesPerRequest: null)
├── queues/
│   └── deployQueue.js       # BullMQ deployment queue definition
├── services/
│   ├── githubStatus.js      # GitHub REST Commit Status API client
│   └── notifier.js          # Slack ChatOps webhook notifications (Block Kit)
├── workers/
│   └── deployWorker.js      # BullMQ worker: concurrency 1, LKG state, process spawner
├── .env.example             # Documented environment variable template
├── .gitignore               # Excludes secrets, node_modules, and temporary artifacts
├── app.js                   # Express server, raw HMAC verification & webhook endpoint
├── deploy.sh                # Shell script: directory guard, pull, change detection, PM2, LKG rollback
├── package.json             # ES Module project definition & scripts
└── README.md                # Technical documentation & systems architecture
```

---

## 🛠️ Getting Started

### Prerequisites
- **Node.js**: `>= 20.0.0`
- **Redis Server**: `>= 6.0` (Running locally on `127.0.0.1:6379` or accessible via network)
- **Git** & **Bash** (Git Bash on Windows or standard bash on Linux/macOS)
- **PM2**: `npm install -g pm2` (Optional for production process management; script falls back gracefully in simulation mode)

### 1. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/Subham0813/CICD-Server.git
cd CICD-Server
npm install
```

### 2. Environment Configuration
Copy `.env.example` to create your local `.env`:
```bash
cp .env.example .env
```

Configure your variables:
```env
PORT=4566
WEBHOOK_SECRET=your_github_webhook_secret_here

# Redis Configuration (BullMQ Queue)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Deployment Target Configuration
DEPLOY_SCRIPT_PATH=./deploy.sh
TARGET_DIR=../learning-gh-action
TARGET_PORT=4000

# GitHub Commit Status API (Requires repo:status or commit status permission)
GITHUB_TOKEN=ghp_your_personal_access_token_here

# Slack Incoming Webhook (Optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
```

### 3. Running AutoShip
```bash
# Production mode
npm start

# Development mode (with file watcher)
npm run dev
```

---

## 🌐 Webhook Setup on GitHub

1. In your GitHub repository, navigate to **Settings > Webhooks > Add webhook**.
2. **Payload URL**: `https://<your-domain-or-ngrok-tunnel>/api/github/webhook`
3. **Content type**: `application/json`
4. **Secret**: Enter the secret configured in `WEBHOOK_SECRET`.
5. **Events**: Select **Just the push event** (or **Let me select individual events** -> **Pushes**).
6. Click **Add webhook**. AutoShip will automatically handle GitHub's `ping` handshake and acknowledge it with `200 OK`.

---

## 📡 API Reference

### Health Check
```http
GET /health
```
**Response (200 OK):**
```json
{
  "msg": "Server is healthy."
}
```

### GitHub Webhook Receiver
```http
POST /api/github/webhook
```

**Required Headers:**
| Header | Value | Description |
| :--- | :--- | :--- |
| `x-hub-signature-256` | `sha256=<hex_digest>` | HMAC-SHA256 signature calculated over raw body |
| `x-github-event` | `push` \| `ping` | GitHub event type |
| `Content-Type` | `application/json` | Request payload format |

**Response (202 Accepted):**
```json
{
  "msg": "Deployment queued successfully",
  "jobId": "28"
}
```

---

## 🔮 Upcoming Roadmap

- [ ] **Live Build Log Streaming via Server-Sent Events (SSE)**: Expose real-time build stdout/stderr streaming to browser dashboards and CLI consumers (`GET /api/deployments/:jobId/logs`) using event-driven SSE and Redis Pub/Sub buffer caching for late joiners.
- [ ] **Webhook Replay Protection**: Redis nonce and timestamp sliding-window verification to safeguard against intercepted webhook replay attempts.
- [ ] **Multi-Tenant Git Worktree Isolation**: Dynamically isolate concurrent builds across different repositories using ephemeral `git worktree` directories.
