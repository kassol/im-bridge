/**
 * Durable processing seam tests.
 *
 * Updates go in as normalized updates and come out as real HTTP against the
 * fake Bot API plus real rows in a temporary SQLite store. What is asserted
 * here is the part a user never sees: when an update is marked, what a retry
 * repeats, when the polling checkpoint may move, and what a dead letter is
 * allowed to remember.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/backends/types.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { encodeCallback } from "../src/runtime/callbacks.ts";
import { MAX_ATTEMPTS, STEP_QUEUED } from "../src/runtime/processing.ts";
import { BridgeRuntime, PLATFORM, RESEND_NOTICE } from "../src/runtime/runtime.ts";
import { Store } from "../src/store/store.ts";
import { Allowlist } from "../src/telegram/allowlist.ts";
import { TelegramApi } from "../src/telegram/api.ts";
import type { InboundMessage } from "../src/telegram/updates.ts";
import { FakeBackend } from "./fake-backend.ts";
import { startFakeTelegram, type FakeCall, type FakeReply, type FakeTelegram } from "./fake-telegram.ts";

const run = promisify(execFile);

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";
const AUTHORISED = 149523521;
const STRANGER = 999000111;
const CHAT = 5000;
const THREAD = 31;
const OTHER_THREAD = 32;
const SESSION = "01j8z4qk9m7f3b2n6x5c4v-0001";
const OTHER_SESSION = "01j8z4qk9m7f3b2n6x5c4v-0002";
const MENU_MESSAGE = 900;
const EPOCH = "epoch1";
const WORK_DIR = "/private/tmp/im-bridge-work";
const ALIASES = new Map([["work", WORK_DIR]]);
const SECRET = "把生产库删了";

let dir: string;
let store: Store;
let backend: FakeBackend;
let server: FakeTelegram | undefined;
let runtime: BridgeRuntime;
let reply: (call: FakeCall) => FakeReply;
let lines: string[];
let updateId = 100;

interface Gate {
  readonly wait: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function okReply(call: FakeCall): FakeReply {
  if (call.method === "answerCallbackQuery") return { json: { ok: true, result: true } };
  return { json: { ok: true, result: { message_id: MENU_MESSAGE } } };
}

/** A rejection Telegram answers with, so no attempt sleeps on a retry. */
function rejected(): FakeReply {
  return { json: { ok: false, error_code: 400, description: "BAD_REQUEST" } };
}

function session(sessionId: string, extra: Partial<Session> = {}): Session {
  return { sessionId, running: false, cwd: WORK_DIR, ...extra };
}

function link(sessionId: string, threadId: number = THREAD): void {
  store.link({ platform: PLATFORM, chatId: CHAT, threadId, backend: "dsh", sessionId });
}

async function start(sessions: readonly Session[] = [session(SESSION)]): Promise<BridgeRuntime> {
  backend = new FakeBackend(sessions);
  server = await startFakeTelegram((call) => reply(call));
  runtime = new BridgeRuntime({
    api: new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl }),
    backend,
    store,
    allowlist: new Allowlist([AUTHORISED]),
    cwdAliases: ALIASES,
    logger: capturingLogger(),
    epoch: EPOCH,
  });
  return runtime;
}

function capturingLogger(): Logger {
  return createLogger({ level: "debug", write: (line) => lines.push(line) });
}

function message(fields: Partial<InboundMessage> = {}): InboundMessage {
  updateId += 1;
  return {
    kind: "message",
    updateId,
    thread: { chatId: CHAT, threadId: THREAD },
    userId: AUTHORISED,
    messageId: updateId,
    ...fields,
  };
}

function calls(method: string): FakeCall[] {
  return (server?.calls ?? []).filter((call) => call.method === method);
}

function textOf(call: FakeCall): string {
  return String(call.body["text"] ?? "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-bridge-processing-"));
  store = new Store(join(dir, "bridge.db"));
  reply = okReply;
  lines = [];
  updateId = 100;
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    store.close();
  } catch {
    // A crash-recovery test closes it first; the file is going anyway.
  }
  rmSync(dir, { recursive: true, force: true });
  await server?.close();
  server = undefined;
});

