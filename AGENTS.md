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
| **link** | 一条 thread ↔ session 的映射记录 |
| **polling checkpoint** | 已完成处理或已隔离的最高 Telegram update id |
| **dead letter** | 达到重试上限后隔离的 Telegram update 与失败摘要 |
| **turn** | 一次「用户发消息 → agent 输出完毕」的完整往返 |

禁止混用：不写 chat/conversation/room 指代 thread，不写 agent/instance 指代 session。

## 技术栈

- Node 24 + TypeScript strict，`node --experimental-strip-types` 直接跑 `.ts`，不预编译
- pnpm workspace（`packages/*`）
- SQLite：`node:sqlite`（Node 24 内置，无三方依赖）
- Telegram：直接打 Bot API HTTP 接口，不引 SDK
- Markdown 分片：`marked@18`（精确锁版，唯一运行时依赖）。只用 `lexer()` 的 block token：
  `raw` 逐字保留原文，代码 token 带 `lang`，所以分片是按 token 边界拼接原文，不重新渲染
- 测试：vitest

不引 telegraf / grammy 这类框架。本项目只用到 Bot API 的极小子集，
且 `sendMessageDraft` / `sendRichMessage` 是 2026 年的新方法，框架未必跟进。

## 目录索引

```
packages/bridge/src/
  backends/        backend adapter。每个 backend 实现同一个接口
  telegram/        Telegram 平台适配：收 update、发消息、渲染、
                   Rich Message 预算与 Markdown 分片
  runtime/         update 编排：按 thread 排队与四线程并发上限、durable processing
                   与 dead letter、私聊 topic 管理菜单、callback 校验、link 变更、
                   turn 编排与流式草稿、图片与相册输入、图片内存预算、审批 UI
  store/           SQLite schema v2：link 表、polling checkpoint、
                   update processing 记录、dead letter
packages/bridge/live/
                   只手动跑的实机脚本，不进 vitest：`e2e.ts` 驱动真实
                   Telegram + dsh 走完验收清单，`checklist.ts` 是纯粹的
                   清单记账与证据脱敏（有单测）
docs/              实测结论与协议记录
  adr/             架构决策记录
  agents/          engineering skills 配置
scripts/           可重复的本机安装与运维向导
  setup-dsh.sh     安装并验证 dsh 后端服务
  setup-bridge.sh  写配置、跑测试与实机验证、安装 bridge LaunchAgent
```

## 核心抽象

backend adapter 必须实现七个动作，多一个都不加：

```
listSessions()                    列出会话
createSession(cwd)                在允许的工作目录创建会话
sendPrompt(sessionId, content)    向空闲会话发送 prompt content
steer(sessionId, content)         向运行中的会话发送 prompt content
subscribe(handler)                订阅事件流，handler 收到的事件带 sessionId
respondApproval(requestId, ok)    回应审批请求
close()                           关闭连接与后台重连
```

契约还包含一个错误类型：`respondApproval` 遇到已被其他客户端答复的请求时抛
`ApprovalNotPendingError`（`src/backends/types.ts`）。审批是广播的、先答者赢，
platform 层必须能区分这种正常结果与真失败，所以它按类型判断，不读 backend 的错误文案。

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
- **Rich Message 上限按 32768 UTF-8 字符处理**。最终消息使用 `sendRichMessage`，
  保守按 32000 UTF-8 字符分片。普通 `sendMessage` / `sendMessageDraft` 的上限仍是
  4096 字符；200 行代码块在单条限制内会自动折叠成 "Show more"。
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
- **`node --check` 按最终扩展名选模块加载器**。临时文件叫 `supervisor.mjs.AbCdEf` 会报
  `ERR_UNKNOWN_FILE_EXTENSION` 并以退出码 1 结束（Node 24.14.0 实测）。
  要检查的临时文件必须以 `.mjs` 结尾。
- **BSD `mktemp` 只展开模板末尾的 `XXXXXX`**。`mktemp "foo.XXXXXX.mjs"` 不做替换，
  直接报 `mkstemp failed ... File exists`。要保留扩展名就先用末尾模板占位创建，
  再 `mv` 回带扩展名的路径。
- **`plutil -lint` 按内容校验，与扩展名无关**。plist 临时文件名不受此限制。

- **`node --check` 只查语法，不验证 ESM named export**。`basename` / `dirname`
  错从 `node:fs` 导入时，`--check` 仍返回 0，实际执行才报
  `SyntaxError: node:fs does not provide an export named 'basename'`。生成 supervisor 后
  必须执行 validation mode，让模块完成链接和凭据格式校验，再安装 LaunchAgent。
