# Research: Telegram Rich Messages 官方 schema

## 结论

截至 Bot API 10.2，`sendMessageDraft` 只流式发送普通文本；Rich Message 使用 `sendRichMessage`，其流式版本是 `sendRichMessageDraft`。官方文档未提供名为 `text` 或 `code` 的 block：普通正文 block 是 `paragraph`，内联代码是 `RichTextCode`。

## 请求与响应

- `sendMessageDraft(chat_id, message_thread_id?, draft_id, text?, parse_mode?, entities?) -> True`。`chat_id` 仅限 private chat；`draft_id` 必填、非零，同 ID 更新会动画过渡；`text` 为实体解析后 0–4096 字符，空串显示 “Thinking…”；无 `reply_markup`。[官方定义](https://core.telegram.org/bots/api#sendmessagedraft)
- `sendRichMessage(..., chat_id, message_thread_id?, rich_message, ..., reply_parameters?, reply_markup?) -> Message`。Rich 文本上限 32768 个 UTF-8 字符（含 custom emoji 替代文本与公式源码）；`reply_markup` 接受 inline/reply keyboard、remove 或 force reply。[官方定义](https://core.telegram.org/bots/api#sendrichmessage)
- Rich 流式须调用 `sendRichMessageDraft(chat_id, message_thread_id?, draft_id, rich_message) -> True`；同样要求 private chat、非零 `draft_id`，不支持直接上传新文件，也无键盘参数。[官方定义](https://core.telegram.org/bots/api#sendrichmessagedraft)

## `InputRichMessage` 与 blocks

`InputRichMessage` 要求 `html`、`markdown`、`blocks` **恰好一个**；另有 `media?`、`is_rtl?`、`skip_entity_detection?`。总限制为 500 blocks、16 层嵌套、50 个媒体、表格 20 列。[字段与限制](https://core.telegram.org/bots/api#inputrichmessage)

结构化依据：

- `InputRichBlockThinking`: `{type:"thinking", text: RichText}`，仅用于 `sendRichMessageDraft`，不会出现在最终消息。
- `InputRichBlockDetails`: `{type:"details", summary: RichText, blocks: InputRichBlock[], is_open?: true}`。
- `InputRichBlockParagraph`: `{type:"paragraph", text: RichText}`。
- `InputRichBlockPreformatted`: `{type:"pre", text: RichText, language?: string}`。
- `RichTextCode`: `{type:"code", text: RichText}`；`RichText` 也可直接是 string 或数组。[block schema](https://core.telegram.org/bots/api#inputrichblock)

`markdown` 支持 GFM 可兼容部分及 HTML：行内代码用反引号，代码块用带可选语言的 fenced code；`details` 可写 `<details><summary>…</summary>…</details>`；thinking 只能在 draft 中写 `<tg-thinking>…</tg-thinking>`。[格式规则](https://core.telegram.org/bots/api#rich-message-formatting-options)

## 编辑与键盘

`editMessageText` 新增 `rich_message?: InputRichMessage`，与 `text` 二选一；返回编辑后的 `Message`，inline message 返回 `True`。它只接受 `InlineKeyboardMarkup`，且当前只能编辑无键盘或带 inline keyboard 的消息。[官方定义](https://core.telegram.org/bots/api#editmessagetext)

## 来源取舍与风险

保留 Telegram [Bot API](https://core.telegram.org/bots/api) 与 [官方 changelog](https://core.telegram.org/bots/api-changelog)；后者确认 Rich Messages 在 10.1 引入、blocks 在 10.2 加入。丢弃博客、SDK issue 与搜索摘要，因非一手 schema。未调用真实 bot；客户端渲染兼容性和服务端边界报错未实测。

```acceptance-report
{
  "criteriaSatisfied": [{"id":"criterion-1","status":"satisfied","evidence":"报告列出官方请求/响应、block 字段、限制、编辑与键盘能力，并标注官方 URL；残余风险已单列。"}],
  "changedFiles": ["/Users/kassol/.pi/agent/sessions/--Users-kassol-Workspace-im-bridge--/subagent-artifacts/outputs/558205d5-1951-44f7-a4e8-243ee9f5132f/telegram.md"],
  "testsAddedOrUpdated": [],
  "commandsRun": [{"command":"官方文档静态检索与字段交叉核对（未调用 bot）","result":"passed","summary":"核对 Bot API 10.2 主文档、格式规则与 changelog。"}],
  "validationOutput": ["sendMessageDraft -> True；sendRichMessage -> Message；sendRichMessageDraft -> True。"],
  "residualRisks": ["未用真实 bot 验证客户端渲染兼容性与服务端边界报错。"],
  "noStagedFiles": true,
  "diffSummary": "新增 Telegram Rich Messages 官方 schema 中文研究报告。",
  "reviewFindings": ["no blockers；medium: 项目既有文档若仍将 sendMessageDraft 与 Rich Message 混为同一接口，需要按 Bot API 10.2 修正。"],
  "manualNotes": "按运行时要求仅写入 authoritative artifact，未改仓库 docs/research/telegram-rich-messages.md。"
}
```
