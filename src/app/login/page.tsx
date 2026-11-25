"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { saveSession, routeForRole } from "@/lib/auth/session";
import { callAuthSession } from "@/lib/supabase/client";
import type { AppRole } from "@/lib/types/domain";
import { t } from "@/lib/i18n";

export default function LoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const cleaned = pin.replace(/\D/g, "");
    if (cleaned.length !== 6) {
      setErrorMsg(t("auth.invalid_credentials"));
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await callAuthSession({ action: "login", pin: cleaned });
      if (!res.ok) {
        if (res.status === 429) setErrorMsg(t("auth.rate_limited"));
        else if (res.status === 409) setErrorMsg(t("auth.takeover_blocked"));
        else setErrorMsg(t("auth.invalid_credentials"));
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
      setErrorMsg(t("common.offline"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-[100dvh] flex items-center justify-center p-4 bg-bg">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-surface border border-border rounded-card p-6 shadow-soft space-y-4"
      >
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-accent" aria-hidden="true" />
          <h1 className="text-lg font-semibold">{t("auth.pin_title")}</h1>
        </div>

        <input
          type="tel"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder={t("auth.pin_placeholder")}
          aria-label={t("auth.pin_title")}
          className="w-full h-14 px-4 rounded-card border border-border bg-bg text-text text-center text-2xl tracking-[0.35em] tabular-nums focus:outline-none focus:ring-2 focus:ring-accent"
        />

        {errorMsg && (
          <p role="alert" className="text-sm text-danger font-medium">
            {errorMsg}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || pin.length !== 6}
          className="w-full h-14 rounded-card bg-accent text-white font-semibold disabled:opacity-50"
        >
          {t("auth.sign_in")}
        </button>
      </form>
    </main>
  );
}
