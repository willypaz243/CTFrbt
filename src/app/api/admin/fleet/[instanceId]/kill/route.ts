import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { Prisma, prisma } from "@/lib/prisma";
import { deleteInstance } from "@/lib/orchestrator";

/**
 * Admin kill for the fleet panel (story #8): stop any dynamic-challenge
 * instance, delete its container and clear the access data — the same
 * cleanup the player's own stop performs, but for any team's instance.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  const { instanceId } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const instance = await prisma.challengeInstance.findUnique({
    where: { id: instanceId },
  });
  if (!instance) {
    return NextResponse.json({ error: "instance not found" }, { status: 404 });
  }

  if (instance.state === "STARTING" || instance.state === "RUNNING") {
    if (instance.containerId) {
      // Deletes the container, its network and any gateway route.
      await deleteInstance(instance.containerId);
    }
  }

  const stopped = await prisma.challengeInstance.update({
    where: { id: instance.id },
    data: {
      state: "STOPPED",
      accessUrl: null,
      token: null,
      containerId: null,
      portMap: Prisma.JsonNull,
      sshUser: null,
      sshPass: null,
      lastLog: null,
    },
  });

  return NextResponse.json({ instance: stopped });
}
