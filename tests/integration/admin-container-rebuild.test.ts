vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "@/app/api/admin/challenges/[id]/container/route";
import { prisma } from "../helpers/db";
import {
  createAdminUser,
  createChallenge,
  mockSession,
} from "../helpers/factories";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const put = (id: string, dockerfile: string) =>
  new Request(`http://localhost/api/admin/challenges/${id}/container`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dockerfile }),
  });

const get = (id: string) =>
  new Request(`http://localhost/api/admin/challenges/${id}/container`);

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

/** Drive a fresh challenge to a READY image (first build). */
async function buildFirstImage(challengeId: string, digest: string) {
  mockOrchestrator({
    "/builds": { status: 202, body: { buildId: "abcdef1234567890" } },
  });
  await PUT(
    put(challengeId, "FROM alpine:3.20\nEXPOSE 80\n"),
    params(challengeId),
  );
  mockOrchestrator({
    "/builds/abcdef1234567890": {
      status: 200,
      body: { state: "READY", log: "ok", digest },
    },
  });
  await GET(get(challengeId), params(challengeId));
}

describe("admin container rolling rebuild", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rebuild keeps the active image and tracks a pending build", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await buildFirstImage(challenge.id, "sha256:old");

    const storedBefore = await prisma.containerConfig.findUnique({
      where: { challengeId: challenge.id },
    });
    expect(storedBefore?.imageDigest).toBe("sha256:old");

    mockOrchestrator({
      "/builds": { status: 202, body: { buildId: "1111111111111111" } },
    });
    const res = await PUT(
      put(challenge.id, "FROM alpine:3.20\nEXPOSE 80\nRUN echo v2\n"),
      params(challenge.id),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    // Active image keeps serving: READY + same digest; pending build tracked.
    expect(body.config.buildState).toBe("READY");
    expect(body.config.imageDigest).toBe("sha256:old");
    expect(body.config.pendingState).toBe("BUILDING");
    expect(body.config.buildId).toBe("1111111111111111");
  });

  it("a READY rebuild promotes the new digest to the active image", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await buildFirstImage(challenge.id, "sha256:old");

    mockOrchestrator({
      "/builds": { status: 202, body: { buildId: "2222222222222222" } },
    });
    await PUT(
      put(challenge.id, "FROM alpine:3.20\nEXPOSE 80\nRUN echo v2\n"),
      params(challenge.id),
    );

    mockOrchestrator({
      "/builds/2222222222222222": {
        status: 200,
        body: { state: "READY", log: "ok v2", digest: "sha256:new" },
      },
    });
    const res = await GET(get(challenge.id), params(challenge.id));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.buildState).toBe("READY");
    expect(body.config.imageDigest).toBe("sha256:new");
    expect(body.config.pendingState).toBeNull();
    expect(body.config.pendingDigest).toBe("sha256:new");

    const stored = await prisma.containerConfig.findUnique({
      where: { challengeId: challenge.id },
    });
    expect(stored?.imageDigest).toBe("sha256:new");
  });

  it("a FAILED rebuild keeps the active digest and stores the error log", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await buildFirstImage(challenge.id, "sha256:old");

    mockOrchestrator({
      "/builds": { status: 202, body: { buildId: "3333333333333333" } },
    });
    await PUT(
      put(challenge.id, "FROM alpine:3.20\nEXPOSE 80\nRUN false\n"),
      params(challenge.id),
    );

    mockOrchestrator({
      "/builds/3333333333333333": {
        status: 200,
        body: { state: "FAILED", log: "step 2 failed badly" },
      },
    });
    const res = await GET(get(challenge.id), params(challenge.id));
    expect(res.status).toBe(200);

    const body = await res.json();
    // Back to READY on the old image, with the failure visible.
    expect(body.config.buildState).toBe("READY");
    expect(body.config.imageDigest).toBe("sha256:old");
    expect(body.config.pendingState).toBe("FAILED");
    expect(body.config.pendingLog).toContain("step 2 failed badly");

    const stored = await prisma.containerConfig.findUnique({
      where: { challengeId: challenge.id },
    });
    expect(stored?.imageDigest).toBe("sha256:old");
  });

  it("an unreachable orchestrator during rebuild leaves the active image intact", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    await buildFirstImage(challenge.id, "sha256:old");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );

    const res = await PUT(
      put(challenge.id, "FROM alpine:3.20\nEXPOSE 80\nRUN echo v2\n"),
      params(challenge.id),
    );
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.config.buildState).toBe("READY");
    expect(body.config.imageDigest).toBe("sha256:old");
    expect(body.config.pendingState).toBe("FAILED");
    expect(body.config.pendingLog).toContain("orchestrator unreachable");
  });

  it("a failed first build (no active image) ends FAILED", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    mockOrchestrator({
      "/builds": { status: 202, body: { buildId: "4444444444444444" } },
    });
    await PUT(
      put(challenge.id, "FROM alpine:3.20\nEXPOSE 80\n"),
      params(challenge.id),
    );

    mockOrchestrator({
      "/builds/4444444444444444": {
        status: 200,
        body: { state: "FAILED", log: "no FROM" },
      },
    });
    const res = await GET(get(challenge.id), params(challenge.id));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.config.buildState).toBe("FAILED");
    expect(body.config.imageDigest).toBeNull();
    expect(body.config.buildLog).toContain("no FROM");
  });
});
