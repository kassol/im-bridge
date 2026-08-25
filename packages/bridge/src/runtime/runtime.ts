/**
 * The bridge runtime.
 *
 * One object owns the four things a Telegram update has to be resolved
 * against: the Telegram adapter, the Backend contract, the Store, and the
 * epoch of this process. `handleUpdate` is the single entry point the polling
 * loop feeds, so every path that changes a link starts here.
 *
 * Two invariants shape the code:
 *
 *   - Nothing is trusted across a click. A menu says what was true when it was
 *     drawn; a tap re-reads the allowlist, the topic, the epoch, the link, the
 *     backend's sessions, the configured cwd roots, and the directories under
 *     them before it acts, and then edits that same menu into whatever it
 *     found. A repeated tap therefore converges instead of duplicating.
 *   - The bridge never rebinds and never deletes on the user's behalf.
 *     `Store.link` refuses an occupied side, an active session refuses an
 *     unlink, and unlinking leaves the backend session alone.
 *
 * Text in a linked topic is a prompt. An idle session starts a turn, a running
 * one is steered, and the backend's events come back through the link that
 * exists when each event arrives — never through the one the turn started with.
 * Images take the same path: an album becomes one input once its members stop
 * arriving, and its bytes are held only between the memory reservation and the
 * backend call that consumes them.
 *
 * Every update is scheduled and durable. Its thread runs it in arrival order,
 * four threads run at once, and the unit is marked processing before its first
 * side effect, so a retry resumes from the last recorded step and a crash is
 * isolated instead of replayed.
 */
import {
  ApprovalNotPendingError,
  type Backend,
  type BackendEvent,
  type PromptContent,
  type Session,
} from "../backends/types.ts";
import type { Logger } from "../log.ts";
import { LinkConflictError, type Link, type Store } from "../store/store.ts";
import type { Allowlist } from "../telegram/allowlist.ts";
import { TelegramApiError, failureSummary, type TelegramApi } from "../telegram/api.ts";
import { headChars, splitFinalMarkdown } from "../telegram/markdown.ts";
import {
  PLATFORM,
  type InboundCallback,
  type InboundMessage,
  type InboundUnsupported,
  type InboundUpdate,
  type ThreadIdentity,
} from "../telegram/updates.ts";
import { AlbumCollector, type AlbumGroup } from "./albums.ts";
import { createEpoch, decodeCallback, sessionSuffix, type CallbackAction } from "./callbacks.ts";
import { directoryLabel, listSubdirectories, resolveInsideRoot } from "./directories.ts";
import { MediaError, downloadImages, mediaNotice, planPrompt, type PromptPlan } from "./media.ts";
import {
  markQueued,
  runProcessing,
  STEP_APPROVAL_ANSWERED,
  STEP_MESSAGE_EDITED,
  STEP_MESSAGE_SENT,
  STEP_PROMPT_SENT,
  STEP_SESSION_CREATED,
  type ProcessingUnit,
  type UpdateProgress,
} from "./processing.ts";
import { ThreadScheduler } from "./scheduler.ts";
import { MemorySemaphore } from "./semaphore.ts";
import { TurnStream } from "./turns.ts";
import {
  approvalMenu,
  approvalResolvedMenu,
  existingSessionsMenu,
  expiredMenu,
  invalidLinkMenu,
  linkedMenu,
  newSessionMenu,
  sessionLabel,
  subdirectoryMenu,
  unknownCommandMenu,
  unlinkedMenu,
  APPROVAL_ALLOWED_TEXT,
  APPROVAL_ELSEWHERE_TEXT,
  APPROVAL_EXPIRED_TEXT,
  APPROVAL_REJECTED_TEXT,
  APPROVAL_UNLINKED_TEXT,
  MENU_EXPIRED_NOTICE,
  MESSAGE_DISCARDED_TEXT,
  START_TEXT,
  type MenuView,
  type SessionChoice,
} from "./menus.ts";

export { PLATFORM };

/** How an album is named in its processing record and its dead letter. */
const ALBUM_KIND = "album";

/** The one reply every message outside the prompt path gets. */
const UNSUPPORTED_MESSAGE_FAILURE = "unsupported-message";

/** A backend message is quoted in a status line, not reproduced whole. */
const NOTICE_LIMIT = 500;

/** Every image buffer in the process, summed. */
const IMAGE_BUDGET_BYTES = 20 * 1024 * 1024;
/** How many threads may hold image budget at once. */
const MAX_IMAGE_THREADS = 4;

export const ALREADY_LINKED_NOTICE = "本 topic 已绑定 session，请先解除绑定。";
export const THREAD_CONFLICT_NOTICE = "本 topic 已绑定其他 session，两边绑定都未改动。";
export const SESSION_CONFLICT_NOTICE = "该 session 已绑定到其他 topic，两边绑定都未改动。";
export const SESSION_GONE_NOTICE = "该 session 已不存在。";
export const AMBIGUOUS_SESSION_NOTICE = "有多个 session 的编号结尾相同，无法确定绑定哪一个。";
export const ALIAS_GONE_NOTICE = "该工作目录已不在配置中。";
export const DIRECTORY_GONE_NOTICE = "该目录已不存在。";
export const AMBIGUOUS_DIRECTORY_NOTICE = "有多个目录的编号相同，无法确定新建在哪一个。";
export const DIRECTORY_OUTSIDE_NOTICE = "该目录已不在配置的工作目录内。";
export const RUNNING_NOTICE = "session 正在运行，无法解除绑定。";
export const UNLINKED_NOTICE = "已解除绑定，backend session 未删除。";
export const RESEND_NOTICE = "上次输入可能未送达，请重新发送。";
export const STEER_ACK_TEXT = "已插入当前回合。";
export const WARNING_PREFIX = "后端警告：";
export const ERROR_PREFIX = "后端错误：";

