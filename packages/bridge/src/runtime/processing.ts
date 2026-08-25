/**
 * Durable update processing.
 *
 * One unit is one atomic input: a single update, or every update an album was
 * made of. Before the unit's first Telegram or Backend side effect it is
 * marked processing, and each completed effect records a bounded step plus
 * whatever id the effect returned. A retry inside this process reads those
 * back and skips what already happened, so three attempts never produce three
 * sessions or three prompts.
 *
 * Nothing user-authored is written here. The step is a constant from this
 * file, the failure code and summary are composed from the error's type, and
 * the ids come from Telegram and the backend — an exception message never
 * reaches the database, because it is the one string that could carry a
 * fragment of a prompt.
 *
 * Retries stop at the process boundary. A crash leaves the record open, and
 * startup isolates it instead of repeating work whose external effects cannot
 * be proved.
 */
import type { Logger } from "../log.ts";
import type { ProcessingRecord, ProcessingStepPatch, Store } from "../store/store.ts";
import { TelegramApiError } from "../telegram/api.ts";
import { PLATFORM, type ThreadIdentity } from "../telegram/updates.ts";

/** Attempts inside one process, including the first. */
export const MAX_ATTEMPTS = 3;

/** Marked at dispatch, before the unit reaches the first effect. */
export const STEP_QUEUED = "queued";
/** The backend accepted the prompt content; a retry must not send it again. */
export const STEP_PROMPT_SENT = "prompt-sent";
/** The backend created a session; a retry must bind that one, not a new one. */
export const STEP_SESSION_CREATED = "session-created";
/** A menu or a status message reached Telegram. */
export const STEP_MESSAGE_SENT = "message-sent";
/** The tapped message was edited into its current state. */
export const STEP_MESSAGE_EDITED = "message-edited";
/** The backend was told what the user decided about an approval. */
export const STEP_APPROVAL_ANSWERED = "approval-answered";

/** What a bridge restart is called in a dead letter. */
export const DEAD_LETTER_EXHAUSTED = "retry-exhausted";

/** One atomic input, named by every update id that made it. */
export interface ProcessingUnit {
  /** In order. The first one keys the record and the dead letter. */
  readonly updateIds: readonly number[];
  /** Bounded label: what kind of input this is. */
  readonly kind: string;
  readonly thread: ThreadIdentity;
}

export interface ProcessingDeps {
  readonly store: Store;
  readonly logger: Logger;
}

/**
 * The recorded progress of one unit, as the effects of an attempt see it.
 *
 * Reads answer "was this already done"; `advance` writes the answer for the
 * next attempt.
 */
export class UpdateProgress {
  readonly #store: Store;
  #record: ProcessingRecord;

  constructor(store: Store, record: ProcessingRecord) {
    this.#store = store;
    this.#record = record;
  }

  get step(): string {
    return this.#record.step;
  }

  /** The session an earlier attempt created or sent to. */
  get sessionId(): string | undefined {
    return this.#record.sessionId;
  }

  /** The Telegram message an earlier attempt sent. */
  get messageId(): number | undefined {
    return this.#record.messageId;
  }

  advance(patch: ProcessingStepPatch): void {
    this.#record = this.#store.recordStep(this.#record.updateId, patch);
  }
}

/**
 * Opens the record for `unit` before it is queued.
 *
 * The record is also the checkpoint barrier: while it exists, no younger
 * update can move the checkpoint past this one, so an update waiting for a
 * free thread is never skipped.
 */
export function markQueued(store: Store, unit: ProcessingUnit): void {
  store.beginProcessing({
    updateId: anchorOf(unit),
    updateKind: unit.kind,
    platform: PLATFORM,
    chatId: unit.thread.chatId,
    threadId: unit.thread.threadId,
    step: STEP_QUEUED,
  });
}

/**
 * Runs one unit to a durable outcome: completed, or isolated as a dead letter.
 *
 * It never rejects. A unit that keeps failing is the reason dead letters
 * exist, and the polling checkpoint has to keep moving either way.
 */
export async function runProcessing(
  deps: ProcessingDeps,
  unit: ProcessingUnit,
  run: (progress: UpdateProgress) => Promise<void>,
): Promise<void> {
  const { store, logger } = deps;
  const anchor = anchorOf(unit);
  let failure: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // The first attempt reuses the record opened at dispatch; a later one
    // counts itself, keeping the step and the ids the earlier attempt wrote.
    const record =
      attempt === 1
        ? store.findProcessing(anchor) ?? beginRecord(store, unit, anchor)
        : beginRecord(store, unit, anchor);
    try {
      await run(new UpdateProgress(store, record));
      store.settleUpdates(unit.updateIds);
      return;
    } catch (error) {
      failure = error;
      logger.error("bridge.update.failed", {
        updateId: anchor,
        threadId: unit.thread.threadId,
        attempt,
        reason: unit.kind,
        errorSummary: failureSummary(error),
      });
    }
  }
  store.writeDeadLetter({
    updateId: anchor,
    updateKind: unit.kind,
    platform: PLATFORM,
    chatId: unit.thread.chatId,
    threadId: unit.thread.threadId,
    errorCode: DEAD_LETTER_EXHAUSTED,
    errorSummary: failureSummary(failure),
    attempts: MAX_ATTEMPTS,
  });
  // The dead letter settles its own update; an album's other members are
  // settled with it, so the whole input leaves as one thing.
  store.settleUpdates(unit.updateIds);
  logger.error("bridge.update.isolated", {
    updateId: anchor,
    threadId: unit.thread.threadId,
    count: unit.updateIds.length,
    reason: DEAD_LETTER_EXHAUSTED,
    errorSummary: failureSummary(failure),
  });
}

/**
 * A failure named by its type, never by its message.
 *
 * Telegram descriptions and backend messages are the only strings in the
 * bridge that could quote what a user wrote, and a dead letter outlives the
 * process, so what is written here is composed from fields that cannot.
 */
export function failureSummary(error: unknown): string {
  if (error instanceof TelegramApiError) {
    const code = error.errorCode === undefined ? "" : ` ${String(error.errorCode)}`;
    return `telegram ${error.method} ${error.kind}${code}`;
  }
  if (error instanceof Error) return `${error.name} in update processing`;
  return "unknown failure in update processing";
}

function beginRecord(store: Store, unit: ProcessingUnit, anchor: number): ProcessingRecord {
  return store.beginProcessing({
    updateId: anchor,
    updateKind: unit.kind,
    platform: PLATFORM,
    chatId: unit.thread.chatId,
    threadId: unit.thread.threadId,
    step: STEP_QUEUED,
  });
}

function anchorOf(unit: ProcessingUnit): number {
  const anchor = unit.updateIds[0];
  if (anchor === undefined) throw new Error("a processing unit needs at least one update id");
  return anchor;
}
