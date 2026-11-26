import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { reconcileInstancePause } from "@/lib/instance-pause-controller";
import { sweepExpiredInstances } from "@/lib/instance-sweeper";
import {
  createChallenge,
  createTeam,
  createAdminUser,
  mockSession,
} from "../helpers/factories";
import { PATCH } from "@/app/api/admin/game/route";
import { GET } from "@/app/api/admin/instance-pause/route";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/orchestrator", () => ({
  setInstanceSuspended: vi.fn(),
  deleteInstance: vi.fn().mockResolvedValue(true),
}));

const base = new Date("2026-12-01T12:00:00Z");
async function fixture(enabled = true) {
  const config = await prisma.gameConfig.create({
    data: {
      startTime: new Date(base.getTime() - 60_000),
      pausedUntil: new Date(base.getTime() + 60_000),
      instancePauseStartedAt: base,
      suspendInstances: enabled,
    },
  });
  const challenge = await createChallenge();
  const team = await createTeam();
  const instance = await prisma.challengeInstance.create({
    data: {
      challengeId: challenge.id,
      teamId: team.id,
      state: "RUNNING",
      containerId: "ctfrbt-test",
      flag: "flag{unchanged}",
      accessUrl: "http://localhost:23456/",
      expiresAt: new Date(base.getTime() + 30_000),
    },
  });
  return { config, instance };
}

