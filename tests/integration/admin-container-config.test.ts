vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "@/app/api/admin/challenges/[id]/container/route";
import { prisma } from "../helpers/db";
import {
  createAdminUser,
  createChallenge,
  createUser,
  mockSession,
} from "../helpers/factories";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const json = (body: unknown) =>
  new Request("http://localhost/api/admin/challenges/x/container", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Routes the stubbed orchestrator fetch by URL. */
function mockOrchestrator(
  routes: Record<string, { status: number; body: unknown }>,
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
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
}

describe("admin container config", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUT validates the Dockerfile and starts a build", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    mockOrchestrator({
      "/builds": { status: 202, body: { buildId: "abcdef1234567890" } },
    });

    const res = await PUT(
      json({ dockerfile: "FROM alpine:3.20\n" }),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.buildState).toBe("BUILDING");
    expect(body.config.buildId).toBe("abcdef1234567890");

    const stored = await prisma.containerConfig.findUnique({
      where: { challengeId: challenge.id },
    });
    expect(stored).not.toBeNull();
    expect(stored?.dockerfile).toBe("FROM alpine:3.20\n");
    expect(stored?.buildState).toBe("BUILDING");
  });

  it("PUT rejects an invalid Dockerfile without calling the orchestrator", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("should not be called"));

    const res = await PUT(
      json({ dockerfile: "RUN echo hi\n" }),
      params(challenge.id),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("FROM");
    expect(fetchSpy).not.toHaveBeenCalled();

    const stored = await prisma.containerConfig.findUnique({
      where: { challengeId: challenge.id },
    });
    expect(stored).toBeNull();
  });

  it("PUT records a FAILED build when the orchestrator is unreachable", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );

    const res = await PUT(
      json({ dockerfile: "FROM alpine:3.20\n" }),
      params(challenge.id),
    );
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.config.buildState).toBe("FAILED");
    expect(body.config.buildLog).toContain("orchestrator unreachable");
  });

  it("GET refreshes a BUILDING config from the orchestrator", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    await prisma.containerConfig.create({
      data: {
        challengeId: challenge.id,
        dockerfile: "FROM alpine:3.20\n",
        buildState: "BUILDING",
        buildId: "abcdef1234567890",
      },
    });

    mockOrchestrator({
      "/builds/abcdef1234567890": {
        status: 200,
        body: {
          state: "READY",
          log: "Successfully built",
          digest: "sha256:abc123",
        },
      },
    });

    const res = await GET(
      new Request("http://localhost"),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.buildState).toBe("READY");
    expect(body.config.imageDigest).toBe("sha256:abc123");

    const stored = await prisma.containerConfig.findUnique({
      where: { challengeId: challenge.id },
    });
    expect(stored?.buildState).toBe("READY");
    expect(stored?.imageDigest).toBe("sha256:abc123");
  });

  it("GET marks a lost build as FAILED", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    await prisma.containerConfig.create({
      data: {
        challengeId: challenge.id,
        dockerfile: "FROM alpine:3.20\n",
        buildState: "BUILDING",
        buildId: "abcdef1234567890",
      },
    });

    mockOrchestrator({
      "/builds/abcdef1234567890": { status: 404, body: { error: "not found" } },
    });

    const res = await GET(
      new Request("http://localhost"),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.buildState).toBe("FAILED");
    expect(body.config.buildLog).toContain("build state lost");
  });

  it("GET returns 404 for a challenge without container config", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    const res = await GET(
      new Request("http://localhost"),
      params(challenge.id),
    );
    expect(res.status).toBe(404);
  });

  it("PUT is forbidden for non-admins", async () => {
    const user = await createUser();
    const challenge = await createChallenge();
    mockSession(user);

    const res = await PUT(
      json({ dockerfile: "FROM alpine:3.20\n" }),
      params(challenge.id),
    );
    expect(res.status).toBe(403);
  });
});
