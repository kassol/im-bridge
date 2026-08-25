/**
 * Update validation and the long polling loop.
 *
 * Validation order is the security boundary: the allowlist is checked before
 * the chat type, the callback data, or the message content, so an unapproved
 * user never reaches any code that could answer, download, or spend anything.
 * A rejected update produces no reply at all — a reply would confirm that a
 * machine-controlling bot is listening.
 *
 * Everything leaving this module is normalized. Telegram wire shapes stop here.
 */
import type { Logger } from "../log.ts";
import type { Allowlist } from "./allowlist.ts";
import { TelegramApiError, failureSummary, type TelegramApi, type TelegramUpdate } from "./api.ts";

/** Shown to an authorised user who writes in the private main chat. */
export const TOPIC_INSTRUCTION = "请在私聊 topic 中使用";

/** The platform these updates come from, as stored beside every record. */
export const PLATFORM = "telegram";

export interface ThreadIdentity {
  readonly chatId: number;
  readonly threadId: number;
}

export interface InboundPhotoSize {
  readonly fileId: string;
  readonly width: number;
  readonly height: number;
  readonly fileSize?: number;
}

export interface InboundDocument {
  readonly fileId: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly fileSize?: number;
}

export interface InboundMessage {
  readonly kind: "message";
  readonly updateId: number;
  readonly thread: ThreadIdentity;
  readonly userId: number;
  readonly messageId: number;
  /** Message text, or the caption of a photo or image document. */
  readonly text?: string;
  readonly photo?: readonly InboundPhotoSize[];
  readonly document?: InboundDocument;
  readonly mediaGroupId?: string;
}

/**
 * A message whose media the bridge cannot put in a prompt.
 *
 * It is delivered rather than dropped because the sender is authorised and
 * waiting for an answer: the runtime replies once and the input goes no
 * further. Issue #7 keeps these types outside the prompt path, so the caption
 * of a video is never read as if it were a text turn.
 */
export interface InboundUnsupported {
  readonly kind: "unsupported";
  readonly updateId: number;
  readonly thread: ThreadIdentity;
  readonly userId: number;
  readonly messageId: number;
}

export interface InboundCallback {
  readonly kind: "callback";
  readonly updateId: number;
  readonly thread: ThreadIdentity;
  readonly userId: number;
  readonly callbackId: string;
  readonly data: string;
  readonly messageId: number;
}

export type InboundUpdate = InboundMessage | InboundUnsupported | InboundCallback;

/** Message fields that carry media the Backend contract has no part for. */
const UNSUPPORTED_MEDIA = ["video", "animation", "audio", "voice", "sticker", "video_note"] as const;

/** Why an update produced nothing. Logged, never shown to the sender. */
export type DropReason = "unauthorised" | "not-private" | "unsupported";

export type UpdateDecision =
  | { readonly action: "deliver"; readonly update: InboundUpdate }
  | { readonly action: "instruct"; readonly updateId: number; readonly chatId: number }
  | { readonly action: "drop"; readonly updateId: number; readonly reason: DropReason };

export function classifyUpdate(update: TelegramUpdate, allowlist: Allowlist): UpdateDecision {
  // The allowlist runs first, on whatever carrier holds the sender, before any
  // other field of the update is read.
  if (!allowlist.permits(readUserId(update))) {
    return { action: "drop", updateId: update.update_id, reason: "unauthorised" };
  }
  const message = asRecord(update.message);
  if (message !== undefined) return classifyMessage(update.update_id, message);
  const callback = asRecord(update.callback_query);
  if (callback !== undefined) return classifyCallback(update.update_id, callback);
  return { action: "drop", updateId: update.update_id, reason: "unsupported" };
}

