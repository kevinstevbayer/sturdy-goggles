// Supabase Edge Function (Deno): Finalize Leaderboard Snapshot
// Verifies active Hub JWT, computes the authoritative final leaderboard using
// the exact scoring specification, stores an immutable snapshot in
// public.final_snapshots, switches scoring_n_mode to 'final', and audit-logs.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";
import { jwtVerify } from "https://esm.sh/jose@5.9.6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET =
  Deno.env.get("APP_JWT_SECRET") ??
  Deno.env.get("SUPABASE_JWT_SECRET") ??
  Deno.env.get("JWT_SECRET") ??
  "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

interface StationScoringConfig {
  id: number;
  name: string;
  rank: "time_then_progress" | "count";
  dnf_zero?: boolean;
  bonus_on_dnf?: boolean;
  has_bonus: boolean;
}

interface ScoringTeam {
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

interface ScoringAttempt {
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

interface StationTeamScore {
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

interface LeaderboardRow {
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

interface VariantWarning {
  station_id: number;
  variant: string;
  attempt_count: number;
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function computeRankPoints(rank: number, n: number): number {
  if (n <= 0 || rank <= 0 || rank > n) return 0;
  return round1((10 * (n - rank + 1)) / n);
}

function routeToLetter(route: number): string {
  const normalized = ((route % 7) + 7) % 7;
  return String.fromCharCode(65 + normalized);
}

function compareAttempts(
  a: ScoringAttempt,
  b: ScoringAttempt,
  station: StationScoringConfig
): number {
  if (station.rank === "count") {
    return (b.progress ?? 0) - (a.progress ?? 0);
  }
  const aComp = a.completed === true;
  const bComp = b.completed === true;
  if (aComp !== bComp) return aComp ? -1 : 1;
  if (aComp && bComp) {
    return (a.time_ms ?? Number.MAX_SAFE_INTEGER) - (b.time_ms ?? Number.MAX_SAFE_INTEGER);
  }
  return (b.progress ?? 0) - (a.progress ?? 0);
}

function computeBonusPoints(
  attempt: ScoringAttempt,
  station: StationScoringConfig
): number {
  if (!station.has_bonus || attempt.bonus_correct !== true) return 0;
  const allowBonusOnDnf = station.bonus_on_dnf ?? true;
  return attempt.completed === true || allowBonusOnDnf ? 1 : 0;
}

function scoreAttemptGroup(
  group: ScoringAttempt[],
  station: StationScoringConfig,
  denominatorN: number
): Map<string, StationTeamScore> {
  const scores = new Map<string, StationTeamScore>();
  const isDnfZero = station.dnf_zero === true;
  const rankable: ScoringAttempt[] = [];
  const unrankedDnf: ScoringAttempt[] = [];

  for (const att of group) {
    if (isDnfZero && att.completed !== true) {
      unrankedDnf.push(att);
    } else {
      rankable.push(att);
    }
  }

  rankable.sort((a, b) => compareAttempts(a, b, station));

  let currentRank = 1;
  for (let i = 0; i < rankable.length; i++) {
    const att = rankable[i]!;
    if (i > 0 && compareAttempts(rankable[i - 1]!, att, station) !== 0) {
      currentRank = i + 1;
    }
    const gamePoints = computeRankPoints(currentRank, denominatorN);
    const bonusPoints = computeBonusPoints(att, station);

    scores.set(att.team_id, {
      station_id: station.id,
      played: true,
      attempt_id: att.id,
      completed: att.completed,
      time_ms: att.time_ms,
      progress: att.progress,
      variant: att.variant,
      rank: currentRank,
      n_used: denominatorN,
      game_points: gamePoints,
      bonus_points: bonusPoints,
      total_points: round1(gamePoints + bonusPoints)
    });
  }

  for (const att of unrankedDnf) {
    const bonusPoints = computeBonusPoints(att, station);
    scores.set(att.team_id, {
      station_id: station.id,
      played: true,
      attempt_id: att.id,
      completed: att.completed,
      time_ms: att.time_ms,
      progress: att.progress,
      variant: att.variant,
      rank: null,
      n_used: denominatorN,
      game_points: 0,
      bonus_points: bonusPoints,
      total_points: round1(bonusPoints)
    });
  }

  return scores;
}

function computeFinalScoring(
  teams: ScoringTeam[],
  stations: StationScoringConfig[],
  attempts: ScoringAttempt[],
  variantRankingMode: "across" | "within"
) {
  const activeTeams = teams.filter((t) => !t.withdrawn);
  const activeTeamIds = new Set(activeTeams.map((t) => t.id));
  const finalN = activeTeams.filter((t) => t.checked_in_at !== null).length;

  const validAttempts = attempts.filter(
    (a) => a.state === "scored" && !a.practice && !a.voided && activeTeamIds.has(a.team_id)
  );

  const attemptsByStation = new Map<number, ScoringAttempt[]>();
  for (const st of stations) {
    attemptsByStation.set(st.id, []);
  }
  for (const att of validAttempts) {
    attemptsByStation.get(att.station_id)?.push(att);
  }

  const variantWarnings: VariantWarning[] = [];
  const stationScoresByStation = new Map<number, Map<string, StationTeamScore>>();

  for (const station of stations) {
    const stAttempts = attemptsByStation.get(station.id) ?? [];
    const useWithinVariant = station.id === 7 && variantRankingMode === "within";

    if (useWithinVariant) {
      const byVariant = new Map<string, ScoringAttempt[]>();
      for (const att of stAttempts) {
        const label = att.variant ?? "default";
        const bucket = byVariant.get(label) ?? [];
        bucket.push(att);
        byVariant.set(label, bucket);
      }

      const merged = new Map<string, StationTeamScore>();
      for (const [variantLabel, group] of byVariant.entries()) {
        if (group.length > 0 && group.length < 5) {
          variantWarnings.push({
            station_id: station.id,
            variant: variantLabel,
            attempt_count: group.length
          });
        }
        const groupScores = scoreAttemptGroup(group, station, group.length);
        for (const [teamId, cell] of groupScores.entries()) {
          merged.set(teamId, cell);
        }
      }
      stationScoresByStation.set(station.id, merged);
    } else {
      const scored = scoreAttemptGroup(stAttempts, station, finalN);
      stationScoresByStation.set(station.id, scored);
    }
  }

  const rows: LeaderboardRow[] = activeTeams.map((team) => {
    const stationCells: Record<number, StationTeamScore> = {};
    let grandTotal = 0;
    let firstPlaceCount = 0;
    let stationsPlayed = 0;

    for (const station of stations) {
      const cell = stationScoresByStation.get(station.id)?.get(team.id);
      if (cell) {
        stationCells[station.id] = cell;
        grandTotal += cell.total_points;
        stationsPlayed += 1;
        if (cell.rank === 1) firstPlaceCount += 1;
      } else {
        stationCells[station.id] = {
          station_id: station.id,
          played: false,
          attempt_id: null,
          completed: null,
          time_ms: null,
          progress: null,
          variant: null,
          rank: null,
          n_used: finalN,
          game_points: 0,
          bonus_points: 0,
          total_points: 0
        };
      }
    }

    let hubElapsedMs: number | null = null;
    if (team.started_at !== null && team.finished_at !== null) {
      const diff = Date.parse(team.finished_at) - Date.parse(team.started_at);
      if (!Number.isNaN(diff) && diff >= 0) {
        hubElapsedMs = diff;
      }
    }

    return {
      overall_rank: 0,
      team_id: team.id,
      team_number: team.number,
      church: team.church,
      team_name: team.team_name,
      route_letter: routeToLetter(team.route),
      stations: stationCells,
      stations_played: stationsPlayed,
      first_place_count: firstPlaceCount,
      hub_elapsed_ms: hubElapsedMs,
      duel_won: team.duel_won,
      grand_total: round1(grandTotal),
      missing_finish_alert: stationsPlayed === stations.length && team.finished_at === null
    };
  });

  const compareRankOrder = (a: LeaderboardRow, b: LeaderboardRow): number => {
    if (a.grand_total !== b.grand_total) return b.grand_total - a.grand_total;
    if (a.first_place_count !== b.first_place_count) {
      return b.first_place_count - a.first_place_count;
    }
    const aElapsed = a.hub_elapsed_ms ?? Number.POSITIVE_INFINITY;
    const bElapsed = b.hub_elapsed_ms ?? Number.POSITIVE_INFINITY;
    if (aElapsed !== bElapsed) return aElapsed - bElapsed;
    if (a.duel_won !== b.duel_won) return a.duel_won ? -1 : 1;
    return 0;
  };

  rows.sort((a, b) => {
    const cmp = compareRankOrder(a, b);
    return cmp !== 0 ? cmp : a.team_number - b.team_number;
  });

  let rank = 1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i > 0 && compareRankOrder(rows[i - 1]!, row) !== 0) {
      rank = i + 1;
    }
    row.overall_rank = rank;
  }

