/**
 * Album collection.
 *
 * Telegram delivers an album as several updates that share a `media_group_id`
 * and arrive within a few hundred milliseconds. The user sent one input, so
 * the bridge waits for the group to go quiet and then hands the whole group to
 * the prompt path at once — one prompt, one memory reservation, one failure.
 *
 * The group also stays one processing unit: it carries every member's update
 * id, so the durable processing and the polling checkpoint can treat the album
 * as a single thing to complete or isolate.
 */
import type { InboundMessage, ThreadIdentity } from "../telegram/updates.ts";

/** How long a group must stay quiet before it is treated as complete. */
export const ALBUM_QUIET_MS = 1_000;

export interface AlbumGroup {
  readonly thread: ThreadIdentity;
  /** One processing unit: every update that made up this input. */
  readonly updateIds: readonly number[];
  /** Members in Telegram's own order. */
  readonly messages: readonly InboundMessage[];
}

export interface AlbumCollectorOptions {
  /** Handles one complete album. It must not reject: nothing catches for it. */
  onSeal: (group: AlbumGroup) => Promise<void>;
  quietMs?: number;
}

interface OpenAlbum {
  readonly thread: ThreadIdentity;
  readonly messages: InboundMessage[];
  timer: NodeJS.Timeout;
}

export class AlbumCollector {
  readonly #onSeal: (group: AlbumGroup) => Promise<void>;
  readonly #quietMs: number;
  readonly #open = new Map<string, OpenAlbum>();
  /** Seals already handed on. Shutdown waits for these, not for the timers. */
  readonly #work = new Set<Promise<void>>();

  constructor(options: AlbumCollectorOptions) {
    this.#onSeal = options.onSeal;
    this.#quietMs = options.quietMs ?? ALBUM_QUIET_MS;
  }

  /**
   * Adds one member and restarts its quiet window. The window is per group and
   * per thread, so two topics filling albums at once do not seal each other.
   */
  add(mediaGroupId: string, message: InboundMessage): void {
    const key = `${String(message.thread.chatId)}:${String(message.thread.threadId)}:${mediaGroupId}`;
    const open = this.#open.get(key);
    if (open === undefined) {
      this.#open.set(key, {
        thread: message.thread,
        messages: [message],
        timer: setTimeout(() => this.#seal(key), this.#quietMs),
      });
      return;
    }
    clearTimeout(open.timer);
    open.messages.push(message);
    open.timer = setTimeout(() => this.#seal(key), this.#quietMs);
  }

  /**
   * Closes every open album now and waits for what they started. Shutdown
   * cannot wait out a quiet window it did not start, and a half-collected
   * album is still the user's input.
   */
  async sealAll(): Promise<void> {
    for (const key of [...this.#open.keys()]) this.#seal(key);
    while (this.#work.size > 0) await Promise.all([...this.#work]);
  }

  #seal(key: string): void {
    const open = this.#open.get(key);
    if (open === undefined) return;
    clearTimeout(open.timer);
    this.#open.delete(key);
    // Telegram may deliver members out of order; the message id is the order
    // the user saw when sending them.
    const messages = [...open.messages].sort((left, right) => left.messageId - right.messageId);
    const work: Promise<void> = this.#onSeal({
      thread: open.thread,
      updateIds: messages.map((message) => message.updateId),
      messages,
    }).finally(() => {
      this.#work.delete(work);
    });
    this.#work.add(work);
  }
}
