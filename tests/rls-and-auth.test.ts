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
