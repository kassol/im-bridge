/**
 * Rich Message budgeting and Markdown-aware splitting.
 *
 * Telegram counts a Rich Message in UTF-8 characters, so every length here is
 * a count of code points, never of UTF-16 units: a surrogate pair is one
 * character and cutting it in half produces a broken string rather than a
 * shorter one.
 *
 * Splitting goes through `marked`'s lexer for one property: block tokens keep
 * a `raw` field that reproduces the source verbatim, so parts are rebuilt by
 * concatenating tokens instead of re-rendering the document. Only a token that
 * is itself over budget is cut, and a code fence is cut by line and refenced,
 * because half a fence turns the rest of the part into code.
 */
import { lexer, type Token, type Tokens } from "marked";
import type { RichBlock } from "./api.ts";

/**
 * Final-send budget. Telegram's ceiling is 32768 UTF-8 characters; the gap
 * absorbs any difference between its count and this one.
 */
export const FINAL_BUDGET = 32_000;
/** Draft budget, thinking block included. */
export const DRAFT_BUDGET = 30_000;
/** The newest reasoning a draft shows. */
export const THINKING_BUDGET = 2_000;
/** Room for the `[N/M]` label prefixed to every part of a split result. */
const LABEL_RESERVE = 24;

export const OMITTED_OUTPUT_TEXT = "（较早的输出已省略，完整结果稍后发送）";

/** Counts UTF-8 characters: a surrogate pair counts once. */
export function charLength(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    count += 1;
    if (isSurrogatePair(text, index)) index += 1;
  }
  return count;
}

/** The first `max` characters, never splitting a surrogate pair. */
export function headChars(text: string, max: number): string {
  if (max <= 0) return "";
  if (charLength(text) <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/** The last `max` characters, never splitting a surrogate pair. */
export function tailChars(text: string, max: number): string {
  if (max <= 0) return "";
  if (charLength(text) <= max) return text;
  return Array.from(text).slice(-max).join("");
}

/**
 * The result as the parts to send, in order.
 *
 * A result that fits goes out unlabelled. Anything longer is labelled `[N/M]`,
 * and the label is reserved out of the budget so a part cannot exceed the
 * limit by wearing its own label.
 */
export function splitFinalMarkdown(markdown: string, budget: number = FINAL_BUDGET): string[] {
  if (charLength(markdown) <= budget) return [markdown];
  const parts = splitMarkdown(markdown, budget - LABEL_RESERVE);
  return parts.map((part, index) => `[${index + 1}/${parts.length}]\n\n${part}`);
}

/**
 * The blocks of the streaming draft.
 *
 * Thinking is capped to its own budget and takes precedence, because it is the
 * part the user watches while nothing else has arrived. The output keeps its
 * newest characters; when older output no longer fits, the draft says so
 * rather than pretending to be the whole answer — the complete result lands in
 * history at turn end.
 */
export function draftBlocks(state: {
  thinking: string;
  output: string;
  /** True when the caller already dropped older output before this call. */
  omitted?: boolean;
}): RichBlock[] {
  const thinking = tailChars(state.thinking, THINKING_BUDGET);
  const budget = DRAFT_BUDGET - charLength(thinking);
  const marker = charLength(OMITTED_OUTPUT_TEXT);
  let omitted = state.omitted === true;
  let output = state.output;
  // The marker is part of the draft, so it comes out of the same budget.
  if (charLength(output) > budget - (omitted ? marker : 0)) {
    output = tailChars(output, budget - marker);
    omitted = true;
  }
  const blocks: RichBlock[] = [];
  if (thinking !== "") blocks.push({ type: "thinking", text: thinking });
  if (omitted) blocks.push({ type: "paragraph", text: OMITTED_OUTPUT_TEXT });
  blocks.push(...outputBlocks(output));
  return blocks;
}

/**
 * Parsed output as draft blocks. Consecutive prose stays in one paragraph
 * block; a fence becomes a `pre` block that carries its language, which is the
 * only thing that makes Telegram highlight it.
 */
function outputBlocks(markdown: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  let prose = "";
  const flush = (): void => {
    const text = prose.trim();
    if (text !== "") blocks.push({ type: "paragraph", text });
    prose = "";
  };
  for (const token of lexer(markdown)) {
    if (token.type !== "code") {
      prose += token.raw;
      continue;
    }
    flush();
    const code = token as Tokens.Code;
    const language = firstWord(code.lang);
    blocks.push({ type: "pre", text: code.text, ...(language === "" ? {} : { language }) });
  }
  flush();
  return blocks;
}

/** Packs block tokens into parts, cutting only what is over budget on its own. */
function splitMarkdown(markdown: string, budget: number): string[] {
  const parts: string[] = [];
  let current = "";
  const flush = (): void => {
    const part = current.trim();
    if (part !== "") parts.push(part);
    current = "";
  };
  const append = (chunk: string): void => {
    if (charLength(current) + charLength(chunk) > budget) flush();
    // A part never opens with the blank line that separated it from the
    // previous block.
    current += current === "" ? chunk.replace(/^\n+/u, "") : chunk;
  };
  for (const token of lexer(markdown)) {
    for (const chunk of chunksOf(token, budget)) append(chunk);
  }
  flush();
  return parts.length === 0 ? [markdown] : parts;
}

/** One token as pieces that each fit the budget. */
function chunksOf(token: Token, budget: number): string[] {
  if (charLength(token.raw) <= budget) return [token.raw];
  if (token.type === "code") return splitCode(token as Tokens.Code, budget);
  return splitLines(token.raw, budget);
}

/**
 * An over-budget fence, cut by line. Every part is refenced and repeats the
 * language, so each one is highlighted and none of them leaks its fence into
 * the surrounding text.
 */
function splitCode(code: Tokens.Code, budget: number): string[] {
  const language = firstWord(code.lang);
  const fence = safeFence(code.text);
  // Two fences, the language, and the three newlines that frame the body.
  const overhead = charLength(fence) * 2 + charLength(language) + 3;
  const body = budget - overhead;
  if (body <= 0) return splitLines(code.raw, budget);
  return splitLines(code.text, body).map((part) => `${fence}${language}\n${part}\n${fence}`);
}

/** Cuts at line boundaries, and inside a line only when one line is too long. */
function splitLines(text: string, budget: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = current === "" ? line : `\n${line}`;
    if (charLength(current) + charLength(piece) <= budget) {
      current += piece;
      continue;
    }
    if (current !== "") {
      chunks.push(current);
      current = "";
    }
    let rest = line;
    while (charLength(rest) > budget) {
      const head = headChars(rest, budget);
      chunks.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/** A fence longer than any backtick run inside the code it has to close. */
function safeFence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Telegram takes one language name; an info string may carry more words. */
function firstWord(value: string | undefined): string {
  return (value ?? "").trim().split(/\s+/u)[0] ?? "";
}

function isSurrogatePair(text: string, index: number): boolean {
  const high = text.charCodeAt(index);
  if (high < 0xd800 || high > 0xdbff || index + 1 >= text.length) return false;
  const low = text.charCodeAt(index + 1);
  return low >= 0xdc00 && low <= 0xdfff;
}
