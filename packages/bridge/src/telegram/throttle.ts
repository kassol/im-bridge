/**
 * Streaming throttle for Telegram.
 *
 * Measured 2026-08-24 against a real bot in a private chat:
 *   1000ms x 60 -> 0 failures
 *   1500ms x 40 -> 0 failures
 *    500ms x100 -> fine for ~40 calls, then sustained 429s with retry_after
 *                  climbing 3s -> 9s
 *
 * So 500ms is a burst allowance, not a rate. One second is the sustainable
 * cadence, and it matches Telegram's documented 1 msg/s private-chat ceiling.
 *
 * Agent output arrives token by token, far faster than that. This class
 * coalesces those tokens into at most one flush per interval and always
 * flushes the latest accumulated text, so dropping intermediate frames is
 * harmless — the next flush carries everything.
 */
export interface ThrottleOptions {
  /** Minimum gap between flushes. Do not lower below 1000 without re-measuring. */
  intervalMs?: number;
  /** Emits the accumulated text. Rejections are reported via onError. */
  flush: (text: string) => Promise<void>;
  onError?: (error: unknown) => void;
}

export class StreamThrottle {
  private readonly intervalMs: number;
  private readonly doFlush: (text: string) => Promise<void>;
  private readonly onError: (error: unknown) => void;

  private pending: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private lastFlushAt = 0;
  /** Set when Telegram returns retry_after; no flush may start before this. */
  private blockedUntil = 0;
  private closed = false;

  constructor(options: ThrottleOptions) {
    this.intervalMs = options.intervalMs ?? 1000;
    this.doFlush = options.flush;
    this.onError = options.onError ?? (() => {});
  }

  /** Replace the pending text. Later calls supersede earlier ones. */
  push(text: string): void {
    if (this.closed) return;
    this.pending = text;
    this.schedule();
  }

  /**
   * Telegram asked us to back off. Penalties escalate if ignored, so honour
   * the full delay rather than retrying immediately.
   */
  backOff(retryAfterSeconds: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + retryAfterSeconds * 1000);
    this.schedule();
  }

  /** Flush whatever remains, ignoring the interval. Used at turn end. */
  async finish(): Promise<void> {
    this.clearTimer();
    if (this.pending === undefined) return;
    const text = this.pending;
    this.pending = undefined;
    try {
      await this.doFlush(text);
    } catch (error) {
      this.onError(error);
    }
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
    this.pending = undefined;
  }

  private schedule(): void {
    if (this.timer !== undefined || this.inFlight || this.pending === undefined) return;
    const now = Date.now();
    const earliest = Math.max(this.lastFlushAt + this.intervalMs, this.blockedUntil);
    const delay = Math.max(0, earliest - now);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
  }

  private async run(): Promise<void> {
    if (this.pending === undefined || this.closed) return;
    const text = this.pending;
    this.pending = undefined;
    this.inFlight = true;
    try {
      await this.doFlush(text);
    } catch (error) {
      this.onError(error);
    } finally {
      this.inFlight = false;
      this.lastFlushAt = Date.now();
      this.schedule();
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
