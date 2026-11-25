import type { RoleSession } from "@/lib/types/domain";

const STORAGE_KEY = "th2027_role_session";

export function loadSession(): RoleSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RoleSession>;
    if (!parsed.access_token || !parsed.role || !parsed.session_id) return null;
    return {
      access_token: parsed.access_token,
      role: parsed.role,
      station_id: parsed.station_id ?? null,
      session_id: parsed.session_id
    };
  } catch {
    return null;
  }
}

export function saveSession(session: RoleSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function routeForRole(role: RoleSession["role"]): string {
  if (role === "hub") return "/hub";
  if (role === "floater") return "/floater";
  return "/host";
}
