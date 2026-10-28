# pi-runtime

一个跑在 **pi** 编码 agent（`@earendil-works/pi-coding-agent`）之上的个人助理运行时 —— 像平台团队封装 agent 内核那样封装它。

这个项目的重点不是"在自己的电脑上跟 AI 聊天"，而是拿到聊天壳子没有的三样东西：

1. **状态** —— 每个任务、每条事件、每个结果都能扛住崩溃。
2. **边界** —— 执行器是一次性子进程，没有数据库、不占端口。
3. **接缝** —— agent 内核可替换，平台逻辑始终是自己的。

它现在能做的事：

| 能力 | 一句话 |
|---|---|
| **记忆** | 每条记忆绑定到一条编号事件与逐字证据，四种裁决由数据库状态决定 |
| **上下文编排** | 段有稳定性、预算、淘汰顺序；跨段去重与冲突提示 |
| **短期状态** | 端口、分支、待办链接这类"只活几天"的信息，同步写入、到期消失 |
| **人格** | `SOUL.md`（怎么说话）+ `CONTRACTS.md`（怎么干活），常驻且独立预算 |
| **提醒** | 由模型在回复里发控制指令登记，到点由运行时主动推送 |
| **通道** | CLI / Telegram / 飞书 / QQ（OneBot v11），同一份记忆 |

## 架构

```
        你（现在 CLI，之后 Web / IM）
                    │
                    ▼
        ┌───────────────────────────┐
        │  编排层（本仓库）          │  ← 唯一有状态的部分
        │  tasks · events · queue   │
        │  SQLite (data/runtime.db) │
        └───────────┬───────────────┘
                    │ stdin JSONL  ▲ stdout JSONL
                    ▼              │
        ┌───────────────────────────┐
        │  pi --mode rpc            │  ← 无状态、无数据库、无端口
        │  prompt · tools · stream  │
        └───────────┬───────────────┘
                    │
                    ▼
        ┌───────────────────────────┐
        │  workspace（磁盘上的文件）  │  ← 真正的副作用发生在这里
        └───────────────────────────┘
```

为什么要这样切：执行器可以被杀掉、重启、装进容器、甚至换成另一个 agent，而队列的位置不会丢。

## 快速开始

```bash
# 1. 装依赖（--ignore-scripts：pi 不需要生命周期脚本，沙箱里常被拦截）
npm install --ignore-scripts

# 2. 绑定模型（凭证写到 data/pi，不是 ~/.pi）
node src/cli.ts login

# 3. 检查管道
node src/cli.ts doctor

# 4. 在当前目录跑一个任务
node src/cli.ts ask "总结一下这个仓库是做什么的" --cwd .

# 5. 或者起一个消费队列的守护进程
node src/cli.ts worker
```

## 能力全景

一个运行中的实例（飞书 + QQ 双通道，共用一份记忆）当前具备：

| 层 | 能力 | 关键实现 |
|---|---|---|
| 接入 | 飞书长连接 / QQ OneBot / CLI / Telegram | 幂等 `claimMessage`，群内 @ 或唤醒词才应答 |
| 记忆 | 证据绑定的结构化事实、四态裁决、置信度门限 | `memory.ts` + `confidence.ts`；`tentative` 永不注入 |
| 记忆检索 | 向量检索（`memory_search`），同模型空间比较 | `memory-server.mjs`，带逐字证据 |
| 文档知识 | 切分 → 向量 → `knowledge_search` / `knowledge_add` | `knowledge.ts`，与记忆严格分离 |
| 上下文 | 分段预算、稳定性、淘汰顺序、跨段去重、冲突提示、token 校准 | `compose.ts` |
| 人格 | `SOUL.md`（怎么说）+ `CONTRACTS.md`（怎么干），独立字符预算 | `persona.ts` |
| 工具 | `fetch` / `search` / `memory_search` / `knowledge_*` / `fanout` / `note_*` / `lock_*` / `send` / `propose_self_edit` | 六个手写 MCP server |
| 多智能体 | 模型自主 `fanout`，子任务独立线程、共享便签、冲突仲裁、失败重试 | `fanout.ts` + `api.ts` |
| 治理 | 死循环状态指纹、HITL 审批、并发文件锁、凭据守卫、SSRF 防护 | `loop-guard.ts` / `approval.ts` / `file-lock.ts` |
| 自我修改 | 改人格与 MCP 配置需人工批准，可回滚，代码永不可改 | `proposal.ts` |
| 可观测 | span 树、工具审计、事件日志、`doctor`、`context_plan` | `trace.ts` / `tools-report.ts` |

**当前规模**：38 个源文件 · 38 个测试文件 · 737 项测试 · 4 个长连服务。
## 常用命令

| 命令 | 作用 |
|---|---|
| `doctor` | 与 pi 握手，打印 session id / 模型 / 压缩状态 |
| `login` | 在隔离的配置目录里跑 pi 的登录 |
| `ask "<prompt>"` | 入队并立刻执行一个任务，流式输出 |
| `worker [--once]` | 守护进程：逐个领取队列任务，崩溃安全 |
| `list [n]` | 最近任务及状态 |
| `show <id>` | 单个任务的结果与事件轨迹 |
| `remember "<text>" --key <slot>` | 手工写入一条记忆 |
| `memories [category] [--all]` | 列出记忆（默认只看 active） |
| `history <key>` | 某个槽位的完整覆盖 / 作废链 |
| `forget <id>` | 硬删除一行 |
| `distill [--thread t]` | 从尚未提炼的对话里批量抽取记忆 |
| `state set/list/promote/del` | 短期状态（带 TTL） |
| `persona init/show/usage` | 人格与执行纪律两个常驻文件 |
| `remind [cancel <id>]` | 列出 / 取消待触发的提醒 |
| `archive` / `backup` | 归档旧事件 / 压缩快照数据库 |
| `compact` | 清理事件表里的流式增量 |
| `calibrate` | 用真实用量校准 token 估算 |
| `sandbox` | 查看当前工具能力策略 |
| `eval [--cases f] [--repeat n]` | 跑记忆抽取评测 |
| `serve --channel <c>` | 起服务：telegram / feishu / feishu-webhook / qq |

## 记忆

三层：**证据 → 主体 → 裁决**。

| 类别 | 用于 |
|---|---|
| `preference` | 长期稳定的个人偏好（饮食、作息、称呼、回答风格…） |
| `fact` | 长期稳定的客观事实（工作、技术栈、设备、常住地…） |
| `event` | 重要的单次事件与长期承诺（离职、复盘约定…） |

