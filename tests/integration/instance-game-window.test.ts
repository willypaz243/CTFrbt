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
  setGameConfig,
} from "../helpers/factories";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const postReq = (id: string) =>
  new Request(`http://localhost/api/challenges/${id}/instance`, {
    method: "POST",
  });
const delReq = (id: string) =>
  new Request(`http://localhost/api/challenges/${id}/instance`, {
    method: "DELETE",
  });

function recordFetch() {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
    calls.push(String(input));
    return new Response("{}", { status: 404 });
  });
  return calls;
}

describe("instance start vs game window", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to start an instance after the CTF has ended", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    // Ended window: both start and end in the past.
    await setGameConfig(
      new Date(Date.now() - 2 * 3600_000),
      new Date(Date.now() - 3600_000),
    );
    mockSession({ id: user.id, teamId: team.id });
    const calls = recordFetch();

    const res = await POST(postReq(challenge.id), params(challenge.id));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("The CTF has ended");
    expect(calls).toHaveLength(0);
    const row = await prisma.challengeInstance.findFirst({
      where: { challengeId: challenge.id, teamId: team.id },
    });
    expect(row).toBeNull();
  });

  it("still lets the team stop its instance after the CTF ended", async () => {
    const { user, team } = await createUserWithTeam();
    const challenge = await createChallenge();
    await setGameConfig(
      new Date(Date.now() - 2 * 3600_000),
      new Date(Date.now() - 3600_000),
    );
    await prisma.challengeInstance.create({
      data: { challengeId: challenge.id, teamId: team.id, state: "STOPPED" },
    });
    mockSession({ id: user.id, teamId: team.id });

    const res = await DELETE(delReq(challenge.id), params(challenge.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: { state: string } };
    expect(body.instance.state).toBe("STOPPED");
  });
});
