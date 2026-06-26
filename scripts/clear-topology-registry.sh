#!/bin/bash
# Created by dev on 2026/04/07
# 删除 ~/.cursor/<产品线>-registry.json，避免未过期注册表导致「跳过扫描」沿用旧结果。
# 用法: bash scripts/clear-topology-registry.sh <产品线名称>

set -e
PL="${1:?用法: bash scripts/clear-topology-registry.sh <产品线名称>}"
F="$HOME/.cursor/${PL}-registry.json"
if [[ -f "$F" ]]; then
  rm -f "$F"
  echo "已删除: $F"
else
  echo "文件不存在（跳过）: $F"
fi
