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
