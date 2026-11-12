/**
 * CTFrbt orchestrator — talks to the Docker Engine API (Docker or podman)
 * to build challenge images. Stateless with respect to the CTF database:
 * the app sends what it needs and polls back build results.
 *
 * POST /builds accepts either a JSON body ({ dockerfile, tag }) or a
 * multipart/form-data body with `dockerfile`/`tag` fields and one file
 * part per challenge file, where the *field name* is the flat name the
 * Dockerfile must COPY. Files land in the build context next to the
 * Dockerfile.
 *
 * Auth: `Authorization: Bearer <ORCHESTRATOR_SECRET>` on every route
 * except /healthz. The service must not be reachable from outside the
 * compose network / localhost.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Dockerode from "dockerode";
import { create as createTar } from "tar";
import busboy from "busboy";

const PORT = Number(process.env.PORT ?? 7474);
const HOST = process.env.HOST ?? "0.0.0.0";
const SECRET = process.env.ORCHESTRATOR_SECRET ?? "";
const SOCKET_PATH = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";

const MAX_BUILD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BUILD_FILES = 20;
const MAX_FIELD_BYTES = 256 * 1024;

if (!SECRET) {
  console.error(
    "orchestrator: ORCHESTRATOR_SECRET is required — refusing to start.",
  );
  process.exit(1);
}

// --- Docker engine (Engine API: works with Docker and podman sockets) ---
let docker: Dockerode | null = null;
try {
  docker = new Dockerode({ socketPath: SOCKET_PATH });
  await docker.version();
  console.log(`orchestrator: connected to Docker Engine API at ${SOCKET_PATH}`);
} catch (err) {
  console.error(
    `orchestrator: cannot reach Docker Engine API at ${SOCKET_PATH}:`,
    err,
  );
  process.exit(1);
}

// --- Build registry (in-memory; the app polls until terminal state) ---
type BuildState = {
  id: string;
  tag: string;
  state: "BUILDING" | "READY" | "FAILED";
  log: string;
  digest?: string;
};
const builds = new Map<string, BuildState>();
const MAX_BUILDS = 32;
// Drop finished builds once the registry overflows.
function pruneBuilds() {
  if (builds.size <= MAX_BUILDS) return;
  for (const [id, b] of builds) {
    if (b.state !== "BUILDING") builds.delete(id);
    if (builds.size <= MAX_BUILDS) break;
  }
}

const TAG_RE = /^[a-z0-9][a-z0-9._/-]*$/i;

function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Flat, collision-safe name for a build context member. Spaces become
 * underscores so COPY never needs quoting (buildah limitation).
 */
function sanitizeContextName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function readMultipart(req: IncomingMessage): Promise<{
  dockerfile: string;
  tag: string;
  files: Array<{ name: string; data: Buffer }>;
}> {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_BUILD_FILE_BYTES,
        files: MAX_BUILD_FILES,
      },
    });
    let dockerfile = "";
    let tag = "";
    const files: Array<{ name: string; data: Buffer }> = [];
    const pending: Array<Promise<void>> = [];
    bb.on("field", (name, value) => {
      if (name === "dockerfile") dockerfile += value;
      else if (name === "tag") tag += value;
      if (dockerfile.length + tag.length > MAX_FIELD_BYTES) {
        bb.destroy();
        reject(new Error("field too large"));
      }
    });
    bb.on("file", (name, stream) => {
      const clean = sanitizeContextName(name);
      if (!clean) {
        stream.resume();
        reject(new Error("invalid file name"));
        return;
      }
      pending.push(
        collectStream(stream).then((data) => {
          files.push({ name: clean, data });
        }),
      );
    });
    bb.on("error", (err) => {
      const e = err as Error & { fileLimit?: boolean; fileSize?: boolean };
      if (e.fileLimit)
        reject(new Error(`too many files (max ${MAX_BUILD_FILES})`));
      else if (e.fileSize) reject(new Error("file too large (max 25 MB)"));
      else reject(err);
    });
    bb.on("finish", () => {
      Promise.all(pending)
        .then(() => resolve({ dockerfile, tag, files }))
        .catch(reject);
    });
    req.pipe(bb);
  });
}

