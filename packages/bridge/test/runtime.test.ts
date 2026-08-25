/**
 * Runtime seam tests.
 *
 * Everything below goes in as a normalized update and comes out as real HTTP
 * against the fake Bot API plus real rows in a temporary SQLite store. Only the
 * backend is a stand-in, and it is used through the Backend contract alone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/backends/types.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { encodeCallback, sessionSuffix } from "../src/runtime/callbacks.ts";
import {
  MENU_EXPIRED_TEXT,
  MESSAGE_DISCARDED_TEXT,
  START_TEXT,
  UNLINKED_TEXT,
} from "../src/runtime/menus.ts";
import {
  ALIAS_GONE_NOTICE,
  AMBIGUOUS_SESSION_NOTICE,
  BridgeRuntime,
  PLATFORM,
  RUNNING_NOTICE,
  SESSION_CONFLICT_NOTICE,
  SESSION_GONE_NOTICE,
  THREAD_CONFLICT_NOTICE,
  UNLINKED_NOTICE,
} from "../src/runtime/runtime.ts";
import { Store } from "../src/store/store.ts";
import { Allowlist } from "../src/telegram/allowlist.ts";
import { TelegramApi } from "../src/telegram/api.ts";
import { runUpdateLoop, type InboundCallback, type InboundMessage } from "../src/telegram/updates.ts";
import { FakeBackend } from "./fake-backend.ts";
import { startFakeTelegram, type FakeCall, type FakeTelegram } from "./fake-telegram.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";
const AUTHORISED = 149523521;
const STRANGER = 999000111;
const CHAT = 5000;
const THREAD = 31;
const MENU_MESSAGE = 900;
const EPOCH = "epoch1";
const WORK_DIR = "/private/tmp/im-bridge-work";
const NOTES_DIR = "/private/tmp/im-bridge-notes";
const ALIASES = new Map([
  ["work", WORK_DIR],
  ["notes", NOTES_DIR],
]);

interface Button {
  readonly text: string;
  readonly callback_data: string;
}

let dir: string;
let store: Store;
let backend: FakeBackend;
let server: FakeTelegram;
let runtime: BridgeRuntime;
let updateId = 100;

function silentLogger(): Logger {
  return createLogger({ level: "debug", write: () => {} });
}

async function start(sessions: readonly Session[] = []): Promise<void> {
  backend = new FakeBackend(sessions);
  server = await startFakeTelegram((call) => {
    if (call.method === "answerCallbackQuery") return { json: { ok: true, result: true } };
    return { json: { ok: true, result: { message_id: MENU_MESSAGE } } };
  });
  runtime = new BridgeRuntime({
    api: new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl }),
    backend,
    store,
    allowlist: new Allowlist([AUTHORISED]),
    cwdAliases: ALIASES,
    logger: silentLogger(),
    epoch: EPOCH,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-bridge-runtime-"));
  store = new Store(join(dir, "bridge.db"));
  updateId = 100;
});

afterEach(async () => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  await server.close();
});

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

function callback(data: string, fields: Partial<InboundCallback> = {}): InboundCallback {
  updateId += 1;
  return {
    kind: "callback",
    updateId,
    thread: { chatId: CHAT, threadId: THREAD },
    userId: AUTHORISED,
    callbackId: `cb-${updateId}`,
    data,
    messageId: MENU_MESSAGE,
    ...fields,
  };
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

/** The menu the user is looking at: the last message sent or edited. */
function shownMenu(): FakeCall {
  const call = server.calls
    .filter((entry) => entry.method === "sendMessage" || entry.method === "editMessageText")
    .at(-1);
  if (call === undefined) throw new Error("no menu was shown");
  return call;
}

function buttonData(label: string): string {
  const button = markupOf(shownMenu())
    .flat()
    .find((entry) => entry.text === label);
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  return button.callback_data;
}

function labels(): string[] {
  return markupOf(shownMenu())
    .flat()
    .map((button) => button.text);
}

/** Taps a button by its label, exactly as Telegram would send it back. */
async function tap(label: string): Promise<void> {
  await runtime.handleUpdate(callback(buttonData(label)));
}

function linkedSessionId(): string | undefined {
  return store.findByThread(PLATFORM, CHAT, THREAD)?.sessionId;
}

function session(sessionId: string, extra: Partial<Session> = {}): Session {
  return { sessionId, running: false, cwd: WORK_DIR, ...extra };
}

