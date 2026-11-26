import { prisma } from "./prisma";
import { setInstanceSuspended } from "./orchestrator";

export const SUSPENSION_STATES = ["SUSPENDING", "SUSPENDED", "RESUMING"];

export function wantsInstancePause(
  config: {
    suspendInstances: boolean;
    pausedUntil: Date | null;
  } | null,
  now: Date,
) {
  return !!(
    config?.suspendInstances &&
    config.pausedUntil &&
    config.pausedUntil > now
  );
}

/** Independent reconciler. Persist intent BEFORE Docker so a crash is retryable.
 * The advisory lock serializes controllers and expiry cleanup. Intent writes use
 * the main connection intentionally: they must survive a controller crash.
 */
export async function reconcileInstancePause(
  operate = setInstanceSuspended,
  clock = () => new Date(),
) {
  return prisma.$transaction(
    async (lock) => {
      const [result] = await lock.$queryRaw<
        { acquired: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(72461125) AS acquired`;
      if (!result.acquired) return;
      const config = await prisma.gameConfig.findFirst({
        orderBy: { createdAt: "desc" },
      });
      if (config)
        await prisma.gameConfig.update({
          where: { id: config.id },
          data: { instanceControllerHeartbeat: clock() },
        });
      const pausing = wantsInstancePause(config, clock());
      const candidates = await prisma.challengeInstance.findMany({
        where: pausing
          ? {
              OR: [
                { state: { in: ["SUSPENDING", "RESUMING"] } },
                {
                  state: "RUNNING",
                  containerId: { not: null },
                  OR: [
                    { expiresAt: null },
                    {
                      expiresAt: {
                        gt: config?.instancePauseStartedAt ?? clock(),
                      },
                    },
                  ],
                },
              ],
            }
          : { suspensionStartedAt: { not: null } },
        // Failed instances go to the back, so one failure cannot starve the fleet.
        orderBy: [
          { suspensionCheckedAt: { sort: "asc", nulls: "first" } },
          { id: "asc" },
        ],
        take: 4,
      });
      let failures = 0;
      for (const instance of candidates) {
        if (!instance.containerId) continue;
        const current = await prisma.gameConfig.findFirst({
          orderBy: { createdAt: "desc" },
        });
        const pause = wantsInstancePause(current, clock());
        if (!pause && !instance.suspensionStartedAt) continue;
        // Include queue time in TTL compensation: a short-lived instance must
        // not expire merely because its turn in the suspension batch came late.
        const startedAt =
          instance.suspensionStartedAt ??
          new Date(
            Math.max(
              current?.instancePauseStartedAt?.getTime() ?? clock().getTime(),
              instance.createdAt.getTime(),
            ),
          );
        const match = {
          id: instance.id,
          containerId: instance.containerId,
          state: instance.state,
        };
        const claimed = await prisma.challengeInstance.updateMany({
          where: match,
          data: {
            state: pause ? "SUSPENDING" : "RESUMING",
            suspensionStartedAt: startedAt,
            suspensionCheckedAt: clock(),
          },
        });
        if (!claimed.count) continue;
        const owned = {
          id: instance.id,
          containerId: instance.containerId,
          suspensionStartedAt: startedAt,
        };
        try {
          const outcome = await operate(instance.containerId, pause);
          if (outcome === "missing" || outcome === "stopped") {
            await prisma.challengeInstance.updateMany({
              where: owned,
              data: {
                state: "STOPPED",
                containerId: null,
                accessUrl: null,
                token: null,
                sshUser: null,
                sshPass: null,
                suspensionStartedAt: null,
                suspensionError:
                  outcome === "missing"
                    ? "Container no longer exists"
                    : "Container was already stopped",
              },
            });
          } else if (pause) {
            await prisma.challengeInstance.updateMany({
              where: owned,
              data: { state: "SUSPENDED", suspensionError: null },
            });
          } else {
            // Compensation happens exactly once when intent is cleared. Preserve
            // flag, filesystem, credentials and port; never recreate the container.
            const downtime = Math.max(
              0,
              clock().getTime() - startedAt.getTime(),
            );
            await prisma.challengeInstance.updateMany({
              where: owned,
              data: {
                state: "RUNNING",
                suspensionStartedAt: null,
                suspensionError: null,
                expiresAt: instance.expiresAt
                  ? new Date(instance.expiresAt.getTime() + downtime)
                  : null,
              },
            });
          }
        } catch {
          failures++;
          await prisma.challengeInstance.updateMany({
            where: owned,
            data: {
              suspensionError:
                "Controller could not reach or change the container; retrying",
            },
          });
        }
      }
      return candidates.length === 4 && failures === 0;
    },
    { timeout: 25_000 },
  );
}
