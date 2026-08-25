import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinkConflictError, MigrationConflictError, SCHEMA_VERSION, Store } from "../src/store/store.ts";

// File operations run in an isolated temp dir, never the repo.
let dir: string;
let store: Store;
let clock: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-bridge-store-"));
  clock = new Date("2026-08-25T00:00:00.000Z");
  store = new Store(join(dir, "bridge.db"), { now: () => clock });
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

/** The schema the first release wrote. It reports user_version 0. */
function createV1Database(path: string, rows: Array<Omit<typeof sample, never>>): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      platform   TEXT NOT NULL,
      chat_id    INTEGER NOT NULL,
      thread_id  INTEGER NOT NULL,
      backend    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (platform, chat_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS links_by_session ON links (backend, session_id);
  `);
  for (const row of rows) {
    db.prepare(
      `INSERT INTO links (platform, chat_id, thread_id, backend, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.platform, row.chatId, row.threadId, row.backend, row.sessionId, "2026-08-24T00:00:00.000Z");
  }
  db.close();
}

function inspect<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function userVersion(path: string): number {
  return inspect(path, (db) => Number((db.prepare(`PRAGMA user_version`).get() as Record<string, unknown>)["user_version"]));
}

function columns(path: string, table: string): string[] {
  return inspect(path, (db) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c["name"])));
}

