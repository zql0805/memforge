#!/usr/bin/env bash
# Created by dev on 2026/04/22
# Copyright © 2026
# Memforge 一键部署脚本 — git pull → 编译 → PM2 重启
#
# ═══════════════════════════════════════════════════════════════
# 部署架构说明
# ═══════════════════════════════════════════════════════════════
#
# 标准部署目录: /opt/memforge/ (git clone)
# Nginx 静态文件: /opt/memforge/packages/web-ui/dist/
# PM2 服务: gateway(3000) + memory-service(3001) + rules-engine(3002)
#
# SSH 连接:
#   登录用户: your-user（~/.ssh/config）
#   应用用户: memforge（PM2/文件属主）
#   登录用户 ≠ 应用用户时，自动通过 sudo -u memforge 执行
#
# 代码同步: git push (本地) → git pull (服务器)
#   服务器通过 SSH Deploy Key 访问 GitLab
#
# Nginx 配置同步:
#   deploy/mci/nginx-memforge.conf（仓库内）→ /etc/nginx/conf.d/memforge.conf
#   每次部署自动检测并同步（变更时自动 reload）
#
# ═══════════════════════════════════════════════════════════════
#
# 用法:
#   ./scripts/deploy.sh                    # 拉取最新代码 + 自动检测变更 + 编译 + 重启
#   ./scripts/deploy.sh memory-service     # 拉取 + 仅编译/重启 memory-service
#   ./scripts/deploy.sh gateway            # 拉取 + 仅编译/重启 gateway
#   ./scripts/deploy.sh web-ui             # 拉取 + 仅编译前端
#   ./scripts/deploy.sh all                # 拉取 + 编译全部 + 重启所有 PM2 服务
#   ./scripts/deploy.sh fix-paths          # 重置所有 PM2 服务到标准目录
#
# 环境变量:
#   MEMFORGE_SSH_HOST    SSH 连接地址（默认从 SSH config 读取 your-server）
#   MEMFORGE_APP_USER    应用运行用户（默认 memforge）
#   MEMFORGE_REMOTE_DIR  部署目标目录（默认 /home/$APP_USER/memforge）
#   MEMFORGE_GIT_BRANCH  部署分支（默认 main）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ─── 服务器连接配置 ─────────────────────────────
SSH_HOST="${MEMFORGE_SSH_HOST:-${MEMFORGE_REMOTE_HOST:-moMal}}"
APP_USER="${MEMFORGE_APP_USER:-memforge}"
REMOTE_DIR="${MEMFORGE_REMOTE_DIR:-/home/$APP_USER/memforge}"
GIT_BRANCH="${MEMFORGE_GIT_BRANCH:-main}"
TARGET="${1:-auto}"

# ─── 颜色输出 ─────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[部署]${NC} $*"; }
warn()  { echo -e "${YELLOW}[警告]${NC} $*"; }
error() { echo -e "${RED}[错误]${NC} $*"; exit 1; }
hint()  { echo -e "${CYAN}[提示]${NC} $*"; }

if [ -z "$SSH_HOST" ]; then
  error "请设置 MEMFORGE_SSH_HOST 环境变量"
fi

# 判断 SSH 登录用户
SSH_LOGIN_USER=$(ssh -G "$SSH_HOST" 2>/dev/null | awk '/^user / {print $2}')
NEED_SUDO="false"
if [ -n "$SSH_LOGIN_USER" ] && [ "$SSH_LOGIN_USER" != "$APP_USER" ]; then
  NEED_SUDO="true"
fi

run_remote() {
  if [ "$NEED_SUDO" = "true" ]; then
    ssh "$SSH_HOST" "sudo -u $APP_USER bash -c 'export PATH=\$PATH:/usr/local/bin:/usr/local/lib/node_modules/pm2/bin; $1'" 2>&1
  else
    ssh "$SSH_HOST" "bash -c '$1'" 2>&1
  fi
}

cd "$ROOT_DIR"
info "SSH: $SSH_HOST (登录用户: ${SSH_LOGIN_USER:-unknown}) → 应用用户: $APP_USER → 目录: $REMOTE_DIR"

# ─── 0. 检测 PM2 服务实际运行路径 ─────────────────
info "检测 PM2 服务运行路径..."

