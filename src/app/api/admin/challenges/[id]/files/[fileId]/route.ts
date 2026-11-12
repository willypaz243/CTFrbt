import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidate, CACHE_KEYS } from "@/lib/cache";
import { rm } from "fs/promises";
import path from "path";
import { PUBLIC_DIR } from "@/lib/uploads";

// DELETE /api/admin/challenges/[id]/files/[fileId] — remove one file
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, fileId } = await params;
  const file = await prisma.challengeFile.findFirst({
    where: { id: fileId, challengeId: id },
  });
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // file.path is stored relative to public/ (see the download route);
  // guard against anything that would escape the uploads directory.
  const filePath = path.resolve(PUBLIC_DIR, file.path);
  const uploadsRoot = path.join(PUBLIC_DIR, "uploads");
  const safe = filePath.startsWith(uploadsRoot + path.sep);
  await prisma.challengeFile.delete({ where: { id: fileId } });
  if (safe) {
    await rm(filePath, { force: true }).catch(() => {});
  }
  invalidate(CACHE_KEYS.CHALLENGES);
  return NextResponse.json({ message: "File deleted" });
}
