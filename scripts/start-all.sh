#!/bin/bash
# Created by dev on 2026/04/05
# Copyright © 2026
# Memforge 全套服务一键启动脚本（本地开发环境）

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PID_DIR="$ROOT_DIR/.pids"
LOG_DIR="$ROOT_DIR/.logs"

mkdir -p "$PID_DIR" "$LOG_DIR"

# 加载 .env（如果存在），.env.local 覆盖 .env
for envfile in "$ROOT_DIR/.env" "$ROOT_DIR/.env.local"; do
  if [ -f "$envfile" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$envfile"
    set +a
  fi
done

DB_URL="${DATABASE_URL:-postgresql://localhost:5432/memforge}"
MODEL_TIER="${EMBEDDING_MODEL_TIER:-L3}"
MODELS_DIR="${MODELS_BASE_DIR:-$ROOT_DIR/models}"

echo "🚀 Memforge 全套服务启动"
echo "  模型: $MODEL_TIER"
echo "  数据库: $(echo "$DB_URL" | sed 's|//.*:.*@|//<hidden>@|')"
echo ""

# 0. 安装 Cursor 规则到全局（幂等，无变化时静默）
bash "$SCRIPT_DIR/install-rules.sh"

# 0.1 检查 ripgrep（拓扑扫描依赖，缺失时仅警告不阻塞）
if ! command -v rg &>/dev/null; then
  echo "⚠️  ripgrep (rg) 未安装。拓扑扫描将只能检测 SDK 级依赖，无法发现 MOA/RPC 调用链。"
  echo "   安装: brew install ripgrep"
fi

# 1. 等待 PostgreSQL 就绪（最多 60s，解决 launchd 开机竞态）
PG_READY=false
PG_HOST=$(echo "$DB_URL" | sed -n 's|.*://[^@]*@\([^:/]*\).*|\1|p')
PG_PORT=$(echo "$DB_URL" | sed -n 's|.*://[^@]*@[^:]*:\([0-9]*\).*|\1|p')
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
for i in $(seq 1 30); do
  if command -v pg_isready &>/dev/null; then
    pg_isready -h "$PG_HOST" -p "$PG_PORT" -q 2>/dev/null && PG_READY=true && break
  else
    (echo > "/dev/tcp/$PG_HOST/$PG_PORT") 2>/dev/null && PG_READY=true && break
  fi
  if [ "$i" -eq 1 ]; then
    echo "⏳ 等待 PostgreSQL 就绪 ($PG_HOST:$PG_PORT)..."
  fi
  sleep 2
done
if [ "$PG_READY" = false ]; then
  echo "❌ PostgreSQL 60s 内未就绪，放弃启动"
  exit 1
fi
echo "✅ PostgreSQL 已就绪"

# 2. 检查并启动 Redis（最多等待 20s）
if ! redis-cli PING > /dev/null 2>&1; then
  echo "⏳ 启动 Redis..."
  if command -v brew &>/dev/null; then
    brew services start redis > /dev/null 2>&1 || redis-server --daemonize yes
  else
    redis-server --daemonize yes 2>/dev/null || sudo systemctl start redis-server 2>/dev/null || true
  fi
  for i in $(seq 1 10); do
    if redis-cli PING > /dev/null 2>&1; then break; fi
    sleep 2
  done
fi
if ! redis-cli PING > /dev/null 2>&1; then
  echo "⚠️  Redis 未就绪，部分缓存功能可能不可用"
else
  echo "✅ Redis 已就绪"
fi

# 3. Memory Service (HTTP:3001)
if lsof -ti:3001 > /dev/null 2>&1; then
  echo "⚠️  端口 3001 已占用，跳过 Memory Service"
else
  echo "⏳ 启动 Memory Service (HTTP:3001)..."
  TRANSPORT_MODE=http PORT=3001 \
    BIND_HOST="${BIND_HOST:-127.0.0.1}" \
    DATABASE_URL="$DB_URL" \
    JWT_SECRET="${JWT_SECRET:?请在 .env.local 中设置 JWT_SECRET}" \
    MODELS_BASE_DIR="$MODELS_DIR" \
    EMBEDDING_MODEL_TIER="$MODEL_TIER" \
    LOG_LEVEL=info \
    nohup npx tsx "$ROOT_DIR/packages/memory-service/src/index.ts" \
    > "$LOG_DIR/memory-service.log" 2>&1 &
  echo $! > "$PID_DIR/memory-service.pid"
  # BGE-M3 模型加载需要 ~8s，最多等待 30s
  for i in $(seq 1 15); do
    if curl -sf http://127.0.0.1:3001/health > /dev/null 2>&1; then
      echo "✅ Memory Service 运行中 (PID: $(cat "$PID_DIR/memory-service.pid"))"
      break
    fi
    if [ "$i" -eq 15 ]; then
      echo "❌ Memory Service 启动超时(30s)，查看 $LOG_DIR/memory-service.log"
    fi
    sleep 2
  done
fi

# 4. Rules Engine (HTTP:3002)
if lsof -ti:3002 > /dev/null 2>&1; then
  echo "⚠️  端口 3002 已占用，跳过 Rules Engine"
else
  echo "⏳ 启动 Rules Engine (HTTP:3002)..."
  TRANSPORT_MODE=http PORT=3002 \
    BIND_HOST="${BIND_HOST:-127.0.0.1}" \
    DATABASE_URL="$DB_URL" \
    JWT_SECRET="${JWT_SECRET:?请在 .env.local 中设置 JWT_SECRET}" \
    MODELS_BASE_DIR="$MODELS_DIR" \
    EMBEDDING_MODEL_TIER="$MODEL_TIER" \
    LOG_LEVEL=info \
    nohup npx tsx "$ROOT_DIR/packages/rules-engine/src/index.ts" \
    > "$LOG_DIR/rules-engine.log" 2>&1 &
  echo $! > "$PID_DIR/rules-engine.pid"
  for i in $(seq 1 15); do
    if curl -sf http://127.0.0.1:3002/health > /dev/null 2>&1; then
      echo "✅ Rules Engine 运行中 (PID: $(cat "$PID_DIR/rules-engine.pid"))"
      break
    fi
    if [ "$i" -eq 15 ]; then
      echo "❌ Rules Engine 启动超时(30s)，查看 $LOG_DIR/rules-engine.log"
    fi
    sleep 2
  done
fi

# 5. Knowledge Service (HTTP:3003)
if lsof -ti:3003 > /dev/null 2>&1; then
  echo "⚠️  端口 3003 已占用，跳过 Knowledge Service"
else
  echo "⏳ 启动 Knowledge Service (HTTP:3003)..."
  TRANSPORT_MODE=http PORT=3003 \
    BIND_HOST="${BIND_HOST:-127.0.0.1}" \
    DATABASE_URL="$DB_URL" \
    JWT_SECRET="${JWT_SECRET:?请在 .env.local 中设置 JWT_SECRET}" \
    MODELS_BASE_DIR="$MODELS_DIR" \
    EMBEDDING_MODEL_TIER="$MODEL_TIER" \
    LOG_LEVEL=info \
    nohup npx tsx "$ROOT_DIR/packages/knowledge-service/src/index.ts" \
    > "$LOG_DIR/knowledge-service.log" 2>&1 &
  echo $! > "$PID_DIR/knowledge-service.pid"
  for i in $(seq 1 15); do
    if curl -sf http://127.0.0.1:3003/health > /dev/null 2>&1; then
      echo "✅ Knowledge Service 运行中 (PID: $(cat "$PID_DIR/knowledge-service.pid"))"
      break
    fi
    if [ "$i" -eq 15 ]; then
      echo "❌ Knowledge Service 启动超时(30s)，查看 $LOG_DIR/knowledge-service.log"
    fi
    sleep 2
  done
fi

# 6. Gateway (HTTP:3000)
if lsof -ti:3000 > /dev/null 2>&1; then
  echo "⚠️  端口 3000 已占用，跳过 Gateway"
else
  echo "⏳ 启动 Gateway (HTTP:3000)..."
  JWT_SECRET="${JWT_SECRET:?请在 .env.local 中设置 JWT_SECRET}" \
  PORT=3000 \
    GATEWAY_HOST="${GATEWAY_HOST:-${BIND_HOST:-127.0.0.1}}" \
    CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173}" \
    MEMORY_SERVICE_URL=http://127.0.0.1:3001 \
    RULES_SERVICE_URL=http://127.0.0.1:3002 \
    KNOWLEDGE_SERVICE_URL=http://127.0.0.1:3003 \
    DATABASE_URL="$DB_URL" \
    LOG_LEVEL=info \
    nohup npx tsx "$ROOT_DIR/packages/gateway/src/index.ts" \
    > "$LOG_DIR/gateway.log" 2>&1 &
  echo $! > "$PID_DIR/gateway.pid"
  for i in $(seq 1 10); do
    if curl -sf http://127.0.0.1:3000/health > /dev/null 2>&1; then
      echo "✅ Gateway 运行中 (PID: $(cat "$PID_DIR/gateway.pid"))"
      break
    fi
    if [ "$i" -eq 10 ]; then
      echo "❌ Gateway 启动超时(20s)，查看 $LOG_DIR/gateway.log"
    fi
    sleep 2
  done
