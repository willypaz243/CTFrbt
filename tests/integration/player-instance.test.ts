vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "@/app/api/challenges/[id]/instance/route";
import { prisma } from "../helpers/db";
import {
  createChallenge,
  createUser,
  createUserWithTeam,
  mockNoSession,
  mockSession,
} from "../helpers/factories";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

// Mirror the route's env handling so the assertions hold whatever the dev
// .env points at (inst.ctfrbt.local by default, inst.ctfrbt.home.arpa:8088
// in the local dev setup of story #15).
const GATEWAY_DOMAIN = process.env.GATEWAY_DOMAIN ?? "inst.ctfrbt.local";
const GATEWAY_PORT = process.env.GATEWAY_PORT
  ? `:${process.env.GATEWAY_PORT}`
  : "";

const req = (id: string, method: "GET" | "POST" | "DELETE") =>
  new Request(`http://localhost/api/challenges/${id}/instance`, { method });

/**
 * Stub the orchestrator and record every request so tests can assert
 * what the app sent (name, labels, gateway host).
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

describe("player team instance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST starts the team instance and returns its gateway URL", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    const calls = mockOrchestrator({
      "/instances": {
        status: 201,
        body: {
          containerId: name,
          name,
          state: "RUNNING",
          routes: [],
        },
      },
    });

    const res = await POST(req(challenge.id, "POST"), params(challenge.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      instance: {
        state: string;
        accessUrl: string | null;
        startCount: number;
      };
    };
    expect(body.instance.state).toBe("RUNNING");
    expect(body.instance.accessUrl).toMatch(
      new RegExp(`^http://[a-f0-9]{32}\\.${GATEWAY_DOMAIN}${GATEWAY_PORT}/$`),
    );
    expect(body.instance.startCount).toBe(1);

    const stored = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(stored?.state).toBe("RUNNING");
    expect(stored?.containerId).toBe(name);
    expect(stored?.imageDigest).toBe("sha256:abc123");

    // The gateway host (random token) and the team labels reach the
    // orchestrator.
    const create = calls.find(
      (c) => c.method === "POST" && c.url === "/instances",
    );
    expect(create).toBeDefined();
    const sent = JSON.parse(create!.body!) as {
      image: string;
      name: string;
      labels: Record<string, string>;
      gatewayHost: string;
    };
    expect(sent.image).toBe(`ctfrbt/${challenge.id}`);
    expect(sent.name).toBe(name);
    expect(sent.labels["ctfrbt.challengeId"]).toBe(challenge.id);
    expect(sent.labels["ctfrbt.teamId"]).toBe(team.id);
    expect(sent.gatewayHost).toBe(
      body.instance
        .accessUrl!.replace(/^http:\/\//, "")
        .replace(/\/$/, "")
        .replace(/:\d+$/, ""),
    );
    expect(sent.gatewayHost).toMatch(
      new RegExp(`^[a-f0-9]{32}\\.${GATEWAY_DOMAIN}$`),
    );
  });

  it("a second start while running is rejected with 409", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    mockOrchestrator({
      "/instances": {
        status: 201,
        body: { containerId: name, name, state: "RUNNING", routes: [] },
      },
    });
    await POST(req(challenge.id, "POST"), params(challenge.id));

    const res = await POST(req(challenge.id, "POST"), params(challenge.id));
    expect(res.status).toBe(409);
  });

  it("DELETE stops the instance and clears the route data", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    await prisma.challengeInstance.create({
      data: {
        challengeId: challenge.id,
        teamId: team.id,
        state: "RUNNING",
        containerId: name,
        token: "deadbeef",
        accessUrl: "http://deadbeef.inst.ctfrbt.local/",
      },
    });

    const calls = mockOrchestrator({
      [`/instances/${name}`]: { status: 200, body: { removed: true } },
    });

    const res = await DELETE(req(challenge.id, "DELETE"), params(challenge.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      instance: { state: string; accessUrl: string | null };
    };
    expect(body.instance.state).toBe("STOPPED");
    expect(body.instance.accessUrl).toBeNull();
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url === `/instances/${name}`,
      ),
    ).toBe(true);

    const stored = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(stored?.token).toBeNull();
    expect(stored?.containerId).toBeNull();
  });

  it("a restart re-issues the token (new URL, new start count)", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    mockOrchestrator({
      "/instances": {
        status: 201,
        body: { containerId: name, name, state: "RUNNING", routes: [] },
      },
    });
    const first = (await (
      await POST(req(challenge.id, "POST"), params(challenge.id))
    ).json()) as { instance: { accessUrl: string } };

    await DELETE(req(challenge.id, "DELETE"), params(challenge.id));

    const second = (await (
      await POST(req(challenge.id, "POST"), params(challenge.id))
    ).json()) as { instance: { accessUrl: string; startCount: number } };

    expect(second.instance.accessUrl).not.toBe(first.instance.accessUrl);
    expect(second.instance.startCount).toBe(2);
  });

  it("POST records FAILED when the orchestrator errors", async () => {
    const { user } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    mockOrchestrator({
      "/instances": { status: 502, body: { error: "cannot create network" } },
    });

    const res = await POST(req(challenge.id, "POST"), params(challenge.id));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { instance: { state: string } };
    expect(body.instance.state).toBe("FAILED");
  });

  it("POST rejects a challenge whose image is not built", async () => {
    const { user } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await prisma.containerConfig.create({
      data: {
        challengeId: challenge.id,
        dockerfile: "FROM alpine:3.20\n",
        buildState: "FAILED",
        buildLog: "boom",
      },
    });

    mockOrchestrator({});

    const res = await POST(req(challenge.id, "POST"), params(challenge.id));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("image not built");
  });

  it("POST rejects a static challenge (no container config)", async () => {
    const { user } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);

    mockOrchestrator({});

    const res = await POST(req(challenge.id, "POST"), params(challenge.id));
    expect(res.status).toBe(400);
  });

  it("GET reports a vanished container as STOPPED", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    await prisma.challengeInstance.create({
      data: {
        challengeId: challenge.id,
        teamId: team.id,
        state: "RUNNING",
        containerId: name,
        accessUrl: "http://tok.inst.ctfrbt.local/",
      },
    });

    mockOrchestrator({ [`/instances/${name}`]: { status: 404, body: {} } });

    const res = await GET(req(challenge.id, "GET"), params(challenge.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: { state: string } };
    expect(body.instance.state).toBe("STOPPED");

    const stored = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(stored?.accessUrl).toBeNull();
  });

  it("GET of a STARTING instance promoted to RUNNING by the engine", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const name = `ctfrbt-${challenge.id}-${team.id}`;
    await prisma.challengeInstance.create({
      data: {
        challengeId: challenge.id,
        teamId: team.id,
        state: "STARTING",
        containerId: name,
      },
    });

    mockOrchestrator({
      [`/instances/${name}`]: {
        status: 200,
        body: { containerId: name, name, state: "RUNNING", routes: [] },
      },
    });

    const res = await GET(req(challenge.id, "GET"), params(challenge.id));
    const body = (await res.json()) as { instance: { state: string } };
    expect(body.instance.state).toBe("RUNNING");
  });

  it("GET returns 404 when the team has no instance yet", async () => {
    const { user } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    mockOrchestrator({});

    const res = await GET(req(challenge.id, "GET"), params(challenge.id));
    expect(res.status).toBe(404);
  });

  it("requires a session and a team", async () => {
    const challenge = await createChallenge();
    await createReadyConfig(challenge.id);

    mockOrchestrator({});
    mockNoSession();
    const anon = await POST(req(challenge.id, "POST"), params(challenge.id));
    expect(anon.status).toBe(401);

    const noTeam = await createUser();
    mockSession(noTeam);
    const noTeamRes = await POST(
      req(challenge.id, "POST"),
      params(challenge.id),
    );
    expect(noTeamRes.status).toBe(403);
  });
});
