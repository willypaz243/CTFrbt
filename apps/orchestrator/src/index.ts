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
import { pickHostPort } from "./ports.js";

const PORT = Number(process.env.PORT ?? 7474);
const HOST = process.env.HOST ?? "0.0.0.0";
const SECRET = process.env.ORCHESTRATOR_SECRET ?? "";
const SOCKET_PATH = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";

const MAX_BUILD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BUILD_FILES = 20;
const MAX_FIELD_BYTES = 256 * 1024;

// --- Gateway (Traefik file provider) -----------------------------------
// Each running instance gets one dynamic route entry
// (Host(`<token>.inst.<domain>`) -> container) written to a shared
// directory the gateway watches. The gateway container is connected to
// the per-instance network so it can reach the container without any
// published port.
const GATEWAY_DIR = process.env.GATEWAY_DIR ?? "/etc/traefik/dynamic";
const GATEWAY_CONTAINER = process.env.GATEWAY_CONTAINER ?? "ctfrbt-gateway";

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
const INSTANCE_NAME_RE = /^ctfrbt-[a-z0-9]+(-[a-z0-9]+)*$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const LABEL_PART_RE = /^[a-zA-Z0-9._-]{1,64}$/;

// --- Instance helpers (stateless: inspect via the engine per request) ---

interface InstanceRoute {
  containerPort: number;
  hostPort: number;
  protocol: string;
}

interface InstanceInfo {
  containerId: string;
  name: string;
  state: "RUNNING" | "PAUSED" | "EXITED";
  routes: InstanceRoute[];
}

