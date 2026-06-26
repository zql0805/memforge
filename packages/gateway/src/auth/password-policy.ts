// Created by dev on 2026/04/11
// Copyright © 2026
// 密码策略校验

const MIN_LENGTH = 8;
const HAS_LOWER = /[a-z]/;
const HAS_UPPER = /[A-Z]/;
const HAS_DIGIT = /\d/;

export interface PasswordValidationResult {
  valid: boolean;
  message: string;
}

/**
 * 校验密码是否满足安全策略：长度 ≥ 8，包含大写、小写和数字。
 * 仅在设置/修改/重置密码时调用；已有密码的登录不校验策略。
 */
export function validatePassword(password: string): PasswordValidationResult {
  if (password.length < MIN_LENGTH) {
    return { valid: false, message: `密码至少 ${MIN_LENGTH} 个字符` };
  }
  if (!HAS_LOWER.test(password)) {
    return { valid: false, message: '密码必须包含至少一个小写字母' };
  }
  if (!HAS_UPPER.test(password)) {
    return { valid: false, message: '密码必须包含至少一个大写字母' };
  }
  if (!HAS_DIGIT.test(password)) {
    return { valid: false, message: '密码必须包含至少一个数字' };
  }
  return { valid: true, message: '' };
}

/** 人类可读的密码策略描述 */
export const PASSWORD_POLICY_HINT = `至少 ${MIN_LENGTH} 个字符，包含大写字母、小写字母和数字`;
