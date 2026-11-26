import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Stage 3 (P1 Essential Features) Apply Script
 * Save as D:\Programming\app\apply-stage3.mjs and run:
 *   node apply-stage3.mjs
 *
 * Implements:
 *  - P1 #5: Complete Hub Admin UI (attempt completed/progress edit, team withdraw/reinstate
 *           with reason, duel_won toggle, Station 7 variant_labels + max_teams + walk_time_s,
 *           and in-UI confirmation modal for Role Regenerate)
 *  - P1 #6: Mobile/Tablet navigation for all 8 Hub tabs + Sign out via "More" sheet
 *  - P1 #7: Offline-safe Host Undo (local outbox cancel when unsynced) & non-retriable
 *           outbox conflict classification + dismissible host banner + unit tests
 *  - P1 #8: Off-route inbound calculation fix in computeOpsBoard() and get_station_inbound()
 */

const rootDir = process.cwd();

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.replace(/^\n/, ""), "utf8");
  console.log("  wrote " + relativePath);
}

function runCommand(cmd) {
  console.log("\n> " + cmd);
  execSync(cmd, { stdio: "inherit", shell: true });
}

// Update package.json test script to include offline outbox unit tests
const pkgPath = path.join(rootDir, "package.json");
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.scripts = {
    ...pkg.scripts,
    test: "vitest run src/lib/scoring src/lib/timer src/lib/reset src/lib/ops src/lib/offline"
  };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log("  updated package.json test script");
}

