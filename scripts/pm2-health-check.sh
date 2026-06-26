#!/bin/bash
# Created by dev on 2026/04/27
# PM2 模式下的健康检查（配合 cron 使用）
# watchdog.sh 用于 nohup/launchd 模式；本脚本用于 PM2 生产部署
# 用法: */5 * * * * /path/to/memforge/scripts/pm2-health-check.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG="$ROOT_DIR/.logs/pm2-health.log"
mkdir -p "$(dirname "$LOG")"

GATEWAY_URL="http://127.0.0.1:3000/health"
MEMORY_URL="http://127.0.0.1:3001/health"
RULES_URL="http://127.0.0.1:3002/health"

MAX_LOG_SIZE=1048576
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
  mv "$LOG" "$LOG.old"
fi

restart_count=0

check_and_restart() {
  local name=$1 url=$2 pm2_name=$3
  local code
  code=$(curl -m 5 -sf -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [ "$code" != "200" ]; then
    echo "[$(date)] WARN: $name 返回 $code，执行 pm2 restart $pm2_name" >> "$LOG"
    pm2 restart "$pm2_name" >> "$LOG" 2>&1
    ((restart_count++))
    sleep 8
    local retry_code
    retry_code=$(curl -m 5 -sf -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
    if [ "$retry_code" = "200" ]; then
      echo "[$(date)] RECOVERED: $name 已恢复" >> "$LOG"
    else
      echo "[$(date)] FAILED: $name 重启后仍返回 $retry_code" >> "$LOG"
    fi
  fi
}

check_and_restart "memory-service" "$MEMORY_URL" "memory-service"
check_and_restart "rules-engine" "$RULES_URL" "rules-engine"
check_and_restart "gateway" "$GATEWAY_URL" "gateway"

if [ "$restart_count" -gt 0 ]; then
  WEBHOOK_URL="${WATCHDOG_WEBHOOK_URL:-}"
  if [ -n "$WEBHOOK_URL" ]; then
    curl -sf -X POST "$WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\"$(date) Memforge pm2-health: 重启了 $restart_count 个服务\"}" \
      --connect-timeout 5 --max-time 10 > /dev/null 2>&1 || true
  fi
fi

# 整点记录心跳
minute=$(date +%M)
if [ "$minute" = "00" ] && [ "$restart_count" -eq 0 ]; then
  echo "[$(date)] OK: 所有服务健康" >> "$LOG"
fi
