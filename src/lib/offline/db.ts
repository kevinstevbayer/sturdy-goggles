import Dexie, { type Table } from "dexie";
import type { AttemptRow, StationConfig, TeamPublic } from "@/lib/types/domain";

export interface OutboxItem {
  id: string;
  table: "attempts" | "station_resets";
  payload: Record<string, unknown>;
  status: "queued" | "syncing" | "synced" | "failed";
  attempts: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
}

export interface MetaItem {
  key: string;
  value: unknown;
}

class OpsOfflineDb extends Dexie {
  teams!: Table<TeamPublic, string>;
  stations!: Table<StationConfig, number>;
  outbox!: Table<OutboxItem, string>;
  local_attempts!: Table<AttemptRow, string>;
  meta!: Table<MetaItem, string>;

  constructor() {
    super("th2027_ops_db");
    this.version(1).stores({
      teams: "id, number, token",
      stations: "id",
      outbox: "id, table, status, next_retry_at, created_at",
      local_attempts: "id, [team_id+station_id], station_id, state",
      meta: "key"
    });
  }
}

export const offlineDb = new OpsOfflineDb();
