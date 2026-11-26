import { getSupabaseClient } from "@/lib/supabase/client";
import type { AttemptRow, RoleSession, StationConfig, TeamPublic } from "@/lib/types/domain";
import { offlineDb, type OutboxItem } from "./db";

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export function nextBackoffMs(retryCount: number): number {
  const idx = Math.min(retryCount, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx] ?? 30000;
}

/**
 * Classifies permanent Postgres / PostgREST constraint or permission failures so
 * they stop retrying indefinitely and surface as a visible conflict instead.
 */
export function isNonRetriableError(error: {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}): boolean {
  const code = String(error.code ?? "");
  const msg = String(error.message ?? "");
  const status = error.status ?? 0;

  if (
    code === "23505" || // unique_violation (e.g. uq_attempts_live_team_station)
    code === "23503" || // foreign_key_violation
    code === "23514" || // check_violation
    code === "P0001" || // raise_exception (e.g. PRACTICE_FORBIDDEN_IN_LIVE_MODE)
    code === "42501" // insufficient_privilege / RLS
  ) {
    return true;
  }

  if (
    msg.includes("uq_attempts_live_team_station") ||
    msg.includes("PRACTICE_FORBIDDEN_IN_LIVE_MODE") ||
    msg.includes("row-level security")
  ) {
    return true;
  }

  if (status === 400 || status === 401 || status === 403 || status === 409) {
    return true;
  }

  return false;
}

export async function cacheTeams(teams: TeamPublic[]): Promise<void> {
  await offlineDb.transaction("rw", offlineDb.teams, async () => {
    await offlineDb.teams.clear();
    await offlineDb.teams.bulkPut(teams);
  });
}

export async function cacheStations(stations: StationConfig[]): Promise<void> {
  await offlineDb.stations.bulkPut(stations);
}

export async function enqueueWrite(
  table: "attempts" | "station_resets",
  id: string,
  payload: Record<string, unknown>
): Promise<void> {
  const item: OutboxItem = {
    id,
    table,
    payload,
    status: "queued",
    attempts: 0,
    next_retry_at: Date.now(),
    last_error: null,
    created_at: Date.now()
  };
  await offlineDb.outbox.put(item);

  if (table === "attempts") {
    await offlineDb.local_attempts.put(payload as unknown as AttemptRow);
  }
}

export async function getConflictItems(): Promise<OutboxItem[]> {
  return await offlineDb.outbox.where("status").equals("conflict").toArray();
}

export async function dismissConflict(id: string): Promise<void> {
  const item = await offlineDb.outbox.get(id);
  await offlineDb.outbox.delete(id);
  if (item?.table === "attempts") {
    await offlineDb.local_attempts.delete(id);
  }
}

export async function flushOutbox(session: RoleSession): Promise<{
  syncedCount: number;
  pendingCount: number;
  conflictCount: number;
}> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const pending = await offlineDb.outbox.where("status").anyOf("queued", "failed", "syncing").count();
    const conflictCount = await offlineDb.outbox.where("status").equals("conflict").count();
    return { syncedCount: 0, pendingCount: pending, conflictCount };
  }

  const supabase = getSupabaseClient(session);
  const now = Date.now();
  const due = await offlineDb.outbox
    .where("status")
    .anyOf("queued", "failed")
    .filter((item) => item.next_retry_at <= now)
    .sortBy("created_at");

  let syncedCount = 0;

  for (const item of due) {
    await offlineDb.outbox.update(item.id, { status: "syncing" });
    const { error, status } = await supabase
      .from(item.table)
      .upsert(item.payload, { onConflict: "id" });

    if (!error) {
      await offlineDb.outbox.update(item.id, {
        status: "synced",
        last_error: null
      });
      syncedCount += 1;
    } else if (isNonRetriableError({ code: error.code, message: error.message, status })) {
      await offlineDb.outbox.update(item.id, {
        status: "conflict",
        last_error: error.message
      });
    } else {
      const nextRetry = item.attempts + 1;
      await offlineDb.outbox.update(item.id, {
        status: "failed",
        attempts: nextRetry,
        next_retry_at: Date.now() + nextBackoffMs(nextRetry),
        last_error: error.message
      });
    }
  }

  const pendingCount = await offlineDb.outbox.where("status").anyOf("queued", "failed", "syncing").count();
  const conflictCount = await offlineDb.outbox.where("status").equals("conflict").count();
  return { syncedCount, pendingCount, conflictCount };
}
