import { describe, expect, it } from "vitest";
import { hostPortFromUrl } from "@/lib/host-port";

describe("hostPortFromUrl", () => {
  it("returns host:port for an http url", () => {
    expect(hostPortFromUrl("http://10.0.0.5:24321/")).toBe("10.0.0.5:24321");
  });

  it("keeps the port for high ports in the published range", () => {
    expect(hostPortFromUrl("http://gateway:60000/")).toBe("gateway:60000");
  });

  it("returns just the host when no port is present", () => {
    expect(hostPortFromUrl("http://example.com/")).toBe("example.com");
  });
});
