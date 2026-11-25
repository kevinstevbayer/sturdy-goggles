"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Clock, LogOut, Radio } from "lucide-react";
import { clearSession, loadSession } from "@/lib/auth/session";
import { t } from "@/lib/i18n";
import { computeOpsBoard } from "@/lib/ops";
import type { ResetLogInput } from "@/lib/reset";
import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  AttemptRow,
  EventSettingsRow,
  RoleSession,
  StationConfig,
  TeamRow
} from "@/lib/types/domain";

export function FloaterApp() {
  const router = useRouter();
  const [session, setSession] = useState<RoleSession | null>(null);
  const [stations, setStations] = useState<StationConfig[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [resets, setResets] = useState<ResetLogInput[]>([]);
  const [activeStationIds, setActiveStationIds] = useState<Set<number>>(new Set());
  const [settings, setSettings] = useState<EventSettingsRow | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const s = loadSession();
    if (!s || (s.role !== "floater" && s.role !== "hub")) {
      router.replace("/login");
      return;
    }
    setSession(s);

    const supabase = getSupabaseClient(s);
    async function load() {
      const [stRes, tmRes, attRes, rstRes, sessRes, setRes] = await Promise.all([
        supabase.from("stations").select("config").order("id", { ascending: true }),
        supabase.from("teams").select("*").order("number", { ascending: true }),
        supabase.from("attempts").select("*").order("updated_at", { ascending: false }),
        supabase.from("station_resets").select("id,station_id,started_at,done_at,items_done,skipped").order("started_at", { ascending: false }),
        supabase.from("role_sessions").select("station_id").is("revoked_at", null).not("station_id", "is", null),
        supabase.from("event_settings").select("*").eq("id", 1).maybeSingle()
      ]);
      if (stRes.data) setStations(stRes.data.map((r) => r.config as StationConfig));
      if (tmRes.data) setTeams(tmRes.data as TeamRow[]);
      if (attRes.data) setAttempts(attRes.data as AttemptRow[]);
      if (rstRes.data) setResets(rstRes.data as ResetLogInput[]);
      if (sessRes.data) setActiveStationIds(new Set(sessRes.data.map((r) => Number(r.station_id))));
      if (setRes.data) setSettings(setRes.data as EventSettingsRow);
    }

    void load();

    const channel = supabase
      .channel("floater-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "attempts" }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "station_resets" }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, () => void load())
      .subscribe();

    const pollId = window.setInterval(() => {
      setNowMs(Date.now());
      void load();
    }, 5000);
    const clockId = window.setInterval(() => setNowMs(Date.now()), 1000);

    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(pollId);
      window.clearInterval(clockId);
    };
  }, [router]);

  const board = useMemo(
    () =>
      computeOpsBoard({
        stations,
        teams,
        attempts,
        resets,
        activeStationIds,
        walkTimeS: settings?.walk_time_s ?? 30,
        nowMs
      }),
    [stations, teams, attempts, resets, activeStationIds, settings, nowMs]
  );

  if (!session) return null;

  return (
    <div className="min-h-[100dvh] bg-bg flex flex-col">
      <header className="safe-pt px-4 pb-3 border-b border-border bg-surface flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-accent" />
          <h1 className="text-base font-semibold">{t("floater.title")}</h1>
        </div>
        <button
          type="button"
          onClick={() => {
            clearSession();
            router.replace("/login");
          }}
          className="h-9 px-3 rounded-card border border-border text-xs text-muted inline-flex items-center gap-1"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>{t("common.sign_out")}</span>
        </button>
      </header>

      <main className="flex-1 p-4 max-w-2xl w-full mx-auto space-y-5 safe-pb">
        {/* Alerts */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase text-muted">
            {t("floater.alerts_title")} ({board.alerts.length})
          </h2>
          {board.alerts.length === 0 ? (
            <p className="text-sm text-muted bg-surface border border-border rounded-card p-3">
              {t("hub.empty_alerts")}
            </p>
          ) : (
            <div className="space-y-2">
              {board.alerts.map((al) => (
                <div
                  key={al.id}
                  className={
                    "p-3 rounded-card border text-sm flex items-start gap-2.5 " +
                    (al.severity === "danger"
                      ? "bg-danger/10 border-danger/40 text-danger"
                      : "bg-warning/10 border-warning/40 text-warning")
                  }
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">{al.label}</p>
                    <p className="text-xs opacity-90">{al.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Station Board */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase text-muted">{t("floater.stations_title")}</h2>
          <div className="space-y-2.5">
            {board.stations.map((st) => {
              const badgeClass =
                st.state === "ready"
                  ? "bg-success/15 text-success"
                  : st.state === "in-play"
                    ? "bg-accent/15 text-accent"
                    : st.state === "resetting"
                      ? "bg-warning/15 text-warning"
                      : "bg-danger/15 text-danger";

              return (
                <div key={st.station_id} className="bg-surface border border-border rounded-card p-3.5 shadow-soft space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm">
                      S{st.station_id} · {st.name}
                    </span>
                    <span className={"px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase " + badgeClass}>
                      {st.state}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted tabular-nums">
                    {st.state === "in-play" ? (
                      <span className="inline-flex items-center gap-1 text-text font-medium">
                        <Clock className="w-3.5 h-3.5" />
                        Team #{st.active_team_number ?? "?"} · {st.in_play_elapsed_s ?? 0}s / {st.cap_s}s
                      </span>
                    ) : st.state === "resetting" ? (
                      <span className="inline-flex items-center gap-1 text-warning font-medium">
                        <Clock className="w-3.5 h-3.5" />
                        Reset {st.reset_elapsed_s ?? 0}s / {st.reset_target_s}s
                      </span>
                    ) : (
                      <span>Cap {st.cap_s}s</span>
                    )}

                    <span>
                      {st.inbound.length > 0
                        ? "Inbound: " + st.inbound.map((i) => "#" + i.team_number).join(", ")
                        : t("host.no_inbound")}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
