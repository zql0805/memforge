#!/usr/bin/env bash
# 自动拉取部署守护进程（PM2 托管，10 秒轮询）
# PM2: pm2 start scripts/auto-pull-deploy.sh --name auto-deploy --cron-restart="0 */6 * * *"
set -uo pipefail

DEPLOY_DIR="${MEMFORGE_DEPLOY_DIR:-/opt/memforge}"
BRANCH="${MEMFORGE_GIT_BRANCH:-main}"
POLL_INTERVAL="${DEPLOY_POLL_INTERVAL:-10}"
LOG_DIR="$DEPLOY_DIR/.logs"
LOCK_FILE="$DEPLOY_DIR/.deploy.lock"
LOG_FILE="$LOG_DIR/auto-pull-deploy.log"
PATH="$PATH:/usr/local/bin:/usr/local/lib/node_modules/pm2/bin"

mkdir -p "$LOG_DIR"

log() { echo "[$(date +%Y-%m-%d\ %H:%M:%S)] $1" | tee -a "$LOG_FILE"; }

cleanup() {
  rm -f "$LOCK_FILE"
  log "守护进程退出"
  exit 0
}
trap cleanup SIGTERM SIGINT

deploy_once() {
  if [ -f "$LOCK_FILE" ]; then
    pid=$(cat "$LOCK_FILE" 2>/dev/null)
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  echo $$ > "$LOCK_FILE"

  cd "$DEPLOY_DIR" || return 1

  git fetch origin "$BRANCH" --quiet 2>/dev/null || return 0
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null) || return 0

  if [ "$LOCAL" = "$REMOTE" ]; then
    rm -f "$LOCK_FILE"
    return 0
  fi

  log "检测到新提交: ${LOCAL:0:8} → ${REMOTE:0:8}"

  git merge "origin/$BRANCH" --ff-only >> "$LOG_FILE" 2>&1 || { log "merge 失败"; rm -f "$LOCK_FILE"; return 1; }

  CHANGED=$(git diff "$LOCAL".."$REMOTE" --name-only 2>/dev/null || echo "")

  if echo "$CHANGED" | grep -qE "package(-lock)?\.json"; then
    log "安装依赖..."
    npm install --production=false >> "$LOG_FILE" 2>&1
  fi

  if echo "$CHANGED" | grep -qE "packages/(shared|memory-service|gateway|rules-engine|knowledge-service)/"; then
    log "编译后端..."
    npx tsc -b packages/memory-service packages/gateway packages/rules-engine packages/knowledge-service >> "$LOG_FILE" 2>&1
  fi

  if echo "$CHANGED" | grep -q "packages/web-ui/"; then
    log "构建前端..."
    (cd packages/web-ui && npx vite build >> "$LOG_FILE" 2>&1)
  fi

  NEED_RESTART=false
  if echo "$CHANGED" | grep -qE "packages/(shared|memory-service|gateway|rules-engine|knowledge-service)/"; then
    NEED_RESTART=true
  fi
  if echo "$CHANGED" | grep -qE "ecosystem\.config\.cjs"; then
    NEED_RESTART=true
  fi

  if [ "$NEED_RESTART" = true ]; then
    log "重启后端..."
    source "$DEPLOY_DIR/.env.production" 2>/dev/null || true
    pm2 restart ecosystem.config.cjs --update-env >> "$LOG_FILE" 2>&1
    pm2 save >> "$LOG_FILE" 2>&1
  fi

  sleep 3
  for port in 3001 3002 3003 3000; do
    if curl -sf --connect-timeout 3 "http://127.0.0.1:$port/health" > /dev/null 2>&1; then
      log "端口 $port ✓"
    else
      log "端口 $port ✗"
    fi
  done

  log "部署完成: $(git rev-parse --short HEAD)"
  rm -f "$LOCK_FILE"
}

log "自动部署守护启动 — 分支: $BRANCH, 间隔: ${POLL_INTERVAL}s"

while true; do
  deploy_once
  sleep "$POLL_INTERVAL"
done