/** Says how much of a split result reached Telegram. Nothing is resent. */
export function partialResultText(sent: number, total: number): string {
  return `发送失败：已发送 ${sent}/${total}，其余未发送。`;
}

export interface BridgeRuntimeOptions {
  api: TelegramApi;
  backend: Backend;
  store: Store;
  /** Rechecked on every update, including every callback. */
  allowlist: Allowlist;
  /**
   * Alias -> resolved parent directory. A session is created in one of the
   * subdirectories of a root; only the alias and a directory name ever reach
   * Telegram.
   */
  cwdRoots: ReadonlyMap<string, string>;
  logger: Logger;
  /** Injected by tests so callback data is predictable. */
  epoch?: string;
  /**
   * The polling loop's controller. `shutdown` aborts it first, so no further
   * update is fetched while the work already admitted drains.
   */
  polling?: AbortController;
}

export interface ShutdownOptions {
  /** How long active work may run before the process gives up on it. */
  deadlineMs?: number;
  /** Bounded label for the log line. A signal name, or why the loop ended. */
  reason?: string;
}

export interface ShutdownOutcome {
  /** False when work was still running at the deadline. */
  readonly drained: boolean;
}

/**
 * One atomic input. `updateIds` is the processing unit: an album completes or
 * fails as the whole set of updates that made it, never as one of them.
 */
interface PromptInput {
  readonly thread: ThreadIdentity;
  readonly updateIds: readonly number[];
  readonly messages: readonly InboundMessage[];
}

/** One approval request and the message the user answers it in. */
interface PendingApproval {
  readonly requestId: string;
  readonly sessionId: string;
  readonly chatId: number;
  readonly threadId: number;
  /** Set once the backend has the decision, so a repeated tap converges. */
  outcome?: string;
}

/** What to show on the tapped button. An alert needs a tap to dismiss. */
interface Notice {
  readonly text: string;
  readonly alert?: boolean;
}

/** ADR 0003: how long shutdown waits for update, media, and send work. */
export const SHUTDOWN_DEADLINE_MS = 20_000;

export class BridgeRuntime {
  readonly epoch: string;

