/**
 * The live end-to-end run.
 *
 * This is the only code in the repository that talks to the real Bot API and
 * the real dsh at once, and it never runs in the default suite: vitest collects
 * `*.test.ts`, and this file is a script the wizard invokes by name.
 *
 * What it drives is the real `BridgeRuntime`, in process, against a temporary
 * SQLite file. Everything the bridge can originate for itself — a prompt, a
 * steer, a turn started by another dsh client, a split final message — is
 * driven from here as a normalized update or a Backend call, so the human only
 * does what a bot cannot do at all: create a private topic, tap an inline
 * button, and send a photo from a phone. Those steps print an instruction and
 * wait for the update that proves they happened.
 *
 * Two failures are injected rather than provoked: Telegram will not reject a
 * send on request, so the wrapper below fails one `sendRichMessage` to prove
 * the partial-result report, and the split path is exercised with a document
 * the bridge itself composes. Everything else is real traffic.
 *
 * Evidence is JSON Lines of ids, counts, and durations. `live/checklist.ts`
 * owns the redaction and is unit tested; nothing here writes a prompt, a
 * caption, an agent answer, or a token.
 *
 * Usage:
 *   pnpm -F bridge live:e2e <config.json> --thread <id> [--chat <id>]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshBackend } from "../src/backends/dsh.ts";
import { loadConfig, type BridgeConfig } from "../src/config.ts";
import { createLogger, type Logger } from "../src/log.ts";
import {
  BridgeRuntime,
  PLATFORM,
  RESEND_NOTICE,
  STEER_ACK_TEXT,
  partialResultText,
} from "../src/runtime/runtime.ts";
import { Store } from "../src/store/store.ts";
import { Allowlist } from "../src/telegram/allowlist.ts";
import { TelegramApi, TelegramApiError } from "../src/telegram/api.ts";
import { splitFinalMarkdown } from "../src/telegram/markdown.ts";
import { runUpdateLoop, type InboundMessage, type InboundUpdate } from "../src/telegram/updates.ts";
import type { BackendEvent } from "../src/backends/types.ts";
import { Checklist } from "./checklist.ts";

/** How long a step that needs the human may wait. */
const HUMAN_TIMEOUT_MS = 240_000;
/** How long a real DeepSeek turn may take before the run gives up on it. */
const AGENT_TIMEOUT_MS = 240_000;
/** Synthetic update ids stay below every real one, so polling keeps its offset. */
const SYNTHETIC_BASE = 1;

/** A prompt long enough that the model keeps working while a steer arrives. */
const LONG_TASK_TEXT = "请依次说明 TCP 三次握手的每一步，每步至少三句话，最后给一段 Python 伪代码。";
const SHORT_TASK_TEXT = "用一句话回答：1 加 1 等于几？";
/** A harmless approval: dsh asks before it runs anything in a shell. */
const APPROVAL_TASK_TEXT = "请用 bash 工具执行 `echo im-bridge-live-check`，只执行这一条命令。";

interface OutboundCall {
  readonly method: string;
  readonly threadId: number | undefined;
  readonly messageId: number | undefined;
  /** A bridge-authored constant this text matched. Never the text itself. */
  readonly label: string | undefined;
}

/**
 * Records what the bridge sent, and can fail one send on demand.
 *
 * The recorder stores a label, not the message: matching against the runtime's
 * own exported constants is enough to prove which status line was delivered,
 * and it keeps an agent's answer out of this process's memory dumps.
 */
class OutboundRecorder {
  readonly calls: OutboundCall[] = [];

  #failNextRich = false;

