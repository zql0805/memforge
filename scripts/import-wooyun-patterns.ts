#!/usr/bin/env npx tsx
// WooYun 安全漏洞模式导入脚本
// 将 wooyun-security-scanner skill 的 references 目录中的安全模式批量导入到知识库

import * as fs from 'node:fs';
import * as path from 'node:path';

const WOOYUN_REFS_DIR = path.join(
  process.env.HOME ?? '',
  '.claude/skills/wooyun-security-scanner/references',
);

const KNOWLEDGE_SERVICE_URL = process.env.KNOWLEDGE_SERVICE_URL || 'http://127.0.0.1:3003';

interface WooyunDomain {
  filename: string;
  title: string;
  knowledgeType: 'security';
  tags: string[];
}

const DOMAIN_MAP: WooyunDomain[] = [
  { filename: 'authentication-domain.md', title: 'WooYun 安全模式：认证绕过', knowledgeType: 'security', tags: ['wooyun', 'security', 'authentication', 'login-bypass', 'session'] },
  { filename: 'authorization-domain.md', title: 'WooYun 安全模式：越权访问', knowledgeType: 'security', tags: ['wooyun', 'security', 'authorization', 'idor', 'privilege-escalation'] },
  { filename: 'configuration-domain.md', title: 'WooYun 安全模式：配置不当', knowledgeType: 'security', tags: ['wooyun', 'security', 'misconfiguration', 'cors', 'debug-leak'] },
  { filename: 'financial-domain.md', title: 'WooYun 安全模式：支付篡改', knowledgeType: 'security', tags: ['wooyun', 'security', 'payment', 'financial', 'price-tampering'] },
  { filename: 'information-domain.md', title: 'WooYun 安全模式：信息泄露', knowledgeType: 'security', tags: ['wooyun', 'security', 'information-leak', 'pii', 'error-disclosure'] },
  { filename: 'logic-flow-domain.md', title: 'WooYun 安全模式：逻辑缺陷', knowledgeType: 'security', tags: ['wooyun', 'security', 'logic-flaw', 'race-condition', 'replay'] },
];

async function storeToKnowledge(domain: WooyunDomain, content: string): Promise<boolean> {
  const body = {
    project_id: '_global_',
    product_line: null,
    knowledge_type: domain.knowledgeType,
    category: 'security',
    title: domain.title,
    question: `${domain.title}有哪些常见漏洞模式和审计检查点？`,
    answer: content,
    source_type: 'manual',
    source_ref: `wooyun:${domain.filename}`,
    tags: domain.tags,
    visibility: 'global',
    status: 'published',
  };

  try {
    const resp = await fetch(`${KNOWLEDGE_SERVICE_URL}/api/knowledge/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`  [FAIL] ${domain.filename}: HTTP ${resp.status} - ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`  [ERROR] ${domain.filename}: ${err}`);
    return false;
  }
}

async function main() {
  console.log('=== WooYun 安全模式导入 ===');
  console.log(`数据源: ${WOOYUN_REFS_DIR}`);
  console.log(`目标: ${KNOWLEDGE_SERVICE_URL}`);
  console.log('');

  if (!fs.existsSync(WOOYUN_REFS_DIR)) {
    console.error(`目录不存在: ${WOOYUN_REFS_DIR}`);
    console.error('请确认 wooyun-security-scanner skill 已安装。');
    process.exit(1);
  }

  let success = 0;
  let fail = 0;

  for (const domain of DOMAIN_MAP) {
    const filePath = path.join(WOOYUN_REFS_DIR, domain.filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`  [SKIP] ${domain.filename}: 文件不存在`);
      fail++;
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    console.log(`  导入 ${domain.filename} (${(content.length / 1024).toFixed(1)}KB)...`);

    const ok = await storeToKnowledge(domain, content);
    if (ok) {
      console.log(`  [OK] ${domain.title}`);
      success++;
    } else {
      fail++;
    }
  }

  console.log('');
  console.log(`导入完成: ${success} 成功, ${fail} 失败, 共 ${DOMAIN_MAP.length} 个域`);
}

main().catch(err => {
  console.error('导入脚本执行失败:', err);
  process.exit(1);
});
