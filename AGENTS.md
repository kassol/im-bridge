# im-bridge

## 项目概述

把 coding agent harness 接到即时通讯软件上：一个 Telegram topic 对应一个 agent 会话，
在 topic 里发消息就是给 agent 发 prompt，agent 的输出流式回帖到同一个 topic。

第一版只接 **dsh**（deepseek-harness）一个后端、只接 **Telegram** 一个平台。
Discord 是第二个平台，用来验证抽象是否站得住；现在不写。

### 为什么不用隧道

bridge 出站连 Telegram（long polling），dsh 只听 127.0.0.1，两者都在同一台机器上。
机器不开任何入站端口，不需要 Cloudflare Tunnel。

代价：鉴权从 Zero Trust 降级成自己写的白名单。**这是本项目最脆弱的一环**，
见「安全边界」。

### pi 不在支持范围内

pi 没有会话列表接口，也无法定向订阅某个会话的事件。给 pi 做远程控制面板是另一个项目
（`~/Workspace/pi-remote`），那里用 SDK 内嵌 + 文件观察绕开了这些缺口。
**不要把 pi 的 managed/foreign 二分搬进本项目。**

## 领域语言

全项目、全文档、全代码统一使用这套词，不造同义词：

| 术语 | 定义 |
|---|---|
| **backend** | 被控制的 agent harness。当前只有 `dsh` |
| **session** | backend 侧的会话，由 backend 分配 id 并持久化 |
| **platform** | 即时通讯平台。当前只有 `telegram` |
| **thread** | platform 侧的会话容器。Telegram 里是私聊 topic（`message_thread_id`） |
| **link** | 一条 thread ↔ session 的映射记录。本项目唯一必须持久化的状态 |
| **turn** | 一次「用户发消息 → agent 输出完毕」的完整往返 |

禁止混用：不写 chat/conversation/room 指代 thread，不写 agent/instance 指代 session。

## 技术栈

- Node 24 + TypeScript strict，`node --experimental-strip-types` 直接跑 `.ts`，不预编译
- pnpm workspace（`packages/*`）
- SQLite：`node:sqlite`（Node 24 内置，无三方依赖）
- Telegram：直接打 Bot API HTTP 接口，不引 SDK
- 测试：vitest

不引 telegraf / grammy 这类框架。本项目只用到 Bot API 的极小子集，
且 `sendMessageDraft` / `sendRichMessage` 是 2026 年的新方法，框架未必跟进。

## 目录索引

```
packages/bridge/src/
  backends/        backend adapter。每个 backend 实现同一个接口
  telegram/        Telegram 平台适配：收 update、发消息、渲染
  store/           SQLite link 表
docs/              实测结论与协议记录
```

## 核心抽象

backend adapter 必须实现四个动作，多一个都不加：

```
listSessions()                    列出会话
sendPrompt(sessionId, text)       向指定会话发消息
subscribe(handler)                订阅事件流，handler 收到的事件带 sessionId
respondApproval(requestId, ok)    回应审批请求
```

platform 层只认这个接口，**不许 import 任何 backend 专有类型**。
dsh 的全量流过滤、RPC 信封细节全部在 `backends/dsh.ts` 内部吸收掉。

抽象泄漏的判据：platform 层出现 `if (backend === 'dsh')` 就是泄漏，回去改 adapter。

## 实测结论（都是踩过的坑，改代码前先读）

以下全部为 2026-08-24 在本机实测所得，非文档推断。推翻任何一条前先复现。

### Telegram

- **流式节流固定 1 秒**。实测：1000ms × 60 次零失败；500ms 前 40 次正常、之后持续 429，
  `retry_after` 逐步升到 9 秒。500ms 是突发额度，不是稳态速率。
- **必须处理 `retry_after` 退避**。惩罚会累积升级（3s → 14s），踩线不退避会雪崩。
- **`sendMessageDraft` 只能发私聊**（`chat_id` 仅接受 private chat），但**支持 `message_thread_id`**，
  所以「一个 thread 一个 session」与流式可以共存。
- **draft 是 30 秒临时预览，不进历史**。同一 `draft_id` 反复调用是流式；
  收尾**必须**再调一次 `sendMessage` / `sendRichMessage` 落地。
- **`draft_id` 是必填字段**，不是 `random_id`（后者报 `RANDOM_ID_INVALID`）。
- **代码高亮完全取决于 `language` 字段**。实测 `pre` 带 `language=python` 有 10 个着色 span +
  "Python" 标签；不带则 0 个着色 span。agent 输出代码时必须提取语言名传过去。
- **`{markdown: ...}` 入口与结构化 `blocks` 渲染效果完全一致**（DOM 对比逐项相同）。
  所以默认走 markdown 入口，不自己构造 block 树。只有需要 `details` 折叠、
  `thinking` 状态这类 markdown 表达不了的语义时才用 blocks。
- **超长输出不用自己切分**。200 行代码块 Telegram 自动折叠成 "Show more"。
  单条消息上限仍是 4096 字符（4097 报 `MESSAGE_TOO_LONG`）。
- **topics 开关在 BotFather Mini App 的 Threaded mode**，不在旧版聊天菜单，也没有 API 方法可开。
  开启后 `getMe` 的 `has_topics_enabled` 为 true。
- **回复必须带 `message_thread_id`**，否则消息落到主聊天而不是那个 topic。
- `api.telegram.org` 会偶发 TLS `ECONNRESET`。**网络层重试是必需品**，不是可选项。

