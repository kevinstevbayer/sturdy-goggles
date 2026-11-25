import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RoleSession } from "@/lib/types/domain";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "local-dev-anon-key-placeholder";

let cachedToken: string | null = null;
let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(session: RoleSession | null): SupabaseClient {
  const token = session?.access_token ?? null;
  if (cachedClient && cachedToken === token) {
    return cachedClient;
  }

  cachedToken = token;
  cachedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: token
      ? {
          headers: {
            Authorization: "Bearer " + token
          }
        }
      : undefined
  });

  return cachedClient;
}

export async function callAuthSession(
  body: Record<string, unknown>,
  bearerToken?: string
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY
  };
  if (bearerToken) {
    headers.Authorization = "Bearer " + bearerToken;
  }

  const res = await fetch(SUPABASE_URL + "/functions/v1/auth-session", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

