import { assertEquals, assertNotEquals } from 'jsr:@std/assert';

import { cacheKeyFor, normalizeArabic, sha256Hex } from './index.ts';

Deno.test('normalizeArabic unifies hamza/alef variants', () => {
  assertEquals(normalizeArabic('الإقليم'), normalizeArabic('الاقليم'));
  assertEquals(normalizeArabic('أحد'), normalizeArabic('احد'));
  assertEquals(normalizeArabic('آلام'), normalizeArabic('الام'));
});

Deno.test('normalizeArabic strips diacritics and tatweel', () => {
  assertEquals(normalizeArabic('الْجَبَلُ'), normalizeArabic('الجبل'));
  assertEquals(normalizeArabic('الــــنيل'), normalizeArabic('النيل'));
});

Deno.test('normalizeArabic maps alef maqsura and ta marbuta', () => {
  assertEquals(normalizeArabic('عيسى'), normalizeArabic('عيسي'));
  assertEquals(normalizeArabic('المدينة'), normalizeArabic('المدينه'));
});

Deno.test('normalizeArabic is whitespace- and case-insensitive', () => {
  assertEquals(normalizeArabic('  نهر   النيل  '), 'نهر النيل');
});

Deno.test('sha256Hex is deterministic and hex', async () => {
  const a = await sha256Hex('test');
  const b = await sha256Hex('test');
  assertEquals(a, b);
  assertEquals(a.length, 64);
  assertNotEquals(await sha256Hex('test'), await sha256Hex('test2'));
});

Deno.test('cacheKeyFor is stable across normalization differences', async () => {
  const a = await cacheKeyFor('q1', 'المدينة المنورة');
  const b = await cacheKeyFor('q1', 'المدينه المنوره');
  assertEquals(a, b);
});
