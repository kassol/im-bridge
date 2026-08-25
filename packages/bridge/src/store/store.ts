/**
 * Durable bridge state.
 *
 * Four things must survive a restart: the thread <-> session links, how far
 * Telegram polling got, which updates were mid-flight, and which updates were
 * given up on. Everything else can be rebuilt by asking the backend. If this
 * database is lost, every existing thread goes mute: the backend still holds
 * the sessions, but nothing knows which Telegram topic they belong to.
 *
 * Nothing here stores user content. Prompt text, captions, image bytes, tokens
 * and complete Telegram updates have no column to live in — the shape of the
 * tables is the guarantee, not the discipline of the caller.
 *
 * Schema
 * ------
 * `PRAGMA user_version` selects the migration path. v1 is the original links
 * table; a database written by the first bridge release reports 0 and is
 * treated as v1. v2 adds one-to-one link enforcement, the polling checkpoint,
 * processing records and dead letters. Migrations run in order inside one
 * transaction, so a rejected migration leaves the file untouched.
 *
 * Checkpoint advancement
 * ----------------------
 * The runtime reports every update it is done with — completed, dropped as
 * unauthorised, or isolated as a dead letter — through `settleUpdates`. The
 * store then moves the checkpoint to the highest settled id that lies below
 * every update still being processed. An id settled out of order waits until
 * the older work finishes, so a gap is never skipped, and Telegram's update
 * numbering does not have to be gapless for that to hold.
 */
import { DatabaseSync } from "node:sqlite";

export interface Link {
  platform: string;
  chatId: number;
  threadId: number;
  backend: string;
  sessionId: string;
  createdAt: string;
}

/** A platform-side conversation container. Telegram: chat plus topic. */
export interface ThreadRef {
  platform: string;
  chatId: number;
  threadId: number;
}

/** One session that v1 data mapped to more than one thread. */
export interface DuplicateSessionLink {
  backend: string;
  sessionId: string;
  threads: ThreadRef[];
}

/**
 * A link would break the one-to-one rule.
 *
 * `reason` says which side is taken and `existing` is the link that already
 * holds it, so the caller can name the occupied thread or session in the
 * message it renders. Rebinding is an explicit unlink, never a side effect.
 */
export class LinkConflictError extends Error {
  readonly reason: "thread" | "session";
  readonly existing: Link;

  constructor(reason: "thread" | "session", existing: Link) {
    super(
      reason === "thread"
        ? `thread ${existing.platform}:${existing.chatId}:${existing.threadId} is already linked to session ${existing.backend}:${existing.sessionId}`
        : `session ${existing.backend}:${existing.sessionId} is already linked to thread ${existing.platform}:${existing.chatId}:${existing.threadId}`,
    );
    this.name = "LinkConflictError";
    this.reason = reason;
    this.existing = existing;
  }
}

/**
 * Existing data cannot satisfy schema v2.
 *
 * Deleting one of two links to the same session would silently redirect a
 * user's prompts, so migration reports the conflicting threads and stops. An
 * operator unlinks the wrong one and starts the bridge again.
 */
export class MigrationConflictError extends Error {
  readonly conflicts: DuplicateSessionLink[];

  constructor(conflicts: DuplicateSessionLink[]) {
    super(
      `cannot migrate to schema v${SCHEMA_VERSION}: ${conflicts.length} session(s) linked to more than one thread: ` +
        conflicts
          .map(
            (c) =>
              `${c.backend}:${c.sessionId} -> ${c.threads
                .map((t) => `${t.platform}:${t.chatId}:${t.threadId}`)
                .join(", ")}`,
          )
          .join("; "),
    );
    this.name = "MigrationConflictError";
    this.conflicts = conflicts;
  }
}

/** An update whose effects are still in flight. Content-free by construction. */
export interface ProcessingRecord {
  updateId: number;
  updateKind: string;
  platform: string;
  chatId: number;
  threadId: number;
  /** Label of the last completed side effect, so a retry resumes from it. */
  step: string;
  /** Ids returned by external systems, kept so a retry does not create twins. */
  sessionId?: string;
  draftId?: string;
  messageId?: number;
  /** Progress of a multi-part final message. */
  partsSent: number;
  partsTotal: number;
  attempts: number;
  startedAt: string;
  updatedAt: string;
}

export interface BeginProcessingInput {
  updateId: number;
  updateKind: string;
  platform: string;
  chatId: number;
  threadId: number;
  step: string;
}

/** Only the named fields move; anything omitted keeps its recorded value. */
export interface ProcessingStepPatch {
  step: string;
  sessionId?: string;
  draftId?: string;
  messageId?: number;
  partsSent?: number;
  partsTotal?: number;
}

