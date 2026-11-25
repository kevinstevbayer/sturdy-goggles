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

describe("computeOpsBoard (alerts & continuous dispatch)", () => {
  it("flags attempt_over_cap_10s, team_overdue_240s, wrong_station_scan, and reset_over_target_with_inbound", () => {
    const nowMs = Date.parse("2027-01-10T10:00:00Z");
    const teams = [
      makeTeam(1, { started_at: "2027-01-10T09:50:00Z" }),
      makeTeam(2, { started_at: "2027-01-10T09:50:00Z" }),
      makeTeam(3, { started_at: "2027-01-10T09:50:00Z" })
    ];

    const attempts: AttemptRow[] = [
      // Team 1 over cap by 20s at Stn 1 (cap 120s -> started 140s ago)
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
      // Team 2 finished Stn 2 300s ago -> overdue (>240s) heading to Stn 3
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
      // Team 3 (route 2 -> expects Stn 3) scanned at Stn 5 -> wrong_station_scan
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
      // Stn 3 had a prior attempt end 90s ago (>60s target) with no reset done -> reset_over_target_with_inbound
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

  it("suggests the next safe-to-launch team and blocks launch when station is busy", () => {
    const nowMs = Date.parse("2027-01-10T10:00:00Z");
    const teams = [makeTeam(1), makeTeam(2)];
    const snap = computeOpsBoard({
      stations: STATIONS,
      teams,
      attempts: [],
      resets: [],
      activeStationIds: new Set([2]), // Only Stn 2 online -> Team 1 (Stn 1) not safe, Team 2 (Stn 2) safe
      walkTimeS: 30,
      nowMs
    });

    expect(snap.routes[0]?.safe_to_launch).toBe(false);
    expect(snap.routes[1]?.safe_to_launch).toBe(true);
    expect(snap.suggested_team?.number).toBe(2);
  });
});