describe("commands", () => {
  it("explains the private topic entry point on /start", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "/start" }));
    const sent = lastCall("sendMessage");
    expect(textOf(sent)).toBe(START_TEXT);
    expect(textOf(sent)).toContain("私聊 topic");
    expect(sent.body["reply_markup"]).toBeUndefined();
  });

  it("corrects an unknown command and offers the management action", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "/deploy now" }));
    expect(textOf(lastCall("sendMessage"))).toContain("无法识别的命令");
    expect(labels()).toEqual(["管理"]);
  });

  it("stays silent for a user outside the allowlist", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "/manage", userId: STRANGER }));
    await runtime.handleUpdate(callback(encodeCallback(EPOCH, { kind: "new" }), { userId: STRANGER }));
    expect(server.calls).toHaveLength(0);
  });

  it("discards the body of a message in an unlinked topic and opens the menu", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "rm -rf /" }));
    const sent = lastCall("sendMessage");
    expect(textOf(sent)).toBe(MESSAGE_DISCARDED_TEXT);
    expect(textOf(sent)).not.toContain("rm -rf");
    expect(labels()).toEqual(["新建 session", "绑定已有 session", "关闭"]);
    expect(backend.prompts).toHaveLength(0);
  });

  it("turns text in a linked topic into a prompt and answers nothing", async () => {
    await start([session("01j8z4qk9m7f3b2n6x5c4v-0001")]);
    store.link({ platform: PLATFORM, chatId: CHAT, threadId: THREAD, backend: "dsh", sessionId: "01j8z4qk9m7f3b2n6x5c4v-0001" });
    await runtime.handleUpdate(message({ text: "写个测试" }));
    expect(backend.prompts).toEqual([
      { kind: "prompt", sessionId: "01j8z4qk9m7f3b2n6x5c4v-0001", content: [{ type: "text", text: "写个测试" }] },
    ]);
    // A normal turn adds no start message; the draft is the feedback.
    expect(server.calls).toHaveLength(0);
  });
});

describe("/manage menu states", () => {
  it("shows the unlinked menu", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "/manage" }));
    expect(textOf(lastCall("sendMessage"))).toBe(UNLINKED_TEXT);
    expect(labels()).toEqual(["新建 session", "绑定已有 session", "关闭"]);
  });

  it("shows the linked menu with the session state", async () => {
    await start([session("01j8z4qk9m7f3b2n6x5c4v-0001", { running: true, title: "重构 store" })]);
    store.link({ platform: PLATFORM, chatId: CHAT, threadId: THREAD, backend: "dsh", sessionId: "01j8z4qk9m7f3b2n6x5c4v-0001" });
    await runtime.handleUpdate(message({ text: "/manage" }));
    expect(textOf(lastCall("sendMessage"))).toContain("重构 store");
    expect(textOf(lastCall("sendMessage"))).toContain("运行中");
    expect(labels()).toEqual(["解除绑定", "关闭"]);
  });

  it("shows a link whose session the backend lost as invalid, and keeps it", async () => {
    await start([session("01j8z4qk9m7f3b2n6x5c4v-0001")]);
    store.link({ platform: PLATFORM, chatId: CHAT, threadId: THREAD, backend: "dsh", sessionId: "01j8z4qk9m7f3b2n6x5c4v-0001" });
    backend.remove("01j8z4qk9m7f3b2n6x5c4v-0001");
    await runtime.handleUpdate(message({ text: "/manage" }));
    expect(textOf(lastCall("sendMessage"))).toContain("已不存在");
    expect(labels()).toEqual(["解除绑定", "重新检查", "关闭"]);
    expect(linkedSessionId()).toBe("01j8z4qk9m7f3b2n6x5c4v-0001");
  });
});

