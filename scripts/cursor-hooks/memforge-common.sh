#!/usr/bin/env bash
# Memforge Cursor Hooks — 共享工具函数
# 所有 hook 脚本 source 此文件获取配置和 API 调用能力

set -uo pipefail

MEMFORGE_SESSION_DIR="${TMPDIR:-/tmp}/memforge-hooks"
mkdir -p "$MEMFORGE_SESSION_DIR"

_mf_log() {
  echo "[memforge-hook] $1" >&2
}

# 自动从 Cursor MCP 配置（~/.cursor/mcp.json）或独立配置文件读取凭据
# 优先级：环境变量 > mcp.json > memforge-hook-config.json
_mf_load_config() {
  # 1. 已有环境变量（CI/测试场景）
  if [ -n "${MEMFORGE_URL:-}" ] && [ -n "${MEMFORGE_API_KEY:-}" ]; then
    return 0
  fi

  # 2. 从 Cursor MCP 配置自动读取（零配置）
  local mcp_json="$HOME/.cursor/mcp.json"
  if [ -f "$mcp_json" ] && command -v python3 &>/dev/null; then
    eval "$(python3 -c "
import json, sys
try:
    with open('$mcp_json') as f:
        d = json.load(f)
    for k,v in d.get('mcpServers',{}).items():
        if 'memforge' in k.lower():
            env = v.get('env',{})
            key = env.get('MEMFORGE_API_KEY','')
            url = env.get('MEMFORGE_GATEWAY_URL','')
            if key and url:
                print(f'MEMFORGE_API_KEY=\"{key}\"')
                print(f'MEMFORGE_URL=\"{url}\"')
                break
except: pass
" 2>/dev/null)"
    if [ -n "${MEMFORGE_URL:-}" ] && [ -n "${MEMFORGE_API_KEY:-}" ]; then
      export MEMFORGE_URL MEMFORGE_API_KEY
      return 0
    fi
  fi

  # 3. 独立配置文件（后备）
  local config="${MEMFORGE_HOOK_CONFIG:-$HOME/.cursor/memforge-hook-config.json}"
  if [ -f "$config" ]; then
    MEMFORGE_URL=$(jq -r '.gateway_url // empty' "$config")
    MEMFORGE_API_KEY=$(jq -r '.api_key // empty' "$config")
    if [ -n "$MEMFORGE_URL" ] && [ -n "$MEMFORGE_API_KEY" ]; then
      export MEMFORGE_URL MEMFORGE_API_KEY
      return 0
    fi
  fi

  _mf_log "无法获取 Memforge 凭据（检查 mcp.json 或 memforge-hook-config.json）"
  return 1
}

# 调用 Memforge MCP 工具
# 用法: _mf_call_tool <tool_name> <arguments_json>
# 返回: tool 返回的 text content (去除 JSON-RPC 包装)
_mf_call_tool() {
  local tool_name="$1"
  local arguments="$2"
  local payload
  payload=$(jq -n \
    --arg method "tools/call" \
    --arg name "$tool_name" \
    --argjson args "$arguments" \
    '{jsonrpc:"2.0", method:$method, params:{name:$name, arguments:$args}, id:1}')

  local response
  response=$(curl -s --max-time 15 \
    -X POST "$MEMFORGE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $MEMFORGE_API_KEY" \
    -d "$payload" 2>/dev/null)

  if [ $? -ne 0 ] || [ -z "$response" ]; then
    _mf_log "API 调用失败: $tool_name"
    return 1
  fi

  # Streamable HTTP 可能返回 SSE 格式（event: message\ndata: {...}）或纯 JSON
  local json_data
  if [[ "$response" == event:* ]]; then
    json_data=$(printf '%s' "$response" | grep '^data:' | sed 's/^data: *//')
  else
    json_data="$response"
  fi

  printf '%s' "$json_data" | jq -r '.result.content[0].text // empty' 2>/dev/null
}

# 获取当前 session 标识（基于 PID 树，避免跨 session 混淆）
_mf_session_id() {
  # Cursor agent 每次会话有不同的进程树，用 PPID 链路 hash 作为 session ID
  echo "${CURSOR_SESSION_ID:-$(echo "$$-$PPID" | md5sum 2>/dev/null | cut -c1-12 || echo "default")}"
}