### 第一层：每条记忆都绑到一条编号事件

对话以追加方式存在 `conversation_events`（`#1024 | user_1 | role | text`）。抽取器看到的不是纯文本，而是带编号的行，且必须返回：

```json
{ "evidence_event_id": 1024, "evidence_quote": "我平时只喝美式，不加糖" }
```

引文会被校验为**那一条事件**的归一化子串，而不是整段对话的子串。引文属于隔壁那条消息就会被拒 —— 这正是"听起来合理但其实张冠李戴"被挡住的地方。

**并且来源必须是用户消息。** 助手的复述、猜测、编造都不算证据；否则模型可以把自己的猜测洗成关于用户的事实（这个缺陷在留出集里被抓到过，见"评测"一节）。

### 第二层：结构化主体，禁用代词

```json
"target": { "type": "current_speaker" }
"target": { "type": "named_member", "name": "张三" }
"target": { "type": "current_group" }
"target": { "type": "self" }
```

`named_member` 必须给名字。提示词里写死了归属规则（"张三说李四不吃辣" → 李四），并禁止 他/她/用户。存储保留 `target_type` + `target_name`，并派生 `subject`（`Rick` / `member:张三` / `group` / `agent`）用于建键、注入和过滤。

### Owner（主人）是配置出来的，不是猜出来的

`config.json` 里的 `ownerName`（默认 **Rick**，可用 `PI_RT_OWNER` 覆盖）是 `current_speaker` 的规范主体。两个后果：

- 历史行里的 `subject = "user"` 会在启动时改写成 owner 名，所以改名是一次迁移，不是显示调整。
- 归属**在接入时配置，绝不推断**。最早的实现把"第一个说话的人"提升为 owner，结果改主人名会把那个群成员也改名 —— 于是一个本该属于 Rick 的 agent，悄悄把张三变成了主人。`ensureOwner()` 现在按名字匹配，并且不会把其他身份降级。

一个人、多个渠道、一个主体：

- `PI_RT_OWNER_IDS`（或 config 里的 `ownerIds`）列出也属于主人的渠道 id，用于档案名不是 "Rick" 的场景（飞书昵称、Telegram handle）。
- 因此 `members.is_owner` 的含义是"这个身份属于主人"，可以有多行。
- 提炼时把所有 owner 身份折叠成同一主体：来自 Rick 飞书账号的消息存成 `subject = Rick`，不是 `member:陈涛`。否则同一个人会占两个记忆槽，agent 会忘掉一半。

### 第三层：四种裁决，由数据库状态决定

| 动作 | 含义 | 需要 |
|---|---|---|
| `create` | 新槽位 | — |
| `correct` | 值被替换（搬家 / 换工作 / 改偏好） | `target_fact_id` |
| `invalidate` | 被撤回，无替代 | `target_fact_id` |
| `contest` | 相互冲突，无法判断哪个为真 | `target_fact_id` |

抽取器会拿到当前状态（`[ID: 42 | key: … | state: active]`），因此能指向具体一行。数据库再校验这一行确实存在且是 active，并且仍可能驳回提案：

- 对已存在的 key 做 `create` → 变成对该行的 `correct`
- `create` 近似重复（bigram-Jaccard ≥ 0.82）→ 变成 `correct`，并沿用已有 key
- `correct` 但没有可用目标 → 降级为 `create`
- `invalidate` / `contest` 但没有可用目标 → 拒绝

同一个 key 只有一行 `active`（部分唯一索引）。历史以状态标记（`superseded` / `invalidated` / `contested`），永不删除。

**争议中的行不会被注入。** 有争议的事实不是事实；把它当真相喂给模型，比什么都不说更糟。用 `pi-rt resolve <key> <keep-id>` 人工裁决。

### 批量提炼，不是逐条

- **阈值**：累计 `batchTurns`（默认 10）轮未提炼的对话后，`ask` 在结束时提炼。
- **闲置**：`worker` / `serve` 会提炼"最新未提炼事件超过 `idleMinutes`（默认 15）"的线程。
- **可重试**：无法解析的输出**不会**标记为已提炼，下一批会重来。

### 作用域：聊天记录不是代码库

同一个库里既有项目事实也有个人事实，所以注入按线程隔离：从 `feishu:oc_x` 抽出的行只会注入那个会话，手写的行（`thread IS NULL`）全局生效，项目记忆待在自己的线程里。

没有这个隔离时，"我在戒咖啡"会被注入一堆 RPC 传输层的笔记，然后 agent 就开始聊代码 —— 而那段回复又被记成事件、提炼成关于代码库的"事实"。第一次飞书端到端跑出来的正是这个结果，所以才有作用域。

同一次运行还暴露出两件事：

- **不同主体不共享槽位**：相似度去重按 `subject` 过滤，两个都讨厌香菜的人得到两条记忆，而不是互相覆盖。
- **`target_fact_id` 必须在实际展示给抽取器的参考集里**：否则模型编造一个 id 就能改到会话之外的行、改写别人的记忆 —— 加白名单之前确实发生过。

### 注入

只用 active 行，按 `importance` 再按新近度排序，截断在 1800 字符，并且是在**运行那一刻**注入，所以排队的任务看到的是它真正执行时的记忆。

```bash
node src/cli.ts events main                     # 带编号的证据
node src/cli.ts remember "默认使用 bash" --key user_shell --category fact --target self
node src/cli.ts history user_shell              # 完整裁决链
node src/cli.ts resolve user_birth_city 7       # 裁决争议槽位
```

## 通道

一条接入路径，多种传输。消息在任何模型调用**之前**就变成编号事件，所以即使回复失败，证据仍然留存。

```
聊天消息 → Members（身份）→ conversation_event (#id) → task → pi → 回复 → 再记一条事件
```

| 传输 | 状态 | 说明 |
|---|---|---|
| `feed`（本地） | 可用 | `--as <name>` 模拟说话人，用于测试与演示 |
| `telegram` | 可用 | 长轮询，不需要公网地址；需要 `TELEGRAM_BOT_TOKEN` |
| `feishu` | 可用 | 长连接（不需要公网地址）；需要 app id / secret |
| `qq` | 可用 | OneBot v11：WebSocket 收、HTTP 发，见 [`deploy/qq.md`](deploy/qq.md) |
| 其他 | 只留接口 | 接到 `ingest()` 上，见 `src/gateway.ts` |

