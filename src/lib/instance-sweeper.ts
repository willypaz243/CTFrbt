import { Prisma, prisma } from "@/lib/prisma";
import { deleteInstance } from "@/lib/orchestrator";

/** How often the sweeper runs while the app process is alive (#7). */
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * Stops the dynamic instances whose TTL has passed (#7). Each one is
 * deleted from the orchestrator (container, network and gateway route die
 * together) and marked EXPIRED — the team can start it again, which issues
 * a fresh token and a fresh TTL. Returns the number of instances swept.
 *
 * Safe to run on a schedule: a STARTING/RUNNING row without a container
 * (orchestrator failed mid-start) is just marked, not deleted.
 */
export async function sweepExpiredInstances(
  now: Date = new Date(),
): Promise<number> {
  const expired = await prisma.challengeInstance.findMany({
    where: {
      state: { in: ["STARTING", "RUNNING"] },
      expiresAt: { lte: now },
    },
  });
  for (const instance of expired) {
    if (instance.containerId) {
      await deleteInstance(instance.containerId);
    }
    await prisma.challengeInstance.update({
      where: { id: instance.id },
      data: {
        state: "EXPIRED",
        accessUrl: null,
        token: null,
        containerId: null,
        portMap: Prisma.JsonNull,
        sshUser: null,
        sshPass: null,
        lastLog: null,
      },
    });
  }
  return expired.length;
}

let lastSweepAt = 0;

/**
 * Runs `sweep` at most once per `SWEEP_INTERVAL_MS` (#7). The standalone
 * deployment has no background timer (Next 15 does not bundle
 * `instrumentation.ts` into `output: "standalone"`), so hot read routes
 * call this instead: the first call in a window runs the sweep, the rest
 * are no-ops. A failed sweep does not hold the window — the next call
 * retries.
 */
export async function sweepExpiredThrottled(
  sweep: () => Promise<number> = sweepExpiredInstances,
): Promise<number> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  lastSweepAt = now;
  try {
    return await sweep();
  } catch (err) {
    lastSweepAt = 0;
    console.error("instance sweep failed:", err);
    return 0;
  }
}
