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
 *     backend's sessions, and the configured aliases before it acts, and then
 *     edits that same menu into whatever it found. A repeated tap therefore
 *     converges instead of duplicating.
 *   - The bridge never rebinds and never deletes on the user's behalf.
 *     `Store.link` refuses an occupied side, an active session refuses an
 *     unlink, and unlinking leaves the backend session alone.
 *
 * Text in a linked topic becomes a prompt in a later ticket; here it is logged.
 */
import type { Backend, Session } from "../backends/types.ts";
import type { Logger } from "../log.ts";
import { LinkConflictError, type Link, type Store } from "../store/store.ts";
import type { Allowlist } from "../telegram/allowlist.ts";
import type { TelegramApi } from "../telegram/api.ts";
import type { InboundCallback, InboundMessage, InboundUpdate, ThreadIdentity } from "../telegram/updates.ts";
import { createEpoch, decodeCallback, sessionSuffix, type CallbackAction } from "./callbacks.ts";
import {
  existingSessionsMenu,
  expiredMenu,
  invalidLinkMenu,
  linkedMenu,
  newSessionMenu,
  sessionLabel,
  unknownCommandMenu,
  unlinkedMenu,
  MENU_EXPIRED_NOTICE,
  MESSAGE_DISCARDED_TEXT,
  START_TEXT,
  type MenuView,
  type SessionChoice,
} from "./menus.ts";

/** The one platform this bridge speaks, as stored in the link table. */
export const PLATFORM = "telegram";

export const ALREADY_LINKED_NOTICE = "本 topic 已绑定 session，请先解除绑定。";
export const THREAD_CONFLICT_NOTICE = "本 topic 已绑定其他 session，两边绑定都未改动。";
export const SESSION_CONFLICT_NOTICE = "该 session 已绑定到其他 topic，两边绑定都未改动。";
export const SESSION_GONE_NOTICE = "该 session 已不存在。";
export const AMBIGUOUS_SESSION_NOTICE = "有多个 session 的编号结尾相同，无法确定绑定哪一个。";
export const ALIAS_GONE_NOTICE = "该工作目录已不在配置中。";
export const RUNNING_NOTICE = "session 正在运行，无法解除绑定。";
export const UNLINKED_NOTICE = "已解除绑定，backend session 未删除。";

export interface BridgeRuntimeOptions {
  api: TelegramApi;
  backend: Backend;
  store: Store;
  /** Rechecked on every update, including every callback. */
  allowlist: Allowlist;
  /** Alias -> resolved directory. Only the alias ever reaches Telegram. */
  cwdAliases: ReadonlyMap<string, string>;
  logger: Logger;
  /** Injected by tests so callback data is predictable. */
  epoch?: string;
  /** Aborting stops in-flight Telegram calls during shutdown. */
  signal?: AbortSignal;
}

/** What to show on the tapped button. An alert needs a tap to dismiss. */
interface Notice {
  readonly text: string;
  readonly alert?: boolean;
}

export class BridgeRuntime {
  readonly epoch: string;

  readonly #api: TelegramApi;
  readonly #backend: Backend;
  readonly #store: Store;
  readonly #allowlist: Allowlist;
  readonly #cwdAliases: ReadonlyMap<string, string>;
  readonly #logger: Logger;
  readonly #signal: AbortSignal | undefined;

  constructor(options: BridgeRuntimeOptions) {
    this.#api = options.api;
    this.#backend = options.backend;
    this.#store = options.store;
    this.#allowlist = options.allowlist;
    this.#cwdAliases = options.cwdAliases;
    this.#logger = options.logger;
    this.#signal = options.signal;
    this.epoch = options.epoch ?? createEpoch();
  }

