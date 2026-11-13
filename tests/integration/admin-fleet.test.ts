vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/fleet/route";
import { POST } from "@/app/api/admin/fleet/[instanceId]/kill/route";
import { prisma } from "../helpers/db";
import {
  createAdminUser,
  createChallenge,
  createUserWithTeam,
  mockNoSession,
  mockSession,
} from "../helpers/factories";

const req = () => new Request("http://localhost/api/admin/fleet");

/** Stub the orchestrator's GET /instances with the given containers. */
function mockOrchestrator(list: Array<{ name: string; state: string }>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname === "/instances") {
      return new Response(
        JSON.stringify({
          instances: list.map((c, i) => ({
            containerId: `cid-${i}`,
            name: c.name,
            state: c.state,
            labels: {},
          })),
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

function mockOrchestratorDown() {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
}

describe("admin fleet (story #8)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects requests without a session", async () => {
    mockNoSession();
    expect((await GET(req())).status).toBe(403);
  });

  it("rejects non-admin users", async () => {
    const { user } = await createUserWithTeam();
    mockSession({ id: user.id, teamId: user.teamId });
    expect((await GET(req())).status).toBe(403);
  });

  it("lists instances enriched with challenge/team data and live container state", async () => {
    const admin = await createAdminUser();
    const { team } = await createUserWithTeam();
    const { team: team2 } = await createUserWithTeam();
    const challenge = await createChallenge({ title: "Fleet target" });

    const running = await prisma.challengeInstance.create({
      data: {
        challengeId: challenge.id,
        teamId: team.id,
        state: "RUNNING",
        containerId: "ctfrbt-a",
        accessUrl: "http://10.0.0.5:31000/",
        portMap: { containerPort: 22, hostPort: 31000, protocol: "tcp" },
        expiresAt: new Date(Date.now() + 2 * 3600_000),
        startCount: 3,
      },
    });
    const stopped = await prisma.challengeInstance.create({
      data: {
        challengeId: challenge.id,
        teamId: team2.id,
        state: "STOPPED",
      },
    });

    mockOrchestrator([{ name: "ctfrbt-a", state: "RUNNING" }]);
    mockSession({ id: admin.id, isAdmin: true });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      instances: Array<Record<string, unknown>>;
    };
    const rows = new Map(body.instances.map((r) => [r.id as string, r]));

    const a = rows.get(running.id);
    expect(a).toMatchObject({
      state: "RUNNING",
      accessUrl: "http://10.0.0.5:31000/",
      containerPort: 22,
      hostPort: 31000,
      startCount: 3,
      containerState: "RUNNING",
    });
    expect(a!.challenge).toMatchObject({ title: "Fleet target" });
    expect(a!.team).toMatchObject({ name: team.name });
    expect(typeof a!.expiresAt).toBe("string");
    expect(typeof a!.createdAt).toBe("string");

    const b = rows.get(stopped.id);
    expect(b).toMatchObject({ state: "STOPPED", containerState: null });
    expect(b!.hostPort).toBeNull();
    expect(b!.containerPort).toBeNull();
  });

  it("flags a RUNNING instance whose container is gone as MISSING", async () => {
    const admin = await createAdminUser();
    const { team } = await createUserWithTeam();
    const challenge = await createChallenge();
    const instance = await prisma.challengeInstance.create({
      data: {
        challengeId: challenge.id,
        teamId: team.id,
        state: "RUNNING",
        containerId: "ctfrbt-gone",
      },
    });

    mockOrchestrator([]);
    mockSession({ id: admin.id, isAdmin: true });

    const res = await GET(req());
    const body = (await res.json()) as {
      instances: Array<Record<string, unknown>>;
    };
    const row = body.instances.find((r) => r.id === instance.id);
    expect(row).toMatchObject({ state: "RUNNING", containerState: "MISSING" });
  });

  it("degrades gracefully when the orchestrator is unreachable", async () => {
    const admin = await createAdminUser();
    const { team } = await createUserWithTeam();
    const challenge = await createChallenge();
    const instance = await prisma.challengeInstance.create({
      data: {
        challengeId: challenge.id,
        teamId: team.id,
        state: "RUNNING",
        containerId: "ctfrbt-x",
      },
    });

    mockOrchestratorDown();
    mockSession({ id: admin.id, isAdmin: true });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      instances: Array<Record<string, unknown>>;
    };
    const row = body.instances.find((r) => r.id === instance.id);
    expect(row).toMatchObject({ state: "RUNNING", containerState: null });
  });
});

describe("admin fleet kill (story #8)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const killReq = (id: string) =>
    new Request(`http://localhost/api/admin/fleet/${id}/kill`, {
      method: "POST",
    });
  const params = (id: string) => ({
    params: Promise.resolve({ instanceId: id }),
  });

  /** Stub the orchestrator and record every call (method + pathname). */
  function recordOrchestrator() {
    const calls: Array<{ method: string; pathname: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ method: init?.method ?? "GET", pathname: url.pathname });
        return new Response("{}", { status: 200 });
      },
    );
    return calls;
  }

  it("rejects non-admin users", async () => {
    const { user } = await createUserWithTeam();
    mockSession({ id: user.id, teamId: user.teamId });
    expect((await POST(killReq("nope"), params("nope"))).status).toBe(403);
  });

  it("kills a running instance: deletes the container and stops the row", async () => {
    const admin = await createAdminUser();
    const { team } = await createUserWithTeam();
    const challenge = await createChallenge();
    const instance = await prisma.challengeInstance.create({
      data: {
        challengeId: challenge.id,
        teamId: team.id,
        state: "RUNNING",
        containerId: "ctfrbt-kill",
        accessUrl: "http://10.0.0.5:31001/",
        token: "tok",
        portMap: { containerPort: 80, hostPort: 31001, protocol: "tcp" },
        sshUser: "user",
        sshPass: "pw",
        lastLog: "some log",
      },
    });

    const calls = recordOrchestrator();
    mockSession({ id: admin.id, isAdmin: true });

    const res = await POST(killReq(instance.id), params(instance.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      instance: Record<string, unknown>;
    };
    expect(body.instance).toMatchObject({
      state: "STOPPED",
      accessUrl: null,
      containerId: null,
    });

    const after = await prisma.challengeInstance.findUniqueOrThrow({
      where: { id: instance.id },
    });
    expect(after).toMatchObject({
      state: "STOPPED",
      accessUrl: null,
      token: null,
      containerId: null,
      sshUser: null,
      sshPass: null,
      lastLog: null,
    });
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.pathname === "/instances/ctfrbt-kill",
      ),
    ).toBe(true);
  });

  it("stops a not-yet-started instance without touching the orchestrator", async () => {
    const admin = await createAdminUser();
    const { team } = await createUserWithTeam();
    const challenge = await createChallenge();
    const instance = await prisma.challengeInstance.create({
      data: {
        challengeId: challenge.id,
        teamId: team.id,
        state: "NOT_STARTED",
      },
    });

    const calls = recordOrchestrator();
    mockSession({ id: admin.id, isAdmin: true });

    const res = await POST(killReq(instance.id), params(instance.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: Record<string, unknown> };
    expect(body.instance).toMatchObject({ state: "STOPPED" });
    expect(calls).toHaveLength(0);
  });

  it("returns 404 for an unknown instance", async () => {
    const admin = await createAdminUser();
    mockSession({ id: admin.id, isAdmin: true });
    expect((await POST(killReq("missing"), params("missing"))).status).toBe(
      404,
    );
  });
});
