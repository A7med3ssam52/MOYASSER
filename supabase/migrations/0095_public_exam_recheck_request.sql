-- =====================================================================
-- 0095_public_exam_recheck_request.sql
-- طلب إعادة تصحيح يدوي من شاشة نتيجة الطالب (بدون تسجيل دخول)
-- + فتح /results للقراءة بدون باسورد/لوجين (العرض عام للقراءة فقط،
--   تعديل الدرجات يفضل خاص بالطاقم عبر set_public_exam_answer_marks).
-- =====================================================================

ALTER TABLE public.public_exam_attempts
    ADD COLUMN IF NOT EXISTS recheck_requested_at timestamptz,
    ADD COLUMN IF NOT EXISTS recheck_reason      text;

-- ---------------------------------------------------------------------
-- RPC: طلب إعادة تصحيح يدوي — أي زائر (anon) يقدر يطلب لممحاولته
-- ملاحظة: الطلب flag بس، مش بيغيّر أي درجة. التصحيح يفضل للطاقم.
-- idempotent: الضغطة التانية بتحدّث الملاحظة بس من غير qubump للتاريخ.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_public_exam_recheck(p_attempt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_attempt        public.public_exam_attempts;
    v_reason         text := NULLIF(btrim(COALESCE(p_reason, '')), '');
    v_was_requested  boolean;
BEGIN
    SELECT * INTO v_attempt FROM public.public_exam_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'attempt_not_found';
    END IF;
    IF v_attempt.status NOT IN ('submitted', 'grading', 'graded', 'grading_failed') THEN
        RAISE EXCEPTION 'not_submitted';
    END IF;
    IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
        RAISE EXCEPTION 'reason_too_long';
    END IF;

    v_was_requested := v_attempt.recheck_requested_at IS NOT NULL;

    UPDATE public.public_exam_attempts
       SET recheck_requested_at = COALESCE(recheck_requested_at, now()),
           recheck_reason      = COALESCE(v_reason, recheck_reason)
     WHERE id = p_attempt_id
     RETURNING * INTO v_attempt;

    RETURN jsonb_build_object('ok', true,
                              'already_requested', v_was_requested,
                              'recheck_requested_at', v_attempt.recheck_requested_at,
                              'recheck_reason', v_attempt.recheck_reason);
END;
$$;

COMMENT ON FUNCTION public.request_public_exam_recheck(uuid, text) IS 'Public/anon: flag an attempt for manual re-correction (with optional note, max 500 chars). Does NOT change scores; staff corrects from /results after login. Idempotent — repeat calls only refresh the note.';

REVOKE EXECUTE ON FUNCTION public.request_public_exam_recheck(uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.request_public_exam_recheck(uuid, text) TO anon, authenticated;

-- ---------------------------------------------------------------------
-- بدء المحاولة — شاشة «لقد قمت بأداء هذا الإمتحان بالفعل» محتاجة
-- ترجّع attempt_id + علم إعادة التصحيح عشان الطالب يطلب من هناك كمان
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_public_exam_attempt(p_full_name text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name    text := btrim(regexp_replace(COALESCE(p_full_name, ''), '\s+', ' ', 'g'));
    v_phone   text := translate(
                        regexp_replace(COALESCE(p_phone, ''), '[^0-9٠-٩۰-۹]', '', 'g'),
                        '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
                        '01234567890123456789');
    v_words   integer;
    v_open    timestamptz;
    v_close   timestamptz;
    v_dur     integer;
    v_now     timestamptz := now();
    v_attempt public.public_exam_attempts;
    v_order   jsonb;
    v_exists  boolean;
    v_max     numeric(6, 2);
    v_qs      jsonb;
BEGIN
    -- الاسم: 4 كلمات فأكثر، حروف عربية/لاتينية ومسافات فقط
    v_words := array_length(regexp_split_to_array(v_name, '\s+'), 1);
    IF v_name = '' OR v_words IS NULL OR v_words < 4 THEN
        RAISE EXCEPTION 'name_too_short';
    END IF;
    IF v_name !~ '^[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿ A-Za-z]+$' THEN
        RAISE EXCEPTION 'invalid_name';
    END IF;

    -- التليفون: 11 رقمًا يبدأ بـ 01
    IF v_phone !~ '^01[0-9]{9}$' THEN
        RAISE EXCEPTION 'invalid_phone';
    END IF;

    SELECT opens_at, closes_at, duration_minutes
      INTO v_open, v_close, v_dur
      FROM public.public_exam_settings
     WHERE exam_key = 'sades_grade6';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'exam_not_configured';
    END IF;

    IF v_now < v_open THEN
        RETURN jsonb_build_object('phase', 'not_started', 'opens_at', v_open, 'server_now', v_now);
    END IF;

    SELECT * INTO v_attempt
      FROM public.public_exam_attempts
     WHERE exam_key = 'sades_grade6' AND phone = v_phone;
    v_exists := FOUND;

    IF v_exists THEN
        IF v_attempt.status = 'late' THEN
            RETURN jsonb_build_object('phase', 'late', 'server_now', v_now);
        END IF;
        IF v_attempt.status IN ('submitted', 'grading', 'graded', 'grading_failed') THEN
            RETURN jsonb_build_object('phase', 'locked', 'status', v_attempt.status,
                                      'attempt_id', v_attempt.id,
                                      'final_score', v_attempt.final_score,
                                      'max_score', v_attempt.max_score,
                                      'recheck_requested_at', v_attempt.recheck_requested_at,
                                      'recheck_reason', v_attempt.recheck_reason,
                                      'server_now', v_now);
        END IF;
        -- محاولة قائمة غير مسلّمة → رجّعها عشان الطالب يكمل
        SELECT jsonb_agg(jsonb_build_object(
                   'id', q.id, 'kind', q.kind, 'prompt', q.prompt,
                   'choices', q.choices, 'position', q.position,
                   'marks', q.marks, 'image_path', q.image_path)
                 ORDER BY shuffled.ord_pos)
          INTO v_qs
          FROM (SELECT shuffled.id, shuffled.n AS ord_pos
                  FROM jsonb_array_elements_text(v_attempt.question_order) WITH ORDINALITY AS shuffled(id, n)) shuffled
          JOIN public.public_exam_questions q ON q.id = shuffled.id::uuid;

        RETURN jsonb_build_object('phase', 'resume',
                                  'attempt_id', v_attempt.id,
                                  'started_at', v_attempt.started_at,
                                  'deadline_at', v_attempt.deadline_at,
                                  'duration_minutes', v_dur,
                                  'total_marks', v_attempt.max_score,
                                  'server_now', v_now,
                                  'questions', COALESCE(v_qs, '[]'::jsonb));
    END IF;

    -- بعد إغلاق الدخول: سجّل كمتأخر
    IF v_now >= v_close THEN
        INSERT INTO public.public_exam_attempts (exam_key, full_name, phone, status)
        VALUES ('sades_grade6', v_name, v_phone, 'late');
        RETURN jsonb_build_object('phase', 'late', 'server_now', v_now);
    END IF;

    -- إنشاء المحاولة بترتيب عشوائي للأسئلة (ثابت للـ resume)
    SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) INTO v_order
      FROM (SELECT id FROM public.public_exam_questions
             WHERE exam_key = 'sades_grade6' ORDER BY random()) s;
    IF jsonb_array_length(v_order) = 0 THEN
        RAISE EXCEPTION 'exam_empty';
    END IF;

    SELECT COALESCE(sum(marks), 0) INTO v_max
      FROM public.public_exam_questions WHERE exam_key = 'sades_grade6';

    INSERT INTO public.public_exam_attempts
        (exam_key, full_name, phone, status, question_order, started_at, deadline_at, max_score)
    VALUES
        ('sades_grade6', v_name, v_phone, 'in_progress', v_order, v_now,
         v_now + make_interval(mins => v_dur), v_max)
    RETURNING * INTO v_attempt;

    SELECT jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'prompt', q.prompt,
                                        'choices', q.choices, 'position', q.position,
                                        'marks', q.marks, 'image_path', q.image_path)
                     ORDER BY shuffled.ord_pos)
      INTO v_qs
      FROM (SELECT shuffled.id, shuffled.n AS ord_pos
              FROM jsonb_array_elements_text(v_order) WITH ORDINALITY AS shuffled(id, n)) shuffled
      JOIN public.public_exam_questions q ON q.id = shuffled.id::uuid;

    RETURN jsonb_build_object('phase', 'started',
                              'attempt_id', v_attempt.id,
                              'started_at', v_attempt.started_at,
                              'deadline_at', v_attempt.deadline_at,
                              'duration_minutes', v_dur,
                              'total_marks', v_max,
                              'server_now', v_now,
                              'questions', COALESCE(v_qs, '[]'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------
-- get_public_exam_attempt — الحالة «done» بترجع علم إعادة التصحيح
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_exam_attempt(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_attempt public.public_exam_attempts;
    v_now     timestamptz := now();
    v_qs      jsonb;
    v_answers jsonb;
BEGIN
    SELECT * INTO v_attempt FROM public.public_exam_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'attempt_not_found';
    END IF;

    SELECT COALESCE(jsonb_object_agg(a.question_id, a.answer) FILTER (WHERE a.answer IS NOT NULL), '{}'::jsonb)
      INTO v_answers
      FROM public.public_exam_answers a
     WHERE a.attempt_id = v_attempt.id;

    IF v_attempt.status = 'in_progress' THEN
        SELECT jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'prompt', q.prompt,
                                            'choices', q.choices, 'position', q.position,
                                            'marks', q.marks, 'image_path', q.image_path)
                         ORDER BY shuffled.ord_pos)
          INTO v_qs
          FROM (SELECT shuffled.id, shuffled.n AS ord_pos
                  FROM jsonb_array_elements_text(v_attempt.question_order) WITH ORDINALITY AS shuffled(id, n)) shuffled
          JOIN public.public_exam_questions q ON q.id = shuffled.id::uuid;

        RETURN jsonb_build_object('phase', 'taking',
                                  'attempt_id', v_attempt.id,
                                  'started_at', v_attempt.started_at,
                                  'deadline_at', v_attempt.deadline_at,
                                  'server_now', v_now,
                                  'full_name', v_attempt.full_name,
                                  'total_marks', v_attempt.max_score,
                                  'questions', COALESCE(v_qs, '[]'::jsonb),
                                  'answers', COALESCE(v_answers, '{}'::jsonb));
    END IF;

    RETURN jsonb_build_object('phase', 'done',
                              'status', v_attempt.status,
                              'final_score', v_attempt.final_score,
                              'objective_score', v_attempt.objective_score,
                              'essay_score', v_attempt.essay_score,
                              'max_score', v_attempt.max_score,
                              'submitted_at', v_attempt.submitted_at,
                              'recheck_requested_at', v_attempt.recheck_requested_at,
                              'recheck_reason', v_attempt.recheck_reason,
                              'server_now', v_now);
END;
$$;

-- ---------------------------------------------------------------------
-- صفحة النتائج /results — قراءة عامة بدون لوجين (العرض فقط).
-- مفيش تعديل درجات هنا: set_public_exam_answer_marks لسه محتاج طاقم.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_public_exam_attempts(p_status text DEFAULT NULL, p_search text DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rows jsonb;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', a.id,
               'full_name', a.full_name,
               'phone', a.phone,
               'status', a.status,
               'started_at', a.started_at,
               'submitted_at', a.submitted_at,
               'deadline_at', a.deadline_at,
               'objective_score', a.objective_score,
               'essay_score', a.essay_score,
               'final_score', a.final_score,
               'max_score', a.max_score,
               'created_at', a.created_at,
               'recheck_requested_at', a.recheck_requested_at,
               'recheck_reason', a.recheck_reason)
             ORDER BY a.created_at DESC), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT * FROM public.public_exam_attempts
             WHERE exam_key = 'sades_grade6'
               AND (p_status IS NULL OR status = p_status)
               AND (p_search IS NULL OR btrim(p_search) = ''
                    OR full_name ILIKE '%' || btrim(p_search) || '%'
                    OR phone LIKE '%' || btrim(p_search) || '%')
             ORDER BY created_at DESC
             LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 1000))) a;

    RETURN jsonb_build_object('rows', v_rows,
                              'total', jsonb_array_length(v_rows));
