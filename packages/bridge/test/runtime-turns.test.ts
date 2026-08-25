/**
 * Turn seam tests.
 *
 * A turn is driven from both ends at once: normalized Telegram updates go in
 * through the runtime, backend events go in through the Backend contract, and
 * everything is asserted on the real HTTP requests the fake Bot API captured.
 * The one-second draft cadence runs on fake timers, so no test waits.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendEvent, Session } from "../src/backends/types.ts";
import { createLogger, type Logger } from "../src/log.ts";
import {
  BridgeRuntime,
  ERROR_PREFIX,
  PLATFORM,
  STEER_ACK_TEXT,
  WARNING_PREFIX,
  partialResultText,
} from "../src/runtime/runtime.ts";
import { Store } from "../src/store/store.ts";
import { Allowlist } from "../src/telegram/allowlist.ts";
import { TelegramApi } from "../src/telegram/api.ts";
import { charLength, OMITTED_OUTPUT_TEXT } from "../src/telegram/markdown.ts";
import type { InboundMessage } from "../src/telegram/updates.ts";
import { FakeBackend } from "./fake-backend.ts";
import { startFakeTelegram, type FakeCall, type FakeReply, type FakeTelegram } from "./fake-telegram.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";
const AUTHORISED = 149523521;
const CHAT = 5000;
const THREAD = 31;
const SESSION = "01j8z4qk9m7f3b2n6x5c4v-0001";
const OTHER_SESSION = "01j8z4qk9m7f3b2n6x5c4v-0002";
const WORK_DIR = "/private/tmp/im-bridge-work";
const ALIASES = new Map([["work", WORK_DIR]]);
/** Telegram's ceiling is 32768; the bridge splits at this conservative budget. */
const FINAL_BUDGET = 32_000;

interface Block {
  readonly type: string;
  readonly text: string;
  readonly language?: string;
}

/** Captured before any test fakes the clock, so `tick` can wait for real I/O. */
const realSetTimeout = globalThis.setTimeout;

let dir: string;
let store: Store;
let backend: FakeBackend;
let server: FakeTelegram;
let runtime: BridgeRuntime;
let reply: (call: FakeCall) => FakeReply;
let updateId = 500;

function silentLogger(): Logger {
  return createLogger({ level: "debug", write: () => {} });
}

function okReply(call: FakeCall): FakeReply {
  if (call.method === "sendMessage" || call.method === "sendRichMessage") {
    return { json: { ok: true, result: { message_id: 7000 + call.count } } };
  }
  return { json: { ok: true, result: true } };
}

function session(sessionId: string, extra: Partial<Session> = {}): Session {
  return { sessionId, running: false, cwd: WORK_DIR, ...extra };
}

function linkSession(sessionId: string = SESSION): void {
  store.link({ platform: PLATFORM, chatId: CHAT, threadId: THREAD, backend: "dsh", sessionId });
}

async function start(sessions: readonly Session[] = [session(SESSION)]): Promise<void> {
  backend = new FakeBackend(sessions);
  server = await startFakeTelegram((call) => reply(call));
  runtime = new BridgeRuntime({
    api: new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl }),
    backend,
    store,
    allowlist: new Allowlist([AUTHORISED]),
    cwdAliases: ALIASES,
    logger: silentLogger(),
    epoch: "epoch1",
  });
  await runtime.start();
  vi.useFakeTimers();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-bridge-turns-"));
  store = new Store(join(dir, "bridge.db"));
  reply = okReply;
  updateId = 500;
});

afterEach(async () => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  await server.close();
});

/**
 * Moves the fake clock, then lets the real event loop deliver the HTTP calls
 * those timers started. The clock is fake; the Bot API server is not.
 */
async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await turns(10);
}

/** Real event-loop turns, so a request started under a fake clock can land. */
async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 1);
    });
  }
}

/**
 * The calls of one method once the ones this step expects have arrived. A
 * request the throttle started is in flight on a real socket, so waiting for
 * it beats guessing how many event-loop turns a busy machine needs.
 */
async function settled(method: string, expected: number): Promise<FakeCall[]> {
  for (let attempt = 0; attempt < 200 && calls(method).length < expected; attempt += 1) {
    await turns(1);
  }
  return calls(method);
}

/** The newest call of a method, once `expected` of them have arrived. */
async function settledLast(method: string, expected: number): Promise<FakeCall> {
  const call = (await settled(method, expected)).at(-1);
  if (call === undefined) throw new Error(`no ${method} call`);
  return call;
}

function text(body: string): InboundMessage {
  updateId += 1;
  return {
    kind: "message",
    updateId,
    thread: { chatId: CHAT, threadId: THREAD },
    userId: AUTHORISED,
    messageId: updateId,
    text: body,
  };
}

