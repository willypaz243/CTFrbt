vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST } from "@/app/api/challenges/[id]/instance/route";
import { prisma } from "../helpers/db";
import {
  createChallenge,
  createUserWithTeam,
  mockSession,
} from "../helpers/factories";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string, method: "POST" | "DELETE") =>
  new Request(`http://localhost/api/challenges/${id}/instance`, { method });

const route = (hostPort: number) => ({
  containerPort: 80,
  hostPort,
  protocol: "tcp",
});

/**
 * Stub the orchestrator with a queue of start responses (one per POST) and
 * record every request body.
 */
function mockOrchestrator(starts: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const calls: Array<{ url: string; body: string | null }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        url: url.pathname,
        body: typeof init?.body === "string" ? init.body : null,
      });
      const next = starts[Math.min(i++, starts.length - 1)];
      return new Response(JSON.stringify(next.body), {
        status: next.status,
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
      dockerfile: "FROM alpine:3.20\nEXPOSE 80\n",
      buildState: "READY",
      imageDigest: "sha256:abc123",
    },
  });
}

describe("one port per instance (#16)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores the published port as portMap and accessUrl", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    const calls = mockOrchestrator([
      {
        status: 201,
        body: {
          containerId: name,
          name,
          state: "RUNNING",
          routes: [route(24321)],
        },
      },
    ]);

    const res = await POST(req(challenge.id, "POST"), params(challenge.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      instance: { state: string; accessUrl: string | null };
    };
    expect(body.instance.state).toBe("RUNNING");
    expect(body.instance.accessUrl).toBe("http://localhost:24321/");

    // The game flow no longer routes through the gateway (#16): no
    // gatewayHost in the orchestrator request.
    const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(sent.gatewayHost).toBeUndefined();

    const stored = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(stored?.portMap).toEqual({
      containerPort: 80,
      hostPort: 24321,
      protocol: "tcp",
    });
    expect(stored?.accessUrl).toBe("http://localhost:24321/");
  });

  it("re-rolls the host port on restart", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    mockOrchestrator([
      {
        status: 201,
        body: {
          containerId: name,
          name,
          state: "RUNNING",
          routes: [route(24321)],
        },
      },
      {
        status: 201,
        body: {
          containerId: name,
          name,
          state: "RUNNING",
          routes: [route(30500)],
        },
      },
    ]);

    await POST(req(challenge.id, "POST"), params(challenge.id));
    await DELETE(req(challenge.id, "DELETE"), params(challenge.id));

    const res = await POST(req(challenge.id, "POST"), params(challenge.id));
    const body = (await res.json()) as {
      instance: { accessUrl: string | null };
    };
    expect(body.instance.accessUrl).toBe("http://localhost:30500/");

    const stored = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(stored?.portMap).toEqual({
      containerPort: 80,
      hostPort: 30500,
      protocol: "tcp",
    });
  });

  it("clears portMap and accessUrl on stop", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    mockOrchestrator([
      {
        status: 201,
        body: {
          containerId: name,
          name,
          state: "RUNNING",
          routes: [route(24321)],
        },
      },
    ]);

    await POST(req(challenge.id, "POST"), params(challenge.id));
    const res = await DELETE(req(challenge.id, "DELETE"), params(challenge.id));
    const body = (await res.json()) as {
      instance: { state: string; accessUrl: string | null };
    };
    expect(body.instance.state).toBe("STOPPED");
    expect(body.instance.accessUrl).toBeNull();

    const stored = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(stored?.portMap).toBeNull();
  });

  it("fails the start when the orchestrator publishes no port", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    mockOrchestrator([
      {
        status: 201,
        body: { containerId: name, name, state: "RUNNING", routes: [] },
      },
    ]);

    const res = await POST(req(challenge.id, "POST"), params(challenge.id));
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      instance: { state: string; lastLog: string | null };
    };
    expect(body.instance.state).toBe("FAILED");
  });
});
