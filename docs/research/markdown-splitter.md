# Markdown 拆分 parser 调研

> **勘误（2026-08-24）**：后续官方 Bot API 10.2 调研确认本项目最终输出使用
> `sendRichMessage`，上限为 32768 UTF-8 字符。ADR 0003 采用保守 32000 UTF-8
> 字符分片。本文关于 parser 的比较与 `marked` 推荐仍有效；所有 4096 限额描述仅适用于
> 普通 `sendMessage` / `sendMessageDraft`，不再是本项目最终 Rich Message 的分片参数。

## 结论

推荐 **`marked@18.0.10` 的 `marked.lexer()`**。它是 ESM-only、Node >=20、自带 TypeScript 声明、零运行时依赖；block token 保留 `raw`，代码 token 提供 `text`/`lang`，适合按原文 token 边界累加，并仅在单个代码块超限时按行拆分、为每片生成围栏。围栏长度应大于代码内容中的连续反引号，且每片把开闭围栏和语言名计入 4096 限额。

## 候选

| 包 | npm 发布包 / 依赖 | API 与取舍 | 维护状态 |
|---|---:|---|---|
| [`marked`](https://registry.npmjs.org/marked/latest) | 469,664 B / 0 | `marked.lexer(md)`；token 有 `raw`，fence 有 `text`、`lang`。源码保真和实现成本最佳。 | [v18 系列持续发布](https://github.com/markedjs/marked/releases) |
| [`mdast-util-from-markdown`](https://registry.npmjs.org/mdast-util-from-markdown/latest) | 97,286 B / 12 | ESM-only，`fromMarkdown()` 返回带 position 的 mdast；语义最完整，可按 offset 切原文，但依赖多，仍需自行识别并重建 fence。 | [2.0.3，2026-02-21](https://github.com/syntax-tree/mdast-util-from-markdown/releases/tag/2.0.3) |
| [`markdown-it`](https://registry.npmjs.org/markdown-it/latest) | 1,958,686 B / 6 | ESM/CJS、自带类型，`parse()` 给 block token；`map` 主要是行号，缺少统一 `raw`，原文重建更繁琐。 | [15.0.0 changelog](https://github.com/markdown-it/markdown-it/blob/master/CHANGELOG.md) |

## 实现边界与未知

先按完整 `raw` token 装箱；超长普通 block 退化到换行/Unicode code point 边界，超长 fence 用 `text` 按行拆并复制 `lang`。不得按 UTF-16 下标截断代理对。**未知**：Telegram 对 emoji、组合字符及 rich message 实体的 4096 计数口径，官方包资料无法证明，需 Bot API 实测锁定。`marked` 的 `raw` 拼接对全部 CommonMark/GFM 输入是否逐字恒等也未见官方契约，应加 property/fixture 测试。

## Sources

- Kept: npm registry `latest` 元数据与三个官方 GitHub 仓库/发布记录，提供版本、包体、模块格式、类型、依赖和 API 证据。
- Dropped: Bundlephobia/Packagephobia、博客与第三方 splitter 包，数据非一手或维护证据不足。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "review-findings 与 residual-risks 均给出；产物路径和风险明确。"
    }
  ],
  "changedFiles": [
    "/Users/kassol/.pi/agent/sessions/--Users-kassol-Workspace-im-bridge--/subagent-artifacts/outputs/558205d5-1951-44f7-a4e8-243ee9f5132f/markdown.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "web_search + fetch_content against npm registry and official GitHub repositories",
      "result": "passed",
      "summary": "核对三个候选的 latest 元数据、README、源码 API 与 release/changelog。"
    }
  ],
  "validationOutput": [
    "npm latest: marked 18.0.10 / 469664 B / 0 dependencies; mdast-util-from-markdown 2.0.3 / 97286 B / 12; markdown-it 15.0.0 / 1958686 B / 6。"
  ],
  "residualRisks": [
    "Telegram 对 Unicode 与 rich message 实体的 4096 计数口径未实测。",
    "marked 未公开承诺所有输入的 token.raw 拼接逐字恒等，需 fixture/property 测试。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增一份最多三个候选的 Markdown parser 调研，推荐 marked。",
  "reviewFindings": [
    "medium: docs/research/markdown-splitter.md - 实现前必须实测 Telegram Unicode/实体计数，避免片段仍被拒绝。",
    "low: docs/research/markdown-splitter.md - marked raw round-trip 需要测试锁定，官方未给稳定性契约。"
  ],
  "manualNotes": "运行时要求仅写权威 artifact 路径，因此未修改仓库 docs/research/markdown-splitter.md。"
}
```
