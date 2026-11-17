import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FileText,
  Loader2,
  Lock,
  PenLine,
  Timer,
  TriangleAlert,
} from 'lucide-react';

import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { SeoHead } from '../../components/SeoHead';
import { Textarea } from '../../components/Textarea';
import { useServerTime } from '../../lib/serverTime';
import {
  getPublicExamAttempt,
  gradePublicExamAttempt,
  requestPublicExamRecheck,
  savePublicExamAnswers,
  startPublicExamAttempt,
  submitPublicExamAttempt,
  PublicExamError,
} from './publicExamRpc';
import type { PublicExamAttemptStatus, PublicExamQuestion } from './publicExamTypes';
import { PUBLIC_EXAM_STORAGE_KEY } from './publicExamTypes';
import { formatExamCountdown, shuffledChoices } from './publicExamUtils';
import {
  normalizePublicExamPhone,
  validatePublicExamName,
  validatePublicExamPhone,
} from './validation';

const EXAM_OPENS_LABEL = 'من الساعة 10:30 مساء اليوم (17 نوفمبر 2026) وحتى نهاية يوم 18 نوفمبر';
const EXAM_CLOSES_LABEL = 'منتصف الليل (00:00) نهاية يوم 18 نوفمبر 2026';
const AUTOSAVE_DEBOUNCE_MS = 700;

type Phase =
  | 'loading'
  | 'intro'
  | 'not_started'
  | 'taking'
  | 'submitting'
  | 'result'
  | 'locked'
  | 'late'
  | 'error';

interface ExamSession {
  attemptId: string;
  fullName: string;
  startedAt: string;
  deadlineAt: string;
  totalMarks: number;
  questions: PublicExamQuestion[];
}

interface ExamResult {
  attemptId: string;
  status: PublicExamAttemptStatus;
  objectiveScore: number | null;
  essayScore: number | null;
  finalScore: number | null;
  maxScore: number | null;
  recheckRequested: boolean;
  recheckReason: string | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  name_too_short: 'برجاء كتابة الاسم الرباعي كاملًا (٤ أسماء أو أكثر)',
  invalid_name: 'الاسم يجب أن يكون حروفًا فقط بدون أرقام أو رموز',
  invalid_phone: 'رقم التليفون يجب أن يكون 11 رقمًا ويبدأ بـ 01',
  exam_not_configured: 'الإمتحان غير متاح حاليًا — حاول مرة أخرى لاحقًا',
  exam_empty: 'الإمتحان غير متاح حاليًا — حاول مرة أخرى لاحقًا',
  attempt_not_found: 'محاولاتك غير موجودة — ابدأ من جديد',
};

function errorMessage(error: unknown): string {
  if (error instanceof PublicExamError && error.code && ERROR_MESSAGES[error.code]) {
    return ERROR_MESSAGES[error.code];
  }
  return 'حدث خطأ غير متوقع — حاول مرة أخرى';
}

function answeredCount(questions: PublicExamQuestion[], answers: Record<string, string>): number {
  return questions.reduce((count, question) => {
    const value = answers[question.id];
    return value && value.trim() ? count + 1 : count;
  }, 0);
}

/**
 * النسخة الكاملة من صفحة الإمتحان (محفوظة للرجوع إليها عند فتح الإمتحان فعليًا).
 * غير مستخدمة حاليًا — المسار /exam يعرض «الإمتحان قريباً» من PublicExamPage.
 */