PM2_PATHS=$(run_remote "pm2 jlist 2>/dev/null" | python3 -c "
import sys, json
try:
    procs = json.load(sys.stdin)
    for p in procs:
        name = p.get('name','')
        cwd = p.get('pm2_env',{}).get('pm_cwd','') or p.get('pm2_env',{}).get('cwd','')
        script = p.get('pm2_env',{}).get('pm_exec_path','')
        print(f'{name}|{cwd}|{script}')
except: pass
" 2>/dev/null || true)

PATH_MISMATCH="false"
if [ -n "$PM2_PATHS" ]; then
  echo "$PM2_PATHS" | while IFS='|' read -r name cwd script; do
    if [ -z "$name" ]; then continue; fi
    if echo "$cwd" | grep -q "$REMOTE_DIR"; then
      echo -e "  ${GREEN}✓${NC} $name → $cwd"
    else
      echo -e "  ${RED}✗${NC} $name → $cwd (期望: $REMOTE_DIR)"
      PATH_MISMATCH="true"
    fi
  done
  if echo "$PM2_PATHS" | grep -qv "$REMOTE_DIR"; then
    echo ""
    warn "部分服务运行在非标准目录！部署后这些服务不会生效。"
    hint "运行 './scripts/deploy.sh fix-paths' 重置所有服务到标准目录"
    echo ""
  fi
fi

# ─── fix-paths 特殊命令 ─────────────────────────
if [ "$TARGET" = "fix-paths" ]; then
  info "重置所有 PM2 服务到 $REMOTE_DIR ..."
  run_remote "cd $REMOTE_DIR && pm2 delete all 2>/dev/null; pm2 start ecosystem.config.cjs --update-env && pm2 save"
  sleep 3
  info "验证..."
  run_remote "pm2 list"
  info "完成。所有服务现在从 $REMOTE_DIR 运行。"
  exit 0
fi

# ─── 1. 拉取最新代码（git pull）──────────────────
info "拉取最新代码 (git pull origin $GIT_BRANCH) ..."

PULL_OUTPUT=$(run_remote "cd $REMOTE_DIR && git pull origin $GIT_BRANCH 2>&1")
echo "$PULL_OUTPUT" | tail -5

if echo "$PULL_OUTPUT" | grep -q "Already up to date"; then
  if [ "$TARGET" = "auto" ]; then
    info "代码已是最新，无需部署"
    exit 0
  fi
  warn "代码已是最新，但指定了 TARGET=$TARGET，继续编译"
fi

info "代码拉取完成"

# ─── 1.5 Nginx 配置同步（从仓库目录读取）─────────
REMOTE_NGINX_SRC="$REMOTE_DIR/deploy/mci/nginx-memforge.conf"
REMOTE_NGINX_DST="/etc/nginx/conf.d/memforge.conf"

NGINX_DIFF=$(ssh "$SSH_HOST" "
  if [ -f $REMOTE_NGINX_SRC ]; then
    SRC_MD5=\$(md5sum $REMOTE_NGINX_SRC 2>/dev/null | awk '{print \$1}')
    DST_MD5=\$(sudo md5sum $REMOTE_NGINX_DST 2>/dev/null | awk '{print \$1}')
    if [ \"\$SRC_MD5\" != \"\$DST_MD5\" ]; then echo 'CHANGED'; else echo 'SAME'; fi
  else
    echo 'NO_SRC'
  fi
" 2>&1)

if [ "$NGINX_DIFF" = "CHANGED" ]; then
  info "检测到 Nginx 配置变更，同步中..."
  ssh "$SSH_HOST" "
    sudo cp $REMOTE_NGINX_DST ${REMOTE_NGINX_DST}.bak 2>/dev/null
    sudo cp $REMOTE_NGINX_SRC $REMOTE_NGINX_DST
    sudo nginx -t 2>&1 && sudo nginx -s reload 2>&1
  "
  ssh "$SSH_HOST" "sudo chmod o+x /home/$APP_USER/"
  info "Nginx 配置已同步并 reload"
fi

# ─── 2. 自动检测需要编译的包 ────────────────────
detect_changed_packages() {
  local changed=""
  local diff_output
  diff_output=$(run_remote "cd $REMOTE_DIR && git diff HEAD~1 --name-only 2>/dev/null" || echo "")

  if [ -z "$diff_output" ]; then
    echo ""
    return
  fi

  if echo "$diff_output" | grep -q "packages/shared/"; then
    changed="$changed shared"
  fi
  if echo "$diff_output" | grep -q "packages/memory-service/"; then
    changed="$changed memory-service"
  fi
  if echo "$diff_output" | grep -q "packages/gateway/"; then
    changed="$changed gateway"
  fi
  if echo "$diff_output" | grep -q "packages/rules-engine/"; then
    changed="$changed rules-engine"
  fi
  if echo "$diff_output" | grep -q "packages/web-ui/"; then
    changed="$changed web-ui"
  fi
  if echo "$diff_output" | grep -q "scripts/proxy/\|packages/memory-service/src/tools/topology/"; then
    changed="$changed proxy"
  fi
  echo "$changed"
}

if [ "$TARGET" = "auto" ]; then
  PACKAGES=$(detect_changed_packages)
  if [ -z "$PACKAGES" ]; then
    PACKAGES="shared memory-service"
    warn "无法自动检测变更，默认编译 shared + memory-service"
  else
    info "自动检测到变更包: $PACKAGES"
  fi
elif [ "$TARGET" = "all" ]; then
  PACKAGES="shared memory-service gateway rules-engine web-ui"
else
  PACKAGES="shared $TARGET"
fi

# ─── 3. 远程编译 ──────────────────────────────
info "远程编译..."

BUILD_CMD=""
TSC_TARGETS=""
PROXY_BUILD=""
for pkg in $PACKAGES; do
  case "$pkg" in
    shared|memory-service|gateway|rules-engine)
      TSC_TARGETS="$TSC_TARGETS packages/$pkg"
      ;;
    web-ui)
      BUILD_CMD="$BUILD_CMD cd packages/web-ui && npx vite build && cd ../.. &&"
      ;;
    proxy)
      PROXY_BUILD="node scripts/proxy/build.mjs &&"
      ;;
  esac
