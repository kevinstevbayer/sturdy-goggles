export type RankMode = "time_then_progress" | "count";
export type ScoringNMode = "provisional" | "final";
export type VariantRankingMode = "across" | "within";

export interface StationScoringConfig {
  id: number;
  name: string;
  rank: RankMode;
  dnf_zero?: boolean;
  bonus_on_dnf?: boolean;
  has_bonus: boolean;
}

export interface ScoringTeam {
  id: string;
  number: number;
  church: string;
  team_name: string | null;
  route: number;
  checked_in_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duel_won: boolean;
  withdrawn: boolean;
}

export interface ScoringAttempt {
  id: string;
  team_id: string;
  station_id: number;
  state: "arrived" | "started" | "ended" | "scored";
  completed: boolean | null;
  time_ms: number | null;
  progress: number | null;
  bonus_correct: boolean | null;
  variant: string | null;
  practice: boolean;
  voided: boolean;
}

export interface ScoringOptions {
  n_mode: ScoringNMode;
  variant_ranking_mode: VariantRankingMode;
}

export interface StationTeamScore {
  station_id: number;
  played: boolean;
  attempt_id: string | null;
  completed: boolean | null;
  time_ms: number | null;
  progress: number | null;
  variant: string | null;
  rank: number | null;
  n_used: number;
  game_points: number;
  bonus_points: number;
  total_points: number;
}

export interface LeaderboardRow {
  overall_rank: number;
  team_id: string;
  team_number: number;
  church: string;
  team_name: string | null;
  route_letter: string;
  stations: Record<number, StationTeamScore>;
  stations_played: number;
  first_place_count: number;
  hub_elapsed_ms: number | null;
  duel_won: boolean;
  grand_total: number;
  missing_finish_alert: boolean;
}

export interface VariantWarning {
  station_id: number;
  variant: string;
  attempt_count: number;
}

export interface ScoringResult {
  n_mode: ScoringNMode;
  variant_ranking_mode: VariantRankingMode;
  final_n: number;
  provisional: boolean;
  leaderboard: LeaderboardRow[];
  variant_warnings: VariantWarning[];
}
