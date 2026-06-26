#!/usr/bin/env bash
# Hook: postToolUse — Code Review 完成后提醒存储 P0/P1 发现
# 触发条件：postToolUse 事件中检测到 agent 输出包含 Code Review 相关关键词
# 注意：此 hook 匹配所有 postToolUse，由脚本内部判断是否为 Review 场景

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/memforge-common.sh"

input=$(cat)

# 检查 tool output 是否包含 Code Review 结果标记
tool_output=$(echo "$input" | jq -r '.output // .result // empty' 2>/dev/null)
tool_name=$(echo "$input" | jq -r '.toolName // empty' 2>/dev/null)

# 仅对特定工具响应检查（Write/StrReplace 完成后通常跟随 Review）
# 实际 Review 结果在 agent 的文本输出中，不在 tool output 中
# 此 hook 作为提醒机制，在大批量文件修改后注入 additional_context 提醒 Review

# 统计本 session 修改的文件数
session_id=$(_mf_session_id)
counter_file="$MEMFORGE_SESSION_DIR/${session_id}-write-count"

case "$tool_name" in
  Write|StrReplace)
    count=$(cat "$counter_file" 2>/dev/null || echo "0")
    count=$((count + 1))
    echo "$count" > "$counter_file"

    # 修改超过 2 个文件时，注入 Review 提醒
    if [ "$count" -eq 3 ]; then
      jq -n '{
        "additional_context": "已修改 3+ 个文件。完成所有修改后，请执行 Code Review（6 项必检清单），P0/P1 发现自动调用 store_code_review 存储到 Memforge。"
      }'
      exit 0
    fi
    ;;
esac

echo '{}'
exit 0