async function runBuild(
  buildId: string,
  dockerfile: string,
  tag: string,
  files: Array<{ name: string; data: Buffer }>,
) {
  const build: BuildState = { id: buildId, tag, state: "BUILDING", log: "" };
  builds.set(buildId, build);
  const dir = path.join(tmpdir(), `ctfrbt-build-${buildId}`);
  try {
    await mkdir(dir, { recursive: true });
    const dfPath = path.join(dir, "Dockerfile");
    await writeFile(dfPath, dockerfile);
    for (const file of files) {
      await writeFile(path.join(dir, file.name), file.data);
    }
    const tarPath = path.join(dir, "context.tar");
    // Build context: the Dockerfile plus the uploaded files (no host
    // files leak in). cwd makes the members flat names, which the engine
    // expects for COPY.
    await createTar({ file: tarPath, portable: true, cwd: dir }, [
      "Dockerfile",
      ...files.map((f) => f.name),
    ]);
    const stream = createReadStream(tarPath);
    // dockerode resolves to a node PassThrough of JSON-line build events.
    const out = (await docker!.buildImage(stream, {
      t: tag,
      rm: true,
      pull: true,
    })) as unknown as NodeJS.ReadableStream;
    let buf = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      build.log += line + "\n";
      if (build.log.length > 200_000) build.log = build.log.slice(-100_000);
      try {
        const ev = JSON.parse(line) as {
          aux?: { ID?: string };
          error?: unknown;
        };
        if (ev.aux?.ID) build.digest = ev.aux.ID;
        if (typeof ev.error === "string") build.state = "FAILED";
      } catch {
        /* non-JSON log line — keep it as text */
      }
    };
    out.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    out.on("end", () => {
      if (buf.trim()) handleLine(buf);
      if (build.state === "BUILDING") {
        build.state = build.digest ? "READY" : "FAILED";
        if (!build.digest) build.log += "build ended without an image id\n";
      }
    });
    out.on("error", (err: Error) => {
      build.state = "FAILED";
      build.log += `${err.message}\n`;
    });
  } catch (err) {
    build.state = "FAILED";
    build.log += `\n${(err as Error).message}`;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    pruneBuilds();
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const auth = req.headers.authorization ?? "";
    if (url.pathname !== "/healthz" && auth !== `Bearer ${SECRET}`) {
      send(res, 401, { error: "unauthorized" });
      return;
    }

    if (url.pathname === "/healthz") {
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/builds") {
      const contentType = req.headers["content-type"] ?? "";
      let dockerfile = "";
      let tag = "";
      let files: Array<{ name: string; data: Buffer }> = [];

      if (contentType.includes("multipart/form-data")) {
        let parsed: Awaited<ReturnType<typeof readMultipart>>;
        try {
          parsed = await readMultipart(req);
        } catch (err) {
          const message = (err as Error).message;
          send(res, message.startsWith("file too large") ? 413 : 400, {
            error: message,
          });
          return;
        }
        ({ dockerfile, tag, files } = parsed);
      } else {
        const raw = await readBody(req);
        let body: { dockerfile?: string; tag?: string };
        try {
          body = JSON.parse(raw);
        } catch {
          send(res, 400, { error: "invalid JSON body" });
          return;
        }
        dockerfile = body.dockerfile ?? "";
        tag = body.tag ?? "";
      }

      if (dockerfile.trim().length === 0) {
        send(res, 400, { error: "dockerfile is required" });
        return;
      }
      if (!TAG_RE.test(tag) || tag.includes("..")) {
        send(res, 400, { error: "invalid tag" });
        return;
      }
      // De-duplicate context names (the app already sends unique stored
      // names; this is defense in depth).
      const seen = new Set<string>();
      for (const file of files) {
        let name = file.name;
        const ext = path.extname(name);
        const base = path.basename(name, ext);
        let counter = 2;
        while (seen.has(name)) {
          name = `${base}-${counter}${ext}`;
          counter += 1;
        }
        seen.add(name);
        file.name = name;
      }

      const id = randomBytes(8).toString("hex");
      // Fire-and-forget: the app polls GET /builds/:id.
      void runBuild(id, dockerfile, tag, files);
      send(res, 202, { buildId: id });
      return;
    }

    const match = url.pathname.match(/^\/builds\/([a-f0-9]{16})$/);
    if (req.method === "GET" && match) {
      const build = builds.get(match[1]);
      if (!build) {
        send(res, 404, { error: "build not found" });
        return;
      }
      send(res, 200, {
        state: build.state,
        log: build.log,
        digest: build.digest ?? null,
      });
      return;
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error("orchestrator: request error:", err);
    send(res, 500, { error: "internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `orchestrator: listening on http://${HOST}:${PORT} (socket ${SOCKET_PATH})`,
  );
});
