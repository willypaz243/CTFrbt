vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DELETE as stopInstance,
  POST as startInstance,
} from "@/app/api/challenges/[id]/instance/route";
import { POST as submit } from "@/app/api/submissions/route";
import { RATE_LIMIT_MS } from "@/lib/rate-limit";
import { prisma } from "../helpers/db";
import {
  createChallenge,
  createUserWithTeam,
  mockSession,
  setGameConfig,
} from "../helpers/factories";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const instanceReq = (id: string, method: "POST" | "DELETE") =>
  new Request(`http://localhost/api/challenges/${id}/instance`, { method });

const submissionReq = (challengeId: string, flag: string) =>
  new Request("http://localhost/api/submissions", {
    method: "POST",
    body: JSON.stringify({ challengeId, flag }),
    headers: { "Content-Type": "application/json" },
  });

/** Stub the orchestrator and record every request it receives. */
function mockOrchestrator(
  routes: Record<string, { status: number; body: unknown }> = {},
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

/** Start the team instance and return the env the orchestrator received. */
async function startTeamInstance(
  challengeId: string,
): Promise<Record<string, string>> {
  const name = "stub";
  const calls = mockOrchestrator({
    "/instances": {
      status: 201,
      body: { containerId: name, name, state: "RUNNING", routes: [] },
    },
  });
  const res = await startInstance(
    instanceReq(challengeId, "POST"),
    params(challengeId),
  );
  expect(res.status).toBe(200);
  const create = calls.find(
    (c) => c.method === "POST" && c.url === "/instances",
  );
  expect(create).toBeDefined();
  return (JSON.parse(create!.body!) as { env: Record<string, string> }).env;
}

async function storedFlag(challengeId: string, teamId: string) {
  const row = await prisma.challengeInstance.findUnique({
    where: { challengeId_teamId: { challengeId, teamId } },
    select: { flag: true },
  });
  return row?.flag ?? null;
}

describe("dynamic per-team flag (#6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects a per-team flag as env and persists it", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const env = await startTeamInstance(challenge.id);

    expect(env.FLAG).toMatch(new RegExp(`^flag{${team.id}-[a-f0-9]{16}}$`));
    expect(await storedFlag(challenge.id, team.id)).toBe(env.FLAG);
  });

  it("keeps the flag across restarts while the token rotates", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);

    const firstEnv = await startTeamInstance(challenge.id);
    await stopInstance(
      instanceReq(challenge.id, "DELETE"),
      params(challenge.id),
    );

    const secondEnv = await startTeamInstance(challenge.id);

    expect(secondEnv.FLAG).toBe(firstEnv.FLAG);
    expect(await storedFlag(challenge.id, team.id)).toBe(firstEnv.FLAG);
  });

  it("issues a distinct flag per team", async () => {
    const a = await createUserWithTeam();
    const b = await createUserWithTeam();
    const challenge = await createChallenge();
    await createReadyConfig(challenge.id);

    mockSession(a.user);
    const envA = await startTeamInstance(challenge.id);

    mockSession(b.user);
    const envB = await startTeamInstance(challenge.id);

    expect(envB.FLAG).not.toBe(envA.FLAG);
    expect(await storedFlag(challenge.id, b.team.id)).toBe(envB.FLAG);
  });

  it("scores the team's own flag and dedupes the resubmission", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);
    await setGameConfig(
      new Date(Date.now() - 60 * 60 * 1000),
      new Date(Date.now() + 60 * 60 * 1000),
    );

    const env = await startTeamInstance(challenge.id);

    const first = await submit(submissionReq(challenge.id, env.FLAG!));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { correct: boolean };
    expect(firstBody.correct).toBe(true);

    const score = await prisma.score.findFirst({
      where: { teamId: team.id, challengeId: challenge.id },
    });
    expect(score).not.toBeNull();
    expect(score?.points).toBe(challenge.points);

    // Rate limit is per user — wait the window out, then resubmit.
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS + 100));

    const second = await submit(submissionReq(challenge.id, env.FLAG!));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      correct: boolean;
      alreadySubmitted: boolean;
    };
    expect(secondBody.correct).toBe(true);
    expect(secondBody.alreadySubmitted).toBe(true);

    const scores = await prisma.score.count({
      where: { teamId: team.id, challengeId: challenge.id },
    });
    expect(scores).toBe(1);
  }, 30000);

  it("rejects a foreign team's flag and logs FOREIGN_FLAG_SUBMIT", async () => {
    const a = await createUserWithTeam();
    const b = await createUserWithTeam();
    const challenge = await createChallenge();
    await createReadyConfig(challenge.id);
    await setGameConfig(
      new Date(Date.now() - 60 * 60 * 1000),
      new Date(Date.now() + 60 * 60 * 1000),
    );

    mockSession(a.user);
    const envA = await startTeamInstance(challenge.id);

    mockSession(b.user);
    await startTeamInstance(challenge.id);

    const res = await submit(submissionReq(challenge.id, envA.FLAG!));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(false);

    const log = await prisma.activityLog.findFirst({
      where: { teamId: b.team.id, type: "FOREIGN_FLAG_SUBMIT" },
    });
    expect(log).not.toBeNull();
    expect(log?.description).toContain(challenge.title);

    const score = await prisma.score.findFirst({
      where: { teamId: b.team.id, challengeId: challenge.id },
    });
    expect(score).toBeNull();
  });

  it("ignores the static flag on a dynamic challenge", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    mockSession(user);
    await createReadyConfig(challenge.id);
    await setGameConfig(
      new Date(Date.now() - 60 * 60 * 1000),
      new Date(Date.now() + 60 * 60 * 1000),
    );

    await startTeamInstance(challenge.id);

    const res = await submit(submissionReq(challenge.id, challenge.flag!));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(false);

    const score = await prisma.score.findFirst({
      where: { teamId: team.id, challengeId: challenge.id },
    });
    expect(score).toBeNull();
    const log = await prisma.activityLog.findFirst({
      where: { type: "FOREIGN_FLAG_SUBMIT" },
    });
    expect(log).toBeNull();
  });
});
