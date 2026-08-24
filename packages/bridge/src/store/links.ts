/**
 * The thread <-> session mapping.
 *
 * This is the only state im-bridge must persist. Everything else can be
 * rebuilt by asking the backend. If this table is lost, every existing thread
 * goes mute: the backend still holds the sessions, but nothing knows which
 * Telegram topic they belong to.
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

export class LinkStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        platform   TEXT NOT NULL,
        chat_id    INTEGER NOT NULL,
        thread_id  INTEGER NOT NULL,
        backend    TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (platform, chat_id, thread_id)
      );
      -- Resolving backend events to a thread is the hot path: every output
      -- delta arrives keyed by session id and must find its thread.
      CREATE INDEX IF NOT EXISTS links_by_session
        ON links (backend, session_id);
    `);
  }

  link(input: Omit<Link, "createdAt">): Link {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO links (platform, chat_id, thread_id, backend, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, chat_id, thread_id)
         DO UPDATE SET backend = excluded.backend,
                       session_id = excluded.session_id,
                       created_at = excluded.created_at`,
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

  close(): void {
    this.db.close();
  }
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
