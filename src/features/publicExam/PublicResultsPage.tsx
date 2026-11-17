import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  ClipboardList,
  Download,
  Eye,
  RefreshCw,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Input } from '../../components/Input';
import { LayoutShell } from '../../components/LayoutShell';
import { Modal } from '../../components/Modal';
import { RoleNav } from '../../components/RoleNav';
import { Skeleton } from '../../components/Skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../../lib/format';
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

type Tab = 'all' | 'grading' | 'graded' | 'late';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'grading', label: 'بانتظار التصحيح' },
  { id: 'graded', label: 'تم التصحيح' },
  { id: 'late', label: 'المتأخرون' },
];

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
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<PublicExamAttemptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<PublicExamAttemptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [regrading, setRegrading] = useState(false);

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

  const filteredRows = useMemo(() => {
    if (tab !== 'grading') return rows;
    return rows.filter(
      (row) =>
        row.status === 'submitted' || row.status === 'grading' || row.status === 'grading_failed' || row.status === 'in_progress',
    );
  }, [rows, tab]);

  const counts = useMemo(
    () => ({
      total: rows.length,
      graded: rows.filter((r) => r.status === 'graded').length,
      pending: rows.filter((r) => ['submitted', 'grading', 'grading_failed', 'in_progress'].includes(r.status)).length,
      late: rows.filter((r) => r.status === 'late').length,
    }),
    [rows],
  );

  const openDetail = useCallback(async (attemptId: string) => {
    setDetailId(attemptId);
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await getPublicExamAttemptDetail(attemptId));
    } catch {
      showToast('تعذر تحميل تفاصيل المحاولة', 'error');
      setDetailId(null);
    } finally {
      setDetailLoading(false);
    }
  }, [showToast]);

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
      setDetail(await getPublicExamAttemptDetail(detailId));
      void load();
    } catch {
      showToast('تعذر الاتصال بخادم التصحيح', 'error');
    } finally {
      setGrading(false);
    }
  }, [detailId, load, showToast]);

  const regradeAll = useCallback(async () => {
    setRegrading(true);
    let ok = 0;
    let failed = 0;
    try {
      const stuck = rows.filter((row) => ['submitted', 'grading_failed', 'grading'].includes(row.status)).slice(0, 25);
      for (const row of stuck) {
        const result = await gradePublicExamAttempt(row.id);
        if (result.status === 'graded' || result.status === 'already_graded') {
          ok += 1;
        } else {
          failed += 1;
        }
      }
      showToast(
        failed > 0 ? `تم تصحيح ${ok} — تعذر ${failed} (جرّب تاني لما الحصة ترجع)` : `تم تصحيح ${ok} بنجاح`,
        failed > 0 ? 'warning' : 'success',
      );
      void load();
    } catch {
      showToast('تعذر الاتصال بخادم التصحيح', 'error');
    } finally {
      setRegrading(false);
    }
  }, [rows, load, showToast]);

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
    const header = ['الاسم', 'رقم التليفون', 'الحالة', 'وقت البداية', 'وقت التسليم', 'الدرجة', 'من'];
    const lines = filteredRows.map((row) =>
      [
        row.full_name,
        row.phone,
        STATUS_LABELS[row.status],
        row.started_at ? formatDateTime(row.started_at) : '—',
        row.submitted_at ? formatDateTime(row.submitted_at) : '—',
        row.final_score ?? '',
        row.max_score ?? '',
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

  return (
    <LayoutShell title="نتائج امتحان الدراسات الاجتماعية" variant="sidebar" nav={<RoleNav />}>
      <div dir="rtl" className="flex flex-col gap-5 p-4 sm:p-6">
        {/* الإحصائيات السريعة */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'إجمالي المسجلين', value: counts.total, icon: Users },
            { label: 'تم تصحيحهم', value: counts.graded, icon: ClipboardList },
            { label: 'بانتظار التصحيح', value: counts.pending, icon: Sparkles },
            { label: 'المتأخرون', value: counts.late, icon: Eye },
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
            <Button
              variant="outline"
              size="md"
              loading={regrading}
              disabled={regrading || counts.pending === 0}
              onClick={() => void regradeAll()}
              icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
              title="يعيد تصحيح المقالات للمحاولات المتعثرة (لو مفيش quota متاح، هتتعمل لما الحصة ترجع)"
            >
              إعادة تصحيح المتعثر ({counts.pending})
            </Button>
            <Button variant="outline" size="md" onClick={exportCsv} icon={<Download className="h-4 w-4" aria-hidden="true" />}>
              تصدير CSV
            </Button>
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
          <EmptyState title="لا توجد محاولات" description="لم يسجل أحد في هذه القائمة بعد." />
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
                    <Button variant="ghost" size="sm" onClick={() => void openDetail(row.id)}>
                      التفاصيل
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* نافذة التفاصيل */}
      <DetailModal
        open={detailId !== null}
        detail={detail}
        loading={detailLoading}
        grading={grading}
        onRetryGrading={retryGrading}
        onMarksSaved={handleMarksSaved}
        onClose={() => {
          setDetailId(null);
          setDetail(null);
        }}
      />
    </LayoutShell>
  );
}

// ============================================================
// نافذة تفاصيل المحاولة + التصحيح اليدوي
// ============================================================
interface DetailModalProps {
  open: boolean;
  detail: PublicExamAttemptDetail | null;
  loading: boolean;
  grading: boolean;
  onRetryGrading: () => void;
  onMarksSaved: (value: {
    objective_score: number | null;
    essay_score: number | null;
    final_score: number | null;
    status: string;
  }) => void;
  onClose: () => void;
}

function DetailModal({
  open,
  detail,
  loading,
  grading,
  onRetryGrading,
  onMarksSaved,
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
            {pending ? (
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
