/**
 * Approval seam tests.
 *
 * An approval is the one place where a tap on a Telegram button changes what
 * the agent is allowed to do on this machine, and dsh broadcasts the same
 * request to every client. So the tests drive both ends: the backend files a
 * request, the fake Bot API captures the message the user sees, and the click
 * comes back as a callback update with the data that message carried.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/backends/types.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { encodeCallback } from "../src/runtime/callbacks.ts";
import {
  APPROVAL_ALLOWED_TEXT,
  APPROVAL_ELSEWHERE_TEXT,
  APPROVAL_EXPIRED_TEXT,
  APPROVAL_PREFIX,
  APPROVAL_REASON_LIMIT,
  APPROVAL_REJECTED_TEXT,
  APPROVAL_UNLINKED_TEXT,
} from "../src/runtime/menus.ts";
import { BridgeRuntime, ERROR_PREFIX, PLATFORM } from "../src/runtime/runtime.ts";
import { Store } from "../src/store/store.ts";
import { Allowlist } from "../src/telegram/allowlist.ts";
import { TelegramApi } from "../src/telegram/api.ts";
import type { InboundCallback } from "../src/telegram/updates.ts";
import { FakeBackend } from "./fake-backend.ts";
import { startFakeTelegram, type FakeCall, type FakeTelegram } from "./fake-telegram.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";
const AUTHORISED = 149523521;
const CHAT = 5000;
const THREAD = 31;
const SESSION = "01j8z4qk9m7f3b2n6x5c4v-0001";
const REQUEST = "rpc-1a2b3c4d-5e6f-7890-abcd-ef0123456789";
const APPROVAL_MESSAGE = 910;
const EPOCH = "epoch1";
const WORK_DIR = "/private/tmp/im-bridge-work";
const ROOTS = new Map([["work", WORK_DIR]]);

interface Button {
  readonly text: string;
  readonly callback_data: string;
}

let dir: string;
let store: Store;
let backend: FakeBackend;
let server: FakeTelegram;
let api: TelegramApi;
let runtime: BridgeRuntime;
let lines: string[];
let updateId = 200;

function silentLogger(): Logger {
  return createLogger({ level: "debug", write: (line) => lines.push(line) });
}

function session(sessionId: string, extra: Partial<Session> = {}): Session {
  return { sessionId, running: false, cwd: WORK_DIR, ...extra };
}

async function start(): Promise<void> {
  backend = new FakeBackend([session(SESSION)]);
  server = await startFakeTelegram((call) => {
    if (call.method === "answerCallbackQuery") return { json: { ok: true, result: true } };
    return { json: { ok: true, result: { message_id: APPROVAL_MESSAGE } } };
  });
  api = new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl });
  runtime = new BridgeRuntime({
    api,
    backend,
    store,
    allowlist: new Allowlist([AUTHORISED]),
    cwdRoots: ROOTS,
    logger: silentLogger(),
    epoch: EPOCH,
  });
  await runtime.start();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-bridge-approvals-"));
  store = new Store(join(dir, "bridge.db"));
  lines = [];
  updateId = 200;
});

afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  await server.close();
});

function link(): void {
  store.link({ platform: PLATFORM, chatId: CHAT, threadId: THREAD, backend: "dsh", sessionId: SESSION });
}

function calls(method: string): FakeCall[] {
  return server.calls.filter((call) => call.method === method);
}

function lastCall(method: string): FakeCall {
  const call = calls(method).at(-1);
  if (call === undefined) throw new Error(`no ${method} call`);
  return call;
}

function textOf(call: FakeCall): string {
  return String(call.body["text"] ?? "");
}

function markupOf(call: FakeCall): Button[][] {
  const markup = call.body["reply_markup"];
  if (typeof markup !== "object" || markup === null) return [];
  const rows = (markup as { inline_keyboard?: unknown }).inline_keyboard;
  return Array.isArray(rows) ? (rows as Button[][]) : [];
}

/** Files one approval and returns the callback data of each button. */
async function ask(prompt = "运行 bash: rm -rf build"): Promise<Map<string, string>> {
  await backend.emit({ type: "approval", sessionId: SESSION, requestId: REQUEST, prompt });
  const buttons = markupOf(lastCall("sendMessage")).flat();
  return new Map(buttons.map((button) => [button.text, button.callback_data]));
}

function callback(data: string, fields: Partial<InboundCallback> = {}): InboundCallback {
  updateId += 1;
  return {
    kind: "callback",
    updateId,
    thread: { chatId: CHAT, threadId: THREAD },
    userId: AUTHORISED,
    callbackId: `cb-${String(updateId)}`,
    data,
    messageId: APPROVAL_MESSAGE,
    ...fields,
  };
}