async function inspectInstance(name: string): Promise<InstanceInfo | null> {
  const container = docker!.getContainer(name);
  const info = await container.inspect();
  const routes: InstanceRoute[] = [];
  for (const [key, bindings] of Object.entries(info.NetworkSettings.Ports)) {
    if (!bindings?.length) continue;
    const [containerPort, protocol] = key.split("/");
    routes.push({
      containerPort: Number(containerPort),
      hostPort: Number(bindings[0].HostPort),
      protocol: protocol || "tcp",
    });
  }
  return {
    containerId: name,
    name: info.Name.replace(/^\//, ""),
    state: info.State.Paused
      ? "PAUSED"
      : info.State.Running
        ? "RUNNING"
        : "EXITED",
    routes,
  };
}

/** Writes (or overwrites) the gateway route entry for an instance. */
async function writeGatewayRoute(
  name: string,
  host: string,
  containerPort: number,
): Promise<void> {
  try {
    await mkdir(GATEWAY_DIR, { recursive: true });
    const yaml = [
      "http:",
      "  routers:",
      `    ${name}:`,
      `      rule: Host(\`${host}\`)`,
      `      service: ${name}`,
      "  services:",
      `    ${name}:`,
      "      loadBalancer:",
      "        servers:",
      `          - url: http://${name}:${containerPort}`,
      "",
    ].join("\n");
    await writeFile(`${GATEWAY_DIR}/${name}.yml`, yaml);
  } catch (err) {
    console.error(`orchestrator: cannot write gateway route for ${name}:`, err);
  }
}

async function removeInstance(name: string): Promise<boolean> {
  try {
    const container = docker!.getContainer(name);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true });
    // Kill the gateway route before the network goes away.
    await rm(`${GATEWAY_DIR}/${name}.yml`, { force: true }).catch(() => {});
    const network = docker!.getNetwork(`${name}-net`);
    await network.disconnect({ Container: GATEWAY_CONTAINER }).catch(() => {});
    // The per-instance network follows the container name (<name>-net).
    await network.remove().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function createInstance(body: {
  image: string;
  name: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  memoryLimitMb?: number;
  cpuLimit?: string;
  /** Full subdomain the gateway should route to this instance. */
  gatewayHost?: string;
}): Promise<InstanceInfo | { error: string }> {
  const { image, name } = body;
  if (!TAG_RE.test(image) || image.includes(".."))
    return { error: "invalid image" };
  if (!INSTANCE_NAME_RE.test(name)) return { error: "invalid name" };
  const env = body.env ?? {};
  const entries = Object.entries(env);
  if (entries.length > 20) return { error: "too many env entries" };
  for (const [k, v] of entries) {
    if (!ENV_KEY_RE.test(k) || v.length > 512)
      return { error: "invalid env entry" };
  }
  const labels = { ...(body.labels ?? {}) };
  for (const [k, v] of Object.entries(labels)) {
    if (!LABEL_PART_RE.test(k) || !LABEL_PART_RE.test(v))
      return { error: "invalid label" };
  }
  labels["ctfrbt.managed"] = "true";

  const memoryMb = Math.min(Math.max(body.memoryLimitMb ?? 256, 16), 8192);
  const cpu = Number(body.cpuLimit ?? "0.50") || 0.5;
  const cpuCores = Math.min(Math.max(cpu, 0.1), 8);

  const networkName = `${name}-net`;
  // A stale network with the same (random) name would block creation;
  // reuse it if it exists.
  try {
    await docker!
      .getNetwork(networkName)
      .inspect()
      .catch(async () => {
        throw new Error("missing");
      });
  } catch {
    try {
      // icc=false: no inter-container traffic on the bridge — the only
      // way in is the single published host port (#16).
      await docker!.createNetwork({
        Name: networkName,
        Driver: "bridge",
        Options: { icc: "false" },
      });
    } catch (err) {
      // 409 (already exists) is acceptable; anything else is not.
      if (!(err as Error).message?.includes("409"))
        return { error: `cannot create network: ${(err as Error).message}` };
    }
  }

  try {
    const img = docker!.getImage(image);
    const imgInfo = await img.inspect();
    const exposed: string[] = Object.keys(imgInfo.Config.ExposedPorts ?? {});
    const first = exposed[0];
    // One port per instance (#16): the app validates exactly one EXPOSE,
    // so the orchestrator only needs the first (and only) exposed port.
    if (!first) return { error: "image exposes no ports" };

    // Publish the exposed port on a random host port from the wide range;
    // the random port doubles as the token (rotation on every start). A
    // busy host port is excluded and creation is retried with a fresh pick.
    const excluded = new Set<number>();
    let lastError: Error = new Error("container not created");
    for (let attempt = 0; attempt < 50; attempt++) {
      let hostPort: number;
      try {
        hostPort = pickHostPort(excluded);
      } catch (err) {
        return { error: (err as Error).message };
      }
      try {
        const container = await docker!.createContainer({
          Image: image,
          name,
          Env: entries.map(([k, v]) => `${k}=${v}`),
          Labels: labels,
          ExposedPorts: Object.fromEntries(exposed.map((p) => [p, {}])),
          HostConfig: {
            Memory: memoryMb * 1024 * 1024,
            CpuQuota: Math.round(cpuCores * 100_000),
            CpuPeriod: 100_000,
            PidsLimit: 64,
            SecurityOpt: ["no-new-privileges"],
            NetworkMode: networkName,
            PortBindings: {
              [first]: [{ HostIp: "", HostPort: String(hostPort) }],
            },
          },
        });
        await container.start();

        // Gateway registration (best effort, only when a gatewayHost is
        // requested — test instances; game instances use the published
        // port directly, #16): connect the gateway container to the
        // instance network, then write the dynamic route entry
        // (Host(`<gatewayHost>`) -> container:port).
        if (body.gatewayHost) {
          try {
            await docker!
              .getNetwork(networkName)
              .connect({ Container: GATEWAY_CONTAINER });
            const port = Number(first.split("/")[0]);
            if (Number.isInteger(port) && port > 0) {
              await writeGatewayRoute(name, body.gatewayHost, port);
            }
          } catch (err) {
            console.error(
              `orchestrator: gateway setup failed for ${name}:`,
              err,
            );
          }
        }

        return (await inspectInstance(name))!;
      } catch (err) {
        lastError = err as Error;
        const msg = lastError.message ?? "";
        if (
          msg.includes("EADDRINUSE") ||
          msg.includes("address already in use") ||
          msg.includes("port is already allocated") ||
          msg.includes("port is not available")
        ) {
          excluded.add(hostPort);
          continue;
        }
        break;
      }
    }
    // Best-effort cleanup of the half-created instance.
    await removeInstance(name);
    return { error: lastError.message };
  } catch (err) {
    // Best-effort cleanup of the half-created instance.
    await removeInstance(name);
    return { error: (err as Error).message };
  }
}

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

    if (req.method === "POST" && url.pathname === "/instances") {
      const raw = await readBody(req);
      let body: {
        image?: string;
        name?: string;
        env?: Record<string, string>;
        labels?: Record<string, string>;
        memoryLimitMb?: number;
        cpuLimit?: string;
        gatewayHost?: string;
      };
      try {
        body = JSON.parse(raw);
      } catch {
        send(res, 400, { error: "invalid JSON body" });
        return;
      }
      const { image, name, env, labels, memoryLimitMb, cpuLimit, gatewayHost } =
        body;
      if (!image || !name) {
        send(res, 400, { error: "image and name are required" });
        return;
      }
      const result = await createInstance({
        image,
        name,
        env,
        labels,
        memoryLimitMb,
        cpuLimit,
        gatewayHost,
      });
      if ("error" in result) {
        send(res, 502, { error: result.error });
        return;
      }
      send(res, 201, result);
      return;
    }

    // The event controller owns policy; this adapter only changes engine state.
    const suspension = url.pathname.match(
      /^\/instances\/([a-zA-Z0-9._-]+)\/(pause|resume)$/,
    );
    if (req.method === "POST" && suspension) {
      try {
        const container = docker!.getContainer(suspension[1]);
        const info = await container.inspect();
        const labels = info.Config.Labels ?? {};
        if (labels["ctfrbt.managed"] !== "true" || !labels["ctfrbt.teamId"]) {
          send(res, 403, {
            error: "only managed participant instances can be suspended",
          });
          return;
        }
        if (!info.State.Running) {
          send(res, 409, {
            code: "INSTANCE_EXITED",
            error: "instance is not running",
          });
          return;
        }
        const pause = suspension[2] === "pause";
        if (pause && !info.State.Paused) await container.pause();
        if (!pause && info.State.Paused) await container.unpause();
        send(res, 200, { state: pause ? "PAUSED" : "RUNNING" });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        send(res, status === 404 ? 404 : 502, {
          code: status === 404 ? "INSTANCE_NOT_FOUND" : "ENGINE_ERROR",
          error:
            status === 404 ? "instance not found" : "engine suspension failed",
        });
      }
      return;
    }

    const instMatch = url.pathname.match(/^\/instances\/([a-zA-Z0-9._-]+)$/);
    if (instMatch) {
      const name = instMatch[1];
      if (req.method === "GET") {
        try {
          const info = await inspectInstance(name);
          if (!info) send(res, 404, { error: "instance not found" });
          else send(res, 200, info);
        } catch {
          send(res, 404, { error: "instance not found" });
        }
        return;
      }
      if (req.method === "POST" && url.pathname === `/instances/${name}/stop`) {
        try {
          await docker!.getContainer(name).stop({ t: 5 });
          send(res, 200, { stopped: true });
        } catch {
          send(res, 404, { error: "instance not found" });
        }
        return;
      }
      if (req.method === "DELETE") {
        const removed = await removeInstance(name);
        send(res, removed ? 200 : 404, { removed });
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/instances") {
      const list = await docker!.listContainers({
        all: true,
        filters: { label: ["ctfrbt.managed=true"] },
      });
      send(res, 200, {
        instances: list.map((c) => ({
          containerId: c.Id,
          name: (c.Names ?? [])[0]?.replace(/^\//, "") ?? c.Id,
          state: c.State,
          labels: c.Labels ?? {},
        })),
      });
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
