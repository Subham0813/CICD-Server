#!/usr/bin/env bash
set -eo pipefail

# Never hang on interactive terminal prompts in non-interactive CI/CD runs
export GIT_TERMINAL_PROMPT=0

# Configuration
BRANCH="${BRANCH:-}"
REPOSITORY="${REPOSITORY:-}"
COMMIT_SHA="${COMMIT_SHA:-}"
IS_PRIVATE="${IS_PRIVATE:-false}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
DEPLOY_ENV="${DEPLOY_ENV:-production}"

echo "[Deploy] [INFO] Starting deployment for branch: ${BRANCH} [${DEPLOY_ENV}]"

# Guard: Mandatory repository and commit SHA
if [ -z "${REPOSITORY}" ]; then
    echo "[Deploy] [FATAL] REPOSITORY is required but was not provided!"
    exit 1
fi

if [ -z "${COMMIT_SHA}" ]; then
    echo "[Deploy] [FATAL] COMMIT_SHA is required but was not provided! Refusing unverified branch tip execution."
    exit 1
fi

# Guard: Mandatory TARGET_DIR from projects.config.json
if [ -z "${TARGET_DIR}" ]; then
    echo "[Deploy] [FATAL] TARGET_DIR was not provided! Configure it in projects.config.json."
    exit 1
fi

# Guard: Mandatory TARGET_PORT from projects.config.json
if [ -z "${TARGET_PORT}" ]; then
    echo "[Deploy] [FATAL] TARGET_PORT was not provided! Configure it in projects.config.json."
    exit 1
fi

# Resolve repository name
REPO_NAME="${REPOSITORY##*/}"

# Guard against accidental deployment inside CI/CD server directory
if [ "${TARGET_DIR}" = "." ] || [ -z "${REPO_NAME}" ]; then
    echo "[Deploy] [FATAL] Refusing to deploy inside CI/CD server directory."
    exit 1
fi

JUST_CLONED=0

# If target directory does not exist, provision it via git clone
if [ ! -d "${TARGET_DIR}" ]; then
    echo "[Deploy] [INFO] Target directory '${TARGET_DIR}' does not exist."

    # Guard: Private repo requires GITHUB_TOKEN
    if [ "${IS_PRIVATE}" = "true" ] && [ -z "${GITHUB_TOKEN}" ]; then
        echo "[Deploy] [FATAL] Repository '${REPOSITORY}' is PRIVATE, but GITHUB_TOKEN is not configured!"
        echo "[Deploy] [FATAL] Please configure GITHUB_TOKEN in your .env file with repo read permissions."
        exit 1
    fi

    echo "[Deploy] [INFO] Initializing fresh clone for ${REPOSITORY} (${BRANCH})..."
    mkdir -p "$(dirname "${TARGET_DIR}")"

    if [ -n "${GITHUB_TOKEN}" ]; then
        CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPOSITORY}.git"
    else
        CLONE_URL="https://github.com/${REPOSITORY}.git"
    fi

    git clone --branch "${BRANCH}" "${CLONE_URL}" "${TARGET_DIR}"
    JUST_CLONED=1
fi

echo "[Deploy] [INFO] Switching directory to target: ${TARGET_DIR}"
cd "${TARGET_DIR}"

# LKG check
LKG_COMMIT="${LKG_COMMIT:-}"
if [ -n "${LKG_COMMIT}" ]; then
    echo "[Deploy] [INFO] LKG commit from Redis: ${LKG_COMMIT}"
else
    echo "[Deploy] [INFO] Day 0 detected: No prior verified LKG on record."
fi

# Check Remote URL matches repository
CURRENT_REMOTE=$(git config --get remote.origin.url || true)
if [[ "${CURRENT_REMOTE}" != *"${REPOSITORY}"* ]]; then
    echo "[Deploy] [FATAL] Directory remote '${CURRENT_REMOTE}' does not match target repo '${REPOSITORY}'!"
    exit 1
fi

# Synchronize code to exact COMMIT_SHA
if [ ${JUST_CLONED} -eq 0 ]; then
    echo "[Deploy] [INFO] Fetching latest changes for branch: ${BRANCH}..."
    git fetch origin "${BRANCH}"
    git checkout "${BRANCH}"

    echo "[Deploy] [INFO] Synchronizing working tree to target commit: ${COMMIT_SHA}"
    git reset --hard "${COMMIT_SHA}"
