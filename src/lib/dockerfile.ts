/**
 * Dockerfile validation for dynamic challenges. Runs in the admin API
 * route, not in the orchestrator: the orchestrator only builds.
 */

export const MAX_DOCKERFILE_BYTES = 64 * 1024;

export interface DockerfileValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateDockerfile(content: string): DockerfileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!content.trim()) {
    errors.push("Dockerfile is empty");
    return { ok: false, errors, warnings };
  }

  if (Buffer.byteLength(content, "utf8") > MAX_DOCKERFILE_BYTES) {
    errors.push("Dockerfile exceeds 64 KB");
  }
  if (!/^\s*FROM\s+\S+/im.test(content)) {
    errors.push("Dockerfile must contain a FROM instruction");
  }
  if (/\bFROM\s+\S+:latest\b/im.test(content)) {
    warnings.push("base image uses the :latest tag");
  }
  if (/^\s*USER\s+root\s*$/im.test(content)) {
    warnings.push("container runs as root");
  }

  // One port per instance (#16): the challenge must expose exactly one
  // TCP port; it is published on a random host port at start time.
  const exposePorts: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*EXPOSE\s+(.+)$/im);
    if (match) exposePorts.push(...match[1].trim().split(/\s+/));
  }
  if (exposePorts.length !== 1) {
    errors.push("Dockerfile must declare exactly one EXPOSE port");
  } else {
    const [rawPort, protocol] = exposePorts[0].split("/");
    if (!/^\d+$/.test(rawPort ?? "")) {
      errors.push("EXPOSE port must be numeric");
    } else if (Number(rawPort) < 1 || Number(rawPort) > 65535) {
      errors.push("EXPOSE port must be between 1 and 65535");
    }
    if (protocol !== undefined && protocol !== "tcp") {
      errors.push("EXPOSE port must be TCP");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
