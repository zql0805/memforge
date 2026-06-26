#!/bin/bash
# Created by dev on 2026/04/08
# Copyright © 2026
# Memforge 日志轮转（建议加入 crontab 每日执行一次）
# 保留最近 7 天日志，压缩归档旧文件

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT_DIR/.logs"

MAX_DAYS=${LOG_ROTATE_DAYS:-7}
MAX_SIZE_MB=${LOG_ROTATE_SIZE_MB:-50}

if [ ! -d "$LOG_DIR" ]; then
  exit 0
fi

rotated=0

for logfile in "$LOG_DIR"/*.log; do
  [ -f "$logfile" ] || continue
  base=$(basename "$logfile")

  size_mb=$(( $(stat -f%z "$logfile" 2>/dev/null || stat -c%s "$logfile" 2>/dev/null || echo 0) / 1048576 ))

  if [ "$size_mb" -ge "$MAX_SIZE_MB" ]; then
    timestamp=$(date '+%Y%m%d-%H%M%S')
    gzip -c "$logfile" > "${logfile%.log}-${timestamp}.log.gz"
    : > "$logfile"
    ((rotated++))
    echo "$(date '+%H:%M:%S') 轮转: $base (${size_mb}MB → 已压缩归档)"
  fi
done

deleted=0
for gz in "$LOG_DIR"/*.log.gz; do
  [ -f "$gz" ] || continue
  if [ "$(find "$gz" -mtime +${MAX_DAYS} 2>/dev/null)" ]; then
    rm -f "$gz"
    ((deleted++))
  fi
done

if [ "$rotated" -gt 0 ] || [ "$deleted" -gt 0 ]; then
  echo "$(date '+%H:%M:%S') 日志轮转完成: 轮转 $rotated 个, 清理 $deleted 个过期归档"
fi
