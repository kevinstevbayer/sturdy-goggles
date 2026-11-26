"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";
import { computeStationResetStats, deriveStationState, type ResetLogInput } from "@/lib/reset";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { AttemptRow, RoleSession, StationConfig } from "@/lib/types/domain";

interface HubStationsTabProps {
  session: RoleSession;
  stations: StationConfig[];
  attempts: AttemptRow[];
  resets: ResetLogInput[];
  activeStationIds: Set<number>;
  onUpdated: () => Promise<void>;
}

export function HubStationsTab({
  session,
  stations,
  attempts,
  resets,
  activeStationIds,
  onUpdated
}: HubStationsTabProps) {
  const [editing, setEditing] = useState<StationConfig | null>(null);
  const [capS, setCapS] = useState("120");
  const [targetS, setTargetS] = useState("60");
  const [checklistText, setChecklistText] = useState("");

  function startEdit(st: StationConfig) {
    setEditing(st);
    setCapS(String(st.cap_s));
    setTargetS(String(st.reset.target_s));
    setChecklistText(st.reset.checklist.join("\n"));
  }

  async function saveEdit() {
    if (!editing) return;
    const updated: StationConfig = {
      ...editing,
      cap_s: Math.max(15, Number.parseInt(capS, 10) || editing.cap_s),
      reset: {
        target_s: Math.max(10, Number.parseInt(targetS, 10) || editing.reset.target_s),
        checklist: checklistText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      }
    };
    const supabase = getSupabaseClient(session);
    await supabase.from("stations").update({ config: updated }).eq("id", editing.id);
    setEditing(null);
    await onUpdated();
  }

  const nowMs = Date.now();

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <h1 className="text-lg font-semibold">{t("hub.tab_stations")}</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {stations.map((st) => {
          const stats = computeStationResetStats(st.id, resets);
          const stAttempts = attempts.filter((a) => a.station_id === st.id && !a.voided && !a.practice);
          const hasInPlay = stAttempts.some((a) => a.state !== "scored");
          const scored = stAttempts.filter((a) => a.state === "scored" && a.ended_at);
          const lastEnded =
            scored.length > 0
              ? Math.max(...scored.map((a) => Date.parse(a.ended_at!)))
              : null;
          const stResets = resets
            .filter((r) => r.station_id === st.id)
            .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
          const lastReset = stResets[0] ?? null;

          const state = deriveStationState({
            hasActiveSession: activeStationIds.has(st.id),
            hasInPlayAttempt: hasInPlay,
            lastScoredEndedAtMs: lastEnded,
            lastResetDoneAtMs: lastReset?.done_at ? Date.parse(lastReset.done_at) : null,
            lastResetSkipped: lastReset?.skipped ?? false,
            lastResetStartedAtMs: lastReset?.started_at ? Date.parse(lastReset.started_at) : null,
            targetResetS: st.reset.target_s,
            nowMs
          });

          const badgeClass =
            state === "ready"
              ? "bg-success/15 text-success"
              : state === "in-play"
                ? "bg-accent/15 text-accent"
                : state === "resetting"
                  ? "bg-warning/15 text-warning"
                  : "bg-danger/15 text-danger";

          return (
            <div key={st.id} className="bg-surface border border-border rounded-card p-4 shadow-soft space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-muted font-medium">Station {st.id}</p>
                  <h2 className="text-base font-semibold">{st.name}</h2>
                </div>
                <span className={"px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase " + badgeClass}>
                  {state}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs bg-bg p-2.5 rounded-card tabular-nums">
                <div>
                  <p className="text-muted">{t("hub.reset_avg")}</p>
                  <p className="font-semibold">{stats.avg_reset_s !== null ? stats.avg_reset_s + "s" : "—"}</p>
                </div>
                <div>
                  <p className="text-muted">{t("hub.reset_max")}</p>
                  <p className="font-semibold">{stats.max_reset_s !== null ? stats.max_reset_s + "s" : "—"}</p>
                </div>
                <div>
                  <p className="text-muted">{t("hub.reset_skipped")}</p>
                  <p className="font-semibold">{stats.skipped_pct}%</p>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-muted">
                <span className="tabular-nums">Cap {st.cap_s}s · Reset {st.reset.target_s}s</span>
                <button
                  type="button"
                  onClick={() => startEdit(st)}
                  className="h-8 px-3 rounded-card border border-border text-text font-medium"
                >
                  {t("common.edit")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-md bg-surface border border-border rounded-card p-5 shadow-soft space-y-4">
            <h2 className="text-base font-semibold">
              {t("common.edit")} · Station {editing.id}
            </h2>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="text-muted">Cap (s)</span>
                <input
                  type="number"
                  value={capS}
                  onChange={(e) => setCapS(e.target.value)}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg tabular-nums"
                />
              </label>
              <label className="block">
                <span className="text-muted">Reset target (s)</span>
                <input
                  type="number"
                  value={targetS}
                  onChange={(e) => setTargetS(e.target.value)}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg tabular-nums"
                />
              </label>
              <label className="block">
                <span className="text-muted">Checklist (one per line)</span>
                <textarea
                  rows={4}
                  value={checklistText}
                  onChange={(e) => setChecklistText(e.target.value)}
                  className="mt-1 w-full p-3 rounded-card border border-border bg-bg"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="h-10 px-4 rounded-card border border-border text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={saveEdit}
                className="h-10 px-4 rounded-card bg-accent text-white text-sm font-semibold"
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
