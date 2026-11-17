/** RPC wrappers for the public grade-6 exam — safe for anonymous visitors. */
import { getSupabaseClient, supabasePublishableKey, supabaseUrl } from '../../lib/supabase';

import type {
  PublicExamAttemptDetail,
  PublicExamAttemptRow,
  PublicExamAttemptState,
  PublicExamGradingResult,
  PublicExamStartResult,
  PublicExamSubmitResult,
} from './publicExamTypes';

export class PublicExamError extends Error {
  code: string | null;
  constructor(code: string | null, message?: string) {
    super(message ?? code ?? 'unknown_error');
    this.name = 'PublicExamError';
    this.code = code;
  }
}

function extractCode(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === 'object') {
    const anyErr = error as Record<string, unknown>;
    const message = typeof anyErr.message === 'string' ? anyErr.message : '';
    const match = message.match(/^([a-z][a-z0-9_]+)/);
    if (match) return match[1];
    const details = typeof anyErr.details === 'string' ? anyErr.details : '';
    const detMatch = details.match(/^([a-z][a-z0-9_]+)/);
    if (detMatch) return detMatch[1];
    const hint = typeof anyErr.hint === 'string' ? anyErr.hint : '';
    const hintMatch = hint.match(/^([a-z][a-z0-9_]+)/);
    if (hintMatch) return hintMatch[1];
  }
  return null;
}

async function unwrapRpc<T>(promise: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await promise;
  if (error) {
    throw new PublicExamError(extractCode(error), String((error as { message?: string })?.message ?? 'rpc_failed'));
  }
  return data as T;
}

export function startPublicExamAttempt(fullName: string, phone: string): Promise<PublicExamStartResult> {
  return unwrapRpc(getSupabaseClient().rpc('start_public_exam_attempt', {
    p_full_name: fullName,
    p_phone: phone,
  }));
}

export function getPublicExamAttempt(attemptId: string): Promise<PublicExamAttemptState> {
  return unwrapRpc(getSupabaseClient().rpc('get_public_exam_attempt', { p_attempt_id: attemptId }));
}

export function savePublicExamAnswers(
  attemptId: string,
  answers: Record<string, string>,
): Promise<{ saved: boolean; status?: string; server_now?: string }> {
  return unwrapRpc(getSupabaseClient().rpc('save_public_exam_answers', {
    p_attempt_id: attemptId,
    p_answers: answers,
  }));
}

export function submitPublicExamAttempt(
  attemptId: string,
  answers: Record<string, string>,
): Promise<PublicExamSubmitResult> {
  return unwrapRpc(getSupabaseClient().rpc('submit_public_exam_attempt', {
    p_attempt_id: attemptId,
    p_answers: answers,
  }));
}

/** Direct call to the grading Edge Function (verify_jwt=false, anon-safe, idempotent). */
export async function gradePublicExamAttempt(attemptId: string): Promise<PublicExamGradingResult> {
  const res = await fetch(`${supabaseUrl}/functions/v1/grade-public-exam`, {
    method: 'POST',
    headers: {
      apikey: supabasePublishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ attempt_id: attemptId }),
  });
  const payload = (await res.json().catch(() => ({}))) as Partial<PublicExamGradingResult> & {
    error?: string;
  };
  if (!res.ok) {
    return {
      status: 'grading_failed',
      final_score: null,
      objective_score: null,
      essay_score: null,
      error: payload.error ?? `http_${res.status}`,
    };
  }
  return {
    status: payload.status ?? 'grading_failed',
    final_score: payload.final_score ?? null,
    objective_score: payload.objective_score ?? null,
    essay_score: payload.essay_score ?? null,
    error: payload.error,
  };
}

// ---------- Staff (/results) ----------

export async function listPublicExamAttempts(input: {
  status?: string | null;
  search?: string | null;
  limit?: number;
}): Promise<PublicExamAttemptRow[]> {
  const data = await unwrapRpc<{ rows: PublicExamAttemptRow[] }>(
    getSupabaseClient().rpc('list_public_exam_attempts', {
      p_status: input.status ?? null,
      p_search: input.search ?? null,
      p_limit: input.limit ?? 500,
    }),
  );
  return data.rows ?? [];
}

export function getPublicExamAttemptDetail(attemptId: string): Promise<PublicExamAttemptDetail> {
  return unwrapRpc(getSupabaseClient().rpc('get_public_exam_attempt_detail', {
    p_attempt_id: attemptId,
  }));
}

export async function setPublicExamAnswerMarks(input: {
  attemptId: string;
  questionId: string;
  marks: number;
  reason?: string;
}): Promise<{ objective_score: number | null; essay_score: number | null; final_score: number | null; status: string }> {
  return unwrapRpc(getSupabaseClient().rpc('set_public_exam_answer_marks', {
    p_attempt_id: input.attemptId,
    p_question_id: input.questionId,
    p_marks: input.marks,
    p_reason: input.reason ?? null,
  }));
}