else
    echo "[Deploy] [INFO] Repository freshly cloned on branch ${BRANCH}. Skipping redundant fetch."
fi

# Inject production environment secrets if configured
ENV_SOURCE="${ENV_SOURCE:-}"
if [ -n "${ENV_SOURCE}" ]; then
    if [ ! -f "${ENV_SOURCE}" ]; then
        echo "[Deploy] [FATAL] Configured ENV_SOURCE '${ENV_SOURCE}' does not exist on disk!"
        echo "[Deploy] [FATAL] Please place the secrets file on the server before deploying."
        exit 1
    fi
    echo "[Deploy] [INFO] Injecting production secrets from '${ENV_SOURCE}' into '.env'..."
    cp -f "${ENV_SOURCE}" ".env"
fi

# Clean install prod dependencies
DEPS_CHANGED="${DEPS_CHANGED:-}"
if [ "$DEPS_CHANGED" = "true" ] || [ ! -d "node_modules" ]; then
    if [ -f "package.json" ]; then
        echo "[Deploy] [INFO] Dependencies changed (or node_modules missing). Clean installing dependencies (npm ci)..."
        npm ci --omit=dev
    else
        echo "[Deploy] [INFO] No package.json found in target. Skipping npm ci."
    fi
else
    echo "[Deploy] [INFO] Dependencies unchanged. Skipping clean installation (fast deploy)."
fi

# Reload/Restart/Start application via pm2
CONFIG_PATH=${CONFIG_PATH:-ecosystem.config.js}
if command -v pm2 >/dev/null 2>&1; then
    pm2 reload ${CONFIG_PATH} || pm2 restart ${CONFIG_PATH} || pm2 start ${CONFIG_PATH}
else
    echo "[Deploy] [WARN] pm2 not found in PATH; skipping PM2 reload (local simulation mode)"
fi

# Health check of deployment (strict port from projects.config.json)
PORT="${TARGET_PORT}"
HEALTH_ENDPOINT="${HEALTH_ENDPOINT:-/health}"
HEALTH_URL="http://127.0.0.1:${PORT}${HEALTH_ENDPOINT}"
MAX_RETRIES=5
RETRY_DELAY=2
echo "[Health] [INFO] Checking server health at ${HEALTH_URL}..."
HEALTHY=0
for i in $(seq 1 $MAX_RETRIES); do
    attempts="${i}/${MAX_RETRIES}"
    echo "[Health] [INFO] Attempt ${attempts} checking ${HEALTH_URL}..."
    if curl -s -f -m 3 "${HEALTH_URL}" > /dev/null; then
        HEALTHY=1
        echo "[Health] [INFO] Server is healthy."
        break
    fi
    sleep ${RETRY_DELAY}
done

# Rollback logic if health check failed
if [ ${HEALTHY} -eq 0 ]; then
    if [ -z "${LKG_COMMIT}" ]; then
        echo "[Rollback] [FATAL] Initial deployment (Day 0) failed health checks!"
        echo "[Rollback] [WARN] No prior LKG exists. Executing service teardown to prevent port collisions..."

        # Kill PM2 process to free port and resources
        if command -v pm2 >/dev/null 2>&1; then
            pm2 delete ${CONFIG_PATH} || pm2 stop ${CONFIG_PATH} || true
        fi

        git reset --hard HEAD
        echo "[Rollback] [INFO] Service successfully torn down. Manual intervention required for initial release."
        exit 1
    else
        echo "[Rollback] [FATAL] Healthcheck failed! Rolling back to LKG: ${LKG_COMMIT}"

        git fetch origin
        git reset --hard "${LKG_COMMIT}"
        if [ -f "package.json" ]; then
            npm ci --omit=dev
        fi
        if command -v pm2 >/dev/null 2>&1; then
            pm2 reload ${CONFIG_PATH} || pm2 restart ${CONFIG_PATH} || pm2 start ${CONFIG_PATH} || true
        fi

        # Re-check health after rollback
        if curl -s -f -m 3 "${HEALTH_URL}" > /dev/null; then
            echo "[Rollback] [INFO] Rollback successful, application restored to healthy state."
        else
            echo "[Rollback] [FATAL] Rollback failed to restore healthy state! Manual intervention required."
        fi
        exit 1
    fi
fi

echo "[Deploy] [SUCCESS] Deployment successful for branch: ${BRANCH} [${DEPLOY_ENV}]"
exit 0
