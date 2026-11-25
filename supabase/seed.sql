-- Realistic Dev/Test Seed: 9 Role Credentials, 30 Teams, Attempts, Resets

INSERT INTO public.role_credentials (role, station_id, secret_token, pin_code) VALUES
  ('station_1', 1, 'sec-st1-dev-0001', '100101'),
  ('station_2', 2, 'sec-st2-dev-0002', '100202'),
  ('station_3', 3, 'sec-st3-dev-0003', '100303'),
  ('station_4', 4, 'sec-st4-dev-0004', '100404'),
  ('station_5', 5, 'sec-st5-dev-0005', '100505'),
  ('station_6', 6, 'sec-st6-dev-0006', '100606'),
  ('station_7', 7, 'sec-st7-dev-0007', '100707'),
  ('hub',       NULL, 'sec-hub-dev-9999', '999999'),
  ('floater',   NULL, 'sec-flt-dev-8888', '888888')
ON CONFLICT (role) DO NOTHING;

UPDATE public.event_settings
SET variant_labels = ARRAY['W1', 'W2']::text[],
    current_variant = 'W2'
WHERE id = 1;

DO $$
DECLARE
  v_sess uuid[];
  v_team_ids uuid[];
  v_church_names text[] := ARRAY[
    'St. Thomas CSI', 'Grace Fellowship', 'Bethel AG', 'New Life Church',
    'Trinity Methodist', 'Emmanuel Baptist', 'Zion Mar Thoma', 'Christ Church'
  ];
  v_token text;
  v_tid uuid;
  v_aid uuid;
  v_base timestamptz := now() - interval '60 minutes';
  i int;
  s int;
  v_completed bool;
  v_time_ms int;
  v_progress numeric;
  v_bonus bool;
  v_variant text;
BEGIN
  v_sess := ARRAY[]::uuid[];
  FOR s IN 1..7 LOOP
    INSERT INTO public.role_sessions (role, station_id)
    VALUES ('station_' || s, s)
    RETURNING session_id INTO v_tid;
    v_sess := array_append(v_sess, v_tid);
  END LOOP;

  v_team_ids := ARRAY[]::uuid[];
  FOR i IN 1..30 LOOP
    v_token := upper(substr(md5('team-token-2027-' || i::text), 1, 8));
    INSERT INTO public.teams (
      number, church, team_name, token,
      checked_in_at, started_at, finished_at, duel_won, withdrawn
    ) VALUES (
      i,
      v_church_names[((i - 1) % array_length(v_church_names, 1)) + 1],
      CASE WHEN i % 3 = 0 THEN 'Squad ' || i ELSE NULL END,
      v_token,
      v_base - interval '15 minutes',
      v_base + make_interval(mins => (i - 1) / 7 * 12),
      CASE
        WHEN i IN (29, 30) THEN NULL
        ELSE v_base + make_interval(mins => (i - 1) / 7 * 12 + 18 + (i % 5), secs => (i * 17) % 60)
      END,
      (i = 1),
      (i = 30)
    )
    RETURNING id INTO v_tid;
    v_team_ids := array_append(v_team_ids, v_tid);
  END LOOP;

  FOR i IN 1..30 LOOP
    FOR s IN 1..7 LOOP
      IF i = 30 AND s > 2 THEN
        CONTINUE;
      END IF;

      v_aid := gen_random_uuid();
      v_variant := CASE WHEN s = 7 THEN (CASE WHEN i <= 15 THEN 'W1' ELSE 'W2' END) ELSE NULL END;

      IF s = 6 THEN
        v_completed := true;
        v_time_ms := 120000;
        v_progress := CASE
          WHEN i IN (1, 2) THEN 6
          WHEN i IN (3, 4, 5) THEN 5
          ELSE (i % 5) + 1
        END;
        v_bonus := NULL;
      ELSIF s = 7 THEN
        v_completed := (i % 5 <> 0);
        v_time_ms := CASE WHEN v_completed THEN 45000 + ((i * 3100) % 95000) ELSE 150000 END;
        v_progress := NULL;
        v_bonus := (i % 2 = 1);
      ELSE
        v_completed := ((i + s) % 6 <> 0);
        IF s = 1 AND i IN (1, 2) THEN
          v_completed := true;
          v_time_ms := 62000;
          v_progress := 8;
        ELSIF v_completed THEN
          v_time_ms := 40000 + (((i * 7 + s * 13) * 1000) % 75000);
          v_progress := NULL;
        ELSE
          v_time_ms := 120000;
          v_progress := CASE s
            WHEN 1 THEN (i % 7) + 1
            WHEN 2 THEN ((i % 10) + 1) * 15
            WHEN 3 THEN (i % 9) + 1
            WHEN 4 THEN (i % 3) + 1
            WHEN 5 THEN ((i % 10) + 1) * 250
          END;
        END IF;
        v_bonus := ((i + s) % 3 <> 0);
      END IF;

      INSERT INTO public.attempts (
        id, team_id, station_id, state,
        arrived_at, started_at, ended_at, scored_at,
        completed, time_ms, progress, counters,
        bonus_correct, variant, practice, voided, version, session_id
      ) VALUES (
        v_aid,
        v_team_ids[i],
        s,
        'scored',
        v_base + make_interval(mins => (s - 1) * 3),
        v_base + make_interval(mins => (s - 1) * 3, secs => 15),
        v_base + make_interval(mins => (s - 1) * 3, secs => 15 + (v_time_ms / 1000)),
        v_base + make_interval(mins => (s - 1) * 3, secs => 25 + (v_time_ms / 1000)),
        v_completed,
        v_time_ms,
        v_progress,
        CASE WHEN s IN (3, 4) THEN jsonb_build_object('drops', i % 3) ELSE '{}'::jsonb END,
        v_bonus,
        v_variant,
        false,
        false,
        1,
        v_sess[s]
      );

      INSERT INTO public.station_resets (
        id, station_id, after_attempt_id, started_at, done_at, items_done, skipped, session_id
      ) VALUES (
        gen_random_uuid(),
        s,
        v_aid,
        v_base + make_interval(mins => (s - 1) * 3, secs => 25 + (v_time_ms / 1000)),
        CASE WHEN (i + s) % 7 = 0 THEN NULL ELSE v_base + make_interval(mins => (s - 1) * 3, secs => 65 + (v_time_ms / 1000)) END,
        CASE WHEN (i + s) % 7 = 0 THEN 1 ELSE 2 END,
        ((i + s) % 7 = 0),
        v_sess[s]
      );
    END LOOP;
  END LOOP;

  INSERT INTO public.attempts (
    id, team_id, station_id, state, arrived_at, started_at, ended_at, scored_at,
    completed, time_ms, progress, bonus_correct, practice, voided, session_id
  ) VALUES
    (gen_random_uuid(), v_team_ids[1], 1, 'scored', v_base, v_base, v_base + interval '10 seconds', v_base + interval '12 seconds', true, 10000, 8, true, false, true, v_sess[1]),
    (gen_random_uuid(), v_team_ids[2], 1, 'scored', v_base, v_base, v_base + interval '15 seconds', v_base + interval '17 seconds', true, 15000, 8, true, true, false, v_sess[1]);
END $$;
