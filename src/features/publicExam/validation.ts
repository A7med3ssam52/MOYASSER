import { normalizePhone } from '../../lib/validation';

const ARABIC_OR_LATIN_WORD_RE = /^[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿A-Za-z]+$/;
/** Egyptian mobile: 11 digits starting with 01 (e.g. 01012345678). */
export const PUBLIC_EXAM_PHONE_RE = /^01[0-9]{9}$/;

/**
 * Public-exam name rule: at least four space-separated parts, Arabic or
 * Latin letters only — no digits, symbols or mixed scripts inside a part.
 * Returns an Arabic error message, or null when valid.
 */
export function validatePublicExamName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) {
    return 'برجاء كتابة الاسم الرباعي كاملًا';
  }
  const parts = name.split(' ').filter(Boolean);
  if (parts.length < 4) {
    return 'برجاء كتابة الاسم الرباعي كاملًا (٤ أسماء أو أكثر)';
  }
  if (!parts.every((part) => ARABIC_OR_LATIN_WORD_RE.test(part) && part.length >= 2)) {
    return 'الاسم يجب أن يكون حروفًا فقط بدون أرقام أو رموز';
  }
  return null;
}

/**
 * Normalize an Egyptian mobile to the canonical 01xxxxxxxxx form.
 * Handles Arabic-Indic digits (٠١٢) and Persian digits (۰۱۲), spaces and dashes.
 * Returns null when the result is not exactly 11 digits starting with 01.
 */
export function normalizePublicExamPhone(value: string): string | null {
  const normalized = normalizePhone(value);
  return PUBLIC_EXAM_PHONE_RE.test(normalized) ? normalized : null;
}

export function validatePublicExamPhone(value: string): string | null {
  if (!value.trim()) {
    return 'برجاء كتابة رقم التليفون';
  }
  return normalizePublicExamPhone(value) === null
    ? 'رقم التليفون يجب أن يكون 11 رقمًا ويبدأ بـ 01'
    : null;
}