- **未引用 heredoc 里的 JavaScript 正则不要双重转义**。shell 不会处理反斜杠；脚本写
  `/\\s/` 会原样生成匹配反斜杠或 `s` 的正则，含字母 `s` 的 key 因此校验失败。
  源 heredoc 写 `/\s/`，生成文件才是目标正则。

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
- **`dsh` 安装很慢**：约 450 个包、约 280MB，pnpm 冷 store 实测 3 分 12 秒。
  `npx @deepseek-ai/dsh` 会静默卡住不输出任何日志。部署要预装，不能靠冷启动。
- **dsh 的 runtime 必须用 hoisted 布局**（2026-08-24 实测 `0.1.1-rc.2`）。
  它的 manifest 只声明 2 个 `@deepseek-ai/dsh-client-ui-*`，启动配置却动态
  import 了更多。pnpm 默认的隔离布局让缺失暴露：进程 3 秒内报
  `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-client-ui-jobs'`
  并以退出码 1 结束，端口 3080 从未监听。在 runtime 目录写 `.npmrc` 的
  `node-linker=hoisted` 后，未声明的插件被提到可解析位置。runtime 使用独立的
  `pnpm-workspace.yaml`，明确为单 package workspace。这是绕过上游打包缺陷，
  dsh 补全依赖声明后要重新评估。
- **dsh 可以用 `--ignore-scripts` 装**（2026-08-24 实测，macOS arm64、
  Node 24.14、pnpm 11.21.0、独立空 store）：冷装 3 分 12 秒，启动后 5 秒
  `127.0.0.1:3080` 返回 HTTP 200，`node-pty` / `koffi` /
  `@deepseek-ai/dsh-subprocess-local` 均 `require` 成功，`session.create` 与
  `session.list` 均成功。发布的 tarball 已带本平台预编译产物，所以安装期
  lifecycle 脚本不必在部署目录里执行。**未验证**：模型驱动的 bash 工具调用没有
  端到端跑过，需要安装脚本的 subprocess 路径会在首次使用时才暴露。
- **dsh 装在用户级 runtime 目录，不装全局**：
  `~/.local/share/im-bridge/dsh/runtime`。先装进同目录下的 `staging`，
  验证版本后 `mv` 换入，旧版本留成 `runtime.previous` 直到新服务应答端口。
  目录改名是原子的，回滚只要换回来。

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical labels without overrides. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain documentation layout. See `docs/agents/domain.md`.

## 全局规范

### 安全边界

- **bridge 不监听任何端口**。只出站连 Telegram、只连 127.0.0.1 的 dsh。
- **用户白名单是唯一的鉴权**。硬校验 `from.id`，非白名单直接丢弃且不回复。
  这一条写错等于把机器的 shell 交出去（agent 能跑 bash），改动必须带测试。
- bot token 与 API key 只从环境变量或 600 权限文件读，**不进代码、不进日志、不进 git**。
- 新建 session 的 cwd 必须是配置里某个 cwd root 的子目录：点击时按最新的 `readdir` 重新解析，
  再用 `realpath` 证明结果仍在该 root 内，同时 dsh backend 的允许 cwd root 就是配置里的这些 root。
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
# 起 bridge，唯一参数是 600 权限的配置文件路径（不要写 `--`，pnpm 会把它原样传给 node）
pnpm -F bridge start <config.json>
pnpm -F bridge dev <config.json>       # 同上，改动即重启
pnpm -F bridge test       # 单测
pnpm -F bridge typecheck  # 类型检查

# 列出被隔离的 update（每行一条 JSON，只有元数据；不启动轮询、不连 backend）
pnpm -F bridge start <config.json> dead-letters list

# 只校验配置文件，退出码 0/1（向导用它，不在 bash 里重写一遍校验）
pnpm -F bridge start <config.json> config check

# 等一条私聊 topic 里的消息，打印它的 chatId / threadId（bot 不能自己建私聊 topic）
pnpm -F bridge start <config.json> topic detect

# 安装前自检：getMe + threaded mode + 结构化草稿 + 最终 Rich Message
pnpm -F bridge start <config.json> probe --thread <id>

# 实机端到端（真 Telegram + 真 dsh + 临时数据库，按提示在 Telegram 里操作）
pnpm -F bridge live:e2e <config.json> --thread <id>

