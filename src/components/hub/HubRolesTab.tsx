"use client";

import { useEffect, useState } from "react";
import { Copy, QrCode, RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { callAuthSession } from "@/lib/supabase/client";
import type { RoleSession } from "@/lib/types/domain";
import { QrCodeSvg } from "@/components/qr/QrCodeSvg";

interface RoleCredRow {
  role: string;
  station_id: number | null;
  secret_token: string;
  pin_code: string;
}

export function HubRolesTab({ session }: { session: RoleSession }) {
  const [roles, setRoles] = useState<RoleCredRow[]>([]);
  const [takeoverInfo, setTakeoverInfo] = useState<{ role: string; url: string } | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    void loadRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadRoles() {
    const res = await callAuthSession({ action: "list_roles", caller_role: "hub" }, session.access_token);
    if (res.ok && Array.isArray(res.data.roles)) {
      setRoles(res.data.roles as RoleCredRow[]);
    }
  }

  async function handleRegenerate(targetRole: string) {
    const res = await callAuthSession(
      { action: "regenerate", caller_role: "hub", target_role: targetRole },
      session.access_token
    );
    if (res.ok) {
      await loadRoles();
    }
  }

  async function handleCreateTakeover(targetRole: string) {
    const res = await callAuthSession(
      { action: "create_takeover", caller_role: "hub", target_role: targetRole },
      session.access_token
    );
    if (res.ok && typeof res.data.token === "string") {
      setTakeoverInfo({
        role: targetRole,
        url: origin + "/r/takeover-" + res.data.token
      });
    }
  }

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <h1 className="text-lg font-semibold">{t("hub.tab_roles")}</h1>

      {roles.length === 0 ? (
        <p className="text-sm text-muted bg-surface border border-border rounded-card p-6 text-center">
          No role credentials loaded. Start auth-session Edge Function and refresh.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {roles.map((rc) => {
            const link = origin + "/r/" + rc.secret_token;
            return (
              <div key={rc.role} className="bg-surface border border-border rounded-card p-4 shadow-soft space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold uppercase">{rc.role.replace("_", " ")}</h2>
                    <p className="text-sm font-mono font-bold text-accent tabular-nums">PIN: {rc.pin_code}</p>
                  </div>
                  <QrCodeSvg value={link} size={84} />
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(link)}
                    className="h-9 px-3 rounded-card border border-border text-xs font-medium inline-flex items-center gap-1"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>{t("hub.copy_link")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCreateTakeover(rc.role)}
                    className="h-9 px-3 rounded-card border border-border text-xs font-medium inline-flex items-center gap-1"
                  >
                    <QrCode className="w-3.5 h-3.5" />
                    <span>{t("hub.takeover_qr")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRegenerate(rc.role)}
                    className="h-9 px-3 rounded-card border border-danger/40 text-danger text-xs font-medium inline-flex items-center gap-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{t("hub.regenerate")}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {takeoverInfo && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-surface border border-border rounded-card p-5 shadow-soft max-w-xs w-full text-center space-y-3">
            <h2 className="text-base font-semibold uppercase">
              {takeoverInfo.role.replace("_", " ")} · 2 min
            </h2>
            <div className="flex justify-center">
              <QrCodeSvg value={takeoverInfo.url} size={180} />
            </div>
            <button
              type="button"
              onClick={() => setTakeoverInfo(null)}
              className="w-full h-11 rounded-card bg-accent text-white text-sm font-semibold"
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
