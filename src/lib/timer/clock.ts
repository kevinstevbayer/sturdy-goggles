export interface ClockSample {
  rttMs: number;
  offsetMs: number;
}

/**
 * Given a ping's local start, local end, and server timestamp, compute RTT and offset.
 * server_now ≈ client_now + offsetMs
 */
export function computeClockSample(
  clientStartMs: number,
  clientEndMs: number,
  serverTsMs: number
): ClockSample {
  const rttMs = Math.max(0, clientEndMs - clientStartMs);
  const midpoint = clientStartMs + rttMs / 2;
  const offsetMs = Math.round(serverTsMs - midpoint);
  return { rttMs, offsetMs };
}

/**
 * Select the sample with the lowest round-trip time (minimum jitter).
 */
export function selectBestClockOffset(samples: ClockSample[]): number {
  if (samples.length === 0) return 0;
  let best = samples[0]!;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.rttMs < best.rttMs) {
      best = s;
    }
  }
  return best.offsetMs;
}

/**
 * Perform 3 sequential server-time pings and return the best clock offset in ms.
 */
export async function syncServerClock(
  fetcher: () => Promise<number> = async () => {
    const res = await fetch("/api/time", { cache: "no-store" });
    if (!res.ok) throw new Error("TIME_SYNC_FAILED");
    const data = (await res.json()) as { server_ts: number };
    return data.server_ts;
  }
): Promise<number> {
  const samples: ClockSample[] = [];
  for (let i = 0; i < 3; i++) {
    try {
      const t0 = Date.now();
      const serverTs = await fetcher();
      const t1 = Date.now();
      samples.push(computeClockSample(t0, t1, serverTs));
    } catch {
      // Skip failed ping
    }
  }
  return selectBestClockOffset(samples);
}

/**
 * Current server-adjusted timestamp in epoch ms.
 */
export function serverAdjustedNow(offsetMs: number, localNowMs: number = Date.now()): number {
  return localNowMs + offsetMs;
}

/**
 * Pure timestamp-derived elapsed ms (immune to setInterval drift or mobile sleep).
 */
export function computeElapsedMs(
  startedAtMs: number,
  nowMs: number,
  capMs?: number
): number {
  const raw = Math.max(0, nowMs - startedAtMs);
  if (capMs !== undefined && raw >= capMs) {
    return capMs;
  }
  return raw;
}

export function formatDurationMs(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const totalSec = Math.floor(clamped / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const tenths = Math.floor((clamped % 1000) / 100);
  return String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0") + "." + String(tenths);
}

export function formatClockSeconds(ms: number): string {
  const clamped = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
}
