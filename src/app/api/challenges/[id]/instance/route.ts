import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { Prisma, prisma } from "@/lib/prisma";
import { randomBytes } from "crypto";
import { startInstance, getInstance, deleteInstance } from "@/lib/orchestrator";
import { computeExpiresAt } from "@/lib/instance-expiry";
import { sweepExpiredThrottled } from "@/lib/instance-sweeper";

/**
 * Player team instance for a dynamic challenge (#5).
 *
 * One instance per (challenge, team). Starting one (re)creates the
 * container from the built image and publishes its single EXPOSE port on
 * a random host port (#16) — the random port doubles as the token, so it
 * is re-rolled on every start and dies with the container. Stopping
 * deletes the container; the old port/URL stop answering.
 *
 *  GET     /api/challenges/[id]/instance — state (polling)
 *  POST    /api/challenges/[id]/instance — start
 *  DELETE  /api/challenges/[id]/instance — stop
 */

// Host the players reach the published port on (dev: VM LAN IP; prod:
// 167.157.27.65 with the 20000–60000 range forwarded — see #13/#16).
const GATEWAY_HOST = process.env.GATEWAY_HOST ?? "localhost";

const accessUrlFor = (hostPort: number) =>
  `http://${GATEWAY_HOST}:${hostPort}/`;

function toResponse(instance: {
  state: string;
  containerId: string | null;
  token: string | null;
  accessUrl: string | null;
  expiresAt: Date | null;
  startCount: number;
  lastLog: string | null;
}) {
  return {
    state: instance.state,
    accessUrl: instance.accessUrl,
    expiresAt: instance.expiresAt,
    startCount: instance.startCount,
    lastLog: instance.state === "FAILED" ? instance.lastLog : null,
  };
}

