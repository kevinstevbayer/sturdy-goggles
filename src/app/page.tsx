"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { loadSession, routeForRole } from "@/lib/auth/session";
import { t } from "@/lib/i18n";

export default function HomeRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    const session = loadSession();
    if (session) {
      router.replace(routeForRole(session.role));
    } else {
      router.replace("/login");
    }
  }, [router]);

  return (
    <main className="min-h-[100dvh] flex items-center justify-center p-4">
      <p className="text-sm text-muted">{t("common.loading")}</p>
    </main>
  );
}
