/**
 * Shutdown at the runtime seam.
 *
 * The interesting part of shutdown is what it refuses to do: it will not
 * finish work silently, and it will not settle an update it could not prove.
 * These tests hold one unit open on purpose — through the Backend contract, or
 * through a Telegram response that never arrives — and then check the durable
 * traces the next process would read.
 *
 * Timers are fake, so the twenty-second deadline and the album quiet window are
 * both decided by the test rather than waited out.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptContent, Session } from "../src/backends/types.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { BridgeRuntime, PLATFORM } from "../src/runtime/runtime.ts";
import { Store } from "../src/store/store.ts";
import { Allowlist } from "../src/telegram/allowlist.ts";
import { TelegramApi } from "../src/telegram/api.ts";
import type { InboundMessage } from "../src/telegram/updates.ts";
import { FakeBackend } from "./fake-backend.ts";
import { startFakeTelegram, type FakeTelegram } from "./fake-telegram.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";
const AUTHORISED = 149523521;
const CHAT = 5000;
const THREAD = 31;
const SESSION = "01j8z4qk9m7f3b2n6x5c4v-linked-0001";
const WORK_DIR = "/private/tmp/im-bridge-work";

/** A Backend that can hold a prompt open, and that records when it closes. */
class GatedBackend extends FakeBackend {
  readonly order: string[];

  #waiters: Array<() => void> = [];
  #holding = false;

  constructor(order: string[], sessions: readonly Session[] = []) {
    super(sessions);
    this.order = order;
  }

  /** Every later prompt stays unresolved until `release` is called. */
  hold(): void {
    this.#holding = true;
  }

  release(): void {
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiting) resolve();
  }

  override async sendPrompt(sessionId: string, content: PromptContent): Promise<void> {
    await super.sendPrompt(sessionId, content);
    if (!this.#holding) return;
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  override async close(): Promise<void> {
    this.order.push("backend.close");
    await super.close();
  }
}

let dir: string;
let dbPath: string;
let store: Store;
let backend: GatedBackend;
let server: FakeTelegram | undefined;
let runtime: BridgeRuntime;
let polling: AbortController;
let order: string[];
let updateId = 200;

function silentLogger(): Logger {
  return createLogger({ level: "debug", write: () => {} });
}

/** Records the order of the two closes without changing what they do. */
function watchStoreClose(): void {
  const close = store.close.bind(store);
  store.close = (): void => {
    order.push("store.close");
    close();
  };
}

async function build(options: { baseUrl?: string } = {}): Promise<void> {
  order = [];
  backend = new GatedBackend(order, [{ sessionId: SESSION, running: false, cwd: WORK_DIR }]);
  polling = new AbortController();
  watchStoreClose();
  runtime = new BridgeRuntime({
    api: new TelegramApi({ token: TOKEN, baseUrl: options.baseUrl ?? "http://127.0.0.1:1" }),
    backend,
    store,
    allowlist: new Allowlist([AUTHORISED]),
    cwdRoots: new Map([["work", WORK_DIR]]),
    logger: silentLogger(),
    epoch: "epoch1",
    polling,
  });
  store.link({ platform: PLATFORM, chatId: CHAT, threadId: THREAD, backend: "dsh", sessionId: SESSION });
  await runtime.start();
}

function text(body: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  updateId += 1;
  return {
    kind: "message",
    updateId,
    thread: { chatId: CHAT, threadId: THREAD },
    userId: AUTHORISED,
    messageId: updateId,
    text: body,
    ...extra,
  };
}

/** Reads the durable traces after the runtime closed its own handle. */
function reopen(): Store {
  return new Store(dbPath);
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "im-bridge-shutdown-"));
  dbPath = join(dir, "bridge.db");
  store = new Store(dbPath);
  updateId = 200;
});

