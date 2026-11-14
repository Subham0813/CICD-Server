#!/usr/bin/env bash
set -eo pipefail

# Never hang on interactive terminal prompts in non-interactive CI/CD runs
export GIT_TERMINAL_PROMPT=0

# Configuration
BRANCH="${BRANCH:-}"
REPOSITORY="${REPOSITORY:-}"
IS_PRIVATE="${IS_PRIVATE:-false}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

echo "[DEPLOY] starting for branch : ${BRANCH}"

#  Resolve repository name and target directory
REPO_NAME="${REPOSITORY##*/}"
TARGET_DIR="${TARGET_DIR:-../${REPO_NAME}}"

# Guard against accidental deployment inside CI/CD server directory
if [ "${TARGET_DIR}" = "." ] || [ -z "${REPO_NAME}" ]; then
    echo "[DEPLOY] FATAL: Refusing to deploy inside CI/CD server directory."
    exit 1
fi

JUST_CLONED=0

# If target directory does not exist, provision it via git clone
if [ ! -d "${TARGET_DIR}" ]; then
    echo "[DEPLOY] Target directory '${TARGET_DIR}' does not exist."

    # Guard: Private repo requires GITHUB_TOKEN
    if [ "${IS_PRIVATE}" = "true" ] && [ -z "${GITHUB_TOKEN}" ]; then
        echo "[DEPLOY] FATAL: Repository '${REPOSITORY}' is PRIVATE, but GITHUB_TOKEN is not configured!"
        echo "[DEPLOY] Please configure GITHUB_TOKEN in your .env file with repo read permissions."
        exit 1
    fi

    echo "[DEPLOY] Initializing fresh clone for ${REPOSITORY} (${BRANCH})..."
    mkdir -p "$(dirname "${TARGET_DIR}")"

    if [ -n "${GITHUB_TOKEN}" ]; then
        CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPOSITORY}.git"
    else
        CLONE_URL="https://github.com/${REPOSITORY}.git"
    fi

    git clone --branch "${BRANCH}" "${CLONE_URL}" "${TARGET_DIR}"
    JUST_CLONED=1
fi

echo "[DEPLOY] Switching directory to target: ${TARGET_DIR}"
cd "${TARGET_DIR}"

# LKG check
LKG_COMMIT="${LKG_COMMIT:-}"
if [ -n "${LKG_COMMIT}" ]; then
    echo "[DEPLOY] LKG commit from Redis: ${LKG_COMMIT}"
else
    echo "[DEPLOY] Day 0 detected: No prior verified LKG on record."
fi

# Check Remote URL matches repository
CURRENT_REMOTE=$(git config --get remote.origin.url || true)
if [[ "${CURRENT_REMOTE}" != *"${REPOSITORY}"* ]]; then
    echo "[DEPLOY] FATAL: Directory remote '${CURRENT_REMOTE}' does not match target repo '${REPOSITORY}'!"
    exit 1
fi

# Pull latest changes (skip if freshly cloned)
if [ ${JUST_CLONED} -eq 0 ]; then
    echo "[DEPLOY] pulling latest code..."
    git fetch origin ${BRANCH}
    git checkout ${BRANCH}
    git pull origin ${BRANCH}
else
    echo "[DEPLOY] Repository freshly cloned on branch ${BRANCH}. Skipping redundant git pull."
fi

# Clean install prod dependencies
DEPS_CHANGED="${DEPS_CHANGED:-}"
if [ "$DEPS_CHANGED" = "true" ] || [ ! -d "node_modules" ]; then
    if [ -f "package.json" ]; then
        echo "[DEPLOY] Dependencies changed (or node_modules missing). clean installing dependencies..."
        npm ci --omit=dev
    else
        echo "[DEPLOY] No package.json found in target. Skipping npm ci."
    fi
else
    echo "[DEPLOY] Dependencies unchanged. Skipping clean installation...(fast deploy)"
fi

# Reload/Restart/Start application via pm2
CONFIG_PATH=${CONFIG_PATH:-ecosystem.config.js}
if command -v pm2 >/dev/null 2>&1; then
    pm2 reload ${CONFIG_PATH} || pm2 restart ${CONFIG_PATH} || pm2 start ${CONFIG_PATH}
else
    echo "[DEPLOY] pm2 not found in PATH; skipping PM2 reload (local simulation mode)"
fi

# Health check of deploymwnt
PORT="${TARGET_PORT:-4000}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
MAX_RETRIES=5
RETRY_DELAY=2
echo "[CHECK] checking server health..."
HEALTHY=0
for i in $(seq 1 $MAX_RETRIES); do
    attempts="${i}/${MAX_RETRIES}"
    echo "[CHECK] Attempt ${attempts} checking ${HEALTH_URL}..."
    if curl -s -f -m 3 "${HEALTH_URL}" > /dev/null; then
        HEALTHY=1
        echo "[CHECK] Server is healthy..."
        break
    fi
    sleep ${RETRY_DELAY}
done

# Rollback logic if health check failed
if [ ${HEALTHY} -eq 0 ]; then
    if [ -z "${LKG_COMMIT}" ]; then
        echo "[ROLLBACK] FATAL: Initial deployment (Day 0) failed health checks!"
        echo "[ROLLBACK] No prior LKG exists. Executing service teardown to prevent port collisions..."

        # Kill PM2 process to free port and resources
        if command -v pm2 >/dev/null 2>&1; then
            pm2 delete ${CONFIG_PATH} || pm2 stop ${CONFIG_PATH} || true
        fi

        git reset --hard HEAD
        echo "[ROLLBACK] Service successfully torn down. Manual intervention required for initial release."
        exit 1
    else
        echo "[ROLLBACK] FATAL: Healthcheck failed! Rolling back to LKG: ${LKG_COMMIT}"

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
            echo "[ROLLBACK] Rollback successful, application restored to healthy state."
        else
            echo "[ROLLBACK] FATAL: Rollback failed to restore healthy state! Manual intervention required."
        fi
        exit 1
    fi
fi

echo "[DEPLOY] deployment succesful for branch : ${BRANCH}"
exit 0
