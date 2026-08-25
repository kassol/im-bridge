/**
 * Image and album seam tests.
 *
 * Everything goes in as a normalized Telegram update and comes out as either a
 * real HTTP request the fake Bot API captured or a prompt the fake Backend
 * received. Image bytes travel the real path: `getFile`, then a streamed
 * download from the fake file endpoint, then base64 in the prompt content.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptContent, Session } from "../src/backends/types.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { AlbumCollector, type AlbumGroup } from "../src/runtime/albums.ts";
import {
  IMAGE_ANALYSIS_TEXT,
  IMAGE_LIMIT_BYTES,
  MAX_PROMPT_IMAGES,
  mediaNotice,
} from "../src/runtime/media.ts";
import { BridgeRuntime, PLATFORM, STEER_ACK_TEXT } from "../src/runtime/runtime.ts";
import { MemorySemaphore } from "../src/runtime/semaphore.ts";
import { Store } from "../src/store/store.ts";
import { Allowlist } from "../src/telegram/allowlist.ts";
import { TelegramApi } from "../src/telegram/api.ts";
import type { InboundDocument, InboundMessage, InboundPhotoSize } from "../src/telegram/updates.ts";
import { FakeBackend } from "./fake-backend.ts";
import { startFakeTelegram, type FakeCall, type FakeReply, type FakeTelegram } from "./fake-telegram.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";
const AUTHORISED = 149523521;
const CHAT = 5000;
const THREAD = 31;
const SESSION = "01j8z4qk9m7f3b2n6x5c4v-0001";
const WORK_DIR = "/private/tmp/im-bridge-work";
const ALIASES = new Map([["work", WORK_DIR]]);
const MIB = 1024 * 1024;

/** Small enough to compare byte for byte; the format is never parsed here. */
const IMAGE_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04]);
const IMAGE_BASE64 = Buffer.from(IMAGE_BYTES).toString("base64");

/** Captured before any test fakes the clock, so `turns` can wait for real I/O. */
const realSetTimeout = globalThis.setTimeout;

let dir: string;
let store: Store;
let backend: FakeBackend;
let server: FakeTelegram | undefined;
let runtime: BridgeRuntime;
let reply: (call: FakeCall) => FakeReply | Promise<FakeReply>;
let logLines: string[];
let updateId = 800;
let messageId = 900;

/** The fake Bot API of the running test. Unit-only tests never start one. */
function fake(): FakeTelegram {
  if (server === undefined) throw new Error("fake Telegram is not started");
  return server;
}

function silentLogger(): Logger {
  return createLogger({ level: "debug", write: (line) => void logLines.push(line) });
}

/** The file id a download was resolved from, recovered from its URL. */
function fileIdOf(call: FakeCall): string {
  return decodeURIComponent(call.path.slice(call.path.lastIndexOf("/") + 1)).replace(/\.bin$/u, "");
}

function isDownload(call: FakeCall): boolean {
  return call.path.startsWith("/file/");
}

function okReply(call: FakeCall): FakeReply {
  if (isDownload(call)) return { bytes: IMAGE_BYTES };
  if (call.method === "getFile") {
    return { json: { ok: true, result: { file_path: `photos/${String(call.body["file_id"])}.bin` } } };
  }
  if (call.method === "sendMessage" || call.method === "sendRichMessage") {
    return { json: { ok: true, result: { message_id: 7000 + call.count } } };
  }
  return { json: { ok: true, result: true } };
}

function session(sessionId: string, extra: Partial<Session> = {}): Session {
  return { sessionId, running: false, cwd: WORK_DIR, ...extra };
}

function linkSession(sessionId: string = SESSION, threadId: number = THREAD): void {
  store.link({ platform: PLATFORM, chatId: CHAT, threadId, backend: "dsh", sessionId });
}