END;
$$;

COMMENT ON FUNCTION public.list_public_exam_attempts(text, text, integer) IS 'Public read-only: list attempts (tab/search filters) for /results. Includes recheck flag; no score mutation here.';

REVOKE EXECUTE ON FUNCTION public.list_public_exam_attempts(text, text, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_public_exam_attempts(text, text, integer) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_public_exam_attempt_detail(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_attempt public.public_exam_attempts;
    v_items   jsonb;
BEGIN
    SELECT * INTO v_attempt FROM public.public_exam_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'attempt_not_found';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'question_id', q.id,
               'position', q.position,
               'kind', q.kind,
               'prompt', q.prompt,
               'image_path', q.image_path,
               'choices', q.choices,
               'correct_index', q.correct_index,
               'model_answer', q.model_answer,
               'marks', q.marks,
               'answer', a.answer,
               'marks_awarded', a.marks_awarded,
               'verdict', a.verdict,
               'reason', a.reason,
               'graded_by', a.graded_by)
             ORDER BY COALESCE((SELECT ord.n FROM jsonb_array_elements_text(v_attempt.question_order) WITH ORDINALITY AS ord(id, n) WHERE ord.id = q.id::text), q.position)), '[]'::jsonb)
      INTO v_items
      FROM public.public_exam_questions q
      LEFT JOIN public.public_exam_answers a
        ON a.question_id = q.id AND a.attempt_id = p_attempt_id
     WHERE q.exam_key = 'sades_grade6';

    RETURN jsonb_build_object('attempt', jsonb_build_object(
               'id', v_attempt.id,
               'full_name', v_attempt.full_name,
               'phone', v_attempt.phone,
               'status', v_attempt.status,
               'started_at', v_attempt.started_at,
               'submitted_at', v_attempt.submitted_at,
               'objective_score', v_attempt.objective_score,
               'essay_score', v_attempt.essay_score,
               'final_score', v_attempt.final_score,
               'max_score', v_attempt.max_score,
               'ai_raw', v_attempt.ai_raw,
               'recheck_requested_at', v_attempt.recheck_requested_at,
               'recheck_reason', v_attempt.recheck_reason),
           'items', v_items);
END;
$$;

COMMENT ON FUNCTION public.get_public_exam_attempt_detail(uuid) IS 'Public read-only: full attempt detail with model answers and per-question grading for /results. Scores can only change via set_public_exam_answer_marks (staff).';

REVOKE EXECUTE ON FUNCTION public.get_public_exam_attempt_detail(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_public_exam_attempt_detail(uuid) TO anon, authenticated;