/** Routing metadata for the resend notice a recovered update earns. */
export interface RecoveredUpdate {
  updateId: number;
  updateKind: string;
  platform: string;
  chatId: number;
  threadId: number;
  attempts: number;
}

export interface DeadLetter {
  updateId: number;
  updateKind: string;
  platform: string;
  chatId: number;
  threadId: number;
  errorCode: string;
  errorSummary: string;
  attempts: number;
  createdAt: string;
}

export interface DeadLetterInput {
  updateId: number;
  updateKind: string;
  platform: string;
  chatId: number;
  threadId: number;
  errorCode: string;
  errorSummary: string;
  attempts: number;
}

export interface StoreOptions {
  /** Clock for record timestamps. Tests inject a fixed one. */
  now?: () => Date;
}

export const SCHEMA_VERSION = 2;

/** Labels are constants in the code; anything longer is a caller bug. */
const LABEL_MAX = 32;
/** Summaries come from real failures, so they are cut instead of rejected. */
const SUMMARY_MAX = 200;
const DAY_MS = 86_400_000;

const RECOVERY_CODE = "crash-recovery";
const RECOVERY_SUMMARY =
  "bridge restarted while this update was processing; external effects are uncertain";

/** Each entry migrates from version index to version index + 1. */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [migrateToV1, migrateToV2];

