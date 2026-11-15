# 🚀 AutoShip — Production-Grade Custom CI/CD Engine

A lightweight, self-hosted, event-driven CI/CD automation engine engineered with **Node.js**, **Express**, **BullMQ**, **Redis**, and **Bash**.

AutoShip transforms incoming GitHub push webhooks into serialized, zero-downtime deployment pipelines featuring **constant-time cryptographic HMAC verification**, **queue-based race-condition elimination**, **backpressure-safe live log streaming via Server-Sent Events (SSE)**, **dynamic workspace auto-provisioning with private repo authentication**, **intelligent change detection (Fast Deploy)**, **Redis-backed True LKG rollback with Day 0 protection**, and **real-time ChatOps alerts via Slack Block Kit**.

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
│  ├── 5. Throttle childProcess stream via pause()/resume() backpressure │
│  └── 6. Spawn deploy.sh via streaming child_process.spawn              │
└───────────────┬──────────────────────────────────────────┬─────────────┘
                │                                          │
                │ (stdout/stderr chunks)                   ▼
                │                          ┌─────────────────────────────┐
                │                          │ Deployment Execution        │
                │                          │ (deploy.sh)                 │
                │                          │ 1. Workspace Auto-Provision │
                │                          │ 2. Git Fetch & Checkout     │
                │                          │ 3. Fast Deploy Check        │
                │                          │ 4. PM2 Reload / Start       │
                │                          │ 5. Active /health Probe     │
                │                          └──────────────┬──────────────┘
                ▼                                         │
┌──────────────────────────────────────┐                  │
│  Redis Distributed Log Broker        │                  │
│  ├── RPUSH deployment:logs:<jobId>   │                  │
│  │   (Buffers history for replay)    │                  │
│  └── PUBLISH deployment:channel:<id> │                  │
│      (Broadcasts live log chunks)    │                  │
└──────────────────┬───────────────────┘                  │
                   │                                      │
                   ▼                                      ▼
┌──────────────────────────────────────┐       ┌─────────────────────────┐
│  SSE Streaming Endpoint              │       │ Outcomes:               │
│  GET /api/deployments/:jobId/logs    │       │ 🟢 Success:             │
│  ├── Replays historical logs         │       │   - Update Redis LKG    │
│  ├── Pipes live chunks in real time  │       │   - GitHub: "success"   │
│  ├── Backpressure-safe (res.drain)   │       │   - Green Slack Card    │
│  └── Emits 'event: complete' frame   │       │ 🔴 Failure:             │
└──────────────────────────────────────┘       │   - True LKG Rollback   │
                                               │   - Day 0 Teardown      │
                                               │   - GitHub: "failure"   │
                                               │   - Red Alert Card      │
                                               └─────────────────────────┘
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

### 3. Live Build Log Streaming via Server-Sent Events (SSE) & Dual Backpressure
* **The Problem**: Using `child_process.exec()` buffers stdout in memory up to Node's 1MB `maxBuffer` limit, crashing verbose builds. Furthermore, streaming live logs to slow HTTP clients without flow control causes server memory to balloon as unwritten chunks accumulate in RAM.
* **The Solution**: AutoShip implements an event-driven SSE pipeline (`GET /api/deployments/:jobId/logs`):
  - **W3C EventSource Standard**: Emits structured frames (`event: status`, `event: log`, `event: complete`) with mandatory `\n\n` delimiters.
  - **The Late-Joiner Problem**: Buffers all historical log lines in a Redis List (`RPUSH deployment:logs:<jobId>`) with a 1-hour TTL. Late joiners and refreshed pages receive a full historical replay before transitioning to live Redis Pub/Sub events.
  - **Dual-Tier Backpressure Protection**:
    1. *Worker Tier*: Throttles bash output by pausing `childProcess.stdout` until Redis acknowledges each write (`pause()` / `resume()`).
    2. *HTTP Tier*: Halts socket writes when the client's TCP kernel buffer is saturated (`res.write() === false`) and awaits the socket `'drain'` event before resuming.
  - **Proxy Heartbeat**: Transmits `: keep-alive\n\n` comments every 15s to prevent timeouts through Nginx, AWS ALBs, or Cloudflare.

### 4. Dynamic Workspace Auto-Provisioning & Private Repository Authentication
* **The Problem**: Requiring manual directory cloning breaks automation. If an unconfigured repository triggers a deployment, naive scripts execute in `.`, corrupting the CI/CD server itself. Furthermore, cloning private repositories in non-interactive CI/CD environments triggers interactive password prompts (`Username for 'https://github.com':`), freezing the worker indefinitely.
* **The Solution**:
  - Sets `export GIT_TERMINAL_PROMPT=0` to ensure Git fails immediately rather than hanging on credential prompts.
  - Dynamically extracts repository name (`REPO_NAME="${REPOSITORY##*/}"`) and resolves `TARGET_DIR="${TARGET_DIR:-../${REPO_NAME}}"`.
  - Rejects execution if `TARGET_DIR` evaluates to the CI/CD directory itself (`.`).
  - Automatically clones repositories that do not exist yet. If `isPrivate: true` is detected from the webhook payload, asserts that `GITHUB_TOKEN` is present and constructs an authenticated clone URL (`https://x-access-token:${GITHUB_TOKEN}@github.com/${REPOSITORY}.git`).
  - Synchronizes the working tree with cryptographic precision using `git reset --hard ${COMMIT_SHA}` (failing fast with exit code 1 if `COMMIT_SHA` is missing), completely avoiding `git pull` merge conflicts or divergence issues.

