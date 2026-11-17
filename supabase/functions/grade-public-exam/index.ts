// =====================================================================
// grade-public-exam — تصحيح مقالي امتحان الدراسات الاجتماعية (0060/0093)
// =====================================================================
// POST { attempt_id: uuid }
// verify_jwt = false — عام (anon)، لكنه:
//   * idempotent — يقفل المحاولة ذريًا قبل النداء على Gemini؛ 
//     أي تكرار يرجع النتيجة المخزنة بدون تكلفة.
//   * ما بيكشفش أي إجابات نموذجية للمتصفح.
//
// التصحيح:
//   1) يجمع الأسئلة المقالية للمحاولة + موديلات الإجابات (من قاعدة البيانات).
//   2) كاش عالمي (question_id + md5(normalized answer)) — الإجابة المتكررة
//      من طلاب مختلفين متتضربش على الـ API مرة تانية.
//   3) الباقي يتبعت في نداء Gemini واحد مع responseSchema صارم، بدرجة حرارة 0،
//      وروح متساهلة: الإجابة القريبة بجراف الكلمات الأساسية تاخد الدرجة كاملة.
//   4) لو أي سؤال ناقص من الرد → نداء مستقل لسؤال-سؤال (محاولتان)؛
//      لو لسه ناقص → verdict 'pending' + marks 0 + سبب: المراجعة اليدوية،
//      والطالب يشوف رسالته في /results بدل ما يتظلم بصمت.
//   5) أي فشل كلي (429/شبكة/مفتاح ناقص) → status = grading_failed
//      ومحتوى المحاولات زي ما هو — /results تقدر تعيد المحاولة،
//      و cron public_exam_release_stale_grading بيحرر التعليق.
// =====================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.112.2';

import { jsonResponse, preflightResponse } from '../_shared/cors.ts';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_CHAIN = (Deno.env.get('GEMINI_MODEL_CHAIN') ??
  'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash,gemini-1.5-flash')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const PER_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES_PER_MODEL = 2;
const BACKOFF_MS = [1000, 3000];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js rows come back untyped here
type AnyRecord = Record<string, string | number | null>;

interface EssayQuestionRow {
  id: string;
  prompt: string;
  model_answer: string;
  marks: number;
}

interface AnswerRow {
  attempt_id: string;
  question_id: string;
  answer: string | null;
  marks_awarded: number | null;
  verdict: string;
  reason: string | null;
  graded_by: string | null;
}

interface AiVerdict {
  question_id: string;
  marks: number;
  verdict: 'correct' | 'partial' | 'wrong';
  reason: string;
}

/** Arabic normalizer mirroring public.normalize_arabic() in SQL. */
export function normalizeArabic(input: string): string {
  let text = input ?? '';
  text = text.replace(/ﻻ|ﻷ|ﻹ|ﻵ/g, 'لا');
  text = text.replace(/[ً-ٰٟـ]/g, '');
  text = text.replace(/[إأآٱ]/g, 'ا');
  text = text.replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه');
  text = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return text;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function cacheKeyFor(questionId: string, answer: string): Promise<string> {
  return sha256Hex(`${questionId}|${normalizeArabic(answer)}`);
}

function clampMarks(marks: number, max: number): number {
  if (!Number.isFinite(marks) || marks < 0) return 0;
  if (marks > max) return max;
  return Math.round(marks * 100) / 100;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GeminiResult {
  verdicts: AiVerdict[];
  raw: unknown;
  model: string;
}

async function callGemini(apiKey: string, prompt: string): Promise<GeminiResult> {
  let lastError: Error | null = null;

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt += 1) {
      try {
        const response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 2048,
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'OBJECT',
                properties: {
                  results: {
                    type: 'ARRAY',
                    items: {
                      type: 'OBJECT',
                      properties: {
                        question_id: { type: 'STRING' },
                        marks: { type: 'NUMBER' },
                        verdict: { type: 'STRING', enum: ['correct', 'partial', 'wrong'] },
                        reason: { type: 'STRING' },
                      },
                      required: ['question_id', 'marks', 'verdict', 'reason'],
                    },
                  },
                },
                required: ['results'],
              },
            },
          }),
          signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
        });

        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`gemini_http_${response.status}`);
          if (attempt < MAX_RETRIES_PER_MODEL - 1) {
            await sleep(BACKOFF_MS[attempt] ?? 3000);
          }
          continue;
        }
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          lastError = new Error(`gemini_http_${response.status}: ${body.slice(0, 200)}`);
          break; // التبديل للموديل التالي
        }

        const payload = await response.json();
        const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string') {
          lastError = new Error('gemini_empty_output');
          break;
        }
        const parsed = JSON.parse(text) as { results?: AiVerdict[] };
        const verdicts = Array.isArray(parsed.results) ? parsed.results : [];
        return { verdicts, raw: payload, model };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < MAX_RETRIES_PER_MODEL - 1) {
          await sleep(BACKOFF_MS[attempt] ?? 3000);
        }
      }
    }
  }
  throw lastError ?? new Error('gemini_unreachable');
}