async function start(sessions: readonly Session[] = [session(SESSION)]): Promise<void> {
  backend = new FakeBackend(sessions);
  server = await startFakeTelegram((call) => reply(call));
  runtime = new BridgeRuntime({
    api: new TelegramApi({ token: TOKEN, baseUrl: fake().baseUrl, fileBaseUrl: fake().baseUrl }),
    backend,
    store,
    allowlist: new Allowlist([AUTHORISED]),
    cwdAliases: ALIASES,
    logger: silentLogger(),
    epoch: "epoch1",
  });
  await runtime.start();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-bridge-media-"));
  store = new Store(join(dir, "bridge.db"));
  server = undefined;
  reply = okReply;
  logLines = [];
  updateId = 800;
  messageId = 900;
});

afterEach(async () => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  if (server !== undefined) await server.close();
});

/** Real event-loop turns, so a request started under a fake clock can land. */
async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 1);
    });
  }
}

/** The calls of one method once the ones this step expects have arrived. */
async function settled(match: (call: FakeCall) => boolean, expected: number): Promise<FakeCall[]> {
  for (let attempt = 0; attempt < 200 && fake().calls.filter(match).length < expected; attempt += 1) {
    await turns(1);
  }
  return fake().calls.filter(match);
}

/** Real event-loop turns until the backend received `expected` inputs. */
async function prompted(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 300 && backend.prompts.length < expected; attempt += 1) {
    await turns(1);
  }
}

function calls(method: string): FakeCall[] {
  return fake().calls.filter((call) => call.method === method);
}

function lastCall(method: string): FakeCall {
  const call = calls(method).at(-1);
  if (call === undefined) throw new Error(`no ${method} call`);
  return call;
}

function textOf(call: FakeCall): string {
  return String(call.body["text"] ?? "");
}

function variant(fileId: string, fileSize: number | undefined, width: number): InboundPhotoSize {
  return { fileId, width, height: width, ...(fileSize === undefined ? {} : { fileSize }) };
}

function message(extra: Partial<InboundMessage> = {}): InboundMessage {
  updateId += 1;
  messageId += 1;
  return {
    kind: "message",
    updateId,
    thread: { chatId: CHAT, threadId: THREAD },
    userId: AUTHORISED,
    messageId,
    ...extra,
  };
}

function photoMessage(sizes: readonly InboundPhotoSize[], extra: Partial<InboundMessage> = {}): InboundMessage {
  return message({ photo: sizes, ...extra });
}

function documentMessage(document: InboundDocument, extra: Partial<InboundMessage> = {}): InboundMessage {
  return message({ document, ...extra });
}

/** One photo of a known size, as Telegram advertises its variants. */
function onePhoto(extra: Partial<InboundMessage> = {}): InboundMessage {
  return photoMessage([variant("photo-only", 40_000, 1280)], extra);
}

function contentOf(index = 0): PromptContent {
  const entry = backend.prompts[index];
  if (entry === undefined) throw new Error(`no prompt at ${index}`);
  return entry.content;
}

describe("photo input", () => {
  it("sends the largest advertised variant at or below the 5 MiB ceiling", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(
      photoMessage(
        [
          variant("photo-small", 1_000, 90),
          variant("photo-best", 500_000, 1280),
          variant("photo-huge", 6 * MIB, 4096),
        ],
        { text: "看看这张图" },
      ),
    );

    expect(calls("getFile")).toHaveLength(1);
    expect(lastCall("getFile").body["file_id"]).toBe("photo-best");
    expect(contentOf()).toEqual([
      { type: "text", text: "看看这张图" },
      { type: "image", mediaType: "image/jpeg", data: IMAGE_BASE64 },
    ]);
    expect(backend.prompts[0]?.kind).toBe("prompt");
  });

  it("uses the fixed analysis request when an image has no caption", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(onePhoto());

    expect(contentOf()[0]).toEqual({ type: "text", text: IMAGE_ANALYSIS_TEXT });
  });

  it("rejects a photo whose every variant is larger than 5 MiB", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(photoMessage([variant("photo-huge", IMAGE_LIMIT_BYTES + 1, 4096)]));

    expect(backend.prompts).toHaveLength(0);
    expect(calls("getFile")).toHaveLength(0);
    expect(textOf(lastCall("sendMessage"))).toBe(mediaNotice("too-large"));
  });
});

