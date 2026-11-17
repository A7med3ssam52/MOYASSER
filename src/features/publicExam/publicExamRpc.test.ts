import { beforeEach, describe, expect, it } from 'vitest';

import { expectRpcCall, mockRpc, mockRpcError, resetMockState } from '../../test/supabase-mock';
import { PublicExamError, requestPublicExamRecheck } from './publicExamRpc';

describe('requestPublicExamRecheck', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('calls request_public_exam_recheck with the attempt id and reason', async () => {
    mockRpc('request_public_exam_recheck', {
      ok: true,
      already_requested: false,
      recheck_requested_at: '2026-11-17T22:00:00+02:00',
      recheck_reason: 'أنا شايف إن إجابتي في سؤال 3 صح',
    });

    const result = await requestPublicExamRecheck('00000000-0000-0000-0000-000000000001', 'أنا شايف إن إجابتي في سؤال 3 صح');

    expect(result.ok).toBe(true);
    expect(result.already_requested).toBe(false);
    expect(expectRpcCall('request_public_exam_recheck')).toEqual({
      p_attempt_id: '00000000-0000-0000-0000-000000000001',
      p_reason: 'أنا شايف إن إجابتي في سؤال 3 صح',
    });
  });

  it('passes a null reason when the student leaves the note empty', async () => {
    mockRpc('request_public_exam_recheck', {
      ok: true,
      already_requested: true,
      recheck_requested_at: '2026-11-17T22:00:00+02:00',
      recheck_reason: null,
    });

    const result = await requestPublicExamRecheck('00000000-0000-0000-0000-000000000001', null);

    expect(result.already_requested).toBe(true);
    expect(expectRpcCall('request_public_exam_recheck')).toEqual({
      p_attempt_id: '00000000-0000-0000-0000-000000000001',
      p_reason: null,
    });
  });

  it('throws a PublicExamError carrying the server code on failure', async () => {
    mockRpcError('request_public_exam_recheck', 'not_submitted');

    await expect(requestPublicExamRecheck('00000000-0000-0000-0000-000000000001', 'x')).rejects.toMatchObject({
      name: 'PublicExamError',
      code: 'not_submitted',
    });
    await expect(requestPublicExamRecheck('00000000-0000-0000-0000-000000000001', 'x')).rejects.toBeInstanceOf(
      PublicExamError,
    );
  });
});