fi

# 7. Web UI (5173)
if lsof -ti:5173 > /dev/null 2>&1; then
  echo "⚠️  端口 5173 已占用，跳过 Web UI"
else
  WEBUI_DIR="$ROOT_DIR/packages/web-ui"
  WEBUI_MODE="${WEBUI_MODE:-preview}"

  VITE_HOST="${BIND_HOST:-127.0.0.1}"
  if [ "$WEBUI_MODE" = "dev" ]; then
    echo "⏳ 启动 Web UI (Vite dev:5173, host:$VITE_HOST)..."
    cd "$WEBUI_DIR"
    nohup npx vite --port 5173 --host "$VITE_HOST" > "$LOG_DIR/web-ui.log" 2>&1 &
  else
    if [ ! -d "$WEBUI_DIR/dist" ]; then
      echo "⏳ 首次构建 Web UI..."
      cd "$WEBUI_DIR"
      npx vue-tsc -b && npx vite build >> "$LOG_DIR/web-ui-build.log" 2>&1
      echo "✅ Web UI 构建完成"
    fi
    echo "⏳ 启动 Web UI (preview:5173, host:$VITE_HOST)..."
    cd "$WEBUI_DIR"
    nohup npx vite preview --port 5173 --host "$VITE_HOST" > "$LOG_DIR/web-ui.log" 2>&1 &
  fi
  echo $! > "$PID_DIR/web-ui.pid"
  cd "$ROOT_DIR"
  sleep 2
  echo "✅ Web UI 运行中 (PID: $(cat "$PID_DIR/web-ui.pid")) [mode: $WEBUI_MODE]"
