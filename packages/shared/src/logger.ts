// Created by dev on 2026/04/04
// Copyright © 2026

import pino from 'pino';
import { loadConfig } from './config.js';

let loggerInstance: pino.Logger | null = null;

/** 获取 pino 日志实例；首次调用时从 LOG_LEVEL 初始化 */
export function getLogger(name?: string): pino.Logger {
  if (!loggerInstance) {
    const config = loadConfig();
    loggerInstance = pino({
      level: config.logLevel,
      transport: {
        target: 'pino/file',
        options: { destination: 2 }, // stderr, 不干扰 stdio MCP 传输
      },
    });
  }
  return name ? loggerInstance.child({ module: name }) : loggerInstance;
}
