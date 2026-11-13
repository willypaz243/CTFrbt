/**
 * Host port selection for the one-port-per-instance channel (#16).
 *
 * Each game instance publishes its single EXPOSE port on a random host
 * port from a wide range; the random port itself acts as the token
 * (rotation on every start, #5/#7). The range must match the forwarding
 * configured on the public edge (see story #13/#16 notes).
 */

export const HOST_PORT_MIN = 20000;
export const HOST_PORT_MAX = 60000;

/**
 * Pick a random free host port in [HOST_PORT_MIN, HOST_PORT_MAX], skipping
 * the ports in `exclude` (already published or just rejected with
 * EADDRINUSE). `random` is injectable for deterministic tests.
 */
export function pickHostPort(
  exclude: ReadonlySet<number> = new Set(),
  random: () => number = Math.random,
): number {
  const candidates: number[] = [];
  for (let port = HOST_PORT_MIN; port <= HOST_PORT_MAX; port++) {
    if (!exclude.has(port)) candidates.push(port);
  }
  if (candidates.length === 0) {
    throw new Error("no free host port in the configured range");
  }
  return candidates[Math.floor(random() * candidates.length)];
}
