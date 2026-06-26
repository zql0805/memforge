#!/bin/bash
# 服务器仓库批量同步脚本：
#   1. 从数据库读取产品线所有仓库，克隆缺失的仓库
#   2. 拉取所有已克隆仓库的最新 master 代码
# 由 PM2 cron 调度，在 batch-index 之前运行

set -uo pipefail

REPOS_DIR="${REPOS_DIR:-/opt/memforge/repos}"
PRODUCT_LINE="${PRODUCT_LINE:-default}"
DB_URL="${DATABASE_URL:-postgresql://memforge:Memf0rge2026!@127.0.0.1:5432/memforge}"

if [ ! -d "$REPOS_DIR" ]; then
  mkdir -p "$REPOS_DIR"
fi

echo "═══════════════════════════════════════"
echo "  仓库同步开始 $(date '+%Y-%m-%d %H:%M:%S')"
echo "  产品线: $PRODUCT_LINE"
echo "═══════════════════════════════════════"

# ── Phase 1: 克隆缺失仓库 ──
cloned=0
clone_failed=0

while IFS='|' read -r repo_id remote_url; do
  repo_id=$(echo "$repo_id" | xargs)
  remote_url=$(echo "$remote_url" | xargs)
  [ -z "$repo_id" ] && continue

  # 防御：拒绝含协议前缀或特殊字符的异常 repo_id
  if echo "$repo_id" | grep -qE '^(git@|https?://|ssh://)' || echo "$repo_id" | grep -q ':'; then
    echo "[SKIP] $repo_id — repo_id 格式异常（含协议前缀或冒号），跳过"
    continue
  fi

  target_dir="$REPOS_DIR/$repo_id"
  if [ -d "$target_dir/.git" ]; then
    continue
  fi

  # SSH → HTTPS 转换
  clone_url="$remote_url"
  if echo "$clone_url" | grep -q "^git@"; then
    clone_url=$(echo "$clone_url" | sed 's|git@\(.*\):\(.*\)|https://\1/\2|')
  fi

  mkdir -p "$(dirname "$target_dir")"
  echo "[CLONE] $repo_id ..."
  if git clone --depth=1000 --single-branch "$clone_url" "$target_dir" 2>/dev/null; then
    echo "[CLONE] ✅ $repo_id"
    cloned=$((cloned + 1))
  else
    echo "[CLONE] ❌ $repo_id — clone 失败"
    clone_failed=$((clone_failed + 1))
    rm -rf "$target_dir"
  fi
done < <(psql "$DB_URL" -t -A -F'|' -c \
  "SELECT repo_id, git_remote_url FROM memory.topology_nodes WHERE product_line='$PRODUCT_LINE' AND git_remote_url IS NOT NULL ORDER BY repo_id")

if [ $cloned -gt 0 ] || [ $clone_failed -gt 0 ]; then
  echo ""
  echo "  克隆完成: 新增=$cloned 失败=$clone_failed"
  echo ""
fi

# ── Phase 1.5: 更新注册表（如有新克隆） ──
if [ $cloned -gt 0 ]; then
  REGISTRY_DIR="${HOME}/.cursor"
  mkdir -p "$REGISTRY_DIR"
  python3 -c "
import json, os
repos_dir = '$REPOS_DIR'
repos = {}
for root, dirs, files in os.walk(repos_dir):
    depth = root.replace(repos_dir, '').count(os.sep)
    if depth > 2:
        dirs.clear()
        continue
    if '.git' in dirs:
        dirs.clear()
        repo_id = os.path.relpath(root, repos_dir)
        repos[repo_id] = {'localPath': root}
        try:
            import subprocess
            url = subprocess.check_output(['git', '-C', root, 'remote', 'get-url', 'origin'], stderr=subprocess.DEVNULL).decode().strip()
            repos[repo_id]['remote'] = url
        except: pass

registry = {
    'productLine': '$PRODUCT_LINE',
    'generatedAt': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'repos': repos
}
out = os.path.join('$REGISTRY_DIR', '${PRODUCT_LINE}-registry.json')
with open(out, 'w') as f:
    json.dump(registry, f, indent=2, ensure_ascii=False)
print(f'[REG] 注册表已更新: {len(repos)} 个仓库 → {out}')
"
fi

# ── Phase 2: 更新已有仓库 ──
success=0
failed=0
skipped=0

while IFS= read -r -d '' git_dir; do
  repo_dir="$(dirname "$git_dir")"
  repo_name="${repo_dir#$REPOS_DIR/}"

  cd "$repo_dir" || continue

  default_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
  if [ -z "$default_branch" ]; then
    default_branch="master"
  fi

  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$current_branch" != "$default_branch" ]; then
    echo "[FIX] $repo_name — 当前 $current_branch，切换到 $default_branch"
    if ! git checkout "$default_branch" 2>/dev/null; then
      if ! git checkout master 2>/dev/null && ! git checkout main 2>/dev/null; then
        echo "[SKIP] $repo_name — 无法切换到默认分支"
        skipped=$((skipped + 1))
        continue
      fi
    fi
  fi

  old_head=$(git rev-parse HEAD 2>/dev/null)
  if git fetch origin "$default_branch" 2>/dev/null; then
    git reset --hard "origin/$default_branch" 2>/dev/null
    new_head=$(git rev-parse HEAD 2>/dev/null)
    if [ "$old_head" != "$new_head" ]; then
      new_count=$(git rev-list "${old_head}..${new_head}" --count 2>/dev/null || echo "?")
      echo "[SYNC] $repo_name — +${new_count} commits"
    fi
    success=$((success + 1))
  else
    echo "[FAIL] $repo_name — fetch 失败"
    failed=$((failed + 1))
  fi
done < <(find "$REPOS_DIR" -maxdepth 3 -name ".git" -type d -print0)

echo ""
echo "═══════════════════════════════════════"
echo "  同步完成: 更新=$success 跳过=$skipped 失败=$failed"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════"