function output(body: string, sessionId: string = SESSION): BackendEvent {
  return { type: "output", sessionId, text: body };
}

function thinking(body: string, sessionId: string = SESSION): BackendEvent {
  return { type: "thinking", sessionId, text: body };
}

function turnEnd(body: string, sessionId: string = SESSION): BackendEvent {
  return { type: "turn-end", sessionId, text: body };
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

function blocksOf(call: FakeCall): Block[] {
  const rich = call.body["rich_message"];
  const blocks = typeof rich === "object" && rich !== null ? (rich as { blocks?: unknown }).blocks : undefined;
  return Array.isArray(blocks) ? (blocks as Block[]) : [];
}

function markdownOf(call: FakeCall): string {
  const rich = call.body["rich_message"];
  const markdown = typeof rich === "object" && rich !== null ? (rich as { markdown?: unknown }).markdown : undefined;
  return typeof markdown === "string" ? markdown : "";
}

/** Every part of a split result, still labelled. */
function resultParts(): string[] {
  return calls("sendRichMessage").map(markdownOf);
}

/** Telegram receives one string; a half surrogate pair is a corrupted one. */
function hasBrokenSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("prompt and steer", () => {
  it("steers a session the backend already reported as running at startup", async () => {
    linkSession();
    await start([session(SESSION, { running: true })]);

    await runtime.handleUpdate(text("先别改 store"));

    expect(backend.prompts).toEqual([
      { kind: "steer", sessionId: SESSION, content: [{ type: "text", text: "先别改 store" }] },
    ]);
    expect(calls("sendMessage")).toHaveLength(1);
    expect(textOf(lastCall("sendMessage"))).toBe(STEER_ACK_TEXT);
  });

  it("starts an idle turn silently, then steers the next message once", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(text("写个测试"));
    expect(calls("sendMessage")).toHaveLength(0);

    await runtime.handleUpdate(text("改用 vitest"));

    expect(backend.prompts.map((entry) => entry.kind)).toEqual(["prompt", "steer"]);
    expect(calls("sendMessage")).toHaveLength(1);
    expect(textOf(lastCall("sendMessage"))).toBe(STEER_ACK_TEXT);
  });

  it("renders a turn dsh Web UI started, and steers it from Telegram", async () => {
    linkSession();
    await start();

    await backend.emit(output("从 Web UI 开始的回合"));
    await tick();
    expect(await settled("sendRichMessageDraft", 1)).toHaveLength(1);

    await runtime.handleUpdate(text("停一下"));
    expect(backend.prompts.map((entry) => entry.kind)).toEqual(["steer"]);
  });

  it("goes back to starting turns after the backend reports the turn ended", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(text("第一轮"));
    await backend.emit(turnEnd("完成"));
    await runtime.handleUpdate(text("第二轮"));

    expect(backend.prompts.map((entry) => entry.kind)).toEqual(["prompt", "prompt"]);
  });
});

describe("event routing", () => {
  it("logs and drops every event kind from a session no topic holds", async () => {
    await start([session(OTHER_SESSION)]);

    await backend.emit(output("输出", OTHER_SESSION));
    await backend.emit(thinking("推理", OTHER_SESSION));
    await backend.emit({ type: "warning", sessionId: OTHER_SESSION, message: "降级" });
    await backend.emit({ type: "error", sessionId: OTHER_SESSION, message: "失败" });
    await backend.emit(turnEnd("结果", OTHER_SESSION));
    await tick(5_000);

    expect(server.calls).toHaveLength(0);
  });

  it("stops the draft and drops the result when the link disappears mid-turn", async () => {
    linkSession();
    await start();

    await backend.emit(output("第一段"));
    await tick();
    expect(await settled("sendRichMessageDraft", 1)).toHaveLength(1);

    store.unlink(PLATFORM, CHAT, THREAD);
    await backend.emit(output("第二段"));
    await backend.emit(turnEnd("完整结果"));
    await tick(5_000);

    expect(calls("sendRichMessageDraft")).toHaveLength(1);
    expect(calls("sendRichMessage")).toHaveLength(0);
  });

  it("asks the linked topic to decide an approval", async () => {
    linkSession();
    await start();

    await backend.emit({ type: "approval", sessionId: SESSION, requestId: "req-1", prompt: "run rm" });
    await tick(5_000);

    const asked = lastCall("sendMessage");
    expect(asked.body["message_thread_id"]).toBe(THREAD);
    expect(textOf(asked)).toContain("run rm");
    expect(backend.approvals).toHaveLength(0);
  });
});