describe("Store links", () => {
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

  // A stale menu button must never redirect a live conversation.
  it("refuses to rebind a thread that already has a session", () => {
    store.link(sample);

    let error: unknown;
    try {
      store.link({ ...sample, sessionId: "session-def" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(LinkConflictError);
    expect((error as LinkConflictError).reason).toBe("thread");
    expect((error as LinkConflictError).existing.sessionId).toBe("session-abc");
    expect(store.list()).toHaveLength(1);
    expect(store.findByThread("telegram", 149523521, 497642)?.sessionId).toBe("session-abc");
  });

  it("refuses to give one session a second thread", () => {
    store.link(sample);

    let error: unknown;
    try {
      store.link({ ...sample, threadId: 497643 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(LinkConflictError);
    expect((error as LinkConflictError).reason).toBe("session");
    expect((error as LinkConflictError).existing.threadId).toBe(497642);
    expect(store.list()).toHaveLength(1);
  });

  it("links again after an explicit unlink", () => {
    store.link(sample);
    expect(store.unlink("telegram", 149523521, 497642)).toBe(true);
    expect(store.unlink("telegram", 149523521, 497642)).toBe(false);

    store.link({ ...sample, threadId: 497643 });
    expect(store.findBySession("dsh", "session-abc")?.threadId).toBe(497643);
  });

  it("keeps separate threads apart", () => {
    store.link(sample);
    store.link({ ...sample, threadId: 497643, sessionId: "session-beta" });

    expect(store.list()).toHaveLength(2);
    expect(store.findByThread("telegram", 149523521, 497643)?.sessionId).toBe("session-beta");
  });

  // The whole point of persisting: a restart must not orphan live threads.
  it("survives reopening the database file", () => {
    const path = join(dir, "persist.db");
    const first = new Store(path);
    first.link(sample);
    first.close();

    const second = new Store(path);
    expect(second.findByThread("telegram", 149523521, 497642)?.sessionId).toBe("session-abc");
    expect(userVersion(path)).toBe(SCHEMA_VERSION);
    second.close();
  });
});

describe("Store migration", () => {
  it("migrates a v1 database to the current schema and keeps its links", () => {
    const path = join(dir, "v1.db");
    createV1Database(path, [sample, { ...sample, threadId: 497643, sessionId: "session-beta" }]);
    expect(userVersion(path)).toBe(0);

    const migrated = new Store(path);
    expect(migrated.list()).toHaveLength(2);
    expect(migrated.findBySession("dsh", "session-beta")?.threadId).toBe(497643);
    expect(migrated.checkpoint()).toBe(0);
    migrated.close();

    expect(userVersion(path)).toBe(SCHEMA_VERSION);
  });

  it("enforces one-to-one links on data that arrived through migration", () => {
    const path = join(dir, "v1-then-conflict.db");
    createV1Database(path, [sample]);

    const migrated = new Store(path);
    expect(() => migrated.link({ ...sample, threadId: 497643 })).toThrow(LinkConflictError);
    migrated.close();
  });

  it("reports duplicate session links and changes nothing", () => {
    const path = join(dir, "duplicate.db");
    createV1Database(path, [sample, { ...sample, threadId: 497643 }]);

    let error: unknown;
    try {
      new Store(path);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MigrationConflictError);
    const conflicts = (error as MigrationConflictError).conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.sessionId).toBe("session-abc");
    expect(conflicts[0]?.threads.map((t) => t.threadId)).toEqual([497642, 497643]);
    // The operator decides which link to drop; migration never guesses.
    expect((error as Error).message).toContain("telegram:149523521:497643");
    expect(userVersion(path)).toBe(0);
    expect(inspect(path, (db) => db.prepare(`SELECT * FROM links`).all())).toHaveLength(2);
  });

  it("refuses a database written by a newer bridge", () => {
    const path = join(dir, "future.db");
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    expect(() => new Store(path)).toThrow(/newer than this bridge/);
  });

  it("reopens a current database without re-running migrations", () => {
    const path = join(dir, "reopen.db");
    const first = new Store(path);
    first.settleUpdates([700]);
    first.close();

    const second = new Store(path);
    expect(userVersion(path)).toBe(SCHEMA_VERSION);
    expect(second.checkpoint()).toBe(700);
    second.close();
  });
});

const processingInput = {
  updateId: 701,
  updateKind: "message",
  platform: "telegram",
  chatId: 149523521,
  threadId: 497642,
  step: "received",
};

describe("Store checkpoint", () => {
  it("starts unset and advances with settled updates", () => {
    expect(store.checkpoint()).toBe(0);
    expect(store.settleUpdates([700])).toBe(700);
    expect(store.settleUpdates([701, 702])).toBe(702);
    expect(store.checkpoint()).toBe(702);
  });

  // Telegram would resend everything after the checkpoint, so it may never
  // pass an update whose effects are still unfinished.
  it("holds at a gap until the older update finishes", () => {
    store.beginProcessing({ ...processingInput, updateId: 700 });
    store.beginProcessing({ ...processingInput, updateId: 701 });

    expect(store.settleUpdates([701])).toBe(0);
    expect(store.settleUpdates([700])).toBe(701);
  });

  it("ignores an update settled twice", () => {
    store.settleUpdates([700]);
    expect(store.settleUpdates([700])).toBe(700);
  });

  it("advances past an update isolated as a dead letter", () => {
    store.beginProcessing({ ...processingInput, updateId: 700 });
    store.settleUpdates([701]);
    expect(store.checkpoint()).toBe(0);

    store.writeDeadLetter({
      updateId: 700,
      updateKind: "message",
      platform: "telegram",
      chatId: 149523521,
      threadId: 497642,
      errorCode: "backend-unavailable",
      errorSummary: "dsh refused the prompt three times",
      attempts: 3,
    });

    expect(store.checkpoint()).toBe(701);
  });

  it("rejects an update id that is not a safe integer", () => {
    expect(() => store.settleUpdates([1.5])).toThrow(RangeError);
  });
});

describe("Store processing records", () => {
  it("records steps, external ids, and part counts", () => {
    store.beginProcessing(processingInput);
    store.recordStep(701, { step: "prompt-sent", sessionId: "session-abc" });
    const record = store.recordStep(701, { step: "final-sent", messageId: 88, partsSent: 2, partsTotal: 3 });

    expect(record.step).toBe("final-sent");
    // An id recorded by an earlier step survives a later one.
    expect(record.sessionId).toBe("session-abc");
    expect(record.messageId).toBe(88);
    expect(record.partsSent).toBe(2);
    expect(record.partsTotal).toBe(3);
    expect(record.attempts).toBe(1);
    expect(record.startedAt).toBe("2026-08-25T00:00:00.000Z");
  });

  // A retry in the same process resumes from the recorded step; repeating a
  // completed effect would duplicate an agent action.
  it("counts a further attempt without losing the recorded step", () => {
    store.beginProcessing(processingInput);
    store.recordStep(701, { step: "prompt-sent", sessionId: "session-abc" });

    const retried = store.beginProcessing(processingInput);
    expect(retried.attempts).toBe(2);
    expect(retried.step).toBe("prompt-sent");
    expect(retried.sessionId).toBe("session-abc");
  });

  it("refuses a step for an update it never opened", () => {
    expect(() => store.recordStep(999, { step: "prompt-sent" })).toThrow(/No processing record/);
  });

  it("rejects labels long enough to carry content", () => {
    expect(() => store.beginProcessing({ ...processingInput, step: "x".repeat(33) })).toThrow(RangeError);
    expect(() => store.beginProcessing({ ...processingInput, updateKind: "x".repeat(33) })).toThrow(RangeError);
  });

  // Enforced by shape: there is no column a prompt or an image could reach.
  it("has no column for user content", () => {
    const path = join(dir, "shape.db");
    const shaped = new Store(path);
    shaped.close();

    expect(columns(path, "processing")).toEqual([
      "update_id",
      "update_kind",
      "platform",
      "chat_id",
      "thread_id",
      "step",
      "session_id",
      "draft_id",
      "message_id",
      "parts_sent",
      "parts_total",
      "attempts",
      "started_at",
      "updated_at",
    ]);
    expect(columns(path, "dead_letters")).toEqual([
      "update_id",
      "update_kind",
      "platform",
      "chat_id",
      "thread_id",
      "error_code",
      "error_summary",
      "attempts",
      "created_at",
    ]);
  });
});

describe("Store startup recovery", () => {
  it("isolates everything still processing and returns its routing metadata", () => {
    const path = join(dir, "recovery.db");
    const crashed = new Store(path, { now: () => clock });
    crashed.settleUpdates([699]);
    crashed.beginProcessing({ ...processingInput, updateId: 700 });
    crashed.beginProcessing({ ...processingInput, updateId: 701, threadId: 497643 });
    crashed.close();

    const restarted = new Store(path, { now: () => clock });
    const recovered = restarted.recoverProcessing();

    expect(recovered.map((r) => r.updateId)).toEqual([700, 701]);
    expect(recovered[1]?.threadId).toBe(497643);
    expect(recovered[0]?.attempts).toBe(1);
    // No retry: the record is gone and the update is isolated.
    expect(restarted.findProcessing(700)).toBeUndefined();
    expect(restarted.listDeadLetters().map((d) => d.errorCode)).toEqual(["crash-recovery", "crash-recovery"]);
    expect(restarted.checkpoint()).toBe(701);
    expect(restarted.recoverProcessing()).toEqual([]);
    restarted.close();
  });
});

describe("Store dead letters", () => {
  const failure = {
    updateId: 700,
    updateKind: "message",
    platform: "telegram",
    chatId: 149523521,
    threadId: 497642,
    errorCode: "telegram-send-failed",
    errorSummary: "sendRichMessage failed with HTTP 400",
    attempts: 3,
  };

  it("lists what it stored", () => {
    store.writeDeadLetter(failure);
    const [letter] = store.listDeadLetters();

    expect(letter?.updateId).toBe(700);
    expect(letter?.errorSummary).toBe("sendRichMessage failed with HTTP 400");
    expect(letter?.attempts).toBe(3);
    expect(letter?.createdAt).toBe("2026-08-25T00:00:00.000Z");
  });

  // The summary is the one field built from an exception message, so it is
  // the one place user content could ride in.
  it("cuts an oversized summary", () => {
    store.writeDeadLetter({ ...failure, errorSummary: "leak".repeat(200) });
    const summary = store.listDeadLetters()[0]?.errorSummary ?? "";

    expect(summary).toHaveLength(200);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("rejects an oversized error code", () => {
    expect(() => store.writeDeadLetter({ ...failure, errorCode: "x".repeat(33) })).toThrow(RangeError);
  });

  it("removes records past the retention window and keeps the rest", () => {
    store.writeDeadLetter(failure);
    clock = new Date("2026-09-20T00:00:00.000Z");
    store.writeDeadLetter({ ...failure, updateId: 701 });

    // 2026-08-25 is 31 days before the injected now; 2026-09-20 is 5.
    const removed = store.purgeDeadLetters(30, new Date("2026-09-25T00:00:00.000Z"));

    expect(removed).toBe(1);
    expect(store.listDeadLetters().map((d) => d.updateId)).toEqual([701]);
  });

  it("keeps everything when nothing is old enough", () => {
    store.writeDeadLetter(failure);
    expect(store.purgeDeadLetters(30, new Date("2026-08-26T00:00:00.000Z"))).toBe(0);
    expect(store.listDeadLetters()).toHaveLength(1);
  });
});
