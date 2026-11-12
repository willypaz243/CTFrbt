import { describe, expect, it } from "vitest";
import { MAX_DOCKERFILE_BYTES, validateDockerfile } from "@/lib/dockerfile";

describe("validateDockerfile", () => {
  it("rejects an empty Dockerfile", () => {
    const result = validateDockerfile("");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Dockerfile is empty");
  });

  it("rejects a Dockerfile without a FROM instruction", () => {
    const result = validateDockerfile("RUN echo hi\n");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Dockerfile must contain a FROM instruction",
    );
  });

  it("rejects a Dockerfile over the size limit", () => {
    const big = `FROM alpine\n# ${"x".repeat(MAX_DOCKERFILE_BYTES)}`;
    const result = validateDockerfile(big);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Dockerfile exceeds 64 KB");
  });

  it("accepts a minimal valid Dockerfile", () => {
    const result = validateDockerfile("FROM alpine:3.20\nRUN echo ok\n");
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("warns when the base image uses :latest", () => {
    const result = validateDockerfile("FROM nginx:latest\n");
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("base image uses the :latest tag");
  });

  it("warns when the container runs as root", () => {
    const result = validateDockerfile("FROM alpine\nUSER root\n");
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("container runs as root");
  });
});