  constructor(api: TelegramApi) {
    const sendMessage = api.sendMessage.bind(api);
    api.sendMessage = async (message) => {
      const messageId = await sendMessage(message);
      this.#record("sendMessage", message.threadId, messageId, labelOf(message.text));
      return messageId;
    };
    const sendRichMessage = api.sendRichMessage.bind(api);
    api.sendRichMessage = async (message) => {
      if (this.#failNextRich) {
        this.#failNextRich = false;
        this.#record("sendRichMessage.injected-failure", message.threadId, undefined, undefined);
        throw new TelegramApiError({
          method: "sendRichMessage",
          kind: "api",
          transient: false,
          errorCode: 400,
        });
      }
      const messageId = await sendRichMessage(message);
      this.#record("sendRichMessage", message.threadId, messageId, undefined);
      return messageId;
    };
    const sendDraft = api.sendRichMessageDraft.bind(api);
    api.sendRichMessageDraft = async (draft) => {
      await sendDraft(draft);
      this.#record("sendRichMessageDraft", draft.threadId, undefined, undefined);
    };
  }

  /** Telegram never rejects on request, so the partial report needs this. */
  failNextRichMessage(): void {
    this.#failNextRich = true;
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  labels(): string[] {
    return this.calls.map((call) => call.label).filter((label): label is string => label !== undefined);
  }

  #record(method: string, threadId: number | undefined, messageId: number | undefined, label: string | undefined): void {
    this.calls.push({ method, threadId, messageId, label });
  }
}

/** Names the bridge-authored status lines this run has to see arrive. */
function labelOf(text: string): string | undefined {
  if (text === STEER_ACK_TEXT) return "steer-ack";
  if (text === RESEND_NOTICE) return "resend-notice";
  if (text.startsWith("发送失败：已发送")) return "partial-result";
  if (text.startsWith("后端错误：")) return "backend-error";
  if (text.startsWith("后端警告：")) return "backend-warning";
  return undefined;
}

/** Resolves the first observation that matches, or rejects at the timeout. */
class Waiter<T> {
  readonly #waiters = new Set<{ match: (value: T) => boolean; settle: (value: T) => void }>();

  observe(value: T): void {
    for (const waiter of [...this.#waiters]) {
      if (!waiter.match(value)) continue;
      this.#waiters.delete(waiter);
      waiter.settle(value);
    }
  }

  next(match: (value: T) => boolean, timeoutMs: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = {
        match,
        settle: (value: T): void => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(entry);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      this.#waiters.add(entry);
    });
  }
}

interface Harness {
  readonly config: BridgeConfig;
  readonly chatId: number;
  readonly threadId: number;
  readonly api: TelegramApi;
  readonly outbound: OutboundRecorder;
  readonly backend: DshBackend;
  readonly store: Store;
  readonly storePath: string;
  readonly runtime: BridgeRuntime;
  readonly updates: Waiter<InboundUpdate>;
  readonly events: Waiter<BackendEvent>;
  readonly checklist: Checklist;
  readonly logger: Logger;
  readonly polling: AbortController;
}

async function main(): Promise<void> {
  const [, , configPath, ...args] = process.argv;
  if (configPath === undefined) throw new Error("Usage: live:e2e <config.json> --thread <id> [--chat <id>]");
  const config = await loadConfig(configPath);
  const threadId = readNumberFlag(args, "--thread");
  if (threadId === undefined) throw new Error("--thread <id> is required; run `topic detect` to find it");
  const chatId = readNumberFlag(args, "--chat") ?? soleAllowedUserId(config);

  const dir = mkdtempSync(join(tmpdir(), "im-bridge-live-"));
  const storePath = join(dir, "live.db");
  const checklist = new Checklist();
  const logger = createLogger({ level: config.logLevel });
  const api = new TelegramApi({ token: config.botToken, logger });
  const outbound = new OutboundRecorder(api);
  const store = new Store(storePath);
  const backend = new DshBackend({
    baseUrl: config.dshUrl,
    allowedCwdRoots: [...config.cwdRoots.values()],
  });
  const polling = new AbortController();
  const runtime = new BridgeRuntime({
    api,
    backend,
    store,
    allowlist: new Allowlist(config.allowedUserIds),
    cwdRoots: config.cwdRoots,
    logger,
    polling,
  });
  const updates = new Waiter<InboundUpdate>();
  const events = new Waiter<BackendEvent>();
  const harness: Harness = {
    config,
    chatId,
    threadId,
    api,
    outbound,
    backend,
    store,
    storePath,
    runtime,
    updates,
    events,
    checklist,
    logger,
    polling,
  };

  const identity = await api.getMe();
  checklist.note("live.started", { chatId, threadId, count: identity.id });
  await runtime.recover();
  await runtime.start();
  const unsubscribe = backend.subscribe((event) => events.observe(event));

  const loop = runUpdateLoop({
    api,
    allowlist: new Allowlist(config.allowedUserIds),
    checkpoint: store,
    logger,
    signal: polling.signal,
    onUpdate: (update) => {
      updates.observe(update);
      return runtime.handleUpdate(update);
    },
  });

  try {
    await drive(harness);
  } finally {
    unsubscribe();
    await runtime.shutdown({ reason: "live-e2e" });
    // The drain closes the Store the loop settles against, so the loop ends by
    // failing. It is evidence, not silence: only the error's name is written.
    await loop.catch((error: unknown) => {
      checklist.note("live.poll.ended", { reason: errorName(error) });
    });
    rmSync(dir, { recursive: true, force: true });
  }

  for (const line of checklist.report()) process.stdout.write(`${line}\n`);
  if (!checklist.summary().ok) process.exitCode = 1;
}