function classifyMessage(updateId: number, message: Record<string, unknown>): UpdateDecision {
  const chat = asRecord(message.chat);
  const chatId = chat === undefined ? undefined : asNumber(chat.id);
  if (chat?.type !== "private" || chatId === undefined) {
    return { action: "drop", updateId, reason: "not-private" };
  }
  const userId = readUserId({ update_id: updateId, message });
  const messageId = asNumber(message.message_id);
  const threadId = asNumber(message.message_thread_id);
  if (threadId === undefined) return { action: "instruct", updateId, chatId };
  if (userId === undefined || messageId === undefined) {
    return { action: "drop", updateId, reason: "unsupported" };
  }
  // Before any text is read: a caption belongs to its media, so media the
  // bridge cannot send must not arrive at the backend as a text prompt.
  if (UNSUPPORTED_MEDIA.some((field) => asRecord(message[field]) !== undefined)) {
    return {
      action: "deliver",
      update: { kind: "unsupported", updateId, thread: { chatId, threadId }, userId, messageId },
    };
  }
  const photo = readPhoto(message.photo);
  const document = readDocument(message.document);
  const text = asString(message.text) ?? asString(message.caption);
  if (text === undefined && photo === undefined && document === undefined) {
    return { action: "drop", updateId, reason: "unsupported" };
  }
  return {
    action: "deliver",
    update: {
      kind: "message",
      updateId,
      thread: { chatId, threadId },
      userId,
      messageId,
      ...(text === undefined ? {} : { text }),
      ...(photo === undefined ? {} : { photo }),
      ...(document === undefined ? {} : { document }),
      ...(asString(message.media_group_id) === undefined ? {} : { mediaGroupId: asString(message.media_group_id) }),
    },
  };
}

function classifyCallback(updateId: number, callback: Record<string, unknown>): UpdateDecision {
  const message = asRecord(callback.message);
  const chat = message === undefined ? undefined : asRecord(message.chat);
  const chatId = chat === undefined ? undefined : asNumber(chat.id);
  if (chat?.type !== "private" || chatId === undefined) {
    return { action: "drop", updateId, reason: "not-private" };
  }
  const threadId = message === undefined ? undefined : asNumber(message.message_thread_id);
  const messageId = message === undefined ? undefined : asNumber(message.message_id);
  const userId = readUserId({ update_id: updateId, callback_query: callback });
  const callbackId = asString(callback.id);
  const data = asString(callback.data);
  if (threadId === undefined || messageId === undefined || userId === undefined
    || callbackId === undefined || data === undefined) {
    return { action: "drop", updateId, reason: "unsupported" };
  }
  return {
    action: "deliver",
    update: { kind: "callback", updateId, thread: { chatId, threadId }, userId, callbackId, data, messageId },
  };
}

/**
 * Finds `from.id` in any carrier of the update. Scanning every member keeps
 * the allowlist ahead of update-kind handling: a carrier this bridge does not
 * support still gets authenticated before it is discarded.
 */