done
if [ -n "$TSC_TARGETS" ]; then
  BUILD_CMD="npx tsc -b $TSC_TARGETS && $BUILD_CMD"
fi
if [ -n "$PROXY_BUILD" ]; then
  BUILD_CMD="$BUILD_CMD $PROXY_BUILD"
fi
BUILD_CMD="${BUILD_CMD% &&}"
BUILD_CMD="${BUILD_CMD% && }"

if [ -n "$BUILD_CMD" ]; then
  run_remote "cd $REMOTE_DIR && $BUILD_CMD"
  info "编译完成"
else
  warn "没有需要编译的包"
fi

# ─── 4. PM2 重启 ──────────────────────────────
RESTART_SERVICES=""
for pkg in $PACKAGES; do
  case "$pkg" in
    memory-service|gateway|rules-engine)
      RESTART_SERVICES="$RESTART_SERVICES $pkg"
      ;;
  esac
done

if [ -n "$RESTART_SERVICES" ]; then
  for svc in $RESTART_SERVICES; do
    info "重启 $svc..."
    run_remote "cd $REMOTE_DIR && pm2 restart $svc --update-env" | grep -E "(✓|online|error)" || true
  done

  sleep 3

  info "健康检查..."
  ssh "$SSH_HOST" '
    for port in 3001 3002 3000; do
      result=$(curl -sf --connect-timeout 3 "http://127.0.0.1:$port/health" 2>/dev/null)
      if [ -n "$result" ]; then
        echo "  端口 $port: OK"
      else
        echo "  端口 $port: FAIL"
      fi
    done
  ' 2>&1

  info "验证服务运行路径..."
  run_remote "pm2 jlist 2>/dev/null" | python3 -c "
import sys, json
target = '$REMOTE_DIR'
try:
    procs = json.load(sys.stdin)
    ok = True
    for p in procs:
        name = p.get('name','')
        cwd = p.get('pm2_env',{}).get('pm_cwd','') or p.get('pm2_env',{}).get('cwd','')
        if target not in cwd:
            print(f'  ⚠ {name} 仍在非标准路径: {cwd}')
            ok = False
    if ok: print('  ✓ 所有服务运行在标准目录')
except: pass
" 2>/dev/null || true
else
  info "无服务需要重启"
fi

info "部署完成！"