describe("optional instance pause controller", () => {
  it("persists intent before Docker and resumes automatically with the same flag/URL and compensated TTL exactly once", async () => {
    const { instance } = await fixture();
    const operate = vi.fn(async () => {
      const stored = await prisma.challengeInstance.findUniqueOrThrow({
        where: { id: instance.id },
      });
      expect(stored.suspensionStartedAt).not.toBeNull();
      return "ok" as const;
    });
    await reconcileInstancePause(operate, () => base);
    expect(
      (
        await prisma.challengeInstance.findUniqueOrThrow({
          where: { id: instance.id },
        })
      ).state,
    ).toBe("SUSPENDED");
    expect(await sweepExpiredInstances(new Date(base.getTime() + 90_000))).toBe(
      0,
    );
    const after = new Date(base.getTime() + 90_000);
    await reconcileInstancePause(operate, () => after);
    await reconcileInstancePause(operate, () => after);
    const resumed = await prisma.challengeInstance.findUniqueOrThrow({
      where: { id: instance.id },
    });
    expect(resumed).toMatchObject({
      state: "RUNNING",
      flag: instance.flag,
      accessUrl: instance.accessUrl,
      containerId: instance.containerId,
      suspensionStartedAt: null,
    });
    expect(resumed.expiresAt?.getTime()).toBe(
      instance.expiresAt!.getTime() + 90_000,
    );
    expect(operate.mock.calls).toHaveLength(2);
  });

  it("does nothing to containers when the option is disabled", async () => {
    await fixture(false);
    const operate = vi.fn();
    await reconcileInstancePause(operate, () => base);
    expect(operate).not.toHaveBeenCalled();
  });

  it("retries uncertain pause/resume outcomes from durable intent, without double compensation", async () => {
    const { instance, config } = await fixture();
    const operate = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost after Docker accepted"))
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce(new Error("resume response lost"))
      .mockResolvedValue("ok");
    await reconcileInstancePause(operate, () => base);
    let row = await prisma.challengeInstance.findUniqueOrThrow({
      where: { id: instance.id },
    });
    expect(row.state).toBe("SUSPENDING");
    expect(row.suspensionError).toBeTruthy();
    await reconcileInstancePause(operate, () => base);
    await prisma.gameConfig.update({
      where: { id: config.id },
      data: { pausedUntil: null },
    });
    const resumedAt = new Date(base.getTime() + 20_000);
    await reconcileInstancePause(operate, () => resumedAt);
    row = await prisma.challengeInstance.findUniqueOrThrow({
      where: { id: instance.id },
    });
    expect(row.state).toBe("RESUMING");
    expect(row.expiresAt).toEqual(instance.expiresAt);
    await reconcileInstancePause(operate, () => resumedAt);
    row = await prisma.challengeInstance.findUniqueOrThrow({
      where: { id: instance.id },
    });
    expect(row.expiresAt?.getTime()).toBe(
      instance.expiresAt!.getTime() + 20_000,
    );
    expect(row.suspensionError).toBeNull();
  });

  it("protects unprocessed instances from expiry during suspension and catches late starts", async () => {
    const { instance } = await fixture();
    expect(await sweepExpiredInstances(new Date(base.getTime() + 40_000))).toBe(
      0,
    );
    const operate = vi.fn().mockResolvedValue("ok");
    await prisma.challengeInstance.update({
      where: { id: instance.id },
      data: { state: "STARTING" },
    });
    await reconcileInstancePause(operate, () => base);
    expect(operate).not.toHaveBeenCalled();
    await prisma.challengeInstance.update({
      where: { id: instance.id },
      data: { state: "RUNNING" },
    });
    await reconcileInstancePause(operate, () => base);
    expect(operate).toHaveBeenCalledWith(instance.containerId, true);
  });

  it("does not revive missing containers or touch already expired ones", async () => {
    const { instance } = await fixture();
    const operate = vi.fn().mockResolvedValue("missing");
    await prisma.challengeInstance.update({
      where: { id: instance.id },
      data: { expiresAt: base },
    });
    await reconcileInstancePause(operate, () => base);
    expect(operate).not.toHaveBeenCalled();
    await prisma.challengeInstance.update({
      where: { id: instance.id },
      data: { expiresAt: null },
    });
    await reconcileInstancePause(operate, () => base);
    expect(
      (
        await prisma.challengeInstance.findUniqueOrThrow({
          where: { id: instance.id },
        })
      ).state,
    ).toBe("STOPPED");
  });

  it("marks an already exited container stopped instead of retrying forever", async () => {
    const { instance } = await fixture();
    const operate = vi.fn().mockResolvedValue("stopped");
    await reconcileInstancePause(operate, () => base);
    await reconcileInstancePause(operate, () => base);
    const row = await prisma.challengeInstance.findUniqueOrThrow({
      where: { id: instance.id },
    });
    expect(row.state).toBe("STOPPED");
    expect(row.suspensionStartedAt).toBeNull();
    expect(row.suspensionError).toBe("Container was already stopped");
    expect(operate).toHaveBeenCalledTimes(1);
  });

  it("limits a batch to four and does not starve other instances behind failures", async () => {
    const { instance } = await fixture();
    for (let i = 0; i < 5; i++) {
      const team = await createTeam();
      await prisma.challengeInstance.create({
        data: {
          challengeId: instance.challengeId,
          teamId: team.id,
          state: "RUNNING",
          containerId: `ctfrbt-${i}`,
        },
      });
    }
    const operate = vi.fn().mockRejectedValue(new Error("unavailable"));
    await reconcileInstancePause(operate, () => base);
    expect(operate).toHaveBeenCalledTimes(4);
    await reconcileInstancePause(
      operate,
      () => new Date(base.getTime() + 2000),
    );
    expect(new Set(operate.mock.calls.map(([id]) => id)).size).toBe(6);
  });

  it("requires an online controller only for opting into suspension", async () => {
    const { config } = await fixture();
    mockSession(await createAdminUser());
    const request = () =>
      new Request("http://localhost/api/admin/game", {
        method: "PATCH",
        body: JSON.stringify({
          action: "pause",
          minutes: 1,
          suspendInstances: true,
        }),
      });
    expect((await PATCH(request())).status).toBe(503);
    await prisma.gameConfig.update({
      where: { id: config.id },
      data: { instanceControllerHeartbeat: new Date(), startTime: new Date(0) },
    });
    expect((await PATCH(request())).status).toBe(200);
    expect((await (await GET()).json()).controllerOnline).toBe(true);
  });
});
