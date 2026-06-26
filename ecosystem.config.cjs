// Memforge PM2 进程管理配置
// Created by dev on 2026/04/28
//
// 使用方法:
//   首次启动: pm2 start ecosystem.config.cjs
//   重启全部: pm2 restart all --update-env
//   重启单个: pm2 restart memory-service --update-env
//   开机自启: pm2 save && pm2 startup
//
// 所有可变配置从 .env.production 文件读取（gitignored，每台服务器独立）
// 新环境部署：复制 .env.production.example 为 .env.production 并填入实际值

const path = require('path');
const dotenv = require('dotenv');

const DEPLOY_DIR = process.env.MEMFORGE_DEPLOY_DIR || '/opt/memforge';

// 从 .env.production 加载配置（不覆盖已有 shell 环境变量）
dotenv.config({ path: path.resolve(DEPLOY_DIR, '.env.production') });

const DB_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

if (!DB_URL) throw new Error('缺少 DATABASE_URL，请检查 .env.production');
if (!REDIS_URL) throw new Error('缺少 REDIS_URL，请检查 .env.production');

const EMBEDDING_CONFIG = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
  OPENAI_EMBEDDING_DIMENSIONS: process.env.OPENAI_EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_TIER: process.env.EMBEDDING_MODEL_TIER,
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
};

if (!EMBEDDING_CONFIG.OPENAI_BASE_URL || !EMBEDDING_CONFIG.OPENAI_API_KEY) {
  throw new Error('缺少 OPENAI_BASE_URL 或 OPENAI_API_KEY，请检查 .env.production');
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('缺少 JWT_SECRET，请检查 .env.production');

const sharedEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: DB_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  ...EMBEDDING_CONFIG,
  JWT_SECRET,
};

