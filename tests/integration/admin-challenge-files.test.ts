vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "fs";
import { readFile, rm } from "fs/promises";
import path from "path";
import { GET, POST } from "@/app/api/admin/challenges/[id]/files/route";
import { DELETE as DELETE_FILE } from "@/app/api/admin/challenges/[id]/files/[fileId]/route";
import { DELETE as DELETE_CHALLENGE } from "@/app/api/admin/challenges/[id]/route";
import { PUT } from "@/app/api/admin/challenges/[id]/container/route";
import { prisma } from "../helpers/db";
import {
  createAdminUser,
  createChallenge,
  createUser,
  mockSession,
} from "../helpers/factories";
import {
  MAX_FILES_PER_CHALLENGE,
  PUBLIC_DIR,
  uploadDirFor,
} from "@/lib/uploads";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const fileParams = (id: string, fileId: string) => ({
  params: Promise.resolve({ id, fileId }),
});

function uploadRequest(files: Array<{ name: string; content: string }>) {
  const fd = new FormData();
  for (const file of files) {
    fd.append("file", new Blob([file.content]), file.name);
  }
  return new Request("http://localhost/api/admin/challenges/x/files", {
    method: "POST",
    body: fd,
  });
}

function json(body: unknown) {
  return new Request("http://localhost/api/admin/challenges/x/container", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Disk dirs created by this suite (the DB is truncated between suites by
// the shared setup; files are not).
const cleanupDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("admin challenge files", () => {
  it("POST stores files on disk and in the database", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    cleanupDirs.push(uploadDirFor(challenge.id));

    const res = await POST(
      uploadRequest([
        { name: "hello.txt", content: "hola" },
        { name: "bin.dat", content: "abcd" },
      ]),
      params(challenge.id),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.files).toHaveLength(2);
    expect(body.files[0].name).toBe("hello.txt");
    expect(body.files[0].storedName).toBe("hello.txt");
    expect(body.files[0].size).toBe(4);

    const rows = await prisma.challengeFile.findMany({
      where: { challengeId: challenge.id },
    });
    expect(rows).toHaveLength(2);
    // rows[0].path is stored relative to public/.
    const onDisk = await readFile(path.join(PUBLIC_DIR, rows[0].path));
    expect(onDisk.toString()).toBe(
      rows[0].name === "hello.txt" ? "hola" : "abcd",
    );
  });

  it("POST is forbidden for non-admins", async () => {
    const user = await createUser();
    const challenge = await createChallenge();
    mockSession(user);

    const res = await POST(
      uploadRequest([{ name: "a.txt", content: "a" }]),
      params(challenge.id),
    );
    expect(res.status).toBe(403);
  });

  it("POST requires at least one file", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    const res = await POST(
      new Request("http://localhost/api/admin/challenges/x/files", {
        method: "POST",
        body: new FormData(),
      }),
      params(challenge.id),
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects when the per-challenge count limit is exceeded", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    // Seed the challenge up to the limit (DB rows only, no disk files).
    await prisma.challengeFile.createMany({
      data: Array.from({ length: MAX_FILES_PER_CHALLENGE }, (_, i) => ({
        name: `seed-${i}.txt`,
        path: `uploads/${challenge.id}/seed-${i}.txt`,
        size: 1,
        challengeId: challenge.id,
      })),
    });

    const res = await POST(
      uploadRequest([{ name: "one-more.txt", content: "x" }]),
      params(challenge.id),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Too many files");
  });

  it("GET lists the challenge's files", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    cleanupDirs.push(uploadDirFor(challenge.id));

    await POST(
      uploadRequest([{ name: "a.txt", content: "a" }]),
      params(challenge.id),
    );

    const res = await GET(
      new Request("http://localhost/api/admin/challenges/x/files"),
      params(challenge.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].name).toBe("a.txt");
    expect(body.files[0].storedName).toBe("a.txt");
  });

  it("DELETE removes the file row and the file on disk", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    cleanupDirs.push(uploadDirFor(challenge.id));

    const created = await POST(
      uploadRequest([{ name: "a.txt", content: "a" }]),
      params(challenge.id),
    );
    const fileId = (await created.json()).files[0].id as string;
    const row = await prisma.challengeFile.findUnique({
      where: { id: fileId },
    });
    expect(existsSync(path.join(PUBLIC_DIR, row!.path))).toBe(true);

    const res = await DELETE_FILE(
      new Request("http://localhost/api/admin/challenges/x/files/y", {
        method: "DELETE",
      }),
      fileParams(challenge.id, fileId),
    );
    expect(res.status).toBe(200);

    expect(
      await prisma.challengeFile.findUnique({ where: { id: fileId } }),
    ).toBeNull();
    expect(existsSync(path.join(PUBLIC_DIR, row!.path))).toBe(false);
  });

  it("DELETE only removes files of the given challenge", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    const other = await createChallenge();
    mockSession(admin);
    cleanupDirs.push(uploadDirFor(challenge.id));

    const created = await POST(
      uploadRequest([{ name: "a.txt", content: "a" }]),
      params(challenge.id),
    );
    const fileId = (await created.json()).files[0].id as string;

    const res = await DELETE_FILE(
      new Request("http://localhost/api/admin/challenges/x/files/y", {
        method: "DELETE",
      }),
      fileParams(other.id, fileId),
    );
    expect(res.status).toBe(404);
    expect(
      await prisma.challengeFile.findUnique({ where: { id: fileId } }),
    ).not.toBeNull();
  });

  it("PUT container sends the files to the orchestrator as multipart", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    cleanupDirs.push(uploadDirFor(challenge.id));

    await POST(
      uploadRequest([{ name: "data.bin", content: "xyz" }]),
      params(challenge.id),
    );

    const captured: {
      body: unknown;
      dockerfile?: string;
      tag?: string;
      fileContent?: string | null;
    } = { body: null };

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/builds") {
          captured.body = init?.body;
          const fd = init?.body as FormData;
          captured.dockerfile = fd.get("dockerfile") as string;
          captured.tag = fd.get("tag") as string;
          const part = fd.get("data.bin");
          captured.fileContent =
            part instanceof File ? await part.text() : null;
          return new Response(JSON.stringify({ buildId: "abcdef1234567890" }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const dockerfile = "FROM alpine:3.20\nEXPOSE 80\nCOPY data.bin /app/\n";
    const res = await PUT(json({ dockerfile }), params(challenge.id));
    expect(res.status).toBe(200);

    expect(captured.body).toBeInstanceOf(FormData);
    expect(captured.dockerfile).toBe(dockerfile);
    expect(captured.tag).toBe(`ctfrbt/${challenge.id}`);
    expect(captured.fileContent).toBe("xyz");
  });

  it("PUT container keeps the JSON payload when there are no files", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    const captured: { body: unknown } = { body: null };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/builds") {
          captured.body = init?.body;
          return new Response(JSON.stringify({ buildId: "abcdef1234567890" }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const res = await PUT(
      json({ dockerfile: "FROM alpine:3.20\nEXPOSE 80\n" }),
      params(challenge.id),
    );
    expect(res.status).toBe(200);
    expect(typeof captured.body).toBe("string");
  });

  it("PUT container fails when a stored file is missing on disk", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);

    // A row pointing at a file that no longer exists on disk.
    await prisma.challengeFile.create({
      data: {
        name: "ghost.bin",
        path: `uploads/${challenge.id}/ghost.bin`,
        size: 1,
        challengeId: challenge.id,
      },
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("should not be called"),
    );

    const res = await PUT(
      json({ dockerfile: "FROM alpine:3.20\nEXPOSE 80\n" }),
      params(challenge.id),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.config.buildState).toBe("FAILED");
    expect(body.config.buildLog).toContain("missing file on disk");
  });

  it("DELETE challenge removes the files directory", async () => {
    const admin = await createAdminUser();
    const challenge = await createChallenge();
    mockSession(admin);
    cleanupDirs.push(uploadDirFor(challenge.id));

    await POST(
      uploadRequest([{ name: "a.txt", content: "a" }]),
      params(challenge.id),
    );
    expect(existsSync(uploadDirFor(challenge.id))).toBe(true);

    const res = await DELETE_CHALLENGE(
      new Request("http://localhost/api/admin/challenges/x", {
        method: "DELETE",
      }),
      params(challenge.id),
    );
    expect(res.status).toBe(200);
    expect(existsSync(uploadDirFor(challenge.id))).toBe(false);
  });
});
