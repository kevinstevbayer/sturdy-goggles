import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Stage 1 (P0 Backend Security, Finalize Snapshot & DB Grants) Apply Script
 * Save as D:\Programming\app\apply-stage1.mjs and run:
 *   node apply-stage1.mjs
 */

const rootDir = process.cwd();

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.replace(/^\n/, ""), "utf8");
  console.log("  wrote " + relativePath);
}

function runCommand(cmd) {
  console.log("\n> " + cmd);
  execSync(cmd, { stdio: "inherit", shell: true });
}

const files = {
  "supabase/functions/auth-session/index.ts": `
// Supabase Edge Function (Deno): Role Link / PIN / Takeover QR -> 12h Signed JWT
// Enforces cryptographic Hub JWT verification on all admin actions, single active
// device per role, takeover blocking during active 'started' attempts, and
// immediate session revocation.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";
import { jwtVerify, SignJWT } from "https://esm.sh/jose@5.9.6";

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

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSecret(length = 24): string {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz23456789";
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

function randomPin(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0]! % 1_000_000).padStart(6, "0");
}

async function mintRoleJwt(params: {
  role: string;
  station_id: number | null;
  session_id: string;
}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(JWT_SECRET);

  return await new SignJWT({
    aud: "authenticated",
    role: "authenticated",
    app_role: params.role,
    station_id: params.station_id,
    session_id: params.session_id,
    sub: params.session_id
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 12 * 60 * 60)
    .sign(key);
}

async function verifyHubCaller(
  req: Request,
  supabase: SupabaseClient
): Promise<{ ok: true; sessionId: string } | { ok: false }> {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false };
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return { ok: false };
  }

  try {
    const key = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    const appRole = typeof payload.app_role === "string" ? payload.app_role : null;
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;

    if (appRole !== "hub" || !sessionId) {
      return { ok: false };
    }

    const { data: activeSession } = await supabase
      .from("role_sessions")
      .select("session_id")
      .eq("session_id", sessionId)
      .eq("role", "hub")
      .is("revoked_at", null)
      .maybeSingle();

    if (!activeSession) {
      return { ok: false };
    }

    return { ok: true, sessionId };
  } catch {
    return { ok: false };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
  }
  if (!JWT_SECRET) {
    return jsonResponse({ error: "SERVER_MISCONFIGURED_JWT_SECRET" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "INVALID_JSON" }, 400);
  }

  const action = String(payload.action ?? "login");
  const ipRaw = req.headers.get("x-forwarded-for") ?? "unknown";
  const ipHash = await sha256Hex(ipRaw);

  if (action === "list_roles") {
    const hub = await verifyHubCaller(req, supabase);
    if (!hub.ok) {
      return jsonResponse({ error: "HUB_AUTH_REQUIRED" }, 403);
    }

    const { data, error } = await supabase
      .from("role_credentials")
      .select("role, station_id, secret_token, pin_code")
      .order("role", { ascending: true });

    if (error) {
      return jsonResponse({ error: "LIST_ROLES_FAILED", detail: error.message }, 500);
    }
    return jsonResponse({ roles: data ?? [] });
  }

  if (action === "create_takeover") {
    const hub = await verifyHubCaller(req, supabase);
    const targetRole = String(payload.target_role ?? "");
    if (!hub.ok || !targetRole) {
      return jsonResponse({ error: "HUB_AUTH_REQUIRED" }, 403);
    }

    const { data: cred } = await supabase
      .from("role_credentials")
      .select("role, station_id")
      .eq("role", targetRole)
      .maybeSingle();

    if (!cred) {
      return jsonResponse({ error: "ROLE_NOT_FOUND" }, 404);
    }

    const token = randomSecret(20);
    const { error: insErr } = await supabase.from("takeover_tokens").insert({
      token,
      role: cred.role,
      station_id: cred.station_id
    });

    if (insErr) {
      return jsonResponse({ error: "TAKEOVER_CREATE_FAILED", detail: insErr.message }, 500);
    }

    return jsonResponse({ token, role: cred.role });
  }

  if (action === "regenerate") {
    const hub = await verifyHubCaller(req, supabase);
    const targetRole = String(payload.target_role ?? "");
    if (!hub.ok || !targetRole) {
      return jsonResponse({ error: "HUB_AUTH_REQUIRED" }, 403);
    }

    const newSecret = randomSecret(24);
    const newPin = randomPin();

    const { error: updErr } = await supabase
      .from("role_credentials")
      .update({
        secret_token: newSecret,
        pin_code: newPin,
        updated_at: new Date().toISOString()
      })
      .eq("role", targetRole);

    if (updErr) {
      return jsonResponse({ error: "REGENERATE_FAILED", detail: updErr.message }, 400);
    }

    await supabase
      .from("role_sessions")
      .update({
        revoked_at: new Date().toISOString(),
        revoked_reason: "credentials_regenerated"
      })
      .eq("role", targetRole)
      .is("revoked_at", null);

    return jsonResponse({ role: targetRole, secret_token: newSecret, pin_code: newPin });
  }

  const secret = typeof payload.secret === "string" ? payload.secret.trim() : null;
  const pin = typeof payload.pin === "string" ? payload.pin.trim() : null;
  let takeoverToken =
    typeof payload.takeover_token === "string" ? payload.takeover_token.trim() : null;
  if (!takeoverToken && secret && secret.startsWith("takeover-")) {
    takeoverToken = secret.slice("takeover-".length);
  }
  const hubOverrideRequested = payload.hub_override === true;

  let hubOverrideAuthorized = false;
  if (hubOverrideRequested) {
    const hub = await verifyHubCaller(req, supabase);
    if (!hub.ok) {
      return jsonResponse({ error: "HUB_AUTH_REQUIRED" }, 403);
    }
    hubOverrideAuthorized = true;
  }

  if (pin !== null) {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const { count } = await supabase
      .from("pin_attempts")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .eq("succeeded", false)
      .gte("attempted_at", cutoff);

    if ((count ?? 0) >= 5) {
      return jsonResponse({ error: "PIN_RATE_LIMITED" }, 429);
    }
  }

  let matchedRole: { role: string; station_id: number | null; pin_code: string } | null = null;
  let usedTakeoverQr = false;

  if (takeoverToken) {
    const { data: tk } = await supabase
      .from("takeover_tokens")
      .select("token, role, station_id, expires_at, used_at")
      .eq("token", takeoverToken)
      .maybeSingle();

    if (!tk || tk.used_at !== null || Date.parse(tk.expires_at) < Date.now()) {
      return jsonResponse({ error: "INVALID_OR_EXPIRED_TAKEOVER_TOKEN" }, 401);
    }

    const { data: cred } = await supabase
      .from("role_credentials")
      .select("role, station_id, pin_code")
      .eq("role", tk.role)
      .single();

    matchedRole = cred;
    usedTakeoverQr = true;
  } else if (secret) {
    const { data: cred } = await supabase
      .from("role_credentials")
      .select("role, station_id, pin_code")
      .eq("secret_token", secret)
      .maybeSingle();

    matchedRole = cred;
  } else if (pin) {
    const { data: cred } = await supabase
      .from("role_credentials")
      .select("role, station_id, pin_code")
      .eq("pin_code", pin)
      .maybeSingle();

    await supabase.from("pin_attempts").insert({
      ip_hash: ipHash,
      role: cred?.role ?? null,
      succeeded: Boolean(cred)
    });

    matchedRole = cred;
  }

  if (!matchedRole) {
    return jsonResponse({ error: "INVALID_CREDENTIALS" }, 401);
  }

  const { data: activeSessions } = await supabase
    .from("role_sessions")
    .select("session_id")
    .eq("role", matchedRole.role)
    .is("revoked_at", null);

  const hasActiveDevice = (activeSessions?.length ?? 0) > 0;

  if (hasActiveDevice && !usedTakeoverQr) {
    if (!pin || pin !== matchedRole.pin_code) {
      return jsonResponse({ error: "PIN_REQUIRED_FOR_TAKEOVER" }, 403);
    }
  }

  if (hasActiveDevice && matchedRole.station_id !== null && !hubOverrideAuthorized) {
    const { count: startedCount } = await supabase
      .from("attempts")
      .select("id", { count: "exact", head: true })
      .eq("station_id", matchedRole.station_id)
      .eq("state", "started")
      .eq("voided", false);

    if ((startedCount ?? 0) > 0) {
      return jsonResponse({ error: "TAKEOVER_BLOCKED_ATTEMPT_STARTED" }, 409);
    }
  }

  if (usedTakeoverQr && takeoverToken) {
    await supabase
      .from("takeover_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("token", takeoverToken);
  }

  if (hasActiveDevice) {
    await supabase
      .from("role_sessions")
      .update({ revoked_at: new Date().toISOString(), revoked_reason: "device_takeover" })
      .eq("role", matchedRole.role)
      .is("revoked_at", null);
  }

  const { data: createdSession, error: sessErr } = await supabase
    .from("role_sessions")
    .insert({
      role: matchedRole.role,
      station_id: matchedRole.station_id
    })
    .select("session_id")
    .single();

  if (sessErr || !createdSession) {
    return jsonResponse({ error: "SESSION_CREATE_FAILED" }, 500);
  }

  const jwt = await mintRoleJwt({
    role: matchedRole.role,
    station_id: matchedRole.station_id,
    session_id: createdSession.session_id
  });

  return jsonResponse({
    access_token: jwt,
    role: matchedRole.role,
    station_id: matchedRole.station_id,
    session_id: createdSession.session_id
  });
});
`,

  "supabase/functions/finalize/index.ts": `
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
`,

  "supabase/migrations/20261127000001_grants.sql": `
-- =============================================================================
-- Explicit Schema, Table, Sequence, and View GRANTs for Supabase Roles
-- Ensures clean deployments even when "Grant API access automatically" is off.
-- All row-level access remains strictly enforced by RLS policies.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.event_settings,
  public.role_sessions,
  public.stations,
  public.teams,
  public.attempts,
  public.station_resets,
  public.audit_log,
  public.final_snapshots
TO authenticated;

GRANT SELECT ON public.teams_public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
`,

  "tests/rls-and-auth.test.ts": `
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";

const hasEnv = Boolean(ANON_KEY && SERVICE_ROLE_KEY);

async function mintTestJwt(role: string, stationId: number | null, sessionId: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    aud: "authenticated",
    role: "authenticated",
    app_role: role,
    station_id: stationId,
    session_id: sessionId,
    sub: sessionId
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3600)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function clientWithJwt(jwt: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + jwt } }
  });
}

describe.skipIf(!hasEnv)("Phase 1 RLS, Auth & Practice Guard Integration", () => {
  let admin: SupabaseClient;
  let st1SessionId: string;
  let st1Jwt: string;
  let st1Client: SupabaseClient;
  let hubJwt: string;
  let hubClient: SupabaseClient;
  let sampleTeamId: string;

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: st1Sess } = await admin
      .from("role_sessions")
      .insert({ role: "station_1", station_id: 1 })
      .select("session_id")
      .single();
    st1SessionId = st1Sess!.session_id;
    st1Jwt = await mintTestJwt("station_1", 1, st1SessionId);
    st1Client = clientWithJwt(st1Jwt);

    const { data: hubSess } = await admin
      .from("role_sessions")
      .insert({ role: "hub", station_id: null })
      .select("session_id")
      .single();
    hubJwt = await mintTestJwt("hub", null, hubSess!.session_id);
    hubClient = clientWithJwt(hubJwt);

    const { data: team } = await admin.from("teams").select("id").eq("number", 30).single();
    sampleTeamId = team!.id;
  });

  it("blocks a Station 1 host from writing to Station 2 and reading rankings/teams", async () => {
    const { error: insertErr } = await st1Client.from("attempts").insert({
      id: crypto.randomUUID(),
      team_id: sampleTeamId,
      station_id: 2,
      state: "arrived",
      session_id: st1SessionId
    });
    expect(insertErr).not.toBeNull();

    const { data: st2Attempts } = await st1Client
      .from("attempts")
      .select("id")
      .eq("station_id", 2);
    expect(st2Attempts ?? []).toHaveLength(0);

    const { data: rawTeams } = await st1Client.from("teams").select("id, duel_won");
    expect(rawTeams ?? []).toHaveLength(0);

    const { data: pubTeams, error: pubErr } = await st1Client
      .from("teams_public")
      .select("number, church, token, route, withdrawn")
      .limit(5);
    expect(pubErr).toBeNull();
    expect((pubTeams ?? []).length).toBeGreaterThan(0);

    const { data: snaps } = await st1Client.from("final_snapshots").select("id");
    expect(snaps ?? []).toHaveLength(0);
  });

  it("enforces Practice Guard when event_state is set to live", async () => {
    const { error: liveErr } = await hubClient.rpc("hub_update_event_settings", {
      p_patch: { event_state: "live" },
      p_reason: "integration_test_live"
    });
    expect(liveErr).toBeNull();

    const { error: pracErr } = await st1Client.from("attempts").insert({
      id: crypto.randomUUID(),
      team_id: sampleTeamId,
      station_id: 1,
      state: "arrived",
      practice: true,
      session_id: st1SessionId
    });
    expect(pracErr?.message).toContain("PRACTICE_FORBIDDEN_IN_LIVE_MODE");

    await hubClient.rpc("hub_update_event_settings", {
      p_patch: { event_state: "practice" },
      p_reason: "integration_test_cleanup"
    });
  });

  it("revoking a session immediately blocks writes and delivers revocation state", async () => {
    const { data: tempSess } = await admin
      .from("role_sessions")
      .insert({ role: "station_2", station_id: 2 })
      .select("session_id")
      .single();

    const tempClient = clientWithJwt(await mintTestJwt("station_2", 2, tempSess!.session_id));

    await admin
      .from("role_sessions")
      .update({ revoked_at: new Date().toISOString(), revoked_reason: "test_revoke" })
      .eq("session_id", tempSess!.session_id);

    const { data: selfSess } = await tempClient
      .from("role_sessions")
      .select("revoked_at")
      .eq("session_id", tempSess!.session_id)
      .single();
    expect(selfSess?.revoked_at).not.toBeNull();

    const { error: writeAfterRevoke } = await tempClient.from("station_resets").insert({
      id: crypto.randomUUID(),
      station_id: 2,
      started_at: new Date().toISOString(),
      session_id: tempSess!.session_id
    });
    expect(writeAfterRevoke).not.toBeNull();
  });

  it("auth-session Edge Function enforces PIN takeover and blocks takeover during started attempt", async () => {
    const fnUrl = SUPABASE_URL + "/functions/v1/auth-session";

    const noPinRes = await fetch(fnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ action: "login", secret: "sec-st1-dev-0001" })
    });
    expect(noPinRes.status).toBe(403);

    const startedId = crypto.randomUUID();
    await admin.from("attempts").insert({
      id: startedId,
      team_id: sampleTeamId,
      station_id: 1,
      state: "started",
      practice: true,
      session_id: st1SessionId
    });

    const blockedRes = await fetch(fnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ action: "login", pin: "100101" })
    });
    expect(blockedRes.status).toBe(409);

    await admin.from("attempts").delete().eq("id", startedId);
  });

  it("rejects forged and non-hub Bearer tokens on auth-session admin actions", async () => {
    const fnUrl = SUPABASE_URL + "/functions/v1/auth-session";

    const forgedList = await fetch(fnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: "Bearer forged-token"
      },
      body: JSON.stringify({ action: "list_roles", caller_role: "hub" })
    });
    expect(forgedList.status).toBe(403);

    const hostRegen = await fetch(fnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: "Bearer " + st1Jwt
      },
      body: JSON.stringify({ action: "regenerate", target_role: "station_2" })
    });
    expect(hostRegen.status).toBe(403);

    const hubList = await fetch(fnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: "Bearer " + hubJwt
      },
      body: JSON.stringify({ action: "list_roles" })
    });
    expect(hubList.status).toBe(200);
    const listBody = (await hubList.json()) as { roles?: unknown[] };
    expect(Array.isArray(listBody.roles)).toBe(true);
    expect((listBody.roles ?? []).length).toBeGreaterThanOrEqual(9);
  });

  it("finalize rejects non-hub callers and stores a full leaderboard snapshot for Hub", async () => {
    const finalizeUrl = SUPABASE_URL + "/functions/v1/finalize";

    const forgedRes = await fetch(finalizeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: "Bearer fake"
      }
    });
    expect(forgedRes.status).toBe(403);

    const hostRes = await fetch(finalizeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: "Bearer " + st1Jwt
      }
    });
    expect(hostRes.status).toBe(403);

    const hubRes = await fetch(finalizeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: "Bearer " + hubJwt
      }
    });
    expect(hubRes.status).toBe(200);
    const body = (await hubRes.json()) as {
      snapshot?: { id: string; n_final: number; payload?: { leaderboard?: unknown[] } };
    };
    expect(body.snapshot?.id).toBeTruthy();
    expect(Array.isArray(body.snapshot?.payload?.leaderboard)).toBe(true);
    expect((body.snapshot?.payload?.leaderboard ?? []).length).toBeGreaterThan(0);

    if (body.snapshot?.id) {
      await admin.from("final_snapshots").delete().eq("id", body.snapshot.id);
    }
    await hubClient.rpc("hub_update_event_settings", {
      p_patch: { scoring_n_mode: "provisional" },
      p_reason: "integration_test_cleanup"
    });
  });
});
`
};

console.log("==> Writing Stage 1 P0 files into " + rootDir);
for (const [relPath, content] of Object.entries(files)) {
  writeProjectFile(relPath, content);
}

console.log("\n==> Running typecheck and unit tests");
runCommand("pnpm typecheck");
runCommand("pnpm test");

console.log("\n==> Stage 1 files applied. Next, deploy to Supabase:");
console.log('  $env:SUPABASE_ACCESS_TOKEN="<YOUR_SBP_TOKEN>"');
console.log("  npx --yes supabase db push");
console.log("  npx --yes supabase functions deploy auth-session --no-verify-jwt");
console.log("  npx --yes supabase functions deploy finalize --no-verify-jwt");