module.exports = {
  apps: [
    {
      name: 'memory-service',
      script: `${DEPLOY_DIR}/packages/memory-service/dist/index.js`,
      cwd: DEPLOY_DIR,
      node_args: '--max-old-space-size=512',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        ...sharedEnv,
        TRANSPORT_MODE: 'http',
        PORT: parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10),
        BIND_HOST: '0.0.0.0',
        LLM_BASE_URL: process.env.LLM_BASE_URL,
        LLM_API_KEY: process.env.LLM_API_KEY,
        LLM_MODEL: process.env.LLM_MODEL,
        MEMFORGE_LLM_MODEL: process.env.MEMFORGE_LLM_MODEL,
        MEMFORGE_GIT_ENGINE: process.env.MEMFORGE_GIT_ENGINE,
        MEMFORGE_COMMIT_LEARN: process.env.MEMFORGE_COMMIT_LEARN,
        DINGTALK_WEBHOOK_URL: process.env.DINGTALK_WEBHOOK_URL,
        DINGTALK_WEBHOOK_SECRET: process.env.DINGTALK_WEBHOOK_SECRET,
        DINGTALK_NOTIFY_ENABLED: process.env.DINGTALK_NOTIFY_ENABLED,
        DINGTALK_NOTIFY_MIN_SEVERITY: process.env.DINGTALK_NOTIFY_MIN_SEVERITY,
        DINGTALK_QUIET_HOURS: process.env.DINGTALK_QUIET_HOURS,
        MEMFORGE_WEB_URL: process.env.MEMFORGE_WEB_URL,
      },
      error_file: `${DEPLOY_DIR}/.logs/memory-service-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/memory-service-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'rules-engine',
      script: `${DEPLOY_DIR}/packages/rules-engine/dist/index.js`,
      cwd: DEPLOY_DIR,
      node_args: '--max-old-space-size=256',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        ...sharedEnv,
        TRANSPORT_MODE: 'http',
        PORT: parseInt(process.env.RULES_ENGINE_PORT || '3002', 10),
        BIND_HOST: '0.0.0.0',
      },
      error_file: `${DEPLOY_DIR}/.logs/rules-engine-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/rules-engine-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'knowledge-service',
      script: `${DEPLOY_DIR}/packages/knowledge-service/dist/index.js`,
      cwd: DEPLOY_DIR,
      node_args: '--max-old-space-size=256',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        ...sharedEnv,
        TRANSPORT_MODE: 'http',
        PORT: parseInt(process.env.KNOWLEDGE_SERVICE_PORT || '3003', 10),
        BIND_HOST: '0.0.0.0',
        DINGTALK_APP_KEY: process.env.DINGTALK_APP_KEY,
        DINGTALK_APP_SECRET: process.env.DINGTALK_APP_SECRET,
        DINGTALK_OPERATOR_ID: process.env.DINGTALK_OPERATOR_ID,
      },
      error_file: `${DEPLOY_DIR}/.logs/knowledge-service-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/knowledge-service-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'gateway',
      script: `${DEPLOY_DIR}/packages/gateway/dist/index.js`,
      cwd: DEPLOY_DIR,
      node_args: '--max-old-space-size=256',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        ...sharedEnv,
        PORT: parseInt(process.env.GATEWAY_PORT || '3000', 10),
        GATEWAY_HOST: '0.0.0.0',
        MEMORY_SERVICE_URL: process.env.MEMORY_SERVICE_URL || `http://127.0.0.1:${process.env.MEMORY_SERVICE_PORT || '3001'}`,
        RULES_SERVICE_URL: process.env.RULES_SERVICE_URL || `http://127.0.0.1:${process.env.RULES_ENGINE_PORT || '3002'}`,
        KNOWLEDGE_SERVICE_URL: process.env.KNOWLEDGE_SERVICE_URL || `http://127.0.0.1:${process.env.KNOWLEDGE_SERVICE_PORT || '3003'}`,
        REDIS_URL,
        CORS_ORIGINS: process.env.CORS_ORIGINS,
        OPEN_REGISTRATION: process.env.OPEN_REGISTRATION || 'false',
        DEVICE_VERIFICATION: process.env.DEVICE_VERIFICATION || 'false',
        DINGTALK_WEBHOOK_URL: process.env.DINGTALK_WEBHOOK_URL,
        DINGTALK_WEBHOOK_SECRET: process.env.DINGTALK_WEBHOOK_SECRET,
      },
      error_file: `${DEPLOY_DIR}/.logs/gateway-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/gateway-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'webhook-deploy',
      script: `${DEPLOY_DIR}/scripts/webhook-deploy.js`,
      cwd: DEPLOY_DIR,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      watch: false,
      env: {
        NODE_ENV: 'production',
        WEBHOOK_PORT: 9876,
        WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
        MEMFORGE_DEPLOY_DIR: DEPLOY_DIR,
        MEMFORGE_GIT_BRANCH: 'main',
      },
      error_file: `${DEPLOY_DIR}/.logs/webhook-deploy-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/webhook-deploy-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'repo-sync',
      script: `${DEPLOY_DIR}/scripts/repo-sync.sh`,
      interpreter: '/bin/bash',
      cwd: DEPLOY_DIR,
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '30 2 * * *',
      watch: false,
      env: {
        ...sharedEnv,
        REPOS_DIR: process.env.REPOS_DIR || '/opt/memforge/repos',
        PRODUCT_LINE: process.env.PRODUCT_LINE || 'default',
      },
      error_file: `${DEPLOY_DIR}/.logs/repo-sync-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/repo-sync-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'batch-index-docs',
      script: `${DEPLOY_DIR}/scripts/batch-index-docs.ts`,
      interpreter: `${DEPLOY_DIR}/node_modules/.bin/tsx`,
      cwd: DEPLOY_DIR,
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '0 3 * * *',
      watch: false,
      env: {
        ...sharedEnv,
        HOME: process.env.HOME || '/home/memforge',
      },
      error_file: `${DEPLOY_DIR}/.logs/batch-index-docs-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/batch-index-docs-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'batch-index-api',
      script: `${DEPLOY_DIR}/scripts/batch-index-api.ts`,
      interpreter: `${DEPLOY_DIR}/node_modules/.bin/tsx`,
      cwd: DEPLOY_DIR,
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '0 4 * * *',
      watch: false,
      env: {
        ...sharedEnv,
        HOME: process.env.HOME || '/home/memforge',
      },
      error_file: `${DEPLOY_DIR}/.logs/batch-index-api-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/batch-index-api-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'batch-deep-index',
      script: `${DEPLOY_DIR}/scripts/batch-deep-index.ts`,
      interpreter: `${DEPLOY_DIR}/node_modules/.bin/tsx`,
      args: `--product-line ${process.env.PRODUCT_LINE || 'default'} --clean --enable-l2 --enable-business`,
      cwd: DEPLOY_DIR,
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '0 4 * * *',
      watch: false,
      env: {
        ...sharedEnv,
        HOME: process.env.HOME || '/home/memforge',
        LLM_BASE_URL: process.env.LLM_BASE_URL,
        LLM_API_KEY: process.env.LLM_API_KEY,
        LLM_MODEL: process.env.LLM_MODEL,
        KNOWLEDGE_SERVICE_URL: process.env.KNOWLEDGE_SERVICE_URL || `http://127.0.0.1:${process.env.KNOWLEDGE_SERVICE_PORT || '3003'}`,
      },
      error_file: `${DEPLOY_DIR}/.logs/batch-deep-index-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/batch-deep-index-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'backfill-abstract',
      script: `${DEPLOY_DIR}/packages/memory-service/src/jobs/backfill-abstract.ts`,
      interpreter: `${DEPLOY_DIR}/node_modules/.bin/tsx`,
      cwd: DEPLOY_DIR,
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '30 6 * * *',
      watch: false,
      env: {
        ...sharedEnv,
      },
      error_file: `${DEPLOY_DIR}/.logs/backfill-abstract-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/backfill-abstract-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'auto-deploy',
      script: `${DEPLOY_DIR}/scripts/auto-pull-deploy.sh`,
      interpreter: '/bin/bash',
      cwd: DEPLOY_DIR,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 3,
      restart_delay: 30000,
      watch: false,
      env: {
        MEMFORGE_DEPLOY_DIR: DEPLOY_DIR,
        MEMFORGE_GIT_BRANCH: 'main',
        DEPLOY_POLL_INTERVAL: '10',
        PATH: `${process.env.PATH}:/usr/local/bin:/usr/local/lib/node_modules/pm2/bin`,
      },
      error_file: `${DEPLOY_DIR}/.logs/auto-deploy-error.log`,
      out_file: `${DEPLOY_DIR}/.logs/auto-deploy-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