describe("streaming draft", () => {
  it("creates a draft for the private topic on the first thinking delta", async () => {
    linkSession();
    await start();

    await backend.emit(thinking("先读 store"));
    await tick();

    const draft = await settledLast("sendRichMessageDraft", 1);
    expect(draft.body["chat_id"]).toBe(CHAT);
    expect(draft.body["message_thread_id"]).toBe(THREAD);
    expect(draft.body["draft_id"]).toBe(1);
    expect(blocksOf(draft)).toEqual([{ type: "thinking", text: "先读 store" }]);
  });

  it("keeps only the newest 2000 thinking characters", async () => {
    linkSession();
    await start();

    await backend.emit(thinking("甲".repeat(1_500)));
    await tick();
    await backend.emit(thinking("乙".repeat(1_000)));
    await tick(1_000);

    const block = blocksOf(await settledLast("sendRichMessageDraft", 2))[0];
    expect(block?.type).toBe("thinking");
    expect(charLength(block?.text ?? "")).toBe(2_000);
    expect(block?.text.startsWith("甲")).toBe(true);
    expect(block?.text.endsWith("乙")).toBe(true);
  });

  it("parses output into blocks and keeps the code language", async () => {
    linkSession();
    await start();

    await backend.emit(output("先看代码：\n\n```python\nprint(1)\n```\n"));
    await tick();

    expect(blocksOf(await settledLast("sendRichMessageDraft", 1))).toEqual([
      { type: "paragraph", text: "先看代码：" },
      { type: "pre", text: "print(1)", language: "python" },
    ]);
  });

  it("sends at most one draft per second however fast deltas arrive", async () => {
    linkSession();
    await start();

    for (const part of ["一", "二", "三", "四", "五"]) await backend.emit(output(part));
    await tick();
    expect(await settled("sendRichMessageDraft", 1)).toHaveLength(1);
    expect(blocksOf(lastCall("sendRichMessageDraft"))).toEqual([{ type: "paragraph", text: "一二三四五" }]);

    await backend.emit(output("六"));
    await tick(999);
    expect(calls("sendRichMessageDraft")).toHaveLength(1);
    await tick(1);
    expect(await settled("sendRichMessageDraft", 2)).toHaveLength(2);
    expect(blocksOf(lastCall("sendRichMessageDraft"))).toEqual([{ type: "paragraph", text: "一二三四五六" }]);
  });

  it("waits out retry_after before replacing the draft again", async () => {
    linkSession();
    await start();
    reply = (call) =>
      call.method === "sendRichMessageDraft" && call.count === 1
        ? {
            status: 429,
            json: {
              ok: false,
              error_code: 429,
              description: "Too Many Requests: retry after 5",
              parameters: { retry_after: 5 },
            },
          }
        : okReply(call);

    await backend.emit(output("一"));
    await tick();
    expect(await settled("sendRichMessageDraft", 1)).toHaveLength(1);

    await backend.emit(output("二"));
    await tick(4_000);
    expect(calls("sendRichMessageDraft")).toHaveLength(1);

    await tick(1_500);
    expect(await settled("sendRichMessageDraft", 2)).toHaveLength(2);
  });

  it("marks omitted output and stays inside the draft budget", async () => {
    linkSession();
    await start();

    await backend.emit(output("头".repeat(1_000) + "尾".repeat(30_000)));
    await tick();

    const blocks = blocksOf(await settledLast("sendRichMessageDraft", 1));
    expect(blocks[0]).toEqual({ type: "paragraph", text: OMITTED_OUTPUT_TEXT });
    const total = blocks.reduce((sum, block) => sum + charLength(block.text), 0);
    expect(total).toBeLessThanOrEqual(30_000);
    expect(blocks.at(-1)?.text.endsWith("尾")).toBe(true);
  });
});

