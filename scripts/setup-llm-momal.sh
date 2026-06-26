#!/bin/bash
# C2: 在 your-server 上配置 LLM 环境变量并重启服务
# 用法: ssh moMal 'bash -s' < scripts/setup-llm-momal.sh

set -e

if [ -z "$SILICONFLOW_API_KEY" ]; then
  echo "❌ 请设置 SILICONFLOW_API_KEY 环境变量后再运行"
  echo "   用法: SILICONFLOW_API_KEY=sk-xxx ssh moMal 'bash -s' < scripts/setup-llm-momal.sh"
  exit 1
fi

MEMFORGE_DIR="${MEMFORGE_DEPLOY_DIR:-/opt/memforge}"
ENV_FILE="$MEMFORGE_DIR/.env.local"

echo "=== C2: 配置 LLM 环境变量 ==="

# 检查 .env.local 是否存在
if [ ! -f "$ENV_FILE" ]; then
  echo "⚠️ $ENV_FILE 不存在，将创建"
  sudo -u memforge touch "$ENV_FILE"
fi

# 追加 LLM 相关变量（幂等：先删除已有行再追加）
sudo -u memforge bash -c "
cd $MEMFORGE_DIR
# 删除已有的 LLM 相关行
sed -i '/^OPENAI_BASE_URL=/d; /^OPENAI_API_KEY=/d; /^LLM_MODEL=/d; /^MEMFORGE_LLM_MODEL=/d; /^OPENAI_EMBEDDING_MODEL=/d; /^EMBEDDING_MODEL_TIER=/d' .env.local 2>/dev/null || true

# 追加
cat >> .env.local <<'ENVEOF'

# LLM 推理 + Embedding（SiliconFlow）
OPENAI_BASE_URL=https://api.siliconflow.cn/v1
OPENAI_API_KEY=\${SILICONFLOW_API_KEY:-请替换为实际的SiliconFlow API Key}
OPENAI_EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_MODEL_TIER=L3
LLM_MODEL=deepseek-ai/DeepSeek-V3
MEMFORGE_LLM_MODEL=deepseek-ai/DeepSeek-V3
ENVEOF
"

echo "✅ .env.local 已更新"
echo ""
echo "=== 重启 memory-service + gateway ==="

sudo -u memforge bash -c "
export PATH=/usr/local/bin:\$PATH
cd $MEMFORGE_DIR
pm2 restart memory-service gateway --update-env 2>&1
"

echo ""
echo "=== 验证 LLM 配置 ==="

sudo -u memforge bash -c "
export PATH=/usr/local/bin:\$PATH
pm2 env 0 2>/dev/null | grep -E 'LLM_MODEL|OPENAI_BASE' | head -5
"

echo ""
echo "✅ C2 完成。可通过以下命令测试完整管道："
echo "   curl -s -X POST http://localhost:3000/api/hooks/commit \\"
echo "     -H 'X-Hook-Token: mfh_test_token_for_pipeline_2026' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"commit\":\"test123\",\"message\":\"test: LLM review\",\"branch\":\"main\",\"author\":\"dev\",\"repo\":\"test/repo\",\"files\":\"a.ts\",\"diff\":\"diff --git a/a.ts\\n+function unsafe() { eval(input); }\"}'"
