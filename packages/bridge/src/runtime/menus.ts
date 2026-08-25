/**
 * The management menus, as pure values.
 *
 * Nothing here touches Telegram, the store, or the backend: a menu is text plus
 * an inline keyboard derived from state the runtime already resolved. That
 * keeps every rendering rule — page bounds, labels, which button exists in
 * which state — testable without a server.
 *
 * Labels never contain a real path. A user sees a title, or a cwd root alias
 * with one directory name under it and the tail of the session id; the
 * directory the alias stands for stays in the configuration file.
 */
import type { Session } from "../backends/types.ts";
import type { InlineKeyboard, InlineKeyboardButton } from "../telegram/api.ts";
import { charLength, headChars } from "../telegram/markdown.ts";
import { encodeCallback, sessionSuffix, type CallbackAction } from "./callbacks.ts";
import type { DirectoryChoice } from "./directories.ts";

/** Sessions and directories shown per page. More rows stop fitting on a phone. */
export const PAGE_SIZE = 8;
/** How much of the backend's reason an approval message quotes. */
export const APPROVAL_REASON_LIMIT = 500;
/** Enough of a title to recognise a session, short enough for a button. */
const LABEL_LIMIT = 40;

export interface MenuView {
  readonly text: string;
  readonly keyboard: InlineKeyboard;
}

/** One bindable session, already reduced to what a button needs. */
export interface SessionChoice {
  readonly sessionId: string;
  readonly label: string;
}

export const START_TEXT =
  "本 bridge 只在私聊 topic 中工作。每个 topic 绑定一个 session，在 topic 里发消息就是给 agent 发 prompt。"
  + "\n发送 /manage 打开当前 topic 的管理菜单。";

export const UNKNOWN_COMMAND_TEXT = "无法识别的命令。";
export const MENU_EXPIRED_TEXT = "菜单来自上一次运行，已失效。发送 /manage 重新打开。";
export const MENU_EXPIRED_NOTICE = "菜单已失效";
export const UNLINKED_TEXT = "本 topic 尚未绑定 session。";
export const APPROVAL_PREFIX = "后端请求审批：";
export const APPROVAL_ALLOWED_TEXT = "已允许";
export const APPROVAL_REJECTED_TEXT = "已拒绝";
export const APPROVAL_ELSEWHERE_TEXT = "已在其他客户端处理";
export const APPROVAL_EXPIRED_TEXT = "审批请求已失效";
export const APPROVAL_UNLINKED_TEXT = "本 topic 已不再绑定该 session，审批未处理";
export const MESSAGE_DISCARDED_TEXT = `${UNLINKED_TEXT}这条消息没有发给任何 session，请先绑定。`;

/**
 * A session name for a button.
 *
 * `cwdName` is the configured name of the session's cwd — a root alias, or a
 * root alias and one directory under it — or `undefined` when the session runs
 * somewhere no configured root covers.
 */
export function sessionLabel(session: Session, cwdName: string | undefined): string {
  const title = session.title?.trim();
  if (title !== undefined && title !== "") return truncate(title);
  return `${cwdName ?? "未知目录"} ${sessionSuffix(session.sessionId)}`;
}

export function unlinkedMenu(epoch: string, text: string = UNLINKED_TEXT): MenuView {
  return {
    text,
    keyboard: [
      [button(epoch, "新建 session", { kind: "new" })],
      [button(epoch, "绑定已有 session", { kind: "existing", page: 0 })],
      [closeButton(epoch)],
    ],
  };
}

export function newSessionMenu(epoch: string, aliases: readonly string[]): MenuView {
  const rows = aliases.map((alias) => [button(epoch, alias, { kind: "root", alias, page: 0 })]);
  return {
    text: aliases.length === 0 ? "配置里没有可用的工作目录。" : "选择工作目录，新建 session：",
    keyboard: [...rows, [backButton(epoch), closeButton(epoch)]],
  };
}

/**
 * One page of the subdirectories of `alias`, as they were on disk when this
 * menu was drawn. A button carries the digest of a name, so the runtime looks
 * the name up again before it creates anything.
 */
