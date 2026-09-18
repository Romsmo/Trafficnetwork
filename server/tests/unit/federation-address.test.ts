import { describe, expect, it } from "vitest";
import { isAcceptableFederationAddress } from "../../src/modules/federation/address.js";

describe("isAcceptableFederationAddress", () => {
  it("accepts any https:// address", () => {
    expect(isAcceptableFederationAddress("https://node.example")).toBe(true);
    expect(isAcceptableFederationAddress("https://node.example:8443")).toBe(true);
  });

  it("rejects a plain http:// address to a real host", () => {
    expect(isAcceptableFederationAddress("http://node.example")).toBe(false);
  });

  it("accepts the loopback exception (127.0.0.1 or localhost, with or without a port)", () => {
    expect(isAcceptableFederationAddress("http://127.0.0.1")).toBe(true);
    expect(isAcceptableFederationAddress("http://127.0.0.1:3001")).toBe(true);
    expect(isAcceptableFederationAddress("http://localhost:3001")).toBe(true);
  });

  it("rejects a loopback-looking address that isn't actually an exact match", () => {
    expect(isAcceptableFederationAddress("http://127.0.0.1.evil.example")).toBe(false);
    expect(isAcceptableFederationAddress("http://127.0.0.2")).toBe(false);
    expect(isAcceptableFederationAddress("http://notlocalhost")).toBe(false);
  });
});