# bridge 服务（交互式收配置、跑测试与实机验证、安装 LaunchAgent 并验证）
./scripts/setup-bridge.sh

# dsh 后端（交互式安装、配置 LaunchAgent 并验证）
./scripts/setup-dsh.sh

# dsh 后端（另开一个终端，注意关掉 skill 注入）
DSH_AGENTS_HOME=~/.dsh/empty-agents dsh web --no-open --port 3080
```

## 变更日志

- 2026-08-25：`cwdAliases` 改名为 `cwdRoots`，alias 指向父目录而非单个工作目录。
  新建 session 先选 root（只配了一个 root 时跳过这一步），再从该 root 的直接子目录里选：
  `src/runtime/directories.ts` 在画菜单和点击时各读一次 `readdir`，只留 `isDirectory()`、
  跳过点号开头的目录、按名字排序、每页 8 条。callback data 带
  `<root alias>:<目录名 sha256 前 8 位>`，不含目录名也不含列表下标；点击时按摘要在最新
  列表里重新解析，目录消失或摘要撞名都报错不猜，选中的名字还要经 `realpath` 证明仍在 root
  内才允许当 cwd。session 没有 title 时标签是 `<root alias>/<目录名>` + session id 末 8 位，
  root 之外的 cwd 不带任何路径。`src/config.ts`（校验规则不变）、`src/index.ts`、
  `scripts/setup-bridge.sh`（提示语改为 cwd roots as name=/absolute/parent-directory）、
  `packages/bridge/live/e2e.ts` 同步改名，不留兼容层。ADR 0003 加 2026-08-25 修订：
  root 下的目录名会展示给白名单用户，真实完整路径仍然不出现。新增 13 项单测（共 310）。
- 2026-08-25：代码评审修复。Backend 契约新增 `ApprovalNotPendingError`，dsh adapter 抛它、
  runtime 按 `instanceof` 判断，不再匹配错误文案；`failureSummary` 移到 `src/telegram/api.ts`，
  `bridge.event.failed` 与 `telegram.update.failed` 只记错误类型，异常消息不再进日志；
  `live/e2e.ts` 两处空 catch 改为写脱敏证据行；菜单标签改用 `headChars` 按字符截断，
  不再劈开代理对；`video` / `animation` / `audio` / `voice` / `sticker` / `video_note`
  在 `src/telegram/updates.ts` 归一化为 `unsupported`，runtime 只回一句「不支持的消息类型。」，
  caption 不再当文字 prompt 发给 backend；审批消息带上工具名（`toolName: reason`）；
  `sendRichMessageDraft` 恢复默认的 3 次幂等重试，429 仍原样抛给 `StreamThrottle`
  （新增 `pacedByCaller`，退避只发生一次）；启动恢复的重发提示重新校验白名单
  （私聊 chat_id 即 user id），不在白名单只记 `bridge.resend.skipped`；相册成员从入队起
  就按 `album` 记录，崩溃恢复的 dead letter 不再写成 `message`；`topic detect` / `probe` /
  `soleAllowedUserId` / `readNumberFlag` 导出并可注入 base URL，服务只在 `src/index.ts`
  是进程入口时启动。新增 12 项单测（共 297）。
- 2026-08-25：补齐服务边界与部署路径。**下面这些只用假件验证过，实机运行尚未进行**：
  `BridgeRuntime.shutdown({ deadlineMs })`（`src/runtime/runtime.ts`）按固定顺序
  中止轮询 → 停止接收新 update → 立即封口相册 → 最多等 20 秒排空 update / 图片 /
  发送 → 关 Backend → 最后关 SQLite；到点仍在跑的活留着 processing 记录，交给下次
  启动恢复转 dead letter 并提示重发，关机开始后到达的 update 既不记录也不结清，
  checkpoint 不动，下次轮询会重新取到。`ThreadScheduler.drain()` 是排空的等待点。
  第二个信号直接退出（`src/index.ts`）。新增本地命令 `config check` / `topic detect` /
  `probe --thread`，以及 `packages/bridge/live/e2e.ts`（`pnpm -F bridge live:e2e`，
  不进 vitest）。新增 `scripts/setup-bridge.sh`：七个阶段依次是预检 → 收配置 →
  写并校验配置 → typecheck 与单测 → 真实 Bot API 的 Rich Message 自检 → 实机 E2E →
  装 LaunchAgent 并等 `bridge.started`，任一阶段失败都回滚到原配置、原 plist、原服务。
  token 只从静默输入经 stdin 进 600 权限的 `~/.config/im-bridge/config.json`，
  不进命令行、不进 `wizard-values`、不进 plist、不进日志。plist 只传配置文件路径，
  `RunAtLoad` 为真、`KeepAlive` 只在异常退出后重启。ADR 0001 补两条 2026-08-25
  修订：env 文件被 JSON 配置取代；bridge 日志的 10MB × 5 轮转发生在每次安装时，
  单次长跑期间不轮转。新增 45 项单测（关机 7、scheduler 2、live 清单 10、
  向导生成产物 26）。
- 2026-08-25：打通可靠 update 处理与审批。update 按 thread 串行、全局最多 4 个 thread
  同时跑（`src/runtime/scheduler.ts`：每 thread 一条 FIFO 队列，一个任务让出一次名额，
  忙 thread 不会压住等待中的 thread）。每个处理单元在第一个 Telegram / Backend 副作用
  之前落 processing 记录，之后每个有返回 id 的副作用记一步（`src/runtime/processing.ts`：
  step 是本文件的常量，进程内最多重试 3 次并从已记录的步骤续跑——重试不会再建一个
  session、不会再发一次 prompt；重试用尽写一条只有元数据的 dead letter 并结清该 update）。
  dead letter 的 errorSummary 由错误类型拼出，异常消息不入库、不进日志。
  相册的所有 update id 共用一个处理结果与一个 checkpoint 单元，收集期间 anchor 记录
  挡住 checkpoint。`runUpdateLoop` 的 offset 改由 store 的 polling checkpoint 决定
  （`checkpoint + 1`），进程内再叠一层"已派发"下限；被丢弃与主聊天指引的 update 由轮询
  循环结清，投递出去的由 runtime 结清，checkpoint 只走连续前缀，不跳过未完成的空档。
  启动时 `BridgeRuntime.recover()` 把所有不确定的 processing 记录转成 dead letter、
  不重试，并给有 thread 标识的 topic 发一句「上次输入可能未送达，请重新发送」，
  同时清掉 30 天前的 dead letter。新增本地命令 `dead-letters list`（`src/index.ts`）。
  审批 UI：linked topic 收到 approval 事件发一条中文消息带「允许一次 / 拒绝」，
  callback data 带 epoch 与短 token（requestId 留在进程内的映射里，随进程与 epoch 一起
  失效）；每次点击重新校验白名单、私聊 topic、epoch、当前 link 与请求本身，成功后移除
  键盘并把原消息改成「已允许 / 已拒绝」；被 dsh Web UI 或其他客户端抢先回答的请求改成
  「已在其他客户端处理」且不再报错；没有 link 的审批只记 `bridge.approval.unlinked`
  并保持 pending，绝不自动拒绝。新增 25 项单测。
- 2026-08-25：图片与相册进入 prompt 路径。linked topic 里的 Telegram photo 与
  image document 走和文字同一条输入：photo 选不超过 5 MiB 的最大变体，document 校验
  MIME（JPEG / PNG / WebP）并保留安全文件名，caption 作为 text 部分，无 caption 用固定
  中文分析请求（`src/runtime/media.ts`）。一次最多 4 张；张数超限、类型不支持、体积超限、
  下载失败各回一句中文，整条输入都不发给 backend。相册按 `media_group_id` 收集，静默
  1 秒后按 message id 排序封口成一条 prompt，并带上全部 update id 作为同一处理单元
  （`src/runtime/albums.ts`；`BridgeRuntime.sealAlbums()` 让关机立即封口，不等静默窗口）。
  `telegram/api.ts` 新增 `getFile` 与 `downloadFile`：文件 base URL 可注入，边读边计数，
  过 5 MiB 立即 abort，不信任 Content-Length 与 Telegram 声明的 `file_size`。
  `src/runtime/semaphore.ts` 是全局加权信号量，20 MiB 且最多 4 个线程同时持有，
  `finally` 在 `sendPrompt` / `steer` 成功或失败后释放。图片只在内存里，不进 SQLite、
  日志、dead letter 或临时文件。新增 22 项单测。
- 2026-08-25：打通文字 turn。linked topic 里的文字：空闲 session 走 `sendPrompt`
  且不发任何开始消息，运行中的 session 走 `steer` 并回一句中文确认；运行状态在
  `BridgeRuntime.start()` 由 `listSessions().running` 初始化，dsh Web UI 起的回合
  同样渲染。每个 backend event 在到达时用当前 link 定位 thread，未绑定就记日志丢弃
  （approval 留给审批 ticket，只记日志）。新增 `src/runtime/turns.ts`：首个 thinking /
  output delta 建 `sendRichMessageDraft` 草稿，沿用 `StreamThrottle` 的 1 秒节奏并按
  `retry_after` 退避，草稿含最新 2000 字思考 + 30000 UTF-8 字符预算内的解析输出，
  截断时显式标注省略。最终结果只认 `turn-end.text`，用 `sendRichMessage` 的 markdown
  入口落地，超过 32000 UTF-8 字符时按 `marked@18` 的 block token 分片
  （`src/telegram/markdown.ts`，超长代码块按行拆并重建安全围栏与语言，多片带 `[N/M]`）；
  中途失败即停，只报「已发送 k/M」，不重发也不重跑 backend。新增 22 项单测。
- 2026-08-25：落地私聊 topic 管理路径。新增 `src/runtime/`：`runtime.ts`
  （`BridgeRuntime.handleUpdate` 作为 update 唯一入口，`/start` 说明入口、
  `/manage` 按 unlinked / linked / invalid-link 出对应菜单、未绑定 topic 的消息丢弃正文
  并弹菜单、未知命令给一句纠正加管理按钮）、`callbacks.ts`（callback data 带 process
  epoch 与稳定键——cwd alias 或 session id 末 8 位，不含列表下标，编码时校验 64 字节上限）、
  `menus.ts`（纯菜单视图，未绑定 session 每页 8 条，标签用 title 或 alias + 末 8 位，
  不出现真实路径）。每次点击重新校验白名单、私聊 topic、epoch、当前 link、session 是否
  仍在、cwd alias；重复点击幂等，旧进程按钮编辑成失效态，关闭移除键盘。link 严格一对一，
  冲突时两边都不动并给中文结果；运行中的 session 拒绝解绑；解绑不删 backend session；
  backend 侧被删的 session 显示为失效并提供解绑或重新检查。`telegram/api.ts` 增加
  inline keyboard、`editMessageText` / `editMessageReplyMarkup` / `answerCallbackQuery`
  （幂等重试类，`message is not modified` 视为已生效）。`index.ts` 用配置里的 alias 目录
  作为 dsh 允许的 cwd root 构造 backend 并接上 runtime。新增 45 项单测。
- 2026-08-25：落地 Telegram 传输层与配置基线。配置改为单一 JSON 文件
  （`src/config.ts`，属主为当前 uid、mode 0600，token / 白名单 / cwd alias /
  数据库路径 / dsh URL / 日志级别），env 配置路径删除；新增 JSON Lines 日志
  （`src/log.ts`，字段白名单，结构上无法写入 token 与用户内容）；新增 Bot API
  适配器（`src/telegram/api.ts`，可注入 base URL、`getMe` 强制 threaded mode、
  50s/60s long polling、按幂等性分类重试、429 等满 `retry_after`、最终发送不重试）
  与 update 校验加轮询循环（`src/telegram/updates.ts`，白名单先于一切、私聊 topic
  才是 thread、主聊天回固定中文指引、1→30s 重连退避）。`src/index.ts` 改为
  argv 传配置路径并在 SIGTERM/SIGINT 中止轮询。新增 44 项单测（fake Telegram HTTP）。
- 2026-08-25：持久化升级到 SQLite schema v2，`LinkStore` 更名为 `Store`
  （`src/store/store.ts`）。`PRAGMA user_version` 驱动有序迁移，旧库按 v1 处理；
  link 双向唯一，`link()` 不再改绑，冲突抛 `LinkConflictError`，迁移遇到重复 session
  抛 `MigrationConflictError` 并报出冲突 thread、原样保留数据。新增 polling checkpoint
  （最高连续 update id）、update processing 记录（步骤 / 外部实体 id / 分片计数 /
  尝试次数，无 prompt 与图片字段）、启动恢复转 dead letter 并回传 thread 标识、
  dead letter 列表与 30 天清理。28 项 store 单测。
- 2026-08-25：Backend 契约落地七动作。`sendPrompt` 与 `steer` 统一接收 prompt content
  （有序 text / image 部分，图片限 JPEG、PNG、WebP，携带 base64 数据与可选安全文件名）；
  dsh adapter 映射到 `session.prompt` 的 queue / steer 模式，非法 content 在发出 HTTP 前失败。
  ADR 0002 补上被 ADR 0003 取代的交叉引用。
- 2026-08-24：完成 Telegram platform loop 设计，见
  `docs/adr/0003-telegram-platform-loop.md`。Backend 契约加入结构化 prompt content 与
  `steer`，成为七动作；确认私聊 topic 菜单、Rich Message 流式与最终落地、图片输入、
  polling checkpoint / dead letter、防重复优先的崩溃语义、SQLite v2迁移和部署前 E2E。
- 2026-08-24：完成 dsh adapter 设计，见 `docs/adr/0002-dsh-adapter.md`。Backend
  契约增加 `close()`，正式成为六动作；确认 HTTP unary + mux/host 双 WebSocket
  downlink、审批 response 关联、每 subscriber 每 session 64 事件有界队列、cwd root
  强校验与分层测试策略。
- 2026-08-24：Backend 契约正式确认为五动作，纳入 `createSession(cwd)`；新增
  `CONTEXT.md` 固化 backend/session/platform/thread/link/turn/backend event 领域语言。
- 2026-08-24：修复 dsh supervisor 启动即退且无日志：`basename` / `dirname` 改从
  `node:path` 导入，env 解析正则去掉 heredoc 中多余的反斜杠。Stage 3 新增
  supervisor validation mode，实际完成 ESM 链接与凭据格式校验；新增生成产物执行测试。
- 2026-08-24：`scripts/setup-dsh.sh` 的 Stage 4 改用 pnpm hoisted +
  `--ignore-scripts` 装 dsh，替换原来的 npm 安装。runtime staging 里写
  `.npmrc`（`node-linker=hoisted`）、`package.json` 与 `pnpm-workspace.yaml`，
  staging/runtime/service-files 的原子切换与精确 rollback 保持不变；预检恢复
  pnpm 11.21.0 校验。实测范围与 bash 未端到端验证的风险记在「实测结论」与
  ADR 0001。
- 2026-08-24：`scripts/setup-dsh.sh` 改用 npm 装 dsh 到用户级 runtime 目录。
  原来的 pnpm 全局安装让 dsh 启动 3 秒即退（`ERR_MODULE_NOT_FOUND`，上游
  manifest 漏声明 client-ui 插件），向导停在第 5 阶段。现在装进
  `$DSH_HOME/staging` 验证后再换入 `$DSH_HOME/runtime`，旧 runtime 保留到
  服务应答端口为止；失败时恢复旧 runtime 并保留 `dsh.log`，第 5 阶段打印
  经过过滤和脱敏的日志尾部。ADR 0001 的「pnpm 全局」决策同步改写。
- 2026-08-24：修复 `scripts/setup-dsh.sh` 的 supervisor 临时文件名。原写法
  `mktemp "${DSH_SUPERVISOR}.XXXXXX"` 把随机后缀放在 `.mjs` 之后，`node --check`
  报 `ERR_UNKNOWN_FILE_EXTENSION`，向导在第 3 阶段中断。改为先占位创建再
  `mv` 回 `.mjs` 结尾的路径；rollback 现在清理未落位的临时文件。
  新增 `packages/bridge/test/setup-dsh.test.ts` 锁定该行为。
- 2026-08-24：新增 `scripts/setup-dsh.sh`，交互式锁定并安装 dsh，复用
  `~/.dsh/.env` 的 600 权限凭据，安装 user LaunchAgent，并按 10MB × 5
  定期轮转日志。
- 2026-08-24：公开发布前的准备。`docs/adr/0001-local-service-deployment.md` 记录
  dsh 与 bridge 的常驻部署决策：锁定精确版本、两个 user LaunchAgent、
  凭据放 600 权限的 `~/.config/im-bridge/env`、日志 10MB × 5。
  `index.ts` 不再打印 token 前缀，只报告 token configured。
- 2026-08-24：配置 engineering skills：GitHub Issues、默认 triage 标签、单一上下文领域文档布局。
- 2026-08-24：项目初始化。确立 backend/platform 双层抽象与四动作接口，
  固化 Telegram 与 dsh 的实测结论。第一版范围：dsh + Telegram，SQLite 存 link。
  骨架落地：`backends/types.ts`（四动作契约）、`store/links.ts`（SQLite link 表）、
  `telegram/throttle.ts`（1 秒节流 + retry_after 退避）、`telegram/allowlist.ts`（唯一鉴权）。
  17 项单测通过，typecheck 干净。backend 与 platform 的事件循环尚未实现。
