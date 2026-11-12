import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateDockerfile } from "@/lib/dockerfile";
import {
  deleteInstance,
  getBuild,
  getInstance,
  startBuild,
} from "@/lib/orchestrator";
import { readFile } from "fs/promises";
import path from "path";
import { PUBLIC_DIR, storedFileName } from "@/lib/uploads";

interface ContainerConfigResponse {
  dockerfile: string;
  buildState: string;
  buildId: string | null;
  imageDigest: string | null;
  buildLog: string | null;
  testContainerId: string | null;
  testState: string | null;
  testAccessUrl: string | null;
  testExpiresAt: string | null;
}

interface ChallengeFileInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  storedName: string;
}

function toResponse(config: {
  dockerfile: string;
  buildState: string;
  buildId: string | null;
  imageDigest: string | null;
  buildLog: string | null;
  testContainerId: string | null;
  testState: string | null;
  testAccessUrl: string | null;
  testExpiresAt: Date | null;
}): ContainerConfigResponse {
  return {
    dockerfile: config.dockerfile,
    buildState: config.buildState,
    buildId: config.buildId,
    imageDigest: config.imageDigest,
    buildLog: config.buildLog,
    testContainerId: config.testContainerId,
    testState: config.testState,
    testAccessUrl: config.testAccessUrl,
    testExpiresAt: config.testExpiresAt?.toISOString() ?? null,
  };
}

// PUT /api/admin/challenges/[id]/container — save the Dockerfile and kick off a build
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const challenge = await prisma.challenge.findUnique({ where: { id } });
  if (!challenge) {
    return NextResponse.json({ error: "Challenge not found" }, { status: 404 });
  }

  let body: { dockerfile?: string };
  try {
    body = (await request.json()) as { dockerfile?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const validation = validateDockerfile(body.dockerfile ?? "");
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.errors.join("; ") },
      { status: 400 },
    );
  }

  let config = await prisma.containerConfig.upsert({
    where: { challengeId: id },
    create: {
      challengeId: id,
      dockerfile: body.dockerfile as string,
      buildState: "QUEUED",
    },
    update: {
      dockerfile: body.dockerfile as string,
      buildState: "QUEUED",
      buildId: null,
      buildLog: null,
    },
  });

  // Gather the challenge's uploaded files so the Dockerfile can COPY them.
  const fileRows = await prisma.challengeFile.findMany({
    where: { challengeId: id },
  });
  const buildFiles: Array<{ name: string; data: Buffer }> = [];
  for (const row of fileRows) {
    let data: Buffer;
    try {
      // row.path is stored relative to public/ (see the download route).
      data = await readFile(path.join(PUBLIC_DIR, row.path));
    } catch {
      config = await prisma.containerConfig.update({
        where: { challengeId: id },
        data: {
          buildState: "FAILED",
          buildLog: `missing file on disk: ${row.name}`,
        },
      });
      return NextResponse.json(
        { config: toResponse(config), warnings: validation.warnings },
        { status: 500 },
      );
    }
    buildFiles.push({ name: storedFileName(row), data });
  }

  const started = await startBuild(
    body.dockerfile as string,
    `ctfrbt/${id}`,
    buildFiles,
  );
  if ("error" in started) {
    config = await prisma.containerConfig.update({
      where: { challengeId: id },
      data: { buildState: "FAILED", buildLog: started.error },
    });
    return NextResponse.json(
      { config: toResponse(config), warnings: validation.warnings },
      { status: 502 },
    );
  }

  config = await prisma.containerConfig.update({
    where: { challengeId: id },
    data: { buildState: "BUILDING", buildId: started.buildId },
  });

  return NextResponse.json({
    config: toResponse(config),
    warnings: validation.warnings,
  });
}

// GET /api/admin/challenges/[id]/container — current config + build state
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const config = await prisma.containerConfig.findUnique({
    where: { challengeId: id },
  });
  if (!config) {
    return NextResponse.json(
      { error: "Challenge has no container config" },
      { status: 404 },
    );
  }

  // Refresh non-terminal builds from the orchestrator.
  if (
    config.buildId &&
    (config.buildState === "QUEUED" || config.buildState === "BUILDING")
  ) {
    const result = await getBuild(config.buildId);
    if (result === null) {
      // The orchestrator lost track of the build (e.g. restarted).
      await prisma.containerConfig.update({
        where: { challengeId: id },
        data: {
          buildState: "FAILED",
          buildLog: "build state lost (orchestrator restarted)",
        },
      });
    } else if (result.state === "READY") {
      await prisma.containerConfig.update({
        where: { challengeId: id },
        data: {
          buildState: "READY",
          imageDigest: result.digest,
          buildLog: result.log.slice(-20_000),
        },
      });
    } else if (result.state === "FAILED") {
      await prisma.containerConfig.update({
        where: { challengeId: id },
        data: {
          buildState: "FAILED",
          imageDigest: null,
          buildLog: result.log.slice(-20_000),
        },
      });
    }
  }

  // Reconcile the test instance: expired TTL, gone container, or exited.
  if (
    config.testContainerId &&
    (config.testState === "STARTING" ||
      config.testState === "RUNNING" ||
      config.testState === "EXITED")
  ) {
    const expired =
      config.testExpiresAt !== null && config.testExpiresAt < new Date();
    const inst = expired ? null : await getInstance(config.testContainerId);
    if (expired) {
      await deleteInstance(config.testContainerId);
      await prisma.containerConfig.update({
        where: { challengeId: id },
        data: {
          testState: "EXPIRED",
          testContainerId: null,
          testAccessUrl: null,
          testExpiresAt: null,
        },
      });
    } else if (inst === null || inst.state === "EXITED") {
      // Gone (or crashed): remove it — a test instance never lingers.
      if (inst) await deleteInstance(config.testContainerId);
      await prisma.containerConfig.update({
        where: { challengeId: id },
        data: {
          testState: "STOPPED",
          testContainerId: null,
          testAccessUrl: null,
          testExpiresAt: null,
        },
      });
    }
  }

  const fresh = await prisma.containerConfig.findUnique({
    where: { challengeId: id },
  });
  const fileRows = await prisma.challengeFile.findMany({
    where: { challengeId: id },
    orderBy: { name: "asc" },
  });
  const files: ChallengeFileInfo[] = fileRows.map((row) => ({
    id: row.id,
    name: row.name,
    path: row.path,
    size: row.size,
    storedName: storedFileName(row),
  }));
  return NextResponse.json({ config: toResponse(fresh!), files });
}
