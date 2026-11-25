"use client";

import { useEffect, useState } from "react";
import { Check, CheckSquare, Clock, RotateCcw, Square } from "lucide-react";
import { t } from "@/lib/i18n";
import { formatClockSeconds, serverAdjustedNow } from "@/lib/timer/clock";
import type { StationConfig } from "@/lib/types/domain";

export interface InboundTeamInfo {
  team_id: string;
  team_number: number;
  church: string;
  eta_at: string;
}

interface ResetPanelProps {
  station: StationConfig;
  startedAtMs: number;
  clockOffsetMs: number;
  inbound: InboundTeamInfo | null;
  currentVariant: string | null;
  undoSecondsLeft: number;
  lastAttemptSynced: boolean;
  undoError: string | null;
  onUndo: () => void;
  onChecklistChange: (doneCount: number) => void;
  onResetDone: (itemsDone: number) => void;
}

export function ResetPanel({
  station,
  startedAtMs,
  clockOffsetMs,
  inbound,
  currentVariant,
  undoSecondsLeft,
  lastAttemptSynced,
  undoError,
  onUndo,
  onChecklistChange,
  onResetDone
}: ResetPanelProps) {
  const [checked, setChecked] = useState<boolean[]>(() =>
    station.reset.checklist.map(() => false)
  );
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const tick = () => {
      const nowAdj = serverAdjustedNow(clockOffsetMs);
      setElapsedMs(Math.max(0, nowAdj - startedAtMs));
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [startedAtMs, clockOffsetMs]);

  function toggleItem(idx: number) {
    setChecked((prev) => {
      const next = prev.map((v, i) => (i === idx ? !v : v));
      onChecklistChange(next.filter(Boolean).length);
      return next;
    });
  }

  const targetMs = station.reset.target_s * 1000;
  const overTarget = elapsedMs >= targetMs;

  let etaText: string | null = null;
  if (inbound) {
    const etaMs = Date.parse(inbound.eta_at) - serverAdjustedNow(clockOffsetMs);
    etaText = etaMs <= 0 ? "Now" : Math.ceil(etaMs / 1000) + "s";
  }

  return (
    <div className="space-y-3">
      {/* Confirmed banner + 60s Undo */}
      <div className="bg-surface border border-border rounded-card p-3.5 shadow-soft flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{t("host.confirmed_title")}</p>
          <p className="text-xs text-muted">
            {lastAttemptSynced ? t("common.synced") : t("common.queued")}
          </p>
          {undoError && <p className="text-xs text-danger">{undoError}</p>}
        </div>
        <button
          type="button"
          disabled={undoSecondsLeft <= 0}
          onClick={onUndo}
          className="h-12 px-3.5 rounded-card border border-border bg-bg text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
        >
          <RotateCcw className="w-4 h-4" />
          <span className="tabular-nums">
            {t("common.undo")} ({undoSecondsLeft}s)
          </span>
        </button>
      </div>

      {/* Inbound team + reset timer */}
      <div className="bg-surface border border-border rounded-card p-4 shadow-soft space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium text-muted">{t("host.inbound_label")}</p>
            {inbound ? (
              <p className="text-base font-semibold tabular-nums">
                Team #{inbound.team_number} · {etaText}
              </p>
            ) : (
              <p className="text-sm text-muted">{t("host.no_inbound")}</p>
            )}
          </div>
          <div
            className={
              "px-3 py-1.5 rounded-card text-sm font-bold tabular-nums inline-flex items-center gap-1.5 " +
              (overTarget ? "bg-warning/20 text-warning" : "bg-bg text-text border border-border")
            }
          >
            <Clock className="w-4 h-4" />
            <span>{formatClockSeconds(elapsedMs)}</span>
          </div>
        </div>

        {station.id === 7 && currentVariant && (
          <p className="text-xs font-semibold text-accent">
            {t("host.variant_label")}: {currentVariant}
          </p>
        )}

        {/* Tappable reset checklist items */}
        <div className="space-y-2 pt-1">
          {station.reset.checklist.map((item, idx) => {
            const done = checked[idx] === true;
            return (
              <button
                key={item}
                type="button"
                onClick={() => toggleItem(idx)}
                className={
                  "w-full min-h-[56px] px-3.5 py-2.5 rounded-card border text-left text-sm font-medium flex items-center gap-3 " +
                  (done
                    ? "bg-success/10 border-success text-success"
                    : "bg-bg border-border text-text")
                }
              >
                {done ? (
                  <CheckSquare className="w-5 h-5 shrink-0" />
                ) : (
                  <Square className="w-5 h-5 shrink-0 text-muted" />
                )}
                <span>{item}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => onResetDone(station.reset.checklist.length)}
          className="w-full h-14 rounded-card bg-success text-white font-semibold inline-flex items-center justify-center gap-2"
        >
          <Check className="w-5 h-5" />
          <span>{t("common.reset_done")}</span>
        </button>
      </div>
    </div>
  );
}