### 5. 12-Factor Environment-Based Parameter Injection
* **The Problem**: Passing deployment parameters as positional shell arguments (`./deploy.sh $1 $2 $3...`) is brittle. Adding, removing, or reordering parameters breaks backward compatibility and creates shell injection vulnerabilities if commit messages contain spaces or quotes.
* **The Solution**: Follows the **Twelve-Factor App methodology**. [workers/deployWorker.js](workers/deployWorker.js) passes structured configuration via `process.env` during process spawn (`BRANCH`, `REPOSITORY`, `COMMIT_SHA`, `DEPS_CHANGED`, `LKG_COMMIT`, `IS_PRIVATE`, `GITHUB_TOKEN`). The shell script reads these using POSIX parameter expansion (e.g., `BRANCH="${BRANCH:-}"`), ensuring clean, safe, and easily extensible contracts.

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
│   ├── projectConfig.js     # Resolves multi-project & branch routing rules
│   ├── projects.json        # Branch-to-port-and-directory mapping config
│   └── redis.js             # Standalone Redis client & config (maxRetriesPerRequest: null)
├── queues/
│   └── deployQueue.js       # BullMQ deployment queue definition (with retention)
├── scripts/
│   └── deploy.sh            # Shell script: workspace auto-clone, change detection, PM2, True LKG rollback
├── services/
│   ├── githubStatus.js      # GitHub REST Commit Status API client
│   ├── logStreamer.js       # SSE protocol, backpressure-safe streaming, Redis Pub/Sub
│   ├── notifier.js          # Slack ChatOps webhook notifications (Block Kit)
│   └── webhookHandler.js    # HMAC verification, event filtering, delta inspection
├── workers/
│   └── deployWorker.js      # BullMQ worker: concurrency 1, backpressure-paused spawn, True LKG
├── .env.example             # Documented environment variable template
├── .gitignore               # Excludes secrets, node_modules, and temporary artifacts
├── app.js                   # 31-line declarative Express gateway & route registry
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

# Deployment Target Configuration (Optional: defaults to auto-cloning ../<repo-name>)
DEPLOY_SCRIPT_PATH=./deploy.sh
TARGET_DIR=../learning-gh-action
TARGET_PORT=4000

# GitHub Status API & Private Repo Clone Token (Optional)
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
  "jobId": "31"
}
```

---

### Live Build Log Stream (Server-Sent Events)
Stream console output in real time as the deployment executes.

```http
GET /api/deployments/:jobId/logs
```

**Request via curl:**
```bash
curl -N http://127.0.0.1:4566/api/deployments/31/logs
```

**Request via Browser JavaScript:**
```javascript
const es = new EventSource("/api/deployments/31/logs");
es.addEventListener("status", (e) => console.log("🟡", e.data));
es.addEventListener("log", (e) => console.log("📄", e.data));
es.addEventListener("complete", (e) => {
  console.log("🏁 Finished:", JSON.parse(e.data));
  es.close();
});
```

**Sample Live Stream Output:**
```text
event: status
data: [Worker] Processing Job #31: Deploying Subham0813/learning-gh-action (master) - 2aaa030

event: status
data: [Worker] Current LKG on record: a8395f4

event: log
data: [DEPLOY] starting for branch : master

event: log
data: [DEPLOY] Switching directory to target: ../learning-gh-action

event: log
data: [DEPLOY] LKG commit from Redis: a8395f44a900122c400fdc975fb8a6952d4be704

event: log
data: [DEPLOY] pulling latest code...

event: log
data: From https://github.com/Subham0813/learning-gh-action
data:  * branch            master     -> FETCH_HEAD

event: log
data: Already up to date.

event: log
data: [CHECK] checking server health...

event: log
data: [CHECK] Attempt 1/5 checking http://127.0.0.1:4000/health...

event: log
data: [CHECK] Server is healthy...

event: log
data: [DEPLOY] deployment succesful for branch : master

event: complete
data: {"status":"success","code":0,"duration":"7.1s","commitSha":"2aaa030322bab50daf0d12a415f98d998d2ce927","message":"Deployment passed all health checks!"}
```

---

## 🔮 Upcoming Roadmap

- [x] **Live Build Log Streaming via Server-Sent Events (SSE)**: Expose real-time build stdout/stderr streaming to browser dashboards and CLI consumers (`GET /api/deployments/:jobId/logs`) using event-driven SSE and Redis Pub/Sub buffer caching for late joiners.
- [x] **Config-Driven Multi-Project Routing**: Add a `configs/projects.json` mapping configuration to support deploying multiple independent repositories on different ports from a single AutoShip instance.
- [x] **Branch-Based Environment Isolation**: Dynamically route `dev`/`develop` pushes to staging/test environments and `master`/`main` pushes to production in completely isolated directories.
- [ ] **Webhook Replay Protection**: Redis nonce and timestamp sliding-window verification to safeguard against intercepted webhook replay attempts.
