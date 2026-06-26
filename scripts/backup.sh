#!/usr/bin/env bash
# Memforge 备份脚本 — PostgreSQL + Redis
# Created by dev on 2026/04/05
#
# 用法:
#   ./scripts/backup.sh                  # 默认备份到 ./backups/
#   ./scripts/backup.sh /mnt/nas/backup  # 指定目录
#   BACKUP_RETAIN_DAYS=30 ./scripts/backup.sh  # 保留 30 天

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-7}"

DB_USER="${DB_USER:-memforge}"
DB_NAME="${DB_NAME:-memforge}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"

mkdir -p "$BACKUP_DIR"

echo "=== Memforge 备份开始 [$TIMESTAMP] ==="

# ─── PostgreSQL 备份 ─────────────────────────────
PG_BACKUP="$BACKUP_DIR/pg_${TIMESTAMP}.sql.gz"
echo "[1/3] PostgreSQL 备份 → $PG_BACKUP"

pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --no-owner \
  --no-privileges \
  --format=plain \
  --schema=memory \
  | gzip > "$PG_BACKUP"

PG_SIZE=$(du -h "$PG_BACKUP" | cut -f1)
echo "  PostgreSQL 备份完成: $PG_SIZE"

# ─── Redis 备份 (RDB 快照) ──────────────────────
REDIS_BACKUP="$BACKUP_DIR/redis_${TIMESTAMP}.rdb"
echo "[2/3] Redis RDB 快照 → $REDIS_BACKUP"

redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" BGSAVE >/dev/null 2>&1 || true
sleep 2

REDIS_RDB_PATH=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" CONFIG GET dir | tail -1)
REDIS_RDB_FILE=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" CONFIG GET dbfilename | tail -1)

if [ -f "$REDIS_RDB_PATH/$REDIS_RDB_FILE" ]; then
  cp "$REDIS_RDB_PATH/$REDIS_RDB_FILE" "$REDIS_BACKUP"
  REDIS_SIZE=$(du -h "$REDIS_BACKUP" | cut -f1)
  echo "  Redis 备份完成: $REDIS_SIZE"
else
  echo "  Redis RDB 文件不存在，尝试 Docker volume..."
  docker cp memforge-redis:/data/dump.rdb "$REDIS_BACKUP" 2>/dev/null || echo "  跳过 Redis 备份 (无法访问)"
fi

# ─── 清理过期备份 ────────────────────────────────
echo "[3/3] 清理 ${RETAIN_DAYS} 天前的旧备份..."
DELETED=$(find "$BACKUP_DIR" -name "pg_*.sql.gz" -mtime +"$RETAIN_DAYS" -delete -print | wc -l)
find "$BACKUP_DIR" -name "redis_*.rdb" -mtime +"$RETAIN_DAYS" -delete
echo "  已删除 $DELETED 个过期备份"

echo ""
echo "=== 备份完成 ==="
echo "  PostgreSQL: $PG_BACKUP ($PG_SIZE)"
echo "  Redis:      $REDIS_BACKUP"
echo "  保留策略:   ${RETAIN_DAYS} 天"
