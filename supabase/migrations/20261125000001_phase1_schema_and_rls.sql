-- =============================================================================
-- 2027 Treasure Hunt Live Event Ops — Phase 1 Schema, RPCs, Triggers, and RLS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. CORE TABLES

CREATE TABLE public.event_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  event_state text NOT NULL DEFAULT 'practice' CHECK (event_state IN ('practice', 'live')),
  max_teams int NOT NULL DEFAULT 30 CHECK (max_teams BETWEEN 1 AND 200),
  scoring_n_mode text NOT NULL DEFAULT 'provisional' CHECK (scoring_n_mode IN ('provisional', 'final')),
  variant_ranking_mode text NOT NULL DEFAULT 'across' CHECK (variant_ranking_mode IN ('across', 'within')),
  current_variant text NOT NULL DEFAULT 'W1' CHECK (char_length(current_variant) BETWEEN 1 AND 12),
  variant_labels text[] NOT NULL DEFAULT ARRAY['W1']::text[],
  walk_time_s int NOT NULL DEFAULT 30 CHECK (walk_time_s BETWEEN 0 AND 300),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.event_settings (id) VALUES (1);

CREATE TABLE public.role_credentials (
  role text PRIMARY KEY CHECK (
    role IN ('station_1','station_2','station_3','station_4','station_5','station_6','station_7','hub','floater')
  ),
  station_id int UNIQUE CHECK (station_id BETWEEN 1 AND 7),
  secret_token text NOT NULL UNIQUE,
  pin_code text NOT NULL CHECK (pin_code ~ '^[0-9]{6}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_station_consistency CHECK (
    (role LIKE 'station_%' AND station_id = substring(role FROM 9)::int)
    OR (role IN ('hub', 'floater') AND station_id IS NULL)
  )
);

CREATE TABLE public.pin_attempts (
  id bigserial PRIMARY KEY,
  ip_hash text NOT NULL,
  role text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  succeeded bool NOT NULL DEFAULT false
);

CREATE INDEX idx_pin_attempts_ip_time ON public.pin_attempts (ip_hash, attempted_at DESC);

CREATE TABLE public.takeover_tokens (
  token text PRIMARY KEY,
  role text NOT NULL REFERENCES public.role_credentials(role) ON DELETE CASCADE,
  station_id int,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
  used_at timestamptz
);

CREATE TABLE public.role_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL REFERENCES public.role_credentials(role) ON DELETE CASCADE,
  station_id int CHECK (station_id BETWEEN 1 AND 7),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason text
);

CREATE INDEX idx_role_sessions_active ON public.role_sessions (role) WHERE revoked_at IS NULL;

