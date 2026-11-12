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

function headers(): HeadersInit {
  return {
    "Content-Type": "application/json",
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
): Promise<{ buildId: string } | { error: string }> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/builds`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ dockerfile, tag }),
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
