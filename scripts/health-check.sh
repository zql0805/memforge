#!/usr/bin/env bash
# Memforge 健康检查脚本
# Created by dev on 2026/04/05
#
# 用法: ./scripts/health-check.sh
# 返回: 0=健康, 1=部分异常, 2=严重故障

set -uo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3000}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-memforge}"
DB_NAME="${DB_NAME:-memforge}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"

WARNINGS=0
ERRORS=0

check() {
  local name="$1"
  local result="$2"
  local code="$3"

  if [ "$code" -eq 0 ]; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name — $result"
    ((ERRORS++))
  fi
}

warn() {
  local name="$1"
  local msg="$2"
  echo "  ⚠ $name — $msg"
  ((WARNINGS++))
}

echo "=== Memforge 健康检查 ==="
echo ""

# ─── PostgreSQL ──────────────────────────────────
echo "[PostgreSQL]"
PG_RESULT=$(pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" 2>&1)
check "连接" "$PG_RESULT" $?

PG_VERSION=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -t -c "SELECT version();" 2>/dev/null | head -1 | xargs)
if [ -n "$PG_VERSION" ]; then
  echo "  ✓ 版本: $PG_VERSION"
else
  check "查询" "无法连接数据库" 1
fi

SCHEMA_OK=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='memory';" 2>/dev/null | xargs)
if [ "${SCHEMA_OK:-0}" -gt 0 ]; then
  echo "  ✓ memory schema: ${SCHEMA_OK} 张表"
else
  check "Schema" "memory schema 缺失或无表" 1
fi

ENTRY_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -t -c "SELECT COUNT(*) FROM memory.entries;" 2>/dev/null | xargs)
echo "  ℹ 记忆条数: ${ENTRY_COUNT:-?}"

echo ""

# ─── Redis ───────────────────────────────────────
echo "[Redis]"
REDIS_PING=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>&1)
if [ "$REDIS_PING" = "PONG" ]; then
  echo "  ✓ 连接正常"
else
  check "连接" "$REDIS_PING" 1
fi

REDIS_MEM=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" INFO memory 2>/dev/null | grep "used_memory_human" | cut -d: -f2 | tr -d '\r')
echo "  ℹ 内存使用: ${REDIS_MEM:-?}"

echo ""

# ─── Gateway (可选) ──────────────────────────────
echo "[Gateway]"
GW_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/health" 2>/dev/null || echo "000")
if [ "$GW_HEALTH" = "200" ]; then
  echo "  ✓ 运行中 ($GATEWAY_URL)"
else
  warn "Gateway" "未运行或不可达 (HTTP $GW_HEALTH) — 仅 Gateway 模式需要"
fi

echo ""

# ─── 磁盘空间 ───────────────────────────────────
echo "[磁盘]"
DISK_USAGE=$(df -h . | tail -1 | awk '{print $5}')
DISK_PCT=$(echo "$DISK_USAGE" | tr -d '%')
if [ "${DISK_PCT:-0}" -gt 90 ]; then
  warn "磁盘" "使用率 ${DISK_USAGE}，超过 90%"
elif [ "${DISK_PCT:-0}" -gt 80 ]; then
  warn "磁盘" "使用率 ${DISK_USAGE}，超过 80%"
else
  echo "  ✓ 使用率: ${DISK_USAGE}"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$ERRORS" -gt 0 ]; then
  echo "结果: ✗ 发现 $ERRORS 个错误, $WARNINGS 个警告"
  exit 2
elif [ "$WARNINGS" -gt 0 ]; then
  echo "结果: ⚠ $WARNINGS 个警告, 无严重错误"
  exit 1
else
  echo "结果: ✓ 全部正常"
  exit 0
fi