export function subdirectoryMenu(
  epoch: string,
  alias: string,
  choices: readonly DirectoryChoice[],
  page: number,
): MenuView {
  const pageCount = Math.max(1, Math.ceil(choices.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  const start = current * PAGE_SIZE;
  const rows = choices
    .slice(start, start + PAGE_SIZE)
    .map((choice) => [button(epoch, truncate(choice.name), { kind: "create", alias, digest: choice.digest })]);
  const navigation: InlineKeyboardButton[] = [];
  if (current > 0) navigation.push(button(epoch, "上一页", { kind: "root", alias, page: current - 1 }));
  if (current < pageCount - 1) {
    navigation.push(button(epoch, "下一页", { kind: "root", alias, page: current + 1 }));
  }
  return {
    text:
      choices.length === 0
        ? `${alias} 下没有可用的子目录。`
        : `在 ${alias} 下选择目录，新建 session（第 ${current + 1}/${pageCount} 页）：`,
    keyboard: [
      ...rows,
      ...(navigation.length === 0 ? [] : [navigation]),
      [backButton(epoch), closeButton(epoch)],
    ],
  };
}

/**
 * One page of bindable sessions. `page` is clamped here, so a stale page number
 * from an older, longer list lands on a page that exists.
 */
export function existingSessionsMenu(
  epoch: string,
  choices: readonly SessionChoice[],
  page: number,
): MenuView {
  const pageCount = Math.max(1, Math.ceil(choices.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  const start = current * PAGE_SIZE;
  const rows = choices
    .slice(start, start + PAGE_SIZE)
    .map((choice) => [
      button(epoch, choice.label, { kind: "bind", sessionSuffix: sessionSuffix(choice.sessionId) }),
    ]);
  const navigation: InlineKeyboardButton[] = [];
  if (current > 0) navigation.push(button(epoch, "上一页", { kind: "existing", page: current - 1 }));
  if (current < pageCount - 1) {
    navigation.push(button(epoch, "下一页", { kind: "existing", page: current + 1 }));
  }
  return {
    text:
      choices.length === 0
        ? "没有可绑定的 session，请新建一个。"
        : `选择要绑定的 session（第 ${current + 1}/${pageCount} 页）：`,
    keyboard: [
      ...rows,
      ...(navigation.length === 0 ? [] : [navigation]),
      [backButton(epoch), closeButton(epoch)],
    ],
  };
}

export function linkedMenu(epoch: string, label: string, running: boolean): MenuView {
  return {
    text: `本 topic 已绑定 session：${label}\n状态：${running ? "运行中" : "空闲"}`,
    keyboard: [[button(epoch, "解除绑定", { kind: "unlink" })], [closeButton(epoch)]],
  };
}

/**
 * A link whose session the backend no longer lists. The bridge shows it and
 * waits: deleting the link on its own would hide a backend that is merely
 * restarting, so the user either unlinks or re-checks.
 */
export function invalidLinkMenu(epoch: string, suffix: string): MenuView {
  return {
    text: `本 topic 绑定的 session（${suffix}）在 backend 里已不存在。可以解除绑定后重新选择，或稍后重新检查。`,
    keyboard: [
      [button(epoch, "解除绑定", { kind: "unlink" })],
      [button(epoch, "重新检查", { kind: "manage" })],
      [closeButton(epoch)],
    ],
  };
}

export function unknownCommandMenu(epoch: string): MenuView {
  return {
    text: `${UNKNOWN_COMMAND_TEXT}发送 /manage 打开管理菜单。`,
    keyboard: [[button(epoch, "管理", { kind: "manage" })]],
  };
}

/**
 * One approval request, as the user has to answer it.
 *
 * The backend's reason is quoted, bounded: it explains which tool wants to
 * run, and a tool call can carry a long argument list.
 */
export function approvalMenu(epoch: string, token: string, prompt: string): MenuView {
  return {
    text: `${APPROVAL_PREFIX}${headChars(prompt, APPROVAL_REASON_LIMIT)}`,
    keyboard: [
      [
        button(epoch, "允许一次", { kind: "allow", token }),
        button(epoch, "拒绝", { kind: "reject", token }),
      ],
    ],
  };
}

/**
 * The same message once it is no longer a question. The keyboard goes: the
 * outcome is already decided, and a second tap must have nothing to hit.
 */
export function approvalResolvedMenu(outcome: string): MenuView {
  return { text: `${APPROVAL_PREFIX}${outcome}`, keyboard: [] };
}

export function expiredMenu(): MenuView {
  return { text: MENU_EXPIRED_TEXT, keyboard: [] };
}

function button(epoch: string, text: string, action: CallbackAction): InlineKeyboardButton {
  return { text, callbackData: encodeCallback(epoch, action) };
}

function backButton(epoch: string): InlineKeyboardButton {
  return button(epoch, "返回", { kind: "manage" });
}

function closeButton(epoch: string): InlineKeyboardButton {
  return button(epoch, "关闭", { kind: "close" });
}

function truncate(text: string): string {
  return charLength(text) <= LABEL_LIMIT ? text : `${headChars(text, LABEL_LIMIT - 1)}…`;
}