/**
 * The checklist, in dependency order.
 *
 * A step that throws fails its own item and stops the run: every later step
 * assumes the link the earlier ones created, and a cascade of timeouts would
 * bury the first real failure.
 */
async function drive(harness: Harness): Promise<void> {
  await step(harness, "topic-menu", () => proveTopicMenu(harness));
  await step(harness, "session-create", () => proveSessionCreate(harness));
  await step(harness, "unlink-repair", () => proveUnlinkRepair(harness));
  await step(harness, "session-bind", () => proveSessionBind(harness));
  await step(harness, "text-prompt", () => proveTextPrompt(harness));
  await step(harness, "text-steer", () => proveTextSteer(harness));
  await step(harness, "image-single", () => proveImage(harness));
  await step(harness, "album-atomic", () => proveAlbum(harness));
  await step(harness, "image-steer", () => proveImageSteer(harness));
  await step(harness, "approval-allow", () => proveApproval(harness, true));
  await step(harness, "approval-reject", () => proveApproval(harness, false));
  await step(harness, "external-turn", () => proveExternalTurn(harness));
  await step(harness, "long-output", () => proveLongOutput(harness));
  await step(harness, "multipart-failure", () => proveMultipartFailure(harness));
  await step(harness, "restart-recovery", () => proveRestartRecovery(harness));
}

async function step(harness: Harness, id: string, run: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await run();
    harness.checklist.pass(id, { durationMs: Date.now() - startedAt, threadId: harness.threadId });
  } catch (error) {
    harness.checklist.fail(id, error instanceof Error ? error.name : "unknown", {
      durationMs: Date.now() - startedAt,
      threadId: harness.threadId,
    });
    throw error;
  }
}

/** Prints one instruction for the human. Numbered by the item it belongs to. */
function instruct(harness: Harness, id: string, lines: readonly string[]): void {
  harness.checklist.note("live.human.step", { item: id });
  process.stdout.write(`\n  HUMAN STEP · ${id}\n`);
  for (const line of lines) process.stdout.write(`    - ${line}\n`);
}

async function proveTopicMenu(harness: Harness): Promise<void> {
  instruct(harness, "topic-menu", [
    `在私聊 topic（message_thread_id = ${String(harness.threadId)}）里发送 /manage`,
  ]);
  await harness.updates.next(
    (update) => update.kind === "message" && update.text === "/manage",
    HUMAN_TIMEOUT_MS,
    "the /manage command",
  );
  await waitFor(() => harness.outbound.count("sendMessage") > 0, "the management menu");
}

async function proveSessionCreate(harness: Harness): Promise<void> {
  instruct(harness, "session-create", [
    "点「新建 session」，按提示选工作目录与其下的子目录，等待绑定结果",
  ]);
  await waitFor(() => linkOf(harness) !== undefined, "a new link", HUMAN_TIMEOUT_MS);
  const link = requireLink(harness);
  harness.checklist.note("live.link.created", { sessionId: link.sessionId, threadId: link.threadId });
}