describe("marking and settling", () => {
  it("marks the update processing before its first Telegram call", async () => {
    await start();
    let marked: { step: string; kind: string } | undefined;
    reply = (call) => {
      const record = store.findProcessing(updateId);
      if (record !== undefined) marked = { step: record.step, kind: record.updateKind };
      return okReply(call);
    };

    await runtime.handleUpdate(message({ text: "/manage" }));

    expect(marked).toEqual({ step: STEP_QUEUED, kind: "message" });
    // The record is gone once the update is done, and the checkpoint has it.
    expect(store.findProcessing(updateId)).toBeUndefined();
    expect(store.checkpoint()).toBe(updateId);
  });

  it("settles an update it drops, so polling can move past it", async () => {
    await start();
    const stranger = message({ text: "/manage", userId: STRANGER });
    await runtime.handleUpdate(stranger);

    expect(server?.calls).toHaveLength(0);
    expect(store.checkpoint()).toBe(stranger.updateId);
  });

  it("holds the checkpoint at a gap until the older update finishes", async () => {
    link(SESSION);
    link(OTHER_SESSION, OTHER_THREAD);
    await start([session(SESSION), session(OTHER_SESSION)]);
    const held = gate();
    const original = backend.sendPrompt.bind(backend);
    vi.spyOn(backend, "sendPrompt").mockImplementation(async (sessionId, content) => {
      if (sessionId === SESSION) await held.wait;
      await original(sessionId, content);
    });

    const slow = message({ text: "第一条" });
    const slowWork = runtime.handleUpdate(slow);
    const fast = message({ text: "第二条", thread: { chatId: CHAT, threadId: OTHER_THREAD } });
    await runtime.handleUpdate(fast);

    // The younger update finished first; the checkpoint may not pass the gap.
    expect(store.checkpoint()).toBe(0);
    held.open();
    await slowWork;
    expect(store.checkpoint()).toBe(fast.updateId);
  });

  it("runs one thread's updates in arrival order", async () => {
    link(SESSION);
    await start();
    const held = gate();
    const original = backend.sendPrompt.bind(backend);
    vi.spyOn(backend, "sendPrompt").mockImplementation(async (sessionId, content) => {
      if (backend.prompts.length === 0) await held.wait;
      await original(sessionId, content);
    });

    const first = runtime.handleUpdate(message({ text: "第一条" }));
    const second = runtime.handleUpdate(message({ text: "第二条" }));
    held.open();
    await Promise.all([first, second]);

    expect(backend.prompts.map((prompt) => prompt.content)).toEqual([
      [{ type: "text", text: "第一条" }],
      [{ type: "text", text: "第二条" }],
    ]);
  });
});

describe("retries", () => {
  it("resumes from the recorded step instead of creating a second session", async () => {
    await start([]);
    // The menu edit that follows session creation fails once; the retry must
    // bind the session the first attempt already created.
    reply = (call) => (call.method === "editMessageText" && call.count === 1 ? rejected() : okReply(call));

    updateId += 1;
    await runtime.handleUpdate({
      kind: "callback",
      updateId,
      thread: { chatId: CHAT, threadId: THREAD },
      userId: AUTHORISED,
      callbackId: "cb-1",
      data: encodeCallback(EPOCH, { kind: "create", alias: "work" }),
      messageId: MENU_MESSAGE,
    });

    expect(backend.created).toHaveLength(1);
    expect(store.findByThread(PLATFORM, CHAT, THREAD)?.sessionId).toBe(backend.created[0]?.sessionId);
    expect(store.listDeadLetters()).toHaveLength(0);
  });

  it("stops after three attempts, isolates the update, and keeps polling moving", async () => {
    link(SESSION);
    await start();
    vi.spyOn(backend, "sendPrompt").mockRejectedValue(new Error(`dsh refused: ${SECRET}`));

    const toxic = message({ text: SECRET });
    await runtime.handleUpdate(toxic);

    expect(backend.prompts).toHaveLength(0);
    const [isolated] = store.listDeadLetters();
    expect(isolated).toMatchObject({
      updateId: toxic.updateId,
      updateKind: "message",
      threadId: THREAD,
      errorCode: "retry-exhausted",
      attempts: MAX_ATTEMPTS,
    });
    expect(store.checkpoint()).toBe(toxic.updateId);
    expect(store.findProcessing(toxic.updateId)).toBeUndefined();

    // A later update still runs, and the checkpoint moves through both.
    const next = message({ text: "下一条" });
    await runtime.handleUpdate(next);
    expect(store.checkpoint()).toBe(next.updateId);
  });

  it("keeps prompt text out of the dead letter and the log", async () => {
    link(SESSION);
    await start();
    vi.spyOn(backend, "sendPrompt").mockRejectedValue(new Error(`dsh refused: ${SECRET}`));

    await runtime.handleUpdate(message({ text: SECRET }));

    const [isolated] = store.listDeadLetters();
    expect(isolated?.errorSummary).toBe("Error in update processing");
    expect(JSON.stringify(isolated)).not.toContain(SECRET);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(TOKEN);
    }
  });

  it("counts the attempts of one update in its record", async () => {
    link(SESSION);
    await start();
    const attempts: number[] = [];
    vi.spyOn(backend, "sendPrompt").mockImplementation(async () => {
      attempts.push(store.findProcessing(updateId)?.attempts ?? 0);
      throw new Error("dsh refused");
    });

    await runtime.handleUpdate(message({ text: "会失败" }));

    expect(attempts).toEqual([1, 2, 3]);
  });
});

