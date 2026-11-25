"use client";

import { AlertTriangle, Play } from "lucide-react";
import { t } from "@/lib/i18n";
import type { OpsBoardSnapshot } from "@/lib/ops";

interface HubDispatchTabProps {
  board: OpsBoardSnapshot;
  onLaunchTeam: (teamId: string) => Promise<void>;
}

export function HubDispatchTab({ board, onLaunchTeam }: HubDispatchTabProps) {
  return (
    <div className="p-4 lg:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("hub.tab_dispatch")}</h1>
        {board.suggested_team ? (
          <button
            type="button"
            onClick={() => void onLaunchTeam(board.suggested_team!.id)}
            className="h-11 px-4 rounded-card bg-success text-white text-sm font-semibold inline-flex items-center gap-2"
          >
            <Play className="w-4 h-4" />
            <span>
              {t("hub.suggested_next")}: Team #{board.suggested_team.number} (Route{" "}
              {String.fromCharCode(65 + (board.suggested_team.route % 7))})
            </span>
          </button>
        ) : (
          <span className="text-xs font-medium text-muted px-3 py-1.5 rounded-card border border-border bg-surface">
            {t("hub.wait_launch")}
          </span>
        )}
      </div>

      {board.alerts.length > 0 && (
        <div className="space-y-2">
          {board.alerts.map((al) => (
            <div
              key={al.id}
              className="p-3 rounded-card border border-warning/40 bg-warning/10 text-warning text-xs flex items-center gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                <strong>{al.label}:</strong> {al.detail}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {board.routes.map((rt) => (
          <div key={rt.route} className="bg-surface border border-border rounded-card p-4 shadow-soft space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted">Starts at Stn {rt.first_station_id}</p>
                <h2 className="text-base font-bold">Route {rt.route_letter}</h2>
              </div>
              <span
                className={
                  "px-2.5 py-0.5 rounded-full text-xs font-semibold " +
                  (rt.safe_to_launch ? "bg-success/15 text-success" : "bg-warning/15 text-warning")
                }
              >
                {rt.safe_to_launch ? t("hub.safe_to_launch") : t("hub.wait_launch")}
              </span>
            </div>

            <p className="text-xs text-muted">
              Stn {rt.first_station_id}: <strong className="uppercase">{rt.first_station_state}</strong> · Inbound{" "}
              {rt.inbound_count}
            </p>

            {rt.waiting_teams.length === 0 ? (
              <p className="text-xs text-muted">{t("hub.empty_dispatch")}</p>
            ) : (
              <div className="space-y-2 pt-1">
                {rt.waiting_teams.slice(0, 3).map((tm) => (
                  <div key={tm.id} className="flex items-center justify-between gap-2 text-xs bg-bg p-2 rounded-card">
                    <span className="font-semibold tabular-nums truncate">
                      #{tm.number} · {tm.church}
                    </span>
                    <button
                      type="button"
                      onClick={() => void onLaunchTeam(tm.id)}
                      className={
                        "h-8 px-2.5 rounded-card font-semibold shrink-0 " +
                        (rt.safe_to_launch
                          ? "bg-accent text-white"
                          : "border border-border text-text bg-surface")
                      }
                    >
                      {rt.safe_to_launch ? t("hub.launch") : t("hub.launch_override")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
