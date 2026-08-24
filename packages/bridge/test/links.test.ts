import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinkStore } from "../src/store/links.ts";

// File operations run in an isolated temp dir, never the repo.
let dir: string;
let store: LinkStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-bridge-links-"));
  store = new LinkStore(join(dir, "links.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const sample = {
  platform: "telegram",
  chatId: 149523521,
  threadId: 497642,
  backend: "dsh",
  sessionId: "session-abc",
};

describe("LinkStore", () => {
  it("resolves a link in both directions", () => {
    store.link(sample);

    // Inbound: user typed in a thread.
    expect(store.findByThread("telegram", 149523521, 497642)?.sessionId).toBe("session-abc");
    // Outbound: backend emitted an event.
    expect(store.findBySession("dsh", "session-abc")?.threadId).toBe(497642);
  });

  it("returns undefined for unknown lookups", () => {
    expect(store.findByThread("telegram", 1, 2)).toBeUndefined();
    expect(store.findBySession("dsh", "nope")).toBeUndefined();
  });

  // Re-linking a thread must move it, not create a duplicate that would make
  // findByThread ambiguous.
  it("rebinds a thread to a new session without duplicating", () => {
    store.link(sample);
    store.link({ ...sample, sessionId: "session-def" });

    expect(store.list()).toHaveLength(1);
    expect(store.findByThread("telegram", 149523521, 497642)?.sessionId).toBe("session-def");
    expect(store.findBySession("dsh", "session-abc")).toBeUndefined();
  });

  it("keeps separate threads apart", () => {
    store.link(sample);
    store.link({ ...sample, threadId: 497643, sessionId: "session-beta" });

    expect(store.list()).toHaveLength(2);
    expect(store.findByThread("telegram", 149523521, 497643)?.sessionId).toBe("session-beta");
  });

  it("unlinks", () => {
    store.link(sample);
    expect(store.unlink("telegram", 149523521, 497642)).toBe(true);
    expect(store.unlink("telegram", 149523521, 497642)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  // The whole point of persisting: a restart must not orphan live threads.
  it("survives reopening the database file", () => {
    const path = join(dir, "persist.db");
    const first = new LinkStore(path);
    first.link(sample);
    first.close();

    const second = new LinkStore(path);
    expect(second.findByThread("telegram", 149523521, 497642)?.sessionId).toBe("session-abc");
    second.close();
  });
});
