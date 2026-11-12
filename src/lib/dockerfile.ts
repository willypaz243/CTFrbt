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

  return { ok: errors.length === 0, errors, warnings };
}