async function getActor() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const teamId = session.user.teamId ?? null;
  if (!teamId) {
    return {
      error: NextResponse.json(
        { error: "Your team has no instance yet — join a team" },
        { status: 403 },
      ),
    };
  }
  // Sweep expired instances before any instance read/start (#7).
  await sweepExpiredThrottled();
  return { teamId };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const actor = await getActor();
  if ("error" in actor) return actor.error;

  const challenge = await prisma.challenge.findUnique({ where: { id } });
  if (!challenge) {
    return NextResponse.json({ error: "Challenge not found" }, { status: 404 });
  }

  let instance = await prisma.challengeInstance.findUnique({
    where: { challengeId_teamId: { challengeId: id, teamId: actor.teamId } },
  });
  if (!instance) {
    return NextResponse.json({ error: "instance not found" }, { status: 404 });
  }

  // Reconcile against the engine: a vanished/exited container means the
  // instance is over (the route is dead with it).
  if (
    (instance.state === "STARTING" || instance.state === "RUNNING") &&
    instance.containerId
  ) {
    const info = await getInstance(instance.containerId);
    if (!info || info.state === "EXITED") {
      await deleteInstance(instance.containerId);
      instance = await prisma.challengeInstance.update({
        where: { id: instance.id },
        data: {
          state: "STOPPED",
          accessUrl: null,
          token: null,
          containerId: null,
          portMap: Prisma.JsonNull,
          lastLog: null,
        },
      });
    } else if (instance.state === "STARTING") {
      instance = await prisma.challengeInstance.update({
        where: { id: instance.id },
        data: { state: "RUNNING" },
      });
    }
  }

  return NextResponse.json({ instance: toResponse(instance) });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const actor = await getActor();
  if ("error" in actor) return actor.error;

  const challenge = await prisma.challenge.findUnique({
    where: { id },
    include: { containerConfig: true },
  });
  if (!challenge) {
    return NextResponse.json({ error: "Challenge not found" }, { status: 404 });
  }
  const config = challenge.containerConfig;
  if (!config) {
    return NextResponse.json(
      { error: "not a dynamic challenge" },
      { status: 400 },
    );
  }
  if (config.buildState !== "READY") {
    return NextResponse.json({ error: "image not built" }, { status: 400 });
  }

  const existing = await prisma.challengeInstance.findUnique({
    where: { challengeId_teamId: { challengeId: id, teamId: actor.teamId } },
  });
  if (
    existing &&
    (existing.state === "STARTING" || existing.state === "RUNNING")
  ) {
    return NextResponse.json(
      { error: "instance already running" },
      { status: 409 },
    );
  }

  // Every start re-issues the token and re-rolls the published port: the
  // old URL is not enumerable. The team's flag (#6) is issued once, on
  // the first start, and persists across restarts — it travels to the
  // container only as env FLAG. The TTL (#7) is (re)computed on every
  // start; changing the challenge's TTL later never affects a running
  // instance.
  const token = randomBytes(16).toString("hex");
  const flag =
    existing?.flag ?? `flag{${actor.teamId}-${randomBytes(8).toString("hex")}}`;
  const gameConfig = await prisma.gameConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });
  const expiresAt = computeExpiresAt({
    ttlMinutes: config.ttlMinutes,
    gameEnd: gameConfig?.endTime ?? null,
  });
  const name = `ctfrbt-${id}-${actor.teamId}`;

  const instance = await prisma.challengeInstance.upsert({
    where: { challengeId_teamId: { challengeId: id, teamId: actor.teamId } },
    create: {
      challengeId: id,
      teamId: actor.teamId,
      state: "STARTING",
      token,
      flag,
      containerId: name,
      imageDigest: config.imageDigest,
      expiresAt,
      startCount: 1,
    },
    update: {
      state: "STARTING",
      token,
      containerId: name,
      imageDigest: config.imageDigest,
      accessUrl: null,
      expiresAt,
      lastLog: null,
      startCount: { increment: 1 },
    },
  });

  const result = await startInstance({
    image: `ctfrbt/${id}`,
    name,
    env: { FLAG: flag },
    labels: {
      "ctfrbt.challengeId": id,
      "ctfrbt.teamId": actor.teamId,
    },
  });

  if ("error" in result) {
    const failed = await prisma.challengeInstance.update({
      where: { id: instance.id },
      data: { state: "FAILED", lastLog: result.error },
    });
    return NextResponse.json({ instance: toResponse(failed) }, { status: 502 });
  }

  const published = result.routes[0];
  if (!published) {
    // Defensive: the Dockerfile is validated to expose exactly one port
    // (#16), so an empty route list means a broken orchestrator, not a
    // bad config. Kill the half-published container.
    await deleteInstance(result.containerId);
    const failed = await prisma.challengeInstance.update({
      where: { id: instance.id },
      data: { state: "FAILED", lastLog: "orchestrator published no port" },
    });
    return NextResponse.json({ instance: toResponse(failed) }, { status: 502 });
  }

  const running = await prisma.challengeInstance.update({
    where: { id: instance.id },
    data: {
      state: "RUNNING",
      accessUrl: accessUrlFor(published.hostPort),
      portMap: {
        containerPort: published.containerPort,
        hostPort: published.hostPort,
        protocol: published.protocol,
      },
    },
  });
  return NextResponse.json({ instance: toResponse(running) });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const actor = await getActor();
  if ("error" in actor) return actor.error;

  let instance = await prisma.challengeInstance.findUnique({
    where: { challengeId_teamId: { challengeId: id, teamId: actor.teamId } },
  });
  if (!instance) {
    return NextResponse.json({ error: "instance not found" }, { status: 404 });
  }

  if (instance.state === "STARTING" || instance.state === "RUNNING") {
    if (instance.containerId) {
      // Deletes the container, its network and the gateway route.
      await deleteInstance(instance.containerId);
    }
    instance = await prisma.challengeInstance.update({
      where: { id: instance.id },
      data: {
        state: "STOPPED",
        accessUrl: null,
        token: null,
        containerId: null,
        portMap: Prisma.JsonNull,
        lastLog: null,
      },
    });
  }

  return NextResponse.json({ instance: toResponse(instance) });
}
