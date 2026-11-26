import { describe, expect, it } from "vitest";
import { isNonRetriableError, nextBackoffMs } from "./outbox";

describe("offline outbox backoff & conflict classification", () => {
  it("caps exponential backoff at 30 seconds", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(4)).toBe(16000);
    expect(nextBackoffMs(5)).toBe(30000);
    expect(nextBackoffMs(12)).toBe(30000);
  });

  it("classifies Postgres unique constraint, practice guard, and RLS errors as non-retriable", () => {
    expect(isNonRetriableError({ code: "23505", message: "duplicate key" })).toBe(true);
    expect(isNonRetriableError({ code: "P0001", message: "PRACTICE_FORBIDDEN_IN_LIVE_MODE" })).toBe(true);
    expect(isNonRetriableError({ code: "42501", message: "new row violates row-level security" })).toBe(true);
    expect(isNonRetriableError({ status: 409, message: "Conflict" })).toBe(true);
  });

  it("keeps transient network and 5xx errors retriable", () => {
    expect(isNonRetriableError({ status: 503, message: "Service Unavailable" })).toBe(false);
    expect(isNonRetriableError({ message: "Failed to fetch" })).toBe(false);
  });
});
