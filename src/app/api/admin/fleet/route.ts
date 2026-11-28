import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listInstances } from "@/lib/orchestrator";

/**
 * Admin fleet panel data (story #8): every dynamic-challenge instance
 * enriched with challenge/team info and the live container state from the
 * orchestrator, so the admin can spot a RUNNING row whose container
 * already died. The DB is the source of truth; the orchestrator list only
 * decorates it.
 */

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const [instances, live] = await Promise.all([
      prisma.challengeInstance.findMany({
        include: {
          challenge: { select: { id: true, title: true } },
          team: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      listInstances(),
    ]);

    // name → live state; null when the orchestrator is unreachable.
    const liveByContainer =
      live === null ? null : new Map(live.map((c) => [c.name, c.state]));

    const rows = instances.map((instance) => {
      const portMap = instance.portMap as {
        containerPort?: number;
        hostPort?: number;
      } | null;
      let containerState: "RUNNING" | "PAUSED" | "EXITED" | "MISSING" | null =
        null;
      if (instance.containerId && liveByContainer) {
        containerState = liveByContainer.get(instance.containerId) ?? "MISSING";
      }
      return {
        id: instance.id,
        challenge: instance.challenge,
        team: instance.team,
        state: instance.state,
        accessUrl: instance.accessUrl,
        containerPort: portMap?.containerPort ?? null,
        hostPort: portMap?.hostPort ?? null,
        expiresAt: instance.expiresAt,
        createdAt: instance.createdAt,
        startCount: instance.startCount,
        containerState,
      };
    });

    return NextResponse.json({ instances: rows });
  } catch (error) {
    console.error("Error fetching fleet:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