  readonly #api: TelegramApi;
  readonly #backend: Backend;
  readonly #store: Store;
  readonly #allowlist: Allowlist;
  readonly #cwdRoots: ReadonlyMap<string, string>;
  readonly #logger: Logger;
  readonly #polling: AbortController | undefined;
  /**
   * Cancels the runtime's own Telegram calls. It is aborted only after the
   * Store is closed, so a send that outlived the drain deadline cannot come
   * back, fail, and retire its own processing record.
   */
  readonly #work = new AbortController();
  readonly #signal = this.#work.signal;
  /** Cleared when shutdown starts. A later update is left for the next process. */
  #accepting = true;
  #shutdown: Promise<ShutdownOutcome> | undefined;
  /** Renders in flight. They start from backend events, not from the scheduler. */
  readonly #renders = new Set<Promise<void>>();
  /** Sessions mid-turn. Seeded from the backend, not from what the bridge sent. */
  readonly #active = new Set<string>();
  /** The live draft of each session that is streaming. */
  readonly #streams = new Map<string, TurnStream>();
  /** Album members waiting for their group to go quiet. */
  readonly #albums: AlbumCollector;
  /** Per-thread order and the global limit on how many threads run at once. */
  readonly #scheduler = new ThreadScheduler();
  /**
   * Approvals this process filed, by the short token its buttons carry.
   *
   * The map is the reason the token can stay short: the backend's request id
   * never has to fit in callback data. It lives exactly as long as the epoch
   * the buttons carry, so a restart retires both together.
   */
  readonly #approvals = new Map<string, PendingApproval>();
  #approvalTokens = 0;
  /** The one place image bytes are counted, across every thread. */
  readonly #budget = new MemorySemaphore({
    capacityBytes: IMAGE_BUDGET_BYTES,
    maxHolders: MAX_IMAGE_THREADS,
  });
  /** Telegram rejects a zero draft id, so the first turn gets 1. */
  #drafts = 0;

  constructor(options: BridgeRuntimeOptions) {
    this.#api = options.api;
    this.#backend = options.backend;
    this.#store = options.store;
    this.#allowlist = options.allowlist;
    this.#cwdRoots = options.cwdRoots;
    this.#logger = options.logger;
    this.#polling = options.polling;
    this.epoch = options.epoch ?? createEpoch();
    this.#albums = new AlbumCollector({ onSeal: (group) => this.#deliverAlbum(group) });
  }

  /**
   * Closes every album still collecting and waits for the prompts they start.
   *
   * `shutdown` seals the same way, except that it does not await the seal
   * before its deadline starts: the quiet window is a guess about the user, and
   * waiting it out would either delay the exit or lose the input.
   */
  async sealAlbums(): Promise<void> {
    await this.#albums.sealAll();
  }

  /**
   * Stops the bridge without losing work and without finishing it silently.
   *
   * The order is the contract:
   *
   *   1. Abort polling, so Telegram is asked for nothing more.
   *   2. Stop admitting updates. An update that arrives after this point gets
   *      no processing record and is never settled, so the next process polls
   *      it again from the unchanged checkpoint.
   *   3. Seal every open album at once. Its quiet window is a guess about the
   *      user, and waiting it out would either delay the exit or drop input.
   *   4. Wait out the work already admitted — updates, downloads, and sends —
   *      for at most `deadlineMs`.
   *   5. Close the Backend, then the Store, in that order: an event arriving
   *      after the database is gone would have nowhere to resolve its link.
   *
   * Work still running at the deadline keeps its processing record. Startup
   * recovery turns that record into a dead letter and asks the topic to resend,
   * which is the only honest outcome for an effect the bridge cannot prove.
   * That is also why the runtime's own Telegram calls are cancelled only after
   * the Store is closed: cancelling earlier would let a failing send reach its
   * retry limit and retire the record it is supposed to leave open.
   *
   * Calling it twice returns the first outcome; the caller decides what a
   * second signal means.
   */
  shutdown(options: ShutdownOptions = {}): Promise<ShutdownOutcome> {
    this.#shutdown ??= this.#runShutdown(options);
    return this.#shutdown;
  }

  async #runShutdown(options: ShutdownOptions): Promise<ShutdownOutcome> {
    const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
    this.#logger.info("bridge.shutdown.started", {
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      delayMs: deadlineMs,
    });
    this.#polling?.abort();
    this.#accepting = false;
    const sealed = this.#albums.sealAll();
    const drained = await this.#drainWork(sealed, deadlineMs);
    if (!drained) {
      // Named, not counted: the records left open are what startup recovery
      // reads, and it reports them one by one with their thread.
      this.#logger.error("bridge.shutdown.timeout", { delayMs: deadlineMs });
    }
    for (const sessionId of [...this.#streams.keys()]) this.#closeStream(sessionId);
    await this.#backend.close();
    this.#store.close();
    this.#work.abort();
    this.#logger.info("bridge.shutdown.finished", { reason: drained ? "drained" : "deadline" });
    return { drained };
  }

  /**
   * Waits for admitted work to stop, or for the deadline.
   *
   * Sealing an album queues a prompt, and a backend event can start a render
   * while the scheduler is emptying, so this loops until both are quiet rather
   * than taking one snapshot.
   */
  async #drainWork(sealed: Promise<void>, deadlineMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
    });
    const quiet = (async () => {
      await sealed;
      while (this.#scheduler.size > 0 || this.#renders.size > 0) {
        await Promise.all<unknown>([this.#scheduler.drain(), ...this.#renders]);
      }
      return true;
    })();
    try {
      return await Promise.race([quiet, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Subscribes to the backend and records which linked sessions are mid-turn.
   *
   * Running state comes from the backend because a turn may have been started
   * in dsh's own Web UI, before this process existed. Text arriving for such a
   * session must steer it, not queue a second prompt behind it.
   */
  async start(): Promise<void> {
    for (const session of await this.#backend.listSessions()) {
      if (session.running) this.#active.add(session.sessionId);
    }
    this.#backend.subscribe((event) => this.#onEvent(event));
  }

  /**
   * Startup housekeeping.
   *
   * Everything still marked processing crashed mid-flight, and the bridge
   * cannot prove which external effect completed, so it is isolated instead of
   * retried and its topic is asked to send the input again. Dead letters past
   * their retention window go at the same time.
   */
  async recover(): Promise<void> {
    const notified = new Set<string>();
    for (const record of this.#store.recoverProcessing()) {
      this.#logger.info("bridge.update.recovered", {
        updateId: record.updateId,
        threadId: record.threadId,
        attempt: record.attempts,
      });
      const thread: ThreadIdentity = { chatId: record.chatId, threadId: record.threadId };
      const key = threadKey(thread);
      // An album is several records; the topic still lost one input.
      if (!isPrivateTopic(thread) || notified.has(key)) continue;
      notified.add(key);
      // A private chat's id is the user's id, so the allowlist decides here
      // too: a record left by an earlier configuration must not be answered.
      if (!this.#allowlist.permits(thread.chatId)) {
        this.#logger.info("bridge.resend.skipped", {
          updateId: record.updateId,
          threadId: record.threadId,
          reason: "unauthorised",
        });
        continue;
      }
      await this.#notify(thread, RESEND_NOTICE);
    }
    const purged = this.#store.purgeDeadLetters();
    if (purged > 0) this.#logger.info("bridge.deadletters.purged", { count: purged });
  }

  /**
   * The polling loop already filtered this update, but the checks are cheap and
   * the cost of trusting a caller here is the machine's shell, so both the
   * allowlist and the private-topic shape are proved again.
   *
   * A dropped update is settled here: nothing else will finish it, and the
   * checkpoint has to be able to move past it. An accepted one is recorded and
   * queued before this returns, so the caller's order is the order its thread
   * runs, and the returned promise settles when the update needs no further
   * polling protection.
   */
  async handleUpdate(update: InboundUpdate): Promise<void> {
    if (!this.#allowlist.permits(update.userId)) {
      this.#logger.debug("bridge.update.dropped", { updateId: update.updateId, reason: "unauthorised" });
      this.#store.settleUpdates([update.updateId]);
      return;
    }
    if (!isPrivateTopic(update.thread)) {
      this.#logger.debug("bridge.update.dropped", { updateId: update.updateId, reason: "not-topic" });
      this.#store.settleUpdates([update.updateId]);
      return;
    }
    if (!this.#accepting) {
      // Deliberately neither recorded nor settled: with no processing record
      // the checkpoint stays where it was, so the next process polls this
      // update again instead of recovering a unit that never started.
      this.#logger.info("bridge.update.rejected", {
        updateId: update.updateId,
        threadId: update.thread.threadId,
        reason: "shutting-down",
      });
      return;
    }
    const unit: ProcessingUnit = {
      updateIds: [update.updateId],
      kind: unitKind(update),
      thread: update.thread,
    };
    markQueued(this.#store, unit);
    await this.#scheduler.run(threadKey(update.thread), () => this.#runUpdate(update, unit));
  }

  /**
   * One update, on its thread's turn.
   *
   * An album member is not a unit of its own: it joins its group and settles
   * with it, so the whole album completes or is isolated as one input. The
   * record opened at dispatch stays open until then, which is what keeps the
   * checkpoint behind an album that is still filling.
   */
  async #runUpdate(update: InboundUpdate, unit: ProcessingUnit): Promise<void> {
    if (update.kind === "message" && update.mediaGroupId !== undefined && this.#collects(update)) {
      this.#albums.add(update.mediaGroupId, update);
      return;
    }
    await runProcessing({ store: this.#store, logger: this.#logger }, unit, (progress) => {
      if (update.kind === "callback") return this.#handleCallback(update, progress);
      if (update.kind === "unsupported") return this.#handleUnsupported(update);
      return this.#handleMessage(update, progress);
    });
  }

  /** An album member collects only while it is a prompt for a linked session. */
  #collects(update: InboundMessage): boolean {
    return readCommand(update.text) === undefined && this.#linkOf(update.thread) !== undefined;
  }

  async #handleMessage(update: InboundMessage, progress: UpdateProgress): Promise<void> {
    const command = readCommand(update.text);
    if (command === "/start") {
      await this.#send(update.thread, { text: START_TEXT, keyboard: [] }, progress);
      return;
    }
    if (command === "/manage") {
      await this.#send(update.thread, await this.#menuFor(update.thread), progress);
      return;
    }
    if (command !== undefined) {
      await this.#send(update.thread, unknownCommandMenu(this.epoch), progress);
      return;
    }
    const link = this.#linkOf(update.thread);
    if (link !== undefined) {
      const input = { thread: update.thread, updateIds: [update.updateId], messages: [update] };
      await this.#deliverInput(input, link, progress);
      return;
    }
    // The body is dropped rather than queued: it was written for a session that
    // does not exist yet, and holding it would send it to whichever session the
    // user later picks.
    this.#logger.info("bridge.message.discarded", {
      updateId: update.updateId,
      threadId: update.thread.threadId,
    });
    await this.#send(update.thread, unlinkedMenu(this.epoch, MESSAGE_DISCARDED_TEXT), progress);
  }

  /**
   * Media the prompt path cannot carry.
   *
   * The reply is the whole outcome: nothing is downloaded, nothing reaches the
   * backend, and the caption travelling with the media is never read. Sending
   * it takes no processing step, because a repeat of this notice is harmless
   * and the unit has no other effect to resume.
   */
  async #handleUnsupported(update: InboundUnsupported): Promise<void> {
    this.#logger.info("bridge.prompt.rejected", {
      updateId: update.updateId,
      threadId: update.thread.threadId,
      reason: UNSUPPORTED_MESSAGE_FAILURE,
    });
    await this.#notify(update.thread, mediaNotice(UNSUPPORTED_MESSAGE_FAILURE));
  }

  /**
   * One complete album, resolved against the link it has now.
   *
   * The seal runs on a timer rather than inside `handleUpdate`, so nothing is
   * left to report a failure: this is the last place that can, and it must not
   * reject.
   */
  async #deliverAlbum(group: AlbumGroup): Promise<void> {
    const unit: ProcessingUnit = {
      updateIds: group.updateIds,
      kind: ALBUM_KIND,
      thread: group.thread,
    };
    try {
      await this.#scheduler.run(threadKey(group.thread), async () => {
        const link = this.#linkOf(group.thread);
        if (link === undefined) {
          // The topic was unlinked while the album was still arriving.
          this.#logger.info("bridge.album.dropped", {
            threadId: group.thread.threadId,
            count: group.updateIds.length,
          });
          this.#store.settleUpdates(group.updateIds);
          return;
        }
        await runProcessing({ store: this.#store, logger: this.#logger }, unit, (progress) =>
          this.#deliverInput(group, link, progress),
        );
      });
    } catch (error) {
      this.#logger.error("bridge.prompt.failed", {
        threadId: group.thread.threadId,
        count: group.updateIds.length,
        errorSummary: error instanceof Error ? error.name : undefined,
      });
    }
  }

  /**
   * One atomic input: a message, or a whole album.
   *
   * The plan is built before any byte is fetched, so an input that cannot work
   * costs nothing and is reported once. Images are downloaded under a global
   * memory reservation that is released only after the backend has taken the
   * content — the buffers live exactly as long as the reservation says.
   */
  async #deliverInput(input: PromptInput, link: Link, progress: UpdateProgress): Promise<void> {
    let plan: PromptPlan;
    try {
      plan = planPrompt(input.messages);
    } catch (error) {
      await this.#reportMedia(input, error);
      return;
    }
    if (plan.images.length === 0) {
      if (plan.text === "") {
        this.#logger.info("bridge.prompt.unsupported", {
          updateId: input.updateIds[0],
          threadId: input.thread.threadId,
        });
        return;
      }
      await this.#sendContent(input, link, [{ type: "text", text: plan.text }], progress);
      return;
    }
    const release = await this.#budget.acquire(plan.weightBytes);
    try {
      let images: PromptContent;
      try {
        images = await downloadImages(this.#api, plan.images, this.#signal);
      } catch (error) {
        await this.#reportMedia(input, error);
        return;
      }
      await this.#sendContent(input, link, [{ type: "text", text: plan.text }, ...images], progress);
    } finally {
      release();
    }
  }

  /**
   * Sends one input to the session this thread holds.
   *
   * An idle session starts a turn and says nothing: the draft is the feedback,
   * and a separate "started" message would only push it out of view. A running
   * session is steered instead, because a second prompt would queue behind the
   * work the user is trying to redirect, and steering is confirmed because
   * nothing else marks it as accepted.
   */
  async #sendContent(
    input: PromptInput,
    link: Link,
    content: PromptContent,
    progress: UpdateProgress,
  ): Promise<void> {
    if (progress.step === STEP_PROMPT_SENT) {
      // An earlier attempt already handed this input to the backend. Sending
      // it again would run the agent twice on one message.
      return;
    }
    const imageCount = content.filter((part) => part.type === "image").length;
    if (this.#active.has(link.sessionId)) {
      await this.#backend.steer(link.sessionId, content);
      progress.advance({ step: STEP_PROMPT_SENT, sessionId: link.sessionId });
      this.#logger.info("bridge.turn.steered", {
        threadId: input.thread.threadId,
        sessionId: link.sessionId,
        imageCount,
      });
      await this.#notify(input.thread, STEER_ACK_TEXT);
      return;
    }
    await this.#backend.sendPrompt(link.sessionId, content);
    progress.advance({ step: STEP_PROMPT_SENT, sessionId: link.sessionId });
    this.#active.add(link.sessionId);
    this.#logger.info("bridge.turn.started", {
      threadId: input.thread.threadId,
      sessionId: link.sessionId,
      imageCount,
    });
  }

  /** One rejected input produces one short reply, whatever failed inside it. */
  async #reportMedia(input: PromptInput, error: unknown): Promise<void> {
    if (!(error instanceof MediaError)) throw error;
    this.#logger.info("bridge.prompt.rejected", {
      threadId: input.thread.threadId,
      reason: error.failure,
      count: input.updateIds.length,
    });
    await this.#notify(input.thread, mediaNotice(error.failure));
  }

  /**
   * One backend event.
   *
   * Running state is updated first: it describes the session, not the topic,
   * so it stays correct even for a session no thread holds. The destination is
   * then resolved through the link
   * as it stands right now: a topic may have been unlinked or rebound while the
   * session was working, and output must never land where it no longer belongs.
   */
  async #onEvent(event: BackendEvent): Promise<void> {
    if (event.type === "turn-end" || event.type === "error") this.#active.delete(event.sessionId);
    if (event.type === "output" || event.type === "thinking") this.#active.add(event.sessionId);
    const link = this.#store.findBySession(this.#backend.name, event.sessionId);
    if (link === undefined) {
      this.#closeStream(event.sessionId);
      if (event.type === "approval") {
        // Left pending on purpose: another dsh client can still answer it, and
        // an unlinked topic is not a reason to reject on the user's behalf.
        this.#logger.info("bridge.approval.unlinked", { sessionId: event.sessionId });
        return;
      }
      this.#logger.info("bridge.event.dropped", { sessionId: event.sessionId, reason: event.type });
      return;
    }
    // Tracked, because a render is send work the scheduler never sees: it
    // starts from a backend event, and shutdown has to wait for it too.
    const render: Promise<void> = this.#render(event, link)
      .catch((error: unknown) => {
        // The backend adapter swallows a failing handler, so a failure that
        // got this far is reported here or nowhere.
        this.#logger.error("bridge.event.failed", {
          sessionId: event.sessionId,
          threadId: link.threadId,
          reason: event.type,
          errorSummary: failureSummary(error),
        });
      })
      .finally(() => {
        this.#renders.delete(render);
      });
    this.#renders.add(render);
    await render;
  }

  async #render(event: BackendEvent, link: Link): Promise<void> {
    const thread: ThreadIdentity = { chatId: link.chatId, threadId: link.threadId };
    switch (event.type) {
      case "thinking":
        this.#streamFor(link).pushThinking(event.text);
        return;
      case "output":
        this.#streamFor(link).pushOutput(event.text);
        return;
      case "warning":
        await this.#notify(thread, `${WARNING_PREFIX}${headChars(event.message, NOTICE_LIMIT)}`);
        return;
      case "error":
        this.#closeStream(event.sessionId);
        await this.#notify(thread, `${ERROR_PREFIX}${headChars(event.message, NOTICE_LIMIT)}`);
        return;
      case "turn-end":
        this.#closeStream(event.sessionId);
        await this.#deliverResult(thread, event.text);
        return;
      case "approval":
        await this.#askApproval(event.requestId, event.prompt, link);
        return;
    }
  }

  /**
   * Asks the linked topic to decide one approval.
   *
   * The buttons carry a token, not the backend's request id: the id is
   * whatever dsh chose and has no size limit, while callback data has 64
   * bytes. The token resolves through a map that dies with this process,
   * which is the same lifetime the epoch already gives the buttons.
   */
  async #askApproval(requestId: string, prompt: string, link: Link): Promise<void> {
    this.#approvalTokens += 1;
    const token = this.#approvalTokens.toString(36);
    const view = approvalMenu(this.epoch, token, prompt);
    const messageId = await this.#api.sendMessage({
      chatId: link.chatId,
      threadId: link.threadId,
      text: view.text,
      replyMarkup: view.keyboard,
      signal: this.#signal,
    });
    this.#approvals.set(token, {
      requestId,
      sessionId: link.sessionId,
      chatId: link.chatId,
      threadId: link.threadId,
    });
    this.#logger.info("bridge.approval.sent", {
      sessionId: link.sessionId,
      threadId: link.threadId,
      messageId,
    });
  }

  /**
   * Persists the result of a turn.
   *
   * `turn-end.text` is the only source read here: the draft accumulated a
   * preview that Telegram pacing and backend buffering are both allowed to
   * thin out, so reading it back could publish a shortened answer. A failed
   * part stops the sequence, because resending would duplicate whatever
   * already reached Telegram, and the backend turn is never repeated.
   */
  async #deliverResult(thread: ThreadIdentity, text: string): Promise<void> {
    if (text.trim() === "") {
      this.#logger.info("bridge.result.empty", { threadId: thread.threadId });
      return;
    }
    const parts = splitFinalMarkdown(text);
    for (const [index, part] of parts.entries()) {
      try {
        await this.#api.sendRichMessage({
          chatId: thread.chatId,
          threadId: thread.threadId,
          markdown: part,
          signal: this.#signal,
        });
      } catch (error) {
        this.#logger.error("bridge.result.failed", {
          threadId: thread.threadId,
          count: index,
          errorCode: error instanceof TelegramApiError ? error.errorCode : undefined,
          errorSummary: error instanceof TelegramApiError ? error.description : undefined,
        });
        await this.#notify(thread, partialResultText(index, parts.length));
        return;
      }
    }
    this.#logger.info("bridge.result.sent", { threadId: thread.threadId, count: parts.length });
  }

  /** The draft of this session, moved to the topic the link names today. */
  #streamFor(link: Link): TurnStream {
    const existing = this.#streams.get(link.sessionId);
    if (existing !== undefined) {
      if (existing.chatId === link.chatId && existing.threadId === link.threadId) return existing;
      // The topic changed under the turn; that draft has nowhere left to land.
      existing.close();
    }
    this.#drafts += 1;
    const stream = new TurnStream({
      api: this.#api,
      chatId: link.chatId,
      threadId: link.threadId,
      draftId: this.#drafts,
      sessionId: link.sessionId,
      logger: this.#logger,
      signal: this.#signal,
    });
    this.#streams.set(link.sessionId, stream);
    return stream;
  }

  #closeStream(sessionId: string): void {
    this.#streams.get(sessionId)?.close();
    this.#streams.delete(sessionId);
  }

  /** A short status line. Failing to deliver it must not fail the event. */
  async #notify(thread: ThreadIdentity, text: string): Promise<void> {
    try {
      await this.#api.sendMessage({
        chatId: thread.chatId,
        threadId: thread.threadId,
        text,
        signal: this.#signal,
      });
    } catch (error) {
      this.#logger.error("bridge.notice.failed", {
        threadId: thread.threadId,
        errorCode: error instanceof TelegramApiError ? error.errorCode : undefined,
        errorSummary: error instanceof TelegramApiError ? error.description : undefined,
      });
    }
  }

  async #handleCallback(update: InboundCallback, progress: UpdateProgress): Promise<void> {
    const callback = decodeCallback(update.data);
    if (callback === undefined || callback.epoch !== this.epoch) {
      // A button drawn by an earlier process. Its list is gone, so the menu is
      // retired instead of being applied to today's state.
      this.#logger.info("bridge.callback.expired", {
        updateId: update.updateId,
        threadId: update.thread.threadId,
      });
      await this.#edit(update, expiredMenu(), progress);
      await this.#answer(update, { text: MENU_EXPIRED_NOTICE });
      return;
    }
    this.#logger.debug("bridge.callback", {
      updateId: update.updateId,
      threadId: update.thread.threadId,
      action: callback.action.kind,
    });
    const notice = await this.#apply(update, callback.action, progress);
    await this.#answer(update, notice);
  }

  async #apply(
    update: InboundCallback,
    action: CallbackAction,
    progress: UpdateProgress,
  ): Promise<Notice | undefined> {
    if (action.kind === "close") {
      await this.#api.editMessageReplyMarkup({
        chatId: update.thread.chatId,
        messageId: update.messageId,
        signal: this.#signal,
      });
      return undefined;
    }
    if (action.kind === "manage") {
      await this.#edit(update, await this.#menuFor(update.thread), progress);
      return undefined;
    }
    if (action.kind === "new") return this.#openNewSession(update, progress);
    if (action.kind === "existing") return this.#openExistingSessions(update, action.page, progress);
    if (action.kind === "root") return this.#openRoot(update, action.alias, action.page, progress);
    if (action.kind === "create") {
      return this.#createSession(update, action.alias, action.digest, progress);
    }
    if (action.kind === "bind") return this.#bindSession(update, action.sessionSuffix, progress);
    if (action.kind === "allow" || action.kind === "reject") {
      return this.#answerApproval(update, action.token, action.kind === "allow", progress);
    }
    return this.#unlinkSession(update, progress);
  }

  /**
   * One tap on an approval.
   *
   * Everything the button asserted is proved again: the process that drew it
   * (the epoch, already checked), the request it names, the topic it was asked
   * in, and the link that topic holds now. A tap whose link is gone leaves the
   * request pending for another dsh client — the bridge never turns a missing
   * link into a rejection.
   */
  async #answerApproval(
    update: InboundCallback,
    token: string,
    approved: boolean,
    progress: UpdateProgress,
  ): Promise<Notice | undefined> {
    const pending = this.#approvals.get(token);
    if (pending === undefined) {
      await this.#edit(update, approvalResolvedMenu(APPROVAL_EXPIRED_TEXT), progress);
      return { text: APPROVAL_EXPIRED_TEXT };
    }
    if (pending.outcome !== undefined) {
      // The backend already has the decision; a second tap only redraws it.
      await this.#edit(update, approvalResolvedMenu(pending.outcome), progress);
      return { text: pending.outcome };
    }
    const link = this.#linkOf(update.thread);
    if (
      update.thread.chatId !== pending.chatId
      || update.thread.threadId !== pending.threadId
      || link === undefined
      || link.sessionId !== pending.sessionId
    ) {
      this.#logger.info("bridge.approval.unlinked", {
        sessionId: pending.sessionId,
        threadId: update.thread.threadId,
      });
      await this.#edit(update, approvalResolvedMenu(APPROVAL_UNLINKED_TEXT), progress);
      return { text: APPROVAL_UNLINKED_TEXT, alert: true };
    }
    const outcome = await this.#respondApproval(pending, approved);
    pending.outcome = outcome;
    progress.advance({ step: STEP_APPROVAL_ANSWERED });
    await this.#edit(update, approvalResolvedMenu(outcome), progress);
    this.#logger.info("bridge.approval.resolved", {
      sessionId: pending.sessionId,
      threadId: pending.threadId,
      reason: outcome,
    });
    return { text: outcome };
  }

  /** The decision the user made, or the news that someone else made it. */
  async #respondApproval(pending: PendingApproval, approved: boolean): Promise<string> {
    try {
      await this.#backend.respondApproval(pending.requestId, approved);
    } catch (error) {
      // dsh broadcasts every approval and the first answer wins, so the
      // adapter forgets a request as soon as any client resolves it and
      // reports the next answer as an unknown request. Losing that race is a
      // normal outcome of a shared approval, not a failure to report.
      if (!(error instanceof ApprovalNotPendingError)) throw error;
      this.#logger.info("bridge.approval.lost", { sessionId: pending.sessionId });
      return APPROVAL_ELSEWHERE_TEXT;
    }
    return approved ? APPROVAL_ALLOWED_TEXT : APPROVAL_REJECTED_TEXT;
  }

  async #openNewSession(update: InboundCallback, progress: UpdateProgress): Promise<Notice | undefined> {
    if (this.#linkOf(update.thread) !== undefined) {
      await this.#edit(update, await this.#menuFor(update.thread), progress);
      return { text: ALREADY_LINKED_NOTICE };
    }
    const aliases = [...this.#cwdRoots.keys()];
    // One configured root is not a choice: the directories under it are.
    const only = aliases.length === 1 ? aliases[0] : undefined;
    if (only !== undefined) return this.#openRoot(update, only, 0, progress);
    await this.#edit(update, newSessionMenu(this.epoch, aliases), progress);
    return undefined;
  }

  /**
   * One page of the subdirectories of a root, read now rather than remembered.
   * A project added or removed on disk shows up on the next tap.
   */
  async #openRoot(
    update: InboundCallback,
    alias: string,
    page: number,
    progress: UpdateProgress,
  ): Promise<Notice | undefined> {
    if (this.#linkOf(update.thread) !== undefined) {
      await this.#edit(update, await this.#menuFor(update.thread), progress);
      return { text: ALREADY_LINKED_NOTICE };
    }
    const root = this.#cwdRoots.get(alias);
    if (root === undefined) {
      await this.#edit(update, newSessionMenu(this.epoch, [...this.#cwdRoots.keys()]), progress);
      return { text: ALIAS_GONE_NOTICE, alert: true };
    }
    const choices = await listSubdirectories(root);
    await this.#edit(update, subdirectoryMenu(this.epoch, alias, choices, page), progress);
    return undefined;
  }

  async #openExistingSessions(
    update: InboundCallback,
    page: number,
    progress: UpdateProgress,
  ): Promise<Notice | undefined> {
    if (this.#linkOf(update.thread) !== undefined) {
      await this.#edit(update, await this.#menuFor(update.thread), progress);
      return { text: ALREADY_LINKED_NOTICE };
    }
    const choices = this.#choices(await this.#backend.listSessions());
    await this.#edit(update, existingSessionsMenu(this.epoch, choices, page), progress);
    return undefined;
  }

  /**
   * The tapped directory becomes a cwd only if it is still one: the listing is
   * read again, the digest must match exactly one name, and that name has to
   * resolve inside its root. Nothing the button asserted is taken on trust.
   */
  async #createSession(
    update: InboundCallback,
    alias: string,
    digest: string,
    progress: UpdateProgress,
  ): Promise<Notice | undefined> {
    const root = this.#cwdRoots.get(alias);
    if (root === undefined) {
      await this.#edit(update, newSessionMenu(this.epoch, [...this.#cwdRoots.keys()]), progress);
      return { text: ALIAS_GONE_NOTICE, alert: true };
    }
    if (this.#linkOf(update.thread) !== undefined) {
      // A second tap must not create a second session.
      await this.#edit(update, await this.#menuFor(update.thread), progress);
      return { text: ALREADY_LINKED_NOTICE };
    }
    // A retry binds the session the earlier attempt created; asking the
    // backend again would leave an orphan session behind.
    let sessionId = progress.sessionId;
    if (sessionId === undefined) {
      const choices = await listSubdirectories(root);
      const matches = choices.filter((choice) => choice.digest === digest);
      const chosen = matches.length === 1 ? matches[0] : undefined;
      if (chosen === undefined) {
        await this.#edit(update, subdirectoryMenu(this.epoch, alias, choices, 0), progress);
        return {
          text: matches.length === 0 ? DIRECTORY_GONE_NOTICE : AMBIGUOUS_DIRECTORY_NOTICE,
          alert: true,
        };
      }
      const cwd = await resolveInsideRoot(root, chosen.name);
      if (cwd === undefined) {
        await this.#edit(update, subdirectoryMenu(this.epoch, alias, choices, 0), progress);
        return { text: DIRECTORY_OUTSIDE_NOTICE, alert: true };
      }
      sessionId = await this.#backend.createSession(cwd);
      progress.advance({ step: STEP_SESSION_CREATED, sessionId });
    }
    const notice = this.#link(update.thread, sessionId);
    await this.#edit(update, await this.#menuFor(update.thread), progress);
    return notice;
  }

  async #bindSession(
    update: InboundCallback,
    suffix: string,
    progress: UpdateProgress,
  ): Promise<Notice | undefined> {
    const link = this.#linkOf(update.thread);
    if (link !== undefined) {
      await this.#edit(update, await this.#menuFor(update.thread), progress);
      // The same button tapped twice asks for a link that already exists.
      return sessionSuffix(link.sessionId) === suffix ? undefined : { text: THREAD_CONFLICT_NOTICE, alert: true };
    }
    const sessions = await this.#backend.listSessions();
    const matches = sessions.filter((session) => sessionSuffix(session.sessionId) === suffix);
    const session = matches.length === 1 ? matches[0] : undefined;
    if (session === undefined) {
      await this.#edit(update, existingSessionsMenu(this.epoch, this.#choices(sessions), 0), progress);
      return { text: matches.length === 0 ? SESSION_GONE_NOTICE : AMBIGUOUS_SESSION_NOTICE, alert: true };
    }
    const notice = this.#link(update.thread, session.sessionId);
    await this.#edit(update, await this.#menuFor(update.thread), progress);
    return notice;
  }

  async #unlinkSession(update: InboundCallback, progress: UpdateProgress): Promise<Notice | undefined> {
    const link = this.#linkOf(update.thread);
    if (link === undefined) {
      await this.#edit(update, unlinkedMenu(this.epoch), progress);
      return undefined;
    }
    const sessions = await this.#backend.listSessions();
    const session = sessions.find((candidate) => candidate.sessionId === link.sessionId);
    if (session?.running === true) {
      // Dropping the link mid-turn would leave the output with nowhere to land.
      await this.#edit(update, linkedMenu(this.epoch, this.#label(session), true), progress);
      return { text: RUNNING_NOTICE, alert: true };
    }
    this.#store.unlink(PLATFORM, update.thread.chatId, update.thread.threadId);
    this.#logger.info("bridge.link.removed", {
      threadId: update.thread.threadId,
      sessionId: link.sessionId,
    });
    await this.#edit(update, unlinkedMenu(this.epoch), progress);
    return { text: UNLINKED_NOTICE };
  }

  /** Writes the link, or reports which side was already taken. */
  #link(thread: ThreadIdentity, sessionId: string): Notice | undefined {
    try {
      this.#store.link({
        platform: PLATFORM,
        chatId: thread.chatId,
        threadId: thread.threadId,
        backend: this.#backend.name,
        sessionId,
      });
    } catch (error) {
      if (!(error instanceof LinkConflictError)) throw error;
      // Neither link changed: the store refuses before it writes.
      return {
        text: error.reason === "thread" ? THREAD_CONFLICT_NOTICE : SESSION_CONFLICT_NOTICE,
        alert: true,
      };
    }
    this.#logger.info("bridge.link.created", { threadId: thread.threadId, sessionId });
    return undefined;
  }

  /** The menu that matches the state of this topic right now. */
  async #menuFor(thread: ThreadIdentity): Promise<MenuView> {
    const link = this.#linkOf(thread);
    if (link === undefined) return unlinkedMenu(this.epoch);
    const sessions = await this.#backend.listSessions();
    const session = sessions.find((candidate) => candidate.sessionId === link.sessionId);
    if (session === undefined) return invalidLinkMenu(this.epoch, sessionSuffix(link.sessionId));
    return linkedMenu(this.epoch, this.#label(session), session.running);
  }

  /** Sessions no thread holds. A bound session is never offered again. */
  #choices(sessions: readonly Session[]): SessionChoice[] {
    return sessions
      .filter((session) => this.#store.findBySession(this.#backend.name, session.sessionId) === undefined)
      .map((session) => ({ sessionId: session.sessionId, label: this.#label(session) }));
  }

  #label(session: Session): string {
    return sessionLabel(session, this.#cwdName(session.cwd));
  }

  /**
   * Maps a real cwd back to the root alias and directory name it sits under.
   * A cwd no configured root covers gets no name at all; paths stay local.
   */
  #cwdName(cwd: string | undefined): string | undefined {
    if (cwd === undefined) return undefined;
    for (const [alias, root] of this.#cwdRoots) {
      const name = directoryLabel(alias, root, cwd);
      if (name !== undefined) return name;
    }
    return undefined;
  }

  #linkOf(thread: ThreadIdentity): Link | undefined {
    return this.#store.findByThread(PLATFORM, thread.chatId, thread.threadId);
  }

  async #send(thread: ThreadIdentity, view: MenuView, progress: UpdateProgress): Promise<void> {
    const messageId = await this.#api.sendMessage({
      chatId: thread.chatId,
      threadId: thread.threadId,
      text: view.text,
      ...(view.keyboard.length === 0 ? {} : { replyMarkup: view.keyboard }),
      signal: this.#signal,
    });
    progress.advance({ step: STEP_MESSAGE_SENT, messageId });
  }

  /** Every callback ends by editing the menu it came from into current state. */
  async #edit(update: InboundCallback, view: MenuView, progress: UpdateProgress): Promise<void> {
    await this.#api.editMessageText({
      chatId: update.thread.chatId,
      messageId: update.messageId,
      text: view.text,
      replyMarkup: view.keyboard,
      signal: this.#signal,
    });
    progress.advance({ step: STEP_MESSAGE_EDITED, messageId: update.messageId });
  }

  async #answer(update: InboundCallback, notice: Notice | undefined): Promise<void> {
    await this.#api.answerCallbackQuery({
      callbackId: update.callbackId,
      ...(notice === undefined ? {} : { text: notice.text }),
      ...(notice?.alert === true ? { showAlert: true } : {}),
      signal: this.#signal,
    });
  }
}

