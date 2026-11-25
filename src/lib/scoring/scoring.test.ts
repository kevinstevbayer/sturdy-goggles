import { describe, expect, it } from "vitest";
import {
  computeRankPoints,
  computeScoring,
  round1,
  type ScoringAttempt,
  type ScoringTeam,
  type StationScoringConfig
} from "./index";

const STATIONS: StationScoringConfig[] = [
  { id: 1, name: "A-Frame Walker", rank: "time_then_progress", bonus_on_dnf: true, has_bonus: true },
  { id: 2, name: "Leaking Pipe", rank: "time_then_progress", bonus_on_dnf: true, has_bonus: true },
  { id: 3, name: "Half-Pipe Aqueduct", rank: "time_then_progress", bonus_on_dnf: true, has_bonus: true },
  { id: 4, name: "Swiss-Cheese Wall", rank: "time_then_progress", bonus_on_dnf: true, has_bonus: true },
  { id: 5, name: "Water Chain", rank: "time_then_progress", bonus_on_dnf: true, has_bonus: true },
  { id: 6, name: "Ricochet Planks", rank: "count", bonus_on_dnf: true, has_bonus: false },
  { id: 7, name: "Balance Scale", rank: "time_then_progress", dnf_zero: true, bonus_on_dnf: true, has_bonus: true }
];

function makeTeam(num: number, overrides: Partial<ScoringTeam> = {}): ScoringTeam {
  return {
    id: "team-" + num,
    number: num,
    church: "Church " + num,
    team_name: null,
    route: (num - 1) % 7,
    checked_in_at: "2027-01-10T09:00:00Z",
    started_at: "2027-01-10T09:10:00Z",
    finished_at: "2027-01-10T09:30:00Z",
    duel_won: false,
    withdrawn: false,
    ...overrides
  };
}

function makeAttempt(
  teamNum: number,
  stationId: number,
  overrides: Partial<ScoringAttempt> = {}
): ScoringAttempt {
  return {
    id: "att-" + teamNum + "-" + stationId + "-" + Math.random().toString(36).slice(2, 6),
    team_id: "team-" + teamNum,
    station_id: stationId,
    state: "scored",
    completed: true,
    time_ms: 60000,
    progress: null,
    bonus_correct: false,
    variant: stationId === 7 ? "W1" : null,
    practice: false,
    voided: false,
    ...overrides
  };
}

describe("computeRankPoints & round1", () => {
  it("computes N=1 as 10.0", () => {
    expect(computeRankPoints(1, 1)).toBe(10);
  });

  it("matches binding spec 1.1 example: 7th of 10 = 4.0", () => {
    expect(computeRankPoints(7, 10)).toBe(4.0);
  });

  it("rounds to 1 decimal place cleanly", () => {
    expect(round1((10 * (7 - 7 + 1)) / 7)).toBe(1.4);
    expect(computeRankPoints(2, 3)).toBe(6.7);
  });
});