### QQ 的两种部署

```
有桌面的机器（Windows 本机）  → deploy/qq.md，NapCat 或 SnowLuma 都行
无桌面的云服务器（7×24）      → deploy/qq-desktop/README.md，SnowLuma 官方镜像 + noVNC
```

云上那份文档用官方镜像把 QQ + SnowLuma 压在大约 250MB，并记录了端口绑定、登录态、分体 token 和 swappiness 这几件事。不要再构建自带 `LIBGL_ALWAYS_SOFTWARE=1` 的桌面镜像。

QQ 通道额外支持三种「叫它」的方式，都通过环境变量配置：

```
QQ_ALLOW_GROUPS       群白名单（不设则全部允许）
QQ_GROUP_NO_MENTION   这些群不用 @ 也回复
QQ_WAKE_WORDS         消息里出现这些词就当在叫它（子串匹配）
```

群消息默认只在**真 @ 到它**时才回复。值得注意的是：手动输入 `@昵称` 在 QQ 里只是纯文本，不会产生 at 段，必须从成员列表选中——日志里会打印原始 `at=[...]` 列表来区分这两种情况。

### 飞书接入步骤

1. [open.feishu.cn](https://open.feishu.cn) → 开发者后台 → 创建**企业自建应用**
2. 添加应用能力 → **机器人**
3. 权限：`im:message`（接收）、`im:message:send_as_bot`（发送）；想要真实姓名再加 `contact:user.base:readonly`
4. 事件与回调 → 订阅方式选 **使用长连接接收事件** → 添加事件 `im.message.receive_v1`
5. 创建版本并发布，管理员审核通过
6. 把机器人加进目标会话，然后 `pi-rt serve --channel feishu`

选长连接是刻意的：个人助理躲在 NAT 后面，webhook 需要隧道、域名和证书。代价是控制台必须设成长连接模式。

当前限制：只接入 `text` 消息（富文本 `post`、图片、文件会跳过而不是硬解析）；@ 提及会被剥离；没有通讯录权限时显示名回退成 open_id。

### 飞书的两种传输

| 模式 | 需要 | 何时用 |
|---|---|---|
| `serve --channel feishu` | 应用凭证 | 控制台设了长连接，不需要公网地址 |
| `serve --channel feishu-webhook` | `FEISHU_ENCRYPT_KEY` 做验签 | 有公网地址，或想在本地测 |

webhook 传输存在的理由是：没有真实应用就无法演练长连接。它会校验 `sha256(timestamp + nonce + encryptKey + body)`，解密 `{encrypt}` 信封（AES-256-CBC，key = sha256(encryptKey)，IV = 前 16 字节），应答 `url_verification`，并且**先回 200 再跑 agent** —— 飞书会重投慢响应，重投就会变成第二条消息、第二条记忆。

### 幂等

IM 平台在 ack 慢时会重投。`claimMessage(channel, message_id)` 在创建事件之前记下传输层 id，所以重投会被丢掉，而不是产生第二条事件（进而第二条记忆）。

```bash
node tests/channels.test.mjs        # 9 项：解析、提及、富文本/空/坏载荷、去重
node tests/feishu-webhook.test.mjs  # 13 项：验签、解密、challenge、ack、token、加密事件
```

## 上下文

记忆是 agent 永远知道的东西，上下文是它这一轮还能看见的东西 —— 两套不同机制。

每次的 prompt 这样组装：

```
① 指令（临时状态标记的用法）
② 长期记忆（按作用域过滤）
③ 短期状态（带剩余时间，排在记忆之前）
④ 会话摘要（滚动压缩）
⑤ 最近对话窗口
⑥ 冲突提示（检测到时才出现）
⑦ 当前消息
```

`src/context.ts` 里两条规则：

- **新的优先**：预算从后往前消耗，所以最近的一轮永远在。丢掉最新一轮的窗口，比没有窗口更糟。
- **单条超长消息仍然保留**：当前问题绝不能因为它自己太长或被前面闲聊挤掉。

窗口是**视图**而不是存储：事件始终追加写入，所以压缩可以之后再做而不丢原文。

### 滚动摘要

窗口有限，对话迟早从后面掉出去。当线程的"冷区"（摘要游标到窗口之间的一切）超过 `summaryTriggerChars`，就在生成答案之前压缩：

```
thread_state { thread, summary, summarized_until_event_id }
```

- **结构化输出**，不是散文：已确认事实 / 用户指令与偏好 / 未决问题 / 关键实体。
- **游标只在成功后推进**。压缩失败时游标不动，下一轮重试同一批事件，而不是悄悄丢掉。
- **摘要是派生视图**，源数据仍在 `conversation_events`，压缩错了可以重算。
- **压缩失败绝不让回答失败** —— 只用窗口继续。

```bash
pi-rt thread <thread>    # 看实时状态（事件数、游标、摘要）
```

### 实测：窗口 vs 窗口+摘要

同一份对话、两种条件（baseline = 固定 30 条窗口；system = 6 条窗口 + 滚动摘要）：

| 场景 | baseline | system | 结论 |
|---|---|---|---|
| 短会话（5 轮闲聊） | 10/10 | 10/10 | 窗口够用，摘要没有增益 |
| 长会话（20–25 轮闲聊） | **0/5** | **5/5** | 事实被挤出窗口，摘要全部捞回 |

诚实的读法：摘要**不是**普遍改进，它只在窗口装不下时才有价值；在短会话里是纯开销。而且 baseline 不是稻草人 —— 更大的窗口也能过长会话那几题，摘要在**成本有界**上赢，不是"唯一解"。

## 上下文编排

prompt 现在由 `src/compose.ts` 组装：一个纯函数，渲染各段并返回 manifest。P1 阶段是零行为变化的重构 —— 前后 prompt 逐字节对比完全一致（485 字符）。

每次运行都会记 `context_plan`：

```json
{"budgetChars":4000,"usedChars":486,"estimatedTokens":139,"charsPerToken":3.5,
 "segments":[{"kind":"instructions","chars":86},
             {"kind":"memory","chars":290,"meta":{"ids":[31,30,29,5,4,3]}},
             {"kind":"short_state","chars":165,"meta":{"keys":["hotfix_branch","deploy_port"]}},
             {"kind":"current","chars":17}],"skipped":[]}
```

### 段的预算、淘汰与去重（P2）

| 段 | floor | cap | 先丢什么 |
|---|---|---|---|
| 指令 | — | — | 永不 |
| 长期记忆 | 150 | 900 | 尾部低优先行 |
| 短期状态 | 0 | 300 | 尾部行 |
| 摘要 | 0 | 1000 | 尾部段落 |
| 最近窗口 | **1200** | 2800 | **最旧**的行（新的必留） |
| 检索 | 0 | 800 | 第一个被淘汰 |
| 当前消息 | — | — | 永不 |

预算紧张时的淘汰顺序：`检索 → 短期状态 → 记忆 → 摘要 → 窗口`。窗口有硬保底，所以再长的记忆也挤不掉最近的对话。

**跨段去重**在分配之前跑：已经出现在更高优先级段里的行会从低优先段删掉（`窗口 > 短期状态 > 记忆 > 摘要`）。比较前先剥掉展示前缀（`- [事实·4] …`、`[Rick] …`）—— 不剥的话，相似度测的是格式而不是内容。

真实运行里的证据：

```json
"dedup": [{"kind":"memory","dropped":"runtime 状态存 SQLite 而非 Postgres…",
           "keptIn":"higher-priority segment","similarity":0.73}]
```

记忆段 311 → 258 字符，其余部分一字未变。

manifest 记录每段的 `floor`/`cap`/`truncated`/`droppedChars`，以及 `evictions[]`、`dedup[]`、`overBudget`。

### token 校准

用 `chars / 3.5` 估 token 只是猜。provider 会报真实用量，所以比例是**学出来的** —— 但有个会改变结论的细节：

**provider 的 `input` 不是我们的 prompt。** pi 还会发自己的系统提示和工具 schema，所以计数里含一段固定开销。直接相除会虚高；诚实的模型是一条直线：

```
provider_input_tokens ≈ slope × 我们的prompt字符数 + intercept
```

`src/calibration.ts` 用最小二乘拟合，**满 8 个样本**才启用，并报告 `r2` 让差拟合可见；不足时回落到 3.5。

```bash
pi-rt calibrate --backfill   # 从 usage.input ⨝ context_plan.usedChars 回填样本
pi-rt calibrate              # 看斜率、截距、r2、最终比例
```

本机当前拟合：`slope 0.3259 tokens/char`、`intercept 115 tokens`、`r2 0.692`、`3.07 chars/token`。

两个结论：默认的 3.5 对中文密集内容是**低估约 12%**；`r2 = 0.69` 说明可用但有噪声，所以 manifest 记下实际用了哪个比例，估错了能追溯。

### 冲突提示

当一条记忆与刚说的话不一致时，prompt 里会多一小段：

```
## 上下文冲突提示
- 记忆「部署端口是 3000」与最近对话不一致（相似度 0.23），以最近对话为准
```

**读路径永远不写。** 启发式错一次就会永久污染一条事实，所以提示只声明优先级；真正的改写留给提炼（四态裁决 + 证据校验）。每次运行都会记 `context_conflict`。

检测需要两个信号，缺一不可：

| 信号 | 例子 | 另一个为什么不行 |
|---|---|---|
| 同话题 + 数字不相交 | 端口是 `3000` → 端口改成 `8080` | 词面相似度只有 **0.23**，任何可用阈值都够不到 |
| 无数字的措辞漂移 | 「必须完全避开」→「偶尔吃一点没事」 | 没有数字可比 |

相似度用**包含度**（`|A∩B| / min(|A|,|B|)`）而不是 Jaccard：Jaccard 惩罚长度，把过敏那对改写句打到 0.21，包含度是 0.42。措辞分支还要求双方都不含数字，这样"端口 8080 已确认"不会被判成与"端口是 8080"矛盾。

实测：

```
记忆: 部署端口是 3000       窗口: 部署端口改成 8080 了。
→ context_conflict 事件已记录，记忆未被修改
→ 回答: "当前部署端口是 8080 …… 长期记忆里的 3000 已作废"
```

## 短期状态

长期记忆回答"关于这个人什么是真的"，短期状态回答"我们正做到哪一步"。端口、分支、待办链接、任务进度必须跨轮存活，但不该变成永久信念 —— 这是不同的机制，不是记忆的另一个类别。

| | 长期记忆 | 短期状态 |
|---|---|---|
| 寻址方式 | 主体 + key，按作用域注入 | key，直接命中 |
| 生命周期 | 永久，按类别衰减 | 显式 TTL（1 分钟 – 30 天） |
| 写入 | 批量、异步 | **同步** |
| 冲突时 | 四态裁决 | 最新值胜 |

同步写入是关键：「已记住」这句话在说出口的瞬间必须为真，异步提炼器保证不了这一点。

```bash
pi-rt state set deploy_port 8080 --ttl 7d
pi-rt state list                                   # 剩余时间 + 晋升提示
pi-rt state promote deploy_port --category fact    # 槽位 → 长期记忆，槽位移除
```

agent 也能自己写，用控制标记，由服务端解析而不是再跑一次模型：

```
<!--state: debug_port=8899; ttl=7d-->
```

标记会在存储和发送之前剥掉，用户永远看不到。实测：让它"把端口 8899 记成临时状态"，槽位出现且剩 168 小时，可见回复只有"已记下调试端口 8899，有效期 7 天。"

守卫：槽位与记忆同级 —— 名字像凭据（`db_password`）或值像凭据一律拒写，因为槽位同样会进 prompt。

## 人格：两个常驻文件

人物性格不是一句"你是一个专业友好的助手"——那种描述对模型行为没有任何约束力。这里用两个文件，都在**每轮 prompt 的最前面**：

```
persona/SOUL.md       怎么说话（语气、禁忌、示例）   预算 4,000 字符
persona/CONTRACTS.md  怎么干活（证据、分寸、完成标准） 预算 3,000 字符
```

**为什么拆两个**：人格改坏了只影响语气，纪律改坏了影响所有任务。更实际的原因是防一个失败模式——傲娇人格渗透进执行纪律，变成「明明构建失败了，但承认显得不够傲娇」。

**为什么用字符不用 token**：渲染时不需要 tokenizer，而且改文件的人能直接数。**为什么独立预算**：人格是固定成本，不该和记忆抢空间。

渲染出来带用量标注，模型自己能看见还剩多少：

```markdown
## 人格（persona/SOUL.md）[13% — 502/4000 字符]

你是油桃，Rick 的助理。你不打算承认自己挺在意这份工作。
...
```

超限时截断，但**明确告诉模型完整文件还在磁盘上**——不说这句，模型会把截断读成失忆，然后开始道歉。

```bash
node src/cli.ts persona init     # 生成两个默认文件
node src/cli.ts persona usage    # 看用量
node src/cli.ts persona show     # 看内容
```

改文件下一轮即生效，不用重启。

人格机制的来源：[Tobs 的 `soul.ts`](https://github.com/BotHarness/DeepSeekBot/blob/main/packages/core/src/memory/soul.ts)（字符预算 + 百分比标注 + 截断公告）、[Yuki 的 `prompting/contracts.py`](https://github.com/YuanYeYouTao/Yuki)（把人格与执行纪律分成两层）。

## 提醒：唯一会主动找你的东西

记忆是"说完之后还记得"，提醒是"什么都不说也会来找你"——运行时里唯一不需要被叫醒的行为。

模型在回复末尾写一行控制指令，运行时解析、落库、到点推送：

```
<!--remind: 2026-10-27 15:00 | 跟王工对 Orion-7 进度-->
```

四个实现决定：

- **用控制指令而不是工具调用**：工具需要一次额外的 RPC 往返，而控制指令能随回复一起原子完成
- **时间按东八区解释**：容器跑 UTC，用户不在 UTC；`2026-10-27 15:00` 解析成 `07:00Z`
- **支持相对时间**：`30分钟` / `2小时` / `1天`，因为人常常这么说
- **去重**：同一线程 + 同一文本 + 同一时刻只存一条，避免模型换个说法重复登记

推送循环 30 秒扫一次（分钟级精度足够），发送走和普通回复同一条路径：

```bash
node src/cli.ts remind             # 列出待触发
node src/cli.ts remind cancel 3    # 取消 #3
```

## 凭据守卫

留出集跑出了最糟的一种失败：贴进来的密码被当成偏好存了下来 —— 于是被注入到之后每一轮 prompt、渲染进 `MEMORY.md`、持久化在 SQLite 里。`src/secrets.ts` 现在在**写入边界**（`MemoryStore.apply`）拒绝凭据，而不是靠提示词。

| 拦什么 | 依据 |
|---|---|
| `密码是 <值>` / `password: <值>` | 关键字 + 分隔符 + 值形状的 token |
| `sk-…`、`ghp_…`、`gho_…`、`xox*-…`、`AKIA…`、`AIza…` | 供应商 token 前缀 |
| `Bearer <token>`、`-----BEGIN … PRIVATE KEY-----` | 认证头、私钥块 |
| 28+ 字符且 ≥3 类字符 | 生成串 |
| 银行卡 / 支付密码 + 6 位以上数字 | 卡号与 PIN |

另一个失败方向是误报：「我的密码策略是 90 天改一次」必须能存，一个把它也拦掉的系统会被用户关掉。所以赋值规则要求关键字后面**真的有值**，UUID 和 hex 摘要从熵规则里排除，`tests/secrets.test.mjs` 锁了 9 个必须拦、7 个必须放。

约束是代码，不是感觉：提示词里也写了"凭据一律不记"，但提示词可以被模型说服。被拦的写入会留一条 `memory_blocked` 审计事件，内容是**脱敏预览**。


## 记忆的可审阅投影（借鉴 Tobs）

数据库仍是权威源，但它对人不可读。`pi-rt memory-git` 把记忆导出成一个 Git 仓库：

```
data/memory-repo/
  MEMORY.md                    索引：按主体分组，每条一行
  memories/<subject>/<key>.md  每条记忆一个文件，带 front-matter
```

每个文件都带 **证据引用**（事件 id + 逐字引文），所以审阅者能回答"它凭什么这么记" —— 这是纯笔记型记忆仓库做不到的。无变化不提交；历史不重写，可 `git log -p` 看每次改动。

### 顺带修的两件事

- **prompt 段按变化频率排序**（frozen → stable → volatile），manifest 记录 `cacheableChars`。实测一次运行 551 字符里 439 字符（80%）是稳定前缀，可命中 provider 的 prompt cache。
- **截断不再静默**：被裁剪的段尾部会加一行说明，模型知道自己看到的不完整 —— 静默丢行会让它自信地答错。

## 子 Agent（spawn）

`ask --spawn N` 让模型把自己的任务拆成 N 个子任务，并行执行，再由父回合汇总。

```bash
pi-rt ask "分别说明 WAL 的优点和代价" --spawn 2
pi-rt tree <task-id>          # 看派生树
```

实测（WAL 那题）：

```
t_mvo1i46i_wqb7x  done  191 字符  8s
  └─ 拆分任务       done  331 字符  3s
  └─ 子任务 1       done   56 字符  2s
  └─ 子任务 2       done   88 字符  2s
  └─ 汇总           done  191 字符  2s
子任务 4/4 成功，总耗时 8s
```

四个设计约束，每个都有具体理由：

| 约束 | 做法 | 为什么 |
|---|---|---|
| **独立上下文** | 子任务跑在 `<thread>#subN`，看不到父线程历史 | 第一版共用线程，日志显示子任务"携带 6 条历史"——那不算独立上下文 |
| **并发受控** | 子任务用自己的 `Gate(PI_RT_SPAWN_CONCURRENCY)`，默认 3 | 父任务的 `maxConcurrent` 是为了串行化无关任务，不该限制一批并行子任务 |
| **失败隔离** | 单个子任务失败返回 `{status:"failed"}`，其余继续 | 汇总时明确告诉父模型"这部分缺失"，而不是整体失败 |
| **聚合有界** | 每个子任务输出截断到 1200 字符 | 汇总方收到三篇长文，比自己做还贵 |

**拆分由模型完成，不按标点切** —— 边界应该跟着工作走，而不是跟着格式走。


## 运行链路（Tracing）

一次任务会产生一棵 span 树，落在 `spans` 表里，`pi-rt trace <task-id>` 打出来：

```
$ pi-rt trace t_mvo1ynmy_hfn4a
• 1282ms  task/attempt 1  (chars=2, tokens=6062)
  • 1254ms  model/deepseek-flash  (chars=551, tokens=6062)
  •    2ms  compose/context  (chars=551, cacheable=439)
```

读法：**时长越大越靠上，✗ 表示该层失败，问题就在那一层往下找**。三层的含义：

| 层 | 看什么 | 常见问题 |
|---|---|---|
| `compose` | 上下文组装耗时与字符数 | 组装慢说明去重/检索是瓶颈 |
| `model` | 模型调用耗时、输入字符、token | 慢在这里，就优化上下文或换模型 |
| `tool` | 每次工具调用的耗时与成败 | 工具失败率高，问题在工具或权限，不在模型 |

这是 JD 里那句"从盯着日志猜测，变成打开链路即可定位"的最小实现。
## 工具审计与 MCP 边界

`pi-rt tools` 把工具调用从事件日志里聚合出来：

```
$ pi-rt tools
MCP      未配置
调用
  bash                               次数  24  成功 100%  平均 292ms
  read                               次数   1  成功   0%  平均 3ms
沙箱     safe · 安全：禁用 bash（不能执行命令），可以读写工作区文件
统计范围 最近 30 天
```

数据来自 `tool_execution_start` / `tool_execution_end` 事件：结束事件定成败（它带 `isError`），开始事件只用来量耗时 —— 缺了开始事件就显示"未知"，而不是算成 0。

### MCP：不是"要不要支持"，是一个必须先堵的洞

pi 自带 MCP 客户端（`pi mcp add`，配置在 `data/pi/mcp.json`）。我们不需要重写协议，但**沙箱必须认识它**：

| 模式 | 内置工具 | MCP 工具 |
|---|---|---|
| `readonly` | 只 read | **全部禁用**（`mcp__*`） |
| `safe` | 除 bash | 允许 |
| `full` | 全部 | 允许 |

`readonly` 排除 `mcp__*` 是刻意的：MCP server 自己声明能力，我们无法检查它会不会写。一个"只读"模式如果留着 MCP 开口，就不是只读 —— 任何人 `pi mcp add` 一个 filesystem server 就能把写权限重新打开。
## MCP 工具集

四个手写 server（无 SDK 依赖），全部以 `direct` 暴露给模型：

| server | 工具 | 说明 |
|---|---|---|
| `fetch-server` | `fetch` `search` | HttpOnly + SSRF 防御；搜索优先 Bing（DDG 在境内不可达） |
| `memory-server` | `memory_search` | 只读打开数据库，只返回 `active`，强制同 embedding 空间 |
| `knowledge-server` | `knowledge_search` `knowledge_list` `knowledge_add` | 文档切分 600 字符 / 80 重叠，同名覆盖 |
| `spawn-server` | `fanout` `note_write` `note_read` `lock_file` `unlock_file` `list_locks` `send` `propose_self_edit` | 派生、共享便签、路径锁、主动播报、自改申请 |

运行时还暴露一个本地控制 API（`127.0.0.1:8899`）：`/fanout` `/notes` `/lock` `/send` `/proposal` `/health`。
**调度权只在运行时一处**——MCP server 是薄客户端，否则会出现两个进程抢同一个队列。

## 自我修改：改能力面，不改代码

`propose_self_edit` 允许模型申请两类改动，**都必须人工批准**：

```
persona/SOUL.md · persona/CONTRACTS.md      → 改语气与纪律
mcp:<name>                                  → 新增/替换一个 MCP server
src/**                                      → 永远拒绝
```

MCP 那条额外加五道限制：命令白名单（node/npx/uvx/python3/deno/bun）、参数路径必须在 `/workspace`、
env 值疑似凭据即拒、最多 8 个 server、必须写理由。应用后写 `mcp.json`，可 `proposal-revert` 精确回滚。

**为什么不做“模型审模型”**：只有一条模型链路时，让同一个模型审自己的补丁等于没审。这里人就是审查者，
校验器只兜机械性错误。

## 知识库与记忆为什么分开

| | 记忆 | 知识库 |
|---|---|---|
| 回答 | 关于这个人的结论 | 这份文档说了什么 |
| 形态 | 结构化行 + 证据外键 | 切分后的文本 + 向量 |
| 写入 | 蒸馏自动（有人工审批的置信度门限） | `knowledge add` 或 `knowledge_add` |
| 检索 | 结构过滤（默认注入） | 余弦 top-k（按需调用） |

**分开的意义**：文档内容不能伪装成“用户说过的话”，长 PDF 也挤不掉记忆预算。
## 事件日志：什么值得留

每一条 RPC record 过去都原样入库，其中大部分是流式增量：pi 每个 token 发一条 `message_update`，用 start/end 包住每一轮 —— 活着时有用，事后无用，因为最终答案已经作为对话事件存在了。

实测成本：**19,738 行里的 19,313 行（7.5 MB 中的 83%）**，约 30 次运行。

| 丢掉 | 保留 |
|---|---|
| `message_update`、`message_start`、`message_end` | `tool_execution_start` / `_end`（压缩字段） |
| `turn_start`、`turn_end`、`agent_start` | `agent_end`（只留停止原因） |
| `tool_execution_update`（工具增量输出） | `error`、`usage`、`context_plan`、`context_conflict` … |

两条规则让剩下的行既诚实又小：

- **写入时压缩**：只留有信息量的字段（`toolName`、`toolCallId`、`isError`、输出）。
- **截断要留标记**：超过 2,000 字符的 payload 变成 `{truncated: true, originalChars: N, preview: "…"}` —— 绝不假装它本来就这么小。

本机结果：`19,738 行 / 7,531 KB → 302 行 / 197 KB`，数据库 `10.80 MB → 0.49 MB（-95.5%）`。现在一次运行只写 **7 行 / 1.1 KB**，`agent_end` 从 22 KB 降到 51 字节。

```bash
pi-rt compact --dry-run    # 先看会删什么
pi-rt compact --vacuum     # 删噪音、截断超长行、回收磁盘
```

## 沙箱：真正被强制执行的部分

三层，全部在提示词之外执行 —— 模型能忽略的指令不是边界。

| 模式 | shell（`bash`） | write / edit | 用途 |
|---|---|---|---|
| `readonly` | ❌ | ❌ | 回答关于代码的问题 |
| `safe`（默认） | ❌ | ✅ | 日常助理工作 |
| `full` | ✅ | ✅ | 必须执行命令的任务 |

`--exclude-tools` 是交给 pi 本身的，所以工具不是被"降级"，而是**不存在**。

**环境变量收窄**：子进程不再继承 `process.env`，只拿 OS 白名单（`PATH`、`SystemRoot`、`TEMP`…）加几个控制变量。pi 从自己的配置目录读模型凭证，所以功能没有损失 —— 而 shell 再也 `echo` 不到 `$FEISHU_APP_SECRET`。

**工作区护栏**：拒绝磁盘根目录、用户主目录、以及系统目录（`/etc`、`/usr`、`/var`、`C:\Windows` …）。在 `C:\` 下运行 agent 意味着它随手想到的绝对路径都在射程内。

实测（不是"应该"）：

```
readonly  → "本次会话我只挂载了 read 工具，没有写文件或执行命令的能力"
            sandbox-probe.txt 确实没被创建
safe      → "当前会话只挂载了 read / edit / write 三个文件工具，没有 shell 执行工具"
full      → 父进程 export PI_RT_TEST_SECRET=TOPSECRET-123
            子进程里该变量 UNSET
```

### 这不是什么

`read` 工具仍然能读你有权读的任何文件 —— 包括 pi 自己的凭据文件，所以处理不可信任务时只有 `readonly` 勉强算安全。没有网络出口限制，`full` 模式下环境变量收窄是 shell 与密钥之间的唯一屏障。

真正的隔离需要容器或虚机。这里实现的是**能力限制**，以极低成本移除最锋利的边缘（`rm -rf`、`git push --force`、任意进程）。

## 归档与备份

两个不同的问题，两套机制。

**归档**把旧的对话事件搬出主表到 `data/archive/*.jsonl.gz` 再删除。三条排除规则，各有理由：

| 保留 | 为什么 |
|---|---|
| 还没提炼的 | 仍是待办工作，归档等于丢记忆 |
| 被某条记忆引用为 `evidence_event_id` 的 | 删了证据链就断了 |
| 最近的 | 还在上下文窗口里 |

归档文件保存原始行，所以"删了"是可逆的。

**备份**用 `VACUUM INTO` 生成一致性快照再压缩 —— 不是拷文件，因为库跑在 WAL 模式，复制可能拿到撕裂状态。`serve` 会在最新备份超过 24 小时时自动做一次。

```bash
pi-rt archive --days 30 --dry-run
pi-rt archive --days 30
pi-rt archive --list
pi-rt backup --keep 7
```

本机实测：库 0.49 MB → 备份 **86.5 KB**；`--days 0` 时 77 条可归档、11 条因证据保留。

## 作为服务运行

`pi-rt serve` 收到消息就回答，并在后台跑维护循环。

它补的缺口是：提炼默认在**第 N 轮**（10）之后触发，所以两三句的对话永远够不到阈值、记忆永远不被抽取 —— 用户说了值得记的东西，然后被悄悄丢掉。而真实的 IM 对话大多是短的。

```
每 PI_RT_MAINTENANCE_MINUTES（默认 5）：
  清理过期的短期状态槽位
  对每个闲置超过 PI_RT_IDLE_MINUTES（默认 15）的线程：
    提炼，除非该线程正在回复
```

两个必要的守卫：

- **绝不在回复中途提炼**：`src/maintenance.ts` 接收一个 `busy` 集合，消息处理器在任务运行期间持有它；没有它，抽取器会看到半截对话。
- **单个失败不能中断整轮**：某个线程提炼抛错就记录并跳过，一个坏对话不能卡住其他所有。

`serve --no-maintenance` 可关闭该循环（当另一个 `pi-rt worker` 负责提炼时）。

端到端验证过：两条 webhook 消息（低于 10 轮阈值）在下一个 tick 被提炼出 `trip_budget_cny`，没有执行任何手工命令。

### 部署到云上

`deploy/` 里有完整产物：Dockerfile、compose、systemd unit、bootstrap 脚本。详见 [deploy/README.md](deploy/README.md)。

要点：飞书长连接是**纯出站**的，所以不需要公网 IP、域名、证书和 ICP 备案；单实例设计（SQLite + 一条长连接）不能水平扩容。

## 评测

三套，刻意分开：

| 集合 | 用途 | 状态 |
|---|---|---|
| `eval/cases.json`（28） | 开发基准，调参用过 | 样本内，不可引用 |
| `eval/holdout.json`（10） | 第一次留出 | 因 `h01` 报销（凭据泄漏） |
| `eval/holdout-secrets.json`（10） | 验证凭据守卫 | 因断言修正报销 |
| `eval/holdout-v3.json`（30） | **当前基准** | 跑一次，3 次重复 |

单次只给一个数字，不告诉你它稳不稳。`--repeat` 会把整套再跑一遍并报告均值 / 最小 / 最大 / range —— 这就是"10 题对 9 题"和"87% ± 10 个点"的区别。

```bash
pi-rt eval --cases eval/holdout-v3.json --repeat 3
```

让数字有意义的纪律：**题先写好，跑完不改**。用例失败就作为发现报告，而不是顺手修掉 —— 否则基准就变成"这次改动"的描述。

### 结果：30 题 × 3 次

| 指标 | 均值 | 最小 | 最大 | 区间 |
|---|---|---|---|---|
| 通过率 | **87.8%** | 83.3% | 93.3% | 10.0 pt |
| precision | 85.0% | 80.0% | 88.0% | 8.0 pt |
| recall | 93.9% | 90.9% | 100.0% | 9.1 pt |
| 凭据泄漏 | **0** | 0 | 0 | 0 |

两次失败是**系统性**的（三次都错）：

- `v25_paraphrase` —— 唯一的事实句是助手在复述，抽取器把它学了。校验只检查引文在所引事件里，不检查该事件是**用户**消息。
- `v20_invalidate` —— 动作识别对了，但状态没翻转。

还有四条在运行之间摇摆，这正是 `--repeat` 的全部理由：单次在这里可能报 83% 也可能报 93%。

**同日更正：** `v20` 不是系统缺陷 —— 我的断言写了 `must_be: "invalidated"`，而校验器不支持这个值，于是落进默认分支（要求恰好一条活跃行），作废后活跃行为 0 就判失败。作废本身是成功的。由此做了两件事：`checkState` 遇到未知 `must_be` 直接抛错，用例改成 `old_inactive`。

真正的缺陷只有 `v25`，已修复：**证据必须来自用户消息**。在新一组 8 题（4 条仅助手发言 + 4 条用户亲述对照）上验收：**8/8**，四条助手断言全部被拒、四条对照全部学到。

### 关于"100%"的诚实说明

开发集在 `deepseek-flash` 上曾连续跑出 28/28。但同样的 28 题连续多轮会产生 27/28、26/28、28/28 —— 而几乎每次"失败"查下去都是**判分问题**：断言了模型合理不认同的类别（`主要用 Go` 是偏好还是事实）、在纠正事件已经让旧事实失效时硬要 `invalidate`、或者在主体已验证的情况下还要求内容里出现人名。由此固化了三条判分规则：

- **类别是软指标**，只报一致率，不作为通过门槛 —— 它是最不稳定的字段。
- **失效看状态**：「被撤回的那句话不再活跃」，而不是「槽位为空」。
- **`allow_contains`** 容忍用例没有枚举的合理额外事实。

所以 100% 只说明"系统拟合了这份基准"，不说明"基准很难"。这 28 题被六轮提示词与判分调优用过，只有留出集才能让数字可引用。

整个过程中暴露的问题，按顺序：

1. **JSON 被截断**丢掉整批 → 解析器在断点前抢救完整对象。
2. **`invalidate` vs `correct`** —— "已停止"留下幽灵活跃记忆 → 提示词里把边界写清。
3. **真值太窄** —— 合理的额外事实被记成误报 → 用例可以声明 `allow_contains`。
4. **失效判分太严** —— 纠正事件（"猫死了"）和 `invalidate` 一样能让旧事实失效 → 状态检查改为断言"被撤回的话不再活跃"。
5. **类别当门槛是最吵的判据** → 降级为软指标。

只有第 1、2 条是系统缺陷，3–5 是**测量缺陷**。这个比例才是真正的教训：一个反复失败的评测，多半在告诉你它的判据有问题。

## 设计决策

- **用 RPC 而不是 SDK。** SDK 把 pi 嵌进进程（更快，但一次崩溃就带走队列，且 agent 与我们共享内存）。RPC 保持硬进程边界，且与语言无关 —— IM 网关或容器化 runner 需要的正是这条接缝。
- **手写 JSONL 分帧。** pi 的协议是一行一个 JSON 对象。`readline` 在这里是错的：它还会按 `U+2028`/`U+2029` 切，而这两个字符在 JSON 字符串里是合法的。
- **等 `agent_settled`，不等 `agent_end`。** `agent_end` 只结束一次底层运行；重试、压缩、排队工作还可能继续。只有 `agent_settled` 意味着"它不会自己再动了"。
- **用自己的数据库，不用 pi 的 session。** 运行时用 `--no-session` 跑 pi。持久化归编排层，这样加 retry、resume、审计、多渠道投递都不用读 pi 的内部格式。
- **隔离配置目录。** `PI_CODING_AGENT_DIR=data/pi` 把运行时的凭证和设置与用户的全局 `~/.pi/agent` 分开。
- **`--no-approve`。** 守护进程没法回答信任确认，所以默认拒绝项目本地资源。

## 状态

**已完成并验证：**

- 队列 → 派生 → 流式/错误 → 持久化 → 僵尸任务回收
- 记忆 v3：编号事件、逐事件证据绑定、结构化主体、四态裁决、争议行不注入、批量提炼、完整审计链
- 凭据守卫：写入边界拦截，值泄漏 0；`memory_blocked` 审计事件
- 短期状态：TTL、同步写、晋升、agent 自写、过期清理
- 上下文：窗口 + 滚动摘要；编排（段预算 / 淘汰顺序 / 跨段去重 / 冲突提示 / token 校准 / manifest）
- 可靠性：按错误分类的重试、并发门、双层预算（provider 真实用量）
- 运维：事件表瘦身、可逆归档、一致性备份、每日快照
- 安全：工具能力限制、环境变量收窄、工作区护栏
- 通道：本地 `feed`、Telegram 长轮询、飞书长连接与 webhook、QQ（OneBot v11，WebSocket 收 / HTTP 发）、传输层幂等
- 人格：`SOUL.md` + `CONTRACTS.md` 两个常驻文件，独立字符预算、用量标注、截断公告
- 提醒：控制指令登记 → 落库 → 30 秒轮询 → 主动推送（东八区解析、相对时间、去重）
- 群聊治理：真 @ 才算叫它、指定群免 @、关键词唤醒；跳过时打印原始 at 段用于诊断
- 服务化：`serve` 后台维护循环（闲置提炼 + 过期清理 + 每日备份）
- 部署：一台 Debian 13 云服务器，飞书长连接 + QQ 通道（snowluma 容器内的 QQ + 协议端）
- 工程：CI 跑 737 项测试 + 密钥扫描 + 脚本语法检查、MIT LICENSE、无桌面 QQ 部署的可复现文档
- 置信度：`confidence.ts` 接进 `apply()`，`tentative` 永不注入，手写记忆跳过评分
- 死循环：状态指纹（工具 + 参数稳定哈希），连续 3 次告警 / 6 次中止
- HITL：`<!--ask:-->` 挂起 → 同意/拒绝/超时 → 重跑原请求
- 多智能体：模型自主 `fanout`、子任务独立线程、共享便签、冲突仲裁（最后写入 + 显式上报）、失败重试一次
- 主动播报：`send` 工具，每任务 3 条上限，只能发当前会话
- 并发文件锁：路径级租约 + TTL 自愈 + 跑前跑后哈希对比（不依赖配合的冲突发现）
- 文档知识库：切分 / 向量 / `knowledge_search`，与记忆严格分离
- 自我修改：人格与 MCP 配置可申请修改，人工批准 + 精确回滚，`src/**` 永不可改
- 提醒：飞书与 QQ 双通道都已有投递循环

**已知缺口：**

- 富媒体（图片 / 文件 / 语音）直接丢弃
- 流式输出：pi 有 `text_delta`，但没有推送到 IM 的出口（飞书支持消息更新，QQ 不支持）
- 检索质量：默认 hash embedding 只抓字面相似，未接真实 embedding；无 rerank、无 query 改写
- 事件层未脱敏：含密码的原始消息仍明文存在 `conversation_events`
- 单条评测用例在不同运行间抖动（30 题里约 4 条），尚未定位
- 单实例：SQLite + 一条长连接，不能水平扩容
- 真隔离未做：需要容器/虚机，且 `read` 工具仍能读用户可读的一切
- 持续工作（Work 生命周期）没有实现：跨轮目标靠记忆和摘要顶着，而不是显式状态机

下一步见 [ROADMAP.md](ROADMAP.md)。
