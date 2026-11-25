import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function round1(v: number): number {
  return Math.round((v + Number.EPSILON) * 10) / 10;
}

function computeRankPoints(rank: number, n: number): number {
  if (n <= 0 || rank <= 0 || rank > n) return 0;
  return round1((10 * (n - rank + 1)) / n);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "HUB_AUTH_REQUIRED" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const [tmRes, stRes, attRes, setRes] = await Promise.all([
    supabase.from("teams").select("*"),
    supabase.from("stations").select("config").order("id", { ascending: true }),
    supabase.from("attempts").select("*").eq("state", "scored").eq("practice", false).eq("voided", false),
    supabase.from("event_settings").select("*").eq("id", 1).single()
  ]);

  const teams = (tmRes.data ?? []).filter((t: Record<string, unknown>) => !t.withdrawn);
  const stations = (stRes.data ?? []).map((r: Record<string, unknown>) => r.config as Record<string, unknown>);
  const attempts = attRes.data ?? [];
  const settings = setRes.data as Record<string, unknown>;
  const finalN = teams.filter((t: Record<string, unknown>) => t.checked_in_at !== null).length;
  const variantMode = String(settings?.variant_ranking_mode ?? "across");

  // Store immutable final snapshot
  const payload = {
    finalized_at: new Date().toISOString(),
    n_final: finalN,
    variant_ranking_mode: variantMode,
    team_count: teams.length,
    attempt_count: attempts.length,
    station_count: stations.length,
    sample_top_formula_check: computeRankPoints(1, Math.max(1, finalN))
  };

  const { data: snap, error } = await supabase
    .from("final_snapshots")
    .insert({
      created_by_role: "hub",
      n_final: finalN,
      variant_ranking_mode: variantMode,
      payload
    })
    .select("*")
    .single();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Also switch scoring_n_mode to 'final'
  await supabase
    .from("event_settings")
    .update({ scoring_n_mode: "final", updated_at: new Date().toISOString() })
    .eq("id", 1);

  return new Response(JSON.stringify({ snapshot: snap }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
