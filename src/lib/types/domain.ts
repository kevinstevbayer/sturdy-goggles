export type AppRole =
  | "station_1"
  | "station_2"
  | "station_3"
  | "station_4"
  | "station_5"
  | "station_6"
  | "station_7"
  | "hub"
  | "floater";

export interface RoleSession {
  access_token: string;
  role: AppRole;
  station_id: number | null;
  session_id: string;
}

export type WidgetKind = "stopwatch_progress" | "counter_countdown" | "hover_hold";

export interface ProgressTapsConfig {
  kind: "taps";
  unit: string;
  values: number[];
}

export interface ProgressStepperConfig {
  kind: "stepper";
  unit: string;
  min: number;
  max: number;
  step: number;
}

export interface StationHelperConfig {
  id: string;
  type: "hold_overlay" | "counter" | "hover_reset";
  hold_s?: number;
}

export interface StationConfig {
  id: number;
  name: string;
  widget: WidgetKind;
  cap_s: number;
  rank: "time_then_progress" | "count";
  dnf_zero?: boolean;
  bonus_on_dnf?: boolean;
  hover?: { hold_s: number };
  progress?: ProgressTapsConfig | ProgressStepperConfig;
  helpers: StationHelperConfig[];
  reset: {
    target_s: number;
    checklist: string[];
  };
  rule: string;
  bonus: { q: string; a: string } | null;
}

export interface TeamPublic {
  id: string;
  number: number;
  church: string;
  team_name: string | null;
  token: string;
  route: number;
  withdrawn: boolean;
}

export interface TeamRow extends TeamPublic {
  checked_in_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duel_won: boolean;
  created_at: string;
}

export interface AttemptRow {
  id: string;
  team_id: string;
  station_id: number;
  state: "arrived" | "started" | "ended" | "scored";
  arrived_at: string;
  started_at: string | null;
  ended_at: string | null;
  scored_at: string | null;
  completed: boolean | null;
  time_ms: number | null;
  progress: number | null;
  counters: Record<string, number>;
  bonus_correct: boolean | null;
  variant: string | null;
  practice: boolean;
  voided: boolean;
  version: number;
  session_id: string;
  client_server_skew_flagged?: boolean;
}

export interface EventSettingsRow {
  id: number;
  event_state: "practice" | "live";
  max_teams: number;
  scoring_n_mode: "provisional" | "final";
  variant_ranking_mode: "across" | "within";
  current_variant: string;
  variant_labels: string[];
  walk_time_s: number;
  updated_at: string;
}

export interface AuditLogRow {
  id: number;
  ts: string;
  actor_role: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
  reason: string;
}
