#!/bin/bash
# Created by dev on 2026/04/05
# Updated by dev on 2026/04/09
# Copyright © 2026
# Memforge launchd 开机自启安装脚本
# 架构：start-all.sh 以前台模式运行 + KeepAlive:true，由 launchd 管理生命周期
# 废弃旧版 watchdog plist（进程组清理导致子进程被杀）

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
GUID="gui/$(id -u)"
LA_DIR="$HOME/Library/LaunchAgents"

STARTUP_LABEL="com.memforge.services"
WATCHDOG_LABEL="com.memforge.watchdog"

# 从 .env.local 加载配置
ENV_LOCAL="$ROOT_DIR/.env.local"
if [ ! -f "$ENV_LOCAL" ]; then
  echo "❌ 缺少 $ENV_LOCAL 文件。请先运行 scripts/start-all.sh 或手动创建 .env.local"
  exit 1
fi
set -a; . "$ENV_LOCAL"; set +a

: "${DATABASE_URL:?请在 .env.local 中设置 DATABASE_URL}"
: "${JWT_SECRET:?请在 .env.local 中设置 JWT_SECRET}"

ENV_VARS="
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>DATABASE_URL</key>
        <string>${DATABASE_URL}</string>
        <key>EMBEDDING_MODEL_TIER</key>
        <string>${EMBEDDING_MODEL_TIER:-L3}</string>
        <key>JWT_SECRET</key>
        <string>${JWT_SECRET}</string>
        <key>CORS_ORIGINS</key>
        <string>${CORS_ORIGINS:-http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173}</string>"

echo "📦 安装 Memforge 开机自启..."

mkdir -p "$LA_DIR" "$ROOT_DIR/.logs"

# ── 0. 清理旧版 watchdog（已废弃）──
WATCHDOG_PLIST="$LA_DIR/$WATCHDOG_LABEL.plist"
if [ -f "$WATCHDOG_PLIST" ]; then
  launchctl bootout "$GUID/$WATCHDOG_LABEL" 2>/dev/null || true
  rm -f "$WATCHDOG_PLIST"
  echo "  🗑️  已移除旧版 watchdog plist（由 KeepAlive 前台守护替代）"
fi

# ── 1. 主服务 plist（前台阻塞 + KeepAlive）──
STARTUP_PLIST="$LA_DIR/$STARTUP_LABEL.plist"
cat > "$STARTUP_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$STARTUP_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$ROOT_DIR/scripts/start-all.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ExitTimeOut</key>
    <integer>15</integer>
    <key>StandardOutPath</key>
    <string>$ROOT_DIR/.logs/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT_DIR/.logs/launchd-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>$ENV_VARS
        <key>LAUNCHD_MODE</key>
        <string>1</string>
    </dict>
</dict>
</plist>
PLISTEOF

echo "  ✅ 主服务 plist: $STARTUP_PLIST (KeepAlive + 前台守护)"

# ── 2. 日志轮转 plist（每天 03:00 执行一次）──
LOGROTATE_LABEL="com.memforge.logrotate"
LOGROTATE_PLIST="$LA_DIR/$LOGROTATE_LABEL.plist"

cat > "$LOGROTATE_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LOGROTATE_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$ROOT_DIR/scripts/rotate-logs.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$ROOT_DIR/.logs/logrotate.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT_DIR/.logs/logrotate.log</string>
</dict>
</plist>
PLISTEOF

echo "  ✅ 日志轮转 plist: $LOGROTATE_PLIST"

# ── 3. DB 备份 plist（每天 04:00 执行一次）──
BACKUP_LABEL="com.memforge.backup"
BACKUP_PLIST="$LA_DIR/$BACKUP_LABEL.plist"

cat > "$BACKUP_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$BACKUP_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$ROOT_DIR/scripts/backup-db.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>4</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$ROOT_DIR/.logs/backup.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT_DIR/.logs/backup.log</string>
    <key>EnvironmentVariables</key>
    <dict>$ENV_VARS
    </dict>
</dict>
</plist>
PLISTEOF

echo "  ✅ DB 备份 plist: $BACKUP_PLIST"

# ── 4. 注册到 launchd ──
launchctl bootout "$GUID/$STARTUP_LABEL" 2>/dev/null || true
launchctl bootout "$GUID/$LOGROTATE_LABEL" 2>/dev/null || true
launchctl bootout "$GUID/$BACKUP_LABEL" 2>/dev/null || true

launchctl bootstrap "$GUID" "$STARTUP_PLIST"
launchctl bootstrap "$GUID" "$LOGROTATE_PLIST"
launchctl bootstrap "$GUID" "$BACKUP_PLIST"

echo ""
echo "✅ 已注册到 launchd（共 3 个任务）"
echo "  🚀 主服务: 开机自启 + KeepAlive 自动恢复（前台守护模式）"
echo "  📝 轮转:   每天 03:00 压缩归档超限日志"
echo "  💾 备份:   每天 04:00 自动备份 PostgreSQL"
echo ""
echo "管理命令:"
echo "  查看状态:  launchctl list | grep memforge"
echo "  手动启动:  launchctl kickstart $GUID/$STARTUP_LABEL"
echo "  手动停止:  launchctl kill SIGTERM $GUID/$STARTUP_LABEL"
echo "  手动备份:  bash $SCRIPT_DIR/backup-db.sh"
echo "  卸载全部:  for s in services logrotate backup; do launchctl bootout $GUID/com.memforge.\$s 2>/dev/null; done"
echo "  重新安装:  bash $SCRIPT_DIR/install-launchd.sh"
echo "  查看日志:  tail -f $ROOT_DIR/.logs/launchd-stdout.log"
