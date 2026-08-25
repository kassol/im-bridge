/**
 * The contract every backend adapter implements.
 *
 * The platform layer talks only to this interface. Backend-specific concerns —
 * dsh's aggregate event stream, its RPC envelope, its racing approvals — are
 * absorbed inside the adapter and never surface here.
 *
 * Leak test: an `if (backend === 'dsh')` in the platform layer means the
 * abstraction failed. Fix the adapter, not the caller.
 */

/** A backend-side conversation. The backend owns the id and persists it. */
export interface Session {
  sessionId: string;
  /** True when the backend is actively working on a turn. */
  running: boolean;
  /** Working directory of the session, when the backend exposes one. */
  cwd?: string;
  title?: string;
}

/** Image formats a prompt content part may carry. */
export type PromptImageMediaType = "image/jpeg" | "image/png" | "image/webp";

/** One piece of a prompt: text, or an image carried as base64 data. */
export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: PromptImageMediaType; data: string; name?: string };

/**
 * One atomic input for a session, as an ordered list of parts. Starting a turn
 * and steering a running turn take the same shape.
 */
export type PromptContent = readonly PromptContentPart[];

/**
 * Events a backend can emit, normalised across backends.
 *
 * Deliberately smaller than any backend's native event set: the platform layer
 * only needs to know what to render, not how the backend models its internals.
 */
export type BackendEvent =
  /** Incremental assistant output. `text` is the delta, not the accumulation. */
  | { type: "output"; sessionId: string; text: string }
  /** The model's reasoning, when the backend exposes it separately. */
  | { type: "thinking"; sessionId: string; text: string }
  /** A turn finished. `text` is the complete assistant message. */
  | { type: "turn-end"; sessionId: string; text: string }
  /** The backend needs a human decision before continuing. */
  | { type: "approval"; sessionId: string; requestId: string; prompt: string }
  /** The backend degraded but the current turn continues. */
  | { type: "warning"; sessionId: string; message: string }
  /** The backend failed. Terminal for the current turn. */
  | { type: "error"; sessionId: string; message: string };

export type BackendEventHandler = (event: BackendEvent) => void | Promise<void>;

/**
 * The request named by `respondApproval` is no longer pending.
 *
 * An approval is broadcast to every client of a backend and the first answer
 * wins, so losing that race is a normal outcome the platform layer renders
 * rather than a failure. It is part of the contract as a type because the
 * platform layer must never read a backend's error text to tell them apart.
 */
export class ApprovalNotPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalNotPendingError";
  }
}

export interface Backend {
  /** Stable name, used in logs and in the link table. */
  readonly name: string;

  listSessions(): Promise<Session[]>;

  /** Create a session and return its id. */
  createSession(cwd: string): Promise<string>;

  /** Start a turn on an idle session. */
  sendPrompt(sessionId: string, content: PromptContent): Promise<void>;

  /** Feed content into the turn a session is already running. */
  steer(sessionId: string, content: PromptContent): Promise<void>;

  /**
   * Subscribe to the event stream. Returns an unsubscribe function.
   *
   * Adapters must fan out to every handler and must not assume a single
   * consumer — one bridge process may render to several places at once.
   */
  subscribe(handler: BackendEventHandler): () => void;

  /** Answer an approval request. Losing a race is normal; see AGENTS.md. */
  respondApproval(requestId: string, approved: boolean): Promise<void>;

  /** Close connections and stop background reconnect work. */
  close(): Promise<void>;
}
