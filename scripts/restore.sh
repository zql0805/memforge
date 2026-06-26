#!/usr/bin/env bash
# Memforge 恢复脚本 — 从备份还原 PostgreSQL
# Created by dev on 2026/04/05
#
# 用法:
#   ./scripts/restore.sh backups/pg_20260405_120000.sql.gz

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "用法: $0 <pg-backup-file.sql.gz>"
  echo "示例: $0 backups/pg_20260405_120000.sql.gz"
  exit 1
fi

PG_BACKUP="$1"

if [ ! -f "$PG_BACKUP" ]; then
  echo "错误: 备份文件不存在 — $PG_BACKUP"
  exit 1
fi

DB_USER="${DB_USER:-memforge}"
DB_NAME="${DB_NAME:-memforge}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

echo "=== Memforge 恢复 ==="
echo "  备份文件: $PG_BACKUP"
echo "  目标库:   $DB_NAME@$DB_HOST:$DB_PORT"
echo ""
read -p "确认恢复? 这将覆盖 memory schema 中的所有数据 (y/N): " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "已取消"
  exit 0
fi

echo "[1/3] 清除现有 memory schema..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -c "DROP SCHEMA IF EXISTS memory CASCADE;" 2>/dev/null || true

echo "[2/3] 恢复 schema 结构..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -f sql/init.sql

echo "[3/3] 恢复数据..."
gunzip -c "$PG_BACKUP" | psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"

echo ""
echo "=== 恢复完成 ==="

ENTRY_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -t -c "SELECT COUNT(*) FROM memory.entries;" 2>/dev/null || echo "?")
RULE_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -t -c "SELECT COUNT(*) FROM memory.coding_rules;" 2>/dev/null || echo "?")

echo "  记忆条数: $ENTRY_COUNT"
echo "  规则条数: $RULE_COUNT"
