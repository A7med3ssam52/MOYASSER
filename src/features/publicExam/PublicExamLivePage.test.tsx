import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectRpcCall, mockRpc, mockRpcError, resetMockState } from '../../test/supabase-mock';
import { renderWithProviders } from '../../test/utils';
import { PublicExamLivePage } from './PublicExamLivePage';

const ATTEMPT_ID = '00000000-0000-0000-0000-00000000c001';

function mockLockedStart(recheck: { recheck_requested_at: string | null; recheck_reason: string | null } = { recheck_requested_at: null, recheck_reason: null }) {
  mockRpc('start_public_exam_attempt', {
    phase: 'locked',
    status: 'graded',
    attempt_id: ATTEMPT_ID,
    final_score: 45,
    max_score: 60,
    ...recheck,
    server_now: '2026-11-17T23:00:00+02:00',
  });
}

async function fillAndSubmitStartForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('الاسم الرباعي كاملًا'), 'يوسف خالد عبد الرحمن');
  await user.type(screen.getByLabelText('رقم التليفون'), '01012345678');
  await user.click(screen.getByRole('button', { name: 'ابدأ الإمتحان الآن' }));
}

describe('PublicExamLivePage — locked result screen', () => {
  beforeEach(() => {
    resetMockState();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the recheck request button after a locked (already-submitted) start and submits it with a note', async () => {
    mockLockedStart();
    mockRpc('request_public_exam_recheck', {
      ok: true,
      already_requested: false,
      recheck_requested_at: '2026-11-17T23:05:00+02:00',
      recheck_reason: 'أنا شايف إن إجابتي في السؤال 3 صح',
    });
    const user = userEvent.setup();

    renderWithProviders(<PublicExamLivePage />);

    await fillAndSubmitStartForm(user);

    // شاشة «لقد قمت بأداء هذا الإمتحان بالفعل» + زر طلب إعادة التصحيح
    expect(await screen.findByText('لقد قمت بأداء هذا الإمتحان بالفعل')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /طلب إعادة تصحيح يدوي/ }));

    await user.type(screen.getByLabelText(/اكتب ملاحظتك/), 'أنا شايف إن إجابتي في السؤال 3 صح');
    await user.click(screen.getByRole('button', { name: 'إرسال الطلب' }));

    expect(await screen.findByText('تم استلام طلب إعادة التصحيح')).toBeInTheDocument();
    expect(expectRpcCall('request_public_exam_recheck')).toEqual({
      p_attempt_id: ATTEMPT_ID,
      p_reason: 'أنا شايف إن إجابتي في السؤال 3 صح',
    });
  });

  it('shows the received state immediately when the attempt already requested a recheck', async () => {
    mockLockedStart({
      recheck_requested_at: '2026-11-17T23:05:00+02:00',
      recheck_reason: 'طلبي السابق',
    });
    const user = userEvent.setup();

    renderWithProviders(<PublicExamLivePage />);

    await fillAndSubmitStartForm(user);

    expect(await screen.findByText('تم استلام طلب إعادة التصحيح')).toBeInTheDocument();
    expect(screen.getByText('طلبي السابق', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إرسال الطلب' })).not.toBeInTheDocument();
  });

  it('surfaces the server error when the recheck request fails', async () => {
    mockLockedStart();
    mockRpcError('request_public_exam_recheck', 'not_submitted');
    const user = userEvent.setup();

    renderWithProviders(<PublicExamLivePage />);

    await fillAndSubmitStartForm(user);

    expect(await screen.findByText('لقد قمت بأداء هذا الإمتحان بالفعل')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /طلب إعادة تصحيح يدوي/ }));
    await user.click(screen.getByRole('button', { name: 'إرسال الطلب' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('لازم تسلّم الإمتحان الأول');
  });
});
