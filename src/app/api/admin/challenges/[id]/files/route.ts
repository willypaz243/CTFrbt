import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidate, CACHE_KEYS } from "@/lib/cache";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  checkUploadLimits,
  sanitizeUploadName,
  storedFileName,
  uploadDirFor,
} from "@/lib/uploads";

// GET /api/admin/challenges/[id]/files — list the challenge's files
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const challenge = await prisma.challenge.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!challenge) {
    return NextResponse.json({ error: "Challenge not found" }, { status: 404 });
  }

  const files = await prisma.challengeFile.findMany({
    where: { challengeId: id },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ files: files.map(fileToInfo) });
}

// POST /api/admin/challenges/[id]/files — upload one or more files
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const challenge = await prisma.challenge.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!challenge) {
    return NextResponse.json({ error: "Challenge not found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "multipart form required" },
      { status: 400 },
    );
  }
  const uploads = (form.getAll("file") as Array<File | string>).filter(
    (f): f is File => f instanceof File,
  );
  if (uploads.length === 0) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const existing = await prisma.challengeFile.findMany({
    where: { challengeId: id },
    select: { size: true },
  });
  const existingTotal = existing.reduce((sum, f) => sum + f.size, 0);
  const limitError = checkUploadLimits(uploads, existing.length, existingTotal);
  if (limitError) {
    return NextResponse.json({ error: limitError }, { status: 400 });
  }

  const dir = uploadDirFor(id);
  const created: Array<{
    id: string;
    name: string;
    path: string;
    size: number;
    storedName: string;
  }> = [];

  try {
    await mkdir(dir, { recursive: true });
    for (const upload of uploads) {
      const cleanName = sanitizeUploadName(upload.name);
      let storedName = cleanName;
      const ext = path.extname(cleanName);
      const base = path.basename(cleanName, ext);
      let counter = 2;
      while (existsSync(path.join(dir, storedName))) {
        storedName = `${base}-${counter}${ext}`;
        counter += 1;
      }
      await writeFile(
        path.join(dir, storedName),
        Buffer.from(await upload.arrayBuffer()),
      );
      const row = await prisma.challengeFile.create({
        data: {
          name: upload.name,
          path: `uploads/${id}/${storedName}`,
          size: upload.size,
          challengeId: id,
        },
      });
      created.push(fileToInfo(row));
    }
  } catch (uploadError) {
    console.error("Challenge file upload error:", uploadError);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }

  invalidate(CACHE_KEYS.CHALLENGES);
  return NextResponse.json({ files: created }, { status: 201 });
}

function fileToInfo(file: {
  id: string;
  name: string;
  path: string;
  size: number;
}): {
  id: string;
  name: string;
  path: string;
  size: number;
  storedName: string;
} {
  return {
    id: file.id,
    name: file.name,
    path: file.path,
    size: file.size,
    storedName: storedFileName(file),
  };
}
