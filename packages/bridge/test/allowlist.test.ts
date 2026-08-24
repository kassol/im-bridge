import { describe, expect, it } from "vitest";
import { Allowlist } from "../src/telegram/allowlist.ts";

describe("Allowlist", () => {
  it("permits only listed ids", () => {
    const list = new Allowlist([149523521]);
    expect(list.permits(149523521)).toBe(true);
    expect(list.permits(999)).toBe(false);
  });

  // Fail closed. An empty list must never mean "allow everyone".
  it("denies everything when empty", () => {
    const list = new Allowlist([]);
    expect(list.permits(149523521)).toBe(false);
    expect(list.permits(undefined)).toBe(false);
  });

  it("denies missing user id", () => {
    const list = new Allowlist([1]);
    expect(list.permits(undefined)).toBe(false);
  });

  it("parses a comma-separated env value", () => {
    const list = Allowlist.fromEnv(" 149523521 , 987654321 ");
    expect(list.permits(149523521)).toBe(true);
    expect(list.permits(987654321)).toBe(true);
    expect(list.size).toBe(2);
  });

  it("treats unset and blank env as deny-all", () => {
    expect(Allowlist.fromEnv(undefined).size).toBe(0);
    expect(Allowlist.fromEnv("   ").size).toBe(0);
  });

  // A typo must stop startup. Silently coercing to NaN would deny a real user
  // and look like a bug elsewhere; silently skipping could widen access.
  it("throws on malformed ids instead of coercing", () => {
    expect(() => Allowlist.fromEnv("123,abc")).toThrow(/Invalid user id/);
    expect(() => new Allowlist([1.5])).toThrow(/integer user ids/);
    expect(() => new Allowlist([Number.NaN])).toThrow(/integer user ids/);
  });
});
