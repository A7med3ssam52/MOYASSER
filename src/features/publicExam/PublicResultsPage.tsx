import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import {
  ClipboardList,
  Download,
  Eye,
  Link2,
  LogIn,
  PenLine,
  RefreshCw,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';

import { Badge } from '../../components/Badge';
import { BrandIcon } from '../../components/BrandIcon';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Input } from '../../components/Input';
import { LayoutShell } from '../../components/LayoutShell';
import { Modal } from '../../components/Modal';
import { RoleNav } from '../../components/RoleNav';
import { Skeleton } from '../../components/Skeleton';
import { Spinner } from '../../components/Spinner';
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../../lib/format';
import { copyText } from '../../lib/clipboard';
import { useAuth } from '../auth/AuthContext';
import {
  getPublicExamAttemptDetail,
  gradePublicExamAttempt,
  listPublicExamAttempts,
  setPublicExamAnswerMarks,
} from './publicExamRpc';
import type {
  PublicExamAttemptDetail,
  PublicExamAttemptRow,
  PublicExamAttemptStatus,
} from './publicExamTypes';

type Tab = 'all' | 'grading' | 'graded' | 'late' | 'recheck';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'grading', label: 'بانتظار التصحيح' },
  { id: 'graded', label: 'تم التصحيح' },
  { id: 'late', label: 'المتأخرون' },
  { id: 'recheck', label: 'طلبات إعادة التصحيح' },
];

const STAFF_ROLES: ReadonlyArray<string> = ['mr_moyasser', 'admin', 'teacher'];

function statusVariant(status: PublicExamAttemptStatus): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  switch (status) {
    case 'graded':
      return 'success';
    case 'grading':
    case 'submitted':
    case 'grading_failed':
      return 'warning';
    case 'in_progress':
      return 'info';
    case 'late':
      return 'error';
    default:
      return 'neutral';
  }
}

const STATUS_LABELS: Record<PublicExamAttemptStatus, string> = {
  in_progress: 'قيد الحل',
  submitted: 'تم التسليم — بانتظار التصحيح',
  grading: 'جاري التصحيح',
  graded: 'تم التصحيح',
  grading_failed: 'فشل التصحيح الآلي',
  late: 'متأخر (لم يدخل)',
};

