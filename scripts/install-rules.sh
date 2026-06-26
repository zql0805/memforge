#!/bin/bash
# Created by dev on 2026/04/05
# Copyright © 2026
# Memforge Cursor 规则安装脚本
# 将 Memforge 项目中的 .cursor/rules/ 安装到全局 ~/.cursor/rules/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SOURCE_DIR="$ROOT_DIR/.cursor/rules"
TARGET_DIR="$HOME/.cursor/rules"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "⚠️  源目录不存在: $SOURCE_DIR"
  exit 0
fi

mkdir -p "$TARGET_DIR"

INSTALLED=0
SKIPPED=0

for rule_file in "$SOURCE_DIR"/*.mdc; do
  [ -f "$rule_file" ] || continue
  
  filename="$(basename "$rule_file")"
  target="$TARGET_DIR/$filename"
  
  if [ -f "$target" ] && diff -q "$rule_file" "$target" > /dev/null 2>&1; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  
  cp "$rule_file" "$target"
  INSTALLED=$((INSTALLED + 1))
  echo "  📝 已安装: $filename"
done

if [ "$INSTALLED" -gt 0 ]; then
  echo "✅ Cursor 规则已安装 ($INSTALLED 个更新, $SKIPPED 个无变化)"
elif [ "$SKIPPED" -gt 0 ]; then
  echo "✅ Cursor 规则已是最新 ($SKIPPED 个无变化)"
else
  echo "⚠️  未找到规则文件"
fi
