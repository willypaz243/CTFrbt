import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SWEEP_INTERVAL_MS,
  sweepExpiredThrottled,
} from "@/lib/instance-sweeper";

// The throttle keeps one global timestamp per process, so these tests run
// in order against the shared state and advance the clock explicitly.
describe("sweepExpiredThrottled", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("runs the sweep on the first call", async () => {
    const sweep = vi.fn().mockResolvedValue(0);
    await sweepExpiredThrottled(sweep);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("skips calls within the throttle window", async () => {
    const sweep = vi.fn().mockResolvedValue(0);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS - 1);
    await sweepExpiredThrottled(sweep);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("runs again after the window elapses", async () => {
    const sweep = vi.fn().mockResolvedValue(0);
    vi.advanceTimersByTime(2);
    await sweepExpiredThrottled(sweep);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("retries on the next call when the sweep fails", async () => {
    const sweep = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(1);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + 1);
    await expect(sweepExpiredThrottled(sweep)).resolves.toBe(0);
    await sweepExpiredThrottled(sweep);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
