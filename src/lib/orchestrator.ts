/**
 * Client for the local container orchestrator (apps/orchestrator).
 * The orchestrator speaks the Docker Engine API and is only reachable
 * through the compose network / localhost; every call carries the
 * shared secret.
 */

const ORCHESTRATOR_URL = (
  process.env.ORCHESTRATOR_URL ?? "http://localhost:7474"
).replace(/\/+$/, "");
const ORCHESTRATOR_SECRET = process.env.ORCHESTRATOR_SECRET ?? "";

export interface OrchestratorBuildResult {
  state: "BUILDING" | "READY" | "FAILED";
  log: string;
  digest: string | null;
}

/** A challenge file to include in the Docker build context. */
export interface BuildFile {
  /** Name the file must be COPYed by in the Dockerfile (flat, sanitized). */
  name: string;
  data: Uint8Array;
}

function headers(json = true): HeadersInit {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${ORCHESTRATOR_SECRET}`,
  };
}

export async function orchestratorHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/healthz`, {
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startBuild(
  dockerfile: string,
  tag: string,
  files: BuildFile[] = [],
): Promise<{ buildId: string } | { error: string }> {
  try {
    // With files the body is multipart (one part per file, named by the
    // flat file name so the orchestrator can place it in the build context).
    // Without files we keep the lighter JSON payload.
    let payload: BodyInit;
    let useJson = true;
    if (files.length > 0) {
      const fd = new FormData();
      fd.append("dockerfile", dockerfile);
      fd.append("tag", tag);
      for (const file of files) {
        // slice() yields a copy backed by a plain ArrayBuffer, which is a
        // valid BlobPart (a shared/growable buffer view is not).
        fd.append(file.name, new Blob([file.data.slice().buffer]));
      }
      payload = fd;
      useJson = false;
    } else {
      payload = JSON.stringify({ dockerfile, tag });
    }

    const res = await fetch(`${ORCHESTRATOR_URL}/builds`, {
      method: "POST",
      headers: headers(useJson),
      body: payload,
      cache: "no-store",
    });
    const body = (await res.json()) as { buildId?: string; error?: string };
    if (!res.ok || !body.buildId) {
      return { error: body.error ?? `orchestrator returned ${res.status}` };
    }
    return { buildId: body.buildId };
  } catch (err) {
    return { error: `orchestrator unreachable: ${(err as Error).message}` };
  }
}

export interface InstanceRoute {
  containerPort: number;
  hostPort: number;
  protocol: string;
}

/** Container summary from the orchestrator's fleet listing (#8). */
export interface OrchestratorInstanceSummary {
  containerId: string;
  name: string;
  state: "RUNNING" | "EXITED";
  labels: Record<string, string>;
}

export interface OrchestratorInstance {
  containerId: string;
  name: string;
  state: "RUNNING" | "EXITED";
  routes: InstanceRoute[];
}

export interface StartInstanceOptions {
  image: string;
  name: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  memoryLimitMb?: number;
  cpuLimit?: string;
  /** Full subdomain the gateway should route to this instance. */
  gatewayHost?: string;
}

export async function startInstance(
  opts: StartInstanceOptions,
): Promise<OrchestratorInstance | { error: string }> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/instances`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(opts),
      cache: "no-store",
    });
    const body = (await res.json()) as OrchestratorInstance & {
      error?: string;
    };
    if (!res.ok || !body.containerId) {
      return { error: body.error ?? `orchestrator returned ${res.status}` };
    }
    return body;
  } catch (err) {
    return { error: `orchestrator unreachable: ${(err as Error).message}` };
  }
}

export async function getInstance(
  containerId: string,
): Promise<OrchestratorInstance | null> {
  try {
    const res = await fetch(
      `${ORCHESTRATOR_URL}/instances/${encodeURIComponent(containerId)}`,
      { headers: headers(), cache: "no-store" },
    );
    if (!res.ok) return null;
    return (await res.json()) as OrchestratorInstance;
  } catch {
    return null;
  }
}

/**
 * List every managed container in the orchestrator (#8). Returns null when
 * the orchestrator is unreachable so callers can degrade gracefully.
 */
export async function listInstances(): Promise<
  OrchestratorInstanceSummary[] | null
> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/instances`, {
      headers: headers(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      instances: OrchestratorInstanceSummary[];
    };
    return body.instances ?? [];
  } catch {
    return null;
  }
}

export async function stopInstance(containerId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${ORCHESTRATOR_URL}/instances/${encodeURIComponent(containerId)}/stop`,
      { method: "POST", headers: headers(), cache: "no-store" },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteInstance(containerId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${ORCHESTRATOR_URL}/instances/${encodeURIComponent(containerId)}`,
      { method: "DELETE", headers: headers(), cache: "no-store" },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function getBuild(
  buildId: string,
): Promise<OrchestratorBuildResult | null> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/builds/${buildId}`, {
      headers: headers(),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return (await res.json()) as OrchestratorBuildResult;
  } catch {
    return null;
  }
}
