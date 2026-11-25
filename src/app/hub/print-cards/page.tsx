"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Printer } from "lucide-react";
import { loadSession } from "@/lib/auth/session";
import { t } from "@/lib/i18n";
import { getRouteOrder } from "@/lib/reset";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { TeamRow } from "@/lib/types/domain";
import { QrCodeSvg } from "@/components/qr/QrCodeSvg";

export default function PrintCardsPage() {
  const router = useRouter();
  const [teams, setTeams] = useState<TeamRow[]>([]);

  useEffect(() => {
    const s = loadSession();
    if (!s || s.role !== "hub") {
      router.replace("/login");
      return;
    }
    const supabase = getSupabaseClient(s);
    void supabase
      .from("teams")
      .select("*")
      .eq("withdrawn", false)
      .order("number", { ascending: true })
      .then(({ data }) => {
        if (data) setTeams(data as TeamRow[]);
      });
  }, [router]);

  return (
    <div className="min-h-[100dvh] bg-bg p-4 print:p-0 print:bg-white">
      <div className="print:hidden flex items-center justify-between max-w-5xl mx-auto mb-4">
        <button
          type="button"
          onClick={() => router.back()}
          className="h-10 px-4 rounded-card border border-border bg-surface text-sm font-medium"
        >
          {t("common.back")}
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="h-10 px-4 rounded-card bg-accent text-white text-sm font-semibold inline-flex items-center gap-2"
        >
          <Printer className="w-4 h-4" />
          <span>{t("common.print")}</span>
        </button>
      </div>

      <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 print:grid-cols-2 print:gap-3">
        {teams.map((tm) => {
          const routeLetter = String.fromCharCode(65 + (tm.route % 7));
          const order = getRouteOrder(tm.route).join(" → ");
          return (
            <div
              key={tm.id}
              className="bg-surface border border-border rounded-card p-4 flex items-center justify-between gap-3 break-inside-avoid print:border-black"
            >
              <div className="space-y-1 min-w-0">
                <p className="text-2xl font-bold tabular-nums">Team #{tm.number}</p>
                <p className="text-sm font-medium truncate">{tm.church}</p>
                <p className="text-xs font-semibold text-accent">Route {routeLetter}</p>
                <p className="text-xs text-muted tabular-nums">{order}</p>
                <p className="text-[11px] font-mono text-muted">{tm.token}</p>
              </div>
              <QrCodeSvg value={tm.token} size={108} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
