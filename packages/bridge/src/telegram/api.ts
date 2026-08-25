/**
 * Telegram Bot API transport.
 *
 * This is the only place that knows the token, the wire envelope, and the
 * retry policy. The base URL is injectable so tests drive the real HTTP path
 * against a fake server instead of a mocked `fetch`.
 *
 * Two rules shape the retry classifier:
 *   - `api.telegram.org` drops TLS connections at random, so reads without a
 *     retry are not reliable.
 *   - A final send whose response is lost may already have reached Telegram.
 *     Retrying it would post the message twice, so an ambiguous failure is
 *     final. Only a definitive rejection (429) proves nothing was delivered.
 */
import type { Logger } from "../log.ts";

/**
 * How a failed call may be repeated.
 *   - `idempotent`: reads, file downloads, and draft replacement. Repeating
 *     them changes nothing the user can see.
 *   - `final-send`: anything that lands in Telegram history.
 */
export type TelegramRetryClass = "idempotent" | "final-send";

export type TelegramFailureKind = "transport" | "malformed" | "api";

export interface TelegramApiOptions {
  token: string;
  /** Defaults to the public Bot API host. */
  baseUrl?: string;
  logger?: Logger;
  /** Injected so tests do not wait out backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface TelegramCallOptions {
  retryClass: TelegramRetryClass;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Long polling owns its own reconnect backoff, so it passes 0. */
  maxRetries?: number;
}

export interface BotIdentity {
  readonly id: number;
  readonly username: string;
}

/** One inline button. The callback data is opaque here; the runtime owns its shape. */
export interface InlineKeyboardButton {
  readonly text: string;
  readonly callbackData: string;
}

/** Rows of inline buttons. An empty keyboard leaves a message with no buttons. */
export type InlineKeyboard = readonly (readonly InlineKeyboardButton[])[];

/**
 * One block of a Rich Message.
 *
 * Only the three shapes the bridge renders are modelled. `language` is what
 * makes Telegram highlight code — measured 2026-08-24, a `pre` block without
 * it renders with zero coloured spans — so the language travels with the code
 * instead of being dropped at this boundary.
 */
export type RichBlock =
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "pre"; readonly text: string; readonly language?: string };

/** A Telegram update, still in wire shape. Wire types stay inside this directory. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly [field: string]: unknown;
}

/**
 * A bounded Telegram failure. It carries the error code, a redacted and
 * truncated description, and the honoured backoff. It never carries the token,
 * the request payload, or the response body.
 */
export class TelegramApiError extends Error {
  readonly method: string;
  readonly kind: TelegramFailureKind;
  readonly errorCode: number | undefined;
  readonly description: string | undefined;
  readonly retryAfterMs: number | undefined;
  /** True when the failure could clear on its own; false for a rejection. */
  readonly transient: boolean;

  constructor(details: {
    method: string;
    kind: TelegramFailureKind;
    transient: boolean;
    errorCode?: number;
    description?: string;
    retryAfterMs?: number;
  }) {
    const summary = details.description === undefined ? "" : `: ${details.description}`;
    super(`Telegram ${details.method} failed (${details.kind}${codeSuffix(details.errorCode)})${summary}`);
    this.name = "TelegramApiError";
    this.method = details.method;
    this.kind = details.kind;
    this.transient = details.transient;
    this.errorCode = details.errorCode;
    this.description = details.description;
    this.retryAfterMs = details.retryAfterMs;
  }
}

const DEFAULT_BASE_URL = "https://api.telegram.org";
/** Telegram holds a long poll this long before answering with an empty list. */
const POLL_TIMEOUT_SECONDS = 50;
/** Ten seconds of slack over the server timeout, so a stalled socket is visible. */
const POLL_CLIENT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 8_000;
const MAX_DESCRIPTION_LENGTH = 200;