async function proveUnlinkRepair(harness: Harness): Promise<void> {
  instruct(harness, "unlink-repair", [
    "发送 /manage，点「解除绑定」",
    "解除后再发送 /manage，确认菜单回到未绑定状态",
  ]);
  await waitFor(() => linkOf(harness) === undefined, "the link to be removed", HUMAN_TIMEOUT_MS);
}

async function proveSessionBind(harness: Harness): Promise<void> {
  instruct(harness, "session-bind", [
    "发送 /manage，点「绑定已有 session」，选中刚才那个 session",
  ]);
  await waitFor(() => linkOf(harness) !== undefined, "the existing session to be bound", HUMAN_TIMEOUT_MS);
}

async function proveTextPrompt(harness: Harness): Promise<void> {
  const link = requireLink(harness);
  const done = harness.events.next(
    (event) => event.type === "turn-end" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the first turn to end",
  );
  await harness.runtime.handleUpdate(textUpdate(harness, SHORT_TASK_TEXT));
  await done;
  await waitFor(() => harness.outbound.count("sendRichMessage") > 0, "the final Rich Message");
}

async function proveTextSteer(harness: Harness): Promise<void> {
  const link = requireLink(harness);
  const before = harness.outbound.labels().filter((label) => label === "steer-ack").length;
  const running = harness.events.next(
    (event) => event.type === "output" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the long turn to start producing output",
  );
  await harness.runtime.handleUpdate(textUpdate(harness, LONG_TASK_TEXT));
  await running;
  await harness.runtime.handleUpdate(textUpdate(harness, "补充一句：请顺便说明为什么不是两次握手。"));
  await waitFor(
    () => harness.outbound.labels().filter((label) => label === "steer-ack").length > before,
    "the steer acknowledgement",
  );
  await harness.events.next(
    (event) => event.type === "turn-end" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the steered turn to end",
  );
}

async function proveImage(harness: Harness): Promise<void> {
  const link = requireLink(harness);
  instruct(harness, "image-single", ["在同一个 topic 里发一张图片，并写一句 caption"]);
  const sent = await harness.updates.next(
    (update) => update.kind === "message" && update.photo !== undefined && update.mediaGroupId === undefined,
    HUMAN_TIMEOUT_MS,
    "one photo",
  );
  harness.checklist.note("live.image.received", { updateId: sent.updateId });
  await harness.events.next(
    (event) => event.type === "turn-end" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the image turn to end",
  );
}

async function proveAlbum(harness: Harness): Promise<void> {
  const link = requireLink(harness);
  instruct(harness, "album-atomic", ["一次发送两张图片（相册），可以带 caption"]);
  const first = await harness.updates.next(
    (update) => update.kind === "message" && update.mediaGroupId !== undefined,
    HUMAN_TIMEOUT_MS,
    "the first album member",
  );
  const group = first.kind === "message" ? first.mediaGroupId : undefined;
  const second = await harness.updates.next(
    (update) => update.kind === "message" && update.mediaGroupId === group && update.updateId !== first.updateId,
    HUMAN_TIMEOUT_MS,
    "the second album member",
  );
  harness.checklist.note("live.album.received", { updateId: first.updateId, count: 2 });
  // One prompt for two updates is the whole point: the album is one unit.
  await harness.events.next(
    (event) => event.type === "turn-end" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the album turn to end",
  );
  const store = harness.store;
  if (store.findProcessing(first.updateId) !== undefined) throw new Error("album anchor was left processing");
  if (store.findProcessing(second.updateId) !== undefined) throw new Error("album member was left processing");
}

