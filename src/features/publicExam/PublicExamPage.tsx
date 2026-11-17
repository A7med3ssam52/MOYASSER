import { Clock3, Hourglass } from 'lucide-react';

import { SeoHead } from '../../components/SeoHead';
import { useServerTime } from '../../lib/serverTime';

import { PublicExamLivePage } from './PublicExamLivePage';

/** موعد فتح الإمتحان — ثابت للكل (توقيت القاهرة). */
const EXAM_OPENS_AT_ISO = '2026-11-17T22:30:00+02:00';
const EXAM_OPENS_LABEL = 'الساعة 10:30 مساء اليوم (17 نوفمبر 2026) — وحتى نهاية يوم 18 نوفمبر';

function remainingParts(remainingMs: number): { hours: string; minutes: string; seconds: string } {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    hours: pad(Math.floor(totalSeconds / 3600)),
    minutes: pad(Math.floor((totalSeconds % 3600) / 60)),
    seconds: pad(totalSeconds % 60),
  };
}

export function PublicExamPage() {
  const serverTime = useServerTime(true);
  const nowMs = serverTime.nowMs ?? Date.now();
  const remainingMs = Math.max(0, Date.parse(EXAM_OPENS_AT_ISO) - nowMs);
  const started = remainingMs === 0;
  const { hours, minutes, seconds } = remainingParts(remainingMs);

  // بعد فتح الإمتحان: الراوت بيرن تلقائيًا للإمتحان الحي (بدون إعادة تحميل)
  if (started) {
    return <PublicExamLivePage />;
  }

  return (
    <div dir="rtl" className="relative flex min-h-dvh flex-col overflow-hidden bg-background text-foreground">
      <SeoHead
        title="الإمتحان قريباً | امتحان الدراسات الاجتماعية"
        description="امتحان الدراسات الاجتماعية للصف السادس الابتدائي — الترم الأول — الإمتحان على وشك البدء"
        canonicalPath="/exam"
        noIndex
      />

      {/* توهجات خلفية ناعمة */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 right-1/2 h-96 w-96 translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute bottom-0 left-0 h-72 w-72 rounded-full bg-primary-soft/40 blur-3xl" />
      </div>

      <main className="relative mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-4 py-12 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-primary/20 bg-primary-soft/60 shadow-sm">
          <Hourglass className="h-10 w-10 text-primary-strong" aria-hidden="true" />
        </div>

        <p className="mt-6 text-xs font-bold uppercase tracking-widest text-foreground-subtle">
          الصف السادس الابتدائي · الترم الأول
        </p>
        <h1 className="mt-2 text-4xl font-black leading-tight text-foreground sm:text-5xl">الإمتحان قريباً</h1>
        <p className="mt-3 text-base font-bold text-foreground-muted sm:text-lg">امتحان الدراسات الاجتماعية</p>

        <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-bold text-foreground-muted sm:text-sm">
          <Clock3 className="h-4 w-4 text-primary-strong" aria-hidden="true" />
          {EXAM_OPENS_LABEL}
        </p>

        {/* العداد التنازلي */}
        <div
          className="mt-8 flex items-stretch justify-center gap-3 sm:gap-4"
          role="timer"
          aria-live="off"
          aria-label="الوقت المتبقي على فتح الإمتحان"
          dir="ltr"
        >
          <CountdownUnit value={hours} label="ساعة" />
          <CountdownSeparator />
          <CountdownUnit value={minutes} label="دقيقة" />
          <CountdownSeparator />
          <CountdownUnit value={seconds} label="ثانية" />
        </div>

        {started ? (
          <p className="mt-8 animate-pulse text-lg font-black text-primary-strong">الإمتحان على وشك البدء — ترقبوا</p>
        ) : (
          <p className="mt-8 text-sm leading-7 text-foreground-muted">
            استعدوا — الإمتحان هيفتح الساعة 10:30 مساءً (بتوقيت القاهرة).
            <br />
            وعند الفتح الصفحة دي هتتحول تلقائيًا للإمتحان — كل طالب يدخل ياخد ساعة كاملة.
            <br />
            والإمتحان هيفضل متاحًا حتى نهاية يوم 18 نوفمبر 2026.
          </p>
        )}
      </main>

      <footer className="relative border-t border-border bg-surface/60 px-4 py-3 text-center text-[11px] text-foreground-subtle">
        منصة مستر محمد ياسر — بالتوفيق لجميع الطلبة
      </footer>
    </div>
  );
}

function CountdownUnit({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-border bg-surface font-mono text-4xl font-black tabular-nums text-primary-strong shadow-sm sm:h-24 sm:w-24 sm:text-5xl">
        {value}
      </div>
      <span className="text-[11px] font-bold text-foreground-subtle sm:text-xs">{label}</span>
    </div>
  );
}

function CountdownSeparator() {
  return (
    <div aria-hidden="true" className="flex items-center pb-6 text-3xl font-black text-foreground-subtle sm:text-4xl">
      :
    </div>
  );
}
