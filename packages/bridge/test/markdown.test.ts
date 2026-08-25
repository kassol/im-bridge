/**
 * Splitter unit tests.
 *
 * The runtime seam covers how split results reach Telegram; these three cases
 * are the ones that need a budget small enough to read, or an input too odd to
 * build out of a plausible agent answer.
 */
import { describe, expect, it } from "vitest";
import { charLength, splitFinalMarkdown } from "../src/telegram/markdown.ts";

describe("splitFinalMarkdown", () => {
  it("leaves a result that fits unlabelled and unchanged", () => {
    const markdown = "# 标题\n\n正文 **加粗**。\n";
    expect(splitFinalMarkdown(markdown, 100)).toEqual([markdown]);
  });

  it("rebuilds a fence longer than the backticks inside the code", () => {
    // A four-backtick fence is the only way to write a code block whose body
    // contains a three-backtick run.
    const lines = Array.from({ length: 40 }, (_unused, index) => `行 ${index} 里有 \`\`\` 三个反引号`);
    const parts = splitFinalMarkdown(`\`\`\`\`markdown\n${lines.join("\n")}\n\`\`\`\`\n`, 300);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const body = part.replace(/^\[\d+\/\d+\]\n\n/u, "");
      expect(body.startsWith("````markdown\n")).toBe(true);
      expect(body.endsWith("\n````")).toBe(true);
      expect(charLength(part)).toBeLessThanOrEqual(300);
    }
    expect(parts.filter((part) => part.includes("行 0 里有"))).toHaveLength(1);
    expect(parts.filter((part) => part.includes("行 39 里有"))).toHaveLength(1);
  });

  it("cuts one over-budget line on code points, never inside a surrogate pair", () => {
    const line = "🙂".repeat(100);
    const parts = splitFinalMarkdown(line, 40);

    expect(parts.length).toBeGreaterThan(1);
    const rejoined = parts.map((part) => part.replace(/^\[\d+\/\d+\]\n\n/u, "")).join("");
    expect(rejoined).toBe(line);
    for (const part of parts) {
      expect(charLength(part)).toBeLessThanOrEqual(40);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(part)).toBe(false);
    }
  });
});