export class TelegramApi {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #logger: Logger | undefined;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: TelegramApiOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#logger = options.logger;
    this.#sleep = options.sleep ?? delay;
  }

  /**
   * Validates the token and the one capability the bridge cannot work without.
   * Topics are switched on in the BotFather Mini App; there is no API to enable
   * them, so a bot without threaded mode can only fail later, in a topic.
   */
  async getMe(signal?: AbortSignal): Promise<BotIdentity> {
    const result = await this.call("getMe", {}, { retryClass: "idempotent", signal });
    if (!isRecord(result) || typeof result.id !== "number" || typeof result.username !== "string") {
      throw new TelegramApiError({ method: "getMe", kind: "malformed", transient: false });
    }
    if (result.has_topics_enabled !== true) {
      throw new Error(
        "Telegram bot has threaded mode disabled; enable Threaded mode in the BotFather Mini App",
      );
    }
    return { id: result.id, username: result.username };
  }

  /**
   * One long poll. Reconnect backoff lives in the update loop, so a failure
   * here is reported rather than retried.
   */
  async getUpdates(options: { offset?: number; signal?: AbortSignal }): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = { timeout: POLL_TIMEOUT_SECONDS };
    if (options.offset !== undefined) payload.offset = options.offset;
    payload.allowed_updates = ["message", "callback_query"];
    const result = await this.call("getUpdates", payload, {
      retryClass: "idempotent",
      timeoutMs: POLL_CLIENT_TIMEOUT_MS,
      maxRetries: 0,
      signal: options.signal,
    });
    if (!Array.isArray(result)) {
      throw new TelegramApiError({ method: "getUpdates", kind: "malformed", transient: true });
    }
    return result.filter(isUpdate);
  }

  /** Sends a plain message and returns its message id. */
  async sendMessage(message: {
    chatId: number;
    threadId?: number;
    text: string;
    replyMarkup?: InlineKeyboard;
    signal?: AbortSignal;
  }): Promise<number> {
    const payload: Record<string, unknown> = { chat_id: message.chatId };
    if (message.threadId !== undefined) payload.message_thread_id = message.threadId;
    payload.text = message.text;
    if (message.replyMarkup !== undefined) payload.reply_markup = toReplyMarkup(message.replyMarkup);
    const result = await this.call("sendMessage", payload, {
      retryClass: "final-send",
      signal: message.signal,
    });
    if (!isRecord(result) || typeof result.message_id !== "number") {
      throw new TelegramApiError({ method: "sendMessage", kind: "malformed", transient: false });
    }
    return result.message_id;
  }

  /**
   * Replaces the streaming preview of a turn.
   *
   * A draft is a 30-second preview that never enters history, and the same
   * `draft_id` supersedes the previous one, so a repeat changes nothing the
   * user can see. It does not retry: drafts are paced by `StreamThrottle`, and
   * the next flush carries fresher blocks than a retry of this one would, so
   * sleeping inside the call would only delay newer content.
   */
  async sendRichMessageDraft(draft: {
    chatId: number;
    threadId?: number;
    /** Telegram rejects a zero id; the caller numbers drafts per turn. */
    draftId: number;
    blocks: readonly RichBlock[];
    signal?: AbortSignal;
  }): Promise<void> {
    const payload: Record<string, unknown> = { chat_id: draft.chatId };
    if (draft.threadId !== undefined) payload.message_thread_id = draft.threadId;
    payload.draft_id = draft.draftId;
    payload.rich_message = { blocks: draft.blocks.map(toRichBlock) };
    await this.call("sendRichMessageDraft", payload, {
      retryClass: "idempotent",
      maxRetries: 0,
      signal: draft.signal,
    });
  }

  /**
   * Sends the result that stays in history, and returns its message id.
   *
   * Markdown is the entry point rather than blocks: measured 2026-08-24, the
   * two render identically, and Markdown keeps the agent's own output shape
   * without a block tree built from it.
   */
  async sendRichMessage(message: {
    chatId: number;
    threadId?: number;
    markdown: string;
    signal?: AbortSignal;
  }): Promise<number> {
    const payload: Record<string, unknown> = { chat_id: message.chatId };
    if (message.threadId !== undefined) payload.message_thread_id = message.threadId;
    payload.rich_message = { markdown: message.markdown };
    const result = await this.call("sendRichMessage", payload, {
      retryClass: "final-send",
      signal: message.signal,
    });
    if (!isRecord(result) || typeof result.message_id !== "number") {
      throw new TelegramApiError({ method: "sendRichMessage", kind: "malformed", transient: false });
    }
    return result.message_id;
  }

  /**
   * Replaces the text and the keyboard of a message this bot already sent.
   *
   * Retry class is `idempotent`: an edit names its target message and carries
   * the complete new content, so repeating it converges on the same message
   * instead of adding a second one. Telegram rejects an edit that would change
   * nothing with "message is not modified"; that answer means the requested
   * state already holds, so it counts as success.
   */
  async editMessageText(message: {
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: InlineKeyboard;
    signal?: AbortSignal;
  }): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: message.chatId,
      message_id: message.messageId,
      text: message.text,
    };
    if (message.replyMarkup !== undefined) payload.reply_markup = toReplyMarkup(message.replyMarkup);
    await this.#edit("editMessageText", payload, message.signal);
  }

  /** Replaces only the keyboard. Omitting `replyMarkup` removes the buttons. */
  async editMessageReplyMarkup(message: {
    chatId: number;
    messageId: number;
    replyMarkup?: InlineKeyboard;
    signal?: AbortSignal;
  }): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: message.chatId,
      message_id: message.messageId,
    };
    if (message.replyMarkup !== undefined) payload.reply_markup = toReplyMarkup(message.replyMarkup);
    await this.#edit("editMessageReplyMarkup", payload, message.signal);
  }

  /**
   * Clears the loading spinner on a tapped button, optionally with a notice.
   *
   * Retry class is `idempotent`: the answer belongs to one callback id, so a
   * repeat replaces nothing and creates nothing. An already-answered or
   * expired query is a rejection Telegram reports without side effects.
   */
  async answerCallbackQuery(answer: {
    callbackId: string;
    text?: string;
    showAlert?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const payload: Record<string, unknown> = { callback_query_id: answer.callbackId };
    if (answer.text !== undefined) payload.text = answer.text;
    if (answer.showAlert === true) payload.show_alert = true;
    await this.call("answerCallbackQuery", payload, {
      retryClass: "idempotent",
      signal: answer.signal,
    });
  }

  async #edit(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    try {
      await this.call(method, payload, { retryClass: "idempotent", signal });
    } catch (error) {
      if (error instanceof TelegramApiError && isUnmodified(error)) return;
      throw error;
    }
  }

  /**
   * The retry loop every Bot API method shares. Later tickets add methods here
   * rather than re-implementing the classifier.
   */
  async call(
    method: string,
    payload: Record<string, unknown>,
    options: TelegramCallOptions,
  ): Promise<unknown> {
    const maxRetries = options.maxRetries ?? MAX_RETRIES;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#attempt(method, payload, options);
      } catch (error) {
        if (options.signal?.aborted === true) throw error;
        if (!(error instanceof TelegramApiError)) throw error;
        const delayMs = retryDelayMs(error, options.retryClass, attempt, maxRetries);
        if (delayMs === undefined) {
          this.#logger?.error("telegram.request.failed", {
            method,
            attempt,
            retryClass: options.retryClass,
            errorCode: error.errorCode,
            errorSummary: error.description,
          });
          throw error;
        }
        this.#logger?.info("telegram.request.retry", {
          method,
          attempt,
          delayMs,
          retryClass: options.retryClass,
          errorCode: error.errorCode,
        });
        await this.#sleep(delayMs, options.signal);
      }
    }
  }

  async #attempt(
    method: string,
    payload: Record<string, unknown>,
    options: TelegramCallOptions,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    this.#logger?.debug("telegram.request", { method, retryClass: options.retryClass });
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted === true) throw options.signal.reason;
      // The failure is summarised rather than chained: a cause carries a stack
      // and a request URL, and the URL contains the token.
      throw new TelegramApiError({
        method,
        kind: "transport",
        transient: true,
        description: this.#bound(summarize(error)),
      });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TelegramApiError({
        method,
        kind: "malformed",
        transient: true,
        errorCode: response.status,
      });
    }
    if (isRecord(body) && body.ok === true) return body.result;
    if (!isRecord(body)) {
      throw new TelegramApiError({ method, kind: "malformed", transient: true, errorCode: response.status });
    }
    const errorCode = typeof body.error_code === "number" ? body.error_code : response.status;
    const description = typeof body.description === "string" ? this.#bound(body.description) : undefined;
    throw new TelegramApiError({
      method,
      kind: "api",
      transient: response.status >= 500 || errorCode >= 500,
      errorCode,
      description,
      retryAfterMs: readRetryAfterMs(errorCode, body.parameters),
    });
  }

  /** Bounds a summary and removes the token, whatever produced the text. */
  #bound(text: string): string {
    const redacted = text.split(this.#token).join("<redacted>");
    return redacted.length <= MAX_DESCRIPTION_LENGTH ? redacted : redacted.slice(0, MAX_DESCRIPTION_LENGTH);
  }
}

