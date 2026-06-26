#!/usr/bin/env bash
# Hook: sessionStart — 自动 recall_memory
# 把 GATE 1 "AI 软约束" 变成 "系统硬保障"
# 每会话首次触发时调用 recall_memory，将结果注入 agent 上下文

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/memforge-common.sh"

input=$(cat)

_mf_load_config || { echo '{}'; exit 0; }

# 从 stdin 提取工作区路径
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
product_line=$(_mf_detect_product_line "$cwd")

if [ -z "$product_line" ]; then
  echo '{}'
  exit 0
fi

# 调用 recall_memory — 使用产品线和项目名作为泛化 query
project_name=$(basename "$cwd" 2>/dev/null || echo "unknown")
recall_args=$(jq -n \
  --arg query "$project_name 项目架构 编码规范 最近经验" \
  --arg pl "$product_line" \
  '{query:$query, product_line:$pl, limit:5, format:"prompt"}')

recall_result=$(_mf_call_tool "recall_memory" "$recall_args")

if [ -n "$recall_result" ] && [ "$recall_result" != "null" ]; then
  _mf_log "recall_memory 完成，已注入 session 上下文"
  # sessionStart 不支持直接注入 agent_message
  # 将结果写入临时文件，供后续 preToolUse hook 读取并注入
  session_id=$(_mf_session_id)
  echo "$recall_result" > "$MEMFORGE_SESSION_DIR/${session_id}-recall-result.txt"
fi

# Git hooks 自动检查（按项目 git root 去重）
if [ -n "$cwd" ]; then
  _git_root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$_git_root" ]; then
    _dedup_key="git-hooks-sync-$(echo "$_git_root" | md5sum 2>/dev/null | cut -c1-8 || echo "${_git_root##*/}")"
    if _mf_check_once "$_dedup_key"; then
      _mf_sync_git_hooks "$cwd"
    fi
  fi
fi

echo '{}'
exit 0