describe("binding an existing session", () => {
  const many = Array.from({ length: 20 }, (_unused, index) =>
    session(`01j8z4qk9m7f3b2n6x5c4v-${String(index).padStart(4, "0")}`),
  );

  it("pages unlinked sessions eight at a time and hides real paths", async () => {
    await start(many);
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("绑定已有 session");
    expect(textOf(lastCall("editMessageText"))).toContain("第 1/3 页");
    expect(labels().filter((label) => label.startsWith("work "))).toHaveLength(8);
    expect(JSON.stringify(shownMenu().body)).not.toContain(WORK_DIR);

    await tap("下一页");
    expect(textOf(lastCall("editMessageText"))).toContain("第 2/3 页");
    expect(labels()).toContain(`work ${sessionSuffix(many[8]!.sessionId)}`);
  });

  it("edits the original menu into the linked state and persists the link", async () => {
    await start(many.slice(0, 2));
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("绑定已有 session");
    await tap(`work ${sessionSuffix(many[1]!.sessionId)}`);
    const edit = lastCall("editMessageText");
    expect(edit.body["message_id"]).toBe(MENU_MESSAGE);
    expect(textOf(edit)).toContain("已绑定 session");
    expect(linkedSessionId()).toBe(many[1]!.sessionId);
    expect(calls("sendMessage")).toHaveLength(1);
  });

  it("is idempotent when the same button is tapped twice", async () => {
    await start(many.slice(0, 2));
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("绑定已有 session");
    const data = buttonData(`work ${sessionSuffix(many[0]!.sessionId)}`);
    await runtime.handleUpdate(callback(data));
    await runtime.handleUpdate(callback(data));
    expect(store.list()).toHaveLength(1);
    expect(textOf(lastCall("editMessageText"))).toContain("已绑定 session");
    expect(lastCall("answerCallbackQuery").body["text"]).toBeUndefined();
  });

  it("keeps both links when the session already belongs to another topic", async () => {
    await start(many.slice(0, 1));
    const taken = many[0]!.sessionId;
    store.link({ platform: PLATFORM, chatId: CHAT, threadId: 32, backend: "dsh", sessionId: taken });
    await runtime.handleUpdate(callback(encodeCallback(EPOCH, { kind: "bind", sessionSuffix: sessionSuffix(taken) })));
    expect(lastCall("answerCallbackQuery").body["text"]).toBe(SESSION_CONFLICT_NOTICE);
    expect(store.findByThread(PLATFORM, CHAT, 32)?.sessionId).toBe(taken);
    expect(linkedSessionId()).toBeUndefined();
  });

  it("requires an explicit unlink before switching session", async () => {
    await start(many.slice(0, 2));
    store.link({ platform: PLATFORM, chatId: CHAT, threadId: THREAD, backend: "dsh", sessionId: many[0]!.sessionId });
    const other = sessionSuffix(many[1]!.sessionId);
    await runtime.handleUpdate(callback(encodeCallback(EPOCH, { kind: "bind", sessionSuffix: other })));
    expect(lastCall("answerCallbackQuery").body["text"]).toBe(THREAD_CONFLICT_NOTICE);
    expect(linkedSessionId()).toBe(many[0]!.sessionId);
  });

  it("reports a session that disappeared between drawing and tapping", async () => {
    await start(many.slice(0, 2));
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("绑定已有 session");
    const data = buttonData(`work ${sessionSuffix(many[0]!.sessionId)}`);
    backend.remove(many[0]!.sessionId);
    await runtime.handleUpdate(callback(data));
    expect(lastCall("answerCallbackQuery").body["text"]).toBe(SESSION_GONE_NOTICE);
    expect(linkedSessionId()).toBeUndefined();
  });

  it("refuses an id tail that two sessions share", async () => {
    await start([session("aaaa-1234abcd"), session("bbbb-1234abcd")]);
    await runtime.handleUpdate(callback(encodeCallback(EPOCH, { kind: "bind", sessionSuffix: "1234abcd" })));
    expect(lastCall("answerCallbackQuery").body["text"]).toBe(AMBIGUOUS_SESSION_NOTICE);
    expect(store.list()).toHaveLength(0);
  });

  it("never offers a session another topic already holds", async () => {
    await start(many.slice(0, 3));
    store.link({ platform: PLATFORM, chatId: CHAT, threadId: 32, backend: "dsh", sessionId: many[0]!.sessionId });
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("绑定已有 session");
    expect(labels()).not.toContain(`work ${sessionSuffix(many[0]!.sessionId)}`);
    expect(labels()).toContain(`work ${sessionSuffix(many[1]!.sessionId)}`);
  });
});

describe("creating a session", () => {
  it("offers only the configured aliases and creates before linking", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("新建 session");
    expect(labels()).toEqual(["work", "notes", "返回", "关闭"]);

    await tap("work");
    expect(backend.created).toEqual([{ cwd: WORK_DIR, sessionId: backend.created[0]?.sessionId }]);
    expect(linkedSessionId()).toBe(backend.created[0]?.sessionId);
    const edit = lastCall("editMessageText");
    expect(edit.body["message_id"]).toBe(MENU_MESSAGE);
    expect(textOf(edit)).toContain("已绑定 session");
  });

  it("does not create a second session when the button is tapped twice", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("新建 session");
    const data = buttonData("work");
    await runtime.handleUpdate(callback(data));
    await runtime.handleUpdate(callback(data));
    expect(backend.created).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  it("rejects an alias the configuration no longer names", async () => {
    await start();
    await runtime.handleUpdate(callback(encodeCallback(EPOCH, { kind: "create", alias: "removed" })));
    expect(lastCall("answerCallbackQuery").body["text"]).toBe(ALIAS_GONE_NOTICE);
    expect(backend.created).toHaveLength(0);
  });
});

