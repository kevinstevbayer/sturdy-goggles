import type { ScoringResult } from "@/lib/scoring";
import type { StationConfig } from "@/lib/types/domain";

function csvEscape(val: unknown): string {
  const s = val === null || val === undefined ? "" : String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Generates RFC 4180 CSV with UTF-8 BOM for Excel & Google Sheets.
 */
export function buildLeaderboardCsv(
  scoring: ScoringResult,
  stations: StationConfig[]
): string {
  const headers: string[] = [
    "Rank",
    "Team #",
    "Church",
    "Team Name",
    "Route",
    "Mode",
    "Grand Total",
    "#1 Finishes",
    "Hub Elapsed (ms)",
    "Duel Won"
  ];

  for (const st of stations) {
    headers.push("S" + st.id + " Rank");
    headers.push("S" + st.id + " Points");
    headers.push("S" + st.id + " Bonus");
    headers.push("S" + st.id + " Time (ms)");
    headers.push("S" + st.id + " Progress");
  }

  const lines: string[] = [headers.map(csvEscape).join(",")];

  for (const row of scoring.leaderboard) {
    const cols: unknown[] = [
      row.overall_rank,
      row.team_number,
      row.church,
      row.team_name ?? "",
      row.route_letter,
      scoring.provisional ? "PROVISIONAL" : "FINAL",
      row.grand_total.toFixed(1),
      row.first_place_count,
      row.hub_elapsed_ms ?? "",
      row.duel_won ? "YES" : "NO"
    ];

    for (const st of stations) {
      const cell = row.stations[st.id];
      cols.push(cell?.rank ?? (cell?.played ? "DNF" : ""));
      cols.push(cell?.played ? cell.total_points.toFixed(1) : "0.0");
      cols.push(cell?.bonus_points ?? 0);
      cols.push(cell?.time_ms ?? "");
      cols.push(cell?.progress ?? "");
    }

    lines.push(cols.map(csvEscape).join(","));
  }

  return "\uFEFF" + lines.join("\r\n");
}
