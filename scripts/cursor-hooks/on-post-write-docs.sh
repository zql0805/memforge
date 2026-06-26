#!/usr/bin/env bash
# Hook: postToolUse (Write/StrReplace) — docs/ 文件变更后自动 sync_documents
# 把 "文档更新后同步索引" 从 AI 自觉变成系统自动
# 仅对 docs/ 路径下的文件触发，完全无副作用

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/memforge-common.sh"

input=$(cat)

file_path=$(echo "$input" | jq -r '.input.path // .input.filePath // empty' 2>/dev/null)

# 仅对 docs/ 目录下的文件触发
case "$file_path" in
  */docs/*) ;; # match
  *) echo '{}'; exit 0 ;;
esac

_mf_load_config || { echo '{}'; exit 0; }

cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
project_root="${cwd:-$PWD}"

sync_args=$(jq -n \
  --arg root "$project_root" \
  '{project_root:$root, dry_run:false}')

# 异步执行，不阻塞主流程
(_mf_call_tool "sync_documents" "$sync_args" >/dev/null 2>&1 && \
  _mf_log "sync_documents 完成: $file_path") &

echo '{}'
exit 0
