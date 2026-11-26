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