const files = {
  "supabase/migrations/20261127000002_fix_inbound_offroute.sql": `
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
`,

  "src/lib/offline/db.ts": `
import Dexie, { type Table } from "dexie";
import type { AttemptRow, StationConfig, TeamPublic } from "@/lib/types/domain";

export interface OutboxItem {
  id: string;
  table: "attempts" | "station_resets";
  payload: Record<string, unknown>;
  status: "queued" | "syncing" | "synced" | "failed" | "conflict";
  attempts: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
}

export interface MetaItem {
  key: string;
  value: unknown;
}

class OpsOfflineDb extends Dexie {
  teams!: Table<TeamPublic, string>;
  stations!: Table<StationConfig, number>;
  outbox!: Table<OutboxItem, string>;
  local_attempts!: Table<AttemptRow, string>;
  meta!: Table<MetaItem, string>;

  constructor() {
    super("th2027_ops_db");
    this.version(1).stores({
      teams: "id, number, token",
      stations: "id",
      outbox: "id, table, status, next_retry_at, created_at",
      local_attempts: "id, [team_id+station_id], station_id, state",
      meta: "key"
    });
  }
}

export const offlineDb = new OpsOfflineDb();
`,

  "src/lib/offline/outbox.ts": `
import { getSupabaseClient } from "@/lib/supabase/client";
import type { AttemptRow, RoleSession, StationConfig, TeamPublic } from "@/lib/types/domain";
import { offlineDb, type OutboxItem } from "./db";

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export function nextBackoffMs(retryCount: number): number {
  const idx = Math.min(retryCount, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx] ?? 30000;
}

/**
 * Classifies permanent Postgres / PostgREST constraint or permission failures so
 * they stop retrying indefinitely and surface as a visible conflict instead.
 */
export function isNonRetriableError(error: {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}): boolean {
  const code = String(error.code ?? "");
  const msg = String(error.message ?? "");
  const status = error.status ?? 0;

  if (
    code === "23505" || // unique_violation (e.g. uq_attempts_live_team_station)
    code === "23503" || // foreign_key_violation
    code === "23514" || // check_violation
    code === "P0001" || // raise_exception (e.g. PRACTICE_FORBIDDEN_IN_LIVE_MODE)
    code === "42501" // insufficient_privilege / RLS
  ) {
    return true;
  }

  if (
    msg.includes("uq_attempts_live_team_station") ||
    msg.includes("PRACTICE_FORBIDDEN_IN_LIVE_MODE") ||
    msg.includes("row-level security")
  ) {
    return true;
  }

  if (status === 400 || status === 401 || status === 403 || status === 409) {
    return true;
  }

  return false;
}

export async function cacheTeams(teams: TeamPublic[]): Promise<void> {
  await offlineDb.transaction("rw", offlineDb.teams, async () => {
    await offlineDb.teams.clear();
    await offlineDb.teams.bulkPut(teams);
  });
}

export async function cacheStations(stations: StationConfig[]): Promise<void> {
  await offlineDb.stations.bulkPut(stations);
}

export async function enqueueWrite(
  table: "attempts" | "station_resets",
  id: string,
  payload: Record<string, unknown>
): Promise<void> {
  const item: OutboxItem = {
    id,
    table,
    payload,
    status: "queued",
    attempts: 0,
    next_retry_at: Date.now(),
    last_error: null,
    created_at: Date.now()
  };
  await offlineDb.outbox.put(item);

  if (table === "attempts") {
    await offlineDb.local_attempts.put(payload as unknown as AttemptRow);
  }
}

export async function getConflictItems(): Promise<OutboxItem[]> {
  return await offlineDb.outbox.where("status").equals("conflict").toArray();
}

export async function dismissConflict(id: string): Promise<void> {
  const item = await offlineDb.outbox.get(id);
  await offlineDb.outbox.delete(id);
  if (item?.table === "attempts") {
    await offlineDb.local_attempts.delete(id);
  }
}

export async function flushOutbox(session: RoleSession): Promise<{
  syncedCount: number;
  pendingCount: number;
  conflictCount: number;
}> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const pending = await offlineDb.outbox.where("status").anyOf("queued", "failed", "syncing").count();
    const conflictCount = await offlineDb.outbox.where("status").equals("conflict").count();
    return { syncedCount: 0, pendingCount: pending, conflictCount };
  }

  const supabase = getSupabaseClient(session);
  const now = Date.now();
  const due = await offlineDb.outbox
    .where("status")
    .anyOf("queued", "failed")
    .filter((item) => item.next_retry_at <= now)
    .sortBy("created_at");

  let syncedCount = 0;

  for (const item of due) {
    await offlineDb.outbox.update(item.id, { status: "syncing" });
    const { error, status } = await supabase
      .from(item.table)
      .upsert(item.payload, { onConflict: "id" });

    if (!error) {
      await offlineDb.outbox.update(item.id, {
        status: "synced",
        last_error: null
      });
      syncedCount += 1;
    } else if (isNonRetriableError({ code: error.code, message: error.message, status })) {
      await offlineDb.outbox.update(item.id, {
        status: "conflict",
        last_error: error.message
      });
    } else {
      const nextRetry = item.attempts + 1;
      await offlineDb.outbox.update(item.id, {
        status: "failed",
        attempts: nextRetry,
        next_retry_at: Date.now() + nextBackoffMs(nextRetry),
        last_error: error.message
      });
    }
  }

  const pendingCount = await offlineDb.outbox.where("status").anyOf("queued", "failed", "syncing").count();
  const conflictCount = await offlineDb.outbox.where("status").equals("conflict").count();
  return { syncedCount, pendingCount, conflictCount };
}
`,

  "src/lib/offline/outbox.test.ts": `
import { describe, expect, it } from "vitest";
import { isNonRetriableError, nextBackoffMs } from "./outbox";

describe("offline outbox backoff & conflict classification", () => {
  it("caps exponential backoff at 30 seconds", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(4)).toBe(16000);
    expect(nextBackoffMs(5)).toBe(30000);
    expect(nextBackoffMs(12)).toBe(30000);
  });

  it("classifies Postgres unique constraint, practice guard, and RLS errors as non-retriable", () => {
    expect(isNonRetriableError({ code: "23505", message: "duplicate key" })).toBe(true);
    expect(isNonRetriableError({ code: "P0001", message: "PRACTICE_FORBIDDEN_IN_LIVE_MODE" })).toBe(true);
    expect(isNonRetriableError({ code: "42501", message: "new row violates row-level security" })).toBe(true);
    expect(isNonRetriableError({ status: 409, message: "Conflict" })).toBe(true);
  });

  it("keeps transient network and 5xx errors retriable", () => {
    expect(isNonRetriableError({ status: 503, message: "Service Unavailable" })).toBe(false);
    expect(isNonRetriableError({ message: "Failed to fetch" })).toBe(false);
  });
});
`,

  "src/lib/ops/index.ts": `
import {
  deriveStationState,
  getExpectedNextStation,
  getRouteOrder,
  type ResetLogInput,
  type StationBoardState
} from "@/lib/reset";
import type { AttemptRow, StationConfig, TeamRow } from "@/lib/types/domain";

export interface InboundEntry {
  team_id: string;
  team_number: number;
  church: string;
  last_ended_at_ms: number;
  eta_ms: number;
}

export interface StationBoardCard {
  station_id: number;
  name: string;
  state: StationBoardState;
  active_team_number: number | null;
  in_play_elapsed_s: number | null;
  cap_s: number;
  reset_elapsed_s: number | null;
  reset_target_s: number;
  ready_since_ms: number | null;
  inbound: InboundEntry[];
  safe_to_launch: boolean;
}

export type AlertCode =
  | "ready_with_inbound_over_120s"
  | "reset_over_target_with_inbound"
  | "wrong_station_scan"
  | "team_overdue_240s"
  | "attempt_over_cap_10s"
  | "missing_finish";

export interface OpsAlert {
  id: string;
  code: AlertCode;
  severity: "warning" | "danger";
  station_id: number | null;
  team_number: number | null;
  label: string;
  detail: string;
}

export interface DispatchRouteCard {
  route: number;
  route_letter: string;
  first_station_id: number;
  first_station_state: StationBoardState;
  safe_to_launch: boolean;
  waiting_teams: TeamRow[];
  inbound_count: number;
}

export interface OpsBoardSnapshot {
  stations: StationBoardCard[];
  alerts: OpsAlert[];
  routes: DispatchRouteCard[];
  suggested_team: TeamRow | null;
}

export function computeOpsBoard(params: {
  stations: StationConfig[];
  teams: TeamRow[];
  attempts: AttemptRow[];
  resets: ResetLogInput[];
  activeStationIds: Set<number>;
  walkTimeS: number;
  nowMs: number;
}): OpsBoardSnapshot {
  const { stations, teams, attempts, resets, activeStationIds, walkTimeS, nowMs } = params;
  const liveAttempts = attempts.filter((a) => !a.voided && !a.practice);
  const activeTeams = teams.filter((tm) => !tm.withdrawn);
  const teamById = new Map(activeTeams.map((tm) => [tm.id, tm]));

  const inboundByStation = new Map<number, InboundEntry[]>();
  for (const st of stations) {
    inboundByStation.set(st.id, []);
  }

  const alerts: OpsAlert[] = [];

  for (const team of activeTeams) {
    const teamAtts = liveAttempts.filter((a) => a.team_id === team.id);
    const activeAtt = teamAtts.find((a) => a.state !== "scored");
    const scoredAtts = teamAtts
      .filter((a) => a.state === "scored")
      .sort(
        (a, b) =>
          Date.parse(a.ended_at ?? a.scored_at ?? a.arrived_at) -
          Date.parse(b.ended_at ?? b.scored_at ?? b.arrived_at)
      );

    if (scoredAtts.length >= stations.length && stations.length > 0 && team.finished_at === null) {
      alerts.push({
        id: "missing_finish_" + team.id,
        code: "missing_finish",
        severity: "warning",
        station_id: null,
        team_number: team.number,
        label: "Missing finish",
        detail: "Team #" + team.number + " completed all stations without Hub finish"
      });
    }

    const playedIds = scoredAtts.map((a) => a.station_id);
    const expectedNext = getExpectedNextStation(team.route, playedIds);

    if (activeAtt) {
      if (expectedNext !== null && activeAtt.station_id !== expectedNext) {
        alerts.push({
          id: "wrong_station_" + activeAtt.id,
          code: "wrong_station_scan",
          severity: "warning",
          station_id: activeAtt.station_id,
          team_number: team.number,
          label: "Off-route scan",
          detail:
            "Team #" +
            team.number +
            " at Stn " +
            activeAtt.station_id +
            " (expected Stn " +
            expectedNext +
            ")"
        });
      }
      continue;
    }

    if (team.finished_at !== null || scoredAtts.length === 0 || expectedNext === null) {
      continue;
    }

    const lastScored = scoredAtts[scoredAtts.length - 1]!;
    const lastEndedMs = Date.parse(lastScored.ended_at ?? lastScored.scored_at ?? lastScored.arrived_at);
    if (Number.isNaN(lastEndedMs)) continue;

    // P1 #8: Use route-based next unplayed station so off-route redirected teams stay tracked
    const nextStationId = expectedNext;
    const etaMs = lastEndedMs + walkTimeS * 1000;
    const bucket = inboundByStation.get(nextStationId);
    if (bucket) {
      bucket.push({
        team_id: team.id,
        team_number: team.number,
        church: team.church,
        last_ended_at_ms: lastEndedMs,
        eta_ms: etaMs
      });
    }

    if (nowMs - lastEndedMs > 240_000) {
      alerts.push({
        id: "overdue_" + team.id,
        code: "team_overdue_240s",
        severity: "danger",
        station_id: nextStationId,
        team_number: team.number,
        label: "Team overdue",
        detail:
          "Team #" +
          team.number +
          " >240s since Stn " +
          lastScored.station_id +
          " (next Stn " +
          nextStationId +
          ")"
      });
    }
  }

  for (const list of inboundByStation.values()) {
    list.sort((a, b) => a.eta_ms - b.eta_ms);
  }

  const stationCards: StationBoardCard[] = stations.map((st) => {
    const stAtts = liveAttempts.filter((a) => a.station_id === st.id);
    const activeAtt = stAtts.find((a) => a.state !== "scored") ?? null;
    const scoredAtts = stAtts
      .filter((a) => a.state === "scored" && (a.ended_at || a.scored_at))
      .sort((a, b) => Date.parse(b.ended_at ?? b.scored_at!) - Date.parse(a.ended_at ?? a.scored_at!));
    const lastScoredMs = scoredAtts[0] ? Date.parse(scoredAtts[0].ended_at ?? scoredAtts[0].scored_at!) : null;

    const stResets = resets
      .filter((r) => r.station_id === st.id)
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    const lastReset = stResets[0] ?? null;
    const lastResetDoneMs = lastReset?.done_at ? Date.parse(lastReset.done_at) : null;
    const lastResetStartedMs = lastReset?.started_at ? Date.parse(lastReset.started_at) : null;

    const state = deriveStationState({
      hasActiveSession: activeStationIds.has(st.id),
      hasInPlayAttempt: activeAtt !== null,
      lastScoredEndedAtMs: lastScoredMs,
      lastResetDoneAtMs: lastResetDoneMs,
      lastResetSkipped: lastReset?.skipped ?? false,
      lastResetStartedAtMs: lastResetStartedMs,
      targetResetS: st.reset.target_s,
      nowMs
    });

    const inbound = inboundByStation.get(st.id) ?? [];

    let inPlayElapsedS: number | null = null;
    if (activeAtt && activeAtt.started_at) {
      inPlayElapsedS = Math.max(0, Math.floor((nowMs - Date.parse(activeAtt.started_at)) / 1000));
      if (activeAtt.state === "started" && inPlayElapsedS > st.cap_s + 10) {
        const tm = teamById.get(activeAtt.team_id);
        alerts.push({
          id: "overcap_" + activeAtt.id,
          code: "attempt_over_cap_10s",
          severity: "danger",
          station_id: st.id,
          team_number: tm?.number ?? null,
          label: "Over cap +10s",
          detail: "Stn " + st.id + " at " + inPlayElapsedS + "s (cap " + st.cap_s + "s)"
        });
      }
    }

    let resetElapsedS: number | null = null;
    const resetPending =
      lastScoredMs !== null &&
      !(lastResetDoneMs !== null && lastResetDoneMs >= lastScoredMs) &&
      !(lastReset?.skipped && lastResetStartedMs !== null && lastResetStartedMs >= lastScoredMs);

    if (!activeAtt && lastScoredMs !== null && resetPending) {
      resetElapsedS = Math.max(0, Math.floor((nowMs - lastScoredMs) / 1000));
      if (resetElapsedS > st.reset.target_s && inbound.length > 0) {
        alerts.push({
          id: "reset_over_" + st.id,
          code: "reset_over_target_with_inbound",
          severity: "warning",
          station_id: st.id,
          team_number: inbound[0]!.team_number,
          label: "Reset over target",
          detail:
            "Stn " +
            st.id +
            " resetting " +
            resetElapsedS +
            "s/" +
            st.reset.target_s +
            "s with Team #" +
            inbound[0]!.team_number +
            " inbound"
        });
      }
    }

    let readySinceMs: number | null = null;
    if (state === "ready") {
      if (lastResetDoneMs !== null && lastScoredMs !== null && lastResetDoneMs >= lastScoredMs) {
        readySinceMs = lastResetDoneMs;
      } else if (lastScoredMs !== null) {
        readySinceMs = lastScoredMs + st.reset.target_s * 1000;
      }
      if (readySinceMs !== null && inbound.length > 0 && nowMs - readySinceMs > 120_000) {
        alerts.push({
          id: "ready_idle_" + st.id,
          code: "ready_with_inbound_over_120s",
          severity: "warning",
          station_id: st.id,
          team_number: inbound[0]!.team_number,
          label: "Station waiting",
          detail: "Stn " + st.id + " ready >120s with Team #" + inbound[0]!.team_number + " inbound"
        });
      }
    }

    const hasInboundWithinEta = inbound.some((inb) => inb.eta_ms <= nowMs + walkTimeS * 1000);
    const safeToLaunch = state === "ready" && !resetPending && !hasInboundWithinEta;

    const activeTeam = activeAtt ? teamById.get(activeAtt.team_id) : null;

    return {
      station_id: st.id,
      name: st.name,
      state,
      active_team_number: activeTeam?.number ?? null,
      in_play_elapsed_s: inPlayElapsedS,
      cap_s: st.cap_s,
      reset_elapsed_s: resetElapsedS,
      reset_target_s: st.reset.target_s,
      ready_since_ms: readySinceMs,
      inbound,
      safe_to_launch: safeToLaunch
    };
  });

  const cardByStation = new Map(stationCards.map((c) => [c.station_id, c]));

  const routes: DispatchRouteCard[] = Array.from({ length: 7 }, (_, route) => {
    const firstStationId = getRouteOrder(route)[0]!;
    const card = cardByStation.get(firstStationId);
    const waiting = activeTeams
      .filter((tm) => tm.route === route && tm.checked_in_at !== null && tm.started_at === null)
      .sort((a, b) => a.number - b.number);

    return {
      route,
      route_letter: String.fromCharCode(65 + route),
      first_station_id: firstStationId,
      first_station_state: card?.state ?? "offline",
      safe_to_launch: card?.safe_to_launch ?? false,
      waiting_teams: waiting,
      inbound_count: card?.inbound.length ?? 0
    };
  });

  const safeWaiting = routes
    .filter((r) => r.safe_to_launch && r.waiting_teams.length > 0)
    .map((r) => r.waiting_teams[0]!)
    .sort((a, b) => a.number - b.number);

  return {
    stations: stationCards,
    alerts,
    routes,
    suggested_team: safeWaiting[0] ?? null
  };
}
`,

  "src/lib/ops/ops.test.ts": `
import { describe, expect, it } from "vitest";
import { computeOpsBoard } from "./index";
import type { AttemptRow, StationConfig, TeamRow } from "@/lib/types/domain";

const STATIONS: StationConfig[] = Array.from({ length: 7 }, (_, idx) => ({
  id: idx + 1,
  name: "Station " + (idx + 1),
  widget: "stopwatch_progress",
  cap_s: 120,
  rank: "time_then_progress",
  helpers: [],
  reset: { target_s: 60, checklist: ["Item 1"] },
  rule: "Rule",
  bonus: null
}));

function makeTeam(num: number, overrides: Partial<TeamRow> = {}): TeamRow {
  return {
    id: "t-" + num,
    number: num,
    church: "Church " + num,
    team_name: null,
    token: "TOK0000" + num,
    route: (num - 1) % 7,
    checked_in_at: "2027-01-10T09:00:00Z",
    started_at: null,
    finished_at: null,
    duel_won: false,
    withdrawn: false,
    created_at: "2027-01-10T08:50:00Z",
    ...overrides
  };
}

describe("computeOpsBoard (alerts, off-route inbound & continuous dispatch)", () => {
  it("flags attempt_over_cap_10s, team_overdue_240s, wrong_station_scan, and reset_over_target_with_inbound", () => {
    const nowMs = Date.parse("2027-01-10T10:00:00Z");
    const teams = [
      makeTeam(1, { started_at: "2027-01-10T09:50:00Z" }),
      makeTeam(2, { started_at: "2027-01-10T09:50:00Z" }),
      makeTeam(3, { started_at: "2027-01-10T09:50:00Z" })
    ];

    const attempts: AttemptRow[] = [
      {
        id: "a1",
        team_id: "t-1",
        station_id: 1,
        state: "started",
        arrived_at: new Date(nowMs - 150_000).toISOString(),
        started_at: new Date(nowMs - 140_000).toISOString(),
        ended_at: null,
        scored_at: null,
        completed: null,
        time_ms: null,
        progress: null,
        counters: {},
        bonus_correct: null,
        variant: null,
        practice: false,
        voided: false,
        version: 1,
        session_id: "s1"
      },
      {
        id: "a2",
        team_id: "t-2",
        station_id: 2,
        state: "scored",
        arrived_at: new Date(nowMs - 400_000).toISOString(),
        started_at: new Date(nowMs - 360_000).toISOString(),
        ended_at: new Date(nowMs - 300_000).toISOString(),
        scored_at: new Date(nowMs - 300_000).toISOString(),
        completed: true,
        time_ms: 60000,
        progress: null,
        counters: {},
        bonus_correct: null,
        variant: null,
        practice: false,
        voided: false,
        version: 1,
        session_id: "s2"
      },
      {
        id: "a3",
        team_id: "t-3",
        station_id: 5,
        state: "arrived",
        arrived_at: new Date(nowMs - 10_000).toISOString(),
        started_at: null,
        ended_at: null,
        scored_at: null,
        completed: null,
        time_ms: null,
        progress: null,
        counters: {},
        bonus_correct: null,
        variant: null,
        practice: false,
        voided: false,
        version: 1,
        session_id: "s5"
      },
      {
        id: "a4",
        team_id: "t-1",
        station_id: 3,
        state: "scored",
        arrived_at: new Date(nowMs - 200_000).toISOString(),
        started_at: new Date(nowMs - 150_000).toISOString(),
        ended_at: new Date(nowMs - 90_000).toISOString(),
        scored_at: new Date(nowMs - 90_000).toISOString(),
        completed: true,
        time_ms: 60000,
        progress: null,
        counters: {},
        bonus_correct: null,
        variant: null,
        practice: false,
        voided: false,
        version: 1,
        session_id: "s3"
      }
    ];

    const snap = computeOpsBoard({
      stations: STATIONS,
      teams,
      attempts,
      resets: [],
      activeStationIds: new Set([1, 2, 3, 4, 5, 6, 7]),
      walkTimeS: 30,
      nowMs
    });

    const codes = new Set(snap.alerts.map((a) => a.code));
    expect(codes.has("attempt_over_cap_10s")).toBe(true);
    expect(codes.has("team_overdue_240s")).toBe(true);
    expect(codes.has("wrong_station_scan")).toBe(true);
    expect(codes.has("reset_over_target_with_inbound")).toBe(true);
  });

  it("tracks off-route redirected teams as inbound to their next unplayed route station", () => {
    const nowMs = Date.parse("2027-01-10T10:00:00Z");
    // Team 1 has route 0 -> order [1, 2, 3, 4, 5, 6, 7].
    // Played Stn 1, then Floater redirected them to Stn 3 (skipping Stn 2).
    // Next expected unplayed station must be Stn 2.
    const teams = [makeTeam(1, { started_at: "2027-01-10T09:50:00Z" })];
    const attempts: AttemptRow[] = [
      {
        id: "a1",
        team_id: "t-1",
        station_id: 1,
        state: "scored",
        arrived_at: new Date(nowMs - 180_000).toISOString(),
        started_at: new Date(nowMs - 170_000).toISOString(),
        ended_at: new Date(nowMs - 120_000).toISOString(),
        scored_at: new Date(nowMs - 120_000).toISOString(),
        completed: true,
        time_ms: 50000,
        progress: null,
        counters: {},
        bonus_correct: null,
        variant: null,
        practice: false,
        voided: false,
        version: 1,
        session_id: "s1"
      },
      {
        id: "a2",
        team_id: "t-1",
        station_id: 3,
        state: "scored",
        arrived_at: new Date(nowMs - 90_000).toISOString(),
        started_at: new Date(nowMs - 80_000).toISOString(),
        ended_at: new Date(nowMs - 20_000).toISOString(),
        scored_at: new Date(nowMs - 20_000).toISOString(),
        completed: true,
        time_ms: 60000,
        progress: null,
        counters: {},
        bonus_correct: null,
        variant: null,
        practice: false,
        voided: false,
        version: 1,
        session_id: "s3"
      }
    ];

    const snap = computeOpsBoard({
      stations: STATIONS,
      teams,
      attempts,
      resets: [],
      activeStationIds: new Set([1, 2, 3, 4, 5, 6, 7]),
      walkTimeS: 30,
      nowMs
    });

    const stn2 = snap.stations.find((s) => s.station_id === 2)!;
    expect(stn2.inbound.map((i) => i.team_number)).toEqual([1]);
  });

  it("suggests the next safe-to-launch team and blocks launch when station is busy", () => {
    const nowMs = Date.parse("2027-01-10T10:00:00Z");
    const teams = [makeTeam(1), makeTeam(2)];
    const snap = computeOpsBoard({
      stations: STATIONS,
      teams,
      attempts: [],
      resets: [],
      activeStationIds: new Set([2]),
      walkTimeS: 30,
      nowMs
    });

    expect(snap.routes[0]?.safe_to_launch).toBe(false);
    expect(snap.routes[1]?.safe_to_launch).toBe(true);
    expect(snap.suggested_team?.number).toBe(2);
  });
});
`,

  "src/components/host/HostApp.tsx": `
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  Check,
  CloudOff,
  LogOut,
  Play,
  Square,
  Wifi,
  X
} from "lucide-react";
import { clearSession, loadSession } from "@/lib/auth/session";
import { t } from "@/lib/i18n";
import { offlineDb, type OutboxItem } from "@/lib/offline/db";
import {
  cacheStations,
  cacheTeams,
  dismissConflict,
  enqueueWrite,
  flushOutbox,
  getConflictItems
} from "@/lib/offline/outbox";
import { getRouteOrder } from "@/lib/reset";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  computeElapsedMs,
  formatClockSeconds,
  formatDurationMs,
  serverAdjustedNow,
  syncServerClock
} from "@/lib/timer/clock";
import { WakeLockController } from "@/lib/timer/wakeLock";
import type {
  AttemptRow,
  EventSettingsRow,
  RoleSession,
  StationConfig,
  TeamPublic
} from "@/lib/types/domain";
import { QrScanner } from "@/components/qr/QrScanner";
import { ResetPanel, type InboundTeamInfo } from "@/components/host/ResetPanel";

type HostPhase = "scan" | "ready" | "running" | "result" | "bonus" | "review" | "reset";

const ACTIVE_RUN_META_KEY = "active_host_run";

interface ActiveHostRunSnapshot {
  station_id: number;
  session_id: string;
  phase: Exclude<HostPhase, "scan" | "reset">;
  selectedTeam: TeamPublic;
  attemptId: string;
  arrivedAtIso: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  elapsedMs: number;
  completed: boolean;
  progress: number | null;
  countValue: number;
  counters: Record<string, number>;
  bonusCorrect: boolean | null;
  stampedVariant: string | null;
  practiceMode: boolean;
  wrongStationWarn: boolean;
}

function playBeep(freq = 880, durationMs = 140) {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      void ctx.close();
    }, durationMs);
  } catch {
    // Audio optional
  }
}

function vibrate(pattern: number | number[]) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    // Vibration unsupported on iOS
  }
}

export function HostApp() {
  const router = useRouter();
  const [session, setSession] = useState<RoleSession | null>(null);
  const [station, setStation] = useState<StationConfig | null>(null);
  const [settings, setSettings] = useState<EventSettingsRow | null>(null);
  const [teams, setTeams] = useState<TeamPublic[]>([]);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [online, setOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [conflicts, setConflicts] = useState<OutboxItem[]>([]);
  const [practiceMode, setPracticeMode] = useState(false);

  // Flow & QR scanner state
  const [phase, setPhase] = useState<HostPhase>("scan");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [teamInput, setTeamInput] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<TeamPublic | null>(null);
  const [wrongStationWarn, setWrongStationWarn] = useState(false);

  // Active attempt state
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [arrivedAtIso, setArrivedAtIso] = useState<string | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [endedAtMs, setEndedAtMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [countValue, setCountValue] = useState(0);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [bonusCorrect, setBonusCorrect] = useState<boolean | null>(null);
  const [stampedVariant, setStampedVariant] = useState<string | null>(null);

  // Widget overlays / hover state (timestamp-derived)
  const [holdEndsAtMs, setHoldEndsAtMs] = useState<number | null>(null);
  const [holdRemainingMs, setHoldRemainingMs] = useState(0);
  const [hoverStartedAtMs, setHoverStartedAtMs] = useState<number | null>(null);
  const [hoverRemainingMs, setHoverRemainingMs] = useState(0);
  const [capFlash, setCapFlash] = useState(false);

  // Reset Panel & Undo state
  const [lastSubmittedId, setLastSubmittedId] = useState<string | null>(null);
  const lastSubmittedIdRef = useRef<string | null>(null);
  const [undoDeadlineMs, setUndoDeadlineMs] = useState<number | null>(null);
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  const [lastAttemptSynced, setLastAttemptSynced] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetStartedAtMs, setResetStartedAtMs] = useState<number | null>(null);
  const [resetItemsDone, setResetItemsDone] = useState(0);
  const [inboundTeam, setInboundTeam] = useState<InboundTeamInfo | null>(null);

  const capFiredRef = useRef(false);
  const wakeLockRef = useRef<WakeLockController | null>(null);

  useEffect(() => {
    lastSubmittedIdRef.current = lastSubmittedId;
  }, [lastSubmittedId]);

  const refreshSyncCounters = useCallback(async (s: RoleSession) => {
    const res = await flushOutbox(s);
    setPendingCount(res.pendingCount);
    setConflicts(await getConflictItems());
    if (lastSubmittedIdRef.current) {
      const ob = await offlineDb.outbox.get(lastSubmittedIdRef.current);
      if (ob?.status === "synced") setLastAttemptSynced(true);
    }
  }, []);

  // Persist active run snapshot in Dexie for crash / accidental reload recovery
  useEffect(() => {
    if (!session || !station) return;
    if (
      (phase === "ready" ||
        phase === "running" ||
        phase === "result" ||
        phase === "bonus" ||
        phase === "review") &&
      selectedTeam &&
      attemptId
    ) {
      const snap: ActiveHostRunSnapshot = {
        station_id: station.id,
        session_id: session.session_id,
        phase,
        selectedTeam,
        attemptId,
        arrivedAtIso: arrivedAtIso ?? new Date(serverAdjustedNow(clockOffsetMs)).toISOString(),
        startedAtMs,
        endedAtMs,
        elapsedMs,
        completed,
        progress,
        countValue,
        counters,
        bonusCorrect,
        stampedVariant,
        practiceMode,
        wrongStationWarn
      };
      void offlineDb.meta.put({ key: ACTIVE_RUN_META_KEY, value: snap });
    } else if (phase === "scan" || phase === "reset") {
      void offlineDb.meta.delete(ACTIVE_RUN_META_KEY);
    }
  }, [
    session,
    station,
    phase,
    selectedTeam,
    attemptId,
    arrivedAtIso,
    startedAtMs,
    endedAtMs,
    elapsedMs,
    completed,
    progress,
    countValue,
    counters,
    bonusCorrect,
    stampedVariant,
    practiceMode,
    wrongStationWarn,
    clockOffsetMs
  ]);

  // Acquire Wake Lock during running phase
  useEffect(() => {
    if (!wakeLockRef.current) {
      wakeLockRef.current = new WakeLockController();
    }
    if (phase === "running") {
      void wakeLockRef.current.acquire();
    } else {
      void wakeLockRef.current.release();
    }
    return () => {
      void wakeLockRef.current?.release();
    };
  }, [phase]);

  // Load session, restore any interrupted attempt, & bootstrap caches (once on mount)
  useEffect(() => {
    const s = loadSession();
    if (!s || !s.station_id) {
      router.replace("/login");
      return;
    }
    setSession(s);
    setOnline(typeof navigator !== "undefined" ? navigator.onLine : true);
    void syncServerClock().then((off) => setClockOffsetMs(off));

    const supabase = getSupabaseClient(s);

    async function hydrate() {
      const cachedSt = await offlineDb.stations.get(s!.station_id!);
      if (cachedSt) setStation(cachedSt);
      const cachedTeams = await offlineDb.teams.toArray();
      if (cachedTeams.length > 0) setTeams(cachedTeams);

      const savedRun = await offlineDb.meta.get(ACTIVE_RUN_META_KEY);
      if (savedRun?.value) {
        const snap = savedRun.value as ActiveHostRunSnapshot;
        if (snap.station_id === s!.station_id && snap.session_id === s!.session_id) {
          setSelectedTeam(snap.selectedTeam);
          setAttemptId(snap.attemptId);
          setArrivedAtIso(snap.arrivedAtIso);
          setStartedAtMs(snap.startedAtMs);
          setEndedAtMs(snap.endedAtMs);
          setElapsedMs(snap.elapsedMs);
          setCompleted(snap.completed);
          setProgress(snap.progress);
          setCountValue(snap.countValue);
          setCounters(snap.counters);
          setBonusCorrect(snap.bonusCorrect);
          setStampedVariant(snap.stampedVariant);
          setPracticeMode(snap.practiceMode);
          setWrongStationWarn(snap.wrongStationWarn);
          setPhase(snap.phase);
        } else {
          await offlineDb.meta.delete(ACTIVE_RUN_META_KEY);
        }
      }

      const [{ data: stData }, { data: tmData }, { data: setData }] = await Promise.all([
        supabase.from("stations").select("config").eq("id", s!.station_id!).maybeSingle(),
        supabase.from("teams_public").select("id,number,church,team_name,token,route,withdrawn"),
        supabase.from("event_settings").select("*").eq("id", 1).maybeSingle()
      ]);

      if (stData?.config) {
        const cfg = stData.config as StationConfig;
        setStation(cfg);
        await cacheStations([cfg]);
      }
      if (tmData) {
        const list = tmData as TeamPublic[];
        setTeams(list);
        await cacheTeams(list);
      }
      if (setData) {
        const es = setData as EventSettingsRow;
        setSettings(es);
        if (es.event_state === "live") setPracticeMode(false);
      }

      await refreshSyncCounters(s!);
    }

    void hydrate();

    const onOnline = () => {
      setOnline(true);
      void refreshSyncCounters(s);
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const pollId = window.setInterval(async () => {
      if (!navigator.onLine) return;
      const [{ data: sessRow }, { data: esRow }, { data: inbRows }] = await Promise.all([
        supabase
          .from("role_sessions")
          .select("revoked_at")
          .eq("session_id", s.session_id)
          .maybeSingle(),
        supabase.from("event_settings").select("*").eq("id", 1).maybeSingle(),
        supabase.rpc("get_station_inbound")
      ]);
      if (sessRow?.revoked_at) {
        clearSession();
        router.replace("/login");
        return;
      }
      if (esRow) {
        const es = esRow as EventSettingsRow;
        setSettings(es);
        if (es.event_state === "live") setPracticeMode(false);
      }
      if (Array.isArray(inbRows) && inbRows.length > 0) {
        setInboundTeam(inbRows[0] as InboundTeamInfo);
      } else {
        setInboundTeam(null);
      }
      await refreshSyncCounters(s);
    }, 5000);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(pollId);
    };
  }, [router, refreshSyncCounters]);

  const capMs = (station?.cap_s ?? 120) * 1000;
  const hoverHoldMs = (station?.hover?.hold_s ?? 5) * 1000;

  const finishRun = useCallback(
    (didComplete: boolean, finalTimeMs: number, countOverride?: number) => {
      const nowAdj = serverAdjustedNow(clockOffsetMs);
      setEndedAtMs(nowAdj);
      setElapsedMs(finalTimeMs);
      setCompleted(didComplete);
      setHoldEndsAtMs(null);
      setHoldRemainingMs(0);
      setHoverStartedAtMs(null);
      setHoverRemainingMs(0);

      if (station?.widget === "counter_countdown") {
        setProgress(countOverride ?? countValue);
        setPhase(station.bonus ? "bonus" : "review");
        return;
      }

      if (didComplete || station?.widget === "hover_hold") {
        setProgress(null);
        setPhase(station?.bonus ? "bonus" : "review");
      } else {
        if (station?.progress?.kind === "stepper") {
          setProgress(station.progress.min);
        } else {
          setProgress(null);
        }
        setPhase("result");
      }
    },
    [clockOffsetMs, countValue, station]
  );

  // High-frequency timestamp tick while running
  useEffect(() => {
    if (phase !== "running" || startedAtMs === null || !station) return;

    const tick = () => {
      const nowAdj = serverAdjustedNow(clockOffsetMs);
      const nextElapsed = computeElapsedMs(startedAtMs, nowAdj, capMs);
      setElapsedMs(nextElapsed);

      if (holdEndsAtMs !== null) {
        const rem = Math.max(0, holdEndsAtMs - nowAdj);
        setHoldRemainingMs(rem);
        if (rem <= 0) {
          setHoldEndsAtMs(null);
        }
      }

      if (nextElapsed >= capMs && !capFiredRef.current) {
        capFiredRef.current = true;
        setCapFlash(true);
        playBeep(440, 350);
        vibrate([200, 100, 200]);
        setTimeout(() => setCapFlash(false), 600);
        if (station.widget === "counter_countdown") {
          finishRun(true, capMs);
        } else {
          finishRun(false, capMs);
        }
        return;
      }

      if (station.widget === "hover_hold" && hoverStartedAtMs !== null) {
        const hoverElapsed = nowAdj - hoverStartedAtMs;
        const rem = Math.max(0, hoverHoldMs - hoverElapsed);
        setHoverRemainingMs(rem);
        if (rem <= 0 && !capFiredRef.current) {
          capFiredRef.current = true;
          playBeep(1046, 220);
          vibrate(150);
          finishRun(true, nextElapsed);
        }
      }
    };

    tick();
    const id = window.setInterval(tick, 100);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [
    phase,
    startedAtMs,
    clockOffsetMs,
    capMs,
    station,
    holdEndsAtMs,
    hoverStartedAtMs,
    hoverHoldMs,
    finishRun
  ]);

  // 60-second Undo countdown
  useEffect(() => {
    if (phase !== "reset" || undoDeadlineMs === null) return;
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((undoDeadlineMs - Date.now()) / 1000));
      setUndoSecondsLeft(left);
    }, 500);
    return () => window.clearInterval(id);
  }, [phase, undoDeadlineMs]);

  const recordResetLog = useCallback(
    async (skipped: boolean, itemsDone: number) => {
      if (!session || !station || !resetId || !resetStartedAtMs) return;
      const nowAdj = serverAdjustedNow(clockOffsetMs);
      await enqueueWrite("station_resets", resetId, {
        id: resetId,
        station_id: station.id,
        after_attempt_id: lastSubmittedId,
        started_at: new Date(resetStartedAtMs).toISOString(),
        done_at: skipped ? null : new Date(nowAdj).toISOString(),
        items_done: itemsDone,
        skipped,
        session_id: session.session_id
      });
      setResetId(null);
      setResetStartedAtMs(null);
      setResetItemsDone(0);
      await refreshSyncCounters(session);
    },
    [session, station, resetId, resetStartedAtMs, clockOffsetMs, lastSubmittedId, refreshSyncCounters]
  );

  const resolveAndSelectTeam = useCallback(
    async (query: { token?: string; number?: number }) => {
      if (!session || !station) return;
      setLookupError(null);

      let found: TeamPublic | undefined;
      if (query.token) {
        const cleanTok = query.token.trim().toUpperCase();
        found = teams.find((tm) => tm.token.toUpperCase() === cleanTok && !tm.withdrawn);
        if (!found) {
          const fromDb = await offlineDb.teams.where("token").equals(cleanTok).first();
          if (fromDb && !fromDb.withdrawn) found = fromDb;
        }
      } else if (query.number !== undefined) {
        found = teams.find((tm) => tm.number === query.number && !tm.withdrawn);
      }

      if (!found) {
        setLookupError(t("host.unknown_team"));
        return;
      }

      if (phase === "reset" && resetId) {
        await recordResetLog(true, resetItemsDone);
      }

      const isPractice = settings?.event_state === "live" ? false : practiceMode;

      if (!isPractice) {
        const localExisting = await offlineDb.local_attempts
          .where("[team_id+station_id]")
          .equals([found.id, station.id])
          .filter((a) => !a.practice && !a.voided)
          .first();

        let remoteExisting = false;
        if (navigator.onLine) {
          const supabase = getSupabaseClient(session);
          const { data } = await supabase
            .from("attempts")
            .select("id")
            .eq("team_id", found.id)
            .eq("station_id", station.id)
            .eq("practice", false)
            .eq("voided", false)
            .limit(1);
          remoteExisting = (data?.length ?? 0) > 0;
        }

        if (localExisting || remoteExisting) {
          setLookupError(t("host.already_played"));
          return;
        }
      }

      const order = getRouteOrder(found.route);
      const isExpectedInbound = inboundTeam?.team_id === found.id;
      const isFirstOnRoute = order[0] === station.id;
      const offRoute = !isExpectedInbound && !isFirstOnRoute && inboundTeam !== null;
      setWrongStationWarn(offRoute);

      const newId = crypto.randomUUID();
      const nowIso = new Date(serverAdjustedNow(clockOffsetMs)).toISOString();
      const variant = station.id === 7 ? (settings?.current_variant ?? "W1") : null;

      setCameraOpen(false);
      setSelectedTeam(found);
      setAttemptId(newId);
      setArrivedAtIso(nowIso);
      setStartedAtMs(null);
      setEndedAtMs(null);
      setStampedVariant(variant);
      setCounters({});
      setCountValue(0);
      setProgress(null);
      setBonusCorrect(null);
      setElapsedMs(0);
      setCompleted(false);
      setPhase("ready");

      const arrivedRow: AttemptRow = {
        id: newId,
        team_id: found.id,
        station_id: station.id,
        state: "arrived",
        arrived_at: nowIso,
        started_at: null,
        ended_at: null,
        scored_at: null,
        completed: null,
        time_ms: null,
        progress: null,
        counters: {},
        bonus_correct: null,
        variant,
        practice: isPractice,
        voided: false,
        version: 1,
        session_id: session.session_id
      };
      await enqueueWrite("attempts", newId, arrivedRow as unknown as Record<string, unknown>);
      await refreshSyncCounters(session);
    },
    [
      session,
      station,
      teams,
      phase,
      resetId,
      recordResetLog,
      resetItemsDone,
      practiceMode,
      inboundTeam,
      clockOffsetMs,
      settings,
      refreshSyncCounters
    ]
  );

  function handleLookupNumber() {
    const num = Number.parseInt(teamInput.trim(), 10);
    if (Number.isNaN(num)) {
      setLookupError(t("host.unknown_team"));
      return;
    }
    void resolveAndSelectTeam({ number: num });
  }

  async function handleStart() {
    if (!session || !station || !selectedTeam || !attemptId) return;
    playBeep(880, 120);
    vibrate(60);
    capFiredRef.current = false;
    const nowAdj = serverAdjustedNow(clockOffsetMs);
    const startedIso = new Date(nowAdj).toISOString();
    setStartedAtMs(nowAdj);
    setElapsedMs(0);
    setHoverStartedAtMs(null);
    setHoldEndsAtMs(null);
    setHoldRemainingMs(0);
    setPhase("running");

    const isPractice = settings?.event_state === "live" ? false : practiceMode;
    const startedRow: AttemptRow = {
      id: attemptId,
      team_id: selectedTeam.id,
      station_id: station.id,
      state: "started",
      arrived_at: arrivedAtIso ?? startedIso,
      started_at: startedIso,
      ended_at: null,
      scored_at: null,
      completed: null,
      time_ms: null,
      progress: null,
      counters: {},
      bonus_correct: null,
      variant: stampedVariant,
      practice: isPractice,
      voided: false,
      version: 1,
      session_id: session.session_id
    };
    await enqueueWrite("attempts", attemptId, startedRow as unknown as Record<string, unknown>);
    await refreshSyncCounters(session);
  }

  async function handleCancelBeforeStart() {
    if (session && attemptId) {
      const ob = await offlineDb.outbox.get(attemptId);
      if (ob && ob.status !== "synced") {
        await offlineDb.outbox.delete(attemptId);
        await offlineDb.local_attempts.delete(attemptId);
      } else if (navigator.onLine) {
        const supabase = getSupabaseClient(session);
        await supabase.rpc("host_cancel_before_start", { p_attempt_id: attemptId });
        await offlineDb.local_attempts.update(attemptId, { voided: true });
      }
      await offlineDb.meta.delete(ACTIVE_RUN_META_KEY);
      const pending = await offlineDb.outbox.where("status").anyOf("queued", "failed", "syncing").count();
      setPendingCount(pending);
    }

    setSelectedTeam(null);
    setAttemptId(null);
    setArrivedAtIso(null);
    setTeamInput("");
    setPhase("scan");
  }

  async function handleSubmitAttempt() {
    if (!session || !station || !selectedTeam || !attemptId) return;
    const nowAdj = serverAdjustedNow(clockOffsetMs);
    const finalEndMs = endedAtMs ?? nowAdj;
    const payload: AttemptRow = {
      id: attemptId,
      team_id: selectedTeam.id,
      station_id: station.id,
      state: "scored",
      arrived_at: arrivedAtIso ?? new Date(nowAdj).toISOString(),
      started_at: startedAtMs ? new Date(startedAtMs).toISOString() : new Date(nowAdj).toISOString(),
      ended_at: new Date(finalEndMs).toISOString(),
      scored_at: null,
      completed,
      time_ms: elapsedMs,
      progress: station.widget === "counter_countdown" ? countValue : progress,
      counters,
      bonus_correct: station.bonus ? bonusCorrect : null,
      variant: stampedVariant,
      practice: settings?.event_state === "live" ? false : practiceMode,
      voided: false,
      version: 1,
      session_id: session.session_id
    };

    await enqueueWrite("attempts", attemptId, payload as unknown as Record<string, unknown>);
    await offlineDb.meta.delete(ACTIVE_RUN_META_KEY);
    setLastSubmittedId(attemptId);
    setLastAttemptSynced(false);
    setUndoError(null);
    setUndoDeadlineMs(Date.now() + 60_000);
    setUndoSecondsLeft(60);

    setResetId(crypto.randomUUID());
    setResetStartedAtMs(finalEndMs);
    setResetItemsDone(0);
    setTeamInput("");
    setLookupError(null);
    setPhase("reset");

    await refreshSyncCounters(session);
  }

  // P1 #7: Offline-safe Host Undo
  // If the attempt has not yet synced to Postgres, cancel it directly from Dexie outbox.
  async function handleUndo() {
    if (!session || !lastSubmittedId) return;
    setUndoError(null);

    const ob = await offlineDb.outbox.get(lastSubmittedId);
    if (ob && ob.status !== "synced") {
      await offlineDb.outbox.delete(lastSubmittedId);
      await offlineDb.local_attempts.delete(lastSubmittedId);
      const pending = await offlineDb.outbox.where("status").anyOf("queued", "failed", "syncing").count();
      setPendingCount(pending);
      setConflicts(await getConflictItems());
    } else {
      if (!navigator.onLine) {
        setUndoError("Offline: reconnect to undo synced attempt");
        return;
      }
      const supabase = getSupabaseClient(session);
      const { error } = await supabase.rpc("host_undo", {
        p_attempt_id: lastSubmittedId,
        p_undone_at: new Date(serverAdjustedNow(clockOffsetMs)).toISOString()
      });

      if (error) {
        setUndoError(error.message);
        return;
      }
      await offlineDb.local_attempts.update(lastSubmittedId, { voided: true });
    }

    setAttemptId(crypto.randomUUID());
    setLastSubmittedId(null);
    setUndoDeadlineMs(null);
    setResetId(null);
    setResetStartedAtMs(null);
    setPhase("review");
  }

  async function handleResetDone(itemsDone: number) {
    await recordResetLog(false, itemsDone);
    setSelectedTeam(null);
    setAttemptId(null);
    setTeamInput("");
    setLookupError(null);
    setPhase("scan");
  }

  const remainingMs = Math.max(0, capMs - elapsedMs);
  const runningBgClass = useMemo(() => {
    if (phase !== "running") return "bg-bg";
    if (capFlash || remainingMs <= 0) return "bg-danger/20";
    if (remainingMs <= 10_000) return "bg-warning/20";
    return "bg-success/15";
  }, [phase, capFlash, remainingMs]);

  const notEnoughHoverTime = remainingMs < hoverHoldMs;
  const canGoBackFromReview = Boolean(station?.bonus) || (!completed && Boolean(station?.progress));

  if (!session) return null;

  return (
    <div className={"min-h-[100dvh] flex flex-col " + runningBgClass}>
      {practiceMode && (
        <div className="bg-warning text-white text-center text-xs font-semibold py-1.5 px-3">
          {t("common.practice_banner")}
        </div>
      )}

      {/* Top bar */}
      <header className="safe-pt px-4 pb-3 border-b border-border bg-surface flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted font-medium">Station {session.station_id}</p>
          <h1 className="text-base font-semibold truncate">{station?.name ?? t("common.loading")}</h1>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium " +
              (online ? "bg-success/15 text-success" : "bg-danger/15 text-danger")
            }
          >
            {online ? <Wifi className="w-3.5 h-3.5" /> : <CloudOff className="w-3.5 h-3.5" />}
            {online
              ? pendingCount > 0
                ? pendingCount + " " + t("common.queued")
                : t("common.synced")
              : t("common.offline")}
          </span>
          {settings?.event_state !== "live" && (phase === "scan" || phase === "reset") && (
            <button
              type="button"
              onClick={() => setPracticeMode((p) => !p)}
              className={
                "h-9 px-3 rounded-card border text-xs font-medium " +
                (practiceMode ? "border-warning bg-warning/15 text-warning" : "border-border text-muted")
              }
            >
              {t("host.practice_mode")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              clearSession();
              router.replace("/login");
            }}
            aria-label={t("common.sign_out")}
            className="h-9 px-2.5 rounded-card border border-border text-muted flex items-center gap-1 text-xs"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{t("common.sign_out")}</span>
          </button>
        </div>
      </header>

      {/* Non-retriable outbox conflict banner */}
      {conflicts.length > 0 && (
        <div className="bg-danger/15 border-b border-danger/40 px-4 py-2.5 text-xs text-danger space-y-1.5">
          {conflicts.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">
                Sync rejected ({c.table}): {c.last_error ?? "Conflict"}
              </span>
              <button
                type="button"
                onClick={async () => {
                  await dismissConflict(c.id);
                  setConflicts(await getConflictItems());
                }}
                className="px-2 py-1 rounded border border-danger/50 font-semibold shrink-0"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main zone */}
      <main className="flex-1 p-4 flex flex-col justify-between max-w-md w-full mx-auto gap-4">
        {!station ? (
          <p className="text-sm text-muted text-center my-auto">{t("host.no_station_config")}</p>
        ) : phase === "scan" || phase === "reset" ? (
          <div className="space-y-4">
            {phase === "reset" && resetStartedAtMs !== null && (
              <ResetPanel
                station={station}
                startedAtMs={resetStartedAtMs}
                clockOffsetMs={clockOffsetMs}
                inbound={inboundTeam}
                currentVariant={settings?.current_variant ?? null}
                undoSecondsLeft={undoSecondsLeft}
                lastAttemptSynced={lastAttemptSynced}
                undoError={undoError}
                onUndo={handleUndo}
                onChecklistChange={setResetItemsDone}
                onResetDone={handleResetDone}
              />
            )}

            {cameraOpen ? (
              <QrScanner
                compact={phase === "reset"}
                onScan={(code) => void resolveAndSelectTeam({ token: code })}
                onClose={() => setCameraOpen(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                className="w-full h-14 rounded-card bg-accent text-white font-semibold inline-flex items-center justify-center gap-2"
              >
                <Camera className="w-5 h-5" />
                <span>{t("host.scan_camera")}</span>
              </button>
            )}

            <div className="bg-surface border border-border rounded-card p-4 shadow-soft space-y-3">
              <label htmlFor="team-num-input" className="block text-xs font-semibold text-muted">
                {t("host.scan_title")}
              </label>
              <div className="flex gap-2">
                <input
                  id="team-num-input"
                  type="tel"
                  inputMode="numeric"
                  value={teamInput}
                  onChange={(e) => setTeamInput(e.target.value.replace(/\\D/g, ""))}
                  placeholder={t("host.team_placeholder")}
                  className="flex-1 h-14 px-4 rounded-card border border-border bg-bg text-text text-xl font-semibold text-center tabular-nums"
                />
                <button
                  type="button"
                  onClick={handleLookupNumber}
                  className="h-14 px-5 rounded-card border border-border bg-surface font-semibold"
                >
                  {t("host.lookup")}
                </button>
              </div>
              {lookupError && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {lookupError}
                </p>
              )}
            </div>
          </div>
        ) : phase === "ready" && selectedTeam ? (
          <>
            <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-bold tabular-nums">Team #{selectedTeam.number}</span>
                <span className="text-sm font-medium text-muted">
                  {t("host.route_label")} {String.fromCharCode(65 + (selectedTeam.route % 7))}
                </span>
              </div>
              <p className="text-base font-medium">{selectedTeam.church}</p>
              {station.id === 7 && stampedVariant && (
                <p className="text-sm font-medium text-accent">
                  {t("host.variant_label")}: {stampedVariant}
                </p>
              )}
              {wrongStationWarn && (
                <div className="flex items-center gap-2 p-3 rounded-card bg-warning/15 text-warning text-sm font-medium">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{t("host.wrong_station")}</span>
                </div>
              )}
              <p className="text-sm text-muted pt-2 border-t border-border">{station.rule}</p>
            </div>

            <div className="safe-pb grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => void handleCancelBeforeStart()}
                className="h-14 rounded-card border border-border bg-surface text-text font-semibold"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleStart()}
                className="col-span-2 h-14 rounded-card bg-success text-white font-semibold flex items-center justify-center gap-2"
              >
                <Play className="w-5 h-5" />
                <span>{t("common.start")}</span>
              </button>
            </div>
          </>
        ) : phase === "running" && selectedTeam ? (
          <>
            <div className="text-center space-y-2 pt-4">
              <p className="text-sm font-medium text-muted">
                Team #{selectedTeam.number} · {selectedTeam.church}
              </p>
              <div className="text-6xl font-bold tabular-nums tracking-tight">
                {station.widget === "counter_countdown"
                  ? formatClockSeconds(remainingMs)
                  : formatDurationMs(elapsedMs)}
              </div>
              <p className="text-sm text-muted tabular-nums">
                {t("host.cap_reached")}: {formatClockSeconds(remainingMs)}
              </p>

              {station.widget === "counter_countdown" && (
                <div className="pt-4">
                  <p className="text-5xl font-bold tabular-nums text-accent">{countValue}</p>
                </div>
              )}

              {station.widget === "hover_hold" && hoverStartedAtMs !== null && (
                <div className="mt-4 p-4 rounded-card bg-accent/15 border border-accent">
                  <p className="text-4xl font-bold tabular-nums text-accent">
                    {(hoverRemainingMs / 1000).toFixed(1)}s
                  </p>
                </div>
              )}

              {holdRemainingMs > 0 && (
                <div className="mt-4 p-4 rounded-card bg-warning text-white font-bold text-2xl tabular-nums">
                  {t("host.foot_down")}: {(holdRemainingMs / 1000).toFixed(1)}s
                </div>
              )}
            </div>

            <div className="safe-pb space-y-3">
              {station.helpers.map((h) => {
                if (h.type === "hold_overlay") {
                  return (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => {
                        const durMs = (h.hold_s ?? 3) * 1000;
                        const nowAdj = serverAdjustedNow(clockOffsetMs);
                        setHoldEndsAtMs(nowAdj + durMs);
                        setHoldRemainingMs(durMs);
                        setCounters((c) => ({ ...c, [h.id]: (c[h.id] ?? 0) + 1 }));
                      }}
                      className="w-full h-14 rounded-card border border-warning bg-warning/15 text-warning font-semibold"
                    >
                      {t("host.foot_down")} ({counters[h.id] ?? 0})
                    </button>
                  );
                }
                if (h.type === "counter") {
                  return (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => setCounters((c) => ({ ...c, [h.id]: (c[h.id] ?? 0) + 1 }))}
                      className="w-full h-14 rounded-card border border-border bg-surface text-text font-semibold tabular-nums"
                    >
                      {t("host.drop_counter")} ({counters[h.id] ?? 0})
                    </button>
                  );
                }
                return null;
              })}

              {station.widget === "stopwatch_progress" && (
                <button
                  type="button"
                  onClick={() => finishRun(true, elapsedMs)}
                  className="w-full h-16 rounded-card bg-danger text-white text-lg font-semibold flex items-center justify-center gap-2"
                >
                  <Square className="w-5 h-5" />
                  <span>{t("common.stop")}</span>
                </button>
              )}

              {station.widget === "counter_countdown" && (
                <div className="grid grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={() => setCountValue((v) => Math.max(0, v - 1))}
                    className="h-16 rounded-card border border-border bg-surface text-xl font-bold"
                  >
                    -1
                  </button>
                  <button
                    type="button"
                    onClick={() => setCountValue((v) => v + 1)}
                    className="col-span-2 h-16 rounded-card bg-accent text-white text-2xl font-bold"
                  >
                    +1
                  </button>
                </div>
              )}

              {station.widget === "hover_hold" && (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    disabled={hoverStartedAtMs === null}
                    onClick={() => {
                      setHoverStartedAtMs(null);
                      setHoverRemainingMs(0);
                      setCounters((c) => ({ ...c, ground_touch: (c.ground_touch ?? 0) + 1 }));
                    }}
                    className="h-16 rounded-card border border-danger bg-danger/10 text-danger font-semibold disabled:opacity-40"
                  >
                    {t("host.hover_reset")} ({counters.ground_touch ?? 0})
                  </button>
                  <button
                    type="button"
                    disabled={hoverStartedAtMs !== null || notEnoughHoverTime}
                    onClick={() => {
                      const nowAdj = serverAdjustedNow(clockOffsetMs);
                      setHoverStartedAtMs(nowAdj);
                      setHoverRemainingMs(hoverHoldMs);
                    }}
                    className="h-16 rounded-card bg-accent text-white font-semibold disabled:opacity-50"
                  >
                    {notEnoughHoverTime ? t("host.not_enough_time") : t("host.hover_start")}
                  </button>
                </div>
              )}
            </div>
          </>
        ) : phase === "result" ? (
          <>
            <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-4">
              <h2 className="text-base font-semibold">{t("host.result_title")}</h2>
              {station.progress?.kind === "taps" && (
                <div className="grid grid-cols-4 gap-2">
                  {station.progress.values.map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setProgress(val)}
                      className={
                        "h-14 rounded-card border font-semibold tabular-nums " +
                        (progress === val
                          ? "bg-accent text-white border-accent"
                          : "bg-bg text-text border-border")
                      }
                    >
                      {val} {station.progress?.unit}
                    </button>
                  ))}
                </div>
              )}
              {station.progress?.kind === "stepper" && (
                <div className="flex items-center justify-between gap-4">
                  <button
                    type="button"
                    onClick={() =>
                      setProgress((p) =>
                        Math.max(
                          station.progress!.kind === "stepper" ? station.progress!.min : 0,
                          (p ?? 0) -
                            (station.progress!.kind === "stepper" ? station.progress!.step : 5)
                        )
                      )
                    }
                    className="h-14 w-16 rounded-card border border-border text-xl font-bold"
                  >
                    -
                  </button>
                  <span className="text-3xl font-bold tabular-nums">
                    {progress ?? station.progress.min} {station.progress.unit}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setProgress((p) =>
                        Math.min(
                          station.progress!.kind === "stepper" ? station.progress!.max : 150,
                          (p ?? 0) +
                            (station.progress!.kind === "stepper" ? station.progress!.step : 5)
                        )
                      )
                    }
                    className="h-14 w-16 rounded-card border border-border text-xl font-bold"
                  >
                    +
                  </button>
                </div>
              )}
            </div>
            <div className="safe-pb">
              <button
                type="button"
                disabled={progress === null}
                onClick={() => setPhase(station.bonus ? "bonus" : "review")}
                className="w-full h-14 rounded-card bg-accent text-white font-semibold disabled:opacity-50"
              >
                {t("common.continue")}
              </button>
            </div>
          </>
        ) : phase === "bonus" && station.bonus ? (
          <>
            <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-3">
              <h2 className="text-sm font-semibold text-muted">{t("host.bonus_title")}</h2>
              <p className="text-base font-medium">{station.bonus.q}</p>
              <p className="text-sm text-success font-semibold pt-2 border-t border-border">
                {station.bonus.a}
              </p>
            </div>
            <div className="safe-pb grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setBonusCorrect(false);
                  setPhase("review");
                }}
                className="h-14 rounded-card border border-danger bg-danger/10 text-danger font-semibold flex items-center justify-center gap-2"
              >
                <X className="w-5 h-5" />
                <span>{t("common.wrong")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setBonusCorrect(true);
                  setPhase("review");
                }}
                className="h-14 rounded-card bg-success text-white font-semibold flex items-center justify-center gap-2"
              >
                <Check className="w-5 h-5" />
                <span>{t("common.correct")}</span>
              </button>
            </div>
          </>
        ) : (
          selectedTeam && (
            <>
              <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-3">
                <h2 className="text-base font-semibold">{t("host.review_title")}</h2>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Team</span>
                  <span className="font-semibold tabular-nums">
                    #{selectedTeam.number} · {selectedTeam.church}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Outcome</span>
                  <span className="font-semibold">
                    {completed ? t("host.completed") : t("host.dnf")}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Time</span>
                  <span className="font-semibold tabular-nums">{formatDurationMs(elapsedMs)}</span>
                </div>

                {station.widget === "counter_countdown" ? (
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="text-sm text-muted">Count</span>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setCountValue((v) => {
                            const next = Math.max(0, v - 1);
                            setProgress(next);
                            return next;
                          });
                        }}
                        className="h-10 w-12 rounded-card border border-border font-bold"
                      >
                        -1
                      </button>
                      <span className="text-lg font-bold tabular-nums min-w-[2ch] text-center">
                        {countValue}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setCountValue((v) => {
                            const next = v + 1;
                            setProgress(next);
                            return next;
                          });
                        }}
                        className="h-10 w-12 rounded-card border border-border font-bold"
                      >
                        +1
                      </button>
                    </div>
                  </div>
                ) : (
                  progress !== null && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted">Progress</span>
                      <span className="font-semibold tabular-nums">{progress}</span>
                    </div>
                  )
                )}

                {station.bonus && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Bonus</span>
                    <span className="font-semibold">
                      {bonusCorrect ? t("common.correct") : t("common.wrong")}
                    </span>
                  </div>
                )}
              </div>
              <div className={"safe-pb grid gap-3 " + (canGoBackFromReview ? "grid-cols-3" : "grid-cols-1")}>
                {canGoBackFromReview && (
                  <button
                    type="button"
                    onClick={() => setPhase(station.bonus ? "bonus" : "result")}
                    className="h-14 rounded-card border border-border bg-surface font-semibold"
                  >
                    {t("common.back")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleSubmitAttempt()}
                  className={
                    "h-14 rounded-card bg-accent text-white font-semibold " +
                    (canGoBackFromReview ? "col-span-2" : "w-full")
                  }
                >
                  {t("common.submit")}
                </button>
              </div>
            </>
          )
        )}
      </main>
    </div>
  );
}
`,

  "src/components/hub/HubRolesTab.tsx": `
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Copy, QrCode, RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { callAuthSession } from "@/lib/supabase/client";
import type { RoleSession } from "@/lib/types/domain";
import { QrCodeSvg } from "@/components/qr/QrCodeSvg";

interface RoleCredRow {
  role: string;
  station_id: number | null;
  secret_token: string;
  pin_code: string;
}

export function HubRolesTab({ session }: { session: RoleSession }) {
  const [roles, setRoles] = useState<RoleCredRow[]>([]);
  const [takeoverInfo, setTakeoverInfo] = useState<{ role: string; url: string } | null>(null);
  const [confirmRegenRole, setConfirmRegenRole] = useState<string | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    void loadRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadRoles() {
    const res = await callAuthSession({ action: "list_roles" }, session.access_token);
    if (res.ok && Array.isArray(res.data.roles)) {
      setRoles(res.data.roles as RoleCredRow[]);
    }
  }

  async function executeRegenerate() {
    if (!confirmRegenRole) return;
    setRegenBusy(true);
    try {
      const res = await callAuthSession(
        { action: "regenerate", target_role: confirmRegenRole },
        session.access_token
      );
      if (res.ok) {
        setConfirmRegenRole(null);
        await loadRoles();
      }
    } finally {
      setRegenBusy(false);
    }
  }

  async function handleCreateTakeover(targetRole: string) {
    const res = await callAuthSession(
      { action: "create_takeover", target_role: targetRole },
      session.access_token
    );
    if (res.ok && typeof res.data.token === "string") {
      setTakeoverInfo({
        role: targetRole,
        url: origin + "/r/takeover-" + res.data.token
      });
    }
  }

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <h1 className="text-lg font-semibold">{t("hub.tab_roles")}</h1>

      {roles.length === 0 ? (
        <p className="text-sm text-muted bg-surface border border-border rounded-card p-6 text-center">
          No role credentials loaded. Ensure auth-session Edge Function is deployed and refresh.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {roles.map((rc) => {
            const link = origin + "/r/" + rc.secret_token;
            return (
              <div key={rc.role} className="bg-surface border border-border rounded-card p-4 shadow-soft space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold uppercase">{rc.role.replace("_", " ")}</h2>
                    <p className="text-sm font-mono font-bold text-accent tabular-nums">PIN: {rc.pin_code}</p>
                  </div>
                  <QrCodeSvg value={link} size={84} />
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(link)}
                    className="h-9 px-3 rounded-card border border-border text-xs font-medium inline-flex items-center gap-1"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>{t("hub.copy_link")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCreateTakeover(rc.role)}
                    className="h-9 px-3 rounded-card border border-border text-xs font-medium inline-flex items-center gap-1"
                  >
                    <QrCode className="w-3.5 h-3.5" />
                    <span>{t("hub.takeover_qr")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRegenRole(rc.role)}
                    className="h-9 px-3 rounded-card border border-danger/40 text-danger text-xs font-medium inline-flex items-center gap-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{t("hub.regenerate")}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Confirmation dialog before rotating credentials & revoking active sessions */}
      {confirmRegenRole && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
        >
          <div className="bg-surface border border-border rounded-card p-5 shadow-soft max-w-sm w-full space-y-4">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h2 className="text-base font-semibold">
                  Regenerate {confirmRegenRole.replace("_", " ").toUpperCase()}?
                </h2>
                <p className="text-sm text-muted">
                  This creates a new PIN and secret link, and immediately signs out the currently
                  active device for this role.
                </p>
                {confirmRegenRole === "hub" && (
                  <p className="text-xs font-semibold text-danger pt-1">
                    Warning: Regenerating HUB will sign out this Hub session. Copy the new PIN before
                    reloading.
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={regenBusy}
                onClick={() => setConfirmRegenRole(null)}
                className="h-10 px-4 rounded-card border border-border text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={regenBusy}
                onClick={() => void executeRegenerate()}
                className="h-10 px-4 rounded-card bg-danger text-white text-sm font-semibold disabled:opacity-50"
              >
                {t("hub.regenerate")}
              </button>
            </div>
          </div>
        </div>
      )}

      {takeoverInfo && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
        >
          <div className="bg-surface border border-border rounded-card p-5 shadow-soft max-w-xs w-full text-center space-y-3">
            <h2 className="text-base font-semibold uppercase">
              {takeoverInfo.role.replace("_", " ")} · 2 min
            </h2>
            <div className="flex justify-center">
              <QrCodeSvg value={takeoverInfo.url} size={180} />
            </div>
            <button
              type="button"
              onClick={() => setTakeoverInfo(null)}
              className="w-full h-11 rounded-card bg-accent text-white text-sm font-semibold"
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
`,

  "src/components/hub/HubApp.tsx": `
"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import {
  AlertTriangle,
  Camera,
  ClipboardList,
  Download,
  Flag,
  KeyRound,
  LogOut,
  Menu,
  Plus,
  Printer,
  Radio,
  Settings,
  Trophy,
  Users,
  X
} from "lucide-react";
import { clearSession, loadSession } from "@/lib/auth/session";
import { t } from "@/lib/i18n";
import { computeOpsBoard } from "@/lib/ops";
import type { ResetLogInput } from "@/lib/reset";
import { computeScoring, type LeaderboardRow, type StationScoringConfig } from "@/lib/scoring";
import { getSupabaseClient } from "@/lib/supabase/client";
import { formatDurationMs } from "@/lib/timer/clock";
import type {
  AttemptRow,
  AuditLogRow,
  EventSettingsRow,
  RoleSession,
  StationConfig,
  TeamRow
} from "@/lib/types/domain";
import { QrScanner } from "@/components/qr/QrScanner";
import { HubDispatchTab } from "@/components/hub/HubDispatchTab";
import { HubExportTab } from "@/components/hub/HubExportTab";
import { HubRolesTab } from "@/components/hub/HubRolesTab";
import { HubStationsTab } from "@/components/hub/HubStationsTab";

type HubTab =
  | "leaderboard"
  | "dispatch"
  | "teams"
  | "stations"
  | "attempts"
  | "roles"
  | "settings"
  | "export";

function randomTeamToken(): string {
  const chars = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function HubApp() {
  const router = useRouter();
  const [session, setSession] = useState<RoleSession | null>(null);
  const [tab, setTab] = useState<HubTab>("leaderboard");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [stations, setStations] = useState<StationConfig[]>([]);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [resets, setResets] = useState<ResetLogInput[]>([]);
  const [activeStationIds, setActiveStationIds] = useState<Set<number>>(new Set());
  const [settings, setSettings] = useState<EventSettingsRow | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogRow[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [search, setSearch] = useState("");
  const [churchFilter, setChurchFilter] = useState("ALL");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [drawerTeamId, setDrawerTeamId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Team creation & withdraw modal state
  const [newNumber, setNewNumber] = useState("");
  const [newChurch, setNewChurch] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [hubScanMode, setHubScanMode] = useState<"launch" | "finish" | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<TeamRow | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");

  // Attempt edit modal state (now includes completed & progress)
  const [editingAttempt, setEditingAttempt] = useState<AttemptRow | null>(null);
  const [editReason, setEditReason] = useState("");
  const [editVoided, setEditVoided] = useState(false);
  const [editCompleted, setEditCompleted] = useState<boolean>(true);
  const [editProgress, setEditProgress] = useState("");
  const [editBonus, setEditBonus] = useState<string>("null");
  const [editTimeMs, setEditTimeMs] = useState("");

  // Settings form state (Station 7 variant labels, max_teams, walk_time_s)
  const [newVariantLabel, setNewVariantLabel] = useState("");
  const [maxTeamsInput, setMaxTeamsInput] = useState("30");
  const [walkTimeInput, setWalkTimeInput] = useState("30");
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null);

  const loadAll = async (s: RoleSession) => {
    const supabase = getSupabaseClient(s);
    const [tmRes, stRes, attRes, rstRes, sessRes, setRes, audRes] = await Promise.all([
      supabase.from("teams").select("*").order("number", { ascending: true }),
      supabase.from("stations").select("config").order("id", { ascending: true }),
      supabase.from("attempts").select("*").order("updated_at", { ascending: false }),
      supabase
        .from("station_resets")
        .select("id,station_id,started_at,done_at,items_done,skipped")
        .order("started_at", { ascending: false }),
      supabase
        .from("role_sessions")
        .select("station_id")
        .is("revoked_at", null)
        .not("station_id", "is", null),
      supabase.from("event_settings").select("*").eq("id", 1).maybeSingle(),
      supabase.from("audit_log").select("*").order("ts", { ascending: false }).limit(50)
    ]);

    if (tmRes.data) setTeams(tmRes.data as TeamRow[]);
    if (stRes.data) setStations(stRes.data.map((r) => r.config as StationConfig));
    if (attRes.data) setAttempts(attRes.data as AttemptRow[]);
    if (rstRes.data) setResets(rstRes.data as ResetLogInput[]);
    if (sessRes.data) {
      setActiveStationIds(new Set(sessRes.data.map((r) => Number(r.station_id))));
    }
    if (setRes.data) {
      const es = setRes.data as EventSettingsRow;
      setSettings(es);
      setMaxTeamsInput(String(es.max_teams));
      setWalkTimeInput(String(es.walk_time_s));
    }
    if (audRes.data) setAuditLog(audRes.data as AuditLogRow[]);
  };

  useEffect(() => {
    const s = loadSession();
    if (!s || s.role !== "hub") {
      router.replace("/login");
      return;
    }
    setSession(s);
    void loadAll(s);

    const supabase = getSupabaseClient(s);
    const channel = supabase
      .channel("hub-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "attempts" }, () => void loadAll(s))
      .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, () => void loadAll(s))
      .on("postgres_changes", { event: "*", schema: "public", table: "station_resets" }, () => void loadAll(s))
      .on("postgres_changes", { event: "*", schema: "public", table: "event_settings" }, () => void loadAll(s))
      .subscribe();

    const pollId = window.setInterval(() => {
      setNowMs(Date.now());
      void loadAll(s);
    }, 5000);
    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(pollId);
    };
  }, [router]);

  const scoringConfigs: StationScoringConfig[] = useMemo(
    () =>
      stations.map((st) => ({
        id: st.id,
        name: st.name,
        rank: st.rank,
        dnf_zero: st.dnf_zero,
        bonus_on_dnf: st.bonus_on_dnf ?? true,
        has_bonus: st.bonus !== null
      })),
    [stations]
  );

  const scoring = useMemo(
    () =>
      computeScoring(teams, scoringConfigs, attempts, {
        n_mode: settings?.scoring_n_mode ?? "provisional",
        variant_ranking_mode: settings?.variant_ranking_mode ?? "across"
      }),
    [teams, scoringConfigs, attempts, settings]
  );

  const opsBoard = useMemo(
    () =>
      computeOpsBoard({
        stations,
        teams,
        attempts,
        resets,
        activeStationIds,
        walkTimeS: settings?.walk_time_s ?? 30,
        nowMs
      }),
    [stations, teams, attempts, resets, activeStationIds, settings, nowMs]
  );

  const churches = useMemo(() => Array.from(new Set(teams.map((tm) => tm.church))).sort(), [teams]);

  const filteredRows = useMemo(() => {
    return scoring.leaderboard.filter((row) => {
      if (churchFilter !== "ALL" && row.church !== churchFilter) return false;
      if (search.trim() !== "" && !String(row.team_number).includes(search.trim())) return false;
      return true;
    });
  }, [scoring.leaderboard, churchFilter, search]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "j") {
        setSelectedIndex((i) => Math.min(filteredRows.length - 1, i + 1));
      } else if (e.key === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "e") {
        const row = filteredRows[selectedIndex];
        if (row) setDrawerTeamId(row.team_id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filteredRows, selectedIndex]);

  const columns = useMemo<ColumnDef<LeaderboardRow>[]>(() => {
    const base: ColumnDef<LeaderboardRow>[] = [
      {
        accessorKey: "overall_rank",
        header: "#",
        cell: (info) => <span className="font-semibold tabular-nums">{String(info.getValue())}</span>
      },
      {
        accessorKey: "team_number",
        header: "Team",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-semibold tabular-nums">#{row.original.team_number}</span>
            <span className="text-muted truncate max-w-[140px]">{row.original.church}</span>
            {row.original.duel_won && (
              <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent text-[11px] font-semibold">
                DUEL
              </span>
            )}
            {row.original.missing_finish_alert && (
              <span className="px-1.5 py-0.5 rounded bg-warning/15 text-warning text-[11px] font-semibold">
                {t("hub.missing_finish")}
              </span>
            )}
          </div>
        )
      }
    ];

    for (const st of stations) {
      base.push({
        id: "st_" + st.id,
        header: "S" + st.id,
        accessorFn: (r) => r.stations[st.id]?.total_points ?? 0,
        cell: ({ row }) => {
          const cell = row.original.stations[st.id];
          if (!cell || !cell.played) return <span className="text-muted tabular-nums">—</span>;
          return (
            <div className="tabular-nums text-xs">
              <span className="font-semibold">{cell.total_points.toFixed(1)}</span>
              <span className="text-muted ml-1">{cell.rank !== null ? "#" + cell.rank : "DNF"}</span>
            </div>
          );
        }
      });
    }

    base.push({
      accessorKey: "grand_total",
      header: "Total",
      cell: (info) => (
        <span className="font-bold tabular-nums text-accent">{Number(info.getValue()).toFixed(1)}</span>
      )
    });

    return base;
  }, [stations]);

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  async function handleAddTeam(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    setFormMsg(null);
    const num = Number.parseInt(newNumber, 10);
    if (Number.isNaN(num) || !newChurch.trim()) return;

    const supabase = getSupabaseClient(session);
    const { error } = await supabase.from("teams").insert({
      number: num,
      church: newChurch.trim(),
      team_name: newTeamName.trim() || null,
      token: randomTeamToken(),
      checked_in_at: new Date().toISOString()
    });

    if (error) {
      setFormMsg(error.message);
    } else {
      setNewNumber("");
      setNewChurch("");
      setNewTeamName("");
      await loadAll(session);
    }
  }

  async function updateTeamTimestamp(teamId: string, field: "checked_in_at" | "started_at" | "finished_at") {
    if (!session) return;
    const supabase = getSupabaseClient(session);
    await supabase.from("teams").update({ [field]: new Date().toISOString() }).eq("id", teamId);
    await loadAll(session);
  }

  async function handleToggleDuelWon(team: TeamRow) {
    if (!session) return;
    const supabase = getSupabaseClient(session);
    await supabase.from("teams").update({ duel_won: !team.duel_won }).eq("id", team.id);
    await loadAll(session);
  }

  async function handleConfirmWithdraw(e: FormEvent) {
    e.preventDefault();
    if (!session || !withdrawTarget || !withdrawReason.trim()) return;
    const supabase = getSupabaseClient(session);
    await supabase.rpc("hub_set_team_withdrawn", {
      p_team_id: withdrawTarget.id,
      p_withdrawn: !withdrawTarget.withdrawn,
      p_reason: withdrawReason.trim()
    });
    setWithdrawTarget(null);
    setWithdrawReason("");
    await loadAll(session);
  }

  async function handleHubQrScan(token: string) {
    if (!session || !hubScanMode) return;
    const found = teams.find((tm) => tm.token.toUpperCase() === token.trim().toUpperCase());
    setHubScanMode(null);
    if (!found) {
      setFormMsg(t("host.unknown_team"));
      return;
    }
    await updateTeamTimestamp(found.id, hubScanMode === "launch" ? "started_at" : "finished_at");
  }

  async function handleSaveAttemptEdit(e: FormEvent) {
    e.preventDefault();
    if (!session || !editingAttempt || !editReason.trim()) return;
    const supabase = getSupabaseClient(session);
    const patch: Record<string, unknown> = {
      voided: editVoided,
      completed: editCompleted,
      bonus_correct: editBonus === "null" ? null : editBonus === "true",
      progress: editProgress.trim() === "" ? null : Number(editProgress)
    };
    if (editTimeMs.trim() !== "") {
      patch.time_ms = Number.parseInt(editTimeMs, 10);
    }
    await supabase.rpc("hub_edit_attempt", {
      p_attempt_id: editingAttempt.id,
      p_patch: patch,
      p_reason: editReason.trim()
    });
    setEditingAttempt(null);
    setEditReason("");
    await loadAll(session);
  }

  async function handleSettingPatch(patch: Record<string, unknown>, reason: string) {
    if (!session) return;
    setSettingsSavedMsg(null);
    const supabase = getSupabaseClient(session);
    const { error } = await supabase.rpc("hub_update_event_settings", {
      p_patch: patch,
      p_reason: reason
    });
    if (!error) {
      setSettingsSavedMsg(t("hub.settings_saved"));
      await loadAll(session);
    }
  }

  async function handleAddVariantLabel(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const clean = newVariantLabel.trim().slice(0, 12);
    if (!clean || settings.variant_labels.includes(clean)) return;
    const nextLabels = [...settings.variant_labels, clean];
    await handleSettingPatch(
      { variant_labels: nextLabels, current_variant: clean },
      "hub_add_variant_label"
    );
    setNewVariantLabel("");
  }

  async function handleSaveNumericSettings(e: FormEvent) {
    e.preventDefault();
    const maxTeams = Math.min(200, Math.max(1, Number.parseInt(maxTeamsInput, 10) || 30));
    const walkTime = Math.min(300, Math.max(0, Number.parseInt(walkTimeInput, 10) || 30));
    await handleSettingPatch(
      { max_teams: maxTeams, walk_time_s: walkTime },
      "hub_update_capacity_and_walk_time"
    );
  }

  const drawerTeam = teams.find((tm) => tm.id === drawerTeamId) ?? null;
  const drawerRow = scoring.leaderboard.find((r) => r.team_id === drawerTeamId) ?? null;

  const navItems: { id: HubTab; label: string; icon: typeof Trophy }[] = [
    { id: "leaderboard", label: t("hub.tab_leaderboard"), icon: Trophy },
    { id: "dispatch", label: t("hub.tab_dispatch"), icon: Radio },
    { id: "teams", label: t("hub.tab_teams"), icon: Users },
    { id: "stations", label: t("hub.tab_stations"), icon: Flag },
    { id: "attempts", label: t("hub.tab_attempts"), icon: ClipboardList },
    { id: "roles", label: t("hub.tab_roles"), icon: KeyRound },
    { id: "settings", label: t("hub.tab_settings"), icon: Settings },
    { id: "export", label: t("hub.tab_export"), icon: Download }
  ];

  const primaryMobileTabs = navItems.slice(0, 4);
  const overflowMobileTabs = navItems.slice(4);
  const isOverflowTabActive = overflowMobileTabs.some((item) => item.id === tab);

  if (!session) return null;

  return (
    <div className="min-h-[100dvh] flex flex-col lg:flex-row bg-bg">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:w-56 flex-col border-r border-border bg-surface p-3 gap-1 shrink-0">
        <div className="px-3 py-2 flex items-center justify-between">
          <span className="font-semibold text-sm">{t("app.title")} · Hub</span>
          <span
            className={
              "px-2 py-0.5 rounded text-[11px] font-semibold " +
              (settings?.event_state === "live"
                ? "bg-success/15 text-success"
                : "bg-warning/15 text-warning")
            }
          >
            {settings?.event_state?.toUpperCase() ?? "PRACTICE"}
          </span>
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={
                "flex items-center gap-2.5 px-3 py-2.5 rounded-card text-sm font-medium text-left " +
                (active ? "bg-accent text-white" : "text-text hover:bg-bg")
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            clearSession();
            router.replace("/login");
          }}
          className="mt-auto flex items-center gap-2.5 px-3 py-2.5 rounded-card text-sm font-medium text-muted hover:bg-bg"
        >
          <LogOut className="w-4 h-4" />
          <span>{t("common.sign_out")}</span>
        </button>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col pb-20 lg:pb-0">
        {tab === "leaderboard" && (
          <div className="p-4 lg:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{t("hub.tab_leaderboard")}</h1>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent/15 text-accent">
                  {scoring.provisional ? t("hub.provisional") : t("hub.final")}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={searchInputRef}
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("hub.search_placeholder")}
                  className="h-10 px-3 rounded-card border border-border bg-surface text-sm w-44"
                />
                <select
                  value={churchFilter}
                  onChange={(e) => setChurchFilter(e.target.value)}
                  aria-label="Filter by church"
                  className="h-10 px-3 rounded-card border border-border bg-surface text-sm"
                >
                  <option value="ALL">{t("hub.all_churches")}</option>
                  {churches.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {scoring.variant_warnings.length > 0 && (
              <div className="flex items-center gap-2 p-3 rounded-card bg-warning/15 text-warning text-sm font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  {t("hub.variant_warning")}:{" "}
                  {scoring.variant_warnings
                    .map((w) => w.variant + " (" + w.attempt_count + ")")
                    .join(", ")}
                </span>
              </div>
            )}

            {filteredRows.length === 0 ? (
              <p className="text-sm text-muted py-8 text-center bg-surface border border-border rounded-card">
                {t("hub.empty_teams")}
              </p>
            ) : (
              <div className="bg-surface border border-border rounded-card shadow-soft overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="border-b border-border text-xs text-muted">
                    {table.getHeaderGroups().map((hg) => (
                      <tr key={hg.id}>
                        {hg.headers.map((header) => (
                          <th
                            key={header.id}
                            onClick={header.column.getToggleSortingHandler()}
                            className="px-3 py-2.5 font-semibold cursor-pointer select-none whitespace-nowrap"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </th>
                        ))}
                      </tr>
                    ))}
                  </thead>
                  <tbody className="divide-y divide-border">
                    {table.getRowModel().rows.map((row, idx) => (
                      <tr
                        key={row.id}
                        onClick={() => {
                          setSelectedIndex(idx);
                          setDrawerTeamId(row.original.team_id);
                        }}
                        className={
                          "cursor-pointer hover:bg-bg " + (idx === selectedIndex ? "bg-accent/5" : "")
                        }
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td key={cell.id} className="px-3 py-2.5 whitespace-nowrap">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "dispatch" && (
          <HubDispatchTab
            board={opsBoard}
            onLaunchTeam={(teamId) => updateTeamTimestamp(teamId, "started_at")}
          />
        )}

        {tab === "teams" && (
          <div className="p-4 lg:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-lg font-semibold">{t("hub.tab_teams")}</h1>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setHubScanMode("launch")}
                  className="h-9 px-3 rounded-card border border-border bg-surface text-xs font-medium inline-flex items-center gap-1.5"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{t("hub.scan_launch")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setHubScanMode("finish")}
                  className="h-9 px-3 rounded-card border border-border bg-surface text-xs font-medium inline-flex items-center gap-1.5"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{t("hub.scan_finish")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/hub/print-cards")}
                  className="h-9 px-3 rounded-card bg-accent text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>{t("common.print")}</span>
                </button>
              </div>
            </div>

            {hubScanMode && (
              <div className="max-w-sm">
                <QrScanner
                  compact
                  onScan={(code) => void handleHubQrScan(code)}
                  onClose={() => setHubScanMode(null)}
                />
              </div>
            )}

            <form
              onSubmit={handleAddTeam}
              className="bg-surface border border-border rounded-card p-4 shadow-soft grid grid-cols-1 md:grid-cols-4 gap-3"
            >
              <input
                type="number"
                required
                min={1}
                max={settings?.max_teams ?? 30}
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                placeholder="Team #"
                className="h-11 px-3 rounded-card border border-border bg-bg"
              />
              <input
                type="text"
                required
                value={newChurch}
                onChange={(e) => setNewChurch(e.target.value)}
                placeholder="Church"
                className="h-11 px-3 rounded-card border border-border bg-bg"
              />
              <input
                type="text"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                placeholder="Team name (optional)"
                className="h-11 px-3 rounded-card border border-border bg-bg"
              />
              <button type="submit" className="h-11 px-4 rounded-card bg-accent text-white font-semibold">
                {t("hub.add_team")}
              </button>
              {formMsg && <p className="text-sm text-danger md:col-span-4">{formMsg}</p>}
            </form>

            {teams.length === 0 ? (
              <p className="text-sm text-muted py-8 text-center bg-surface border border-border rounded-card">
                {t("hub.empty_teams")}
              </p>
            ) : (
              <div className="bg-surface border border-border rounded-card shadow-soft divide-y divide-border">
                {teams.map((tm) => (
                  <div key={tm.id} className="p-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                    <div>
                      <span className="font-semibold tabular-nums">#{tm.number}</span>{" "}
                      <span>{tm.church}</span>{" "}
                      <span className="text-muted text-xs">
                        (Route {String.fromCharCode(65 + (tm.route % 7))} · {tm.token})
                      </span>
                      {tm.duel_won && (
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-accent/15 text-accent text-xs font-semibold">
                          Duel won
                        </span>
                      )}
                      {tm.withdrawn && (
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-danger/15 text-danger text-xs">
                          Withdrawn
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {!tm.checked_in_at && !tm.withdrawn && (
                        <button
                          type="button"
                          onClick={() => updateTeamTimestamp(tm.id, "checked_in_at")}
                          className="h-9 px-3 rounded-card border border-border text-xs font-medium"
                        >
                          {t("hub.check_in")}
                        </button>
                      )}
                      {!tm.started_at && !tm.withdrawn && (
                        <button
                          type="button"
                          onClick={() => updateTeamTimestamp(tm.id, "started_at")}
                          className="h-9 px-3 rounded-card bg-accent text-white text-xs font-medium"
                        >
                          {t("hub.launch")}
                        </button>
                      )}
                      {tm.started_at && !tm.finished_at && !tm.withdrawn && (
                        <button
                          type="button"
                          onClick={() => updateTeamTimestamp(tm.id, "finished_at")}
                          className="h-9 px-3 rounded-card bg-success text-white text-xs font-medium"
                        >
                          {t("hub.finish")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleToggleDuelWon(tm)}
                        className={
                          "h-9 px-3 rounded-card border text-xs font-medium " +
                          (tm.duel_won
                            ? "border-accent bg-accent/15 text-accent"
                            : "border-border text-muted")
                        }
                      >
                        {tm.duel_won ? "Duel: Won" : "Duel: No"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setWithdrawTarget(tm);
                          setWithdrawReason("");
                        }}
                        className={
                          "h-9 px-3 rounded-card border text-xs font-medium " +
                          (tm.withdrawn
                            ? "border-success/40 text-success"
                            : "border-danger/40 text-danger")
                        }
                      >
                        {tm.withdrawn ? "Reinstate" : t("hub.withdraw")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "stations" && (
          <HubStationsTab
            session={session}
            stations={stations}
            attempts={attempts}
            resets={resets}
            activeStationIds={activeStationIds}
            onUpdated={() => loadAll(session)}
          />
        )}

        {tab === "roles" && <HubRolesTab session={session} />}

        {tab === "attempts" && (
          <div className="p-4 lg:p-6 space-y-6">
            <h1 className="text-lg font-semibold">{t("hub.tab_attempts")}</h1>
            {attempts.length === 0 ? (
              <p className="text-sm text-muted py-8 text-center bg-surface border border-border rounded-card">
                {t("hub.empty_attempts")}
              </p>
            ) : (
              <div className="bg-surface border border-border rounded-card shadow-soft divide-y divide-border">
                {attempts.slice(0, 60).map((att) => {
                  const tm = teams.find((x) => x.id === att.team_id);
                  return (
                    <div key={att.id} className="p-3 flex items-center justify-between gap-2 text-sm">
                      <div className="tabular-nums">
                        <span className="font-semibold">Team #{tm?.number ?? "?"}</span> · Stn{" "}
                        {att.station_id} ·{" "}
                        {att.time_ms !== null ? formatDurationMs(att.time_ms) : "—"}
                        {att.progress !== null ? " · Prog " + att.progress : ""} ·{" "}
                        {att.voided
                          ? "VOID"
                          : att.state !== "scored"
                            ? att.state.toUpperCase()
                            : att.completed
                              ? t("host.completed")
                              : t("host.dnf")}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingAttempt(att);
                          setEditVoided(att.voided);
                          setEditCompleted(att.completed === true);
                          setEditProgress(att.progress !== null ? String(att.progress) : "");
                          setEditBonus(att.bonus_correct === null ? "null" : String(att.bonus_correct));
                          setEditTimeMs(att.time_ms !== null ? String(att.time_ms) : "");
                          setEditReason("");
                        }}
                        className="h-9 px-3 rounded-card border border-border text-xs font-medium"
                      >
                        {t("common.edit")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-muted">Audit trail</h2>
              {auditLog.length === 0 ? (
                <p className="text-sm text-muted">{t("hub.empty_audit")}</p>
              ) : (
                <div className="bg-surface border border-border rounded-card divide-y divide-border text-xs">
                  {auditLog.map((log) => (
                    <div key={log.id} className="p-2.5 flex justify-between gap-2">
                      <span>
                        <strong>{log.actor_role}</strong> · {log.table_name} · {log.reason}
                      </span>
                      <span className="text-muted tabular-nums">
                        {new Date(log.ts).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "settings" && settings && (
          <div className="p-4 lg:p-6 space-y-5 max-w-xl">
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-semibold">{t("hub.tab_settings")}</h1>
              {settingsSavedMsg && (
                <span className="text-xs font-semibold text-success">{settingsSavedMsg}</span>
              )}
            </div>

            <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{t("hub.event_state")}</span>
                <div className="flex gap-2">
                  {(["practice", "live"] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => handleSettingPatch({ event_state: st }, "hub_toggle_event_state")}
                      className={
                        "h-9 px-3 rounded-card border text-xs font-semibold " +
                        (settings.event_state === st
                          ? "bg-accent text-white border-accent"
                          : "border-border")
                      }
                    >
                      {st.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="font-medium">{t("hub.n_mode")}</span>
                <div className="flex gap-2">
                  {(["provisional", "final"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => handleSettingPatch({ scoring_n_mode: mode }, "hub_toggle_n_mode")}
                      className={
                        "h-9 px-3 rounded-card border text-xs font-semibold " +
                        (settings.scoring_n_mode === mode
                          ? "bg-accent text-white border-accent"
                          : "border-border")
                      }
                    >
                      {mode.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="font-medium">{t("hub.variant_mode")}</span>
                <div className="flex gap-2">
                  {(["across", "within"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() =>
                        handleSettingPatch({ variant_ranking_mode: mode }, "hub_toggle_variant_mode")
                      }
                      className={
                        "h-9 px-3 rounded-card border text-xs font-semibold " +
                        (settings.variant_ranking_mode === mode
                          ? "bg-accent text-white border-accent"
                          : "border-border")
                      }
                    >
                      {mode.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="font-medium">{t("hub.current_variant")}</span>
                <select
                  value={settings.current_variant}
                  onChange={(e) =>
                    handleSettingPatch({ current_variant: e.target.value }, "hub_change_variant")
                  }
                  className="h-9 px-3 rounded-card border border-border bg-bg text-xs font-semibold"
                >
                  {settings.variant_labels.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              {/* Add new Station 7 variant label */}
              <form onSubmit={handleAddVariantLabel} className="pt-2 border-t border-border space-y-2">
                <span className="block text-xs font-semibold text-muted">
                  Add Station 7 Variant Label
                </span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={12}
                    value={newVariantLabel}
                    onChange={(e) => setNewVariantLabel(e.target.value)}
                    placeholder="e.g. W2, W3"
                    className="flex-1 h-10 px-3 rounded-card border border-border bg-bg text-sm"
                  />
                  <button
                    type="submit"
                    disabled={!newVariantLabel.trim()}
                    className="h-10 px-3.5 rounded-card bg-accent text-white text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-40"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add</span>
                  </button>
                </div>
              </form>

              {/* Max teams & Walk time */}
              <form onSubmit={handleSaveNumericSettings} className="pt-2 border-t border-border space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-muted">{t("hub.max_teams")}</span>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={maxTeamsInput}
                      onChange={(e) => setMaxTeamsInput(e.target.value)}
                      className="mt-1 w-full h-10 px-3 rounded-card border border-border bg-bg tabular-nums"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-muted">Walk time (s)</span>
                    <input
                      type="number"
                      min={0}
                      max={300}
                      value={walkTimeInput}
                      onChange={(e) => setWalkTimeInput(e.target.value)}
                      className="mt-1 w-full h-10 px-3 rounded-card border border-border bg-bg tabular-nums"
                    />
                  </label>
                </div>
                <button
                  type="submit"
                  className="h-10 px-4 rounded-card border border-border bg-bg text-xs font-semibold"
                >
                  {t("common.save")}
                </button>
              </form>
            </div>
          </div>
        )}

        {tab === "export" && (
          <HubExportTab
            session={session}
            scoring={scoring}
            stations={stations}
            onRefresh={() => loadAll(session)}
          />
        )}
      </div>

      {/* Team Detail Drawer */}
      {drawerTeam && drawerRow && (
        <aside className="fixed inset-y-0 right-0 w-full max-w-sm bg-surface border-l border-border shadow-soft p-5 z-40 overflow-y-auto space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold tabular-nums">Team #{drawerTeam.number}</h2>
              <p className="text-sm text-muted">{drawerTeam.church}</p>
            </div>
            <button
              type="button"
              onClick={() => setDrawerTeamId(null)}
              aria-label={t("common.close")}
              className="h-9 px-2.5 rounded-card border border-border flex items-center gap-1 text-xs"
            >
              <X className="w-4 h-4" />
              <span>{t("common.close")}</span>
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleToggleDuelWon(drawerTeam)}
              className={
                "h-9 px-3 rounded-card border text-xs font-semibold " +
                (drawerTeam.duel_won
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border text-muted")
              }
            >
              {drawerTeam.duel_won ? "Duel Winner: YES" : "Mark Duel Winner"}
            </button>
            <button
              type="button"
              onClick={() => {
                setWithdrawTarget(drawerTeam);
                setWithdrawReason("");
              }}
              className="h-9 px-3 rounded-card border border-danger/40 text-danger text-xs font-semibold"
            >
              {drawerTeam.withdrawn ? "Reinstate Team" : t("hub.withdraw")}
            </button>
          </div>

          <div className="divide-y divide-border text-sm">
            {stations.map((st) => {
              const cell = drawerRow.stations[st.id];
              return (
                <div key={st.id} className="py-2.5 flex items-center justify-between">
                  <span>
                    S{st.id} · {st.name}
                  </span>
                  <span className="tabular-nums font-medium">
                    {cell?.played ? cell.total_points.toFixed(1) + " pts" : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {/* Withdraw / Reinstate Team Modal */}
      {withdrawTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
        >
          <form
            onSubmit={handleConfirmWithdraw}
            className="w-full max-w-md bg-surface border border-border rounded-card p-5 shadow-soft space-y-4"
          >
            <h2 className="text-base font-semibold">
              {withdrawTarget.withdrawn ? "Reinstate" : t("hub.withdraw")} · Team #
              {withdrawTarget.number}
            </h2>
            <p className="text-sm text-muted">
              {withdrawTarget.withdrawn
                ? "Reinstating this team includes them in the leaderboard and Final N."
                : "Withdrawing this team excludes them from the leaderboard and Final N."}
            </p>
            <label className="block text-sm">
              <span className="text-muted">{t("hub.reason_label")}</span>
              <input
                type="text"
                required
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                placeholder={t("hub.reason_required")}
                className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setWithdrawTarget(null)}
                className="h-10 px-4 rounded-card border border-border text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={!withdrawReason.trim()}
                className={
                  "h-10 px-4 rounded-card text-white text-sm font-semibold disabled:opacity-50 " +
                  (withdrawTarget.withdrawn ? "bg-success" : "bg-danger")
                }
              >
                {t("common.save")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Attempt Modal (now supports completed & progress) */}
      {editingAttempt && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
        >
          <form
            onSubmit={handleSaveAttemptEdit}
            className="w-full max-w-md bg-surface border border-border rounded-card p-5 shadow-soft space-y-4"
          >
            <h2 className="text-base font-semibold">
              {t("common.edit")} · Stn {editingAttempt.station_id}
            </h2>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="text-muted">Outcome</span>
                <select
                  value={editCompleted ? "true" : "false"}
                  onChange={(e) => setEditCompleted(e.target.value === "true")}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg"
                >
                  <option value="true">{t("host.completed")}</option>
                  <option value="false">{t("host.dnf")}</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-muted">Time (ms)</span>
                  <input
                    type="number"
                    min={0}
                    value={editTimeMs}
                    onChange={(e) => setEditTimeMs(e.target.value)}
                    className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg tabular-nums"
                  />
                </label>
                <label className="block">
                  <span className="text-muted">Progress / Count</span>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    value={editProgress}
                    onChange={(e) => setEditProgress(e.target.value)}
                    placeholder="Empty = null"
                    className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg tabular-nums"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-muted">Bonus</span>
                <select
                  value={editBonus}
                  onChange={(e) => setEditBonus(e.target.value)}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg"
                >
                  <option value="null">N/A</option>
                  <option value="true">{t("common.correct")}</option>
                  <option value="false">{t("common.wrong")}</option>
                </select>
              </label>
              <label className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  checked={editVoided}
                  onChange={(e) => setEditVoided(e.target.checked)}
                />
                <span>{t("common.void")}</span>
              </label>
              <label className="block">
                <span className="text-muted">{t("hub.reason_label")}</span>
                <input
                  type="text"
                  required
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder={t("hub.reason_required")}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingAttempt(null)}
                className="h-11 px-4 rounded-card border border-border text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={!editReason.trim()}
                className="h-11 px-4 rounded-card bg-accent text-white text-sm font-semibold disabled:opacity-50"
              >
                {t("common.save")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Mobile / Tablet "More" Sheet exposing Attempts, Roles, Settings, Export & Sign out */}
      {moreMenuOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="lg:hidden fixed inset-0 bg-black/40 flex items-end z-50"
          onClick={() => setMoreMenuOpen(false)}
        >
          <div
            className="w-full bg-surface border-t border-border rounded-t-card p-4 safe-pb space-y-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-border">
              <span className="text-sm font-semibold">
                Hub Menu ({settings?.event_state?.toUpperCase() ?? "PRACTICE"})
              </span>
              <button
                type="button"
                onClick={() => setMoreMenuOpen(false)}
                className="h-8 px-2.5 rounded-card border border-border text-xs"
              >
                {t("common.close")}
              </button>
            </div>
            {overflowMobileTabs.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setTab(item.id);
                    setMoreMenuOpen(false);
                  }}
                  className={
                    "w-full flex items-center gap-3 px-3 py-3 rounded-card text-sm font-medium " +
                    (active ? "bg-accent text-white" : "bg-bg text-text")
                  }
                >
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                clearSession();
                router.replace("/login");
              }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-card text-sm font-medium text-danger bg-danger/10"
            >
              <LogOut className="w-4 h-4" />
              <span>{t("common.sign_out")}</span>
            </button>
          </div>
        </div>
      )}

      {/* Mobile / Tablet bottom tab bar (<1024px) */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-surface border-t border-border safe-pb flex justify-around px-1 pt-1 z-30">
        {primaryMobileTabs.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={
                "flex flex-col items-center gap-0.5 py-1.5 px-2 text-[11px] font-medium " +
                (active ? "text-accent" : "text-muted")
              }
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreMenuOpen(true)}
          className={
            "flex flex-col items-center gap-0.5 py-1.5 px-2 text-[11px] font-medium " +
            (isOverflowTabActive || moreMenuOpen ? "text-accent" : "text-muted")
          }
        >
          <Menu className="w-4 h-4" />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
`
};

console.log("==> Writing Stage 3 P1 files into " + rootDir);
for (const [relPath, content] of Object.entries(files)) {
  writeProjectFile(relPath, content);
}

console.log("\n==> Running typecheck and unit tests");
runCommand("pnpm typecheck");
runCommand("pnpm test");

console.log("\n==> Stage 3 P1 features applied and verified!");
console.log("Next, push the new migration & deploy to Vercel:");
console.log("  npx --yes supabase db push");
console.log("  git add -A && git commit -m \"feat: P0 and P1 audit fixes\" && git push");