fi

echo ""
echo "🎉 全部服务已启动！"
echo ""
echo "  📊 Web UI:         http://localhost:5173"
echo "  🔗 Gateway:        http://localhost:3000"
echo "  🧠 Memory Service:    http://localhost:3001"
echo "  📏 Rules Engine:      http://localhost:3002"
echo "  📚 Knowledge Service: http://localhost:3003"
echo ""
echo "  停止所有服务: bash scripts/stop-all.sh"
echo "  查看日志: tail -f .logs/<service>.log"

# launchd 模式：前台阻塞等待子进程，使 KeepAlive 生效
# 手动运行 (无 LAUNCHD_MODE) 时脚本立即返回
if [ "${LAUNCHD_MODE:-}" = "1" ]; then
  EXIT_CODE=0

  cleanup() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') 停止所有服务 (exit=$EXIT_CODE)..."
    for pf in "$PID_DIR"/*.pid; do
      [ -f "$pf" ] || continue
      pid=$(cat "$pf")
      kill "$pid" 2>/dev/null || true
    done
    for port in 3001 3002 3003 3000 5173; do
      lsof -ti:"$port" 2>/dev/null | xargs kill 2>/dev/null || true
    done
    echo "$(date '+%Y-%m-%d %H:%M:%S') 所有服务已停止"
    exit "$EXIT_CODE"
  }
  trap 'EXIT_CODE=0; cleanup' SIGTERM SIGINT SIGHUP

  echo "$(date '+%Y-%m-%d %H:%M:%S') [launchd] 前台守护模式，等待子进程..."

  while true; do
    sleep 30
    for port in 3001 3002 3003 3000; do
      if ! curl -sf --connect-timeout 2 "http://127.0.0.1:$port/health" > /dev/null 2>&1; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [launchd] 端口 $port 健康检查失败，退出以触发 launchd 重启"
        EXIT_CODE=1
        cleanup
      fi
    done
  done
fi