describe("failure reporting", () => {
  it("names a failed approval message by its type and never by its message", async () => {
    const marker = "把生产库删了";
    link();
    await start();
    vi.spyOn(api, "sendMessage").mockRejectedValue(new Error(`send refused: ${marker}`));

    await backend.emit({ type: "approval", sessionId: SESSION, requestId: REQUEST, prompt: "运行 bash" });

    const failed = lines.filter((line) => line.includes("bridge.event.failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('"errorSummary":"Error in update processing"');
    for (const line of lines) expect(line).not.toContain(marker);
  });
});

describe("asking", () => {
  it("posts one Chinese message with allow-once and reject buttons", async () => {
    link();
    await start();

    const buttons = await ask();

    const asked = lastCall("sendMessage");
    expect(asked.body["message_thread_id"]).toBe(THREAD);
    expect(textOf(asked)).toBe(`${APPROVAL_PREFIX}运行 bash: rm -rf build`);
    expect([...buttons.keys()]).toEqual(["允许一次", "拒绝"]);
    // The request id never has to fit in callback data.
    for (const data of buttons.values()) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      expect(data).not.toContain(REQUEST);
    }
    expect(backend.approvals).toHaveLength(0);
  });

  it("bounds the reason it quotes", async () => {
    link();
    await start();

    await ask("x".repeat(2_000));

    expect(textOf(lastCall("sendMessage"))).toHaveLength(APPROVAL_PREFIX.length + APPROVAL_REASON_LIMIT);
  });

  it("leaves an approval for an unlinked session pending", async () => {
    await start();

    await backend.emit({ type: "approval", sessionId: SESSION, requestId: REQUEST, prompt: "运行 bash" });

    expect(calls("sendMessage")).toHaveLength(0);
    expect(backend.approvals).toHaveLength(0);
    expect(lines.some((line) => (JSON.parse(line) as { event?: string }).event === "bridge.approval.unlinked")).toBe(true);
  });
});

describe("answering", () => {
  it("allows once, tells the backend, and removes the keyboard", async () => {
    link();
    await start();
    const buttons = await ask();

    await runtime.handleUpdate(callback(buttons.get("允许一次") ?? ""));

    expect(backend.approvals).toEqual([{ requestId: REQUEST, approved: true }]);
    const edited = lastCall("editMessageText");
    expect(edited.body["message_id"]).toBe(APPROVAL_MESSAGE);
    expect(textOf(edited)).toBe(`${APPROVAL_PREFIX}${APPROVAL_ALLOWED_TEXT}`);
    expect(markupOf(edited)).toEqual([]);
    expect(String(lastCall("answerCallbackQuery").body["text"])).toBe(APPROVAL_ALLOWED_TEXT);
  });

  it("rejects and says so", async () => {
    link();
    await start();
    const buttons = await ask();

    await runtime.handleUpdate(callback(buttons.get("拒绝") ?? ""));

    expect(backend.approvals).toEqual([{ requestId: REQUEST, approved: false }]);
    expect(textOf(lastCall("editMessageText"))).toBe(`${APPROVAL_PREFIX}${APPROVAL_REJECTED_TEXT}`);
  });

  it("answers the backend once however often the button is tapped", async () => {
    link();
    await start();
    const buttons = await ask();
    const allow = buttons.get("允许一次") ?? "";

    await runtime.handleUpdate(callback(allow));
    await runtime.handleUpdate(callback(allow));
    await runtime.handleUpdate(callback(buttons.get("拒绝") ?? ""));

    expect(backend.approvals).toEqual([{ requestId: REQUEST, approved: true }]);
    // Every repeat converges on the outcome the backend already has.
    expect(textOf(lastCall("editMessageText"))).toBe(`${APPROVAL_PREFIX}${APPROVAL_ALLOWED_TEXT}`);
  });

  it("shows a request another client resolved as handled elsewhere", async () => {
    link();
    await start();
    backend.answerElsewhere();
    const buttons = await ask();

    await runtime.handleUpdate(callback(buttons.get("允许一次") ?? ""));

    expect(textOf(lastCall("editMessageText"))).toBe(`${APPROVAL_PREFIX}${APPROVAL_ELSEWHERE_TEXT}`);
    // The lost race is the outcome, not a second failure to report.
    expect(calls("sendMessage")).toHaveLength(1);
    expect(store.listDeadLetters()).toHaveLength(0);
    for (const call of calls("sendMessage")) expect(textOf(call)).not.toContain(ERROR_PREFIX);
  });

  it("never answers for a topic whose link is gone", async () => {
    link();
    await start();
    const buttons = await ask();
    store.unlink(PLATFORM, CHAT, THREAD);

    await runtime.handleUpdate(callback(buttons.get("拒绝") ?? ""));

    expect(backend.approvals).toHaveLength(0);
    expect(textOf(lastCall("editMessageText"))).toBe(`${APPROVAL_PREFIX}${APPROVAL_UNLINKED_TEXT}`);
  });

  it("retires a button from an earlier process and an unknown request", async () => {
    link();
    await start();
    await ask();

    await runtime.handleUpdate(callback(encodeCallback("epoch0", { kind: "allow", token: "1" })));
    await runtime.handleUpdate(callback(encodeCallback(EPOCH, { kind: "allow", token: "zz" })));

    expect(backend.approvals).toHaveLength(0);
    expect(textOf(lastCall("editMessageText"))).toBe(`${APPROVAL_PREFIX}${APPROVAL_EXPIRED_TEXT}`);
  });
});