describe("image documents", () => {
  it("sends an image document with its media type and filename", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(
      documentMessage({ fileId: "doc-png", mimeType: "image/png", fileName: "screen shot.png", fileSize: 2_048 }),
    );

    expect(contentOf()).toEqual([
      { type: "text", text: IMAGE_ANALYSIS_TEXT },
      { type: "image", mediaType: "image/png", data: IMAGE_BASE64, name: "screen shot.png" },
    ]);
  });

  it("drops an unsafe filename instead of failing the prompt", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(
      documentMessage({ fileId: "doc-webp", mimeType: "image/webp", fileName: "../../etc/passwd" }),
    );

    expect(contentOf()[1]).toEqual({ type: "image", mediaType: "image/webp", data: IMAGE_BASE64 });
  });

  it("rejects a document whose MIME type is not a supported image", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(
      documentMessage({ fileId: "doc-pdf", mimeType: "application/pdf", fileName: "report.pdf" }),
    );

    expect(backend.prompts).toHaveLength(0);
    expect(calls("getFile")).toHaveLength(0);
    expect(textOf(lastCall("sendMessage"))).toBe(mediaNotice("unsupported-type"));
  });

  it("rejects a document advertised over 5 MiB before downloading it", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(
      documentMessage({ fileId: "doc-big", mimeType: "image/jpeg", fileSize: IMAGE_LIMIT_BYTES + 1 }),
    );

    expect(calls("getFile")).toHaveLength(0);
    expect(textOf(lastCall("sendMessage"))).toBe(mediaNotice("too-large"));
  });
});

describe("download limits", () => {
  it("aborts a body that passes 5 MiB although no length was advertised", async () => {
    linkSession();
    await start();
    // Twenty 1 MiB chunks, chunked transfer encoding, and an advertised size
    // that lies: nothing but the running byte count can stop this download.
    const chunk = new Uint8Array(MIB);
    const chunks = Array.from({ length: 20 }, () => chunk);
    let wrote = 0;
    reply = (call) =>
      isDownload(call)
        ? { stream: { chunks, onWrote: (written) => void (wrote = written) } }
        : okReply(call);

    await runtime.handleUpdate(photoMessage([variant("photo-lying", 4_000, 1280)]));

    expect(backend.prompts).toHaveLength(0);
    expect(textOf(lastCall("sendMessage"))).toBe(mediaNotice("too-large"));
    // The client stopped reading, so the server never placed the last chunk.
    expect(wrote).toBeLessThan(chunks.length);
  });

  it("aborts an oversized body that advertises its full length", async () => {
    linkSession();
    await start();
    const chunk = new Uint8Array(MIB);
    const chunks = Array.from({ length: 20 }, () => chunk);
    let wrote = 0;
    reply = (call) =>
      isDownload(call)
        ? { stream: { chunks, contentLength: chunks.length * MIB, onWrote: (written) => void (wrote = written) } }
        : okReply(call);

    await runtime.handleUpdate(photoMessage([variant("photo-lying", 4_000, 1280)]));

    expect(backend.prompts).toHaveLength(0);
    expect(textOf(lastCall("sendMessage"))).toBe(mediaNotice("too-large"));
    // The ceiling stopped the read; the advertised length never did.
    expect(wrote).toBeLessThan(chunks.length);
  });

  it("reports a failed download once and sends nothing to the backend", async () => {
    linkSession();
    await start();
    reply = (call) =>
      isDownload(call) ? { status: 404, json: { ok: false, error_code: 404 } } : okReply(call);

    await runtime.handleUpdate(onePhoto());

    expect(backend.prompts).toHaveLength(0);
    expect(calls("sendMessage")).toHaveLength(1);
    expect(textOf(lastCall("sendMessage"))).toBe(mediaNotice("download-failed"));
  });
});