describe("unlinking", () => {
  const linked = session("01j8z4qk9m7f3b2n6x5c4v-0001");

  function link(): void {
    store.link({ platform: PLATFORM, chatId: CHAT, threadId: THREAD, backend: "dsh", sessionId: linked.sessionId });
  }

  it("removes the link and leaves the backend session alone", async () => {
    await start([linked]);
    link();
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("解除绑定");
    expect(lastCall("answerCallbackQuery").body["text"]).toBe(UNLINKED_NOTICE);
    expect(linkedSessionId()).toBeUndefined();
    expect(backend.has(linked.sessionId)).toBe(true);
    expect(textOf(lastCall("editMessageText"))).toBe(UNLINKED_TEXT);
  });

  it("refuses while the session is running", async () => {
    await start([linked]);
    link();
    backend.setRunning(linked.sessionId, true);
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("解除绑定");
    expect(lastCall("answerCallbackQuery").body["text"]).toBe(RUNNING_NOTICE);
    expect(linkedSessionId()).toBe(linked.sessionId);
    expect(textOf(lastCall("editMessageText"))).toContain("运行中");
  });

  it("repairs an invalid link on request, without deleting anything by itself", async () => {
    await start([linked]);
    link();
    backend.remove(linked.sessionId);
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("重新检查");
    expect(textOf(lastCall("editMessageText"))).toContain("已不存在");
    expect(linkedSessionId()).toBe(linked.sessionId);

    await tap("解除绑定");
    expect(linkedSessionId()).toBeUndefined();
    expect(textOf(lastCall("editMessageText"))).toBe(UNLINKED_TEXT);
  });

  it("answers a second unlink with the unlinked menu", async () => {
    await start([linked]);
    link();
    await runtime.handleUpdate(message({ text: "/manage" }));
    const data = buttonData("解除绑定");
    await runtime.handleUpdate(callback(data));
    await runtime.handleUpdate(callback(data));
    expect(textOf(lastCall("editMessageText"))).toBe(UNLINKED_TEXT);
    expect(store.list()).toHaveLength(0);
  });
});

describe("callback hygiene", () => {
  it("expires a button drawn by an earlier process", async () => {
    await start();
    store.link({ platform: PLATFORM, chatId: CHAT, threadId: THREAD, backend: "dsh", sessionId: "kept-0001" });
    await runtime.handleUpdate(callback(encodeCallback("older", { kind: "unlink" })));
    const edit = lastCall("editMessageText");
    expect(textOf(edit)).toBe(MENU_EXPIRED_TEXT);
    expect(edit.body["reply_markup"]).toEqual({ inline_keyboard: [] });
    expect(linkedSessionId()).toBe("kept-0001");
    expect(backend.listCalls).toBe(0);
  });

  it("expires callback data it never wrote", async () => {
    await start();
    await runtime.handleUpdate(callback("not-callback-data"));
    expect(textOf(lastCall("editMessageText"))).toBe(MENU_EXPIRED_TEXT);
  });

  it("removes the keyboard on close", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("关闭");
    const edit = lastCall("editMessageReplyMarkup");
    expect(edit.body["message_id"]).toBe(MENU_MESSAGE);
    expect(edit.body["reply_markup"]).toBeUndefined();
    expect(calls("answerCallbackQuery")).toHaveLength(1);
  });

  it("ignores an update that names no topic", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "/manage", thread: { chatId: CHAT, threadId: 0 } }));
    expect(server.calls).toHaveLength(0);
  });

  it("answers every callback so the button stops spinning", async () => {
    await start();
    await runtime.handleUpdate(message({ text: "/manage" }));
    await tap("新建 session");
    await tap("返回");
    expect(calls("answerCallbackQuery")).toHaveLength(2);
  });
});

describe("polling loop", () => {
  it("drives the runtime from a real getUpdates response", async () => {
    backend = new FakeBackend();
    server = await startFakeTelegram((call) => {
      if (call.method === "getUpdates") {
        return call.count === 1
          ? {
              json: {
                ok: true,
                result: [
                  {
                    update_id: 7,
                    message: {
                      message_id: 3,
                      from: { id: AUTHORISED, is_bot: false },
                      chat: { id: CHAT, type: "private" },
                      message_thread_id: THREAD,
                      text: "/manage",
                    },
                  },
                ],
              },
            }
          : { hang: true };
      }
      return { json: { ok: true, result: { message_id: MENU_MESSAGE } } };
    });
    const api = new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl });
    runtime = new BridgeRuntime({
      api,
      backend,
      store,
      allowlist: new Allowlist([AUTHORISED]),
      cwdAliases: ALIASES,
      logger: silentLogger(),
      epoch: EPOCH,
    });
    const controller = new AbortController();
    const loop = runUpdateLoop({
      api,
      allowlist: new Allowlist([AUTHORISED]),
      checkpoint: store,
      logger: silentLogger(),
      signal: controller.signal,
      onUpdate: (update) => runtime.handleUpdate(update),
    });
    for (let attempt = 0; attempt < 300 && calls("sendMessage").length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await loop;
    const sent = lastCall("sendMessage");
    expect(sent.body["message_thread_id"]).toBe(THREAD);
    expect(textOf(sent)).toBe(UNLINKED_TEXT);
  });
});