# 检查本 session 是否已执行过某个操作（去重）
# 用法: _mf_check_once <operation_name> && echo "首次" || echo "已执行过"
_mf_check_once() {
  local op="$1"
  local session_id
  session_id=$(_mf_session_id)
  local flag_file="$MEMFORGE_SESSION_DIR/${session_id}-${op}.done"

  # 清理超过 4 小时的旧标记
  find "$MEMFORGE_SESSION_DIR" -name "*.done" -mmin +240 -delete 2>/dev/null

  if [ -f "$flag_file" ]; then
    return 1
  fi
  touch "$flag_file"
  return 0
}

# 从工作区路径推断 product_line
_mf_detect_product_line() {
  local cwd="${1:-$PWD}"
  case "$cwd" in
    */work/your-org/product/*)
      echo "${MEMFORGE_PRODUCT_LINE:-default}" ;;
    */work/mine/media/*)
      echo "mediav" ;;
    */work/ai-tools/memforge*|*/memforge*)
      echo "memforgesc" ;;
    *)
      echo "" ;;
  esac
}

# 确保 ~/.memforge/config 存在（git hook 脚本运行时需要读取）
_mf_ensure_shared_config() {
  local config_file="$HOME/.memforge/config"
  if [ ! -f "$config_file" ] || ! grep -q "GATEWAY_URL" "$config_file" 2>/dev/null; then
    mkdir -p "$HOME/.memforge" && chmod 700 "$HOME/.memforge"
    printf '# Memforge 共享配置 — 由 IDE hook 自动生成\nGATEWAY_URL=%s\nHOOK_API_KEY=%s\n' \
      "${MEMFORGE_URL%/}" "$MEMFORGE_API_KEY" > "$config_file"
    chmod 600 "$config_file"
  fi
}

# 检查并自动安装/升级 git hooks
_mf_sync_git_hooks() {
  local cwd="${1:-$PWD}"
  local git_root
  git_root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || return 0
  local hooks_dir="$git_root/.git/hooks"
  [ -d "$hooks_dir" ] || return 0

  _mf_ensure_shared_config

  # 提取本地版本
  local local_ver=""
  if [ -f "$hooks_dir/post-commit" ]; then
    local_ver=$(grep -o '\[memforge-auto-installed\] v[^ ]*' "$hooks_dir/post-commit" 2>/dev/null | sed 's/.*v//')
  fi

  # 从 Gateway 获取模板（带 ETag 缓存）
  local resp http_code
  if [ -n "$local_ver" ]; then
    resp=$(curl -s -w '\n%{http_code}' -H "If-None-Match: $local_ver" \
      "${MEMFORGE_URL%/}/api/setup/git-hooks-template" 2>/dev/null)
  else
    resp=$(curl -s -w '\n%{http_code}' \
      "${MEMFORGE_URL%/}/api/setup/git-hooks-template" 2>/dev/null)
  fi
  http_code=$(printf '%s' "$resp" | tail -1)
  [ "$http_code" = "304" ] && return 0
  [ "$http_code" = "200" ] || return 0

  local body
  body=$(printf '%s' "$resp" | sed '$d')
  local version
  version=$(printf '%s' "$body" | jq -r '.version // empty' 2>/dev/null)
  [ -z "$version" ] && return 0

  local installed=0
  for hook_type in post-commit post-merge; do
    local hook_path="$hooks_dir/$hook_type"
    # 跳过非 memforge 的自定义 hooks
    if [ -f "$hook_path" ] && ! grep -q 'memforge' "$hook_path" 2>/dev/null; then
      continue
    fi
    local content
    content=$(printf '%s' "$body" | jq -r ".scripts[\"$hook_type\"] // empty" 2>/dev/null)
    [ -z "$content" ] && continue
    printf '%s\n' "$content" > "$hook_path"
    chmod 755 "$hook_path"
    installed=$((installed + 1))
  done

  [ "$installed" -gt 0 ] && _mf_log "Git hooks 已升级到 v$version ($git_root)"
}
