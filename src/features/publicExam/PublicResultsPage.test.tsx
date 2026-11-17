import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mockRpc,
  resetMockState,
  setAuthenticatedMoyasser,
} from '../../test/supabase-mock';
import { renderApp } from '../../test/utils';

const ROW_ID = '00000000-0000-0000-0000-00000000a001';
const ROW_ID_2 = '00000000-0000-0000-0000-00000000a002';

function makeAttemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    full_name: 'يوسف خالد عبد الرحمن',
    phone: '01012345678',
    status: 'graded',
    started_at: '2026-11-17T20:30:00+02:00',
    submitted_at: '2026-11-17T21:00:00+02:00',
    deadline_at: '2026-11-17T21:30:00+02:00',
    objective_score: 30,
    essay_score: 15,
    final_score: 45,
    max_score: 60,
    created_at: '2026-11-17T20:00:00+02:00',
    recheck_requested_at: null,
    recheck_reason: null,
    ...overrides,
  };
}

function makeAttemptDetail(overrides: { attempt?: Record<string, unknown>; items?: Array<Record<string, unknown>> } = {}) {
  return {
    attempt: {
      id: ROW_ID,
      full_name: 'يوسف خالد عبد الرحمن',
      phone: '01012345678',
      status: 'submitted',
      started_at: '2026-11-17T20:30:00+02:00',
      submitted_at: '2026-11-17T21:00:00+02:00',
      objective_score: 30,
      essay_score: null,
      final_score: null,
      max_score: 60,
      ai_raw: null,
      recheck_requested_at: '2026-11-17T22:00:00+02:00',
      recheck_reason: 'أنا شايف إن إجابتي في سؤال 3 صح',
      ...overrides.attempt,
    },
    items: overrides.items ?? [
      {
        question_id: '00000000-0000-0000-0000-00000000b001',
        position: 1,
        kind: 'short',
        prompt: 'ما هي عاصمة مصر؟',
        image_path: null,
        choices: null,
        correct_index: null,
        model_answer: 'القاهرة',
        marks: 1,
        answer: 'القاهرة',
        marks_awarded: 1,
        verdict: 'correct',
        reason: null,
        graded_by: 'auto',
      },
    ],
  };
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

describe('PublicResultsPage', () => {
  beforeEach(() => {
    resetMockState();
    mockRpc('list_public_exam_attempts', { rows: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders for anonymous visitors without login and shows the recheck badge', async () => {
    mockRpc('list_public_exam_attempts', {
      rows: [
        makeAttemptRow({ recheck_requested_at: '2026-11-17T22:00:00+02:00', recheck_reason: 'سؤال 3' }),
        makeAttemptRow({ id: ROW_ID_2, full_name: 'مريم أحمد علي محمود', phone: '01198765432' }),
      ],
    });

    renderApp('/results');

    expect(await screen.findByText('يوسف خالد عبد الرحمن')).toBeInTheDocument();
    expect(screen.getByText('مريم أحمد علي محمود')).toBeInTheDocument();
    expect(screen.getAllByText('طلب إعادة')).toHaveLength(1);
    // زائر مجهول: لا يظهر زر التصدير (للطاقم فقط) ولا أدوات التصحيح
    expect(screen.queryByRole('button', { name: /تصدير CSV/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /تسجيل دخول الطاقم/ })).toBeInTheDocument();
  });

  it('filters recheck requests in the طلبات إعادة التصحيح tab', async () => {
    mockRpc('list_public_exam_attempts', {
      rows: [
        makeAttemptRow({ recheck_requested_at: '2026-11-17T22:00:00+02:00', recheck_reason: 'سؤال 3' }),
        makeAttemptRow({ id: ROW_ID_2, full_name: 'مريم أحمد علي محمود', phone: '01198765432' }),
      ],
    });
    const user = userEvent.setup();

    renderApp('/results');

    await user.click(await screen.findByRole('tab', { name: 'طلبات إعادة التصحيح' }));

    expect(screen.getByText('يوسف خالد عبد الرحمن')).toBeInTheDocument();
    expect(screen.queryByText('مريم أحمد علي محمود')).not.toBeInTheDocument();
  });

  it('copies a deep link to the student result when the copy button is clicked', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    mockRpc('list_public_exam_attempts', { rows: [makeAttemptRow()] });
    const user = userEvent.setup();
    stubClipboard(writeText);

    renderApp('/results');

    await user.click(await screen.findByRole('button', { name: /نسخ لينك نتيجة/ }));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/results?attempt=${ROW_ID}`);
  });

  it('opens the attempt detail read-only for anonymous visitors (?attempt= deep link)', async () => {
    mockRpc('get_public_exam_attempt_detail', makeAttemptDetail());
    mockRpc('list_public_exam_attempts', { rows: [makeAttemptRow()] });

    renderApp(`/results?attempt=${ROW_ID}`);

    // المودال بيفتح تلقائيًا من الـ deep link
    expect(await screen.findByText(/ما هي عاصمة مصر/)).toBeInTheDocument();
    expect(screen.getAllByText(/القاهرة/).length).toBeGreaterThan(0);
    // بانر طلب إعادة التصحيح ظاهر بالسبب
    expect(screen.getByText(/طلب إعادة تصحيح يدوي/)).toBeInTheDocument();
    expect(screen.getByText(/سؤال 3/)).toBeInTheDocument();
    // وضع القراءة فقط: لا حقول تعديل درجة ولا زر إعادة التصحيح الآلي
    expect(screen.getByText(/وضع القراءة فقط/)).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /إعادة التصحيح بالذكاء الاصطناعي/ })).not.toBeInTheDocument();
  });

  it('shows edit controls and the AI retry button to staff', async () => {
    setAuthenticatedMoyasser();
    mockRpc('get_public_exam_attempt_detail', makeAttemptDetail());
    mockRpc('list_public_exam_attempts', { rows: [makeAttemptRow()] });

    renderApp(`/results?attempt=${ROW_ID}`);

    expect(await screen.findByText(/ما هي عاصمة مصر/)).toBeInTheDocument();
    expect(screen.queryByText(/وضع القراءة فقط/)).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /إعادة التصحيح بالذكاء الاصطناعي/ })).toBeInTheDocument();
  });

  it('staff sees the export button but anonymous visitors do not', async () => {
    setAuthenticatedMoyasser();
    mockRpc('list_public_exam_attempts', { rows: [makeAttemptRow()] });

    renderApp('/results');

    expect(await screen.findByRole('button', { name: /تصدير CSV/ })).toBeInTheDocument();
  });
});
