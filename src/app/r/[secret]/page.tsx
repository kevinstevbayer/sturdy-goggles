"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { routeForRole, saveSession } from "@/lib/auth/session";
import { callAuthSession } from "@/lib/supabase/client";
import type { AppRole } from "@/lib/types/domain";
import { t } from "@/lib/i18n";

export default function RoleLinkExchangePage() {
  const params = useParams<{ secret: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function exchange() {
      const secret = params.secret;
      if (!secret) return;
      try {
        const res = await callAuthSession({ action: "login", secret });
        if (!active) return;
        if (!res.ok) {
          if (res.status === 403) {
            setError(t("auth.pin_required"));
            router.replace("/login");
            return;
          }
          setError(t("auth.invalid_credentials"));
          return;
        }
        const role = res.data.role as AppRole;
        saveSession({
          access_token: String(res.data.access_token),
          role,
          station_id: (res.data.station_id as number | null) ?? null,
          session_id: String(res.data.session_id)
        });
        router.replace(routeForRole(role));
      } catch {
        if (active) setError(t("common.offline"));
      }
    }
    void exchange();
    return () => {
      active = false;
    };
  }, [params.secret, router]);

  return (
    <main className="min-h-[100dvh] flex flex-col items-center justify-center p-4 gap-4">
      <p className="text-sm text-muted">{error ?? t("auth.exchanging_link")}</p>
      {error && (
        <button
          type="button"
          onClick={() => router.replace("/login")}
          className="h-12 px-6 rounded-card bg-accent text-white font-medium"
        >
          {t("auth.sign_in")}
        </button>
      )}
    </main>
  );
}
