// Created by dev on 2026/04/04
// Copyright © 2026
// 通用 Tokenizer — 自动检测并加载 WordPiece / Unigram (SentencePiece)
// M3 计划将此文件提取到 @memforgeai/shared 以消除与 memory-service 的重复

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLogger } from '@memforgeai/shared';

const logger = getLogger('tokenizer');

export interface TokenizerOutput {
  inputIds: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
}

interface WordPieceConfig {
  type: 'WordPiece';
  vocab: Record<string, number>;
  unk_token: string;
  continuing_subword_prefix: string;
  max_input_chars_per_word: number;
}

interface UnigramConfig {
  type: 'Unigram';
  unk_id: number;
  vocab: Array<[string, number]>;
  byte_fallback?: boolean;
}

interface TokenizerJson {
  model: WordPieceConfig | UnigramConfig;
  added_tokens: Array<{ id: number; content: string; special: boolean }>;
  pre_tokenizer?: { type: string; pretokenizers?: Array<{ type: string; replacement?: string; add_prefix_space?: boolean }> };
  post_processor?: { type: string; single?: Array<Record<string, unknown>> };
}

export class AutoTokenizer {
  private impl: TokenizerImpl;

  constructor(modelDir: string, maxSeqLength = 128) {
    const tokenizerPath = resolve(modelDir, 'tokenizer.json');
    const raw = JSON.parse(readFileSync(tokenizerPath, 'utf-8')) as TokenizerJson;

    if (raw.model.type === 'WordPiece') {
      this.impl = new BertWordPieceImpl(raw, maxSeqLength);
    } else if (raw.model.type === 'Unigram') {
      this.impl = new UnigramImpl(raw, maxSeqLength);
    } else {
      throw new Error(`不支持的 tokenizer 类型: ${(raw.model as { type: string }).type}`);
    }

    logger.info(
      { type: raw.model.type, vocabSize: this.impl.vocabSize, maxSeqLength },
      'Tokenizer 加载完成',
    );
  }

  encode(text: string): TokenizerOutput {
    return this.impl.encode(text);
  }
}

interface TokenizerImpl {
  vocabSize: number;
  encode(text: string): TokenizerOutput;
}

class BertWordPieceImpl implements TokenizerImpl {
  private vocab: Map<string, number>;
  private unkTokenId: number;
  private clsTokenId: number;
  private sepTokenId: number;
  private padTokenId: number;
  private prefix: string;
  private maxCharsPerWord: number;
  private maxSeqLen: number;

  get vocabSize(): number { return this.vocab.size; }

  constructor(raw: TokenizerJson, maxSeqLen: number) {
    const cfg = raw.model as WordPieceConfig;
    this.vocab = new Map(Object.entries(cfg.vocab));
    this.prefix = cfg.continuing_subword_prefix || '##';
    this.maxCharsPerWord = cfg.max_input_chars_per_word || 100;
    this.unkTokenId = this.vocab.get(cfg.unk_token || '[UNK]') ?? 100;
    this.clsTokenId = this.vocab.get('[CLS]') ?? 101;
    this.sepTokenId = this.vocab.get('[SEP]') ?? 102;
    this.padTokenId = this.vocab.get('[PAD]') ?? 0;
    this.maxSeqLen = maxSeqLen;
  }

  encode(text: string): TokenizerOutput {
    const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, (ch) => ` ${ch} `)
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();

    const words = this.preTokenize(normalized);
    const tokens: number[] = [this.clsTokenId];

    for (const word of words) {
      if (tokens.length >= this.maxSeqLen - 1) break;
      for (const id of this.wordPiece(word)) {
        if (tokens.length >= this.maxSeqLen - 1) break;
        tokens.push(id);
      }
    }
    tokens.push(this.sepTokenId);

    return padSequence(tokens, this.padTokenId, this.maxSeqLen);
  }

  private preTokenize(text: string): string[] {
    const words: string[] = [];
    for (const seg of text.split(/\s+/)) {
      if (!seg) continue;
      let cur = '';
      for (const ch of seg) {
        if (isPunct(ch)) {
          if (cur) { words.push(cur); cur = ''; }
          words.push(ch);
        } else { cur += ch; }
      }
      if (cur) words.push(cur);
    }
    return words;
  }

  private wordPiece(word: string): number[] {
    if (word.length > this.maxCharsPerWord) return [this.unkTokenId];
    const ids: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found: number | null = null;
      while (start < end) {
        const sub = start > 0 ? this.prefix + word.slice(start, end) : word.slice(start, end);
        const id = this.vocab.get(sub);
        if (id !== undefined) { found = id; break; }
        end--;
      }
      if (found === null) return [this.unkTokenId];
      ids.push(found);
      start = end;
    }
    return ids;
  }
}

