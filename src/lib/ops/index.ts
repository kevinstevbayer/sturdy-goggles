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