/**
 * What this update's processing unit is called.
 *
 * A member of a media group is recorded as `album` from the start, because the
 * unit it joins is the album: a crash before the group seals would otherwise
 * leave a dead letter that calls a whole album one message.
 */
function unitKind(update: InboundUpdate): string {
  return update.kind === "message" && update.mediaGroupId !== undefined ? ALBUM_KIND : update.kind;
}

/** One thread's lane in the scheduler, and its key in a notice set. */
function threadKey(thread: ThreadIdentity): string {
  return `${String(thread.chatId)}:${String(thread.threadId)}`;
}

/**
 * The normalized update already proves the chat was private; what is proved
 * again here is that the update names a topic, because the bridge answers
 * nowhere else.
 */
function isPrivateTopic(thread: ThreadIdentity): boolean {
  return Number.isSafeInteger(thread.chatId) && Number.isSafeInteger(thread.threadId) && thread.threadId > 0;
}

/** The leading `/word` of a message, without the `@bot` suffix Telegram adds. */
function readCommand(text: string | undefined): string | undefined {
  if (text === undefined || !text.startsWith("/")) return undefined;
  const token = text.split(/\s/u)[0] ?? "";
  const at = token.indexOf("@");
  return (at < 0 ? token : token.slice(0, at)).toLowerCase();
}
