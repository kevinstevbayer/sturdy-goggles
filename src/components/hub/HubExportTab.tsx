"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Download, Trash2 } from "lucide-react";
import { buildLeaderboardCsv } from "@/lib/export/csv";
import { t } from "@/lib/i18n";
import type { ScoringResult } from "@/lib/scoring";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { RoleSession, StationConfig } from "@/lib/types/domain";

interface SnapshotRow {
  id: string;
  created_at: string;
  n_final: number;
  variant_ranking_mode: string;
}

interface HubExportTabProps {
  session: RoleSession;
  scoring: ScoringResult;
  stations: StationConfig[];
  onRefresh: () => Promise<void>;
}

export function HubExportTab({ session, scoring, stations, onRefresh }: HubExportTabProps) {
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [purgeReason, setPurgeReason] = useState("");

  async function loadSnapshots() {
    const supabase = getSupabaseClient(session);
    const { data } = await supabase
      .from("final_snapshots")
      .select("id,created_at,n_final,variant_ranking_mode")
      .order("created_at", { ascending: false })
      .limit(10);
    if (data) setSnapshots(data as SnapshotRow[]);
  }

  useEffect(() => {
    void loadSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFinalize() {
    setStatusMsg(null);
    const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321") + "/functions/v1/finalize";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
        Authorization: "Bearer " + session.access_token
      }
    });
    if (res.ok) {
      setStatusMsg("Snapshot saved");
      await loadSnapshots();
      await onRefresh();
    } else {
      setStatusMsg("Finalize failed");
    }
  }

  function handleDownloadCsv() {
    const csv = buildLeaderboardCsv(scoring, stations);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "treasure-hunt-2027-" + (scoring.provisional ? "provisional" : "final") + ".csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function handlePurgePractice() {
    if (!purgeReason.trim()) return;
    const supabase = getSupabaseClient(session);
    const { data, error } = await supabase.rpc("hub_purge_practice_attempts", {
      p_reason: purgeReason.trim()
    });
    if (!error) {
      setStatusMsg("Deleted " + String(data ?? 0) + " practice rows");
      setPurgeReason("");
      await onRefresh();
    }
  }

  return (
    <div className="p-4 lg:p-6 space-y-6 max-w-2xl">
      <h1 className="text-lg font-semibold">{t("hub.tab_export")}</h1>

      <div className="bg-surface border border-border rounded-card p-5 shadow-soft flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleFinalize()}
          className="h-11 px-4 rounded-card bg-accent text-white text-sm font-semibold inline-flex items-center gap-2"
        >
          <CheckCircle2 className="w-4 h-4" />
          <span>{t("hub.finalize_now")}</span>
        </button>
        <button
          type="button"
          onClick={handleDownloadCsv}
          className="h-11 px-4 rounded-card border border-border bg-bg text-sm font-semibold inline-flex items-center gap-2"
        >
          <Download className="w-4 h-4" />
          <span>{t("hub.download_csv")}</span>
        </button>
        {statusMsg && <p className="text-sm font-medium text-success">{statusMsg}</p>}
      </div>

      {/* Practice bulk delete */}
      <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-3">
        <h2 className="text-sm font-semibold">{t("hub.purge_practice")}</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={purgeReason}
            onChange={(e) => setPurgeReason(e.target.value)}
            placeholder={t("hub.reason_required")}
            className="flex-1 h-11 px-3 rounded-card border border-border bg-bg text-sm"
          />
          <button
            type="button"
            disabled={!purgeReason.trim()}
            onClick={() => void handlePurgePractice()}
            className="h-11 px-4 rounded-card bg-danger text-white text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
          >
            <Trash2 className="w-4 h-4" />
            <span>{t("hub.purge_practice")}</span>
          </button>
        </div>
      </div>

      {/* Final Snapshots */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-muted">Final snapshots</h2>
        {snapshots.length === 0 ? (
          <p className="text-sm text-muted bg-surface border border-border rounded-card p-4">
            {t("hub.empty_snapshots")}
          </p>
        ) : (
          <div className="bg-surface border border-border rounded-card divide-y divide-border text-sm">
            {snapshots.map((sn) => (
              <div key={sn.id} className="p-3 flex items-center justify-between tabular-nums">
                <span>
                  N = <strong>{sn.n_final}</strong> · {sn.variant_ranking_mode.toUpperCase()}
                </span>
                <span className="text-xs text-muted">{new Date(sn.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