function buildPrompt(essays: Array<EssayQuestionRow & { student_answer: string }>): string {
  const items = essays
    .map(
      (item, index) => `--- السؤال ${index + 1} (question_id: ${item.id}) ---
السؤال: ${item.prompt}
الإجابة النموذجية (للمرجعية فقط): ${item.model_answer}
الدرجة الكاملة: ${item.marks}
إجابة الطالب: ${item.student_answer.trim() === '' ? '(لم يجب)' : item.student_answer}
`,
    )
    .join('\n');

  return `أنت مصحح امتحان دراسات اجتماعية للصف السادس الابتدائي باللغة العربية.
مهمتك: قيّم إجابة كل طالب مقارنة بالإجابة النموذجية.

القواعد (مهمة جدًا):
- روح التصحيح متساهلة: الطالب اللي جاب المعنى الأساس بأي صياغة أو بلهجة مصرية (حتى لو فيها غلط إملائي بسيط أو أسلوب بسيط) يأخذ الدرجة كاملة.
- الدرجة الجزئية مسموح بيها (مثلاً 1 من 2) لو جاب جزء من الإجابة أو فكرة واحدة صحيحة من عدة.
- صفر فقط لو الإجابة غلط تمامًا أو خارج الموضوع أو لم يجب.
- لا تجيب على الأسئلة بنفسك، ولا تغيّر أي سؤال.
- أعد verdict بإحدى: correct (الدرجة كاملة) / partial (جزئية) / wrong (صفر).
- اكتب سببًا قصيرًا جدًا بالعربية (جملة واحدة) يوضح ليه الدرجة.
- التزم حرفيًا بالـ JSON المطلوب، وبنفس question_id في المخرجات.

الأسئلة:
${items}`;
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return preflightResponse();
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  let attemptId: string | null = null;
  try {
    const body = await req.json();
    attemptId = typeof body?.attempt_id === 'string' ? body.attempt_id : null;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (!attemptId || !UUID_RE.test(attemptId)) {
    return jsonResponse({ error: 'invalid_attempt_id' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const geminiKey = Deno.env.get('GEMINI_API_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('grade-public-exam: missing SUPABASE_URL / SERVICE_ROLE_KEY');
    return jsonResponse({ error: 'misconfigured' }, 500);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---------- القفل الذري قبل أي نداء ----------
  const { data: lockedRows, error: lockError } = await db
    .from('public_exam_attempts')
    .update({ status: 'grading' })
    .eq('id', attemptId)
    .in('status', ['submitted', 'grading_failed'])
    .select('id, status, objective_score, max_score, submitted_at');

  if (lockError) {
    console.error('grade-public-exam: lock failed', lockError.message);
    return jsonResponse({ error: 'internal_error' }, 500);
  }

  if (!lockedRows || lockedRows.length === 0) {
    const { data: current, error: readError } = await db
      .from('public_exam_attempts')
      .select('id, status, objective_score, essay_score, final_score, max_score')
      .eq('id', attemptId)
      .maybeSingle();
    if (readError) {
      return jsonResponse({ error: 'internal_error' }, 500);
    }
    if (!current) {
      return jsonResponse({ error: 'attempt_not_found' }, 404);
    }
    if (current.status === 'graded') {
      return jsonResponse({
        status: 'already_graded',
        final_score: current.final_score,
        objective_score: current.objective_score,
        essay_score: current.essay_score,
        max_score: current.max_score,
      });
    }
    return jsonResponse({ error: 'not_submitted', status: current.status }, 409);
  }

  // ---------- جيب المقالية + الإجابات ----------
  const { data: essaysData, error: essaysError } = await db
    .from('public_exam_questions')
    .select('id, prompt, model_answer, marks')
    .eq('exam_key', 'sades_grade6')
    .eq('kind', 'essay');

  if (essaysError || !essaysData) {
    console.error('grade-public-exam: essays query failed', essaysError?.message);
    await db.from('public_exam_attempts').update({ status: 'grading_failed' }).eq('id', attemptId);
    return jsonResponse({ error: 'internal_error' }, 500);
  }

  const { data: answersData, error: answersError } = await db
    .from('public_exam_answers')
    .select('attempt_id, question_id, answer, marks_awarded, verdict, reason, graded_by')
    .eq('attempt_id', attemptId);

  if (answersError || !answersData) {
    console.error('grade-public-exam: answers query failed', answersError?.message);
    await db.from('public_exam_attempts').update({ status: 'grading_failed' }).eq('id', attemptId);
    return jsonResponse({ error: 'internal_error' }, 500);
  }

  const essays = essaysData as unknown as EssayQuestionRow[];
  const answers = answersData as unknown as AnswerRow[];
  const answerByQuestion = new Map(answers.map((row) => [row.question_id, row]));

  const pendingEssays = essays
    .map((question) => ({
      ...question,
      student_answer: answerByQuestion.get(question.id)?.answer ?? '',
      already_graded: answerByQuestion.get(question.id)?.marks_awarded !== null
        && answerByQuestion.get(question.id)?.marks_awarded !== undefined,
    }))
    .filter((question) => !question.already_graded);

  const gradedEssayResults: AiVerdict[] = [];

  try {
    if (pendingEssays.length > 0) {
      // ---------- الكاش العالمي ----------
      const keys = await Promise.all(
        pendingEssays.map(async (question) => ({
          questionId: question.id,
          key: question.student_answer.trim()
            ? await cacheKeyFor(question.id, question.student_answer)
            : null,
        })),
      );
      const cacheKeys = keys.map((entry) => entry.key).filter((key): key is string => key !== null);
      const cacheMap = new Map<string, { marks: number; verdict: string; reason: string | null }>();
      if (cacheKeys.length > 0) {
        const { data: cacheRows } = await db
          .from('public_exam_grading_cache')
          .select('cache_key, marks, verdict, reason')
          .in('cache_key', cacheKeys);
        for (const row of (cacheRows ?? []) as AnyRecord[]) {
          cacheMap.set(String(row.cache_key), {
            marks: Number(row.marks),
            verdict: String(row.verdict),
            reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
          });
        }
      }

      const fromCache: AiVerdict[] = [];
      const needsAi: Array<EssayQuestionRow & { student_answer: string }> = [];
      for (const question of pendingEssays) {
        if (question.student_answer.trim() === '') {
          fromCache.push({
            question_id: question.id,
            marks: 0,
            verdict: 'wrong',
            reason: 'لم يجب',
          });
          continue;
        }
        const key = keys.find((entry) => entry.questionId === question.id)?.key;
        const cached = key ? cacheMap.get(key) : undefined;
        if (cached) {
          fromCache.push({
            question_id: question.id,
            marks: clampMarks(cached.marks, question.marks),
            verdict: (cached.verdict as AiVerdict['verdict']) ?? 'correct',
            reason: cached.reason ?? '',
          });
        } else {
          needsAi.push(question);
        }
      }

      // ---------- Gemini: نداء واحد مجمّع للباقي ----------
      if (needsAi.length > 0) {
        if (!geminiKey) {
          throw new Error('gemini_not_configured');
        }
        const prompt = buildPrompt(needsAi);
        const gemini = await callGemini(geminiKey, prompt);
        const verdicts = gemini.verdicts ?? [];
        const byId = new Map(verdicts.map((verdict) => [String(verdict.question_id), verdict]));
        const missing: typeof needsAi = [];

        for (const question of needsAi) {
          const verdict = byId.get(question.id);
          if (verdict) {
            gradedEssayResults.push({
              question_id: question.id,
              marks: clampMarks(Number(verdict.marks), question.marks),
              verdict: (['correct', 'partial', 'wrong'].includes(verdict.verdict)
                ? verdict.verdict
                : 'partial') as AiVerdict['verdict'],
              reason: typeof verdict.reason === 'string' ? verdict.reason.slice(0, 500) : '',
            });
          } else {
            missing.push(question);
          }
        }

        // ---------- fallback سؤال-سؤال للمفقود ----------
        for (const question of missing) {
          try {
            const single = await callGemini(geminiKey, buildPrompt([question]));
            const verdict = single.verdicts?.[0];
            if (verdict) {
              gradedEssayResults.push({
                question_id: question.id,
                marks: clampMarks(Number(verdict.marks), question.marks),
                verdict: (['correct', 'partial', 'wrong'].includes(verdict.verdict)
                  ? verdict.verdict
                  : 'partial') as AiVerdict['verdict'],
                reason: typeof verdict.reason === 'string' ? verdict.reason.slice(0, 500) : '',
              });
              continue;
            }
          } catch (error) {
            console.error('grade-public-exam: single-question fallback failed', question.id, error);
          }
          // متعذر: معلّقة للمراجعة اليدوية بدل صفر صامت
          gradedEssayResults.push({
            question_id: question.id,
            marks: 0,
            verdict: 'wrong',
            reason: 'تعذر التصحيح الآلي — يحتاج مراجعة يدوية',
          });
        }

        // ---------- اكتب الكاش للإجابات المصححة حديثًا ----------
        const cacheRows = gradedEssayResults
          .filter((result) => needsAi.some((q) => q.id === result.question_id))
          .map((result) => ({
            cache_key: '', // يُملأ تحت
            question_id: result.question_id,
            marks: result.marks,
            verdict: result.verdict,
            reason: result.reason,
          }));
        const cacheInserts: Array<{ cache_key: string; question_id: string; marks: number; verdict: string; reason: string }> = [];
        for (const row of cacheRows) {
          const source = needsAi.find((q) => q.id === row.question_id);
          if (!source) continue;
          cacheInserts.push({ ...row, cache_key: await cacheKeyFor(row.question_id, source.student_answer) });
        }
        if (cacheInserts.length > 0) {
          const { error: cacheError } = await db
            .from('public_exam_grading_cache')
            .upsert(cacheInserts, { onConflict: 'cache_key' });
          if (cacheError) {
            console.error('grade-public-exam: cache upsert failed', cacheError.message);
          }
        }
      }

      gradedEssayResults.push(...fromCache);

      // ---------- اكتب النتائج ----------
      const cacheHits = new Set(fromCache.map((row) => row.question_id));
      for (const result of gradedEssayResults) {
        const { error: updateError } = await db
          .from('public_exam_answers')
          .update({
            marks_awarded: result.marks,
            verdict: result.verdict,
            reason: result.reason || null,
            graded_by: cacheHits.has(result.question_id) ? 'ai_cache' : 'ai',
            updated_at: new Date().toISOString(),
          })
          .eq('attempt_id', attemptId)
          .eq('question_id', result.question_id)
          .is('marks_awarded', null);
        if (updateError) {
          console.error('grade-public-exam: answer update failed', result.question_id, updateError.message);
        }
      }
    }

    // ---------- احسب المجموع من الإجابات النهائية ----------
    const { data: finalAnswers, error: finalError } = await db
      .from('public_exam_answers')
      .select('marks_awarded, question_id')
      .eq('attempt_id', attemptId);
    if (finalError || !finalAnswers) {
      throw new Error('answers_reload_failed');
    }
    const essayIdSet = new Set(essays.map((question) => question.id));
    let objective = 0;
    let essay = 0;
    for (const row of finalAnswers as AnyRecord[]) {
      const marks = row.marks_awarded === null || row.marks_awarded === undefined ? 0 : Number(row.marks_awarded);
      if (essayIdSet.has(String(row.question_id))) {
        essay += marks;
      } else {
        objective += marks;
      }
    }

    const { error: finalUpdateError } = await db
      .from('public_exam_attempts')
      .update({
        status: 'graded',
        objective_score: objective,
        essay_score: essay,
        final_score: objective + essay,
        ai_raw: { graded_essays: gradedEssayResults.length, model_chain: MODEL_CHAIN[0] ?? 'none' },
      })
      .eq('id', attemptId);
    if (finalUpdateError) {
      throw new Error(`attempt_final_update_failed: ${finalUpdateError.message}`);
    }

    return jsonResponse({
      status: 'graded',
      objective_score: objective,
      essay_score: essay,
      final_score: objective + essay,
    });
  } catch (error) {
    console.error('grade-public-exam: grading failed', error);
    await db
      .from('public_exam_attempts')
      .update({ status: 'grading_failed', ai_raw: { error: String(error instanceof Error ? error.message : error) } })
      .eq('id', attemptId);
    return jsonResponse({ error: 'grading_failed' }, 502);
  }
}

if (import.meta.main) {
  Deno.serve(handle);
}