/**
 * The retry classifier. Returns the delay before the next attempt, or
 * `undefined` when the failure is final.
 */
function retryDelayMs(
  error: TelegramApiError,
  retryClass: TelegramRetryClass,
  attempt: number,
  maxRetries: number,
): number | undefined {
  if (attempt > maxRetries) return undefined;
  // 429 is a rejection: Telegram delivered nothing, so even a final send may
  // repeat it. The wait is the complete value Telegram asked for, because the
  // penalty escalates when it is not honoured.
  if (error.retryAfterMs !== undefined) return error.retryAfterMs;
  if (retryClass === "final-send") return undefined;
  if (!error.transient) return undefined;
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

function readRetryAfterMs(errorCode: number, parameters: unknown): number | undefined {
  if (errorCode !== 429) return undefined;
  const seconds = isRecord(parameters) && typeof parameters.retry_after === "number" ? parameters.retry_after : 1;
  return Math.max(seconds, 1) * 1_000;
}

/** Wire shape of an inline keyboard. Telegram field names stop at this boundary. */
function toReplyMarkup(keyboard: InlineKeyboard): Record<string, unknown> {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    ),
  };
}

/** Wire shape of one Rich Message block. Telegram field names stop here. */
function toRichBlock(block: RichBlock): Record<string, unknown> {
  if (block.type === "pre") {
    return {
      type: "pre",
      text: block.text,
      ...(block.language === undefined ? {} : { language: block.language }),
    };
  }
  return { type: block.type, text: block.text };
}

/** "message is not modified" reports that the edit was already applied. */
function isUnmodified(error: TelegramApiError): boolean {
  return error.errorCode === 400 && error.description?.includes("message is not modified") === true;
}

function summarize(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function codeSuffix(errorCode: number | undefined): string {
  return errorCode === undefined ? "" : ` ${errorCode}`;
}

function isUpdate(value: unknown): value is TelegramUpdate {
  return isRecord(value) && typeof value.update_id === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
