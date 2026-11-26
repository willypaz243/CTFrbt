import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const [config, groups, errors] = await Promise.all([
    prisma.gameConfig.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.challengeInstance.groupBy({ by: ["state"], _count: true }),
    prisma.challengeInstance.count({
      where: { suspensionError: { not: null } },
    }),
  ]);
  return NextResponse.json(
    {
      controllerOnline:
        !!config?.instanceControllerHeartbeat &&
        Date.now() - config.instanceControllerHeartbeat.getTime() < 30_000,
      states: Object.fromEntries(
        groups.map((group) => [group.state, group._count]),
      ),
      errors,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
