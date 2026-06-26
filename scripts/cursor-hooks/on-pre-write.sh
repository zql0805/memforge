#!/usr/bin/env bash
# Hook: preToolUse (Write/StrReplace) — 代码修改前自动加载编码规范
# 把 "修改代码前必须调用 get_system_rules" 从 AI 记忆变成系统强制
# 每会话仅触发一次（去重），将规范注入 agent_message

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/memforge-common.sh"

input=$(cat)

file_path=$(echo "$input" | jq -r '.input.path // .input.filePath // empty' 2>/dev/null)

case "$file_path" in
  *.md|*.json|*.yml|*.yaml|*.txt|*.csv|*.env*|*.lock|*.tsbuildinfo)
    echo '{"permission":"allow"}'
    exit 0
    ;;
esac

_mf_load_config || { echo '{"permission":"allow"}'; exit 0; }

if ! _mf_check_once "get_system_rules"; then
  echo '{"permission":"allow"}'
  exit 0
fi

cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
product_line=$(_mf_detect_product_line "$cwd")

lang=""
case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx) lang="typescript" ;;
  *.java) lang="java" ;;
  *.php) lang="php" ;;
  *.py) lang="python" ;;
  *.go) lang="go" ;;
esac

rules_args=$(jq -n \
  --arg pl "$product_line" \
  --arg lang "$lang" \
  '{product_line:$pl, language:$lang, format:"prompt"}')

rules_result=$(_mf_call_tool "get_system_rules" "$rules_args")

session_id=$(_mf_session_id)
recall_file="$MEMFORGE_SESSION_DIR/${session_id}-recall-result.txt"

if [ -n "$rules_result" ] && [ "$rules_result" != "null" ]; then
  tmpfile=$(mktemp)
  echo "[Memforge 编码规范 — 本会话所有代码变更必须遵守]" > "$tmpfile"
  echo "${rules_result:0:20000}" >> "$tmpfile"
  if [ ${#rules_result} -gt 20000 ]; then
    echo "" >> "$tmpfile"
    echo "（规则已截断，完整版本请通过 get_system_rules 工具获取）" >> "$tmpfile"
  fi
  if [ -f "$recall_file" ]; then
    echo "" >> "$tmpfile"
    echo "[Memforge 记忆检索结果]" >> "$tmpfile"
    cat "$recall_file" >> "$tmpfile"
    rm -f "$recall_file"
  fi
  cat "$tmpfile" | jq -Rs '{permission:"allow", agent_message:.}'
  rm -f "$tmpfile"
  _mf_log "get_system_rules 已注入 ($lang)"
else
  echo '{"permission":"allow"}'
fi
exit 0
