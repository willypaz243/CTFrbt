import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteInstance, startInstance } from "@/lib/orchestrator";
import { randomBytes } from "crypto";

/** Short TTL for admin test instances (minutes). */
const TEST_TTL_MINUTES = 30;

interface TestInstanceConfigResponse {
  testContainerId: string | null;
  testState: string | null;
  testAccessUrl: string | null;
  testExpiresAt: string | null;
}

function toTestResponse(config: {
  testContainerId: string | null;
  testState: string | null;
  testAccessUrl: string | null;
  testExpiresAt: Date | null;
}): TestInstanceConfigResponse {
  return {
    testContainerId: config.testContainerId,
    testState: config.testState,
    testAccessUrl: config.testAccessUrl,
    testExpiresAt: config.testExpiresAt?.toISOString() ?? null,
  };
}

// POST /api/admin/challenges/[id]/test-instance — start a test instance
export async function POST(
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
  if (config.buildState !== "READY") {
    return NextResponse.json({ error: "image not built" }, { status: 400 });
  }

  // Replace a previous test instance, if any.
  if (config.testContainerId) {
    await deleteInstance(config.testContainerId);
  }

  const name = `ctfrbt-test-${randomBytes(8).toString("hex")}`;
  const started = await startInstance({
    image: `ctfrbt/${id}`,
    name,
    env: {
      CTFRBT_TEST: "true",
      FLAG: `flag{test-${id}}`,
    },
    labels: {
      "ctfrbt.challengeId": id,
      "ctfrbt.test": "true",
    },
    memoryLimitMb: 256,
    cpuLimit: "0.50",
  });
  if ("error" in started) {
    await prisma.containerConfig.update({
      where: { challengeId: id },
      data: {
        testState: "FAILED",
        testContainerId: null,
        testAccessUrl: null,
        testExpiresAt: null,
      },
    });
    return NextResponse.json({ error: started.error }, { status: 502 });
  }

  const accessUrl = started.routes[0]
    ? `http://localhost:${started.routes[0].hostPort}`
    : null;
  const fresh = await prisma.containerConfig.update({
    where: { challengeId: id },
    data: {
      testContainerId: started.containerId,
      testState: started.state === "RUNNING" ? "RUNNING" : "STARTING",
      testAccessUrl: accessUrl,
      testExpiresAt: new Date(Date.now() + TEST_TTL_MINUTES * 60 * 1000),
    },
  });

  return NextResponse.json({ config: toTestResponse(fresh) });
}

// DELETE /api/admin/challenges/[id]/test-instance — stop and remove it
export async function DELETE(
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

  if (config.testContainerId) {
    await deleteInstance(config.testContainerId);
  }

  const fresh = await prisma.containerConfig.update({
    where: { challengeId: id },
    data: {
      testContainerId: null,
      testState: "STOPPED",
      testAccessUrl: null,
      testExpiresAt: null,
    },
  });

  return NextResponse.json({ config: toTestResponse(fresh) });
}