export class Store {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.db = new DatabaseSync(path);
    try {
      migrate(this.db);
    } catch (error) {
      // A half-open database keeps the file locked for the rest of the
      // process, which hides the real failure behind a second one.
      this.db.close();
      throw error;
    }
  }

  // --- links ---------------------------------------------------------------

  /**
   * Bind a thread to a session.
   *
   * Throws `LinkConflictError` when either side is taken. A tap on a stale
   * menu button must never redirect a running conversation, so there is no
   * upsert: the caller unlinks first and says so.
   */
  link(input: Omit<Link, "createdAt">): Link {
    const takenThread = this.findByThread(input.platform, input.chatId, input.threadId);
    if (takenThread) throw new LinkConflictError("thread", takenThread);
    const takenSession = this.findBySession(input.backend, input.sessionId);
    if (takenSession) throw new LinkConflictError("session", takenSession);

    const createdAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO links (platform, chat_id, thread_id, backend, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.platform, input.chatId, input.threadId, input.backend, input.sessionId, createdAt);
    return { ...input, createdAt };
  }

  /** Inbound direction: a user typed in a thread; which session is that? */
  findByThread(platform: string, chatId: number, threadId: number): Link | undefined {
    const row = this.db
      .prepare(
        `SELECT platform, chat_id, thread_id, backend, session_id, created_at
         FROM links WHERE platform = ? AND chat_id = ? AND thread_id = ?`,
      )
      .get(platform, chatId, threadId);
    return row ? toLink(row) : undefined;
  }

  /** Outbound direction: the backend emitted an event; which thread renders it? */
  findBySession(backend: string, sessionId: string): Link | undefined {
    const row = this.db
      .prepare(
        `SELECT platform, chat_id, thread_id, backend, session_id, created_at
         FROM links WHERE backend = ? AND session_id = ?`,
      )
      .get(backend, sessionId);
    return row ? toLink(row) : undefined;
  }

  list(): Link[] {
    const rows = this.db
      .prepare(
        `SELECT platform, chat_id, thread_id, backend, session_id, created_at
         FROM links ORDER BY created_at DESC`,
      )
      .all();
    return rows.map(toLink);
  }

  unlink(platform: string, chatId: number, threadId: number): boolean {
    const res = this.db
      .prepare(`DELETE FROM links WHERE platform = ? AND chat_id = ? AND thread_id = ?`)
      .run(platform, chatId, threadId);
    return res.changes > 0;
  }

  // --- polling checkpoint --------------------------------------------------

  /**
   * Highest update id whose effects completed or were isolated, with no older
   * update still unfinished. `getUpdates` asks for `checkpoint() + 1`. Zero
   * means nothing is confirmed yet.
   */
  checkpoint(): number {
    const row = this.db.prepare(`SELECT update_id FROM polling_checkpoint WHERE id = 0`).get();
    return row ? Number(row["update_id"]) : 0;
  }

  /**
   * Report updates the runtime is done with and return the new checkpoint.
   *
   * Covers completion and updates dropped before any processing record was
   * opened. Isolation goes through `writeDeadLetter`, which settles too.
   */
  settleUpdates(updateIds: readonly number[]): number {
    for (const id of updateIds) assertUpdateId(id);
    return this.transaction(() => {
      for (const id of updateIds) this.settle(id);
      return this.advanceCheckpoint();
    });
  }

  // --- update processing ---------------------------------------------------

  /**
   * Open the processing record for an update, before its first side effect.
   *
   * Calling it again for the same update starts another attempt: the recorded
   * step and external ids stay, so a retry within this process resumes where
   * it stopped instead of repeating a completed effect.
   */
  beginProcessing(input: BeginProcessingInput): ProcessingRecord {
    assertUpdateId(input.updateId);
    assertLabel("updateKind", input.updateKind);
    assertLabel("step", input.step);
    const at = this.now().toISOString();
    return this.transaction(() => {
      const existing = this.findProcessing(input.updateId);
      if (existing) {
        this.db
          .prepare(`UPDATE processing SET attempts = attempts + 1, updated_at = ? WHERE update_id = ?`)
          .run(at, input.updateId);
      } else {
        this.db
          .prepare(
            `INSERT INTO processing (update_id, update_kind, platform, chat_id, thread_id, step,
                                     session_id, draft_id, message_id, parts_sent, parts_total,
                                     attempts, started_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)`,
          )
          .run(
            input.updateId,
            input.updateKind,
            input.platform,
            input.chatId,
            input.threadId,
            input.step,
            at,
            at,
          );
      }
      return this.requireProcessing(input.updateId);
    });
  }

  /** Record a completed side effect and what it returned. */
  recordStep(updateId: number, patch: ProcessingStepPatch): ProcessingRecord {
    assertLabel("step", patch.step);
    this.requireProcessing(updateId);
    this.db
      .prepare(
        `UPDATE processing
         SET step = ?,
             session_id = COALESCE(?, session_id),
             draft_id = COALESCE(?, draft_id),
             message_id = COALESCE(?, message_id),
             parts_sent = COALESCE(?, parts_sent),
             parts_total = COALESCE(?, parts_total),
             updated_at = ?
         WHERE update_id = ?`,
      )
      .run(
        patch.step,
        patch.sessionId ?? null,
        patch.draftId ?? null,
        patch.messageId ?? null,
        patch.partsSent ?? null,
        patch.partsTotal ?? null,
        this.now().toISOString(),
        updateId,
      );
    return this.requireProcessing(updateId);
  }

  findProcessing(updateId: number): ProcessingRecord | undefined {
    const row = this.db.prepare(`${PROCESSING_COLUMNS} WHERE update_id = ?`).get(updateId);
    return row ? toProcessing(row) : undefined;
  }

  /**
   * Startup recovery: isolate everything that was still processing.
   *
   * The bridge cannot prove which external effect completed before the crash,
   * so nothing is retried across restart. Each record becomes a dead letter
   * and its thread identifiers come back, so the caller can tell that topic
   * its last input may not have reached the backend.
   */
  recoverProcessing(): RecoveredUpdate[] {
    const rows = this.db.prepare(`${PROCESSING_COLUMNS} ORDER BY update_id`).all().map(toProcessing);
    if (rows.length === 0) return [];
    const at = this.now().toISOString();
    return this.transaction(() => {
      for (const row of rows) {
        this.insertDeadLetter({
          updateId: row.updateId,
          updateKind: row.updateKind,
          platform: row.platform,
          chatId: row.chatId,
          threadId: row.threadId,
          errorCode: RECOVERY_CODE,
          errorSummary: RECOVERY_SUMMARY,
          attempts: row.attempts,
          createdAt: at,
        });
        this.settle(row.updateId);
      }
      this.advanceCheckpoint();
      return rows.map((row) => ({
        updateId: row.updateId,
        updateKind: row.updateKind,
        platform: row.platform,
        chatId: row.chatId,
        threadId: row.threadId,
        attempts: row.attempts,
      }));
    });
  }

  // --- dead letters --------------------------------------------------------

  /**
   * Give up on an update. The summary is cut to a fixed length: it comes from
   * an exception message, which is the one place user content could leak in.
   */
  writeDeadLetter(input: DeadLetterInput): DeadLetter {
    assertUpdateId(input.updateId);
    assertLabel("updateKind", input.updateKind);
    assertLabel("errorCode", input.errorCode);
    const record: DeadLetter = {
      ...input,
      errorSummary: bound(input.errorSummary),
      createdAt: this.now().toISOString(),
    };
    return this.transaction(() => {
      this.insertDeadLetter(record);
      this.settle(record.updateId);
      this.advanceCheckpoint();
      return record;
    });
  }

  listDeadLetters(): DeadLetter[] {
    return this.db.prepare(`${DEAD_LETTER_COLUMNS} ORDER BY created_at DESC, update_id DESC`).all().map(toDeadLetter);
  }

  /**
   * Drop dead letters older than the retention window and return how many
   * went. `createdAt` is a fixed-width UTC ISO string, so comparing it as text
   * is comparing it as time.
   */
  purgeDeadLetters(olderThanDays = 30, now: Date = this.now()): number {
    const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS).toISOString();
    const res = this.db.prepare(`DELETE FROM dead_letters WHERE created_at < ?`).run(cutoff);
    return Number(res.changes);
  }

  close(): void {
    this.db.close();
  }

  // --- internals -----------------------------------------------------------

  private insertDeadLetter(record: DeadLetter): void {
    this.db
      .prepare(
        `INSERT INTO dead_letters (update_id, update_kind, platform, chat_id, thread_id,
                                   error_code, error_summary, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.updateId,
        record.updateKind,
        record.platform,
        record.chatId,
        record.threadId,
        record.errorCode,
        record.errorSummary,
        record.attempts,
        record.createdAt,
      );
    this.db.prepare(`DELETE FROM processing WHERE update_id = ?`).run(record.updateId);
  }

  private settle(updateId: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO settled_updates (update_id) VALUES (?)`).run(updateId);
    this.db.prepare(`DELETE FROM processing WHERE update_id = ?`).run(updateId);
  }

  private advanceCheckpoint(): number {
    const oldest = this.db.prepare(`SELECT MIN(update_id) AS id FROM processing`).get();
    const barrier = oldest && oldest["id"] !== null ? Number(oldest["id"]) : undefined;
    const highest =
      barrier === undefined
        ? this.db.prepare(`SELECT MAX(update_id) AS id FROM settled_updates`).get()
        : this.db
            .prepare(`SELECT MAX(update_id) AS id FROM settled_updates WHERE update_id < ?`)
            .get(barrier);

    const current = this.checkpoint();
    const candidate = highest && highest["id"] !== null ? Number(highest["id"]) : current;
    const next = Math.max(current, candidate);
    this.db.prepare(`UPDATE polling_checkpoint SET update_id = ? WHERE id = 0`).run(next);
    // Confirmed ids carry no information any more; the checkpoint covers them.
    this.db.prepare(`DELETE FROM settled_updates WHERE update_id <= ?`).run(next);
    return next;
  }

  private requireProcessing(updateId: number): ProcessingRecord {
    const record = this.findProcessing(updateId);
    if (!record) throw new Error(`No processing record for update ${updateId}`);
    return record;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const PROCESSING_COLUMNS = `SELECT update_id, update_kind, platform, chat_id, thread_id, step,
         session_id, draft_id, message_id, parts_sent, parts_total, attempts, started_at, updated_at
  FROM processing`;

const DEAD_LETTER_COLUMNS = `SELECT update_id, update_kind, platform, chat_id, thread_id,
         error_code, error_summary, attempts, created_at
  FROM dead_letters`;

function migrate(db: DatabaseSync): void {
  const from = readUserVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `database schema v${from} is newer than this bridge (v${SCHEMA_VERSION}); refusing to open it`,
    );
  }
  if (from === SCHEMA_VERSION) return;
  // One transaction for the whole chain: a rejected migration must leave the
  // file exactly as the operator left it, version included.
  db.exec("BEGIN");
  try {
    for (let target = from + 1; target <= SCHEMA_VERSION; target++) {
      const step = MIGRATIONS[target - 1];
      if (!step) throw new Error(`missing migration to schema v${target}`);
      step(db);
      // PRAGMA takes no parameters; target is a loop counter, not input.
      db.exec(`PRAGMA user_version = ${target}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare(`PRAGMA user_version`).get();
  return row ? Number(row["user_version"]) : 0;
}

/**
 * v1 is what the first release wrote. It reports user_version 0, so an
 * existing file runs this step as a no-op and continues to v2.
 */
function migrateToV1(db: DatabaseSync): void {
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
}

function migrateToV2(db: DatabaseSync): void {
  const conflicts = duplicateSessionLinks(db);
  if (conflicts.length > 0) throw new MigrationConflictError(conflicts);

  db.exec(`
    -- Resolving backend events to a thread is the hot path, so the lookup
    -- index stays. Making it unique is what enforces the second direction of
    -- the one-to-one rule; the primary key already covers the thread side.
    DROP INDEX IF EXISTS links_by_session;
    CREATE UNIQUE INDEX links_by_session ON links (backend, session_id);

    CREATE TABLE IF NOT EXISTS polling_checkpoint (
      id        INTEGER PRIMARY KEY CHECK (id = 0),
      update_id INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO polling_checkpoint (id, update_id) VALUES (0, 0);

    -- Updates finished out of order wait here until every older update is
    -- done, so the checkpoint never jumps over unfinished work.
    CREATE TABLE IF NOT EXISTS settled_updates (
      update_id INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS processing (
      update_id   INTEGER PRIMARY KEY,
      update_kind TEXT    NOT NULL,
      platform    TEXT    NOT NULL,
      chat_id     INTEGER NOT NULL,
      thread_id   INTEGER NOT NULL,
      step        TEXT    NOT NULL,
      session_id  TEXT,
      draft_id    TEXT,
      message_id  INTEGER,
      parts_sent  INTEGER NOT NULL,
      parts_total INTEGER NOT NULL,
      attempts    INTEGER NOT NULL,
      started_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dead_letters (
      update_id     INTEGER PRIMARY KEY,
      update_kind   TEXT    NOT NULL,
      platform      TEXT    NOT NULL,
      chat_id       INTEGER NOT NULL,
      thread_id     INTEGER NOT NULL,
      error_code    TEXT    NOT NULL,
      error_summary TEXT    NOT NULL,
      attempts      INTEGER NOT NULL,
      created_at    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dead_letters_by_created_at ON dead_letters (created_at);
  `);
}

function duplicateSessionLinks(db: DatabaseSync): DuplicateSessionLink[] {
  const rows = db
    .prepare(
      `SELECT backend, session_id FROM links
       GROUP BY backend, session_id HAVING COUNT(*) > 1
       ORDER BY backend, session_id`,
    )
    .all();
  return rows.map((row) => {
    const backend = String(row["backend"]);
    const sessionId = String(row["session_id"]);
    const threads = db
      .prepare(
        `SELECT platform, chat_id, thread_id FROM links
         WHERE backend = ? AND session_id = ?
         ORDER BY platform, chat_id, thread_id`,
      )
      .all(backend, sessionId)
      .map((t) => ({
        platform: String(t["platform"]),
        chatId: Number(t["chat_id"]),
        threadId: Number(t["thread_id"]),
      }));
    return { backend, sessionId, threads };
  });
}

function assertUpdateId(updateId: number): void {
  if (!Number.isSafeInteger(updateId)) {
    throw new RangeError(`update id must be a safe integer, got ${updateId}`);
  }
}

function assertLabel(field: string, value: string): void {
  if (value.length === 0 || value.length > LABEL_MAX) {
    throw new RangeError(`${field} must be 1-${LABEL_MAX} characters, got ${value.length}`);
  }
}

function bound(summary: string): string {
  return summary.length <= SUMMARY_MAX ? summary : `${summary.slice(0, SUMMARY_MAX - 1)}…`;
}

function toLink(row: Record<string, unknown>): Link {
  return {
    platform: String(row["platform"]),
    chatId: Number(row["chat_id"]),
    threadId: Number(row["thread_id"]),
    backend: String(row["backend"]),
    sessionId: String(row["session_id"]),
    createdAt: String(row["created_at"]),
  };
}

function toProcessing(row: Record<string, unknown>): ProcessingRecord {
  const record: ProcessingRecord = {
    updateId: Number(row["update_id"]),
    updateKind: String(row["update_kind"]),
    platform: String(row["platform"]),
    chatId: Number(row["chat_id"]),
    threadId: Number(row["thread_id"]),
    step: String(row["step"]),
    partsSent: Number(row["parts_sent"]),
    partsTotal: Number(row["parts_total"]),
    attempts: Number(row["attempts"]),
    startedAt: String(row["started_at"]),
    updatedAt: String(row["updated_at"]),
  };
  if (row["session_id"] !== null) record.sessionId = String(row["session_id"]);
  if (row["draft_id"] !== null) record.draftId = String(row["draft_id"]);
  if (row["message_id"] !== null) record.messageId = Number(row["message_id"]);
  return record;
}

function toDeadLetter(row: Record<string, unknown>): DeadLetter {
  return {
    updateId: Number(row["update_id"]),
    updateKind: String(row["update_kind"]),
    platform: String(row["platform"]),
    chatId: Number(row["chat_id"]),
    threadId: Number(row["thread_id"]),
    errorCode: String(row["error_code"]),
    errorSummary: String(row["error_summary"]),
    attempts: Number(row["attempts"]),
    createdAt: String(row["created_at"]),
  };
}
