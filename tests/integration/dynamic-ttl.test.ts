vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as startInstance } from "@/app/api/challenges/[id]/instance/route";
import { sweepExpiredInstances } from "@/lib/instance-sweeper";
import { prisma } from "../helpers/db";
import {
  createChallenge,
  createUserWithTeam,
  mockSession,
} from "../helpers/factories";

const MINUTE = 60_000;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const instanceReq = (id: string) =>
  new Request(`http://localhost/api/challenges/${id}/instance`, {
    method: "POST",
  });

/** Stub the orchestrator and record every request it receives. */
function mockOrchestrator() {
  const calls: Array<{ method: string; url: string; body: string | null }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        url: url.pathname,
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(
        JSON.stringify({
          containerId: "stub",
          name: "stub",
          state: "RUNNING",
          routes: [],
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  return calls;
}

async function createReadyConfig(
  challengeId: string,
  ttlMinutes?: number | null,
) {
  return prisma.containerConfig.create({
    data: {
      challengeId,
      dockerfile: "FROM alpine:3.20\n",
      buildState: "READY",
      imageDigest: "sha256:abc123",
      ttlMinutes: ttlMinutes ?? null,
    },
  });
}

describe("dynamic instance TTL (#7)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("start with a short ttl sets expiresAt in the response and the DB", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id, 5);

    mockOrchestrator();
    const before = Date.now();
    const res = await startInstance(
      instanceReq(challenge.id),
      params(challenge.id),
    );
    const after = Date.now();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      instance: { state: string; expiresAt: string | null };
    };
    expect(body.instance.state).toBe("RUNNING");
    expect(body.instance.expiresAt).not.toBeNull();
    const responseExpiry = new Date(body.instance.expiresAt!).getTime();
    // start + 5 min, with a tolerance window for the request elapsed.
    expect(responseExpiry).toBeGreaterThanOrEqual(before + 5 * MINUTE - 1000);
    expect(responseExpiry).toBeLessThanOrEqual(after + 5 * MINUTE + 1000);

    const row = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(row?.expiresAt).not.toBeNull();
    const dbExpiry = row!.expiresAt!.getTime();
    expect(dbExpiry).toBeGreaterThanOrEqual(before + 5 * MINUTE - 1000);
    expect(dbExpiry).toBeLessThanOrEqual(after + 5 * MINUTE + 1000);
  });

  it("sweep stops an expired instance and marks it EXPIRED", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id, 5);

    const calls = mockOrchestrator();
    const res = await startInstance(
      instanceReq(challenge.id),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    // Force the expiration into the past.
    const row = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    await prisma.challengeInstance.update({
      where: { id: row!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const swept = await sweepExpiredInstances();
    expect(swept).toBe(1);

    const after = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(after?.state).toBe("EXPIRED");
    expect(after?.token).toBeNull();
    expect(after?.accessUrl).toBeNull();
    expect(after?.containerId).toBeNull();

    // The orchestrator received the DELETE (container + gateway route die).
    const del = calls.find(
      (c) =>
        c.method === "DELETE" &&
        c.url === `/instances/ctfrbt-${challenge.id}-${team.id}`,
    );
    expect(del).toBeDefined();
  });

  it("restart after expiry issues a new token, new TTL and bumps startCount", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id, 5);

    mockOrchestrator();
    const first = await startInstance(
      instanceReq(challenge.id),
      params(challenge.id),
    );
    expect(first.status).toBe(200);

    const firstRow = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(firstRow?.token).not.toBeNull();

    // Let it expire and let the sweeper take it down.
    await prisma.challengeInstance.update({
      where: { id: firstRow!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await sweepExpiredInstances();

    const before = Date.now();
    const second = await startInstance(
      instanceReq(challenge.id),
      params(challenge.id),
    );
    const after = Date.now();
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      instance: { state: string; expiresAt: string | null };
    };
    expect(body.instance.state).toBe("RUNNING");

    const row = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(row?.token).not.toBe(firstRow?.token);
    expect(row?.startCount).toBe(2);
    const expiry = row?.expiresAt?.getTime() ?? 0;
    expect(expiry).toBeGreaterThanOrEqual(before + 5 * MINUTE - 1000);
    expect(expiry).toBeLessThanOrEqual(after + 5 * MINUTE + 1000);
  });

  it("changing ttlMinutes does not affect a running instance", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id, 5);

    mockOrchestrator();
    const res = await startInstance(
      instanceReq(challenge.id),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const before = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(before?.expiresAt).not.toBeNull();

    // The challenge TTL changes while the instance is running.
    await prisma.containerConfig.update({
      where: { challengeId: challenge.id },
      data: { ttlMinutes: 30 },
    });

    const after = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(after?.expiresAt?.getTime()).toBe(before?.expiresAt?.getTime());
  });
});
