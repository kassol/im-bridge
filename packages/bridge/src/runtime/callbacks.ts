/**
 * Callback data encoding.
 *
 * A button keeps its callback data for as long as its message exists, which
 * outlives the process that drew it. Two rules follow:
 *
 *   - Every payload carries the process epoch. A button drawn before a restart
 *     decodes into a foreign epoch and is answered as expired instead of being
 *     applied to whatever the menu shows now.
 *   - The payload names a stable key — a cwd alias, the tail of a session id, or
 *     the short token of an approval — never a position in the list the menu
 *     happened to render. The list is rebuilt on every click, so an index would
 *     silently point at another session once a session appeared or was bound
 *     elsewhere. An approval token is resolved against a map that lives only in
 *     the process that filed the request, which is exactly as long as its epoch
 *     is valid.
 *
 * Telegram allows 64 bytes of callback data. `encodeCallback` proves the budget
 * rather than trusting it.
 */

/** Telegram's hard limit for `callback_data`, in UTF-8 bytes. */
export const CALLBACK_DATA_LIMIT = 64;

/** How many trailing session-id characters identify a session in a button. */
export const SESSION_SUFFIX_LENGTH = 8;

export type CallbackAction =
  /** Redraw the menu for whatever state the topic is in now. */
  | { readonly kind: "manage" }
  /** Open the list of configured cwd aliases. */
  | { readonly kind: "new" }
  /** Create a session in the directory of `alias`, then link it. */
  | { readonly kind: "create"; readonly alias: string }
  /** Open one page of bindable sessions. */
  | { readonly kind: "existing"; readonly page: number }
  /** Bind the session whose id ends with `sessionSuffix`. */
  | { readonly kind: "bind"; readonly sessionSuffix: string }
  | { readonly kind: "unlink" }
  /** Allow the approval this process filed under `token`, once. */
  | { readonly kind: "allow"; readonly token: string }
  /** Reject the approval this process filed under `token`. */
  | { readonly kind: "reject"; readonly token: string }
  | { readonly kind: "close" };

export interface Callback {
  readonly epoch: string;
  readonly action: CallbackAction;
}

const KIND_CODES = {
  manage: "m",
  new: "n",
  create: "c",
  existing: "e",
  bind: "b",
  unlink: "u",
  allow: "a",
  reject: "r",
  close: "x",
} as const;

/**
 * A value that changes on every start. Base 36 milliseconds is eight
 * characters and orders like the restarts it stands for.
 */
export function createEpoch(now: number = Date.now()): string {
  return now.toString(36);
}

export function sessionSuffix(sessionId: string): string {
  return sessionId.slice(-SESSION_SUFFIX_LENGTH);
}

export function encodeCallback(epoch: string, action: CallbackAction): string {
  if (epoch.includes(":")) throw new Error("callback epoch must not contain a colon");
  const data = `${epoch}:${KIND_CODES[action.kind]}:${argumentOf(action)}`;
  const size = Buffer.byteLength(data, "utf8");
  if (size > CALLBACK_DATA_LIMIT) {
    throw new Error(`callback data is ${size} bytes, over Telegram's ${CALLBACK_DATA_LIMIT}`);
  }
  return data;
}

/** Returns `undefined` for anything this process did not produce. */
export function decodeCallback(data: string): Callback | undefined {
  const firstSeparator = data.indexOf(":");
  const secondSeparator = data.indexOf(":", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator < 0) return undefined;
  const epoch = data.slice(0, firstSeparator);
  const code = data.slice(firstSeparator + 1, secondSeparator);
  // The argument keeps the rest verbatim: a session suffix is backend text and
  // may contain a colon of its own.
  const argument = data.slice(secondSeparator + 1);
  const action = readAction(code, argument);
  return action === undefined ? undefined : { epoch, action };
}

function argumentOf(action: CallbackAction): string {
  if (action.kind === "create") return action.alias;
  if (action.kind === "existing") return String(action.page);
  if (action.kind === "bind") return action.sessionSuffix;
  if (action.kind === "allow" || action.kind === "reject") return action.token;
  return "";
}

function readAction(code: string, argument: string): CallbackAction | undefined {
  if (code === KIND_CODES.manage) return { kind: "manage" };
  if (code === KIND_CODES.new) return { kind: "new" };
  if (code === KIND_CODES.unlink) return { kind: "unlink" };
  if (code === KIND_CODES.close) return { kind: "close" };
  if (code === KIND_CODES.create) return argument === "" ? undefined : { kind: "create", alias: argument };
  if (code === KIND_CODES.allow) return argument === "" ? undefined : { kind: "allow", token: argument };
  if (code === KIND_CODES.reject) return argument === "" ? undefined : { kind: "reject", token: argument };
  if (code === KIND_CODES.bind) {
    return argument === "" ? undefined : { kind: "bind", sessionSuffix: argument };
  }
  if (code === KIND_CODES.existing) {
    const page = Number(argument);
    if (!Number.isSafeInteger(page) || page < 0) return undefined;
    return { kind: "existing", page };
  }
  return undefined;
}