describe("albums", () => {
  /** Album members share a media group and arrive as separate updates. */
  function albumMember(fileId: string, extra: Partial<InboundMessage> = {}): InboundMessage {
    return photoMessage([variant(fileId, 30_000, 1280)], { mediaGroupId: "album-1", ...extra });
  }

  it("collects an album into one ordered prompt after the quiet window", async () => {
    linkSession();
    await start();
    vi.useFakeTimers();

    await runtime.handleUpdate(albumMember("album-a", { text: "这组图" }));
    await runtime.handleUpdate(albumMember("album-b"));
    await runtime.handleUpdate(albumMember("album-c"));
    expect(calls("getFile")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await prompted(1);

    expect(backend.prompts).toHaveLength(1);
    expect(calls("getFile").map((call) => call.body["file_id"])).toEqual(["album-a", "album-b", "album-c"]);
    expect(contentOf()).toEqual([
      { type: "text", text: "这组图" },
      { type: "image", mediaType: "image/jpeg", data: IMAGE_BASE64 },
      { type: "image", mediaType: "image/jpeg", data: IMAGE_BASE64 },
      { type: "image", mediaType: "image/jpeg", data: IMAGE_BASE64 },
    ]);
  });

  it("restarts the quiet window while members keep arriving", async () => {
    linkSession();
    await start();
    vi.useFakeTimers();

    await runtime.handleUpdate(albumMember("album-a"));
    await vi.advanceTimersByTimeAsync(900);
    await runtime.handleUpdate(albumMember("album-b"));
    await vi.advanceTimersByTimeAsync(900);
    expect(calls("getFile")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    await prompted(1);
    expect(backend.prompts).toHaveLength(1);
    expect(calls("getFile")).toHaveLength(2);
  });

  it("fails the whole album when one member is invalid", async () => {
    linkSession();
    await start();
    vi.useFakeTimers();

    await runtime.handleUpdate(albumMember("album-a"));
    await runtime.handleUpdate(
      documentMessage({ fileId: "album-doc", mimeType: "application/zip" }, { mediaGroupId: "album-1" }),
    );
    await runtime.handleUpdate(albumMember("album-c"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled((call) => call.method === "sendMessage", 1);

    expect(backend.prompts).toHaveLength(0);
    expect(calls("getFile")).toHaveLength(0);
    expect(calls("sendMessage")).toHaveLength(1);
    expect(textOf(lastCall("sendMessage"))).toBe(mediaNotice("unsupported-type"));
  });

  it("reports one failure when a single album member cannot be downloaded", async () => {
    linkSession();
    await start();
    vi.useFakeTimers();
    reply = (call) =>
      isDownload(call) && fileIdOf(call) === "album-b"
        ? { status: 404, json: { ok: false, error_code: 404 } }
        : okReply(call);

    await runtime.handleUpdate(albumMember("album-a"));
    await runtime.handleUpdate(albumMember("album-b"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled((call) => call.method === "sendMessage", 1);

    expect(backend.prompts).toHaveLength(0);
    expect(calls("sendMessage")).toHaveLength(1);
    expect(textOf(lastCall("sendMessage"))).toBe(mediaNotice("download-failed"));
  });

  it("rejects a fifth image in one prompt", async () => {
    linkSession();
    await start();
    vi.useFakeTimers();

    for (let index = 0; index <= MAX_PROMPT_IMAGES; index += 1) {
      await runtime.handleUpdate(albumMember(`album-${String(index)}`));
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await settled((call) => call.method === "sendMessage", 1);

    expect(backend.prompts).toHaveLength(0);
    expect(calls("getFile")).toHaveLength(0);
    expect(textOf(lastCall("sendMessage"))).toBe(mediaNotice("too-many"));
  });

  it("seals an open album immediately instead of waiting out the quiet window", async () => {
    linkSession();
    await start();
    vi.useFakeTimers();

    await runtime.handleUpdate(albumMember("album-a"));
    await runtime.handleUpdate(albumMember("album-b"));
    await runtime.sealAlbums();

    expect(backend.prompts).toHaveLength(1);
    expect(contentOf()).toHaveLength(3);
  });

  it("carries every member update id as one processing unit", async () => {
    const sealed: AlbumGroup[] = [];
    const collector = new AlbumCollector({
      onSeal: async (group) => {
        sealed.push(group);
      },
    });

    // Telegram may deliver album members out of order; the prompt is ordered
    // by message id, and the processing unit keeps every update id.
    collector.add("album-1", message({ messageId: 12, photo: [variant("c", 10, 90)] }));
    collector.add("album-1", message({ messageId: 10, photo: [variant("a", 10, 90)] }));
    collector.add("album-1", message({ messageId: 11, photo: [variant("b", 10, 90)] }));
    await collector.sealAll();

    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.messages.map((member) => member.messageId)).toEqual([10, 11, 12]);
    expect(sealed[0]?.updateIds).toEqual(sealed[0]?.messages.map((member) => member.updateId));
    expect(sealed[0]?.updateIds).toHaveLength(3);
  });
});

describe("prompt delivery", () => {
  it("steers an active session with image content", async () => {
    linkSession();
    await start([session(SESSION, { running: true })]);

    await runtime.handleUpdate(onePhoto({ text: "换这张" }));

    expect(backend.prompts[0]?.kind).toBe("steer");
    expect(contentOf()).toEqual([
      { type: "text", text: "换这张" },
      { type: "image", mediaType: "image/jpeg", data: IMAGE_BASE64 },
    ]);
    expect(textOf(lastCall("sendMessage"))).toBe(STEER_ACK_TEXT);
  });

  it("releases the memory budget after a failed prompt", async () => {
    linkSession();
    await start();
    const failing = vi.spyOn(backend, "sendPrompt").mockRejectedValue(new Error("dsh refused"));

    // Three attempts fail and the update is isolated; each attempt reserved
    // the image budget again.
    await runtime.handleUpdate(onePhoto());
    failing.mockRestore();

    // The budget released in `finally`, so the next image prompt runs at once.
    await runtime.handleUpdate(onePhoto());
    expect(backend.prompts).toHaveLength(1);
  });
});

describe("memory budget", () => {
  it("holds at most four threads downloading at once", async () => {
    const sessions = Array.from({ length: 5 }, (_unused, index) => session(`session-${String(index)}`));
    for (const [index, held] of sessions.entries()) linkSession(held.sessionId, THREAD + index);
    await start(sessions);
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    reply = async (call) => {
      if (call.method === "getFile") await gate;
      return okReply(call);
    };

    const inFlight = sessions.map((_unused, index) =>
      runtime.handleUpdate(
        photoMessage([variant(`photo-${String(index)}`, 40_000, 1280)], {
          thread: { chatId: CHAT, threadId: THREAD + index },
        }),
      ),
    );
    await turns(20);
    expect(calls("getFile")).toHaveLength(4);

    open();
    await Promise.all(inFlight);
    expect(calls("getFile")).toHaveLength(5);
    expect(backend.prompts).toHaveLength(5);
  });

  it("queues a thread whose weight does not fit the 20 MiB budget", async () => {
    const budget = new MemorySemaphore({ capacityBytes: 20 * MIB, maxHolders: 4 });
    const first = await budget.acquire(15 * MIB);
    const second = await budget.acquire(5 * MIB);

    let granted = false;
    const third = budget.acquire(5 * MIB).then((release) => {
      granted = true;
      return release;
    });
    await turns(2);
    expect(granted).toBe(false);

    second();
    await third;
    expect(granted).toBe(true);
    first();
  });
});

describe("secrecy", () => {
  it("keeps image bytes out of the database and the log", async () => {
    linkSession();
    await start();

    await runtime.handleUpdate(onePhoto({ text: "机密截图" }));
    expect(backend.prompts).toHaveLength(1);

    for (const name of readdirSync(dir)) {
      const stored = readFileSync(join(dir, name));
      expect(stored.includes(Buffer.from(IMAGE_BYTES))).toBe(false);
      expect(stored.includes(IMAGE_BASE64)).toBe(false);
    }
    const log = logLines.join("\n");
    expect(log).not.toContain(IMAGE_BASE64);
    expect(log).not.toContain("photo-only");
    expect(log).not.toContain("机密截图");
  });
});
