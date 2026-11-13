#!/usr/bin/env bash
set -eo pipefail

# config
BRANCH="${1:-main}"
DEPS_CHANGED="${2:-true}"
LKG_COMMIT="${3:-${LKG_COMMIT:-}}"
PORT="${TARGET_PORT:-4000}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
MAX_RETRIES=5
RETRY_DELAY=2

echo "[DEPLOY] starting for branch : ${BRANCH}"

# If TARGET_DIR is set, navigate to target project repository
TARGET_DIR="${TARGET_DIR:-../learning-gh-action}"
if [ -n "${TARGET_DIR}" ] && [ -d "${TARGET_DIR}" ]; then
    echo "[DEPLOY] Target directory specified. Switching to: ${TARGET_DIR}"
    cd "${TARGET_DIR}"
fi

# LKG check
if [ -n "${LKG_COMMIT}" ]; then
    echo "[DEPLOY] LKG commit from Redis: ${LKG_COMMIT}"
else
    echo "[DEPLOY] Day 0 detected: No prior verified LKG on record."
fi

# pull latest changes
echo "[DEPLOY] pulling latest code..."
git fetch origin ${BRANCH}
git checkout ${BRANCH}
git pull origin ${BRANCH}

# clean install prod deps
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

# reload application via pm2
if command -v pm2 >/dev/null 2>&1; then
    pm2 reload ecosystem.config.js || pm2 restart ecosystem.config.js
else
    echo "[DEPLOY] pm2 not found in PATH; skipping PM2 reload (local simulation mode)"
fi

# Health check of deploymwnt
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
            pm2 delete ecosystem.config.js || pm2 stop ecosystem.config.js || true
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
            pm2 reload ecosystem.config.js || pm2 restart ecosystem.config.js || true
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