class UnigramImpl implements TokenizerImpl {
  private tokenToId: Map<string, number> = new Map();
  private tokenScore: Map<string, number> = new Map();
  private unkId: number;
  private bosId: number;
  private eosId: number;
  private padId: number;
  private maxTokenLen = 0;
  private maxSeqLen: number;
  private useMetaspace: boolean;

  get vocabSize(): number { return this.tokenToId.size; }

  constructor(raw: TokenizerJson, maxSeqLen: number) {
    const cfg = raw.model as UnigramConfig;
    this.unkId = cfg.unk_id ?? 3;
    this.maxSeqLen = maxSeqLen;

    for (let i = 0; i < cfg.vocab.length; i++) {
      const [token, score] = cfg.vocab[i];
      this.tokenToId.set(token, i);
      this.tokenScore.set(token, score);
      if (token.length > this.maxTokenLen) this.maxTokenLen = token.length;
    }

    const specialMap = new Map(raw.added_tokens.map(t => [t.content, t.id]));
    this.bosId = specialMap.get('<s>') ?? 0;
    this.eosId = specialMap.get('</s>') ?? 2;
    this.padId = specialMap.get('<pad>') ?? 1;

    const preToks = raw.pre_tokenizer?.pretokenizers ?? [];
    this.useMetaspace = preToks.some(p => p.type === 'Metaspace');
  }

  encode(text: string): TokenizerOutput {
    const normalized = text.normalize('NFKC');
    const pieces = this.preTokenize(normalized);
    const ids: number[] = [this.bosId];

    for (const piece of pieces) {
      if (ids.length >= this.maxSeqLen - 1) break;
      for (const id of this.viterbiEncode(piece)) {
        if (ids.length >= this.maxSeqLen - 1) break;
        ids.push(id);
      }
    }
    ids.push(this.eosId);

    return padSequence(ids, this.padId, this.maxSeqLen);
  }

  private preTokenize(text: string): string[] {
    const segments = text.split(/(\s+)/);
    const pieces: string[] = [];
    for (const seg of segments) {
      if (!seg || /^\s+$/.test(seg)) continue;
      pieces.push(this.useMetaspace ? '\u2581' + seg : seg);
    }
    return pieces;
  }

  private viterbiEncode(text: string): number[] {
    const n = text.length;
    if (n === 0) return [];

    const NEG_INF = -1e18;
    const dp = new Float64Array(n + 1).fill(NEG_INF);
    const bp = new Int32Array(n + 1).fill(-1);
    dp[0] = 0;

    for (let i = 0; i < n; i++) {
      if (dp[i] === NEG_INF) continue;
      const maxLen = Math.min(this.maxTokenLen, n - i);
      for (let len = 1; len <= maxLen; len++) {
        const sub = text.slice(i, i + len);
        const score = this.tokenScore.get(sub);
        if (score !== undefined) {
          const newScore = dp[i] + score;
          if (newScore > dp[i + len]) {
            dp[i + len] = newScore;
            bp[i + len] = i;
          }
        }
      }
      if (dp[i + 1] === NEG_INF) {
        dp[i + 1] = dp[i] + (-100);
        bp[i + 1] = i;
      }
    }

    const tokens: string[] = [];
    let pos = n;
    while (pos > 0) {
      const prev = bp[pos];
      tokens.push(text.slice(prev, pos));
      pos = prev;
    }
    tokens.reverse();

    return tokens.map(t => this.tokenToId.get(t) ?? this.unkId);
  }
}

function padSequence(ids: number[], padId: number, maxLen: number): TokenizerOutput {
  const inputIds = new Array(maxLen).fill(padId);
  const attentionMask = new Array(maxLen).fill(0);
  const tokenTypeIds = new Array(maxLen).fill(0);
  for (let i = 0; i < ids.length && i < maxLen; i++) {
    inputIds[i] = ids[i];
    attentionMask[i] = 1;
  }
  return { inputIds, attentionMask, tokenTypeIds };
}

function isPunct(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /^\p{P}$/u.test(ch);
}
