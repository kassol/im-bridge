/**
 * The live end-to-end checklist and its evidence writer.
 *
 * The live run talks to the real Bot API and to the real dsh, so its output is
 * the one artefact a human keeps afterwards. That makes it the same hazard as
 * the service log: a transcript of a real conversation would otherwise end up
 * in a terminal buffer, a scrollback file, or a paste.
 *
 * Redaction is therefore structural, exactly as in `src/log.ts`. `EVIDENCE_KEYS`
 * enumerates every field an evidence line may carry, all of them ids, counts,
 * durations, or bridge-authored labels. Anything else is dropped rather than
 * truncated, and a value shaped like a bot token is replaced even when it
 * arrives under an allowed key.
 *
 * Nothing in this file performs I/O of its own, so the bookkeeping the live
 * script depends on is unit tested without a bot, a token, or a network.
 */

/** One acceptance item the run has to observe before it may report success. */
export interface ChecklistItem {
  readonly id: string;
  readonly title: string;
  /** True when a human has to act in Telegram for this item to complete. */
  readonly manual?: true;
}

/**
 * Every item issue #9 requires the live run to cover, in the order the script
 * drives them. The order matters: a session must exist before it can be
 * steered, and recovery is only meaningful once real work has been recorded.
 */
export const CHECKLIST: readonly ChecklistItem[] = [
  { id: "topic-menu", title: "私聊 topic 的管理菜单", manual: true },
  { id: "session-create", title: "菜单新建 session 并绑定", manual: true },
  { id: "session-bind", title: "绑定已存在的 session", manual: true },
  { id: "unlink-repair", title: "解除绑定与失效绑定修复", manual: true },
  { id: "text-prompt", title: "文字 prompt 起一个回合" },
  { id: "text-steer", title: "运行中的回合被文字 steer" },
  { id: "image-single", title: "单张受支持图片进入 prompt", manual: true },
  { id: "album-atomic", title: "相册作为一个处理单元封口", manual: true },
  { id: "image-steer", title: "图片 steer 运行中的回合", manual: true },
  { id: "approval-allow", title: "审批允许一次", manual: true },
  { id: "approval-reject", title: "审批拒绝", manual: true },
  { id: "external-turn", title: "dsh Web UI 起的回合同样渲染" },
  { id: "long-output", title: "超长 Markdown 与代码输出分片" },
  { id: "multipart-failure", title: "分片中途失败只报已发送数量" },
  { id: "restart-recovery", title: "重启恢复转 dead letter 并提示重发" },
];

/**
 * The complete set of fields an evidence line may carry.
 *
 * Same rule as `LogFields`: add one only after checking that it cannot carry a
 * prompt, a caption, an image, an agent's answer, or a credential.
 */
const EVIDENCE_KEYS = [
  "item",
  "reason",
  "threadId",
  "chatId",
  "sessionId",
  "messageId",
  "updateId",
  "count",
  "durationMs",
  "attempt",
] as const;

export type EvidenceKey = (typeof EVIDENCE_KEYS)[number];

/** What an evidence line may say. Ids, counts, durations, bridge-authored labels. */
export type Evidence = Partial<Record<EvidenceKey, string | number>>;

/** Long enough for a label, short enough that no transcript fits. */
const MAX_VALUE_LENGTH = 120;

/** `<bot id>:<secret>`, the one shape that must never survive a paste. */
const TOKEN_SHAPE = /\d+:[A-Za-z0-9_-]{35,}/u;

export const REDACTED = "[redacted]";

/**
 * Keeps the fields an evidence line is allowed to carry and drops the rest.
 *
 * Unknown keys are dropped rather than summarised, because a summary of an
 * unknown value is still a fragment of it.
 */
export function redactEvidence(fields: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const kept: Record<string, string | number> = {};
  for (const key of EVIDENCE_KEYS) {
    const value = fields[key];
    if (typeof value === "number") {
      if (Number.isFinite(value)) kept[key] = value;
      continue;
    }
    if (typeof value !== "string") continue;
    kept[key] = TOKEN_SHAPE.test(value) ? REDACTED : value.slice(0, MAX_VALUE_LENGTH);
  }
  return kept;
}

export type CheckState = "pending" | "passed" | "failed";

export interface ChecklistSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  /** True only when every item passed. Nothing else counts as a green run. */
  readonly ok: boolean;
}

export interface ChecklistOptions {
  /** Defaults to stdout. Tests capture lines here. */
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * Tracks which acceptance items the live run has observed.
 *
 * Every state change writes one JSON Lines record, so an interrupted run still
 * leaves the evidence of what it did reach.
 */
export class Checklist {
  readonly #write: (line: string) => void;
  readonly #now: () => Date;
  readonly #state = new Map<string, CheckState>();

  constructor(options: ChecklistOptions = {}) {
    this.#write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
    this.#now = options.now ?? (() => new Date());
    for (const item of CHECKLIST) this.#state.set(item.id, "pending");
  }

  state(id: string): CheckState {
    const state = this.#state.get(id);
    if (state === undefined) throw new Error(`unknown checklist item: ${id}`);
    return state;
  }

  /** One observation that is not an item on its own. */
  note(event: string, evidence: Evidence = {}): void {
    this.#emit(event, evidence);
  }

  pass(id: string, evidence: Evidence = {}): void {
    this.#settle(id, "passed", evidence);
  }

  /** `reason` is bridge-authored: an error name or a step label, never a message. */
  fail(id: string, reason: string, evidence: Evidence = {}): void {
    this.#settle(id, "failed", { ...evidence, reason });
  }

  summary(): ChecklistSummary {
    const states = [...this.#state.values()];
    const passed = states.filter((state) => state === "passed").length;
    const failed = states.filter((state) => state === "failed").length;
    return {
      total: states.length,
      passed,
      failed,
      pending: states.length - passed - failed,
      ok: passed === states.length,
    };
  }

  /** The closing lines, one per item plus the verdict. Safe to keep verbatim. */
  report(): string[] {
    const lines = CHECKLIST.map((item) => `${symbolOf(this.state(item.id))} ${item.id} · ${item.title}`);
    const summary = this.summary();
    lines.push(
      `${summary.ok ? "PASS" : "FAIL"} ${String(summary.passed)}/${String(summary.total)} passed, ` +
        `${String(summary.failed)} failed, ${String(summary.pending)} pending`,
    );
    return lines;
  }

  #settle(id: string, state: CheckState, evidence: Evidence): void {
    if (!this.#state.has(id)) throw new Error(`unknown checklist item: ${id}`);
    this.#state.set(id, state);
    this.#emit(`live.item.${state}`, { ...evidence, item: id });
  }

  #emit(event: string, evidence: Evidence): void {
    this.#write(
      JSON.stringify({
        time: this.#now().toISOString(),
        event: event.slice(0, MAX_VALUE_LENGTH),
        ...redactEvidence(evidence),
      }),
    );
  }
}

function symbolOf(state: CheckState): string {
  if (state === "passed") return "[ok]";
  return state === "failed" ? "[!!]" : "[--]";
}