function readUserId(update: TelegramUpdate): number | undefined {
  for (const value of Object.values(update)) {
    const carrier = asRecord(value);
    const from = carrier === undefined ? undefined : asRecord(carrier.from);
    const id = from === undefined ? undefined : asNumber(from.id);
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Where polling resumes, and what the loop itself has finished with.
 *
 * `Store` already has this shape. Declaring the two calls the loop needs keeps
 * the platform layer out of the database while the checkpoint stays durable.
 */
export interface PollingCheckpoint {
  /** Highest settled update id. The next poll asks for the one after it. */
  checkpoint(): number;
  /** Updates that reached an outcome without the runtime: drops and notices. */
  settleUpdates(updateIds: readonly number[]): number;
}

export interface UpdateLoopOptions {
  api: TelegramApi;
  allowlist: Allowlist;
  checkpoint: PollingCheckpoint;
  logger: Logger;
  /** Aborting stops the current long poll and ends the loop. */
  signal: AbortSignal;
  /**
   * Takes one accepted update. It must queue the work before it awaits, so
   * updates reach the runtime in Telegram's order, and its promise must settle
   * only when that update needs no further polling protection.
   */
  onUpdate: (update: InboundUpdate) => Promise<void> | void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Long polls until the signal aborts.
 *
 * Where the next poll starts is durable state: `getUpdates` with an offset
 * tells Telegram to forget everything before it, so the loop asks only for
 * what the persisted checkpoint has not confirmed. Inside one process it also
 * never asks again for an update it already dispatched — that update is either
 * recorded as processing or waiting in an album, and a second copy would run
 * its effects twice.
 *
 * A batch is dispatched in Telegram's order and awaited as a whole, so the
 * next poll cannot acknowledge an update that is still unfinished.
 */
export async function runUpdateLoop(options: UpdateLoopOptions): Promise<void> {
  const { api, allowlist, checkpoint, logger, signal } = options;
  const sleep = options.sleep ?? waitFor;
  let dispatched = 0;
  let backoffMs = RECONNECT_MIN_MS;

  while (!signal.aborted) {
    const confirmed = Math.max(checkpoint.checkpoint(), dispatched);
    let updates: TelegramUpdate[];
    try {
      updates = await api.getUpdates({ ...(confirmed === 0 ? {} : { offset: confirmed + 1 }), signal });
    } catch (error) {
      if (signal.aborted) break;
      const retryAfterMs = error instanceof TelegramApiError ? error.retryAfterMs : undefined;
      const delayMs = retryAfterMs ?? backoffMs;
      logger.error("telegram.poll.failed", {
        delayMs,
        errorCode: error instanceof TelegramApiError ? error.errorCode : undefined,
        errorSummary: error instanceof TelegramApiError ? error.description : undefined,
      });
      await sleep(delayMs, signal);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
      continue;
    }
    backoffMs = RECONNECT_MIN_MS;
    // Updates the runtime never sees still have to be settled, or the
    // checkpoint would stop at the first one and Telegram would resend the
    // rest of the batch forever.
    const settled: number[] = [];
    const batch: Array<Promise<void>> = [];
    for (const update of updates) {
      dispatched = Math.max(dispatched, update.update_id);
      batch.push(apply(options, classifyUpdate(update, allowlist), settled));
    }
    await Promise.all(batch);
    if (settled.length > 0) checkpoint.settleUpdates(settled);
  }
}

async function apply(
  options: UpdateLoopOptions,
  decision: UpdateDecision,
  settled: number[],
): Promise<void> {
  const { logger } = options;
  if (decision.action === "drop") {
    logger.debug("telegram.update.dropped", { updateId: decision.updateId, reason: decision.reason });
    settled.push(decision.updateId);
    return;
  }
  if (decision.action === "instruct") {
    try {
      await options.api.sendMessage({
        chatId: decision.chatId,
        text: TOPIC_INSTRUCTION,
        signal: options.signal,
      });
    } catch (error) {
      logger.error("telegram.instruction.failed", {
        updateId: decision.updateId,
        chatId: decision.chatId,
        errorSummary: error instanceof TelegramApiError ? error.description : undefined,
      });
    }
    // The instruction is the whole outcome, delivered or not: nothing else
    // will report this update, so polling moves past it either way.
    settled.push(decision.updateId);
    return;
  }
  const update = decision.update;
  logger.debug("telegram.update.received", {
    updateId: update.updateId,
    chatId: update.thread.chatId,
    threadId: update.thread.threadId,
    userId: update.userId,
    reason: update.kind,
  });
  try {
    await options.onUpdate(update);
  } catch (error) {
    // One failed update must not stop polling. The runtime isolates its own
    // failures as dead letters, so reaching here means the runtime itself
    // failed and this update stays unsettled on purpose.
    logger.error("telegram.update.failed", {
      updateId: update.updateId,
      threadId: update.thread.threadId,
      errorSummary: failureSummary(error),
    });
  }
}

function readPhoto(value: unknown): readonly InboundPhotoSize[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sizes: InboundPhotoSize[] = [];
  for (const entry of value) {
    const size = asRecord(entry);
    const fileId = size === undefined ? undefined : asString(size.file_id);
    const width = size === undefined ? undefined : asNumber(size.width);
    const height = size === undefined ? undefined : asNumber(size.height);
    if (fileId === undefined || width === undefined || height === undefined) continue;
    const fileSize = asNumber(size?.file_size);
    sizes.push({ fileId, width, height, ...(fileSize === undefined ? {} : { fileSize }) });
  }
  return sizes.length === 0 ? undefined : sizes;
}

function readDocument(value: unknown): InboundDocument | undefined {
  const document = asRecord(value);
  const fileId = document === undefined ? undefined : asString(document.file_id);
  if (document === undefined || fileId === undefined) return undefined;
  const fileName = asString(document.file_name);
  const mimeType = asString(document.mime_type);
  const fileSize = asNumber(document.file_size);
  return {
    fileId,
    ...(fileName === undefined ? {} : { fileName }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(fileSize === undefined ? {} : { fileSize }),
  };
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
