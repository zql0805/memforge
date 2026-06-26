// Created by dev on 2026/04/04
// Copyright © 2026
// 敏感数据扫描器：入库前自动检测并拒绝/脱敏含敏感信息的内容

import { getLogger } from '@memforgeai/shared';

const logger = getLogger('scanner');

export interface ScanResult {
  isClean: boolean;
  blocked: boolean;
  blockReason?: string;
  sanitizedContent?: string;
  detections: Array<{
    type: string;
    pattern: string;
    action: 'block' | 'redact';
  }>;
}

const BLOCK_PATTERNS = [
  { type: 'aws_key', pattern: /AKIA[A-Z0-9]{16}/g },
  { type: 'openai_key', pattern: /sk-[a-zA-Z0-9]{20,}/g },
  { type: 'private_key', pattern: /-----BEGIN\s+(RSA\s+|EC\s+)?PRIVATE\s+KEY-----/g },
  { type: 'github_token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g },
  { type: 'generic_secret', pattern: /(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/gi },
];

const REDACT_PATTERNS = [
  {
    type: 'ip_port',
    pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{4,5}\b/g,
    replacement: '[REDACTED_IP]',
  },
  {
    type: 'email',
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    replacement: (match: string) => {
      const [local, domain] = match.split('@');
      return `${local[0]}***@${domain}`;
    },
  },
];

export class SensitiveDataScanner {
  scan(content: string): ScanResult {
    const detections: ScanResult['detections'] = [];
    let sanitizedContent = content;

    for (const { type, pattern } of BLOCK_PATTERNS) {
      const matches = content.match(pattern);
      if (matches) {
        logger.warn({ type, count: matches.length }, '检测到敏感数据，拒绝存储');
        detections.push({ type, pattern: pattern.source, action: 'block' });
        return {
          isClean: false,
          blocked: true,
          blockReason: `检测到 ${type} 类型的敏感数据（${matches.length} 处），拒绝存储。请移除密钥/Token 后重试。`,
          detections,
        };
      }
    }

    for (const { type, pattern, replacement } of REDACT_PATTERNS) {
      const matches = content.match(pattern);
      if (matches) {
        detections.push({ type, pattern: pattern.source, action: 'redact' });
        if (typeof replacement === 'string') {
          sanitizedContent = sanitizedContent.replace(pattern, replacement);
        } else {
          sanitizedContent = sanitizedContent.replace(pattern, replacement);
        }
        logger.info({ type, count: matches.length }, '自动脱敏处理');
      }
    }

    return {
      isClean: detections.length === 0,
      blocked: false,
      sanitizedContent: detections.length > 0 ? sanitizedContent : undefined,
      detections,
    };
  }
}
