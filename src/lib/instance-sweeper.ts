import { Prisma, prisma } from "@/lib/prisma";
import { wantsInstancePause } from "./instance-pause-controller";
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
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<
        { acquired: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(72461125) AS acquired`;
      if (!lock.acquired) return 0;
      const config = await tx.gameConfig.findFirst({
        orderBy: { createdAt: "desc" },
      });
      // Protect instances waiting in the suspension queue too.
      if (wantsInstancePause(config, now)) return 0;
      const expired = await tx.challengeInstance.findMany({
        where: {
          state: { in: ["STARTING", "RUNNING"] },
          suspensionStartedAt: null,
          expiresAt: { lte: now },
        },
        take: 4,
      });
      let swept = 0;
      for (const instance of expired) {
        if (
          instance.containerId &&
          !(await deleteInstance(instance.containerId))
        )
          continue;
        await tx.challengeInstance.update({
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
        swept++;
      }
      return swept;
    },
    { timeout: 25_000 },
  );
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
    const swept = await sweep();
    // Drain a backlog on subsequent reads instead of waiting a minute per batch.
    if (swept >= 4) lastSweepAt = 0;
    return swept;
  } catch (err) {
    lastSweepAt = 0;
    console.error("instance sweep failed:", err);
    return 0;
  }
}
