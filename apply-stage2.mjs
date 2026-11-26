import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Stage 2 (P0 Host Lifecycle, Crash Recovery & Edge-Case Fixes) Apply Script
 * Save as D:\Programming\app\apply-stage2.mjs and run:
 *   node apply-stage2.mjs
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

const files = {
  "src/lib/reset/index.ts": `
export interface ResetLogInput {
  id: string;
  station_id: number;
  started_at: string;
  done_at: string | null;
  items_done: number;
  skipped: boolean;
}

export interface StationResetStats {
  station_id: number;
  total_resets: number;
  completed_resets: number;
  skipped_resets: number;
  skipped_pct: number;
  avg_reset_s: number | null;
  max_reset_s: number | null;
}

export type StationBoardState = "ready" | "in-play" | "resetting" | "offline";

export function computeStationResetStats(
  stationId: number,
  logs: ResetLogInput[]
): StationResetStats {
  const mine = logs.filter((l) => l.station_id === stationId);
  const total = mine.length;
  const skipped = mine.filter((l) => l.skipped).length;
  const durations: number[] = [];

  for (const row of mine) {
    if (!row.skipped && row.done_at) {
      const diffMs = Date.parse(row.done_at) - Date.parse(row.started_at);
      if (!Number.isNaN(diffMs) && diffMs >= 0) {
        durations.push(diffMs / 1000);
      }
    }
  }

  const avg =
    durations.length > 0
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null;
  const max =
    durations.length > 0 ? Math.round(Math.max(...durations) * 10) / 10 : null;

  return {
    station_id: stationId,
    total_resets: total,
    completed_resets: durations.length,
    skipped_resets: skipped,
    skipped_pct: total > 0 ? Math.round((skipped / total) * 100) : 0,
    avg_reset_s: avg,
    max_reset_s: max
  };
}

/**
 * Derive live station board state for Hub and Floater:
 * - offline: no active session for this station
 * - in-play: has an active attempt in arrived|started|ended
 * - resetting: last scored attempt ended < target_s ago and no done/skipped reset AFTER it
 * - ready: otherwise (after Reset done/skipped for this attempt OR after target_s elapsed)
 */
export function deriveStationState(params: {
  hasActiveSession: boolean;
  hasInPlayAttempt: boolean;
  lastScoredEndedAtMs: number | null;
  lastResetDoneAtMs: number | null;
  lastResetSkipped: boolean;
  lastResetStartedAtMs: number | null;
  targetResetS: number;
  nowMs: number;
}): StationBoardState {
  if (!params.hasActiveSession) return "offline";
  if (params.hasInPlayAttempt) return "in-play";
  if (params.lastScoredEndedAtMs === null) return "ready";

  const doneAfterLastAttempt =
    params.lastResetDoneAtMs !== null &&
    params.lastResetDoneAtMs >= params.lastScoredEndedAtMs;

  const skippedAfterLastAttempt =
    params.lastResetSkipped &&
    params.lastResetStartedAtMs !== null &&
    params.lastResetStartedAtMs >= params.lastScoredEndedAtMs;

  if (doneAfterLastAttempt || skippedAfterLastAttempt) return "ready";

  const elapsedResetS = (params.nowMs - params.lastScoredEndedAtMs) / 1000;
  if (elapsedResetS < params.targetResetS) {
    return "resetting";
  }
  return "ready";
}

/**
 * Route r (0..6) visits stations ((r + i) mod 7) + 1 for i = 0..6.
 */
export function getRouteOrder(route: number): number[] {
  const norm = ((route % 7) + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => ((norm + i) % 7) + 1);
}

/**
 * Returns the next expected station ID on a team's route given stations already played.
 */
export function getExpectedNextStation(route: number, playedStationIds: number[]): number | null {
  const order = getRouteOrder(route);
  const played = new Set(playedStationIds);
  for (const stId of order) {
    if (!played.has(stId)) return stId;
  }
  return null;
}
`,

  "src/lib/reset/reset.test.ts": `
import { describe, expect, it } from "vitest";
import {
  computeStationResetStats,
  deriveStationState,
  getExpectedNextStation,
  getRouteOrder
} from "./index";

describe("reset stats, station state & route order", () => {
  it("computes average, max, and skipped % accurately", () => {
    const stats = computeStationResetStats(1, [
      {
        id: "r1",
        station_id: 1,
        started_at: "2027-01-10T09:00:00Z",
        done_at: "2027-01-10T09:00:40Z",
        items_done: 2,
        skipped: false
      },
      {
        id: "r2",
        station_id: 1,
        started_at: "2027-01-10T09:05:00Z",
        done_at: "2027-01-10T09:06:20Z",
        items_done: 2,
        skipped: false
      },
      {
        id: "r3",
        station_id: 1,
        started_at: "2027-01-10T09:10:00Z",
        done_at: null,
        items_done: 1,
        skipped: true
      }
    ]);

    expect(stats.total_resets).toBe(3);
    expect(stats.completed_resets).toBe(2);
    expect(stats.skipped_resets).toBe(1);
    expect(stats.skipped_pct).toBe(33);
    expect(stats.avg_reset_s).toBe(60);
    expect(stats.max_reset_s).toBe(80);
  });

  it("transitions resetting -> ready after Reset done or after target_s", () => {
    const base = 1_000_000;
    expect(
      deriveStationState({
        hasActiveSession: true,
        hasInPlayAttempt: false,
        lastScoredEndedAtMs: base,
        lastResetDoneAtMs: null,
        lastResetSkipped: false,
        lastResetStartedAtMs: null,
        targetResetS: 60,
        nowMs: base + 30_000
      })
    ).toBe("resetting");

    expect(
      deriveStationState({
        hasActiveSession: true,
        hasInPlayAttempt: false,
        lastScoredEndedAtMs: base,
        lastResetDoneAtMs: null,
        lastResetSkipped: false,
        lastResetStartedAtMs: null,
        targetResetS: 60,
        nowMs: base + 61_000
      })
    ).toBe("ready");

    expect(
      deriveStationState({
        hasActiveSession: true,
        hasInPlayAttempt: false,
        lastScoredEndedAtMs: base,
        lastResetDoneAtMs: base + 20_000,
        lastResetSkipped: false,
        lastResetStartedAtMs: base,
        targetResetS: 60,
        nowMs: base + 25_000
      })
    ).toBe("ready");
  });

  it("does NOT mark station ready if lastResetSkipped belonged to an earlier attempt", () => {
    const attempt1End = 1_000_000;
    const attempt2End = 1_200_000;

    // Prior reset was skipped at attempt1End, now attempt2 just ended 15s ago -> must be resetting
    expect(
      deriveStationState({
        hasActiveSession: true,
        hasInPlayAttempt: false,
        lastScoredEndedAtMs: attempt2End,
        lastResetDoneAtMs: null,
        lastResetSkipped: true,
        lastResetStartedAtMs: attempt1End,
        targetResetS: 60,
        nowMs: attempt2End + 15_000
      })
    ).toBe("resetting");

    // Once a skipped reset is recorded for attempt2 (>= attempt2End) -> ready
    expect(
      deriveStationState({
        hasActiveSession: true,
        hasInPlayAttempt: false,
        lastScoredEndedAtMs: attempt2End,
        lastResetDoneAtMs: null,
        lastResetSkipped: true,
        lastResetStartedAtMs: attempt2End,
        targetResetS: 60,
        nowMs: attempt2End + 15_000
      })
    ).toBe("ready");
  });

  it("computes route order and expected next station", () => {
    expect(getRouteOrder(0)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(getRouteOrder(2)).toEqual([3, 4, 5, 6, 7, 1, 2]);
    expect(getExpectedNextStation(2, [3, 4])).toBe(5);
    expect(getExpectedNextStation(2, [3, 4, 5, 6, 7, 1, 2])).toBeNull();
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

    if (activeAtt) {
      const playedIds = scoredAtts.map((a) => a.station_id);
      const expected = getExpectedNextStation(team.route, playedIds);
      if (expected !== null && activeAtt.station_id !== expected) {
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
            expected +
            ")"
        });
      }
      continue;
    }

    if (team.finished_at !== null || scoredAtts.length === 0 || scoredAtts.length >= stations.length) {
      continue;
    }

    const lastScored = scoredAtts[scoredAtts.length - 1]!;
    const lastEndedMs = Date.parse(lastScored.ended_at ?? lastScored.scored_at ?? lastScored.arrived_at);
    if (Number.isNaN(lastEndedMs)) continue;

    const nextStationId = (lastScored.station_id % 7) + 1;
    const alreadyPlayedNext = scoredAtts.some((a) => a.station_id === nextStationId);
    if (alreadyPlayedNext) continue;

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

  "src/components/hub/HubStationsTab.tsx": `
"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";
import { computeStationResetStats, deriveStationState, type ResetLogInput } from "@/lib/reset";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { AttemptRow, RoleSession, StationConfig } from "@/lib/types/domain";

interface HubStationsTabProps {
  session: RoleSession;
  stations: StationConfig[];
  attempts: AttemptRow[];
  resets: ResetLogInput[];
  activeStationIds: Set<number>;
  onUpdated: () => Promise<void>;
}

export function HubStationsTab({
  session,
  stations,
  attempts,
  resets,
  activeStationIds,
  onUpdated
}: HubStationsTabProps) {
  const [editing, setEditing] = useState<StationConfig | null>(null);
  const [capS, setCapS] = useState("120");
  const [targetS, setTargetS] = useState("60");
  const [checklistText, setChecklistText] = useState("");

  function startEdit(st: StationConfig) {
    setEditing(st);
    setCapS(String(st.cap_s));
    setTargetS(String(st.reset.target_s));
    setChecklistText(st.reset.checklist.join("\\n"));
  }

  async function saveEdit() {
    if (!editing) return;
    const updated: StationConfig = {
      ...editing,
      cap_s: Math.max(15, Number.parseInt(capS, 10) || editing.cap_s),
      reset: {
        target_s: Math.max(10, Number.parseInt(targetS, 10) || editing.reset.target_s),
        checklist: checklistText
          .split(/\\r?\\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      }
    };
    const supabase = getSupabaseClient(session);
    await supabase.from("stations").update({ config: updated }).eq("id", editing.id);
    setEditing(null);
    await onUpdated();
  }

  const nowMs = Date.now();

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <h1 className="text-lg font-semibold">{t("hub.tab_stations")}</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {stations.map((st) => {
          const stats = computeStationResetStats(st.id, resets);
          const stAttempts = attempts.filter((a) => a.station_id === st.id && !a.voided && !a.practice);
          const hasInPlay = stAttempts.some((a) => a.state !== "scored");
          const scored = stAttempts.filter((a) => a.state === "scored" && a.ended_at);
          const lastEnded =
            scored.length > 0
              ? Math.max(...scored.map((a) => Date.parse(a.ended_at!)))
              : null;
          const stResets = resets
            .filter((r) => r.station_id === st.id)
            .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
          const lastReset = stResets[0] ?? null;

          const state = deriveStationState({
            hasActiveSession: activeStationIds.has(st.id),
            hasInPlayAttempt: hasInPlay,
            lastScoredEndedAtMs: lastEnded,
            lastResetDoneAtMs: lastReset?.done_at ? Date.parse(lastReset.done_at) : null,
            lastResetSkipped: lastReset?.skipped ?? false,
            lastResetStartedAtMs: lastReset?.started_at ? Date.parse(lastReset.started_at) : null,
            targetResetS: st.reset.target_s,
            nowMs
          });

          const badgeClass =
            state === "ready"
              ? "bg-success/15 text-success"
              : state === "in-play"
                ? "bg-accent/15 text-accent"
                : state === "resetting"
                  ? "bg-warning/15 text-warning"
                  : "bg-danger/15 text-danger";

          return (
            <div key={st.id} className="bg-surface border border-border rounded-card p-4 shadow-soft space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-muted font-medium">Station {st.id}</p>
                  <h2 className="text-base font-semibold">{st.name}</h2>
                </div>
                <span className={"px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase " + badgeClass}>
                  {state}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs bg-bg p-2.5 rounded-card tabular-nums">
                <div>
                  <p className="text-muted">{t("hub.reset_avg")}</p>
                  <p className="font-semibold">{stats.avg_reset_s !== null ? stats.avg_reset_s + "s" : "—"}</p>
                </div>
                <div>
                  <p className="text-muted">{t("hub.reset_max")}</p>
                  <p className="font-semibold">{stats.max_reset_s !== null ? stats.max_reset_s + "s" : "—"}</p>
                </div>
                <div>
                  <p className="text-muted">{t("hub.reset_skipped")}</p>
                  <p className="font-semibold">{stats.skipped_pct}%</p>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-muted">
                <span className="tabular-nums">Cap {st.cap_s}s · Reset {st.reset.target_s}s</span>
                <button
                  type="button"
                  onClick={() => startEdit(st)}
                  className="h-8 px-3 rounded-card border border-border text-text font-medium"
                >
                  {t("common.edit")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-md bg-surface border border-border rounded-card p-5 shadow-soft space-y-4">
            <h2 className="text-base font-semibold">
              {t("common.edit")} · Station {editing.id}
            </h2>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="text-muted">Cap (s)</span>
                <input
                  type="number"
                  value={capS}
                  onChange={(e) => setCapS(e.target.value)}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg tabular-nums"
                />
              </label>
              <label className="block">
                <span className="text-muted">Reset target (s)</span>
                <input
                  type="number"
                  value={targetS}
                  onChange={(e) => setTargetS(e.target.value)}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg tabular-nums"
                />
              </label>
              <label className="block">
                <span className="text-muted">Checklist (one per line)</span>
                <textarea
                  rows={4}
                  value={checklistText}
                  onChange={(e) => setChecklistText(e.target.value)}
                  className="mt-1 w-full p-3 rounded-card border border-border bg-bg"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="h-10 px-4 rounded-card border border-border text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={saveEdit}
                className="h-10 px-4 rounded-card bg-accent text-white text-sm font-semibold"
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
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
import { offlineDb } from "@/lib/offline/db";
import { cacheStations, cacheTeams, enqueueWrite, flushOutbox } from "@/lib/offline/outbox";
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

  // Widget overlays / hover state (timestamp-derived, zero interval drift)
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

  // Load session, restore any interrupted attempt, & bootstrap caches (runs once on mount)
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

      // Crash / reload recovery for an in-progress attempt on this session
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

      const res = await flushOutbox(s!);
      setPendingCount(res.pendingCount);
    }

    void hydrate();

    const onOnline = () => {
      setOnline(true);
      void flushOutbox(s).then((r) => setPendingCount(r.pendingCount));
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
      const r = await flushOutbox(s);
      setPendingCount(r.pendingCount);
      if (lastSubmittedIdRef.current) {
        const ob = await offlineDb.outbox.get(lastSubmittedIdRef.current);
        if (ob?.status === "synced") setLastAttemptSynced(true);
      }
    }, 5000);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(pollId);
    };
  }, [router]);

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
        // Initialize stepper stations (e.g., Station 2) to min (0 cm) so 0 cm DNF is immediately submittable
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

      // Timestamp-derived hold_overlay countdown (Spec 2.3: clock keeps running, cap overrides)
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
      const r = await flushOutbox(session);
      setPendingCount(r.pendingCount);
    },
    [session, station, resetId, resetStartedAtMs, clockOffsetMs, lastSubmittedId]
  );

  // Unified team resolver (works from QR token OR manual team #, online OR offline)
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

      // Check already-played (Spec 2.2: hard-block)
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

      // Write 'arrived' lifecycle state so Hub/Floater see team presence & off-route scans immediately
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
      const flushRes = await flushOutbox(session);
      setPendingCount(flushRes.pendingCount);
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
      settings
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

    // Write 'started' lifecycle state so Hub/Floater see in-play + over-cap alerts
    // and auth-session enforces 409 TAKEOVER_BLOCKED_ATTEMPT_STARTED
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
    const flushRes = await flushOutbox(session);
    setPendingCount(flushRes.pendingCount);
  }

  async function handleCancelBeforeStart() {
    if (session && attemptId) {
      const ob = await offlineDb.outbox.get(attemptId);
      if (ob && ob.status !== "synced") {
        // Never hit Postgres -> remove cleanly from local outbox & local_attempts
        await offlineDb.outbox.delete(attemptId);
        await offlineDb.local_attempts.delete(attemptId);
      } else if (navigator.onLine) {
        // Already synced as 'arrived' -> void via audit-logged RPC
        const supabase = getSupabaseClient(session);
        await supabase.rpc("host_cancel_before_start", { p_attempt_id: attemptId });
        await offlineDb.local_attempts.update(attemptId, { voided: true });
      }
      await offlineDb.meta.delete(ACTIVE_RUN_META_KEY);
      const pending = await offlineDb.outbox.where("status").notEqual("synced").count();
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

    const res = await flushOutbox(session);
    setPendingCount(res.pendingCount);
    const ob = await offlineDb.outbox.get(attemptId);
    if (ob?.status === "synced") setLastAttemptSynced(true);
  }

  async function handleUndo() {
    if (!session || !lastSubmittedId) return;
    setUndoError(null);
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
`
};

console.log("==> Writing Stage 2 P0 files into " + rootDir);
for (const [relPath, content] of Object.entries(files)) {
  writeProjectFile(relPath, content);
}

console.log("\n==> Running typecheck and unit tests");
runCommand("pnpm typecheck");
runCommand("pnpm test");
console.log("\n==> Stage 2 P0 fixes applied and verified!");