export function PublicResultsPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const { role, loading: authLoading } = useAuth();
  const isStaff = role !== null && STAFF_ROLES.includes(role);

  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<PublicExamAttemptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<PublicExamAttemptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const statusFilter =
    tab === 'grading' ? null : tab === 'graded' ? 'graded' : tab === 'late' ? 'late' : null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listPublicExamAttempts({
        status: statusFilter,
        search: search.trim() || null,
        limit: 500,
      });
      setRows(data);
    } catch {
      setError('تعذر تحميل المحاولات — حاول مرة أخرى');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  // فتح/قفل تفاصيل المحاولة عبر الـ URL (?attempt=<id>) — يدعم اللينكات المنسوخة والرجوع بالمتصفح
  const detailIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = searchParams.get('attempt');
    if (id === detailIdRef.current) {
      return;
    }
    detailIdRef.current = id;
    if (!id) {
      setDetailId(null);
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailId(id);
    setDetailLoading(true);
    setDetail(null);
    getPublicExamAttemptDetail(id)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch(() => {
        if (cancelled) return;
        showToast('تعذر تحميل تفاصيل المحاولة', 'error');
        detailIdRef.current = null;
        setDetailId(null);
        setSearchParams({}, { replace: true });
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams, showToast, setSearchParams]);

  const openDetail = useCallback(
    (attemptId: string) => {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set('attempt', attemptId);
        return next;
      });
    },
    [setSearchParams],
  );

  const closeDetail = useCallback(() => {
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  const copyResultLink = useCallback(
    async (attemptId: string) => {
      const url = `${window.location.origin}/results?attempt=${attemptId}`;
      const ok = await copyText(url);
      showToast(ok ? 'تم نسخ لينك نتيجة الطالب' : 'تعذر نسخ اللينك', ok ? 'success' : 'error');
    },
    [showToast],
  );

  const filteredRows = useMemo(() => {
    if (tab === 'grading') {
      return rows.filter(
        (row) =>
          row.status === 'submitted' || row.status === 'grading' || row.status === 'grading_failed' || row.status === 'in_progress',
      );
    }
    if (tab === 'recheck') {
      return rows.filter((row) => row.recheck_requested_at !== null);
    }
    return rows;
  }, [rows, tab]);

  const counts = useMemo(
    () => ({
      total: rows.length,
      graded: rows.filter((r) => r.status === 'graded').length,
      pending: rows.filter((r) => ['submitted', 'grading', 'grading_failed', 'in_progress'].includes(r.status)).length,
      late: rows.filter((r) => r.status === 'late').length,
      recheck: rows.filter((r) => r.recheck_requested_at !== null).length,
    }),
    [rows],
  );

  const retryGrading = useCallback(async () => {
    if (!detailId) return;
    setGrading(true);
    try {
      const result = await gradePublicExamAttempt(detailId);
      if (result.status === 'graded' || result.status === 'already_graded') {
        showToast('تم تصحيح الإمتحان', 'success');
      } else if (result.status === 'grading_failed') {
        showToast('فشل التصحيح الآلي — راجع المقالات يدويًا', 'error');
      }
      const fresh = await getPublicExamAttemptDetail(detailId);
      setDetail(fresh);
      void load();
    } catch {
      showToast('تعذر الاتصال بخادم التصحيح', 'error');
    } finally {
      setGrading(false);
    }
  }, [detailId, load, showToast]);

  const handleMarksSaved = useCallback(
    (updated: { objective_score: number | null; essay_score: number | null; final_score: number | null; status: string }) => {
      setDetail((previous) =>
        previous
          ? {
              ...previous,
              attempt: {
                ...previous.attempt,
                objective_score: updated.objective_score,
                essay_score: updated.essay_score,
                final_score: updated.final_score,
                status: updated.status as PublicExamAttemptStatus,
              },
            }
          : previous,
      );
      showToast('تم حفظ الدرجة', 'success');
      void load();
    },
    [load, showToast],
  );

  const exportCsv = useCallback(() => {
    const header = ['الاسم', 'رقم التليفون', 'الحالة', 'وقت البداية', 'وقت التسليم', 'الدرجة', 'من', 'طلب إعادة تصحيح'];
    const lines = filteredRows.map((row) =>
      [
        row.full_name,
        row.phone,
        STATUS_LABELS[row.status],
        row.started_at ? formatDateTime(row.started_at) : '—',
        row.submitted_at ? formatDateTime(row.submitted_at) : '—',
        row.final_score ?? '',
        row.max_score ?? '',
        row.recheck_requested_at ? 'نعم' : '',
      ]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(','),
    );
    const csv = '﻿' + [header.join(','), ...lines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `نتائج-دراسات-سادسة-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [filteredRows]);

  const content = (
    <div dir="rtl" className="flex flex-col gap-5 p-4 sm:p-6">
        {/* إشعار القراءة فقط لغير الطاقم */}
        {!isStaff ? (
          <div
            role="note"
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface-muted px-4 py-3 text-sm"
          >
            <p className="leading-6 text-foreground-muted">
              <span className="font-bold text-foreground">نسخة عرض فقط.</span> تعديل الدرجات وإعادة التصحيح الآلي متاحان
              للطاقم بعد تسجيل الدخول.
            </p>
            <Button variant="outline" size="sm" onClick={() => navigate('/login')} icon={<LogIn className="h-4 w-4" aria-hidden="true" />}>
              تسجيل دخول الطاقم
            </Button>
          </div>
        ) : null}

        {/* الإحصائيات السريعة */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { label: 'إجمالي المسجلين', value: counts.total, icon: Users },
            { label: 'تم تصحيحهم', value: counts.graded, icon: ClipboardList },
            { label: 'بانتظار التصحيح', value: counts.pending, icon: Sparkles },
            { label: 'المتأخرون', value: counts.late, icon: Eye },
            { label: 'طلبات إعادة تصحيح', value: counts.recheck, icon: PenLine },
          ].map(({ label, value, icon: Icon }) => (
            <div
              key={label}
              className="rounded-2xl border border-border bg-surface px-4 py-3"
            >
              <Icon className="mb-1 h-4 w-4 text-foreground-subtle" aria-hidden="true" />
              <p className="text-2xl font-black tabular-nums">{value}</p>
              <p className="text-[11px] font-medium text-foreground-subtle">{label}</p>
            </div>
          ))}
        </div>

        {/* التابات والبحث والتصدير */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="تصفية المحاولات">
            {TABS.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={`h-10 rounded-full border px-4 text-sm font-bold transition-colors ${
                  tab === item.id
                    ? 'border-primary-strong bg-primary-soft text-primary-strong'
                    : 'border-border bg-surface text-foreground-muted hover:text-foreground'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle"
                aria-hidden="true"
              />
              <Input
                label=""
                aria-label="ابحث بالاسم أو التليفون"
                placeholder="ابحث بالاسم أو التليفون…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-56 ps-9"
              />
            </div>
            <Button variant="outline" size="md" onClick={() => void load()} aria-label="تحديث">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </Button>
            {isStaff ? (
              <Button variant="outline" size="md" onClick={exportCsv} icon={<Download className="h-4 w-4" aria-hidden="true" />}>
                تصدير CSV
              </Button>
            ) : null}
          </div>
        </div>

        {/* الجدول */}
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : filteredRows.length === 0 ? (
          <EmptyState
            title="لا توجد محاولات"
            description={tab === 'recheck' ? 'لا توجد طلبات إعادة تصحيح حتى الآن.' : 'لم يسجل أحد في هذه القائمة بعد.'}
          />
        ) : (
          <Table dense>
            <TableHead>
              <TableRow>
                <TableHeadCell>#</TableHeadCell>
                <TableHeadCell>الاسم</TableHeadCell>
                <TableHeadCell>التليفون</TableHeadCell>
                <TableHeadCell>الحالة</TableHeadCell>
                <TableHeadCell>البداية</TableHeadCell>
                <TableHeadCell>التسليم</TableHeadCell>
                <TableHeadCell>الدرجة</TableHeadCell>
                <TableHeadCell>إعادة التصحيح</TableHeadCell>
                <TableHeadCell>
                  <span className="sr-only">إجراءات</span>
                </TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredRows.map((row, index) => (
                <TableRow key={row.id}>
                  <TableCell>{index + 1}</TableCell>
                  <TableCell className="font-bold">{row.full_name}</TableCell>
                  <TableCell dir="ltr" className="text-start font-mono">
                    {row.phone}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.status)}>{STATUS_LABELS[row.status]}</Badge>
                  </TableCell>
                  <TableCell>{row.started_at ? formatDateTime(row.started_at) : '—'}</TableCell>
                  <TableCell>{row.submitted_at ? formatDateTime(row.submitted_at) : '—'}</TableCell>
                  <TableCell className="tabular-nums font-bold">
                    {row.final_score !== null ? `${row.final_score} / ${row.max_score}` : '—'}
                  </TableCell>
                  <TableCell>
                    {row.recheck_requested_at ? (
                      <Badge variant="warning" icon={<PenLine className="h-3 w-3" aria-hidden="true" />} title={row.recheck_reason ?? 'طلب إعادة تصحيح يدوي'}>
                        طلب إعادة
                      </Badge>
                    ) : (
                      <span className="text-foreground-subtle">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void openDetail(row.id)}>
                        التفاصيل
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void copyResultLink(row.id)}
                        aria-label={`نسخ لينك نتيجة ${row.full_name}`}
                        title="نسخ لينك النتيجة"
                      >
                        <Link2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
    </div>
  );

  if (authLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="جاري التحميل" />
      </div>
    );
  }

  return isStaff ? (
    <LayoutShell title="نتائج امتحان الدراسات الاجتماعية" variant="sidebar" nav={<RoleNav />}>
      {content}
      {renderDetailModal()}
    </LayoutShell>
  ) : (
    <div dir="rtl" className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4">
          <a href="/" className="flex items-center gap-2 text-sm font-black transition-colors hover:text-primary-strong">
            <BrandIcon className="h-7 w-7" />
            منصة مسيّر
          </a>
          <p className="hidden text-xs font-bold text-foreground-subtle sm:block">
            نتائج امتحان الدراسات الاجتماعية — قراءة فقط
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/login')}
            icon={<LogIn className="h-4 w-4" aria-hidden="true" />}
          >
            دخول الطاقم
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1">{content}</main>
      <footer className="border-t border-border bg-surface/60 px-4 py-3 text-center text-[11px] text-foreground-subtle">
        منصة مستر محمد ياسر — نتائج امتحان الدراسات الاجتماعية (الصف السادس الابتدائي)
      </footer>
      {renderDetailModal()}
    </div>
  );

  function renderDetailModal() {
    return (
      <DetailModal
        open={detailId !== null}
        detail={detail}
        loading={detailLoading}
        grading={grading}
        canEdit={isStaff}
        onRetryGrading={retryGrading}
        onMarksSaved={handleMarksSaved}
        onLogin={() => navigate('/login')}
        onClose={closeDetail}
      />
    );
  }
}

// ============================================================
// نافذة تفاصيل المحاولة + التصحيح اليدوي (التصحيح للطاقم فقط)
// ============================================================
interface DetailModalProps {
  open: boolean;
  detail: PublicExamAttemptDetail | null;
  loading: boolean;
  grading: boolean;
  canEdit: boolean;
  onRetryGrading: () => void;
  onMarksSaved: (value: {
    objective_score: number | null;
    essay_score: number | null;
    final_score: number | null;
    status: string;
  }) => void;
  onLogin: () => void;
  onClose: () => void;
}

function DetailModal({
  open,
  detail,
  loading,
  grading,
  canEdit,
  onRetryGrading,
  onMarksSaved,
  onLogin,
  onClose,
}: DetailModalProps) {
  const [draftMarks, setDraftMarks] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    setDraftMarks({});
  }, [detail?.attempt.id]);

  const saveMarks = useCallback(
    async (questionId: string, marks: number) => {
      if (!detail) return;
      setSavingId(questionId);
      try {
        const updated = await setPublicExamAnswerMarks({
          attemptId: detail.attempt.id,
          questionId,
          marks,
        });
        onMarksSaved(updated);
      } catch {
        /* surfaced via toast by caller if needed */
      } finally {
        setSavingId(null);
      }
    },
    [detail, onMarksSaved],
  );

  const pending =
    detail && (detail.attempt.status === 'submitted' || detail.attempt.status === 'grading' || detail.attempt.status === 'grading_failed');

  return (
    <Modal
      open={open}
      title="تفاصيل الإمتحان"
      description={detail ? `${detail.attempt.full_name} — ${detail.attempt.phone}` : undefined}
      confirmLabel="إغلاق"
      cancelLabel=""
      onConfirm={onClose}
      onCancel={onClose}
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-foreground-muted">جاري التحميل…</p>
      ) : detail ? (
        <div className="mt-3 flex max-h-[62vh] flex-col gap-3 overflow-y-auto pe-1">
          {/* إشعار القراءة فقط لغير الطاقم */}
          {!canEdit ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-surface-muted px-4 py-3 text-xs">
              <p className="leading-6 text-foreground-muted">
                <span className="font-bold text-foreground">وضع القراءة فقط.</span> تعديل الدرجات متاح للطاقم بعد الدخول.
              </p>
              <Button size="sm" variant="outline" onClick={onLogin} icon={<LogIn className="h-4 w-4" aria-hidden="true" />}>
                تسجيل الدخول
              </Button>
            </div>
          ) : null}

          {/* تنبيه طلب إعادة التصحيح اليدوي */}
          {detail.attempt.recheck_requested_at ? (
            <div className="rounded-2xl border border-amber-600/25 bg-amber-500/10 px-4 py-3 text-sm">
              <p className="flex items-center gap-2 font-bold text-foreground">
                <PenLine className="h-4 w-4 text-warning" aria-hidden="true" />
                الطالب طلب إعادة تصحيح يدوي
              </p>
              <p className="mt-1 text-xs leading-6 text-foreground-muted">
                {formatDateTime(detail.attempt.recheck_requested_at)}
                {detail.attempt.recheck_reason ? (
                  <>
                    {' '}
                    — <span className="font-medium text-foreground">«{detail.attempt.recheck_reason}»</span>
                  </>
                ) : null}
              </p>
            </div>
          ) : null}

          {/* ملخص */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface-muted px-4 py-3 text-sm">
            <div className="flex flex-wrap gap-4">
              <span>
                الموضوعية: <b className="tabular-nums">{detail.attempt.objective_score ?? '—'}</b>
              </span>
              <span>
                المقالية: <b className="tabular-nums">{detail.attempt.essay_score ?? '—'}</b>
              </span>
              <span>
                النهائية:{' '}
                <b className="tabular-nums text-primary-strong">
                  {detail.attempt.final_score ?? '—'} / {detail.attempt.max_score}
                </b>
              </span>
            </div>
            {pending && canEdit ? (
              <Button size="sm" variant="secondary" loading={grading} onClick={onRetryGrading}>
                إعادة التصحيح بالذكاء الاصطناعي
              </Button>
            ) : null}
          </div>

          {/* الأسئلة والإجابات */}
          {detail.items.map((item, index) => {
            const marksDraft = draftMarks[item.question_id] ?? (item.marks_awarded !== null ? String(item.marks_awarded) : '');
            return (
              <div key={item.question_id} className="rounded-2xl border border-border bg-surface p-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-bold leading-6">
                    {index + 1}. {item.prompt}
                  </p>
                  <span className="shrink-0 text-xs font-bold text-foreground-subtle">{item.marks} د</span>
                </div>
                {item.image_path ? (
                  <img
                    src={item.image_path}
                    alt="خريطة"
                    className="mt-2 max-h-32 rounded-xl border border-border object-contain"
                    loading="lazy"
                  />
                ) : null}
                <p className="mt-2 whitespace-pre-wrap rounded-xl bg-surface-muted px-3 py-2 leading-6">
                  <span className="text-xs text-foreground-subtle">إجابة الطالب: </span>
                  {item.answer?.trim() ? item.answer : <i className="text-foreground-subtle">بدون إجابة</i>}
                </p>
                {item.model_answer ? (
                  <p className="mt-1 whitespace-pre-wrap px-3 text-xs leading-6 text-foreground-subtle">
                    <span className="font-bold">الإجابة النموذجية: </span>
                    {item.model_answer}
                  </p>
                ) : null}
                {item.choices && item.correct_index !== null && item.correct_index !== undefined ? (
                  <p className="mt-1 px-3 text-xs leading-6 text-foreground-subtle">
                    <span className="font-bold">الاختيار الصحيح: </span>
                    {item.choices[item.correct_index]}
                  </p>
                ) : null}
                {item.reason ? (
                  <p className="mt-1 px-3 text-xs leading-6 text-foreground-subtle">
                    <span className="font-bold">ملاحظة: </span>
                    {item.reason}
                  </p>
                ) : null}
                <div className="mt-2 flex items-center justify-between gap-3 border-t border-border-muted pt-2">
                  <Badge variant={item.verdict === 'correct' ? 'success' : item.verdict === 'partial' ? 'warning' : item.verdict === 'wrong' ? 'error' : 'neutral'}>
                    {item.verdict === 'correct'
                      ? 'صحيحة'
                      : item.verdict === 'partial'
                        ? 'جزئية'
                        : item.verdict === 'wrong'
                          ? 'خاطئة'
                          : 'بانتظار التصحيح'}
                    {item.graded_by === 'ai' || item.graded_by === 'ai_cache' ? ' · ذكاء اصطناعي' : item.graded_by === 'manual' ? ' · يدوي' : ''}
                  </Badge>
                  <div className="flex items-center gap-2">
                    {canEdit ? (
                      <>
                        <label className="text-xs text-foreground-subtle" htmlFor={`marks-${item.question_id}`}>
                          الدرجة:
                        </label>
                        <input
                          id={`marks-${item.question_id}`}
                          type="number"
                          min={0}
                          max={item.marks}
                          step={0.5}
                          className="glass-input h-9 w-16 border border-border px-2 text-center text-sm tabular-nums"
                          value={marksDraft}
                          onChange={(event) =>
                            setDraftMarks((previous) => ({ ...previous, [item.question_id]: event.target.value }))
                          }
                          onBlur={() => {
                            const value = Number(draftMarks[item.question_id]);
                            if (Number.isFinite(value) && draftMarks[item.question_id] !== undefined) {
                              void saveMarks(item.question_id, value);
                            }
                          }}
                          disabled={savingId === item.question_id}
                        />
                        <span className="text-xs text-foreground-subtle">/ {item.marks}</span>
                      </>
                    ) : (
                      <p className="text-xs font-bold tabular-nums text-foreground-muted">
                        الدرجة: {item.marks_awarded ?? '—'} <span className="text-foreground-subtle">/ {item.marks}</span>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </Modal>
  );
}