describe("final result", () => {
  it("persists turn-end text as Markdown and never the thinking", async () => {
    linkSession();
    await start();

    await backend.emit(thinking("要先读 store"));
    await backend.emit(output("正在写"));
    await tick();
    await settled("sendRichMessageDraft", 1);
    await backend.emit(turnEnd("# 结果\n\n```ts\nconst a = 1;\n```\n"));

    expect(calls("sendRichMessage")).toHaveLength(1);
    const sent = lastCall("sendRichMessage");
    expect(sent.body["message_thread_id"]).toBe(THREAD);
    expect(markdownOf(sent)).toContain("```ts");
    expect(markdownOf(sent)).not.toContain("要先读 store");
    expect(markdownOf(sent)).not.toMatch(/\[\d+\/\d+\]/u);

    // The draft stops once the result is in history.
    const drafts = calls("sendRichMessageDraft").length;
    await tick(5_000);
    expect(calls("sendRichMessageDraft")).toHaveLength(drafts);
  });

  it("takes the complete result from turn-end after the preview lost deltas", async () => {
    linkSession();
    await start();

    await backend.emit(output("开头"));
    await tick();
    await settled("sendRichMessageDraft", 1);
    await backend.emit(turnEnd("开头，中间，结尾。完整结果只来自 turn-end。"));

    expect(markdownOf(lastCall("sendRichMessage"))).toBe("开头，中间，结尾。完整结果只来自 turn-end。");
  });

  it("splits a long result at block boundaries and labels every part", async () => {
    linkSession();
    await start();
    const document = longDocument();
    expect(charLength(document)).toBeGreaterThan(FINAL_BUDGET);

    await backend.emit(turnEnd(document));

    const parts = resultParts();
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((part, index) => {
      expect(part.startsWith(`[${index + 1}/${parts.length}]\n\n`)).toBe(true);
      expect(charLength(part)).toBeLessThanOrEqual(FINAL_BUDGET);
      expect(hasBrokenSurrogate(part)).toBe(false);
    });
    // Blocks stay whole: the table, the list, and the emoji paragraph each
    // land in exactly one part.
    for (const block of [TABLE, LIST, EMOJI_PARAGRAPH, BACKTICK_PARAGRAPH]) {
      expect(parts.filter((part) => part.includes(block))).toHaveLength(1);
    }
  });

  it("splits an oversized code block by line and refences every part", async () => {
    linkSession();
    await start();
    const lines = Array.from({ length: 3_000 }, (_unused, index) => `print(${index})  # ${"注释".repeat(4)}`);
    await backend.emit(turnEnd(`说明：\n\n\`\`\`python\n${lines.join("\n")}\n\`\`\`\n`));

    const parts = resultParts();
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(charLength(part)).toBeLessThanOrEqual(FINAL_BUDGET);
      const fences = part.match(/^`{3,}/gmu) ?? [];
      expect(fences.length % 2).toBe(0);
      if (fences.length > 0) expect(part).toContain("```python\n");
    }
    // Every line survives exactly once.
    expect(parts.filter((part) => part.includes("print(0)  #"))).toHaveLength(1);
    expect(parts.filter((part) => part.includes("print(2999)  #"))).toHaveLength(1);
  });

  it("stops after a failed part and reports how many were sent", async () => {
    linkSession();
    await start();
    reply = (call) =>
      call.method === "sendRichMessage" && call.count === 2
        ? { status: 500, json: { ok: false, error_code: 500, description: "Internal Server Error" } }
        : okReply(call);

    await backend.emit(turnEnd(longDocument()));

    const attempts = calls("sendRichMessage");
    expect(attempts).toHaveLength(2);
    const total = Number(/\d+\/(\d+)/u.exec(textOf(lastCall("sendMessage")))?.[1]);
    expect(total).toBeGreaterThan(2);
    expect(textOf(lastCall("sendMessage"))).toBe(partialResultText(1, total));
    // Nothing is resent, and the backend turn is never run again.
    expect(backend.prompts).toHaveLength(0);
  });
});

describe("status messages", () => {
  it("reports a warning and a terminal error, and frees the session", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(text("跑一下"));
    await backend.emit({ type: "warning", sessionId: SESSION, message: "输出被截断" });
    expect(textOf(lastCall("sendMessage"))).toBe(`${WARNING_PREFIX}输出被截断`);

    await backend.emit({ type: "error", sessionId: SESSION, message: "backend 连接断开" });
    expect(textOf(lastCall("sendMessage"))).toBe(`${ERROR_PREFIX}backend 连接断开`);

    await runtime.handleUpdate(text("再试一次"));
    expect(backend.prompts.map((entry) => entry.kind)).toEqual(["prompt", "prompt"]);
  });
});

const TABLE = "| 名称 | 说明 |\n|---|---|\n| link | thread 与 session 的映射 |\n| turn | 一次完整往返 |";
const LIST = "- 列表一 **加粗**\n- 列表二 *斜体*\n  - 嵌套的 `内联代码`";
const EMOJI_PARAGRAPH = "表情与代理对：🙂🚀👩‍💻 𝕏𝔸𝕊，后面还有中文。";
const BACKTICK_PARAGRAPH = "反引号段落： `` 里面有 ` 一个 `` 结束。";

/** A result whose blocks cover the shapes the splitter has to keep whole. */
function longDocument(): string {
  const sections = [
    "# 报告",
    "普通段落，含 **加粗**、*斜体* 与 `内联代码`。",
    LIST,
    TABLE,
    EMOJI_PARAGRAPH,
    BACKTICK_PARAGRAPH,
    "```ts\nconst a = 1;\n```",
  ];
  for (let index = 0; index < 100; index += 1) {
    sections.push(`第 ${index} 段。${"填充内容，用来把结果撑过分片上限。".repeat(60)}`);
  }
  return sections.join("\n\n");
}
