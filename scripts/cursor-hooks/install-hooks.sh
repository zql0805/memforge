#!/usr/bin/env bash
# Memforge Cursor Hooks 安装脚本
# 将 hook 脚本安装到 ~/.cursor/hooks/memforge/
# 合并 hooks.json 到 ~/.cursor/hooks.json（保留已有 hooks）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CURSOR_DIR="$HOME/.cursor"
HOOKS_DIR="$CURSOR_DIR/hooks/memforge"
HOOKS_JSON="$CURSOR_DIR/hooks.json"
CONFIG_FILE="$CURSOR_DIR/memforge-hook-config.json"

echo "=== Memforge Cursor Hooks 安装 ==="

# 1. 复制 hook 脚本
echo "[1/4] 安装 hook 脚本到 $HOOKS_DIR ..."
mkdir -p "$HOOKS_DIR"
cp "$SCRIPT_DIR/memforge-common.sh" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/on-session-start.sh" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/on-pre-write.sh" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/on-post-write-docs.sh" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/on-session-stop.sh" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/on-post-review.sh" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR"/*.sh
echo "  ✓ 已安装 6 个脚本"

# 2. 合并 hooks.json
echo "[2/4] 合并 hooks.json ..."
if [ -f "$HOOKS_JSON" ]; then
  # 合并：保留已有 hooks，添加/替换 memforge 的 hooks
  # 使用 jq 深度合并
  if command -v jq &>/dev/null; then
    merged=$(jq -s '
      .[0] as $existing | .[1] as $new |
      $existing * {hooks: ($existing.hooks // {} | to_entries |
        map(select(.value | map(select(.command | startswith("hooks/memforge/") | not)) | length > 0) |
          .value |= map(select(.command | startswith("hooks/memforge/") | not))) |
        from_entries) + $new.hooks}
    ' "$HOOKS_JSON" "$SCRIPT_DIR/hooks.json" 2>/dev/null)

    if [ -n "$merged" ]; then
      echo "$merged" | jq '.' > "$HOOKS_JSON"
    else
      # jq 合并失败，备份后覆盖
      cp "$HOOKS_JSON" "${HOOKS_JSON}.bak"
      cp "$SCRIPT_DIR/hooks.json" "$HOOKS_JSON"
      echo "  ⚠ jq 合并失败，已备份原文件到 hooks.json.bak"
    fi
  else
    cp "$HOOKS_JSON" "${HOOKS_JSON}.bak"
    cp "$SCRIPT_DIR/hooks.json" "$HOOKS_JSON"
    echo "  ⚠ 未安装 jq，已备份原文件到 hooks.json.bak"
  fi
else
  cp "$SCRIPT_DIR/hooks.json" "$HOOKS_JSON"
fi
echo "  ✓ hooks.json 已更新"

# 3. 配置文件
echo "[3/4] 检查配置文件 ..."
if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" << 'EOF'
{
  "gateway_url": "http://localhost:3000",
  "api_key": "YOUR_API_KEY_HERE"
}
EOF
  echo "  ⚠ 已创建配置模板: $CONFIG_FILE"
  echo "    请编辑并填入你的 API Key（在 Memforge WebUI → 设置 → API Key 中获取）"
else
  echo "  ✓ 配置文件已存在"
fi

# 4. 验证依赖
echo "[4/4] 检查依赖 ..."
missing=""
for cmd in jq curl md5sum; do
  if ! command -v "$cmd" &>/dev/null; then
    # macOS 用 md5 替代 md5sum
    if [ "$cmd" = "md5sum" ] && command -v md5 &>/dev/null; then
      continue
    fi
    missing="$missing $cmd"
  fi
done
if [ -n "$missing" ]; then
  echo "  ⚠ 缺少依赖:$missing （brew install jq curl coreutils）"
else
  echo "  ✓ 所有依赖已安装"
fi

echo ""
echo "=== 安装完成 ==="
echo ""
echo "已注册的 Hooks："
echo "  ├── sessionStart  → recall_memory（会话启动时自动检索记忆）"
echo "  ├── preToolUse    → get_system_rules（首次代码修改前加载编码规范）"
echo "  ├── postToolUse   → sync_documents（docs/ 文件变更后同步索引）"
echo "  ├── postToolUse   → code_review 提醒（3+ 文件修改后提醒 Review）"
echo "  └── stop          → session_summary（会话结束时归档关键决策）"
echo ""
echo "下一步："
echo "  1. 编辑 $CONFIG_FILE 填入 API Key"
echo "  2. 重启 Cursor 使 hooks 生效"
echo "  3. 在 Cursor 设置 → Hooks 标签页确认 hooks 已加载"