export function PublicExamLivePage() {
  const serverTime = useServerTime(true);
  const [phase, setPhase] = useState<Phase>('loading');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [exam, setExam] = useState<ExamSession | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ExamResult | null>(null);
  const [opensAtIso, setOpensAtIso] = useState<string | null>(null);

  const answersRef = useRef(answers);
  const saveTimerRef = useRef<number | null>(null);
  const autoSubmittedRef = useRef(false);
  const examRef = useRef(exam);
  examRef.current = exam;
  answersRef.current = answers;

  // ---------- resume on mount ----------
  useEffect(() => {
    const storedId = window.localStorage.getItem(PUBLIC_EXAM_STORAGE_KEY);
    if (!storedId) {
      setPhase('intro');
      return;
    }
    let cancelled = false;
    void getPublicExamAttempt(storedId)
      .then((state) => {
        if (cancelled) return;
        if (state.phase === 'taking') {
          setExam({
            attemptId: state.attempt_id,
            fullName: state.full_name,
            startedAt: state.started_at,
            deadlineAt: state.deadline_at,
            totalMarks: state.total_marks,
            questions: state.questions,
          });
          setAnswers(state.answers ?? {});
          setCurrentIndex(0);
          setPhase('taking');
          return;
        }
        // done
        setResult({
          attemptId: storedId,
          status: state.status,
          objectiveScore: state.objective_score,
          essayScore: state.essay_score,
          finalScore: state.final_score,
          maxScore: state.max_score,
          recheckRequested: Boolean(state.recheck_requested_at),
          recheckReason: state.recheck_reason ?? null,
        });
        setPhase('result');
      })
      .catch(() => {
        if (cancelled) return;
        window.localStorage.removeItem(PUBLIC_EXAM_STORAGE_KEY);
        setPhase('intro');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------- autosave (debounced) ----------
  const scheduleAutosave = useCallback((nextAnswers: Record<string, string>) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      const currentExam = examRef.current;
      if (!currentExam) return;
      void savePublicExamAnswers(currentExam.attemptId, nextAnswers).catch(() => {
        /* best effort — the final submit payload is authoritative */
      });
    }, AUTOSAVE_DEBOUNCE_MS);
  }, []);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
  }, []);

  const setAnswer = useCallback(
    (questionId: string, value: string) => {
      setAnswers((previous) => {
        const next = { ...previous, [questionId]: value };
        scheduleAutosave(next);
        return next;
      });
    },
    [scheduleAutosave],
  );

  // ---------- server-anchored countdown ----------
  const nowMs = serverTime.nowMs ?? Date.now();
  const deadlineMs = exam ? Date.parse(exam.deadlineAt) : null;
  const remainingMs = deadlineMs !== null ? Math.max(0, deadlineMs - nowMs) : null;
  const timeUp = remainingMs === 0 && exam !== null;

  // ---------- finalize + grade ----------
  const finalizeAttempt = useCallback(async (currentAnswers: Record<string, string>) => {
    const currentExam = examRef.current;
    if (!currentExam) return;
    setPhase('submitting');
    setSubmitError(null);
    let res;
    try {
      res = await submitPublicExamAttempt(currentExam.attemptId, currentAnswers);
    } catch (error) {
      // idempotent server-side; a failed call can be retried by the student
      setSubmitError(errorMessage(error));
      setPhase('taking');
      return;
    }

    // أظهر النتيجة الموضوعيوي فورًا — الأسئلة المقالية بتتصحح في الخلفية
    setResult({
      attemptId: currentExam.attemptId,
      status: 'submitted',
      objectiveScore: res.objective_score,
      essayScore: null,
      finalScore: null,
      maxScore: res.max_score,
      recheckRequested: false,
      recheckReason: null,
    });
    setPhase('result');

    // تصحيح المقالات بالذكاء الاصطناعي في الخلفية — محدش مستنية
    void gradePublicExamAttempt(currentExam.attemptId).catch(() => {
      /* الـ attempt بتظهر كـ grading_failed ويصححها الأستاذ من /results */
    });
  }, []);

  // تتبع نتيجة التصحيح في الخلفية (مع setInterval عشان التحديث يظهر لحظيًا)
  useEffect(() => {
    if (phase !== 'result' || !result || result.status !== 'submitted') return undefined;
    const attemptId = examRef.current?.attemptId;
    if (!attemptId) return undefined;
    let cancelled = false;
    let tries = 0;
    const poll = window.setInterval(() => {
      tries += 1;
      void getPublicExamAttempt(attemptId)
        .then((state) => {
          if (cancelled) return;
          if (state.phase === 'done') {
            setResult((previous) =>
              previous
                ? {
                    ...previous,
                    status: state.status,
                    objectiveScore: state.objective_score,
                    essayScore: state.essay_score,
                    finalScore: state.final_score,
                    maxScore: state.max_score,
                  }
                : previous,
            );
            window.clearInterval(poll);
          }
        })
        .catch(() => {
          /* استمر في المحاولة — الـ grade عند الداتا بيز مش في المتصفح */
        });
      if (tries >= 60) window.clearInterval(poll);
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [phase, result]);

  const handleSubmitClick = useCallback(() => {
    setSubmitConfirmOpen(true);
  }, []);

  const confirmSubmit = useCallback(() => {
    setSubmitConfirmOpen(false);
    void finalizeAttempt(answersRef.current);
  }, [finalizeAttempt]);

  // Auto-submit at zero
  useEffect(() => {
    if (!timeUp || phase !== 'taking' || autoSubmittedRef.current) {
      return;
    }
    autoSubmittedRef.current = true;
    void finalizeAttempt(answersRef.current);
  }, [timeUp, phase, finalizeAttempt]);

  // Warn on accidental refresh/exit while taking
  useEffect(() => {
    if (phase !== 'taking' && phase !== 'submitting') return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase]);

  // ---------- start form ----------
  const handleStart = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const nameErr = validatePublicExamName(fullName);
      const normalizedPhone = normalizePublicExamPhone(phone);
      const phoneErr = validatePublicExamPhone(phone);
      setNameError(nameErr);
      setPhoneError(phoneErr);
      if (nameErr || phoneErr || !normalizedPhone) {
        return;
      }
      setStarting(true);
      setStartError(null);
      try {
        const resultPayload = await startPublicExamAttempt(fullName.trim().replace(/\s+/g, ' '), normalizedPhone);
        if (resultPayload.phase === 'started' || resultPayload.phase === 'resume') {
          window.localStorage.setItem(PUBLIC_EXAM_STORAGE_KEY, resultPayload.attempt_id);
          setExam({
            attemptId: resultPayload.attempt_id,
            fullName: fullName.trim().replace(/\s+/g, ' '),
            startedAt: resultPayload.started_at,
            deadlineAt: resultPayload.deadline_at,
            totalMarks: resultPayload.total_marks,
            questions: resultPayload.questions,
          });
          if (resultPayload.phase === 'started') {
            setAnswers({});
          } else {
            // resume mid-exam: pull saved answers from the server
            const state = await getPublicExamAttempt(resultPayload.attempt_id);
            if (state.phase === 'taking') {
              setAnswers(state.answers ?? {});
            }
          }
          setCurrentIndex(0);
          setPhase('taking');
          window.scrollTo({ top: 0 });
          return;
        }
        if (resultPayload.phase === 'locked') {
          setResult({
            attemptId: resultPayload.attempt_id,
            status: resultPayload.status,
            objectiveScore: null,
            essayScore: null,
            finalScore: resultPayload.final_score,
            maxScore: resultPayload.max_score,
            recheckRequested: Boolean(resultPayload.recheck_requested_at),
            recheckReason: resultPayload.recheck_reason ?? null,
          });
          setPhase('locked');
          return;
        }
        if (resultPayload.phase === 'late') {
          setPhase('late');
          return;
        }
        // not_started
        if (resultPayload.phase === 'not_started') {
          setOpensAtIso(resultPayload.opens_at);
          setPhase('not_started');
        }
      } catch (error) {
        setStartError(errorMessage(error));
      } finally {
        setStarting(false);
      }
    },
    [fullName, phone],
  );

  const totalAnswered = exam ? answeredCount(exam.questions, answers) : 0;
  const currentQuestion = exam?.questions[currentIndex] ?? null;

  return (
    <div dir="rtl" className="min-h-dvh bg-background text-foreground">
      <SeoHead
        title="امتحان الدراسات الاجتماعية | الصف السادس الابتدائي"
        description="امتحان الدراسات الاجتماعية للصف السادس الابتدائي — الترم الأول"
        canonicalPath="/exam"
        noIndex
      />

      {/* ============ شاشة البداية ============ */}
      {phase === 'loading' || phase === 'intro' ? (
        <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center px-4 py-10">
          <div className="w-full rounded-3xl border border-border bg-surface p-6 shadow-sm sm:p-8">
            <div className="mb-6 text-center">
              <p className="text-xs font-bold uppercase tracking-widest text-foreground-subtle">
                الصف السادس الابتدائي · الترم الأول
              </p>
              <h1 className="mt-2 text-2xl font-black text-foreground sm:text-3xl">
                امتحان الدراسات الاجتماعية
              </h1>
              <p className="mt-2 text-sm leading-6 text-foreground-muted">
                {EXAM_OPENS_LABEL} · المدة: ساعة واحدة · درجة واحدة لكل سؤال تقريبًا
              </p>
              <p className="mt-1 text-xs text-foreground-subtle">
                آخر موعد للدخول: {EXAM_CLOSES_LABEL} — أي طالب يدخل خلال الساعة يحصل على ساعة كاملة
              </p>
            </div>

            <form onSubmit={handleStart} className="flex flex-col gap-4" noValidate>
              <Input
                label="الاسم الرباعي كاملًا"
                placeholder="مثال: يوسف خالد عبد الرحمن محمود"
                className="text-base sm:text-sm"
                value={fullName}
                onChange={(event) => {
                  setFullName(event.target.value);
                  if (nameError) setNameError(validatePublicExamName(event.target.value));
                }}
                onBlur={() => setNameError(validatePublicExamName(fullName))}
                error={nameError ?? undefined}
                autoComplete="name"
                required
              />
              <Input
                label="رقم التليفون"
                placeholder="01xxxxxxxxx"
                inputMode="numeric"
                dir="ltr"
                className="text-left text-base sm:text-sm"
                maxLength={11}
                value={phone}
                onChange={(event) => {
                  const raw = event.target.value;
                  setPhone(raw);
                  if (phoneError) setPhoneError(validatePublicExamPhone(raw));
                }}
                onBlur={() => setPhoneError(validatePublicExamPhone(phone))}
                error={phoneError ?? undefined}
                hint="11 رقمًا ويبدأ بـ 01 — المحاولة واحدة فقط لكل تليفون"
                autoComplete="tel-national"
                required
              />

              {startError ? (
                <div
                  role="alert"
                  className="rounded-2xl border border-error/40 bg-error/10 px-4 py-3 text-sm font-medium text-error"
                >
                  {startError}
                </div>
              ) : null}

              <Button type="submit" size="lg" className="mt-2 w-full" loading={starting}>
                ابدأ الإمتحان الآن
              </Button>
              <p className="text-center text-[11px] leading-5 text-foreground-subtle">
                بمجرد الضغط على «ابدأ الإمتحان» تبدأ الساعة — اقرأ التعليمات جيدًا قبل البدء
              </p>
            </form>
          </div>

          <section className="mt-6 w-full rounded-2xl border border-border bg-surface-muted p-5 text-sm leading-7 text-foreground-muted">
            <h2 className="mb-2 flex items-center gap-2 font-bold text-foreground">
              <FileText className="h-4 w-4 text-primary-strong" aria-hidden="true" />
              تعليمات هامة
            </h2>
            <ul className="list-inside list-disc space-y-1">
              <li>المدة ساعة واحدة من لحظة الضغط على «ابدأ الإمتحان» — لا يمكن إيقاف العداد.</li>
              <li>إجاباتك تُحفظ تلقائيًا أثناء الحل، حتى لو انقطعت الإنترنت أو أغلقت الصفحة.</li>
              <li>لا يمكنك إعادة الإمتحان مرة أخرى بنفس رقم التليفون.</li>
              <li>عند انتهاء الوقت يتم تسليم إجاباتك تلقائيًا وتظهر درجتك فورًا.</li>
            </ul>
          </section>
        </main>
      ) : null}

      {/* ============ قبل الميعاد ============ */}
      {phase === 'not_started' ? (
        <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
          <Clock3 className="mb-4 h-14 w-14 text-primary-strong" aria-hidden="true" />
          <h1 className="text-2xl font-black">الإمتحان لم يبدأ بعد</h1>
          <p className="mt-2 text-foreground-muted">موعد الإمتحان: {EXAM_OPENS_LABEL}</p>
          {opensAtIso && serverTime.nowMs !== null ? (
            <p className="mt-6 rounded-2xl border border-border bg-surface px-6 py-4 font-mono text-3xl font-bold tabular-nums text-primary-strong">
              {formatExamCountdown(Math.max(0, Date.parse(opensAtIso) - serverTime.nowMs))}
            </p>
          ) : null}
          <p className="mt-4 text-xs text-foreground-subtle">هيظهر الفورم تلقائيًا عند فتح الإمتحان — افتح الصفحة مرة أخرى في الموعد</p>
        </main>
      ) : null}

      {/* ============ المتأخرون ============ */}
      {phase === 'late' ? (
        <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
          <Lock className="mb-4 h-14 w-14 text-error" aria-hidden="true" />
          <h1 className="text-2xl font-black">انتهى الإمتحان</h1>
          <p className="mt-2 max-w-md leading-7 text-foreground-muted">
            انتهى موعد الدخول الساعة {EXAM_CLOSES_LABEL}. تم تسجيل بياناتك كطالب متأخر — شكرًا لمشاركتك.
          </p>
        </main>
      ) : null}

      {/* ============ قفل بعد التسليم ============ */}
      {phase === 'locked' ? (
        <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
          <CheckCircle2 className="mb-4 h-14 w-14 text-primary-strong" aria-hidden="true" />
          <h1 className="text-2xl font-black">لقد قمت بأداء هذا الإمتحان بالفعل</h1>
          {result?.finalScore !== null && result?.finalScore !== undefined ? (
            <p className="mt-3 text-lg font-bold text-foreground">
              درجتك: {result.finalScore} من {result.maxScore}
            </p>
          ) : null}
          <p className="mt-2 max-w-md leading-7 text-foreground-muted">لا يمكن إعادة الإمتحان — المحاولة واحدة فقط لكل رقم تليفون.</p>
          {result ? (
            <div className="mt-6 w-full max-w-md">
              <RecheckSection
                attemptId={result.attemptId}
                requested={result.recheckRequested}
                reason={result.recheckReason}
              />
            </div>
          ) : null}
        </main>
      ) : null}

      {/* ============ الإمتحان ============ */}
      {phase === 'taking' ? (
        exam ? (
          <div className="pb-28 sm:pb-32">
            {/* الشريط اللاصق */}
            <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
              <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-3 py-2 sm:gap-3 sm:px-4">
                <div className="min-w-0">
                  <p className="truncate text-xs text-foreground-subtle">{exam.fullName}</p>
                  <p className="text-[11px] text-foreground-subtle">
                    {answeredCount(exam.questions, answers)} / {exam.questions.length} سؤال
                  </p>
                </div>
                <div
                  className={`flex items-center gap-1.5 sm:gap-2 rounded-2xl border px-2 py-1.5 sm:px-3 font-mono text-base font-bold tabular-nums sm:text-xl ${
                    remainingMs !== null && remainingMs < 5 * 60_000
                      ? 'border-error/50 bg-error/10 text-error'
                      : 'border-border bg-surface-muted text-foreground'
                  }`}
                  aria-live="polite"
                >
                  <Timer className="h-4 w-4" aria-hidden="true" />
                  {remainingMs === null ? '--:--' : formatExamCountdown(remainingMs)}
                </div>
                <Button
                  size="sm"
                  onClick={handleSubmitClick}
                  icon={<ClipboardCheck className="h-4 w-4" aria-hidden="true" />}
                >
                  تسليم
                </Button>
              </div>
            </header>

            <main className="mx-auto w-full max-w-3xl px-4 pt-6">
              {currentQuestion ? (
                <ExamQuestionCard
                  key={currentQuestion.id}
                  question={currentQuestion}
                  index={currentIndex}
                  total={exam.questions.length}
                  answer={answers[currentQuestion.id] ?? ''}
                  attemptId={exam.attemptId}
                  showImage={
                    !currentQuestion.image_path ||
                    exam.questions[currentIndex - 1]?.image_path !== currentQuestion.image_path
                  }
                  onChange={(value) => setAnswer(currentQuestion.id, value)}
                />
              ) : null}

              {/* تنقل الأسئلة */}
              <nav aria-label="التنقل بين الأسئلة" className="mt-6">
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {exam.questions.map((question, index) => {
                    const answered = Boolean(answers[question.id]?.trim());
                    const active = index === currentIndex;
                    return (
                      <button
                        key={question.id}
                        type="button"
                        onClick={() => setCurrentIndex(index)}
                        aria-current={active ? 'true' : undefined}
                        aria-label={`السؤال ${index + 1}${answered ? ' (تمت الإجابة)' : ''}`}
                        className={`h-11 w-11 sm:h-10 sm:w-10 shrink-0 rounded-xl border text-sm font-bold transition-colors ${
                          active
                            ? 'border-primary-strong bg-primary-soft text-primary-strong'
                            : answered
                              ? 'border-border bg-surface-muted text-foreground'
                              : 'border-border bg-surface text-foreground-subtle hover:text-foreground'
                        }`}
                      >
                        {index + 1}
                      </button>
                    );
                  })}
                </div>
              </nav>

              <div className="mt-6 flex items-center justify-between gap-3">
                <Button
                  variant="outline"
                  onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}
                  disabled={currentIndex === 0}
                >
                  السابق
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setCurrentIndex((index) => Math.min(exam.questions.length - 1, index + 1))}
                  disabled={currentIndex >= exam.questions.length - 1}
                >
                  التالي
                </Button>
              </div>
            </main>

            {/* شريط التسليم السفلي */}
            <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
              <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
                <p className="hidden text-xs leading-5 text-foreground-muted sm:block">
                  الإجابات تُحفظ تلقائيًا — {totalAnswered} من {exam.questions.length} تم حلها
                </p>
                <Button
                  onClick={handleSubmitClick}
                  className="w-full sm:w-auto"
                  icon={<ClipboardCheck className="h-4 w-4" aria-hidden="true" />}
                >
                  تسليم الإمتحان
                </Button>
              </div>
            </div>
          </div>
        ) : null
      ) : null}

      {/* ============ النتيجة ============ */}
      {phase === 'result' && result ? <ResultView result={result} /> : null}

      {/* ============ خطأ ============ */}
      {phase === 'error' ? (
        <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
          <TriangleAlert className="mb-4 h-14 w-14 text-error" aria-hidden="true" />
          <h1 className="text-xl font-black">حدث خطأ غير متوقع</h1>
          <Button className="mt-6" onClick={() => window.location.reload()}>
            إعادة المحاولة
          </Button>
        </main>
      ) : null}

      {/* نافذة تأكيد التسليم */}
      <Modal
        open={submitConfirmOpen}
        title="تسليم الإمتحان؟"
        description="بعد التسليم لن تتمكن من تعديل أي إجابة، وسيتم احتساب درجتك فورًا."
        confirmLabel="نعم، سلّم الآن"
        cancelLabel="مراجعة أولاً"
        loading={phase === 'submitting'}
        onConfirm={confirmSubmit}
        onCancel={() => setSubmitConfirmOpen(false)}
      />
      {submitError ? (
        <div role="alert" className="fixed bottom-24 left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-2xl border border-error/40 bg-error/10 px-4 py-3 text-center text-sm font-medium text-error">
          {submitError}
        </div>
      ) : null}

      {phase === 'submitting' ? <GradingView /> : null}
    </div>
  );
}