describe("albums", () => {
  it("settles every member of one album together", async () => {
    link(SESSION);
    await start();
    const group = [
      message({ text: "看这些", mediaGroupId: "album-1" }),
      message({ mediaGroupId: "album-1" }),
    ];
    for (const member of group) await runtime.handleUpdate(member);

    // Collecting holds the checkpoint: the input is not delivered yet.
    expect(store.checkpoint()).toBe(0);
    expect(store.findProcessing(group[0]!.updateId)?.updateKind).toBe("message");

    await runtime.sealAlbums();

    expect(backend.prompts).toHaveLength(1);
    expect(store.checkpoint()).toBe(group[1]!.updateId);
    for (const member of group) expect(store.findProcessing(member.updateId)).toBeUndefined();
  });
});

describe("crash recovery", () => {
  it("isolates uncertain work, asks the topic to resend, and never retries it", async () => {
    link(SESSION);
    await start();
    const stuck = gate();
    vi.spyOn(backend, "sendPrompt").mockImplementation(async () => {
      await stuck.wait;
    });
    const lost = message({ text: "崩溃前的输入" });
    // The old process never finishes this update; that is what a crash is.
    void runtime.handleUpdate(lost).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(store.findProcessing(lost.updateId)).toBeDefined();

    // The process is gone. A new one opens the same file.
    store.close();
    const reopened = new Store(join(dir, "bridge.db"));
    store = reopened;
    const restarted = await start();
    await restarted.recover();

    const [isolated] = reopened.listDeadLetters();
    expect(isolated).toMatchObject({
      updateId: lost.updateId,
      threadId: THREAD,
      errorCode: "crash-recovery",
    });
    expect(backend.prompts).toHaveLength(0);
    expect(reopened.checkpoint()).toBe(lost.updateId);
    expect(textOf(calls("sendMessage")[0]!)).toBe(RESEND_NOTICE);
    expect(calls("sendMessage")).toHaveLength(1);
  });
});

describe("retention", () => {
  it("drops dead letters older than the retention window at startup", async () => {
    const path = join(dir, "bridge.db");
    store.close();
    const long = new Date(Date.now() - 40 * 86_400_000);
    const older = new Store(path, { now: () => long });
    older.writeDeadLetter({
      updateId: 600,
      updateKind: "message",
      platform: PLATFORM,
      chatId: CHAT,
      threadId: THREAD,
      errorCode: "retry-exhausted",
      errorSummary: "Error in update processing",
      attempts: MAX_ATTEMPTS,
    });
    older.close();

    store = new Store(path);
    const restarted = await start();
    await restarted.recover();

    expect(store.listDeadLetters()).toHaveLength(0);
  });
});

describe("dead-letters list", () => {
  it("prints one metadata-only line per record and starts no polling", async () => {
    store.writeDeadLetter({
      updateId: 700,
      updateKind: "message",
      platform: PLATFORM,
      chatId: CHAT,
      threadId: THREAD,
      errorCode: "retry-exhausted",
      errorSummary: "Error in update processing",
      attempts: MAX_ATTEMPTS,
    });
    store.close();
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        botToken: TOKEN,
        allowedUserIds: [AUTHORISED],
        cwdAliases: { work: dir },
        databasePath: join(dir, "bridge.db"),
        dshUrl: "http://127.0.0.1:3080",
      }),
      "utf8",
    );
    chmodSync(configPath, 0o600);

    const entry = new URL("../src/index.ts", import.meta.url).pathname;
    const { stdout } = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      entry,
      configPath,
      "dead-letters",
      "list",
    ]);

    const printed = stdout.trim().split("\n");
    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0]!)).toEqual({
      updateId: 700,
      updateKind: "message",
      platform: PLATFORM,
      chatId: CHAT,
      threadId: THREAD,
      errorCode: "retry-exhausted",
      errorSummary: "Error in update processing",
      attempts: MAX_ATTEMPTS,
      createdAt: expect.any(String),
    });
    expect(stdout).not.toContain(TOKEN);
    // The store was reopened, and nothing else: no bot call was possible.
    store = new Store(join(dir, "bridge.db"));
    expect(store.listDeadLetters()).toHaveLength(1);
  });
});
