import { describe, expect, it } from "vitest";
import { EXPIRY_GRACE_MINUTES, computeExpiresAt } from "@/lib/instance-expiry";

// Story #7 — expiration math: challenge TTL wins; otherwise game end +
// global grace; otherwise no expiration.

const MINUTE = 60_000;
const now = new Date("2026-11-12T12:00:00.000Z");

describe("computeExpiresAt", () => {
  it("uses the challenge TTL when set", () => {
    const gameEnd = new Date("2026-11-12T14:00:00.000Z");
    const expiresAt = computeExpiresAt({
      ttlMinutes: 15,
      gameEnd,
      now,
    });
    expect(expiresAt).toEqual(new Date(now.getTime() + 15 * MINUTE));
  });

  it("falls back to game end plus global grace when no TTL", () => {
    const gameEnd = new Date("2026-11-12T14:00:00.000Z");
    const expiresAt = computeExpiresAt({
      ttlMinutes: null,
      gameEnd,
      now,
    });
    expect(expiresAt).toEqual(
      new Date(gameEnd.getTime() + EXPIRY_GRACE_MINUTES * MINUTE),
    );
    expect(EXPIRY_GRACE_MINUTES).toBe(15);
  });

  it("returns null when there is no TTL and no game end", () => {
    expect(
      computeExpiresAt({ ttlMinutes: null, gameEnd: null, now }),
    ).toBeNull();
  });

  it("returns null when the game end is already in the past", () => {
    const gameEnd = new Date("2026-11-12T11:00:00.000Z");
    expect(computeExpiresAt({ ttlMinutes: null, gameEnd, now })).toBeNull();
  });
});
