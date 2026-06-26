#!/bin/bash
# Created by dev on 2026/04/05
# Copyright © 2026
# Memforge 全套服务一键停止脚本

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PID_DIR="$ROOT_DIR/.pids"

echo "🛑 停止 Memforge 全套服务"
echo ""

stop_service() {
  local name="$1"
  local port="$2"
  local pid_file="$PID_DIR/$name.pid"

  # 通过 PID 文件停止
  if [ -f "$pid_file" ]; then
    local pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      echo "  ✅ $name 已停止 (PID: $pid)"
    else
      echo "  ⚠️  $name PID $pid 已不存在"
    fi
    rm -f "$pid_file"
  fi

  # 通过端口兜底清理
  if [ -n "$port" ]; then
    local pids=$(lsof -ti:"$port" 2>/dev/null)
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill 2>/dev/null
      echo "  🧹 清理端口 $port 残留进程"
    fi
  fi
}

stop_service "web-ui" "5173"
stop_service "gateway" "3000"
stop_service "knowledge-service" "3003"
stop_service "rules-engine" "3002"
stop_service "memory-service" "3001"

echo ""
echo "✅ 所有 Memforge 服务已停止"
echo ""
echo "  注意: PostgreSQL 和 Redis 未被停止（它们是系统级服务）"
echo "  手动停止: brew services stop postgresql@17 && brew services stop redis"
