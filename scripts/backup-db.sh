#!/bin/bash
# Created by dev on 2026/04/08
# Copyright © 2026
# Memforge PostgreSQL 定时备份脚本
# 建议加入 crontab 每日执行或通过 launchd 调度

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$ROOT_DIR/.env.local" ]; then
  set -a; . "$ROOT_DIR/.env.local"; set +a
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/.backups}"
MAX_BACKUPS=${MAX_BACKUPS:-7}
DB_NAME="${DB_NAME:-memforge}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql.gz"

if ! pg_isready -q 2>/dev/null; then
  echo "$(date '+%H:%M:%S') PostgreSQL 未就绪，跳过备份"
  exit 1
fi

echo "$(date '+%H:%M:%S') 开始备份 $DB_NAME..."

PG_DUMP="pg_dump"
for candidate in /usr/local/Cellar/postgresql@17/*/bin/pg_dump /opt/homebrew/Cellar/postgresql@17/*/bin/pg_dump /usr/local/opt/libpq/bin/pg_dump; do
  if [ -x "$candidate" ]; then PG_DUMP="$candidate"; break; fi
done

if "$PG_DUMP" "$DB_NAME" --no-owner --no-privileges 2>/dev/null | gzip > "$BACKUP_FILE"; then
  SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "$(date '+%H:%M:%S') 备份完成: $BACKUP_FILE ($SIZE)"
else
  echo "$(date '+%H:%M:%S') 备份失败"
  rm -f "$BACKUP_FILE"
  exit 1
fi

COUNT=$(find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -type f | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$MAX_BACKUPS" ]; then
  REMOVE_COUNT=$((COUNT - MAX_BACKUPS))
  find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -type f | sort | head -n "$REMOVE_COUNT" | while read -r old; do
    rm -f "$old"
    echo "$(date '+%H:%M:%S') 清理旧备份: $(basename "$old")"
  done
fi

echo "$(date '+%H:%M:%S') 当前保留 $MAX_BACKUPS 份备份"
