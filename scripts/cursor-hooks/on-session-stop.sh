#!/usr/bin/env bash
# Hook: stop — P4-A 增强：自动注入结构化提取指令
# 有代码变更时触发自动提取，普通会话静默提醒

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MEMFORGE_SESSION_DIR="${TMPDIR:-/tmp}/memforge-hooks"

session_id="${CURSOR_SESSION_ID:-$(echo "$$-$PPID" | md5sum 2>/dev/null | cut -c1-12 || echo "default")}"
counter_file="$MEMFORGE_SESSION_DIR/${session_id}-write-count"
write_count=$(cat "$counter_file" 2>/dev/null || echo "0")

if [ "$write_count" -ge 3 ]; then
  jq -n '{
    "followup_message": "会话包含多文件代码变更，请执行收尾：\n1. 如果 extract_session_memories 工具可用，调用它自动提取本次会话的记忆\n2. 否则调用 store_structured_memory({ type: \"session_summary\" }) 存储关键决策和经验\n3. 检查是否有 user_profile 类记忆需要更新（技术偏好、代码风格等）\n4. 调用 AskQuestion 作为最后一个工具调用（GATE 0）",
    "extraction_hints": {
      "categories": [
        {"scope": "architecture", "signal": "出现了架构选型、技术方案讨论、系统设计决策"},
        {"scope": "bug_pattern", "signal": "修复了 Bug 或发现了错误模式"},
        {"scope": "lesson_learned", "signal": "踩坑经验、调试发现、非直觉的技术约束"},
        {"scope": "coding_standard", "signal": "确立了编码规范或最佳实践"},
        {"scope": "user_profile", "signal": "用户表达了技术偏好、代码风格或工具使用习惯"},
        {"scope": "entity_reference", "signal": "讨论了特定项目、服务、人物或概念实体"}
      ],
      "dedup_note": "存储前先 recall_memory 检查是否已有高度相似的记忆（阈值 0.85）"
    }
  }'
else
  jq -n '{
    "additional_context": "[Memforge] 确保最后一个工具调用是 AskQuestion（GATE 0）。如有架构决策或重要经验，调用 store_structured_memory 存储。如有技术偏好变化，存储为 user_profile scope。"
  }'
fi
exit 0
