import { describe, expect, it } from "vitest";
import {
  SSH_PASS_LENGTH,
  generateSshPassword,
  sanitizeSshUser,
} from "@/lib/ssh-credentials";

describe("sanitizeSshUser", () => {
  it("lowercases and strips non-alphanumeric characters", () => {
    expect(sanitizeSshUser("Alice-99!")).toBe("alice99");
  });

  it("caps the length at 32 characters", () => {
    expect(sanitizeSshUser("a".repeat(40)).length).toBe(32);
  });

  it("falls back to 'ctf' for an empty result", () => {
    expect(sanitizeSshUser("###")).toBe("ctf");
    expect(sanitizeSshUser("")).toBe("ctf");
  });

  it("falls back to 'ctf' for the reserved name root", () => {
    expect(sanitizeSshUser("ROOT")).toBe("ctf");
    expect(sanitizeSshUser("root")).toBe("ctf");
  });
});

describe("generateSshPassword", () => {
  it("is 12 alphanumeric characters by default", () => {
    const pass = generateSshPassword();
    expect(pass).toHaveLength(SSH_PASS_LENGTH);
    expect(pass).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it("respects a custom length", () => {
    expect(generateSshPassword(8)).toHaveLength(8);
  });

  it("generates distinct passwords", () => {
    expect(generateSshPassword()).not.toBe(generateSshPassword());
  });
});
