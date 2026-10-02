-- =====================================================================
-- 0072_fix_presence_history_ambiguity
-- get_student_presence_history (0055) can never execute: its RETURNS TABLE
-- declares OUT parameters named id / student_id, and the existence probe
-- uses the bare column reference `WHERE id = p_student_id`, which is
-- ambiguous between the OUT parameter and profiles.id (SQLSTATE 42702 on
-- every call — proven by 12_presence.sql Section 5). Fix: qualify the
-- column (profiles.id). DROP+CREATE+grants convention (same as
-- 0045/0051/0053): DROP is required because CREATE OR REPLACE cannot
-- repair the already-stored broken definition on databases where 0055
-- applied, and grants must be re-asserted after the DROP.
-- No behavior change beyond making the function callable; body, filters,
-- ordering and grants are identical to 0055.
-- =====================================================================

DROP FUNCTION IF EXISTS public.get_student_presence_history(uuid, timestamptz, timestamptz, integer, integer);

CREATE OR REPLACE FUNCTION public.get_student_presence_history(
    p_student_id uuid,
    p_from timestamptz DEFAULT NULL,
    p_to timestamptz DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0
)
RETURNS TABLE (
    id uuid,
    student_id uuid,
    started_at timestamptz,
    last_seen_at timestamptz,
    ended_at timestamptz,
    duration_seconds integer,
    current_path text,
    current_lesson_id uuid,
    is_visible boolean,
    ip_address text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'permission_denied';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = p_student_id) THEN
        RAISE EXCEPTION 'student_not_found';
    END IF;

    RETURN QUERY
    SELECT s.id, s.student_id, s.started_at, s.last_seen_at, s.ended_at,
           (EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_seen_at) - s.started_at)))::integer AS duration_seconds,
           s.current_path, s.current_lesson_id, s.is_visible, s.ip_address
    FROM public.student_sessions s
    WHERE s.student_id = p_student_id
      AND (p_from IS NULL OR s.started_at >= p_from)
      AND (p_to IS NULL OR s.started_at <= p_to)
    ORDER BY s.started_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
    OFFSET GREATEST(0, COALESCE(p_offset, 0));
END $$;

COMMENT ON FUNCTION public.get_student_presence_history(uuid, timestamptz, timestamptz, integer, integer) IS 'Admin-only: paginated session history for a student. (0072: qualify profiles.id — the 0055 bare `id` collided with the OUT parameter and every call failed with 42702.)';

REVOKE EXECUTE ON FUNCTION public.get_student_presence_history(uuid, timestamptz, timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_student_presence_history(uuid, timestamptz, timestamptz, integer, integer) TO authenticated;
