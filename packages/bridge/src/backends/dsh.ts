import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  ApprovalNotPendingError,
  type Backend,
  type BackendEvent,
  type BackendEventHandler,
  type PromptContent,
  type PromptContentPart,
  type Session,
} from "./types.ts";

export interface DshLogger {
  debug?(message: string, details?: unknown): void;
  info?(message: string, details?: unknown): void;
  warn?(message: string, details?: unknown): void;
  error?(message: string, details?: unknown): void;
}

export interface DshBackendOptions {
  baseUrl: string;
  allowedCwdRoots: string[];
  logger?: DshLogger;
}

interface RpcSuccess {
  type: "server-response";
  rpcId: string;
  result: { ok: true; value: unknown };
}

const LIST_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 30_000;
/** dsh also accepts image/gif on the wire; the bridge contract does not. */
const PROMPT_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_NAME_LIMIT = 255;
/** Path separators and control characters must never reach a dsh attachment name. */
const UNSAFE_IMAGE_NAME_PATTERN = /[\\/\u0000-\u001f\u007f]/;

export class DshBackend implements Backend {
  readonly name = "dsh";

  readonly #baseUrl: URL;
  readonly #allowedCwdRoots: string[];
  readonly #logger: DshLogger;
  readonly #subscribers = new Set<Subscriber>();
  readonly #turnMessages = new Map<string, string>();
  readonly #sessionRunning = new Map<string, boolean>();
  readonly #activeSessions = new Set<string>();
  readonly #pendingApprovals = new Map<string, { sessionId: string; approvalId: string }>();
  readonly #dispatchWork = new Set<Promise<void>>();
  #unknownEventCount = 0;
  #muxSocket?: WebSocket;
  #hostSocket?: WebSocket;
  #muxReconnectTimer?: ReturnType<typeof setTimeout>;
  #hostReconnectTimer?: ReturnType<typeof setTimeout>;
  #muxRetryMs = 1_000;
  #hostRetryMs = 1_000;
  #downlinkGeneration = 0;
  #closed = false;

  constructor(options: DshBackendOptions) {
    if (options.allowedCwdRoots.length === 0) throw new Error("allowedCwdRoots must not be empty");
    this.#baseUrl = new URL(options.baseUrl);
    this.#allowedCwdRoots = [...options.allowedCwdRoots];
    this.#logger = options.logger ?? console;
  }

  async listSessions(): Promise<Session[]> {
    const value = await this.#rpc("session.list", {}, LIST_TIMEOUT_MS);
    if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("Invalid session.list response");
    return value.items.map((item) => {
      const session = parseSession(item);
      const running = this.#sessionRunning.get(session.sessionId);
      return running === undefined ? session : { ...session, running };
    });
  }

