vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST } from "@/app/api/challenges/[id]/instance/route";
import { sweepExpiredInstances } from "@/lib/instance-sweeper";
import { prisma } from "../helpers/db";
import {
  createChallenge,
  createUserWithTeam,
  mockSession,
} from "../helpers/factories";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string, method: "POST" | "DELETE") =>
  new Request(`http://localhost/api/challenges/${id}/instance`, { method });

/** Stub the orchestrator and record the start request body. */
function mockOrchestrator(hostPort: number) {
  let sent: Record<string, unknown> | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === "/instances") {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      }
      if (url.pathname === "/instances") {
        return new Response(
          JSON.stringify({
            containerId: "stub",
            name: "stub",
            state: "RUNNING",
            routes: [{ containerPort: 22, hostPort, protocol: "tcp" }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ removed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  return () => sent;
}

async function createReadyConfig(challengeId: string) {
  return prisma.containerConfig.create({
    data: {
      challengeId,
      dockerfile: "FROM alpine:3.20\nEXPOSE 22\n",
      buildState: "READY",
      imageDigest: "sha256:abc123",
    },
  });
}

async function startInstance(
  challengeId: string,
  teamId: string,
  hostPort: number,
) {
  const getSent = mockOrchestrator(hostPort);
  const res = await POST(req(challengeId, "POST"), params(challengeId));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    instance: {
      state: string;
      sshUser: string | null;
      sshPass: string | null;
      containerPort: number | null;
    };
  };
  return { body: body.instance, getSent };
}

describe("per-team SSH credentials (#17)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues a sanitized user and a random password, sent as env", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession({ ...user, alias: "Alice-99!" });
    await createReadyConfig(challenge.id);

    const { body, getSent } = await startInstance(challenge.id, team.id, 24321);
    expect(body.state).toBe("RUNNING");
    // The UI uses the container port (22) to decide whether the
    // credentials belong to an SSH challenge (#17).
    expect(body.containerPort).toBe(22);
    expect(body.sshUser).toBe("alice99");
    expect(body.sshPass).toMatch(/^[a-zA-Z0-9]{12}$/);

    const sent = getSent()!;
    const env = sent.env as Record<string, string>;
    expect(env.SSH_USER).toBe("alice99");
    expect(env.SSH_PASS).toBe(body.sshPass);
  });

  it("rotates the password on restart, keeping the user", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession({ ...user, alias: "bob" });
    await createReadyConfig(challenge.id);

    const first = await startInstance(challenge.id, team.id, 24321);
    await DELETE(req(challenge.id, "DELETE"), params(challenge.id));
    const second = await startInstance(challenge.id, team.id, 30500);

    expect(second.body.sshUser).toBe("bob");
    expect(second.body.sshPass).not.toBe(first.body.sshPass);
    expect(second.body.sshPass).toMatch(/^[a-zA-Z0-9]{12}$/);
  });

  it("clears the credentials on stop", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const { body } = await startInstance(challenge.id, team.id, 24321);
    expect(body.sshPass).not.toBeNull();

    const res = await DELETE(req(challenge.id, "DELETE"), params(challenge.id));
    const stopped = (await res.json()) as {
      instance: { sshUser: string | null; sshPass: string | null };
    };
    expect(stopped.instance.sshUser).toBeNull();
    expect(stopped.instance.sshPass).toBeNull();
  });

  it("clears the credentials when the sweeper expires the instance", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const { body } = await startInstance(challenge.id, team.id, 24321);
    expect(body.sshPass).not.toBeNull();

    // Force expiration and run the sweep.
    await prisma.challengeInstance.update({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await sweepExpiredInstances();

    const stored = await prisma.challengeInstance.findUnique({
      where: {
        challengeId_teamId: { challengeId: challenge.id, teamId: team.id },
      },
    });
    expect(stored?.state).toBe("EXPIRED");
    expect(stored?.sshUser).toBeNull();
    expect(stored?.sshPass).toBeNull();
  });
});
