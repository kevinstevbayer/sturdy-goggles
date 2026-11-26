-- =============================================================================
-- P1 #8: Fix get_station_inbound() for off-route / Floater-redirected teams
-- Uses the team's route order to determine the next unplayed station instead of
-- assuming ((last_station_id % 7) + 1).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_station_inbound(
  p_station_id int DEFAULT NULL
)
RETURNS TABLE (
  team_id uuid,
  team_number int,
  church text,
  eta_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.jwt_role();
  v_target_station int;
  v_walk_s int;
BEGIN
  IF NOT public.is_active_session() THEN
    RAISE EXCEPTION 'SESSION_REVOKED' USING ERRCODE = '42501';
  END IF;

  IF v_role LIKE 'station_%' THEN
    v_target_station := public.jwt_station_id();
  ELSIF v_role IN ('hub', 'floater') THEN
    v_target_station := p_station_id;
  ELSE
    RAISE EXCEPTION 'UNAUTHORIZED_ROLE' USING ERRCODE = '42501';
  END IF;

  IF v_target_station IS NULL OR v_target_station NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'INVALID_STATION_ID' USING ERRCODE = '22023';
  END IF;

  SELECT walk_time_s INTO v_walk_s FROM public.event_settings WHERE id = 1;

  RETURN QUERY
  WITH latest_scored AS (
    SELECT DISTINCT ON (a.team_id)
      a.team_id,
      COALESCE(a.ended_at, a.scored_at) AS last_ended_at
    FROM public.attempts a
    WHERE a.state = 'scored'
      AND NOT a.practice
      AND NOT a.voided
    ORDER BY a.team_id, COALESCE(a.ended_at, a.scored_at) DESC
  ),
  active_elsewhere AS (
    SELECT DISTINCT a.team_id
    FROM public.attempts a
    WHERE a.state IN ('arrived', 'started', 'ended')
      AND NOT a.practice
      AND NOT a.voided
  ),
  expected_next AS (
    SELECT DISTINCT ON (t.id)
      t.id AS team_id,
      (((t.route + gs.i) % 7) + 1) AS next_station_id
    FROM public.teams t
    CROSS JOIN generate_series(0, 6) AS gs(i)
    WHERE NOT t.withdrawn
      AND t.finished_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.attempts a
        WHERE a.team_id = t.id
          AND a.station_id = (((t.route + gs.i) % 7) + 1)
          AND a.state = 'scored'
          AND NOT a.practice
          AND NOT a.voided
      )
    ORDER BY t.id, gs.i ASC
  )
  SELECT
    t.id AS team_id,
    t.number AS team_number,
    t.church,
    (ls.last_ended_at + make_interval(secs => v_walk_s)) AS eta_at
  FROM public.teams t
  JOIN latest_scored ls ON ls.team_id = t.id
  JOIN expected_next en ON en.team_id = t.id
  LEFT JOIN active_elsewhere ae ON ae.team_id = t.id
  WHERE NOT t.withdrawn
    AND t.finished_at IS NULL
    AND ae.team_id IS NULL
    AND en.next_station_id = v_target_station
  ORDER BY eta_at ASC;
END;
$$;
