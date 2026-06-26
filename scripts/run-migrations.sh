#!/bin/bash
# Memforge 数据库迁移执行脚本
# 自动检测并执行未应用的 SQL 迁移
#
# 用法:
#   bash scripts/run-migrations.sh            # 执行所有未应用的迁移
#   bash scripts/run-migrations.sh --dry-run  # 仅显示待执行列表

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="$PROJECT_DIR/sql/migrations"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# 从 .env.production 或环境变量获取 DATABASE_URL
if [[ -z "${DATABASE_URL:-}" ]]; then
  ENV_FILE="$PROJECT_DIR/.env.production"
  if [[ -f "$ENV_FILE" ]]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d'=' -f2-)
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "❌ 未找到 DATABASE_URL，请设置环境变量或配置 .env.production"
  exit 1
fi

export PGPASSWORD
DB_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')
DB_PORT=$(echo "$DATABASE_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
DB_NAME=$(echo "$DATABASE_URL" | sed -n 's|.*/\([^?]*\).*|\1|p')
DB_USER=$(echo "$DATABASE_URL" | sed -n 's|.*://\([^:]*\):.*|\1|p')
PGPASSWORD=$(echo "$DATABASE_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')

PSQL="psql -h ${DB_HOST:-localhost} -p ${DB_PORT:-5432} -U ${DB_USER:-memforge} -d ${DB_NAME:-memforge}"

echo "📦 Memforge 数据库迁移"
echo "   数据库: ${DB_NAME:-memforge}@${DB_HOST:-localhost}:${DB_PORT:-5432}"
echo "   迁移目录: $MIGRATIONS_DIR"
echo ""

# 创建迁移追踪表
$PSQL -q -c "
CREATE TABLE IF NOT EXISTS memory.applied_migrations (
  name VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);" 2>/dev/null

# 获取已执行的迁移列表
APPLIED=$($PSQL -t -A -c "SELECT name FROM memory.applied_migrations ORDER BY name;")

# 扫描迁移文件（按文件名排序）
PENDING=0
EXECUTED=0

for file in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
  filename=$(basename "$file")

  if echo "$APPLIED" | grep -q "^${filename}$"; then
    continue
  fi

  PENDING=$((PENDING + 1))

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  📋 待执行: $filename"
  else
    echo -n "  ▶ 执行: $filename ... "
    if $PSQL -q -f "$file" 2>/tmp/migration_err_$$; then
      $PSQL -q -c "INSERT INTO memory.applied_migrations (name) VALUES ('$filename') ON CONFLICT DO NOTHING;"
      echo "✅"
      EXECUTED=$((EXECUTED + 1))
    else
      echo "❌"
      echo "    错误: $(cat /tmp/migration_err_$$)"
      rm -f /tmp/migration_err_$$
      exit 1
    fi
    rm -f /tmp/migration_err_$$
  fi
done

echo ""
if [[ "$DRY_RUN" == "true" ]]; then
  if [[ $PENDING -eq 0 ]]; then
    echo "✅ 所有迁移均已执行，无待处理项"
  else
    echo "📋 共 $PENDING 个迁移待执行"
  fi
else
  if [[ $EXECUTED -eq 0 && $PENDING -eq 0 ]]; then
    echo "✅ 所有迁移均已执行，无待处理项"
  else
    echo "✅ 完成，执行了 $EXECUTED 个迁移"
  fi
fi