CREATE TABLE public.stations (
  id int PRIMARY KEY CHECK (id BETWEEN 1 AND 7),
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number int NOT NULL UNIQUE CHECK (number BETWEEN 1 AND 999),
  church text NOT NULL CHECK (char_length(trim(church)) > 0),
  team_name text,
  token text NOT NULL UNIQUE CHECK (char_length(token) = 8),
  route int GENERATED ALWAYS AS ((number - 1) % 7) STORED,
  checked_in_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  duel_won bool NOT NULL DEFAULT false,
  withdrawn bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.attempts (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  station_id int NOT NULL REFERENCES public.stations(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('arrived', 'started', 'ended', 'scored')),
  arrived_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  scored_at timestamptz,
  completed bool,
  time_ms int CHECK (time_ms IS NULL OR time_ms >= 0),
  progress numeric CHECK (progress IS NULL OR progress >= 0),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  bonus_correct bool,
  variant text CHECK (variant IS NULL OR char_length(variant) BETWEEN 1 AND 12),
  practice bool NOT NULL DEFAULT false,
  voided bool NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  session_id uuid NOT NULL REFERENCES public.role_sessions(session_id),
  client_server_skew_flagged bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_attempts_live_team_station
  ON public.attempts (team_id, station_id)
  WHERE (NOT practice AND NOT voided);

CREATE INDEX idx_attempts_station_state ON public.attempts (station_id, state) WHERE NOT voided;
CREATE INDEX idx_attempts_team_scored ON public.attempts (team_id, ended_at DESC) WHERE (state = 'scored' AND NOT practice AND NOT voided);

CREATE TABLE public.station_resets (
  id uuid PRIMARY KEY,
  station_id int NOT NULL REFERENCES public.stations(id) ON DELETE RESTRICT,
  after_attempt_id uuid REFERENCES public.attempts(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  done_at timestamptz,
  items_done int NOT NULL DEFAULT 0 CHECK (items_done >= 0),
  skipped bool NOT NULL DEFAULT false,
  session_id uuid NOT NULL REFERENCES public.role_sessions(session_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_station_resets_station_time ON public.station_resets (station_id, started_at DESC);

CREATE TABLE public.audit_log (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor_role text NOT NULL,
  table_name text NOT NULL,
  row_id text NOT NULL,
  before jsonb,
  after jsonb,
  reason text NOT NULL CHECK (char_length(trim(reason)) > 0)
);

CREATE INDEX idx_audit_log_ts ON public.audit_log (ts DESC);

CREATE TABLE public.final_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_role text NOT NULL,
  n_final int NOT NULL CHECK (n_final >= 0),
  variant_ranking_mode text NOT NULL CHECK (variant_ranking_mode IN ('across', 'within')),
  payload jsonb NOT NULL
);

-- 2. JWT CLAIM & SESSION HELPERS

CREATE OR REPLACE FUNCTION public.jwt_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'app_role',
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
$$;

CREATE OR REPLACE FUNCTION public.jwt_station_id()
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'station_id')::int;
$$;

CREATE OR REPLACE FUNCTION public.jwt_session_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.is_active_session()
RETURNS bool
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.role_sessions rs
    WHERE rs.session_id = public.jwt_session_id()
      AND rs.role = public.jwt_role()
      AND rs.revoked_at IS NULL
  );
$$;

-- 3. PUBLIC VIEW FOR HOSTS

CREATE OR REPLACE VIEW public.teams_public AS
SELECT
  t.id,
  t.number,
  t.church,
  t.team_name,
  t.token,
  t.route,
  t.withdrawn
FROM public.teams t
WHERE public.is_active_session();

GRANT SELECT ON public.teams_public TO authenticated;

-- 4. TRIGGERS

CREATE OR REPLACE FUNCTION public.trg_attempts_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_state text;
BEGIN
  SELECT event_state INTO v_event_state FROM public.event_settings WHERE id = 1;

  IF v_event_state = 'live' AND NEW.practice = true THEN
    RAISE EXCEPTION 'PRACTICE_FORBIDDEN_IN_LIVE_MODE' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.state = 'scored' AND NEW.scored_at IS NULL THEN
    NEW.scored_at := now();
  END IF;

  IF NEW.state = 'scored' AND NEW.ended_at IS NOT NULL THEN
    IF abs(extract(epoch FROM (now() - NEW.ended_at))) > 5 THEN
      NEW.client_server_skew_flagged := true;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER attempts_before_write
  BEFORE INSERT OR UPDATE ON public.attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_attempts_before_write();

-- 5. RPCs

CREATE OR REPLACE FUNCTION public.host_undo(
  p_attempt_id uuid,
  p_undone_at timestamptz DEFAULT now()
)
RETURNS public.attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.jwt_role();
  v_station_id int := public.jwt_station_id();
  v_before public.attempts;
  v_after public.attempts;
BEGIN
  IF NOT public.is_active_session() THEN
    RAISE EXCEPTION 'SESSION_REVOKED' USING ERRCODE = '42501';
  END IF;

  IF v_role NOT LIKE 'station_%' OR v_station_id IS NULL THEN
    RAISE EXCEPTION 'HOST_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_before FROM public.attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_before.station_id <> v_station_id THEN
    RAISE EXCEPTION 'FORBIDDEN_STATION' USING ERRCODE = '42501';
  END IF;

  IF v_before.voided THEN
    RAISE EXCEPTION 'ALREADY_VOIDED' USING ERRCODE = 'P0001';
  END IF;

  IF v_before.state <> 'scored' OR v_before.scored_at IS NULL THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_SCORED' USING ERRCODE = 'P0001';
  END IF;

  IF p_undone_at > (v_before.scored_at + interval '65 seconds')
     OR now() > (v_before.scored_at + interval '70 seconds') THEN
    RAISE EXCEPTION 'UNDO_WINDOW_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.attempts
  SET voided = true,
      version = version + 1,
      updated_at = now()
  WHERE id = p_attempt_id
  RETURNING * INTO v_after;

  INSERT INTO public.audit_log (actor_role, table_name, row_id, before, after, reason)
  VALUES (v_role, 'attempts', p_attempt_id::text, to_jsonb(v_before), to_jsonb(v_after), 'host_undo');

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.host_cancel_before_start(
  p_attempt_id uuid
)
RETURNS public.attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.jwt_role();
  v_station_id int := public.jwt_station_id();
  v_before public.attempts;
  v_after public.attempts;
BEGIN
  IF NOT public.is_active_session() THEN
    RAISE EXCEPTION 'SESSION_REVOKED' USING ERRCODE = '42501';
  END IF;

  IF v_role NOT LIKE 'station_%' OR v_station_id IS NULL THEN
    RAISE EXCEPTION 'HOST_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_before FROM public.attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_before.station_id <> v_station_id THEN
    RAISE EXCEPTION 'FORBIDDEN_OR_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_before.state <> 'arrived' OR v_before.voided THEN
    RAISE EXCEPTION 'CANNOT_CANCEL_AFTER_START' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.attempts
  SET voided = true,
      version = version + 1,
      updated_at = now()
  WHERE id = p_attempt_id
  RETURNING * INTO v_after;

  INSERT INTO public.audit_log (actor_role, table_name, row_id, before, after, reason)
  VALUES (v_role, 'attempts', p_attempt_id::text, to_jsonb(v_before), to_jsonb(v_after), 'host_cancel_before_start');

  RETURN v_after;
END;
$$;

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
      a.station_id AS last_station_id,
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
  already_played_target AS (
    SELECT DISTINCT a.team_id
    FROM public.attempts a
    WHERE a.station_id = v_target_station
      AND a.state = 'scored'
      AND NOT a.practice
      AND NOT a.voided
  )
  SELECT
    t.id AS team_id,
    t.number AS team_number,
    t.church,
    (ls.last_ended_at + make_interval(secs => v_walk_s)) AS eta_at
  FROM public.teams t
  JOIN latest_scored ls ON ls.team_id = t.id
  LEFT JOIN active_elsewhere ae ON ae.team_id = t.id
  LEFT JOIN already_played_target apt ON apt.team_id = t.id
  WHERE NOT t.withdrawn
    AND t.finished_at IS NULL
    AND ae.team_id IS NULL
    AND apt.team_id IS NULL
    AND ((ls.last_station_id % 7) + 1) = v_target_station
  ORDER BY eta_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.hub_edit_attempt(
  p_attempt_id uuid,
  p_patch jsonb,
  p_reason text
)
RETURNS public.attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.attempts;
  v_after public.attempts;
BEGIN
  IF NOT public.is_active_session() OR public.jwt_role() <> 'hub' THEN
    RAISE EXCEPTION 'HUB_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR char_length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before FROM public.attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.attempts
  SET
    completed = CASE WHEN p_patch ? 'completed' THEN (p_patch ->> 'completed')::bool ELSE completed END,
    time_ms = CASE WHEN p_patch ? 'time_ms' THEN (p_patch ->> 'time_ms')::int ELSE time_ms END,
    progress = CASE WHEN p_patch ? 'progress' THEN (p_patch ->> 'progress')::numeric ELSE progress END,
    bonus_correct = CASE WHEN p_patch ? 'bonus_correct' THEN (p_patch ->> 'bonus_correct')::bool ELSE bonus_correct END,
    variant = CASE WHEN p_patch ? 'variant' THEN (p_patch ->> 'variant')::text ELSE variant END,
    voided = CASE WHEN p_patch ? 'voided' THEN (p_patch ->> 'voided')::bool ELSE voided END,
    version = version + 1,
    updated_at = now()
  WHERE id = p_attempt_id
  RETURNING * INTO v_after;

  INSERT INTO public.audit_log (actor_role, table_name, row_id, before, after, reason)
  VALUES ('hub', 'attempts', p_attempt_id::text, to_jsonb(v_before), to_jsonb(v_after), trim(p_reason));

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.hub_set_team_withdrawn(
  p_team_id uuid,
  p_withdrawn bool,
  p_reason text
)
RETURNS public.teams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.teams;
  v_after public.teams;
BEGIN
  IF NOT public.is_active_session() OR public.jwt_role() <> 'hub' THEN
    RAISE EXCEPTION 'HUB_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR char_length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before FROM public.teams WHERE id = p_team_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.teams
  SET withdrawn = p_withdrawn
  WHERE id = p_team_id
  RETURNING * INTO v_after;

  INSERT INTO public.audit_log (actor_role, table_name, row_id, before, after, reason)
  VALUES ('hub', 'teams', p_team_id::text, to_jsonb(v_before), to_jsonb(v_after), trim(p_reason));

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.hub_update_event_settings(
  p_patch jsonb,
  p_reason text
)
RETURNS public.event_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.event_settings;
  v_after public.event_settings;
BEGIN
  IF NOT public.is_active_session() OR public.jwt_role() <> 'hub' THEN
    RAISE EXCEPTION 'HUB_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR char_length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before FROM public.event_settings WHERE id = 1 FOR UPDATE;

  UPDATE public.event_settings
  SET
    event_state = COALESCE(p_patch ->> 'event_state', event_state),
    max_teams = COALESCE((p_patch ->> 'max_teams')::int, max_teams),
    scoring_n_mode = COALESCE(p_patch ->> 'scoring_n_mode', scoring_n_mode),
    variant_ranking_mode = COALESCE(p_patch ->> 'variant_ranking_mode', variant_ranking_mode),
    current_variant = COALESCE(p_patch ->> 'current_variant', current_variant),
    variant_labels = CASE
      WHEN p_patch ? 'variant_labels' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch -> 'variant_labels'))
      ELSE variant_labels
    END,
    walk_time_s = COALESCE((p_patch ->> 'walk_time_s')::int, walk_time_s),
    updated_at = now()
  WHERE id = 1
  RETURNING * INTO v_after;

  INSERT INTO public.audit_log (actor_role, table_name, row_id, before, after, reason)
  VALUES ('hub', 'event_settings', '1', to_jsonb(v_before), to_jsonb(v_after), trim(p_reason));

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.hub_purge_practice_attempts(p_reason text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted int;
BEGIN
  IF NOT public.is_active_session() OR public.jwt_role() <> 'hub' THEN
    RAISE EXCEPTION 'HUB_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR char_length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.attempts WHERE practice = true;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.audit_log (actor_role, table_name, row_id, before, after, reason)
  VALUES ('hub', 'attempts', 'bulk_practice', jsonb_build_object('deleted_count', v_deleted), NULL, trim(p_reason));

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.host_undo(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.host_cancel_before_start(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_station_inbound(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hub_edit_attempt(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hub_set_team_withdrawn(uuid, bool, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hub_update_event_settings(jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hub_purge_practice_attempts(text) TO authenticated;

-- 6. ROW-LEVEL SECURITY (RLS)

ALTER TABLE public.event_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pin_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.takeover_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.final_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY event_settings_read_all ON public.event_settings
  FOR SELECT TO authenticated
  USING (public.is_active_session());

CREATE POLICY role_sessions_read_own_or_hub ON public.role_sessions
  FOR SELECT TO authenticated
  USING (
    session_id = public.jwt_session_id()
    OR (public.jwt_role() = 'hub' AND public.is_active_session())
  );

CREATE POLICY stations_read_all ON public.stations
  FOR SELECT TO authenticated
  USING (public.is_active_session());

CREATE POLICY stations_hub_update ON public.stations
  FOR UPDATE TO authenticated
  USING (public.jwt_role() = 'hub' AND public.is_active_session())
  WITH CHECK (public.jwt_role() = 'hub' AND public.is_active_session());

CREATE POLICY teams_read_hub_floater ON public.teams
  FOR SELECT TO authenticated
  USING (public.jwt_role() IN ('hub', 'floater') AND public.is_active_session());

CREATE POLICY teams_write_hub ON public.teams
  FOR ALL TO authenticated
  USING (public.jwt_role() = 'hub' AND public.is_active_session())
  WITH CHECK (public.jwt_role() = 'hub' AND public.is_active_session());

CREATE POLICY attempts_host_select ON public.attempts
  FOR SELECT TO authenticated
  USING (
    public.jwt_role() LIKE 'station_%'
    AND station_id = public.jwt_station_id()
    AND public.is_active_session()
  );

CREATE POLICY attempts_host_insert ON public.attempts
  FOR INSERT TO authenticated
  WITH CHECK (
    public.jwt_role() LIKE 'station_%'
    AND station_id = public.jwt_station_id()
    AND session_id = public.jwt_session_id()
    AND public.is_active_session()
  );

CREATE POLICY attempts_host_update ON public.attempts
  FOR UPDATE TO authenticated
  USING (
    public.jwt_role() LIKE 'station_%'
    AND station_id = public.jwt_station_id()
    AND public.is_active_session()
    AND NOT voided
  )
  WITH CHECK (
    public.jwt_role() LIKE 'station_%'
    AND station_id = public.jwt_station_id()
    AND session_id = public.jwt_session_id()
    AND public.is_active_session()
  );

CREATE POLICY attempts_read_hub_floater ON public.attempts
  FOR SELECT TO authenticated
  USING (public.jwt_role() IN ('hub', 'floater') AND public.is_active_session());

CREATE POLICY resets_host_all ON public.station_resets
  FOR ALL TO authenticated
  USING (
    public.jwt_role() LIKE 'station_%'
    AND station_id = public.jwt_station_id()
    AND public.is_active_session()
  )
  WITH CHECK (
    public.jwt_role() LIKE 'station_%'
    AND station_id = public.jwt_station_id()
    AND session_id = public.jwt_session_id()
    AND public.is_active_session()
  );

CREATE POLICY resets_read_hub_floater ON public.station_resets
  FOR SELECT TO authenticated
  USING (public.jwt_role() IN ('hub', 'floater') AND public.is_active_session());

CREATE POLICY audit_log_read_hub_floater ON public.audit_log
  FOR SELECT TO authenticated
  USING (public.jwt_role() IN ('hub', 'floater') AND public.is_active_session());

CREATE POLICY snapshots_read_hub_floater ON public.final_snapshots
  FOR SELECT TO authenticated
  USING (public.jwt_role() IN ('hub', 'floater') AND public.is_active_session());

CREATE POLICY snapshots_insert_hub ON public.final_snapshots
  FOR INSERT TO authenticated
  WITH CHECK (public.jwt_role() = 'hub' AND public.is_active_session());

-- 7. SEED STATION CONFIGS

INSERT INTO public.stations (id, config) VALUES
(1, '{
  "id": 1,
  "name": "A-Frame Walker",
  "widget": "stopwatch_progress",
  "cap_s": 120,
  "rank": "time_then_progress",
  "bonus_on_dnf": true,
  "progress": {"kind": "taps", "unit": "m", "values": [0,1,2,3,4,5,6,7,8]},
  "helpers": [{"id": "foot_down", "type": "hold_overlay", "hold_s": 3}],
  "reset": {"target_s": 60, "checklist": ["Frame upright on start line", "Ropes untangled"]},
  "rule": "Rider''s feet stay off the ground. Two teammates steer with ropes across 8 m.",
  "bonus": {"q": "How did the friends get the paralyzed man to Jesus in Mark 2?", "a": "Through the roof (Mark 2:4)"}
}'::jsonb),
(2, '{
  "id": 2,
  "name": "Leaking Pipe",
  "widget": "stopwatch_progress",
  "cap_s": 120,
  "rank": "time_then_progress",
  "bonus_on_dnf": true,
  "progress": {"kind": "stepper", "unit": "cm", "min": 0, "max": 150, "step": 5},
  "helpers": [],
  "reset": {"target_s": 90, "checklist": ["Tub filled to line", "Pipe drained, ball at bottom"]},
  "rule": "Bare hands only to plug holes. Stop when the ball exits the top.",
  "bonus": {"q": "What reason did Jeremiah give when first called?", "a": "He was too young (Jer 1:6)"}
}'::jsonb),
(3, '{
  "id": 3,
  "name": "Half-Pipe Aqueduct",
  "widget": "stopwatch_progress",
  "cap_s": 120,
  "rank": "time_then_progress",
  "bonus_on_dnf": true,
  "progress": {"kind": "taps", "unit": "m", "values": [0,1,2,3,4,5,6,7,8,9,10]},
  "helpers": [{"id": "ball_dropped", "type": "counter"}],
  "reset": {"target_s": 60, "checklist": ["Ball at start cone", "Cones and half-pipes in place"]},
  "rule": "No hands on the ball. Ball on the ground restarts from the last cone.",
  "bonus": {"q": "Which empire invaded Judah in Hezekiah''s reign?", "a": "Assyria (2 Chr 32:1)"}
}'::jsonb),
(4, '{
  "id": 4,
  "name": "Swiss-Cheese Wall",
  "widget": "stopwatch_progress",
  "cap_s": 120,
  "rank": "time_then_progress",
  "bonus_on_dnf": true,
  "progress": {"kind": "taps", "unit": "line", "values": [0,1,2,3,4]},
  "helpers": [{"id": "marble_dropped", "type": "counter"}],
  "reset": {"target_s": 60, "checklist": ["Ring at bottom", "Marble in ring, strings untangled"]},
  "rule": "Steer the ring to the top hole. A marble drop resets the ring to the bottom.",
  "bonus": {"q": "Who restored Saul''s sight in Damascus?", "a": "Ananias (Acts 9:17)"}
}'::jsonb),
(5, '{
  "id": 5,
  "name": "Water Chain",
  "widget": "stopwatch_progress",
  "cap_s": 120,
  "rank": "time_then_progress",
  "bonus_on_dnf": true,
  "progress": {"kind": "taps", "unit": "ml", "values": [0,250,500,750,1000,1250,1500,1750,2000,2250,2500,2750,3000]},
  "helpers": [],
  "reset": {"target_s": 90, "checklist": ["Jug filled", "Buckets in position"]},
  "rule": "Nobody turns around. Reach the fill line.",
  "bonus": {"q": "How many stone water jars were at the wedding in John 2?", "a": "Six (John 2:6)"}
}'::jsonb),
(6, '{
  "id": 6,
  "name": "Ricochet Planks",
  "widget": "counter_countdown",
  "cap_s": 120,
  "rank": "count",
  "bonus_on_dnf": true,
  "helpers": [],
  "reset": {"target_s": 60, "checklist": ["Ball at start", "Boards on marks, bucket upright"]},
  "rule": "The ball must touch both boards before entering the bucket.",
  "bonus": null
}'::jsonb),
(7, '{
  "id": 7,
  "name": "Balance Scale",
  "widget": "hover_hold",
  "cap_s": 150,
  "rank": "time_then_progress",
  "dnf_zero": true,
  "bonus_on_dnf": true,
  "hover": {"hold_s": 5},
  "helpers": [{"id": "ground_touch", "type": "hover_reset"}],
  "reset": {"target_s": 60, "checklist": ["Plank level, nothing on it", "Hidden weight matches variant"]},
  "rule": "Hands off during the 5-second hover. Neither end touches the ground. Hover must finish before time is up.",
  "bonus": {"q": "Name the Babylonian king in Daniel 5.", "a": "Belshazzar (Dan 5:1)"}
}'::jsonb);

ALTER PUBLICATION supabase_realtime ADD TABLE
  public.attempts,
  public.station_resets,
  public.teams,
  public.event_settings,
  public.role_sessions;
