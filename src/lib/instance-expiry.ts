/**
 * Instance expiration for dynamic challenges (#7).
 *
 * A challenge with its own TTL expires `ttlMinutes` after the start;
 * otherwise it inherits the game end plus a global grace window, so teams
 * keep working until the results are settled. No game end (dev mode) means
 * no expiration.
 */

export const EXPIRY_GRACE_MINUTES = 15;

const MINUTE_MS = 60_000;

export function computeExpiresAt(opts: {
  ttlMinutes: number | null;
  gameEnd: Date | null;
  now?: Date;
  graceMinutes?: number;
}): Date | null {
  const now = opts.now ?? new Date();
  if (opts.ttlMinutes != null) {
    return new Date(now.getTime() + opts.ttlMinutes * MINUTE_MS);
  }
  if (opts.gameEnd && opts.gameEnd > now) {
    const grace = (opts.graceMinutes ?? EXPIRY_GRACE_MINUTES) * MINUTE_MS;
    return new Date(opts.gameEnd.getTime() + grace);
  }
  return null;
}