  return {
    final_n: finalN,
    variant_ranking_mode: variantRankingMode,
    leaderboard: rows,
    variant_warnings: variantWarnings,
    attempt_count: validAttempts.length
  };
}

async function verifyHubCaller(
  req: Request,
  supabase: SupabaseClient
): Promise<{ ok: true; sessionId: string } | { ok: false }> {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return { ok: false };
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return { ok: false };

  try {
    const key = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    const appRole = typeof payload.app_role === "string" ? payload.app_role : null;
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
    if (appRole !== "hub" || !sessionId) return { ok: false };

    const { data: activeSession } = await supabase
      .from("role_sessions")
      .select("session_id")
      .eq("session_id", sessionId)
      .eq("role", "hub")
      .is("revoked_at", null)
      .maybeSingle();

    return activeSession ? { ok: true, sessionId } : { ok: false };
  } catch {
    return { ok: false };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!JWT_SECRET) return jsonResponse({ error: "SERVER_MISCONFIGURED_JWT_SECRET" }, 500);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const hub = await verifyHubCaller(req, supabase);
  if (!hub.ok) {
    return jsonResponse({ error: "HUB_AUTH_REQUIRED" }, 403);
  }

  const [tmRes, stRes, attRes, setRes] = await Promise.all([
    supabase.from("teams").select("*"),
    supabase.from("stations").select("config").order("id", { ascending: true }),
    supabase
      .from("attempts")
      .select("*")
      .eq("state", "scored")
      .eq("practice", false)
      .eq("voided", false),
    supabase.from("event_settings").select("*").eq("id", 1).single()
  ]);

  if (tmRes.error || stRes.error || attRes.error || setRes.error) {
    return jsonResponse({ error: "DATA_FETCH_FAILED" }, 500);
  }

  const teams = (tmRes.data ?? []) as ScoringTeam[];
  const stationConfigs: StationScoringConfig[] = (stRes.data ?? []).map(
    (r: { config: Record<string, unknown> }) => ({
      id: Number(r.config.id),
      name: String(r.config.name ?? ""),
      rank: r.config.rank === "count" ? "count" : "time_then_progress",
      dnf_zero: r.config.dnf_zero === true,
      bonus_on_dnf: r.config.bonus_on_dnf !== false,
      has_bonus: r.config.bonus !== null && r.config.bonus !== undefined
    })
  );
  const attempts = (attRes.data ?? []) as ScoringAttempt[];
  const settings = setRes.data as Record<string, unknown>;
  const variantMode =
    settings?.variant_ranking_mode === "within" ? "within" : "across";

  const computed = computeFinalScoring(teams, stationConfigs, attempts, variantMode);

  const payload = {
    finalized_at: new Date().toISOString(),
    n_final: computed.final_n,
    variant_ranking_mode: computed.variant_ranking_mode,
    team_count: computed.leaderboard.length,
    attempt_count: computed.attempt_count,
    station_count: stationConfigs.length,
    variant_warnings: computed.variant_warnings,
    leaderboard: computed.leaderboard
  };

  const { data: snap, error } = await supabase
    .from("final_snapshots")
    .insert({
      created_by_role: "hub",
      n_final: computed.final_n,
      variant_ranking_mode: computed.variant_ranking_mode,
      payload
    })
    .select("*")
    .single();

  if (error || !snap) {
    return jsonResponse({ error: error?.message ?? "SNAPSHOT_INSERT_FAILED" }, 400);
  }

  await Promise.all([
    supabase
      .from("event_settings")
      .update({ scoring_n_mode: "final", updated_at: new Date().toISOString() })
      .eq("id", 1),
    supabase.from("audit_log").insert({
      actor_role: "hub",
      table_name: "final_snapshots",
      row_id: String(snap.id),
      before: null,
      after: { n_final: computed.final_n, variant_ranking_mode: computed.variant_ranking_mode },
      reason: "hub_finalize_snapshot"
    })
  ]);

  return jsonResponse({ snapshot: snap }, 200);
});