  async createSession(cwd: string): Promise<string> {
    const resolvedCwd = await realpath(cwd);
    const cwdStat = await stat(resolvedCwd);
    if (!cwdStat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
    const roots = await Promise.all(this.#allowedCwdRoots.map((root) => realpath(root)));
    if (!roots.some((root) => isInside(root, resolvedCwd))) {
      throw new Error(`cwd is outside allowed cwd roots: ${cwd}`);
    }
    const value = await this.#rpc("session.create", { cwd: resolvedCwd }, LIST_TIMEOUT_MS);
    if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
      throw new Error("Invalid session.create response");
    }
    return value.sessionId;
  }

  async sendPrompt(sessionId: string, content: PromptContent): Promise<void> {
    await this.#prompt(sessionId, content, "queue");
  }

  /** dsh steers through the same call; only the mode differs. */
  async steer(sessionId: string, content: PromptContent): Promise<void> {
    await this.#prompt(sessionId, content, "steer");
  }

  subscribe(handler: BackendEventHandler): () => void {
    this.#assertOpen();
    const subscriber: Subscriber = {
      handler,
      queues: new Map(),
      dispatching: new Set(),
      overflowedSessions: new Set(),
      approvalOverloadedSessions: new Set(),
      active: true,
      work: this.#dispatchWork,
    };
    this.#subscribers.add(subscriber);
    if (this.#subscribers.size === 1) this.#openDownlinks();
    return () => {
      subscriber.active = false;
      subscriber.queues.clear();
      this.#subscribers.delete(subscriber);
      if (this.#subscribers.size === 0) {
        this.#clearVolatileState();
        this.#closeDownlinks();
      }
    };
  }

  async respondApproval(requestId: string, approved: boolean): Promise<void> {
    this.#assertOpen();
    const pending = this.#pendingApprovals.get(requestId);
    if (pending === undefined) throw new ApprovalNotPendingError(`Unknown approval request: ${requestId}`);
    let response: Response;
    try {
      response = await fetch(new URL("/api/respond", this.#baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-response",
          rpcId: requestId,
          result: {
            ok: true,
            value: {
              sessionId: pending.sessionId,
              approvalId: pending.approvalId,
              outcome: approved ? "allowed-once" : "rejected",
            },
          },
        }),
        signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error("dsh approval response failed", { cause: error });
    }
    if (!response.ok) throw new Error(`dsh approval response failed with HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error("dsh approval response returned invalid JSON", { cause: error });
    }
    if (isRecord(body) && body.accepted === false && body.reason === "not-pending") {
      this.#pendingApprovals.delete(requestId);
      this.#logger.info?.("dsh approval was already resolved", { requestId });
      return;
    }
    if (!isRecord(body) || body.accepted !== true) {
      throw new Error("Invalid dsh approval response");
    }
    this.#pendingApprovals.delete(requestId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const work = [...this.#dispatchWork];
    for (const subscriber of this.#subscribers) {
      subscriber.active = false;
      subscriber.queues.clear();
    }
    this.#subscribers.clear();
    this.#pendingApprovals.clear();
    this.#turnMessages.clear();
    this.#sessionRunning.clear();
    this.#activeSessions.clear();
    this.#closeDownlinks();
    await Promise.allSettled(work);
  }

  #openDownlinks(): void {
    const generation = ++this.#downlinkGeneration;
    this.#openNamedDownlink("mux", generation);
    this.#openNamedDownlink("host", generation);
  }

  #openNamedDownlink(kind: "mux" | "host", generation: number): void {
    if (this.#closed || this.#subscribers.size === 0 || generation !== this.#downlinkGeneration) return;
    const path = kind === "mux" ? "/api/events.mux" : "/api/events.host";
    const handler = kind === "mux" ? (value: unknown) => this.#handleMux(value) : (value: unknown) => this.#handleHost(value);
    const socket = this.#openDownlink(path, handler, () => this.#downlinkClosed(kind, generation, socket));
    if (kind === "mux") this.#muxSocket = socket;
    else this.#hostSocket = socket;
  }

  #openDownlink(path: string, handler: (value: unknown) => void, onClose: () => void): WebSocket {
    const url = new URL(path, this.#baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.addEventListener("message", (event) => {
      try {
        handler(JSON.parse(String(event.data)));
      } catch (error) {
        this.#logger.warn?.("Invalid dsh downlink frame", { path, error });
      }
    });
    socket.addEventListener("open", () => {
      if (path.endsWith("mux")) this.#muxRetryMs = 1_000;
      else this.#hostRetryMs = 1_000;
    });
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", () => this.#logger.warn?.("dsh downlink error", { path }));
    return socket;
  }

  #downlinkClosed(kind: "mux" | "host", generation: number, socket: WebSocket): void {
    if (generation !== this.#downlinkGeneration || this.#closed || this.#subscribers.size === 0) return;
    if (kind === "mux" && this.#muxSocket !== socket) return;
    if (kind === "host" && this.#hostSocket !== socket) return;
    if (kind === "mux") {
      this.#muxSocket = undefined;
      this.#invalidateApprovals();
    } else {
      this.#hostSocket = undefined;
    }
    const retryMs = kind === "mux" ? this.#muxRetryMs : this.#hostRetryMs;
    const delay = Math.round(retryMs * (0.8 + Math.random() * 0.4));
    const timer = setTimeout(() => this.#openNamedDownlink(kind, generation), delay);
    if (kind === "mux") {
      this.#muxReconnectTimer = timer;
      this.#muxRetryMs = Math.min(retryMs * 2, 30_000);
    } else {
      this.#hostReconnectTimer = timer;
      this.#hostRetryMs = Math.min(retryMs * 2, 30_000);
    }
    this.#logger.warn?.("dsh downlink disconnected; reconnect scheduled", { kind, delay });
  }

  #invalidateApprovals(): void {
    const sessions = new Set<string>();
    for (const pending of this.#pendingApprovals.values()) sessions.add(pending.sessionId);
    this.#pendingApprovals.clear();
    for (const sessionId of sessions) {
      this.#emit({ type: "error", sessionId, message: "Approval expired because the dsh connection was lost" });
    }
    for (const sessionId of this.#activeSessions) {
      if (!sessions.has(sessionId)) {
        this.#emit({ type: "error", sessionId, message: "Turn interrupted because the dsh connection was lost" });
      }
    }
    this.#turnMessages.clear();
    this.#activeSessions.clear();
  }

  #clearVolatileState(): void {
    this.#pendingApprovals.clear();
    this.#turnMessages.clear();
    this.#activeSessions.clear();
    this.#sessionRunning.clear();
  }

  #closeDownlinks(): void {
    this.#downlinkGeneration += 1;
    if (this.#muxReconnectTimer !== undefined) clearTimeout(this.#muxReconnectTimer);
    if (this.#hostReconnectTimer !== undefined) clearTimeout(this.#hostReconnectTimer);
    this.#muxReconnectTimer = undefined;
    this.#hostReconnectTimer = undefined;
    for (const socket of [this.#muxSocket, this.#hostSocket]) {
      if (socket !== undefined && socket.readyState < WebSocket.CLOSING) socket.close();
    }
    this.#muxSocket = undefined;
    this.#hostSocket = undefined;
  }

  #handleMux(value: unknown): void {
    if (!isRecord(value) || !isRecord(value.payload)) {
      this.#logger.warn?.("Malformed dsh mux envelope", { value });
      return;
    }
    const payload = value.payload;
    if (payload.type === "approval/requested") {
      if (typeof value.rpcId !== "string" || typeof payload.sessionId !== "string"
        || typeof payload.approvalId !== "string" || typeof payload.toolName !== "string") {
        this.#logger.warn?.("Malformed dsh approval request", { payload });
        return;
      }
      this.#pendingApprovals.set(value.rpcId, { sessionId: payload.sessionId, approvalId: payload.approvalId });
      // The reason explains the call, the tool name says what would run; a
      // user answering on a phone needs both.
      const prompt = typeof payload.reason === "string"
        ? `${payload.toolName}: ${payload.reason}`
        : `Allow ${payload.toolName}?`;
      this.#emit({ type: "approval", sessionId: payload.sessionId, requestId: value.rpcId, prompt });
      return;
    }
    if (payload.type === "approval/resolved") {
      if (typeof payload.sessionId !== "string" || typeof payload.approvalId !== "string"
        || !["allowed-once", "rejected", "cancelled", "unavailable"].includes(String(payload.outcome))) {
        this.#logger.warn?.("Malformed dsh approval resolution", { payload });
        return;
      }
      for (const [rpcId, pending] of this.#pendingApprovals) {
        if (pending.approvalId === payload.approvalId) this.#pendingApprovals.delete(rpcId);
      }
      return;
    }
    if (payload.type === "question/requested") {
      if (typeof payload.sessionId !== "string") {
        this.#logger.warn?.("Malformed dsh question request", { payload });
        return;
      }
      this.#emit({ type: "error", sessionId: payload.sessionId, message: "Interactive questions are not supported" });
      return;
    }
    if (payload.type !== "session/event") return;
    if (typeof payload.sessionId !== "string" || !isRecord(payload.event)
      || typeof payload.event.type !== "string" || typeof payload.event.seq !== "number"
      || !Number.isInteger(payload.event.seq) || payload.event.seq < 0
      || typeof payload.event.time !== "number" || !Number.isFinite(payload.event.time)
      || !("data" in payload.event)) {
      this.#logger.warn?.("Malformed dsh session event", { payload });
      return;
    }
    const event = payload.event;
    if (event.type === "assistant/chunk") {
      if (!isRecord(event.data) || !isRecord(event.data.chunk)) {
        this.#logger.warn?.("Malformed dsh assistant chunk", { event });
        return;
      }
      const chunk = event.data.chunk;
      const chunkType = chunk.type;
      const chunkText = chunk.text;
      if (typeof chunkType !== "string" || typeof chunkText !== "string") {
        this.#logger.warn?.("Malformed dsh assistant chunk", { event });
        return;
      }
      if (chunkType === "text-delta") {
        this.#turnMessages.set(payload.sessionId, this.#turnMessages.get(payload.sessionId) ?? "");
        this.#emit({ type: "output", sessionId: payload.sessionId, text: chunkText });
      }
      if (chunkType === "reasoning-delta") {
        this.#turnMessages.set(payload.sessionId, this.#turnMessages.get(payload.sessionId) ?? "");
        this.#emit({ type: "thinking", sessionId: payload.sessionId, text: chunkText });
      }
      return;
    }
    if (event.type === "assistant/message") {
      if (!isRecord(event.data) || !isRecord(event.data.message)) {
        this.#logger.warn?.("Malformed dsh assistant message", { event });
        return;
      }
      const text = messageText(event.data.message.content);
      if (text !== undefined) this.#turnMessages.set(payload.sessionId, text);
      return;
    }
    if (event.type === "turn/end") {
      const text = this.#turnMessages.get(payload.sessionId);
      if (text === undefined) {
        this.#emit({ type: "error", sessionId: payload.sessionId, message: "Turn ended without an assistant message" });
      }
      this.#emit({ type: "turn-end", sessionId: payload.sessionId, text: text ?? "" });
      this.#turnMessages.delete(payload.sessionId);
      this.#activeSessions.delete(payload.sessionId);
      return;
    }
    this.#unknownEventCount += 1;
    this.#logger.debug?.("Ignored dsh session event", { type: event.type, count: this.#unknownEventCount });
  }

  #handleHost(value: unknown): void {
    if (!isRecord(value) || !isRecord(value.payload)) {
      this.#logger.warn?.("Malformed dsh host envelope", { value });
      return;
    }
    const payload = value.payload;
    if (payload.type === "host/session-status") {
      if (typeof payload.sessionId !== "string" || typeof payload.running !== "boolean") {
        this.#logger.warn?.("Malformed dsh session status", { payload });
        return;
      }
      this.#sessionRunning.set(payload.sessionId, payload.running);
      return;
    }
    if (payload.type === "host/agent-error") {
      if (typeof payload.sessionId !== "string" || typeof payload.message !== "string") {
        this.#logger.warn?.("Malformed dsh agent error", { payload });
        return;
      }
      this.#turnMessages.delete(payload.sessionId);
      this.#activeSessions.delete(payload.sessionId);
      this.#emit({ type: "error", sessionId: payload.sessionId, message: payload.message });
    }
  }

  #emit(event: BackendEvent): void {
    let approvalOverloaded = false;
    for (const subscriber of this.#subscribers) {
      approvalOverloaded = enqueue(subscriber, event, this.#logger) || approvalOverloaded;
    }
    if (approvalOverloaded) {
      for (const subscriber of this.#subscribers) forceApprovalOverload(subscriber, event.sessionId);
      for (const [rpcId, pending] of this.#pendingApprovals) {
        if (pending.sessionId === event.sessionId) this.#pendingApprovals.delete(rpcId);
      }
    }
  }

  async #prompt(sessionId: string, content: PromptContent, mode: "queue" | "steer"): Promise<void> {
    validatePromptContent(content);
    const value = await this.#rpc(
      "session.prompt",
      { sessionId, mode, content: content.map(toWireContentPart) },
      ACTION_TIMEOUT_MS,
    );
    if (!isRecord(value) || value.accepted !== true) throw new Error("dsh did not accept prompt");
    this.#activeSessions.add(sessionId);
  }

  async #rpc(method: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    this.#assertOpen();
    const rpcId = crypto.randomUUID();
    let response: Response;
    try {
      response = await fetch(new URL(`/api/${method}`, this.#baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`dsh ${method} request failed`, { cause: error });
    }
    if (!response.ok) throw new Error(`dsh ${method} request failed with HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(`dsh ${method} returned invalid JSON`, { cause: error });
    }
    if (!isRpcSuccess(body) || body.rpcId !== rpcId) {
      if (isRecord(body) && isRecord(body.result) && body.result.ok === false) {
        const message = isRecord(body.result.error) && typeof body.result.error.message === "string"
          ? body.result.error.message
          : "unknown RPC error";
        throw new Error(`dsh ${method} failed: ${message}`);
      }
      throw new Error(`Invalid dsh ${method} response`);
    }
    return body.result.value;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("DshBackend is closed");
  }
}

interface Subscriber {
  handler: BackendEventHandler;
  queues: Map<string, BackendEvent[]>;
  dispatching: Set<string>;
  overflowedSessions: Set<string>;
  approvalOverloadedSessions: Set<string>;
  active: boolean;
  work: Set<Promise<void>>;
}

const QUEUE_CAPACITY = 64;
const DELTA_TEXT_CAPACITY = 8_192;
const OVERFLOW_WARNING = "Streamed output was truncated to keep buffering bounded";
const APPROVAL_OVERLOAD_ERROR = "Backend approval overload terminated the current turn";

function enqueue(subscriber: Subscriber, incoming: BackendEvent, logger: DshLogger): boolean {
  let event = incoming;
  let deltaTruncated = false;
  if (isDelta(event) && event.text.length > DELTA_TEXT_CAPACITY) {
    event = { ...event, text: event.text.slice(0, DELTA_TEXT_CAPACITY) };
    deltaTruncated = true;
  }
  const queue = subscriber.queues.get(event.sessionId) ?? [];
  let approvalOverloaded = false;
  if (event.type === "approval" && subscriber.approvalOverloadedSessions.has(event.sessionId)) return true;

  const duplicateIndex = findReplaceableEvent(queue, event);
  if (duplicateIndex >= 0) {
    queue[duplicateIndex] = event;
  } else {
    const previous = queue.at(-1);
    if (isDelta(event) && previous?.type === event.type) {
      const combined = previous.text + event.text;
      previous.text = combined.slice(0, DELTA_TEXT_CAPACITY);
      deltaTruncated = deltaTruncated || combined.length > DELTA_TEXT_CAPACITY;
    } else {
      while (queue.length >= QUEUE_CAPACITY) {
        const discardIndex = queue.findIndex(isDelta);
        if (discardIndex >= 0) {
          queue.splice(discardIndex, 1);
          if (!subscriber.overflowedSessions.has(event.sessionId)) {
            subscriber.overflowedSessions.add(event.sessionId);
            replaceOrAppend(queue, {
              type: "warning",
              sessionId: event.sessionId,
              message: OVERFLOW_WARNING,
            });
          }
          continue;
        }
        if (queue.some((queued) => queued.type === "approval")) {
          queue.length = 0;
          queue.push({ type: "error", sessionId: event.sessionId, message: APPROVAL_OVERLOAD_ERROR });
          subscriber.approvalOverloadedSessions.add(event.sessionId);
          approvalOverloaded = true;
          break;
        }
        queue.shift();
      }
      if (!(event.type === "approval" && subscriber.approvalOverloadedSessions.has(event.sessionId))) {
        if (queue.length >= QUEUE_CAPACITY) queue.shift();
        queue.push(event);
      }
    }
  }
  if (deltaTruncated && !subscriber.overflowedSessions.has(event.sessionId)) {
    subscriber.overflowedSessions.add(event.sessionId);
    replaceOrAppend(queue, { type: "warning", sessionId: event.sessionId, message: OVERFLOW_WARNING });
  }
  if (event.type === "turn-end") {
    subscriber.overflowedSessions.delete(event.sessionId);
    subscriber.approvalOverloadedSessions.delete(event.sessionId);
  }
  subscriber.queues.set(event.sessionId, queue);
  if (subscriber.dispatching.has(event.sessionId)) return approvalOverloaded;
  subscriber.dispatching.add(event.sessionId);
  const work = (async () => {
    try {
      while (subscriber.active && queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) continue;
        try {
          await subscriber.handler(next);
        } catch (error) {
          logger.error?.("dsh subscriber handler failed", error);
        }
      }
    } finally {
      subscriber.dispatching.delete(event.sessionId);
      if (queue.length === 0 || !subscriber.active) subscriber.queues.delete(event.sessionId);
    }
  })();
  subscriber.work.add(work);
  void work.finally(() => subscriber.work.delete(work));
  return approvalOverloaded;
}

function forceApprovalOverload(subscriber: Subscriber, sessionId: string): void {
  subscriber.approvalOverloadedSessions.add(sessionId);
  const queue = subscriber.queues.get(sessionId) ?? [];
  const latestTurnEnd = queue.findLast((event) => event.type === "turn-end");
  queue.length = 0;
  queue.push({ type: "error", sessionId, message: APPROVAL_OVERLOAD_ERROR });
  if (latestTurnEnd !== undefined) {
    queue.push(latestTurnEnd);
    subscriber.approvalOverloadedSessions.delete(sessionId);
  }
  subscriber.queues.set(sessionId, queue);
}

function findReplaceableEvent(queue: BackendEvent[], event: BackendEvent): number {
  if (event.type === "approval") {
    return queue.findIndex((queued) => queued.type === "approval" && queued.requestId === event.requestId);
  }
  if (event.type === "warning" || event.type === "error") {
    return queue.findIndex((queued) => {
      if (queued.type !== event.type) return false;
      if (queued.type === "error" && queued.message === APPROVAL_OVERLOAD_ERROR) return false;
      return true;
    });
  }
  return -1;
}

function replaceOrAppend(queue: BackendEvent[], event: BackendEvent): void {
  const replaceIndex = findReplaceableEvent(queue, event);
  if (replaceIndex >= 0) queue[replaceIndex] = event;
  else {
    if (queue.length >= QUEUE_CAPACITY) queue.shift();
    queue.push(event);
  }
}

function isDelta(event: BackendEvent): event is Extract<BackendEvent, { type: "output" | "thinking" }> {
  return event.type === "output" || event.type === "thinking";
}

function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

/**
 * Reject content dsh would refuse, or that would put an unsafe attachment name
 * on the wire, before the request leaves the process. Parts arrive from runtime
 * platform data, so the adapter narrows them again.
 */
function validatePromptContent(content: PromptContent): void {
  if (content.length === 0) throw new Error("Prompt content must have at least one part");
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.length === 0) throw new Error("Prompt text part must not be empty");
      continue;
    }
    if (!PROMPT_IMAGE_MEDIA_TYPES.includes(part.mediaType)) {
      throw new Error(`Unsupported prompt image media type: ${part.mediaType}`);
    }
    if (part.data.length === 0 || part.data.length % 4 !== 0 || !BASE64_PATTERN.test(part.data)) {
      throw new Error("Prompt image data must be base64");
    }
    if (part.name !== undefined && !isSafeImageName(part.name)) {
      throw new Error(`Unsafe prompt image name: ${part.name}`);
    }
  }
}

function isSafeImageName(name: string): boolean {
  if (name.length === 0 || name.length > IMAGE_NAME_LIMIT) return false;
  if (name === "." || name === "..") return false;
  return !UNSAFE_IMAGE_NAME_PATTERN.test(name);
}

/** `name` is optional on the dsh wire, so omit the field instead of sending a blank. */
function toWireContentPart(part: PromptContentPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  const image: Record<string, unknown> = { type: "image", mediaType: part.mediaType, data: part.data };
  if (part.name !== undefined) image.name = part.name;
  return image;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function parseSession(value: unknown): Session {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.running !== "boolean") {
    throw new Error("Invalid session.list item");
  }
  const session: Session = { sessionId: value.sessionId, running: value.running };
  if (typeof value.cwd === "string") session.cwd = value.cwd;
  if (typeof value.title === "string") session.title = value.title;
  return session;
}

function isRpcSuccess(value: unknown): value is RpcSuccess {
  return isRecord(value)
    && value.type === "server-response"
    && typeof value.rpcId === "string"
    && isRecord(value.result)
    && value.result.ok === true
    && "value" in value.result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
