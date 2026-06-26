#!/bin/bash
# Created by dev on 2026/04/08
# Copyright © 2026
# Memforge 服务守护脚本（由 launchd 周期性调用）
# 检查各 HTTP 服务健康状态，自动重启已死进程

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PID_DIR="$ROOT_DIR/.pids"
LOG_DIR="$ROOT_DIR/.logs"

# 加载 .env.local（如果存在且 launchd 未注入环境变量）
if [ -f "$ROOT_DIR/.env.local" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ROOT_DIR/.env.local"
  set +a
fi

DB_URL="${DATABASE_URL:-postgresql://localhost:5432/memforge}"
MODEL_TIER="${EMBEDDING_MODEL_TIER:-L3}"
MODELS_DIR="${MODELS_BASE_DIR:-$ROOT_DIR/models}"

mkdir -p "$PID_DIR" "$LOG_DIR"

is_port_alive() {
  curl -sf --connect-timeout 2 "http://127.0.0.1:$1/health" > /dev/null 2>&1
}

is_vite_alive() {
  curl -sf --connect-timeout 2 "http://127.0.0.1:$1/" > /dev/null 2>&1
}

restart_count=0

if ! pg_isready -q 2>/dev/null; then
  echo "$(date '+%H:%M:%S') PostgreSQL 未就绪，跳过守护检查"
  exit 0
fi

# Memory Service (HTTP:3001)
if ! is_port_alive 3001; then
  echo "$(date '+%H:%M:%S') Memory Service 已死，重启..."
  lsof -ti:3001 2>/dev/null | xargs kill 2>/dev/null || true
  TRANSPORT_MODE=http PORT=3001 \
    DATABASE_URL="$DB_URL" \
    JWT_SECRET="${JWT_SECRET:-}" \
    CORS_ORIGINS="${CORS_ORIGINS:-}" \
    MODELS_BASE_DIR="$MODELS_DIR" \
    EMBEDDING_MODEL_TIER="$MODEL_TIER" \
    LOG_LEVEL=info \
    nohup npx tsx "$ROOT_DIR/packages/memory-service/src/index.ts" \
    > "$LOG_DIR/memory-service.log" 2>&1 &
  echo $! > "$PID_DIR/memory-service.pid"
  ((restart_count++))
  for i in $(seq 1 15); do
    if is_port_alive 3001; then
      echo "$(date '+%H:%M:%S') Memory Service 已恢复"
      break
    fi
    sleep 2
  done
fi

# Rules Engine (HTTP:3002)
if ! is_port_alive 3002; then
  echo "$(date '+%H:%M:%S') Rules Engine 已死，重启..."
  lsof -ti:3002 2>/dev/null | xargs kill 2>/dev/null || true
  TRANSPORT_MODE=http PORT=3002 \
    DATABASE_URL="$DB_URL" \
    JWT_SECRET="${JWT_SECRET:-}" \
    CORS_ORIGINS="${CORS_ORIGINS:-}" \
    MODELS_BASE_DIR="$MODELS_DIR" \
    EMBEDDING_MODEL_TIER="$MODEL_TIER" \
    LOG_LEVEL=info \
    nohup npx tsx "$ROOT_DIR/packages/rules-engine/src/index.ts" \
    > "$LOG_DIR/rules-engine.log" 2>&1 &
  echo $! > "$PID_DIR/rules-engine.pid"
  ((restart_count++))
  for i in $(seq 1 15); do
    if is_port_alive 3002; then
      echo "$(date '+%H:%M:%S') Rules Engine 已恢复"
      break
    fi
    sleep 2
  done
fi

# Gateway (HTTP:3000) — 依赖 Memory + Rules
if ! is_port_alive 3000; then
  echo "$(date '+%H:%M:%S') Gateway 已死，重启..."
  lsof -ti:3000 2>/dev/null | xargs kill 2>/dev/null || true
  JWT_SECRET="${JWT_SECRET:?watchdog: JWT_SECRET 未设置}" \
    PORT=3000 \
    CORS_ORIGINS="${CORS_ORIGINS:-}" \
    MEMORY_SERVICE_URL=http://127.0.0.1:3001 \
    RULES_ENGINE_URL=http://127.0.0.1:3002 \
    DATABASE_URL="$DB_URL" \
    LOG_LEVEL=info \
    nohup npx tsx "$ROOT_DIR/packages/gateway/src/index.ts" \
    > "$LOG_DIR/gateway.log" 2>&1 &
  echo $! > "$PID_DIR/gateway.pid"
  ((restart_count++))
  for i in $(seq 1 10); do
    if is_port_alive 3000; then
      echo "$(date '+%H:%M:%S') Gateway 已恢复"
      break
    fi
    sleep 2
  done
fi

# Web UI (5173)
if ! is_vite_alive 5173; then
  echo "$(date '+%H:%M:%S') Web UI 已死，重启..."
  lsof -ti:5173 2>/dev/null | xargs kill 2>/dev/null || true
  WEBUI_DIR="$ROOT_DIR/packages/web-ui"
  cd "$WEBUI_DIR"
  if [ -d "$WEBUI_DIR/dist" ]; then
    nohup npx vite preview --port 5173 > "$LOG_DIR/web-ui.log" 2>&1 &
  else
    nohup npx vite --port 5173 > "$LOG_DIR/web-ui.log" 2>&1 &
  fi
  echo $! > "$PID_DIR/web-ui.pid"
  cd "$ROOT_DIR"
  ((restart_count++))
  sleep 3
  echo "$(date '+%H:%M:%S') Web UI 已恢复"
fi

if [ "$restart_count" -gt 0 ]; then
  MSG="$(date '+%Y-%m-%d %H:%M:%S') Memforge watchdog: 重启了 $restart_count 个服务"
  echo "$MSG"

  WEBHOOK_URL="${WATCHDOG_WEBHOOK_URL:-}"
  if [ -n "$WEBHOOK_URL" ]; then
    curl -sf -X POST "$WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\"$MSG\"}" \
      --connect-timeout 5 --max-time 10 > /dev/null 2>&1 || true
  fi
fi