async function proveImageSteer(harness: Harness): Promise<void> {
  const link = requireLink(harness);
  const before = harness.outbound.labels().filter((label) => label === "steer-ack").length;
  const running = harness.events.next(
    (event) => event.type === "output" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the turn that the photo will steer",
  );
  await harness.runtime.handleUpdate(textUpdate(harness, LONG_TASK_TEXT));
  await running;
  instruct(harness, "image-steer", ["趁这个回合还在跑，再发一张图片进来"]);
  await harness.updates.next(
    (update) => update.kind === "message" && update.photo !== undefined,
    HUMAN_TIMEOUT_MS,
    "the steering photo",
  );
  await waitFor(
    () => harness.outbound.labels().filter((label) => label === "steer-ack").length > before,
    "the steer acknowledgement for the photo",
    HUMAN_TIMEOUT_MS,
  );
  await harness.events.next(
    (event) => event.type === "turn-end" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the photo-steered turn to end",
  );
}

/**
 * One approval, answered from Telegram.
 *
 * `echo` is the harmless tool call ADR 0003 authorises: it proves the request
 * reaches the topic and the decision reaches dsh, without letting the agent
 * change anything on the machine.
 */
async function proveApproval(harness: Harness, allow: boolean): Promise<void> {
  const link = requireLink(harness);
  const asked = harness.events.next(
    (event) => event.type === "approval" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the approval request",
  );
  await harness.runtime.handleUpdate(textUpdate(harness, APPROVAL_TASK_TEXT));
  await asked;
  instruct(harness, allow ? "approval-allow" : "approval-reject", [
    `在审批消息上点「${allow ? "允许一次" : "拒绝"}」`,
  ]);
  await harness.updates.next(
    (update) => update.kind === "callback",
    HUMAN_TIMEOUT_MS,
    "the approval answer",
  );
  await harness.events.next(
    (event) => event.type === "turn-end" || event.type === "error",
    AGENT_TIMEOUT_MS,
    "the approved turn to settle",
  );
}

/**
 * A turn no Telegram message started.
 *
 * Calling the Backend directly is what dsh's own Web UI does, so the bridge has
 * to render it from the link that exists when each event arrives.
 */
async function proveExternalTurn(harness: Harness): Promise<void> {
  const link = requireLink(harness);
  const before = harness.outbound.count("sendRichMessage");
  await harness.backend.sendPrompt(link.sessionId, [{ type: "text", text: SHORT_TASK_TEXT }]);
  await harness.events.next(
    (event) => event.type === "turn-end" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the externally started turn to end",
  );
  await waitFor(
    () => harness.outbound.count("sendRichMessage") > before,
    "the external turn to reach the topic",
  );
}

/**
 * The split path against the real API.
 *
 * A model cannot be asked to emit exactly 32 000 characters, so the document is
 * composed here and pushed through the same splitter and the same send the
 * runtime uses. What is being proved is that Telegram accepts every part.
 */
async function proveLongOutput(harness: Harness): Promise<void> {
  const code = Array.from({ length: 2_000 }, (_, index) => `value_${String(index)} = ${String(index)}`).join("\n");
  const document = `# 长输出自检\n\n${"这是一段用于验证分片的中文说明。".repeat(400)}\n\n\`\`\`python\n${code}\n\`\`\`\n`;
  const parts = splitFinalMarkdown(document);
  if (parts.length < 2) throw new Error("the composed document did not need splitting");
  for (const part of parts) {
    await harness.api.sendRichMessage({ chatId: harness.chatId, threadId: harness.threadId, markdown: part });
  }
  harness.checklist.note("live.long-output.sent", { count: parts.length });
}

/**
 * The partial-result report.
 *
 * Telegram does not reject a send on request, so one `sendRichMessage` is
 * failed inside the recorder. What is real is everything after it: the runtime
 * stops the sequence, resends nothing, and says how much arrived.
 */
async function proveMultipartFailure(harness: Harness): Promise<void> {
  const link = requireLink(harness);
  const before = harness.outbound.labels().filter((label) => label === "partial-result").length;
  harness.outbound.failNextRichMessage();
  await harness.runtime.handleUpdate(textUpdate(harness, SHORT_TASK_TEXT));
  await harness.events.next(
    (event) => event.type === "turn-end" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the turn whose result is dropped",
  );
  await waitFor(
    () => harness.outbound.labels().filter((label) => label === "partial-result").length > before,
    "the partial-result notice",
  );
  harness.checklist.note("live.partial.reported", { count: 0, reason: partialResultText(0, 1).slice(0, 12) });
}

