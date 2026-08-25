/**
 * An in-memory Backend.
 *
 * The runtime is only allowed to know the Backend contract, so tests drive it
 * through exactly that contract. The extra methods here are stage direction,
 * not contract: `remove` plays a session deleted in the backend's own UI, and
 * `setRunning` plays a turn that is under way.
 */
import type {
  Backend,
  BackendEventHandler,
  PromptContent,
  Session,
} from "../src/backends/types.ts";

export class FakeBackend implements Backend {
  readonly name = "dsh";
  /** Every `createSession` call, in order. */
  readonly created: Array<{ cwd: string; sessionId: string }> = [];
  readonly prompts: Array<{ sessionId: string; content: PromptContent }> = [];
  listCalls = 0;

  #sessions: Session[];
  #counter = 0;

  constructor(sessions: readonly Session[] = []) {
    this.#sessions = [...sessions];
  }

  async listSessions(): Promise<Session[]> {
    this.listCalls += 1;
    return this.#sessions.map((session) => ({ ...session }));
  }

  async createSession(cwd: string): Promise<string> {
    this.#counter += 1;
    // Long enough that a full id would not fit in callback data.
    const sessionId = `01j8z4qk9m7f3b2n6x5c4v-created-${String(this.#counter).padStart(4, "0")}`;
    this.#sessions.push({ sessionId, running: false, cwd });
    this.created.push({ cwd, sessionId });
    return sessionId;
  }

  async sendPrompt(sessionId: string, content: PromptContent): Promise<void> {
    this.prompts.push({ sessionId, content });
  }

  async steer(sessionId: string, content: PromptContent): Promise<void> {
    this.prompts.push({ sessionId, content });
  }

  subscribe(_handler: BackendEventHandler): () => void {
    return () => {};
  }

  async respondApproval(_requestId: string, _approved: boolean): Promise<void> {}

  async close(): Promise<void> {}

  /** A session that disappeared from the backend, without the bridge asking. */
  remove(sessionId: string): void {
    this.#sessions = this.#sessions.filter((session) => session.sessionId !== sessionId);
  }

  setRunning(sessionId: string, running: boolean): void {
    this.#sessions = this.#sessions.map((session) =>
      session.sessionId === sessionId ? { ...session, running } : session,
    );
  }

  has(sessionId: string): boolean {
    return this.#sessions.some((session) => session.sessionId === sessionId);
  }
}
