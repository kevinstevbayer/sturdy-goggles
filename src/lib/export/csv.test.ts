import { describe, expect, it } from "vitest";
import { computeScoring } from "@/lib/scoring";
import type { StationConfig } from "@/lib/types/domain";
import { buildLeaderboardCsv } from "./csv";

const STATIONS: StationConfig[] = [
  {
    id: 1,
    name: "A-Frame Walker",
    widget: "stopwatch_progress",
    cap_s: 120,
    rank: "time_then_progress",
    bonus_on_dnf: true,
    helpers: [],
    reset: { target_s: 60, checklist: ["Check"] },
    rule: "Rule",
    bonus: { q: "Q", a: "A" }
  }
];

describe("buildLeaderboardCsv", () => {
  it("prepends UTF-8 BOM, escapes commas/quotes per RFC 4180, and formats final rows", () => {
    const scoring = computeScoring(
      [
        {
          id: "t1",
          number: 1,
          church: 'St. Mark, "Central"',
          team_name: "Alpha",
          route: 0,
          checked_in_at: "2027-01-10T09:00:00Z",
          started_at: "2027-01-10T09:10:00Z",
          finished_at: "2027-01-10T09:30:00Z",
          duel_won: true,
          withdrawn: false
        }
      ],
      [
        {
          id: 1,
          name: "A-Frame Walker",
          rank: "time_then_progress",
          bonus_on_dnf: true,
          has_bonus: true
        }
      ],
      [
        {
          id: "a1",
          team_id: "t1",
          station_id: 1,
          state: "scored",
          completed: true,
          time_ms: 55000,
          progress: null,
          bonus_correct: true,
          variant: null,
          practice: false,
          voided: false
        }
      ],
      { n_mode: "final", variant_ranking_mode: "across" }
    );

    const csv = buildLeaderboardCsv(scoring, STATIONS);
    expect(csv.startsWith("\uFEFF")).toBe(true);

    const lines = csv.slice(1).split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Rank,Team #,Church,Team Name,Route,Mode,Grand Total");
    expect(lines[1]).toContain('"St. Mark, ""Central"""');
    expect(lines[1]).toContain(",FINAL,11.0,1,1200000,YES,1,11.0,1,55000,");
  });
});
