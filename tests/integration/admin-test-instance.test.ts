vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DELETE,
  POST,
} from "@/app/api/admin/challenges/[id]/test-instance/route";
import { GET as containerGet } from "@/app/api/admin/challenges/[id]/container/route";
import { prisma } from "../helpers/db";
import {
  createAdminUser,
  createChallenge,
  createUser,
  mockSession,
} from "../helpers/factories";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * Stub the orchestrator and record every request (method + body) so tests
 * can assert what the app sent.
 */
function mockOrchestrator(
  routes: Record<string, { status: number; body: unknown }>,
) {
  const calls: Array<{ method: string; url: string; body: string | null }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        url: url.pathname,
        body: typeof init?.body === "string" ? init.body : null,
      });
      const match = Object.entries(routes).find(([suffix]) =>
        url.pathname.endsWith(suffix),
      );
      if (!match) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(match[1].body), {
        status: match[1].status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  return calls;
}

async function createReadyConfig(challengeId: string) {
  return prisma.containerConfig.create({
    data: {
      challengeId,
      dockerfile: "FROM alpine:3.20\n",
      buildState: "READY",
      imageDigest: "sha256:abc123",
    },
  });
}

describe("admin test instance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST starts a test instance with a demo flag env on a READY image", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await createReadyConfig(challenge.id);

    const calls = mockOrchestrator({
      "/instances": {
        status: 201,
        body: {
          containerId: "ctfrbt-test-abc123",
          name: "ctfrbt-test-abc123",
          state: "RUNNING",
          routes: [{ containerPort: 80, hostPort: 45123, protocol: "tcp" }],
        },
      },
    });

    const res = await POST(
      new Request(
        `http://localhost/api/admin/challenges/${challenge.id}/test-instance`,
      ),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.testContainerId).toBe("ctfrbt-test-abc123");
    expect(body.config.testState).toBe("RUNNING");
    expect(body.config.testAccessUrl).toBe("http://localhost:45123");
    expect(body.config.testExpiresAt).not.toBeNull();

    // ~30 minute TTL.
    const stored = await prisma.containerConfig.findUnique({
      where: { challengeId: challenge.id },
    });
    const ttlMs = (stored?.testExpiresAt?.getTime() ?? 0) - Date.now();
    expect(ttlMs).toBeGreaterThan(29 * 60 * 1000);
    expect(ttlMs).toBeLessThan(31 * 60 * 1000);

    // The demo flag and test label reach the orchestrator.
    const create = calls.find(
      (c) => c.method === "POST" && c.url === "/instances",
    );
    expect(create).toBeDefined();
    const sent = JSON.parse(create!.body!);
    expect(sent.image).toBe(`ctfrbt/${challenge.id}`);
    expect(sent.env.FLAG).toBe(`flag{test-${challenge.id}}`);
    expect(sent.env.CTFRBT_TEST).toBe("true");
    expect(sent.labels["ctfrbt.test"]).toBe("true");
    expect(sent.labels["ctfrbt.challengeId"]).toBe(challenge.id);
  });

  it("POST rejects a challenge whose image failed to build", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await prisma.containerConfig.create({
      data: {
        challengeId: challenge.id,
        dockerfile: "FROM alpine:3.20\n",
        buildState: "FAILED",
        buildLog: "boom",
      },
    });

    const calls = mockOrchestrator({});

    const res = await POST(
      new Request(
        `http://localhost/api/admin/challenges/${challenge.id}/test-instance`,
      ),
      params(challenge.id),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("image not built");
    expect(calls).toHaveLength(0);
  });

  it("POST returns 404 for a challenge without container config", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    mockOrchestrator({});

    const res = await POST(
      new Request(
        `http://localhost/api/admin/challenges/${challenge.id}/test-instance`,
      ),
      params(challenge.id),
    );
    expect(res.status).toBe(404);
  });

  it("POST replaces a previous test instance", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await createReadyConfig(challenge.id);
    await prisma.containerConfig.update({
      where: { challengeId: challenge.id },
      data: { testContainerId: "ctfrbt-test-old", testState: "RUNNING" },
    });

    const calls = mockOrchestrator({
      "/instances": {
        status: 201,
        body: {
          containerId: "ctfrbt-test-new",
          name: "ctfrbt-test-new",
          state: "RUNNING",
          routes: [],
        },
      },
    });

    const res = await POST(
      new Request(
        `http://localhost/api/admin/challenges/${challenge.id}/test-instance`,
      ),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.testContainerId).toBe("ctfrbt-test-new");
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url === "/instances/ctfrbt-test-old",
      ),
    ).toBe(true);
  });

  it("POST records FAILED when the orchestrator errors", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await createReadyConfig(challenge.id);

    mockOrchestrator({
      "/instances": { status: 502, body: { error: "cannot create network" } },
    });

    const res = await POST(
      new Request(
        `http://localhost/api/admin/challenges/${challenge.id}/test-instance`,
      ),
      params(challenge.id),
    );
    expect(res.status).toBe(502);

    const stored = await prisma.containerConfig.findUnique({
      where: { challengeId: challenge.id },
    });
    expect(stored?.testState).toBe("FAILED");
    expect(stored?.testContainerId).toBeNull();
  });

  it("DELETE stops the instance and clears the state", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await createReadyConfig(challenge.id);
    await prisma.containerConfig.update({
      where: { challengeId: challenge.id },
      data: {
        testContainerId: "ctfrbt-test-abc",
        testState: "RUNNING",
        testAccessUrl: "http://localhost:45123",
        testExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const calls = mockOrchestrator({
      "/instances/ctfrbt-test-abc": { status: 200, body: { removed: true } },
    });

    const res = await DELETE(
      new Request(
        `http://localhost/api/admin/challenges/${challenge.id}/test-instance`,
        {
          method: "DELETE",
        },
      ),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.testState).toBe("STOPPED");
    expect(body.config.testContainerId).toBeNull();
    expect(body.config.testAccessUrl).toBeNull();
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url === "/instances/ctfrbt-test-abc",
      ),
    ).toBe(true);
  });

  it("container GET reconciles an expired test instance", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await createReadyConfig(challenge.id);
    await prisma.containerConfig.update({
      where: { challengeId: challenge.id },
      data: {
        testContainerId: "ctfrbt-test-exp",
        testState: "RUNNING",
        testExpiresAt: new Date(Date.now() - 60 * 1000),
      },
    });

    const calls = mockOrchestrator({});

    const res = await containerGet(
      new Request("http://localhost"),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.testState).toBe("EXPIRED");
    expect(body.config.testContainerId).toBeNull();
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url === "/instances/ctfrbt-test-exp",
      ),
    ).toBe(true);
  });

  it("container GET marks a vanished test instance as STOPPED", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await createReadyConfig(challenge.id);
    await prisma.containerConfig.update({
      where: { challengeId: challenge.id },
      data: {
        testContainerId: "ctfrbt-test-gone",
        testState: "RUNNING",
        testExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    mockOrchestrator({
      "/instances/ctfrbt-test-gone": { status: 404, body: { error: "no" } },
    });

    const res = await containerGet(
      new Request("http://localhost"),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.testState).toBe("STOPPED");
    expect(body.config.testContainerId).toBeNull();
  });

  it("POST is forbidden for non-admins", async () => {
    const user = await createUser();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    mockOrchestrator({});

    const res = await POST(
      new Request(
        `http://localhost/api/admin/challenges/${challenge.id}/test-instance`,
      ),
      params(challenge.id),
    );
    expect(res.status).toBe(403);
  });
});