// ============================================================
// بطاقة السؤال
// ============================================================
interface ExamQuestionCardProps {
  question: PublicExamQuestion;
  index: number;
  total: number;
  answer: string;
  attemptId: string;
  showImage: boolean;
  onChange: (value: string) => void;
}

function ExamQuestionCard({
  question,
  index,
  total,
  answer,
  attemptId,
  showImage,
  onChange,
}: ExamQuestionCardProps) {
  const choiceOrder = useMemo(
    () => (question.choices ? shuffledChoices(question.choices, attemptId, question.id) : null),
    [attemptId, question.choices, question.id],
  );

  return (
    <article className="rounded-3xl border border-border bg-surface p-5 shadow-sm sm:p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs font-bold text-foreground-subtle">
          السؤال {index + 1} من {total}
        </span>
        <span className="rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-[11px] font-bold text-foreground-muted">
          {question.marks} {question.marks === 1 ? 'درجة' : 'درجات'}
        </span>
      </div>

      {showImage && question.image_path ? (
        <figure className="mb-4 overflow-hidden rounded-2xl border border-border bg-background">
          <img
            src={question.image_path}
            alt="خريطة الوطن العربي"
            className="mx-auto max-h-48 w-full object-contain sm:max-h-72"
            loading="lazy"
          />
        </figure>
      ) : null}

      <h2 className="text-base font-bold leading-7 text-foreground sm:text-lg">{question.prompt}</h2>

      <div className="mt-4">
        {(question.kind === 'mcq' || question.kind === 'true_false') && choiceOrder ? (
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="اختر الإجابة">
            {choiceOrder.map((choice) => {
              const selected = answer === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange(choice)}
                  className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-start text-sm font-medium leading-6 transition-colors ${
                    selected
                      ? 'border-primary-strong bg-primary-soft/60 text-primary-strong ring-2 ring-primary/30'
                      : 'border-border bg-surface-muted/40 text-foreground hover:border-primary/40'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                      selected ? 'border-primary-strong bg-primary-strong' : 'border-foreground-subtle'
                    }`}
                  >
                    {selected ? <span className="h-2 w-2 rounded-full bg-primary-foreground" /> : null}
                  </span>
                  <span>{choice}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {question.kind === 'short' ? (
          <Input
            label="إجابتك"
            placeholder="اكتب إجابتك هنا…"
            className="text-base sm:text-sm"
            value={answer}
            onChange={(event) => onChange(event.target.value)}
            autoComplete="off"
          />
        ) : null}

        {question.kind === 'essay' ? (
          <Textarea
            label="إجابتك"
            placeholder="اكتب إجابتك هنا…"
            className="text-base sm:text-sm"
            rows={5}
            value={answer}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : null}
      </div>
    </article>
  );
}

// ============================================================
// شاشة النتيجة
// ============================================================
function GradingView() {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsedSeconds((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const clock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return (
    <main
      role="status"
      aria-live="polite"
      className="flex min-h-dvh flex-col items-center justify-center px-4 py-10 text-center"
    >
      <div className="relative mb-6 flex h-24 w-24 items-center justify-center sm:h-28 sm:w-28">
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-primary-soft/50 blur-2xl"
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-spin rounded-full border-4 border-primary/15 border-t-primary-strong"
        />
        <ClipboardCheck
          className="relative h-10 w-10 text-primary-strong sm:h-12 sm:w-12"
          aria-hidden="true"
        />
      </div>
      <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-foreground-subtle">
        استلمنا إجاباتك
      </p>
      <h1 className="mt-2 text-2xl font-black leading-snug text-foreground sm:text-3xl">
        المنصة بتصحح الإمتحان حالياً…
      </h1>
      <p className="mt-3 max-w-md leading-7 text-foreground-muted">
        بنراجع الأسئلة الموضوعية وبنصحح المقالية بالذكاء الاصطناعي.
        <br />
        ثواني وبتظهر درجتك كاملة…
      </p>
      <p className="mt-6 inline-flex items-center gap-2 rounded-2xl border border-border bg-surface px-5 py-2.5 font-mono text-lg font-bold tabular-nums text-primary-strong">
        <Timer className="h-5 w-5" aria-hidden="true" />
        {clock}
      </p>
      <p className="mt-6 max-w-xs text-[11px] leading-6 text-foreground-subtle">
        من فضلك ما تقفلش الصفحة أو تعمل تحديث.
        <br />
        إجاباتك محفوظة على السيرفر — لو حصلت أي مشكلة، نتيجتك هتظهر هنا تاني لما ترجع.
      </p>
    </main>
  );
}

function ResultView({ result }: { result: ExamResult }) {
  const graded = result.status === 'graded';
  const failed = result.status === 'grading_failed';
  const pending = result.status === 'submitted' || result.status === 'grading';
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12 text-center">
      <CheckCircle2 className="mb-4 h-16 w-16 text-primary-strong" aria-hidden="true" />
      <h1 className="text-2xl font-black">تم تسليم الإمتحان</h1>
      {pending ? (
        <>
          <p className="mt-6 text-5xl font-black tabular-nums text-foreground">{result.objectiveScore ?? '—'}</p>
          <p className="mt-1 text-sm font-bold text-foreground-muted">درجتك في الأسئلة الموضوعية (من 40)</p>
          <div className="mt-6 flex flex-col items-center gap-2 rounded-2xl border border-border bg-surface px-6 py-5 text-sm text-foreground-muted">
            <Loader2 className="h-6 w-6 animate-spin text-primary-strong" aria-hidden="true" />
            جاري تصحيح الأسئلة المقالية بالذكاء الاصطناعي…
            <span className="max-w-xs leading-6 text-xs text-foreground-subtle">
              الدرجتين المقاليتين هيضافوا تلقائيًا — يقدر يتأخر شوية لو مفيش quota متاح دلوقتي.
            </span>
          </div>
        </>
      ) : graded && result.finalScore !== null ? (
        <>
          <p className="mt-6 text-6xl font-black tabular-nums text-primary-strong">
            {result.finalScore}
          </p>
          <p className="mt-1 text-sm font-bold text-foreground-muted">من {result.maxScore} درجة</p>
          <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-2xl border border-border bg-surface px-5 py-3">
              <dt className="text-foreground-subtle">الأسئلة الموضوعية</dt>
              <dd className="mt-1 font-bold">{result.objectiveScore ?? '—'}</dd>
            </div>
            <div className="rounded-2xl border border-border bg-surface px-5 py-3">
              <dt className="text-foreground-subtle">الأسئلة المقالية</dt>
              <dd className="mt-1 font-bold">{result.essayScore ?? '—'}</dd>
            </div>
          </dl>
        </>
      ) : failed ? (
        <p className="mt-3 max-w-md leading-7 text-foreground-muted">
          تم استلام إجاباتك بنجاح. لم يكتمل تصحيح الأسئلة المقالية الآن — ستظهر درجتك بعد مراجعة الأستاذ.
        </p>
      ) : null}

      {/* طلب إعادة تصحيح يدوي — يظهر في كل حالات ما بعد التسليم */}
      <div className="mt-6 w-full max-w-md">
        <RecheckSection attemptId={result.attemptId} requested={result.recheckRequested} reason={result.recheckReason} />
      </div>

      <p className="mt-8 max-w-md text-xs leading-6 text-foreground-subtle">
        شكرًا لمشاركتك في امتحان الدراسات الاجتماعية — بالتوفيق في باقي الإمتحانات!
      </p>
    </main>
  );
}

// ============================================================
// طلب إعادة تصحيح يدوي — يظهر للطالب في شاشة النتيجة بدون لوجين
// ============================================================
const RECHECK_ERROR_MESSAGES: Record<string, string> = {
  attempt_not_found: 'محاولتك غير موجودة — افتح الصفحة مرة أخرى',
  not_submitted: 'لازم تسلّم الإمتحان الأول ثم تقدر تطلب إعادة التصحيح',
  reason_too_long: 'الملاحظة طويلة — الحد الأقصى 500 حرف',
};

function recheckErrorMessage(error: unknown): string {
  if (error instanceof PublicExamError && error.code && RECHECK_ERROR_MESSAGES[error.code]) {
    return RECHECK_ERROR_MESSAGES[error.code];
  }
  return 'تعذر إرسال الطلب — حاول مرة أخرى';
}

interface RecheckSectionProps {
  attemptId: string;
  requested: boolean;
  reason: string | null;
}

function RecheckSection({ attemptId, requested: requestedProp, reason: reasonProp }: RecheckSectionProps) {
  const [requested, setRequested] = useState(requestedProp);
  const [reason, setReason] = useState(reasonProp);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(reasonProp ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // لو اتحدّثت القيم من الخادم (مثلاً بعد الـ polling) حدّث الواجهة
  useEffect(() => {
    setRequested(requestedProp);
    setReason(reasonProp);
  }, [requestedProp, reasonProp]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    const trimmed = note.trim();
    try {
      const res = await requestPublicExamRecheck(attemptId, trimmed || null);
      setRequested(true);
      setReason(res.recheck_reason ?? (trimmed || null));
      setOpen(false);
    } catch (submitError) {
      setError(recheckErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }, [attemptId, note]);

  if (requested && !open) {
    return (
      <div className="rounded-2xl border border-border bg-surface px-4 py-4 text-sm">
        <p className="flex items-center justify-center gap-2 font-bold text-primary-strong">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          تم استلام طلب إعادة التصحيح
        </p>
        <p className="mt-1 text-xs leading-6 text-foreground-muted">
          هيتم مراجعة درجتك يدويًا من الأستاذ — ممكن تتغيّر الدرجة بعد المراجعة.
        </p>
        {reason ? (
          <p className="mt-2 whitespace-pre-wrap rounded-xl bg-surface-muted px-3 py-2 text-xs leading-6 text-foreground-muted">
            <span className="font-bold text-foreground">ملاحظتك: </span>
            {reason}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setNote(reason ?? '');
            setOpen(true);
          }}
          className="mt-3 text-xs font-bold text-primary-strong underline-offset-4 hover:underline"
        >
          تعديل الملاحظة
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setNote(reason ?? '');
          setOpen(true);
        }}
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-4 py-3 text-sm font-bold text-foreground transition-colors hover:border-primary/40 hover:text-primary-strong"
      >
        <PenLine className="h-4 w-4" aria-hidden="true" />
        طلب إعادة تصحيح يدوي
      </button>
    );
  }

  return (
    <form
      className="rounded-2xl border border-border bg-surface px-4 py-4 text-start"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        id="recheck-note"
        label="طلب إعادة تصحيح يدوي — اكتب ملاحظتك (اختياري)"
        rows={3}
        maxLength={500}
        placeholder="مثلاً: أنا شايف إن إجابتي في سؤال كذا صح… (اختياري)"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="text-base sm:text-sm"
      />
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-foreground-subtle">
        <span>هتتم مراجعة درجتك من الأستاذ — الدرجة ممكن تتغيّر بعد المراجعة</span>
        <span className="tabular-nums">{note.length}/500</span>
      </div>
      {error ? (
        <p role="alert" className="mt-2 rounded-xl border border-error/40 bg-error/10 px-3 py-2 text-xs font-medium text-error">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <Button type="submit" size="sm" loading={submitting} className="flex-1">
          إرسال الطلب
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
          إلغاء
        </Button>
      </div>
    </form>
  );
}