describe("computeScoring", () => {
  it("handles ties sharing the better rank (1, 2, 2, 4)", () => {
    const teams = [makeTeam(1), makeTeam(2), makeTeam(3), makeTeam(4)];
    const attempts = [
      makeAttempt(1, 1, { time_ms: 50000 }),
      makeAttempt(2, 1, { time_ms: 60000 }),
      makeAttempt(3, 1, { time_ms: 60000 }),
      makeAttempt(4, 1, { time_ms: 70000 })
    ];

    const res = computeScoring(teams, [STATIONS[0]!], attempts, {
      n_mode: "provisional",
      variant_ranking_mode: "across"
    });

    const byTeam = new Map(res.leaderboard.map((r) => [r.team_number, r.stations[1]!]));
    expect(byTeam.get(1)?.rank).toBe(1);
    expect(byTeam.get(1)?.game_points).toBe(10);
    expect(byTeam.get(2)?.rank).toBe(2);
    expect(byTeam.get(2)?.game_points).toBe(7.5);
    expect(byTeam.get(3)?.rank).toBe(2);
    expect(byTeam.get(3)?.game_points).toBe(7.5);
    expect(byTeam.get(4)?.rank).toBe(4);
    expect(byTeam.get(4)?.game_points).toBe(2.5);
  });

  it("ranks completed by time ASC then non-completed by progress DESC", () => {
    const teams = [makeTeam(1), makeTeam(2), makeTeam(3), makeTeam(4)];
    const attempts = [
      makeAttempt(1, 1, { completed: true, time_ms: 80000 }),
      makeAttempt(2, 1, { completed: false, time_ms: 120000, progress: 7 }),
      makeAttempt(3, 1, { completed: false, time_ms: 120000, progress: 4 }),
      makeAttempt(4, 1, { completed: true, time_ms: 65000 })
    ];

    const res = computeScoring(teams, [STATIONS[0]!], attempts, {
      n_mode: "provisional",
      variant_ranking_mode: "across"
    });

    expect(res.leaderboard.map((r) => r.team_number)).toEqual([4, 1, 2, 3]);
  });

  it("ranks count station (Station 6) by progress DESC", () => {
    const teams = [makeTeam(1), makeTeam(2), makeTeam(3)];
    const attempts = [
      makeAttempt(1, 6, { progress: 3, bonus_correct: null }),
      makeAttempt(2, 6, { progress: 7, bonus_correct: null }),
      makeAttempt(3, 6, { progress: 5, bonus_correct: null })
    ];

    const res = computeScoring(teams, [STATIONS[5]!], attempts, {
      n_mode: "provisional",
      variant_ranking_mode: "across"
    });

    expect(res.leaderboard.map((r) => r.team_number)).toEqual([2, 3, 1]);
  });

  it("enforces dnf_zero with DNF counted in N and bonus_on_dnf=true (Spec 1.1 & 1.3)", () => {
    const teams = Array.from({ length: 10 }, (_, idx) => makeTeam(idx + 1));
    const attempts: ScoringAttempt[] = [
      ...Array.from({ length: 7 }, (_, idx) =>
        makeAttempt(idx + 1, 7, { completed: true, time_ms: 40000 + idx * 5000, bonus_correct: false })
      ),
      makeAttempt(8, 7, { completed: false, time_ms: 150000, bonus_correct: true }),
      makeAttempt(9, 7, { completed: false, time_ms: 150000, bonus_correct: false }),
      makeAttempt(10, 7, { completed: false, time_ms: 150000, bonus_correct: false })
    ];

    const res = computeScoring(teams, [STATIONS[6]!], attempts, {
      n_mode: "provisional",
      variant_ranking_mode: "across"
    });

    const byTeam = new Map(res.leaderboard.map((r) => [r.team_number, r.stations[7]!]));
    expect(byTeam.get(7)?.rank).toBe(7);
    expect(byTeam.get(7)?.n_used).toBe(10);
    expect(byTeam.get(7)?.game_points).toBe(4.0);

    expect(byTeam.get(8)?.rank).toBeNull();
    expect(byTeam.get(8)?.game_points).toBe(0);
    expect(byTeam.get(8)?.bonus_points).toBe(1);
    expect(byTeam.get(8)?.total_points).toBe(1.0);
  });

  it("respects bonus_on_dnf=false via config without special-casing", () => {
    const stationNoDnfBonus: StationScoringConfig = {
      ...STATIONS[6]!,
      bonus_on_dnf: false
    };
    const teams = [makeTeam(1)];
    const attempts = [makeAttempt(1, 7, { completed: false, bonus_correct: true })];

    const res = computeScoring(teams, [stationNoDnfBonus], attempts, {
      n_mode: "provisional",
      variant_ranking_mode: "across"
    });

    expect(res.leaderboard[0]?.stations[7]?.total_points).toBe(0);
  });

  it("excludes voided attempts, practice attempts, and withdrawn teams", () => {
    const teams = [makeTeam(1), makeTeam(2), makeTeam(3, { withdrawn: true })];
    const attempts = [
      makeAttempt(1, 1, { time_ms: 10000, voided: true }),
      makeAttempt(1, 1, { time_ms: 80000 }),
      makeAttempt(2, 1, { time_ms: 15000, practice: true }),
      makeAttempt(2, 1, { time_ms: 60000 }),
      makeAttempt(3, 1, { time_ms: 30000 })
    ];

    const res = computeScoring(teams, [STATIONS[0]!], attempts, {
      n_mode: "final",
      variant_ranking_mode: "across"
    });

    expect(res.final_n).toBe(2);
    expect(res.leaderboard.map((r) => r.team_number)).toEqual([2, 1]);
    expect(res.leaderboard[0]?.stations[1]?.n_used).toBe(2);
  });

  it("uses provisional N vs final N correctly (Spec 1.4)", () => {
    const teams = [
      makeTeam(1),
      makeTeam(2),
      makeTeam(3),
      makeTeam(4),
      makeTeam(5, { checked_in_at: null })
    ];
    const attempts = [
      makeAttempt(1, 1, { time_ms: 50000 }),
      makeAttempt(2, 1, { time_ms: 70000 })
    ];

    const prov = computeScoring(teams, [STATIONS[0]!], attempts, {
      n_mode: "provisional",
      variant_ranking_mode: "across"
    });
    const fin = computeScoring(teams, [STATIONS[0]!], attempts, {
      n_mode: "final",
      variant_ranking_mode: "across"
    });

    const provT2 = prov.leaderboard.find((r) => r.team_number === 2)!;
    const finT2 = fin.leaderboard.find((r) => r.team_number === 2)!;
    const finT3 = fin.leaderboard.find((r) => r.team_number === 3)!;

    expect(provT2.stations[1]?.n_used).toBe(2);
    expect(provT2.stations[1]?.game_points).toBe(5.0);

    expect(fin.final_n).toBe(4);
    expect(finT2.stations[1]?.n_used).toBe(4);
    expect(finT2.stations[1]?.game_points).toBe(7.5);
    expect(finT3.stations[1]?.game_points).toBe(0);
  });

  it("applies full tie-break chain: #1 finishes -> Hub elapsed (null=Inf) -> duel_won", () => {
    const tbTeams = [
      makeTeam(1, { started_at: "2027-01-10T09:00:00Z", finished_at: "2027-01-10T09:40:00Z", duel_won: false }),
      makeTeam(2, { started_at: "2027-01-10T09:00:00Z", finished_at: "2027-01-10T09:15:00Z", duel_won: false }),
      makeTeam(3, { started_at: "2027-01-10T09:00:00Z", finished_at: null, duel_won: true }),
      makeTeam(4, { started_at: "2027-01-10T09:00:00Z", finished_at: null, duel_won: false }),
      makeTeam(5, { started_at: "2027-01-10T09:00:00Z", finished_at: "2027-01-10T09:50:00Z", duel_won: false })
    ];

    const exactTieAttempts = [
      makeAttempt(1, 1, { time_ms: 40000, bonus_correct: false }),
      makeAttempt(2, 1, { time_ms: 50000, bonus_correct: true }),
      makeAttempt(3, 1, { time_ms: 50000, bonus_correct: true }),
      makeAttempt(4, 1, { time_ms: 50000, bonus_correct: true }),
      makeAttempt(5, 1, { time_ms: 90000, bonus_correct: false }),
      makeAttempt(5, 7, { completed: true, time_ms: 40000, bonus_correct: false }),
      makeAttempt(1, 7, { completed: false, time_ms: 150000, bonus_correct: false }),
      makeAttempt(2, 7, { completed: false, time_ms: 150000, bonus_correct: true }),
      makeAttempt(3, 7, { completed: false, time_ms: 150000, bonus_correct: true }),
      makeAttempt(4, 7, { completed: false, time_ms: 150000, bonus_correct: true })
    ];

    const res = computeScoring(tbTeams, [STATIONS[0]!, STATIONS[6]!], exactTieAttempts, {
      n_mode: "final",
      variant_ranking_mode: "across"
    });

    expect(res.leaderboard.map((r) => r.team_number)).toEqual([5, 1, 2, 3, 4]);
    expect(res.leaderboard.map((r) => r.overall_rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("supports Station 7 within-variant ranking and emits <5 attempts warning (Spec 1.2)", () => {
    const teams = Array.from({ length: 7 }, (_, idx) => makeTeam(idx + 1));
    const attempts = [
      makeAttempt(1, 7, { time_ms: 50000, variant: "W1" }),
      makeAttempt(2, 7, { time_ms: 60000, variant: "W1" }),
      makeAttempt(3, 7, { time_ms: 70000, variant: "W1" }),
      makeAttempt(4, 7, { time_ms: 80000, variant: "W1" }),
      makeAttempt(5, 7, { time_ms: 90000, variant: "W1" }),
      makeAttempt(6, 7, { time_ms: 110000, variant: "W2" }),
      makeAttempt(7, 7, { time_ms: 120000, variant: "W2" })
    ];

    const within = computeScoring(teams, [STATIONS[6]!], attempts, {
      n_mode: "provisional",
      variant_ranking_mode: "within"
    });

    const t1 = within.leaderboard.find((r) => r.team_number === 1)!;
    const t6 = within.leaderboard.find((r) => r.team_number === 6)!;
    const t7 = within.leaderboard.find((r) => r.team_number === 7)!;

    expect(t1.stations[7]?.rank).toBe(1);
    expect(t1.stations[7]?.game_points).toBe(10.0);
    expect(t6.stations[7]?.rank).toBe(1);
    expect(t6.stations[7]?.game_points).toBe(10.0);
    expect(t6.stations[7]?.n_used).toBe(2);
    expect(t7.stations[7]?.game_points).toBe(5.0);

    expect(within.variant_warnings).toEqual([
      { station_id: 7, variant: "W2", attempt_count: 2 }
    ]);
  });

  it("flags missing_finish_alert when a team has 7 scored attempts and null finished_at (Spec 1.5)", () => {
    const teams = [makeTeam(1, { finished_at: null })];
    const attempts = STATIONS.map((s) => makeAttempt(1, s.id, { progress: s.id === 6 ? 4 : null }));

    const res = computeScoring(teams, STATIONS, attempts, {
      n_mode: "provisional",
      variant_ranking_mode: "across"
    });

    expect(res.leaderboard[0]?.missing_finish_alert).toBe(true);
  });
});