  /**
   * The polling loop already filtered this update, but the checks are cheap and
   * the cost of trusting a caller here is the machine's shell, so both the
   * allowlist and the private-topic shape are proved again.
   */
  async handleUpdate(update: InboundUpdate): Promise<void> {
    if (!this.#allowlist.permits(update.userId)) {
      this.#logger.debug("bridge.update.dropped", { updateId: update.updateId, reason: "unauthorised" });
      return;
    }
    if (!isPrivateTopic(update.thread)) {
      this.#logger.debug("bridge.update.dropped", { updateId: update.updateId, reason: "not-topic" });
      return;
    }
    if (update.kind === "callback") {
      await this.#handleCallback(update);
      return;
    }
    await this.#handleMessage(update);
  }

  async #handleMessage(update: InboundMessage): Promise<void> {
    const command = readCommand(update.text);
    if (command === "/start") {
      await this.#send(update.thread, { text: START_TEXT, keyboard: [] });
      return;
    }
    if (command === "/manage") {
      await this.#send(update.thread, await this.#menuFor(update.thread));
      return;
    }
    if (command !== undefined) {
      await this.#send(update.thread, unknownCommandMenu(this.epoch));
      return;
    }
    if (this.#linkOf(update.thread) !== undefined) {
      // Turning a message into a prompt belongs to the turn runtime.
      this.#logger.debug("bridge.message.linked", {
        updateId: update.updateId,
        threadId: update.thread.threadId,
      });
      return;
    }
    // The body is dropped rather than queued: it was written for a session that
    // does not exist yet, and holding it would send it to whichever session the
    // user later picks.
    this.#logger.info("bridge.message.discarded", {
      updateId: update.updateId,
      threadId: update.thread.threadId,
    });
    await this.#send(update.thread, unlinkedMenu(this.epoch, MESSAGE_DISCARDED_TEXT));
  }

  async #handleCallback(update: InboundCallback): Promise<void> {
    const callback = decodeCallback(update.data);
    if (callback === undefined || callback.epoch !== this.epoch) {
      // A button drawn by an earlier process. Its list is gone, so the menu is
      // retired instead of being applied to today's state.
      this.#logger.info("bridge.callback.expired", {
        updateId: update.updateId,
        threadId: update.thread.threadId,
      });
      await this.#edit(update, expiredMenu());
      await this.#answer(update, { text: MENU_EXPIRED_NOTICE });
      return;
    }
    this.#logger.debug("bridge.callback", {
      updateId: update.updateId,
      threadId: update.thread.threadId,
      action: callback.action.kind,
    });
    const notice = await this.#apply(update, callback.action);
    await this.#answer(update, notice);
  }

  async #apply(update: InboundCallback, action: CallbackAction): Promise<Notice | undefined> {
    if (action.kind === "close") {
      await this.#api.editMessageReplyMarkup({
        chatId: update.thread.chatId,
        messageId: update.messageId,
        signal: this.#signal,
      });
      return undefined;
    }
    if (action.kind === "manage") {
      await this.#edit(update, await this.#menuFor(update.thread));
      return undefined;
    }
    if (action.kind === "new") return this.#openNewSession(update);
    if (action.kind === "existing") return this.#openExistingSessions(update, action.page);
    if (action.kind === "create") return this.#createSession(update, action.alias);
    if (action.kind === "bind") return this.#bindSession(update, action.sessionSuffix);
    return this.#unlinkSession(update);
  }

  async #openNewSession(update: InboundCallback): Promise<Notice | undefined> {
    if (this.#linkOf(update.thread) !== undefined) {
      await this.#edit(update, await this.#menuFor(update.thread));
      return { text: ALREADY_LINKED_NOTICE };
    }
    await this.#edit(update, newSessionMenu(this.epoch, [...this.#cwdAliases.keys()]));
    return undefined;
  }

  async #openExistingSessions(update: InboundCallback, page: number): Promise<Notice | undefined> {
    if (this.#linkOf(update.thread) !== undefined) {
      await this.#edit(update, await this.#menuFor(update.thread));
      return { text: ALREADY_LINKED_NOTICE };
    }
    const choices = this.#choices(await this.#backend.listSessions());
    await this.#edit(update, existingSessionsMenu(this.epoch, choices, page));
    return undefined;
  }

  async #createSession(update: InboundCallback, alias: string): Promise<Notice | undefined> {
    const directory = this.#cwdAliases.get(alias);
    if (directory === undefined) {
      await this.#edit(update, newSessionMenu(this.epoch, [...this.#cwdAliases.keys()]));
      return { text: ALIAS_GONE_NOTICE, alert: true };
    }
    if (this.#linkOf(update.thread) !== undefined) {
      // A second tap must not create a second session.
      await this.#edit(update, await this.#menuFor(update.thread));
      return { text: ALREADY_LINKED_NOTICE };
    }
    const sessionId = await this.#backend.createSession(directory);
    const notice = this.#link(update.thread, sessionId);
    await this.#edit(update, await this.#menuFor(update.thread));
    return notice;
  }

  async #bindSession(update: InboundCallback, suffix: string): Promise<Notice | undefined> {
    const link = this.#linkOf(update.thread);
    if (link !== undefined) {
      await this.#edit(update, await this.#menuFor(update.thread));
      // The same button tapped twice asks for a link that already exists.
      return sessionSuffix(link.sessionId) === suffix ? undefined : { text: THREAD_CONFLICT_NOTICE, alert: true };
    }
    const sessions = await this.#backend.listSessions();
    const matches = sessions.filter((session) => sessionSuffix(session.sessionId) === suffix);
    const session = matches.length === 1 ? matches[0] : undefined;
    if (session === undefined) {
      await this.#edit(update, existingSessionsMenu(this.epoch, this.#choices(sessions), 0));
      return { text: matches.length === 0 ? SESSION_GONE_NOTICE : AMBIGUOUS_SESSION_NOTICE, alert: true };
    }
    const notice = this.#link(update.thread, session.sessionId);
    await this.#edit(update, await this.#menuFor(update.thread));
    return notice;
  }

  async #unlinkSession(update: InboundCallback): Promise<Notice | undefined> {
    const link = this.#linkOf(update.thread);
    if (link === undefined) {
      await this.#edit(update, unlinkedMenu(this.epoch));
      return undefined;
    }
    const sessions = await this.#backend.listSessions();
    const session = sessions.find((candidate) => candidate.sessionId === link.sessionId);
    if (session?.running === true) {
      // Dropping the link mid-turn would leave the output with nowhere to land.
      await this.#edit(update, linkedMenu(this.epoch, this.#label(session), true));
      return { text: RUNNING_NOTICE, alert: true };
    }
    this.#store.unlink(PLATFORM, update.thread.chatId, update.thread.threadId);
    this.#logger.info("bridge.link.removed", {
      threadId: update.thread.threadId,
      sessionId: link.sessionId,
    });
    await this.#edit(update, unlinkedMenu(this.epoch));
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
    return sessionLabel(session, this.#aliasOf(session.cwd));
  }

  /** Maps a real directory back to its configured name. Paths stay local. */
  #aliasOf(cwd: string | undefined): string | undefined {
    if (cwd === undefined) return undefined;
    for (const [alias, directory] of this.#cwdAliases) {
      if (directory === cwd) return alias;
    }
    return undefined;
  }

  #linkOf(thread: ThreadIdentity): Link | undefined {
    return this.#store.findByThread(PLATFORM, thread.chatId, thread.threadId);
  }

  async #send(thread: ThreadIdentity, view: MenuView): Promise<void> {
    await this.#api.sendMessage({
      chatId: thread.chatId,
      threadId: thread.threadId,
      text: view.text,
      ...(view.keyboard.length === 0 ? {} : { replyMarkup: view.keyboard }),
      signal: this.#signal,
    });
  }

  /** Every callback ends by editing the menu it came from into current state. */
  async #edit(update: InboundCallback, view: MenuView): Promise<void> {
    await this.#api.editMessageText({
      chatId: update.thread.chatId,
      messageId: update.messageId,
      text: view.text,
      replyMarkup: view.keyboard,
      signal: this.#signal,
    });
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