/**
 * Restart recovery, with a record this run really left open.
 *
 * A one-millisecond deadline is a crash the test can schedule: the prompt is
 * still in flight, so its processing record survives the shutdown. A second
 * runtime then opens the same database and has to isolate it and ask the topic
 * to resend, which is what the service does at every start.
 */
async function proveRestartRecovery(harness: Harness): Promise<void> {
  const link = requireLink(harness);
  const pending = harness.runtime.handleUpdate(textUpdate(harness, LONG_TASK_TEXT)).catch((error: unknown) => {
    // The scheduled restart interrupts this unit; the failure is expected and
    // is recorded by name, the way `bridge.poll.aborted` records one.
    harness.checklist.note("live.restart.interrupted", { reason: errorName(error) });
  });
  await harness.events.next(
    (event) => event.type === "output" && event.sessionId === link.sessionId,
    AGENT_TIMEOUT_MS,
    "the turn that the restart interrupts",
  );
  harness.polling.abort();
  const outcome = await harness.runtime.shutdown({ deadlineMs: 1, reason: "live-restart" });
  await pending;
  if (outcome.drained) throw new Error("the interrupted unit finished before the restart");

  const store = new Store(harness.storePath);
  const backend = new DshBackend({
    baseUrl: harness.config.dshUrl,
    allowedCwdRoots: [...harness.config.cwdRoots.values()],
  });
  const restarted = new BridgeRuntime({
    api: harness.api,
    backend,
    store,
    allowlist: new Allowlist(harness.config.allowedUserIds),
    cwdRoots: harness.config.cwdRoots,
    logger: harness.logger,
  });
  try {
    const before = harness.outbound.labels().filter((label) => label === "resend-notice").length;
    await restarted.recover();
    const notices = harness.outbound.labels().filter((label) => label === "resend-notice").length;
    if (notices <= before) throw new Error("recovery sent no resend notice");
    const isolated = store.listDeadLetters();
    if (isolated.length === 0) throw new Error("recovery wrote no dead letter");
    harness.checklist.note("live.recovery.isolated", { count: isolated.length });
  } finally {
    await restarted.shutdown({ reason: "live-restart-done" });
  }
}

/** One synthetic update. Ids stay low so the polling offset keeps using real ones. */
let syntheticId = SYNTHETIC_BASE;
function textUpdate(harness: Harness, text: string): InboundMessage {
  syntheticId += 1;
  return {
    kind: "message",
    updateId: syntheticId,
    thread: { chatId: harness.chatId, threadId: harness.threadId },
    userId: soleAllowedUserId(harness.config),
    messageId: syntheticId,
    text,
  };
}

function linkOf(harness: Harness): { sessionId: string; threadId: number } | undefined {
  return harness.store.findByThread(PLATFORM, harness.chatId, harness.threadId);
}

function requireLink(harness: Harness): { sessionId: string; threadId: number } {
  const link = linkOf(harness);
  if (link === undefined) throw new Error("this topic is not linked to a session");
  return link;
}

/** Polls a condition the bridge fulfils asynchronously. */
async function waitFor(check: () => boolean, what: string, timeoutMs = AGENT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A failure as evidence may carry it: its type, never its message. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function soleAllowedUserId(config: BridgeConfig): number {
  const [only, ...rest] = config.allowedUserIds;
  if (only === undefined || rest.length > 0) {
    throw new Error("Pass --chat <id>: the allowlist does not name a single private chat");
  }
  return only;
}

function readNumberFlag(args: readonly string[], flag: string): number | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = Number(args[at + 1]);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} needs an integer id`);
  return value;
}

try {
  await main();
} catch (error) {
  // Startup and configuration errors carry no credential by construction; a
  // step failure was already reported as its own checklist item.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
