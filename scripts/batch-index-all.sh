#!/bin/bash
# 产品线全量知识索引编排：文档 + API 一键索引
#
# 用法:
#   bash scripts/batch-index-all.sh [--product-line your-product] [--dry-run] [--concurrency 2]
#
# 依赖: npx tsx, .env.local 或 .env.production 中配置 DATABASE_URL

set -euo pipefail
cd "$(dirname "$0")/.."

PRODUCT_LINE="${PRODUCT_LINE:-default}"
DRY_RUN=""
CONCURRENCY="1"
EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --product-line) PRODUCT_LINE="$2"; shift 2 ;;
    --dry-run)      DRY_RUN="--dry-run"; shift ;;
    --concurrency)  CONCURRENCY="$2"; shift 2 ;;
    *)              EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

echo "════════════════════════════════════════"
echo "  Memforge 产品线全量知识索引"
echo "  产品线: ${PRODUCT_LINE}"
echo "════════════════════════════════════════"
echo ""

echo "▶ [1/2] 批量文档索引 (README/docs)..."
npx tsx scripts/batch-index-docs.ts \
  --product-line "$PRODUCT_LINE" \
  --concurrency "$CONCURRENCY" \
  $DRY_RUN $EXTRA_ARGS || true

echo ""
echo "▶ [2/2] 批量 API 索引..."
npx tsx scripts/batch-index-api.ts \
  --product-line "$PRODUCT_LINE" \
  --concurrency "$CONCURRENCY" \
  $DRY_RUN $EXTRA_ARGS || true

echo ""
echo "════════════════════════════════════════"
echo "  全量索引完成"
echo "════════════════════════════════════════"
