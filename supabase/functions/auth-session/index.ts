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