afterEach(async () => {
  backend.release();
  await server?.close();
  server = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("BridgeRuntime.shutdown", () => {
  it("drains in-flight work, then closes the backend before the store", async () => {
    await build();
    backend.hold();
    const message = text("跑一下测试");
    const unit = runtime.handleUpdate(message);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.prompts).toHaveLength(1);

    const done = runtime.shutdown({ deadlineMs: 20_000, reason: "SIGTERM" });
    backend.release();
    expect(await done).toEqual({ drained: true });
    await unit;

    expect(order).toEqual(["backend.close", "store.close"]);
    const after = reopen();
    try {
      // Settled: the unit finished, so nothing is left for startup recovery.
      expect(after.findProcessing(message.updateId)).toBeUndefined();
      expect(after.checkpoint()).toBe(message.updateId);
    } finally {
      after.close();
    }
  });

  it("leaves the processing record of work that outlived the deadline", async () => {
    await build();
    backend.hold();
    const message = text("跑一个很久的任务");
    // The polling loop is what catches a failed unit in production; here the
    // rejection arrives when the released prompt meets the closed Store.
    const unit = runtime.handleUpdate(message).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    const done = runtime.shutdown({ deadlineMs: 20_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await done).toEqual({ drained: false });
    expect(order).toEqual(["backend.close", "store.close"]);
    backend.release();
    await unit;

    const after = reopen();
    try {
      // Open on purpose: the next start turns it into a dead letter and asks
      // the topic to resend, rather than reporting a turn that never landed.
      expect(after.findProcessing(message.updateId)?.step).toBe("queued");
      expect(after.checkpoint()).toBe(0);
      expect(after.recoverProcessing().map((record) => record.updateId)).toEqual([message.updateId]);
    } finally {
      after.close();
    }
  });

  it("aborts polling and leaves a later update unrecorded and unsettled", async () => {
    await build();
    backend.hold();
    const running = text("第一条");
    const unit = runtime.handleUpdate(running).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    const done = runtime.shutdown({ deadlineMs: 20_000 });
    expect(polling.signal.aborted).toBe(true);

    const late = text("关机之后到的");
    await runtime.handleUpdate(late);
    backend.release();
    await done;
    await unit;

    const after = reopen();
    try {
      expect(after.findProcessing(late.updateId)).toBeUndefined();
      // Not settled either, so the next process polls it again from the same
      // checkpoint instead of skipping it.
      expect(after.checkpoint()).toBe(running.updateId);
      expect(backend.prompts.map((sent) => sent.content)).toHaveLength(1);
    } finally {
      after.close();
    }
  });

  it("seals a collecting album instead of waiting out its quiet window", async () => {
    await build();
    const first = text("第一张的说明", { mediaGroupId: "group-1" });
    const second = text("第二张的说明", { mediaGroupId: "group-1" });
    await runtime.handleUpdate(first);
    await runtime.handleUpdate(second);
    expect(backend.prompts).toHaveLength(0);

    // No timer is advanced: the quiet window is a guess about the user, and
    // shutdown must not wait it out.
    expect(await runtime.shutdown({ deadlineMs: 20_000 })).toEqual({ drained: true });

    expect(backend.prompts).toHaveLength(1);
    const after = reopen();
    try {
      expect(after.checkpoint()).toBe(second.updateId);
    } finally {
      after.close();
    }
  });

  it("waits for a send a backend event started", async () => {
    server = await startFakeTelegram(() => ({ hang: true }));
    await build({ baseUrl: server.baseUrl });
    // A warning renders as one status message. The fake never answers it, so
    // the only way shutdown can finish is by giving up at the deadline.
    void backend.emit({ type: "warning", sessionId: SESSION, message: "后端降级" });
    await vi.advanceTimersByTimeAsync(0);

    const done = runtime.shutdown({ deadlineMs: 20_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await done).toEqual({ drained: false });
  });

  it("reports the first outcome to every caller and closes once", async () => {
    await build();
    const first = runtime.shutdown({ deadlineMs: 20_000 });
    const second = runtime.shutdown({ deadlineMs: 1 });
    expect(await first).toEqual({ drained: true });
    expect(await second).toEqual({ drained: true });
    expect(order).toEqual(["backend.close", "store.close"]);
  });

  it("records the shutdown reason without any user content", async () => {
    const lines: string[] = [];
    order = [];
    backend = new GatedBackend(order, []);
    polling = new AbortController();
    watchStoreClose();
    runtime = new BridgeRuntime({
      api: new TelegramApi({ token: TOKEN, baseUrl: "http://127.0.0.1:1" }),
      backend,
      store,
      allowlist: new Allowlist([AUTHORISED]),
      cwdRoots: new Map([["work", WORK_DIR]]),
      logger: createLogger({ level: "info", write: (line) => lines.push(line) }),
      polling,
    });

    await runtime.shutdown({ deadlineMs: 20_000, reason: "SIGTERM" });

    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event["event"])).toEqual([
      "bridge.shutdown.started",
      "bridge.shutdown.finished",
    ]);
    expect(events[0]?.["reason"]).toBe("SIGTERM");
    expect(events[0]?.["delayMs"]).toBe(20_000);
    expect(events[1]?.["reason"]).toBe("drained");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
