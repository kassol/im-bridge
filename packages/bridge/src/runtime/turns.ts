/**
 * The streaming preview of one turn.
 *
 * Deltas arrive token by token, far faster than Telegram accepts a draft, so
 * they are folded into two accumulators and paced by `StreamThrottle`. Nothing
 * here is durable: a draft expires after 30 seconds and never enters history,
 * and `turn-end.text` is what actually gets persisted. A dropped, coalesced,
 * or truncated delta therefore cannot shorten the result the user keeps.
 */
import type { Logger } from "../log.ts";
import { TelegramApiError, type TelegramApi } from "../telegram/api.ts";
import { DRAFT_BUDGET, THINKING_BUDGET, draftBlocks, charLength, tailChars } from "../telegram/markdown.ts";
import { StreamThrottle } from "../telegram/throttle.ts";

export interface TurnStreamOptions {
  api: TelegramApi;
  chatId: number;
  threadId: number;
  /** Non-zero and stable for this turn: the same id replaces the same draft. */
  draftId: number;
  sessionId: string;
  logger: Logger;
  signal?: AbortSignal;
}

export class TurnStream {
  readonly chatId: number;
  readonly threadId: number;

  readonly #api: TelegramApi;
  readonly #draftId: number;
  readonly #sessionId: string;
  readonly #logger: Logger;
  readonly #signal: AbortSignal | undefined;
  readonly #throttle: StreamThrottle;

  #thinking = "";
  #output = "";
  /** Set once older output stopped fitting the preview. */
  #omitted = false;

  constructor(options: TurnStreamOptions) {
    this.chatId = options.chatId;
    this.threadId = options.threadId;
    this.#api = options.api;
    this.#draftId = options.draftId;
    this.#sessionId = options.sessionId;
    this.#logger = options.logger;
    this.#signal = options.signal;
    this.#throttle = new StreamThrottle({
      flush: (output) => this.#send(output),
      onError: (error) => {
        this.#logger.error("bridge.draft.failed", {
          sessionId: this.#sessionId,
          threadId: this.threadId,
          errorCode: error instanceof TelegramApiError ? error.errorCode : undefined,
          errorSummary: error instanceof TelegramApiError ? error.description : undefined,
        });
      },
    });
  }

  pushThinking(text: string): void {
    if (text === "") return;
    this.#thinking = tailChars(this.#thinking + text, THINKING_BUDGET);
    this.#throttle.push(this.#output);
  }

  pushOutput(text: string): void {
    if (text === "") return;
    const combined = this.#output + text;
    // The accumulator is bounded because a long turn would otherwise hold the
    // whole transcript in memory for a preview that shows its tail.
    if (charLength(combined) > DRAFT_BUDGET) this.#omitted = true;
    this.#output = tailChars(combined, DRAFT_BUDGET);
    this.#throttle.push(this.#output);
  }

  /** Stops updating the draft. The last draft stays until Telegram expires it. */
  close(): void {
    this.#throttle.close();
  }

  async #send(output: string): Promise<void> {
    try {
      await this.#api.sendRichMessageDraft({
        chatId: this.chatId,
        threadId: this.threadId,
        draftId: this.#draftId,
        blocks: draftBlocks({ thinking: this.#thinking, output, omitted: this.#omitted }),
        signal: this.#signal,
      });
    } catch (error) {
      if (error instanceof TelegramApiError && error.retryAfterMs !== undefined) {
        // Telegram escalates the penalty when the delay is not honoured, and
        // the next flush carries newer blocks than a retry of this one would.
        this.#throttle.backOff(error.retryAfterMs / 1_000);
        // The pacer consumed this text before the call, so the content is put
        // back; the retry leaves after the delay Telegram asked for.
        this.#throttle.push(this.#output);
        return;
      }
      throw error;
    }
  }
}
