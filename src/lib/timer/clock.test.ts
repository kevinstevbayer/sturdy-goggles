import { describe, expect, it } from "vitest";
import {
  computeClockSample,
  computeElapsedMs,
  formatDurationMs,
  selectBestClockOffset,
  serverAdjustedNow,
  syncServerClock
} from "./clock";

describe("clock offset & timestamp timer", () => {
  it("picks the lowest RTT sample across 3 pings", () => {
    const s1 = computeClockSample(1000, 1200, 1600); // rtt 200, mid 1100, offset +500
    const s2 = computeClockSample(2000, 2040, 2500); // rtt 40,  mid 2020, offset +480
    const s3 = computeClockSample(3000, 3150, 3600); // rtt 150, mid 3075, offset +525
    expect(selectBestClockOffset([s1, s2, s3])).toBe(480);
  });

  it("computes accurate elapsed time across a simulated 45s device sleep and resume", () => {
    const offsetMs = 350;
    const startedAt = serverAdjustedNow(offsetMs, 10_000); // 10,350
    // Device sleeps for 45,000 ms without firing intervals
    const resumedAt = serverAdjustedNow(offsetMs, 55_000); // 55,350
    const elapsed = computeElapsedMs(startedAt, resumedAt, 120_000);
    expect(elapsed).toBe(45_000);
    expect(formatDurationMs(elapsed)).toBe("00:45.0");
  });

  it("clamps elapsed time cleanly at capMs when waking after cap", () => {
    const startedAt = 100_000;
    const wokeAt = 260_000; // 160s later
    expect(computeElapsedMs(startedAt, wokeAt, 120_000)).toBe(120_000);
  });

  it("syncServerClock tolerates a dropped ping", async () => {
    let calls = 0;
    const offset = await syncServerClock(async () => {
      calls += 1;
      if (calls === 2) throw new Error("network");
      return Date.now() + 1000;
    });
    expect(Math.abs(offset - 1000)).toBeLessThan(50);
  });
});
