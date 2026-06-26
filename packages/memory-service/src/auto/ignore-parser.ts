// Created by dev on 2026/04/05
// Copyright © 2026

import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * .memforgeignore 文件解析器
 * 语法类似 .gitignore：支持通配符、目录匹配、注释行
 */
export class IgnoreParser {
  private patterns: Array<{ regex: RegExp; negated: boolean }> = [];

  constructor(private projectRoot: string) {
    this.load();
  }

  private load(): void {
    const ignoreFile = join(this.projectRoot, '.memforgeignore');
    if (!existsSync(ignoreFile)) return;

    const content = readFileSync(ignoreFile, 'utf-8');
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const negated = line.startsWith('!');
      const pattern = negated ? line.slice(1) : line;
      this.patterns.push({ regex: this.toRegex(pattern), negated });
    }
  }

  private toRegex(pattern: string): RegExp {
    let p = pattern;
    if (p.endsWith('/')) p = p + '**';

    const regexStr = p
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '⟨GLOBSTAR⟩')
      .replace(/\*/g, '[^/]*')
      .replace(/⟨GLOBSTAR⟩/g, '.*')
      .replace(/\?/g, '[^/]');

    return new RegExp(`(^|/)${regexStr}($|/)`, 'i');
  }

  /**
   * 判断给定路径是否应被忽略
   * @param filePath 绝对路径或相对路径
   */
  isIgnored(filePath: string): boolean {
    const rel = filePath.startsWith('/')
      ? relative(this.projectRoot, filePath)
      : filePath;

    let ignored = false;
    for (const { regex, negated } of this.patterns) {
      if (regex.test(rel)) {
        ignored = !negated;
      }
    }
    return ignored;
  }
}
