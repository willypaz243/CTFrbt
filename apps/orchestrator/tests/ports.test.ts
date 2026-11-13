import { describe, expect, it } from "vitest";
import { HOST_PORT_MAX, HOST_PORT_MIN, pickHostPort } from "../src/ports";

describe("pickHostPort", () => {
  it("stays within the 20000-60000 range", () => {
    for (let i = 0; i < 200; i++) {
      const port = pickHostPort();
      expect(port).toBeGreaterThanOrEqual(HOST_PORT_MIN);
      expect(port).toBeLessThanOrEqual(HOST_PORT_MAX);
      expect(Number.isInteger(port)).toBe(true);
    }
  });

  it("never returns an excluded port", () => {
    const exclude = new Set([20000, 40000, 60000, 31337]);
    for (let i = 0; i < 500; i++) {
      expect(exclude.has(pickHostPort(exclude))).toBe(false);
    }
  });

  it("deterministically picks with a given random source", () => {
    // random() = 0 → first candidate; = 0.999… → last candidate.
    expect(pickHostPort(new Set([20000]), () => 0)).toBe(20001);
    expect(pickHostPort(new Set([60000]), () => 0.9999999)).toBe(59999);
  });

  it("throws when the whole range is excluded", () => {
    const all = new Set<number>();
    for (let p = HOST_PORT_MIN; p <= HOST_PORT_MAX; p++) all.add(p);
    expect(() => pickHostPort(all)).toThrow(/no free host port/);
  });
});