### 工具链

- **vitest 必须 ≥ 3**。vitest 2 依赖 Vite 5，Vite 5 会把 `node:sqlite` 的 `node:` 前缀剥掉，
  再去找一个叫 `sqlite` 的包，报 `Failed to load url sqlite`。
  `server.deps.external` / `ssr.external` / `pool: forks` 都绕不过去，升级是唯一解。
- **pnpm 11 用 `allowBuilds`**（不是 `onlyBuiltDependencies`，也不读 package.json 的 `pnpm` 字段）。
  esbuild 必须设 `true`，否则 vitest 起不来。
  注意 `pnpm approve-builds` 可能往 `pnpm-workspace.yaml` 写入占位字符串
  （`esbuild: set this to true or false`），那会让**所有** pnpm 命令直接失败。

### dsh

- **RPC 信封**：`{type:"client-request", rpcId, method, payload}`。
  `method` 在 URL 里已有，body 里**仍要重复一次**，少了报 `invalid client-request message`。
- **同一 session 支持多个订阅者**。源码是 `Set<FrameQueue>` + `for-of` 广播，
  没有按 sessionId 索引的订阅槽位；实测两条 mux 连接都收到完整事件，互不挤占。
  **im-bridge 是众多客户端之一**，dsh 自己的 Web UI 可以同时开着。
- **没有单会话订阅端点**。`/api/events.mux` 是全会话聚合流，
  bridge 必须自己按 `payload.sessionId` 过滤分发。
- **审批是竞态的**。`approval/requested` 广播给所有连接，先答者赢。
  bridge 与 Web UI 会抢同一个审批，UI 上要显式处理「已被别处回答」。
- **上行走 HTTP，不能复用 WebSocket**。downlink 收到客户端消息立刻 `close(1008, 'downlink only')`。
- **`FrameQueue` 是无界数组**。慢消费者（被限流的 bridge）会让帧堆在 dsh 内存里，
  没有上限也没有丢弃策略。**bridge 必须自己做有界缓冲 + 丢弃策略**，不能指望 dsh 兜底。
- **凭据解析顺序**：进程环境 → `$DSH_HOME/.credentials.yaml` → 启动 cwd 的 `.env` → `$DSH_HOME/.env`。
  「调用目录的 .env」指**启动时的 cwd**，放错目录 key 不生效，症状是
  `MISSING_CREDENTIAL` 且 `session.models` 返回空。
- **`session.models` 必须传 `sessionId`**，且即使传了也可能返回 0——但 prompt 仍能正常工作。
  模型列表与实际推理走的不是同一套解析，不要用 models 是否为空判断 key 有效性。
- **dsh 会注入 skill 清单**，扫的是 `~/.agents/skills`（`npx skills -g` 的规范目录），
  **不是** `~/.pi/agent/skills`，两者内容相同是因为共用磁盘目录。
  每个 session 注入一次，实测让一句话 prompt 的 input 涨到 10546 token。
  要关掉：`DSH_AGENTS_HOME=<空目录> dsh web`。
- **`dsh` 安装很慢**：455 个包、约 280MB、npm 12 分钟 / pnpm 5 分钟。
  `npx @deepseek-ai/dsh` 会静默卡住不输出任何日志。部署要预装，不能靠冷启动。

## 全局规范

### 安全边界

- **bridge 不监听任何端口**。只出站连 Telegram、只连 127.0.0.1 的 dsh。
- **用户白名单是唯一的鉴权**。硬校验 `from.id`，非白名单直接丢弃且不回复。
  这一条写错等于把机器的 shell 交出去（agent 能跑 bash），改动必须带测试。
- bot token 与 API key 只从环境变量或 600 权限文件读，**不进代码、不进日志、不进 git**。
- 新建 session 的 cwd 必须过允许列表校验。
  参考反面教材：pi-remote 的 AGENTS.md 声称有允许列表，实际 `validateCwd` 只查了路径穿越，
  文档与实现不符。**本项目若写了就必须真的实现，并有测试证明。**

### 代码约定

- TypeScript strict。不用 `any`，用 `unknown` + 类型收窄。
- 错误让它现形：不吞异常，不写空 catch。网络重试必须有上限，且最终失败要上报。
- 新代码路径必须带单测，文件操作用临时目录隔离。
- 领域术语见「领域语言」表，不造同义词。

### 文档约定

- 实测得到的结论写进本文件「实测结论」节，注明日期。
- 文档陈述必须与代码一致。发现不一致时，先确认哪边对，再改另一边。

## 常用命令

```bash
pnpm i
pnpm -F bridge dev        # 起 bridge
pnpm -F bridge test       # 单测
pnpm -F bridge typecheck  # 类型检查

# dsh 后端（另开一个终端，注意关掉 skill 注入）
DSH_AGENTS_HOME=~/.dsh/empty-agents dsh web --no-open --port 3080
```

## 变更日志

- 2026-08-24：项目初始化。确立 backend/platform 双层抽象与四动作接口，
  固化 Telegram 与 dsh 的实测结论。第一版范围：dsh + Telegram，SQLite 存 link。
  骨架落地：`backends/types.ts`（四动作契约）、`store/links.ts`（SQLite link 表）、
  `telegram/throttle.ts`（1 秒节流 + retry_after 退避）、`telegram/allowlist.ts`（唯一鉴权）。
  17 项单测通过，typecheck 干净。backend 与 platform 的事件循环尚未实现。
</content>
