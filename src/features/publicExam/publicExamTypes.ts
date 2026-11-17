/** Typed client for the public grade-6 social-studies exam RPCs (0093). */

export type PublicExamQuestionKind = 'mcq' | 'true_false' | 'short' | 'essay';
export type PublicExamAttemptStatus =
  | 'in_progress'
  | 'submitted'
  | 'grading'
  | 'graded'
  | 'grading_failed'
  | 'late';

export interface PublicExamQuestion {
  id: string;
  kind: PublicExamQuestionKind;
  prompt: string;
  choices: string[] | null;
  position: number;
  marks: number;
  image_path: string | null;
}

export type PublicExamStartResult =
  | { phase: 'not_started'; opens_at: string; server_now: string }
  | { phase: 'late'; server_now: string }
  | {
      phase: 'locked';
      status: PublicExamAttemptStatus;
      attempt_id: string;
      final_score: number | null;
      max_score: number | null;
      recheck_requested_at: string | null;
      recheck_reason: string | null;
      server_now: string;
    }
  | {
      phase: 'started' | 'resume';
      attempt_id: string;
      started_at: string;
      deadline_at: string;
      duration_minutes: number;
      total_marks: number;
      server_now: string;
      questions: PublicExamQuestion[];
    };

export type PublicExamAttemptState =
  | {
      phase: 'taking';
      attempt_id: string;
      started_at: string;
      deadline_at: string;
      server_now: string;
      full_name: string;
      total_marks: number;
      questions: PublicExamQuestion[];
      answers: Record<string, string>;
    }
  | {
      phase: 'done';
      status: PublicExamAttemptStatus;
      final_score: number | null;
      objective_score: number | null;
      essay_score: number | null;
      max_score: number | null;
      submitted_at: string | null;
      recheck_requested_at: string | null;
      recheck_reason: string | null;
      server_now: string;
    };

export interface PublicExamSubmitResult {
  phase: 'done';
  status: PublicExamAttemptStatus;
  objective_score: number | null;
  essay_score: number | null;
  final_score: number | null;
  max_score: number | null;
  already_submitted: boolean;
}

export interface PublicExamAttemptRow {
  id: string;
  full_name: string;
  phone: string;
  status: PublicExamAttemptStatus;
  started_at: string | null;
  submitted_at: string | null;
  deadline_at: string | null;
  objective_score: number | null;
  essay_score: number | null;
  final_score: number | null;
  max_score: number | null;
  created_at: string;
  recheck_requested_at: string | null;
  recheck_reason: string | null;
}

export interface PublicExamAttemptDetailItem {
  question_id: string;
  position: number;
  kind: PublicExamQuestionKind;
  prompt: string;
  image_path: string | null;
  choices: string[] | null;
  correct_index: number | null;
  model_answer: string | null;
  marks: number;
  answer: string | null;
  marks_awarded: number | null;
  verdict: 'pending' | 'correct' | 'partial' | 'wrong';
  reason: string | null;
  graded_by: 'auto' | 'ai' | 'ai_cache' | 'manual' | null;
}

export interface PublicExamAttemptDetail {
  attempt: {
    id: string;
    full_name: string;
    phone: string;
    status: PublicExamAttemptStatus;
    started_at: string | null;
    submitted_at: string | null;
    objective_score: number | null;
    essay_score: number | null;
    final_score: number | null;
    max_score: number | null;
    ai_raw: unknown;
    recheck_requested_at: string | null;
    recheck_reason: string | null;
  };
  items: PublicExamAttemptDetailItem[];
}

export interface PublicExamGradingResult {
  status: 'graded' | 'grading_failed' | 'already_graded';
  final_score: number | null;
  objective_score: number | null;
  essay_score: number | null;
  error?: string;
}

export interface PublicExamRecheckResult {
  ok: boolean;
  already_requested: boolean;
  recheck_requested_at: string | null;
  recheck_reason: string | null;
}

export const PUBLIC_EXAM_KEY = 'sades_grade6' as const;
export const PUBLIC_EXAM_STORAGE_KEY = 'sades-grade6-exam-attempt-id';
