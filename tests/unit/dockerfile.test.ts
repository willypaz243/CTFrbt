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
    const result = validateDockerfile(
      "FROM alpine:3.20\nEXPOSE 80\nRUN echo ok\n",
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a Dockerfile without any EXPOSE", () => {
    const result = validateDockerfile("FROM alpine\nRUN echo ok\n");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Dockerfile must declare exactly one EXPOSE port",
    );
  });

  it("rejects a Dockerfile with two EXPOSE instructions", () => {
    const result = validateDockerfile("FROM alpine\nEXPOSE 80\nEXPOSE 443\n");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Dockerfile must declare exactly one EXPOSE port",
    );
  });

  it("rejects a single EXPOSE with multiple ports", () => {
    const result = validateDockerfile("FROM alpine\nEXPOSE 80 443\n");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Dockerfile must declare exactly one EXPOSE port",
    );
  });

  it("rejects a non-numeric EXPOSE port", () => {
    const result = validateDockerfile("FROM alpine\nEXPOSE abc\n");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("EXPOSE port must be numeric");
  });

  it("rejects an out-of-range EXPOSE port", () => {
    const result = validateDockerfile("FROM alpine\nEXPOSE 99999\n");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("EXPOSE port must be between 1 and 65535");
  });

  it("rejects a non-TCP EXPOSE protocol", () => {
    const result = validateDockerfile("FROM alpine\nEXPOSE 80/udp\n");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("EXPOSE port must be TCP");
  });

  it("accepts an explicit /tcp protocol suffix", () => {
    const result = validateDockerfile("FROM alpine\nEXPOSE 8080/tcp\n");
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("warns when the base image uses :latest", () => {
    const result = validateDockerfile("FROM nginx:latest\nEXPOSE 80\n");
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("base image uses the :latest tag");
  });

  it("warns when the container runs as root", () => {
    const result = validateDockerfile("FROM alpine\nUSER root\nEXPOSE 80\n");
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("container runs as root");
  });
});
