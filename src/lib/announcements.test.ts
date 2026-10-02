import { describe, expect, it } from 'vitest';

import {
  ADMIN_DEFAULT_SIGNATURE,
  MOYASSER_LOCKED_SIGNATURE,
  isSignatureLockedForRole,
  resolveAnnouncementSignature,
} from './announcements';

describe('announcement signature helpers', () => {
  it('التوقيع مقفول لمستر محمد ياسر فقط', () => {
    expect(isSignatureLockedForRole('mr_moyasser')).toBe(true);
    expect(isSignatureLockedForRole('admin')).toBe(false);
    expect(isSignatureLockedForRole('teacher')).toBe(false);
    expect(isSignatureLockedForRole(null)).toBe(false);
    expect(isSignatureLockedForRole(undefined)).toBe(false);
  });

  it('مستر محمد ياسر توقيعه ثابت مهما كانت القيمة المدخلة', () => {
    expect(resolveAnnouncementSignature('mr_moyasser', 'الإدارة')).toBe(MOYASSER_LOCKED_SIGNATURE);
    expect(resolveAnnouncementSignature('mr_moyasser', '')).toBe(MOYASSER_LOCKED_SIGNATURE);
    expect(resolveAnnouncementSignature('mr_moyasser')).toBe('م / محمد ياسر');
  });

  it('الأدمن: القيمة المدخلة أو الافتراضي عند الفراغ', () => {
    expect(resolveAnnouncementSignature('admin', '  إدارة المنصة  ')).toBe('إدارة المنصة');
    expect(resolveAnnouncementSignature('admin', '')).toBe(ADMIN_DEFAULT_SIGNATURE);
    expect(resolveAnnouncementSignature('admin')).toBe('الإدارة');
    expect(resolveAnnouncementSignature('teacher', '   ')).toBe('الإدارة');
  });
});

