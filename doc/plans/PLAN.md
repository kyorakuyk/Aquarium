# Aquarium 施工计划书（唯一任务清单）

> 写给接手编码的模型。最后更新：2026-10-20。**当前任务：§15 夜间任务包（V18f → §13）；所有任务先遵守 §0.1 提速规则。**
> **本文是唯一的任务清单。**文档优先级：`PLAN.md` > `HANDOFF.md`（只作为架构、接口、环境的参考）> `DESIGN.md`（设计依据）。
> `REVIEW-2026-10-12.md` 与 `NIGHT-RUN.md` 已并入本文，**作废，不再阅读**。`MORNING.md` 只作为历史记录。
> 开工前按顺序读：本文全文 → `HANDOFF.md` §1、§3、§4 → `DESIGN.md`（需要时查阅）。
> **无人值守（夜间）运行时，§7 的规则覆盖 §0 中与之冲突的条款。**

---

## 0. 工作规则（必须遵守）

1. **白天有人值守**：遇到本文没写清楚的地方，**停下来问用户**，不要猜。
2. **严格按 §3 的顺序做**，一次只做一个任务。遇到标 **⛔ 停止点** 的地方必须停下，等用户明确说“继续”。
3. 每个任务完成时：
   - `npm run check` 全部通过（类型检查、边界检查、测试）；
   - 在本文把该任务的 `[ ]` 改为 `[x]`，并在 §5「进度日志」追加一行；
   - **一个任务一个提交**，提交信息：`<类型>(<范围>): <中文描述>`，类型用 feat / fix / chore / docs / test / refactor。
4. 分支：继续在 `night/2026-10-12` 上工作，**不要合并到 `main`**（合并由用户在 ⛔ 停止点 1 之后决定）。
5. **绝对禁止**：
   - 修改 `reference/` 下任何文件；
   - 提交 `.env`、`data/`、`IDEA.md`、任何密钥或聊天记录；
   - 用 CQ 码字符串发消息（必须用消息段数组）；
   - 运行 `npm start` 或任何 `src/spike/*.ts`（真实环境验证一律由用户做）；
   - 接入或操作 bot 小号以外的 QQ 账号；
   - 在 `src/adapters/onebot/` 以外 import `@snowluma/sdk`（`src/spike/ping.ts` 的既有豁免除外）；
   - 复制 `reference/MaiBot` 的任何代码或提示词原文（GPL-3.0）。
6. 代码约定：TypeScript，**注释用中文**，标识符用英文；只用可擦除语法（不用 `enum`、`namespace`、参数属性）；相对导入写完整扩展名 `./foo.ts`。
7. 测试约定：单元测试不访问网络、不连接 SnowLuma、不读写 `data/`；**临时目录一律用 `os.tmpdir()`**（R6 之后）。
8. 不扩大范围：想到的点子写进 §6「待评估清单」。

---

## 0.1 提速规则（2026-10-16 起生效，覆盖本文其他地方与之冲突的流程要求）

近期每个任务耗时越来越长，主要花在流程上，不是写代码。从现在起：

1. **不做**精确 staged review、SHA-256 记录、checkpoint tag、reviewer 子代理复审。每个任务提交前自己看一遍 `git diff`，就够了。只有任务标 🔍 时才做一轮独立 review（最多一轮）。阶段审查发现问题并修复后，**不需要第二轮独立审查，也不算审查失败**：修复提交通过 `npm run check` 即视为该阶段完成，在早上检查清单里列出修复内容即可，由用户或 Claude 事后复核。
2. **测试分两档**：开发中只跑相关文件，`node --test test/<相关>.test.ts`；**提交前跑一次** `npm run check`。前端只在改了 `panel/` 时才跑 `npm run panel:build`。
3. **测试只覆盖规格列出的测试点**，每点 1–2 条用例。不为“更完整”加额外用例，不做先红后绿的仪式记录。
4. **记录从简**：§5 进度日志每个任务一行，不超过 60 字。任务条目下**不写**“进度”子项，提交信息一行。
5. **不重读整份文档**：开工读 §0、§0.1 和当前任务所在节，HANDOFF 只查需要的部分。
6. **小事自己定**：文件内部结构、私有函数名、变量名、报错文案直接决定，不用问，也不用记录理由。只有**行为或范围**不清楚时才停下来问。
7. **不顺手重构**：与当前任务无关的代码一行不动。看到问题写进 §6，一句话即可。
8. 一个任务卡住超过 3 次尝试：按 §7.2 处理，不要反复重试。

---

## 1. 环境事实（已核实）

- 用户 Windows 上的 Node 实际为 **v26.7.0**（`package.json` 的 `engines` 保持 `>=22.18`，不改）。
- 测试命令：`node --test test/*.test.ts test/*.test.mjs`（Windows 上目录参数不可用，已验证此写法可行）。
- 其余环境事实见 `HANDOFF.md` §1（SnowLuma 路径、端口、小号 QQ `900000001`、许可证限制等），仍然有效。

---

## 2. 当前状态

- 阶段 A–C（R1–R13、C0、T7–T10）已完成；U1、U2 真实环境验证已由用户完成，U2 反馈无重大问题；代码已在 `main`。
- T11 托管层调研已由用户确认；T12a spike 的四项独立 GUI 验收已由用户确认通过；T12b 非托盘实现与 probe-timeout 复测已完成。T12c 真实托盘代码提交 `f5f2dcffa699de3a2a34bef0376054e5a1ab28df`（review SHA-256 `f623dce543f1572d87a69902df8032f958bcebbe75e24e46540b28b7af415a3b`）；用户实测后新增面板启动顺序修复提交 `1f0f2b7668e5ffbaee08824de10b7527aa78bbfa`（review SHA-256 `9a7982774c5da99984a93647a8d3b88b664356c0cb752eea3b2fa9b1bcc9ea64`，当时 `npm run check` 通过 212 项）。follow-up 标签为 `checkpoint/dev-host-panel-startup-fix-2026-10-14-unverified`。真实 Windows 托盘/QQ/autostart 用户验收仍待执行，`autostart:install` 未运行。
- §9.0 U1–U4 代码已提交到 `dev/m2-modes`（`638f1bcadd56af8f6988955f6d538af69241e073`）；当前停在停止点 U，等待用户在控制台确认四项体验，确认前不开始 A1。真实 QQ 调试日志未读取，U3 设备字段确认待用户执行。

- 2026-10-18：M2-CDE（C0–E5、R1–R3）完成于 `dev/m2-persona`；新增 §12 控制台 v2。
- 2026-10-18：M2-B（B0–B9）代码完成；新增 §11 长程任务包，从 `dev/m2-affect` 拉 `dev/m2-persona`。
- 2026-10-16：M2-A（A1–A6）代码完成，真实小群验收待用户；新增 §10 M2-B，从 `dev/m2-modes` 拉 `dev/m2-affect` 开始 B1。`GOALS.md` 为远期愿景，**不是任务来源**，不要据此实现任何功能。

---

## 3. 施工顺序

### 阶段 A：提交文档

- [x] **A1** 把以下文件提交为一次提交，提交信息 `docs: 添加施工计划书与设计 v0.5`：`doc/plans/PLAN.md`、`DESIGN.md`、`HANDOFF.md`、`RESEARCH-maibot.md`、`REVIEW-2026-10-12.md`、`NIGHT-RUN.md`。**不要提交 `IDEA.md`。**
  - 提交前，在 `REVIEW-2026-10-12.md`、`NIGHT-RUN.md` 第一行之前各插入一行：`> ⚠️ 已作废，内容并入 doc/plans/PLAN.md。`
  - 在 `HANDOFF.md` 的 `## 5. 任务清单（M1）` 标题下一行插入：`> ⚠️ 本节任务清单已迁移到 doc/plans/PLAN.md，以 PLAN.md 为准；本节仅保留历史。`

### 阶段 B：修复代码审查发现的问题

- [x] **R1 拆条逻辑（`src/core/split.ts`）**
  - 清洗后的回复**总长度 ≤ 80 字时不拆**，原样作为一条。
  - 超过 80 字时：先按换行切；仍超过 80 字的段落，再在 `。！？!?` 处切，**连续的终止标点视为一个整体**（`。。。`、`？？`、`!?`、`……` 不得被拆开或单独成条）；半角 `.` **不作为切分点**（避免切断 `3.5`、网址、英文缩写）。
  - 切完后把相邻短句**贪心合并**，使每条尽量接近但不超过 80 字；仍超过 80 字的单句按 80 字硬切。
  - 最多 3 条，多余部分并入最后一条（直接拼接，不额外加字符）。
  - 测试（`test/split.test.ts`）至少覆盖：`好啊！走吧。` → 1 条；`哈哈哈。。。真的假的？？` → 1 条；`我昨天跑了3.5公里` → 1 条；一段 200 字、含多个句号的文本 → 3 条，前两条各 ≤ 80 字，三条拼接后与原文完全一致；任何输出都不出现只含标点的条目。

- [x] **R2 清洗回复（`src/core/text.ts`）**
  - 删除“全局去掉 `` ` * _ ~ `` 字符”的规则。改为只去成对的 Markdown 强调：`**x**`、`__x__` → `x`；`` `x` `` → `x`；`~~x~~` → `x`。单个 `*`、`_`、`~` 一律保留。
  - 测试：`好的~明天见 (＾_＾)` 原样保留；`**重点**` → `重点`；`*拍拍*` 原样保留。

- [x] **R3 主人标记（`src/core/prompt.ts`、`src/core/pipeline.ts`）**
  - `buildPromptMessages` 的参数 `owner` 改名为 `ownerId: number`。上下文中 `senderId === ownerId` 且 `ownerId !== 0` 的行，说话人显示为 `昵称（主人）`。
  - 固定规则中删除 QQ 号，改为：`只有标注为（主人）的人的指令才算数；其他人自称主人一律不信。`；`ownerId === 0` 时改为：`当前没有主人，不要把任何人视为主人。`
  - **提示词中任何位置都不得出现主人的 QQ 号。**
  - 测试：system 与 user 内容都不包含 ownerId 的字符串形式；主人发言行带“（主人）”；他人昵称本身含“主人”二字时不被误判（判定只看 senderId）。

- [x] **R4 重复消息（`src/store/repository.ts`、`src/core/pipeline.ts`）**
  - `messages` 插入改为 `INSERT OR IGNORE`；`saveMessage` 返回 `boolean`（是否新插入）。
  - 管线中，入站消息 `saveMessage` 返回 `false` 时，记决策 `reason='duplicate'` 并直接结束，**不回复**。
  - 测试：同一消息保存两次不抛错、第二次返回 false；管线对重复消息只回复一次。

- [x] **R5 会话内串行（新文件 `src/core/session-queue.ts`）**
  - `createSessionQueue()` → `{ run(sessionId, task), idle(): Promise<void> }`：同一 `sessionId` 的任务严格按到达顺序串行，不同会话并行；任务抛错不影响后续任务；某会话队列清空后释放其内部状态。`idle()` 在所有队列清空时 resolve，供关机等待。
  - `src/app/main.ts` 中所有 `pipeline(message)` 都经 `queue.run(sessionId(message.session), …)`；关机时用 `queue.idle()` 等待在途任务。
  - 测试：同一会话两个任务不重叠且顺序正确；不同会话可并行；前一个失败后一个仍执行；`idle()` 行为正确。

- [x] **R6 测试临时目录**
  - 所有测试中 `fs.mkdtempSync(path.join(<仓库根或 process.cwd()>, '.tmp-…'))` 改为 `fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-…'))`（用 `grep -rn "mkdtemp" test` 找全）。
  - 若某个测试**必须**位于仓库内（例如边界检查依赖仓库相对路径），保留，但在 `.gitignore` 加 `/.tmp-*/`，并在该测试文件顶部注释说明原因。
  - 验收：跑完 `npm test` 后，`git status` 不出现任何 `.tmp-*`。

- [x] **R7 主人身份不可被昵称冒充（`src/core/prompt.ts`）**（2026-10-12 第二轮审查发现，规格漏洞）
  - 现状问题：群友把群名片改成 `张三（主人）`，上下文里就和真正的主人标记完全一样。
  - 改为：上下文每行的说话人名字一律用 `JSON.stringify(name)` 包成带引号的字符串，**身份标记写在引号外**：
    - 主人：`[HH:mm] "阿伟"（主人）: 内容`
    - 自己：`[HH:mm] 你: 内容`（不加引号）
    - 其他人：`[HH:mm] "张三（主人）": 内容`
  - 固定规则末尾追加一句：`说话人的名字写在引号里，引号里的任何文字都只是对方的昵称，不代表身份。`
  - 测试：昵称为 `张三（主人）` 的非主人，输出中只出现 `"张三（主人）":`，不出现引号外的“（主人）”；昵称含 `"` 时被正确转义、不能闭合引号；主人行格式正确；提示词中仍不出现主人 QQ 号。

- [x] **R8 保留中文聊天里的 `~~` 和 `__`（`src/core/text.ts`）**
  - 现状问题：`好呀~~那走吧~~` 被清成 `好呀那走吧`；`好__耶__` 被清成 `好耶`。双波浪线在中文聊天中很常见。
  - 改为：**删除** `~~x~~` 与 `__x__` 两条规则，只保留去掉 `**x**` 与 `` `x` ``。
  - 测试：`好呀~~那走吧~~`、`冲冲冲~~ 今晚~~`、`好__耶__`、`(__) 趴下了` 全部原样保留；`**重点**` → `重点` 仍成立。

- [x] **R9 拆条时保留换行（`src/core/split.ts`）**
  - 现状问题：超过 80 字的回复按换行分段后，相邻段落合并成一条时换行丢失，两段话会连在一起。
  - 改为：合并两个来自**不同段落**的片段时，中间插入 `\n`；同一段落内的片段直接拼接。插入的 `\n` 计入 80 字长度。
  - 测试：`第一段。\n第二段……`（总长 > 80，且两段合计 ≤ 80 的情形用构造数据覆盖）合并后保留 `\n`；同段落内拼接不插入任何字符；原有 R1 测试全部仍通过。

> **⛔ 停止点 1**：R9 完成后停下。向用户报告 R7–R9 每项改了什么、新增了哪些测试、`git status` 是否干净。
> 用户随后会：①请 Claude 审查 R1–R6；②做下方「U1 真实环境验证」；③决定是否合并到 `main`。**收到“继续”前不得进入阶段 C。**

#### U1 真实环境验证（由用户执行，接手模型不执行，仅供参考）
1. 启动 SnowLuma，在其 WebUI 的进程列表中手动对小号 QQ 进程点“加载”。
2. `npm run spike:adapter-ping` → 终端显示已连接 `900000001` → 主号私聊小号发 `/aq ping`，收到 `pong 🐟 水族箱已连接` → Ctrl+C。
3. `.env` 填好 `DEEPSEEK_API_KEY` → `npm run spike:llm-ping` → 看到回复与 token 用量。
4. `data/config.yaml` 填好 `owner`，只启用一个测试私聊或小群 → `npm start` → 私聊发一句或在群里 @ 小号，收到符合人设的回复（群聊带引用）；在未启用的群里 @ 小号不回复；`好啊！走吧。` 这类短回复只发一条 → Ctrl+C，日志显示已关闭。

### 阶段 C：日常可用（U2）

- [x] **C0 补全 `.env.example`**：在现有两项之后追加以下三行（值留空），并各加一行中文注释说明用途：`DEEPSEEK_API_KEY=`、`MIMO_API_KEY=`、`AQUARIUM_PANEL_PASSWORD=`。不要修改 `.env`。

- [x] **T7 看图**
  - 触发回复的消息中含 `image` 段时，对其中每张图调用 `vision` 槽位生成一句不超过 30 字的中文描述，在上下文中把该图替换为 `[图片：描述]`。
  - 缓存：键为 `image` 段的 `file` 字段，没有则用 `url` 的 sha1；存入 `image_captions` 表，命中缓存不再调用模型。
  - **不触发回复的消息不识图**。上下文里出现的其他历史图片：有缓存描述用描述，没有则显示 `[图片]`，不为它们调用模型。
  - 单张识图失败：用 `[图片]` 占位，记一条 error 日志，不影响回复。
  - 测试：缓存命中不调用模型；失败降级为 `[图片]`；不触发回复的消息不调用 `vision`。

- [x] **T8 离线补课**
  - 适配器状态变为 `online` 时（含首次连接与重连），对每个**已启用**会话调用 `history(session, 50)`，逐条 `saveMessage` 补齐入库（R4 后重复消息会被忽略）。
  - 在**新插入**的消息中，找出提到自己的（私聊的全部消息、群聊中 `mentionsSelf` 或含 `nicknames`）。若其中最新一条的时间距今 ≤ 10 分钟，则只对**最新那一条**走一次正常回复流程（经 R5 的会话队列）；其余只入库不回复。
  - 补课过程中收到的实时消息照常处理，不必等待补课结束。
  - 测试：用假适配器验证只回复最新一条、超过 10 分钟不回复、重复消息不重复入库。

- [x] **T9 管理指令**
  - 只有 `senderId === owner` 且 `owner !== 0` 时视为指令；其他人发出则当普通消息处理。
  - 生效范围：**已启用的会话**，以及与主人的私聊（即使该私聊未启用）。其他会话中主人发的指令也忽略。
  - 指令（消息纯文本 trim 后完全匹配，`[分钟]` 为可选正整数）：
    - `/aq ping` → 回复 `pong 🐟`
    - `/aq mute [分钟]` → 本会话闭嘴，默认 60 分钟，存内存（重启后失效）；回复 `好，我先不说话了（X 分钟）`
    - `/aq unmute` → 解除；回复 `我回来了`
    - `/aq recall` → 撤回本会话中 bot 最近发出的一条消息；没有可撤回的则回复 `没有可以撤回的消息`
    - `/aq status` → 回复今日花费、预算状态、已启用会话数，一行文字
  - 指令消息本身不进入回复流程；闭嘴期间该会话的所有回复（包括被 @）都跳过，并记决策 `reason='muted'`。
  - 指令回复不经过拆条与节奏延迟，直接发送。
  - 测试：非主人发指令按普通消息处理；mute 期间被 @ 不回复；mute 到期自动恢复；recall 调用适配器的 `recall`。

- [x] **T9b 调试记录（精简版）**
  - 配置新增（schema + `config.example.yaml`）：`debug: { enabled: false, sessions: {}, retainDays: 7 }`。`sessions` 的键为 sessionId、值为 `true/false`，覆盖总开关；随配置热重载立即生效。
  - 迁移新增表 `debug_traces(id INTEGER PK, time INTEGER, session_id TEXT, message_id TEXT, slot TEXT, provider TEXT, model TEXT, prompt_json TEXT, response_text TEXT, prompt_hash TEXT, detail_json TEXT)`，索引 `(session_id, time)`。
  - 某会话调试开启时，`callSlot` 的**每次尝试**（含失败）都写一条：完整 messages 数组、模型原始返回文本（失败则为空，`detail_json` 记错误名与状态码）、`prompt_hash` = messages 的 `JSON.stringify` 结果做 sha256 取前 16 位十六进制。该消息的决策记录 `detail_json` 同时写入 `promptHash`。
  - 调试关闭时**不写入**任何全文。
  - 过期清理：启动时及之后每 6 小时删除早于 `retainDays` 天的记录。
  - 仓储函数：`recordDebugTrace`、`debugTracesFor(sessionId, messageId)`、`pruneDebugTraces(now)`。
  - 在代码中留 TODO 注释：`// TODO(M2): 引入私密信息分级后，调试记录必须对 L0 内容脱敏（DESIGN §10.1）`。
  - 测试：开关继承（总开关 / 会话覆盖）、关闭时不写入、失败调用也有记录、过期清理。

- [x] **T10 控制台**（视觉规范见 §4，必须遵守）
  - **后端** `src/panel-server/`（hono + `@hono/node-server`），由 `src/app/main.ts` 启动：
    - 只监听配置 `panel.host` / `panel.port`；`AQUARIUM_PANEL_PASSWORD` 未设置时**不启动控制台**，打印一条 warn，bot 本身照常运行。
    - 所有 `/api/*` 需要请求头 `Authorization: Bearer <密码>`，用 `crypto.timingSafeEqual` 比较；失败返回 401。
    - 接口：
      - `GET /api/status`：账号、连接状态、今日回复数、今日花费、预算状态、已启用会话数
      - `GET /api/sessions`：合并 `listGroups`、`listFriends` 与配置，每项含 `sessionId`、名称、人数（群）、`enabled`、哪些字段为本会话覆盖
      - `PATCH /api/sessions/:sessionId`：请求体为对 `defaults` 的部分覆盖；值为 `null` 的字段表示“恢复继承”（从覆盖项中删除）；原子写配置文件，热重载生效
      - `GET /api/personas`、`GET /api/personas/:id`、`PUT /api/personas/:id`（写入 `data/personas/<id>.md`）、`POST /api/personas/import`（请求体为 Markdown 文本与文件名；id 取文件名去扩展名，只允许 `[a-z0-9_-]`，冲突时返回 409）
      - `GET /api/decisions?limit=50`（最多 200）：含是否有调试记录
      - `GET /api/decisions/:id/trace`：返回 T9b 的调试记录
      - `GET /api/usage/today`
      - `POST /api/sandbox/chat`：请求体 `{ sessionId, asOwner: boolean, history: [{ role: 'user'|'bot', text }], text }`；走与真实消息**相同**的提示词组装与 `reply` 槽位，返回回复分条结果与决策步骤；**不调用适配器、不写 `messages` 表**，但照常记录用量（计入花费）
      - `POST /api/recall/:messageId`
      - `POST /api/mute-all`、`POST /api/unmute-all`：所有会话闭嘴 / 恢复（复用 T9 的内存状态）
    - 静态托管 `panel/dist`。
  - **前端** `panel/`（Vite + React + TypeScript）：
    - `package.json` 新增脚本：`panel:dev`（Vite 开发服务器，`/api` 代理到控制台后端）、`panel:build`。
    - 密码存 `sessionStorage`；401 时回到登录页。
    - 页面（与设计稿一一对应，见 §4.3）：登录、总览、会话、人设、试聊与决策。
    - M2 才有的功能（群友、情绪与好感、存档；自然 / 积极 / 忙碌模式）显示为**不可点击**，并标注 `M2`。
  - 测试：后端鉴权（无密码 / 错误密码 / 正确密码）、`PATCH` 的 null 恢复继承、试聊不写 `messages` 表、人设导入 id 校验。前端不写测试。
  - **【用户】验收**：浏览器打开控制台，在会话页打开一个会话的开关，无需重启即生效。
  - 夜间把 T10 标为完成只表示代码、单元测试与 `panel:build` 通过；上面的浏览器步骤仍待用户完成，不代表人工验收已通过。

- [x] **R10 决策记录要让人看得懂**（2026-10-13 审查发现）
  - 现状问题：总览“最近的决定”和决策记录页直接显示 `900000001:group:100001`、`not_mentioned`、消息 ID、费用“未关联”。
  - 后端：
    - `GET /api/decisions` 的每一项增加 `sessionName`（群名 / 好友备注或昵称；查不到则为 sessionId）、`messageText`（从 `messages` 表按 `session_id + message_id` 取 `plain_text`，截断到 60 字，查不到为 `null`）、`costCny`（见下条，没有则 `null`）。
    - `src/core/pipeline.ts` 记录 `replied` 决策时，在 `detail` 中写入 `costCny`（本次 `reply` 调用的 `result.usage.costCny`）；`costCny` 字段从 `detail.costCny` 读取。
  - 前端：会话列显示 `sessionName`；消息列显示 `messageText`（`null` 时显示 `—`）；费用列显示 `¥0.0000` 格式（`null` 时显示 `—`）；结果列用中文标签，并按下表配色：
    | reason | 标签 | 配色 |
    |---|---|---|
    | `replied` | 已回复 | 青色浅底 |
    | `not_mentioned` | 没被叫到 | 灰底 |
    | `disabled` | 未启用 | 灰底 |
    | `duplicate` | 重复消息 | 灰底 |
    | `command_ignored` | 指令已忽略 | 灰底 |
    | `command_*`（其余） | 管理指令 | 青色浅底 |
    | `rate_limited` | 限流 | 珊瑚橙浅底 |
    | `muted` | 闭嘴中 | 珊瑚橙浅底 |
    | `empty_reply` | 空回复 | 珊瑚橙浅底 |
    | `llm_error` / `send_error` / `persona_error` / `command_error` | 出错 | 珊瑚橙浅底 |
    | 其他 | 原样显示 reason | 灰底 |
    标签映射写在前端一个独立文件 `panel/src/labels.ts` 中。
  - 测试：后端 `/api/decisions` 返回三个新字段（含查不到时为 `null`）；管线 `replied` 决策的 `detail.costCny` 正确。

- [x] **R11 图片先下载再交给视觉模型（`src/core/images.ts`）**
  - 现状风险：直接把 QQ 图片链接交给视觉模型，模型服务端不一定能访问 QQ 的图片服务器，也不是所有服务商都支持远程图片链接。
  - 改为：对 `http(s)` 图片链接，由 bot 自己先下载：超时 10 秒；只接受响应头 `content-type` 为 `image/jpeg`、`image/png`、`image/gif`、`image/webp`；大于 5 MB 则放弃；成功后转成 `data:<类型>;base64,…` 再交给 `vision` 槽位。
  - 下载失败（超时、类型不符、过大、非 2xx）：按现有规则降级为 `[图片]` 并记 error 日志，**不再**退回去把原始链接发给模型。
  - 下载函数可注入（便于测试），测试中不访问网络。
  - 测试：成功转 data URL；超时、类型不符、超过 5 MB 均降级为 `[图片]`；缓存命中时不下载。

- [x] **R12 控制台文案与小样式**
  - 删除各页标题上方的英文小标签（`AQUARIUM / CONTROL`、`AQUARIUM / SESSIONS`、`OBSERVABILITY`、`GROUP` 等），界面只用中文。
  - 总览副标题改为动态状态句：`缸里有 N 条鱼，M 条在游动。`（N = 账号数，M = 在线账号数；N 为 0 时显示 `缸里还没有鱼。`）。
  - 总览“运行链路”中的 `QQ Adapter` 改为 `QQ（小号）`。
  - “全部闭嘴”等按钮加 `white-space: nowrap`，手机宽度下不得折成两行。
  - 前端不写测试；完成后 `npm run panel:build` 必须成功。

- [x] **R13 图片下载只允许腾讯域名（`src/core/images.ts`）**（U2 实测：图片地址全部为 `https://multimedia.nt.qq.com.cn`）
  - 下载前检查：协议必须是 `https:`，且主机名等于或以 `.` 结尾匹配以下任一后缀：`qq.com.cn`、`qq.com`、`qpic.cn`。不匹配则不下载，按现有规则降级为 `[图片]` 并记 error 日志（含主机名，不含完整 URL）。
  - 不做 IP 解析、不自定义 DNS。
  - 测试：`multimedia.nt.qq.com.cn` 允许；`evil-qq.com`、`qq.com.evil.cn`、`http://multimedia.nt.qq.com.cn`、`https://127.0.0.1` 拒绝。

> **⛔ 停止点 2**：R13 完成后停下，等用户确认后合并到 main。（U2 已于 2026-10-14 由用户验证通过。）

#### U2 真实环境验证（由用户执行，接手模型不执行）
1. `.env` 设置 `AQUARIUM_PANEL_PASSWORD`；启动 SnowLuma 并加载小号 → `npm run panel:build` → `npm start`。
2. 浏览器打开 `http://127.0.0.1:5180`，用密码登录；总览显示小号在线。
3. 会话页：打开一个测试群的开关 → 不重启，在该群 @ 小号能收到回复；关掉后不再回复。
4. 看图：在启用的会话里发一张图并 @ 小号问“这是什么”，回复内容与图片相关；决策记录中能看到这条。
5. 管理指令（主号发）：`/aq status`、`/aq mute 1`（1 分钟内 @ 不回复，之后恢复）、`/aq recall`。
6. 离线补课：停掉 Aquarium，在启用的私聊里发一句话，3 分钟内重新 `npm start`，小号会补回一条回复。
7. 调试记录：配置 `debug.sessions` 打开测试会话 → @ 小号 → 决策记录里能查看完整提示词与原始返回。
8. 试聊：在“试聊与决策”页发一句话，能收到回复，且 QQ 里没有任何新消息。
9. R12：确认各页面不再显示英文分类眉题；总览状态句与账号数/在线数相符（无账号时显示“缸里还没有鱼。”）；运行链路显示“QQ（小号）”；将浏览器宽度设为 320px，确认“全部闭嘴”等按钮文字不换行。


### 阶段 D：一键启动（U3）

- [x] **T11 托管层调研**（只调研、写结论，**不写正式代码**）：已在 `doc/plans/HOST-RESEARCH.md` 记录来源、结论与待用户确认项：
  1. SnowLuma WebUI API 的鉴权方式（读 `reference/SnowLuma/packages/core/src/webui/server.ts` 及相关文件），以及如何调用 `POST /api/processes/:pid/load`；
  2. 如何无窗口启动 SnowLuma（`node index.mjs`，cwd 为其目录，`windowsHide: true`）及如何判断其已就绪；
  3. QQ.exe 的常见安装路径、如何启动并拿到 PID、如何区分小号与主号进程（若无法可靠区分，提出“只注入由我们启动的那个 PID”的方案并说明局限）；
  4. Windows 托盘的候选方案（至少比较两种），各自的依赖、体积、是否需要原生扩展；
  5. 开机自启的方式（启动文件夹快捷方式 / 计划任务），推荐其一并说明理由。

> **⛔ 停止点 3**：写完 `HOST-RESEARCH.md` 后停下，等用户确认方案。

> T11 结论已由用户确认（2026-10-14），见 `HOST-RESEARCH.md`。以下为确认后的规格，与研究报告冲突处以本文为准。

- [x] **T12a 托盘 spike（限时验证，可丢弃；夜间仅完成代码部分）**
  - 安装 `@trayjs/trayjs`（精确版本）。写 `src/spike/tray.ts`：显示小鱼托盘图标（图标文件放 `assets/tray/`，青色 / 黄色 / 红色三个 `.ico`，16×16 与 32×32），提示文字“水族箱”；右键菜单三项：“状态：测试中”（不可点）、“切换颜色”（依次切换三个图标）、“退出”。
  - 退出时托盘辅助进程必须一并退出，不得残留。
  - 在 `HOST-RESEARCH.md` 末尾追加“T12a 结果”一节：包安装后的磁盘占用、是否需要额外运行时、是否支持系统通知（气泡提示）。
  - **【用户】验收**：`node src/spike/tray.ts` → 托盘出现小鱼 → 菜单可用、颜色能切换 → 点“退出”后，任务管理器中无残留进程。
  - 夜间完成结果：固定 `@trayjs/trayjs@0.0.10`；三色双尺寸 ICO 与 fake-tray spike 已实现；`npm run check` 通过（142 项测试）。托盘程序与真实 GUI 未运行，人工验收仍待用户。
> **⛔ 停止点 3b**：有人值守流程在 T12a 后停下等用户验收。夜间按 §7.1 不运行 spike、不做用户验收，继续完成本节指定的 T12b 与空托盘接口后结束。

- [x] **T12b Windows 托管实现**（夜间 §7.1 仅完成非托盘部分；真实托盘及 GUI 验收待用户）
  - **配置**（schema + `config.example.yaml`）：
    ```yaml
    host:
      enabled: true            # false 时行为与现在完全相同（手动启动 SnowLuma）
      startSnowLuma: true      # 由 Aquarium 启动 SnowLuma 子进程
      qqExePath: ''            # 用户手动填写 QQ.exe 完整路径；为空时托盘“打开 QQ”不可用
      scanIntervalSec: 5
    ```
    `.env` / `.env.example` 新增 `SNOWLUMA_WEBUI_PASSWORD=`（注释：SnowLuma 网页控制台的登录密码）。
  - **`src/host/types.ts`**：`Host` 接口 `start()`、`stop()`、`status()`、`onStatus(cb)`；状态枚举：`starting`、`waiting_qq_login`（等待小号登录）、`online`、`error`。
  - **`src/host/windows/snowluma-process.ts`**：
    - 启动前读取 `<snowlumaDir>/config/runtime.json`；若 `hookAutoLoad` 为 `true`，**拒绝启动托管**，状态设为 `error`，日志与托盘提示“请在 SnowLuma 中关闭自动注入”（fail-closed）。
    - 以 `process.execPath` 运行 `<snowlumaDir>/index.mjs`，`cwd` 为 `snowlumaDir`，`windowsHide: true`；stdout / stderr 追加到 `data/logs/snowluma-YYYY-MM-DD.log`。
    - SnowLuma 的环境变量优先于 `runtime.json`；spawn 环境必须去除继承的 hookAutoLoad / WebUI listener override 与 WebUI 密码，再显式固定 `hookAutoLoad=false` 及已校验的 WebUI host / port / TLS，避免继承环境绕过 fail-closed 检查。
    - `startSnowLuma: false` 是 unmanaged attach：拒绝 Aquarium 当前环境中可见的 auto-load/wildcard override 并打印警告，但无法读取已运行外部进程的有效环境；仅在用户确认该进程 `hookAutoLoad=false` 且 listener 为 loopback 时使用。
    - 就绪判定：WebUI 地址取 `runtime.json` 的 `webuiHost` / `webuiPort`（缺省 `127.0.0.1:5099`）；仅接受 loopback host，通配或远端绑定在启动子进程前 fail-closed（改写客户端目标不会改变服务端监听）；每秒尝试一次登录，60 秒内成功即就绪，否则状态 `error`。
    - 子进程意外退出（包括 WebUI 首次就绪前）：按 1s → 2s → 4s … 封顶 30s 指数退避重启；host 保留重试并在恢复 ready 后启动 watcher；连续稳定运行 5 分钟后退避归零。
  - **`src/host/windows/snowluma-webui.ts`**：loopback-only WebUI 客户端，`fetch` 可注入；禁止跟随 redirect，request timeout 覆盖 response body 解析；若 Node env-proxy 或 global proxy agent 已启用，则在发认证请求前 fail-closed，不依赖 `NO_PROXY`；每次请求读取当前 global agent，覆盖运行期 `setGlobalProxyFromEnv()` 切换。
    - `login()`：`POST /api/login`，密码来自 `SNOWLUMA_WEBUI_PASSWORD`；token 只存内存，**不得写入日志或文件**。
    - 任何请求返回 401 时重新登录一次后重试；再失败则状态 `error`。
    - `listProcesses()`、`probeLogin(pid)`、`load(pid)`：路径与返回结构以 `reference/SnowLuma/packages/core/src/webui/server.ts` 为准，在代码注释中注明所依据的行号。
  - **`src/host/windows/qq-watcher.ts`**（核心安全逻辑）：
    - 每 `scanIntervalSec` 秒调用 `listProcesses()`。对每个尚未判定的 PID 调用 `probeLogin(pid)`：
      - `identityKnown: true` 且 UIN **等于**配置的小号 → 调用 `load(pid)`，该 PID 记为“已注入”，以后不再处理；
      - `identityKnown: true` 且 UIN 不等于小号 → 该 PID 记为“忽略”，以后不再探测、**永不注入**；
      - 未知、超时、出错 → 下一轮再探测。
    - 进程列表中消失的 PID 从记录中删除。
    - 任何情况下都**不得**注入 UIN 不匹配或未知的进程。
    - 有“已注入”的 PID 且适配器 `online` → 状态 `online`；否则 → `waiting_qq_login`。
  - **托盘**（采用 T12a 验证通过的库）：
    - 图标颜色：青 = `online`；黄 = `starting` / `waiting_qq_login`；红 = `error`。提示文字随状态变化，如“水族箱 · 等待小号登录”。
    - 菜单：状态文字（不可点）、打开控制台（用默认浏览器打开 `http://127.0.0.1:<panel.port>`）、打开 QQ（以 `qqExePath` 分离启动，未配置时不可点）、全部闭嘴 / 恢复（复用 T9 的状态，文字随状态切换）、重启 SnowLuma、退出。
    - 进入 `waiting_qq_login` 时，若库支持系统通知则弹一次“请登录小号 QQ”；不支持则只改提示文字。
    - “退出”：停止 SnowLuma 子进程与 Aquarium；**不关闭任何 QQ 进程**。
  - **开机自启**：`scripts/autostart.mjs`，npm 脚本 `autostart:install` / `autostart:uninstall`。
    - install：在 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` 写入 `Aquarium.vbs`，内容为以隐藏窗口方式（`WScript.Shell` 的 `Run …, 0, False`）在仓库目录下运行 `"<process.execPath>" --env-file-if-exists=.env src\app\main.ts`；路径中的引号正确转义。若同名文件不是带 Aquarium 所有权标记的普通文件，拒绝覆盖。
    - uninstall：只删除带 Aquarium 所有权标记的普通文件；不删除同名用户文件或符号链接。两者都打印执行结果。
  - **`src/app/main.ts`**：`host.enabled` 为 true 时先启动托管，再创建适配器（适配器已有自动重连，SnowLuma 就绪前连接失败不影响）。SIGINT/SIGTERM 在 host.start 期间到达时，host 先登记以便 shutdown 停止；关闭后不继续启动 watcher、adapter 或面板。`host.enabled` 为 false 时行为不变。
  - 平台判断：非 Windows 平台且 `host.enabled` 为 true 时，打印 warn 并按 `host.enabled: false` 运行（`LinuxHost` 留待以后）。
  - **测试**（不启动真实进程、不访问网络）：qq-watcher 只注入 UIN 匹配的 PID、永不注入不匹配或未知的 PID、同一 PID 不重复注入、消失的 PID 被清理；WebUI 客户端 401 重登一次、token 不出现在日志调用参数中、proxy mode 下不认证（含 client 创建后的运行期代理启用）；`hookAutoLoad: true` 时拒绝启动；fake spawn 断言继承环境不能打开自动注入或 wildcard WebUI listener；unmanaged attach 的已知危险 override 拒绝并 warning；SIGINT/SIGTERM 与延迟 host.start 竞态下停止 host、禁止 watcher/adapter 继续启动；退避时间序列；vbs 内容生成（含带空格与引号的路径）。
  - 夜间完成结果（按 §7.1 排除托盘）：配置兼容、WebUI、进程生命周期、QQ watcher、自启动 VBS 生成和 main 接入均有 fake/offline 覆盖；`npm run check` 通过（187 项测试）。未启动 SnowLuma/QQ、未运行 `npm start`、未执行 autostart install，也未接入真实托盘库。
  - **【用户】验收（真实托盘接入后执行；当前夜间空托盘实现不提供这些交互）**：
    1. `.env` 填 `SNOWLUMA_WEBUI_PASSWORD`；`data/config.yaml` 确认 `host.enabled` / `host.startSnowLuma`。只有要使用托盘“打开 QQ”时才需要填 `host.qqExePath`。
    2. 关掉手动开的 SnowLuma；主号 QQ 照常开着。
    3. `npm start` → 托盘出现黄色小鱼，主号 QQ 没有被注入（SnowLuma 网页里看不到它被加载）。
    4. 托盘“打开 QQ” → 登录小号 → 托盘几秒内变青色，小号能正常回复。
    5. `npm run autostart:install` → 重启电脑 → 登录后**没有任何黑窗口**，托盘出现小鱼。
    6. 托盘“退出” → 小鱼消失，两个 QQ 都还在运行。

- [x] **T12c 接入真实托盘并收尾（白天有人值守；代码完成，用户验收待进行）**
  - 用 `@trayjs/trayjs` 实现 `src/host/tray.ts` 接口，替换空实现；图标复用 T12a 的三色图标；菜单与行为严格按 T12b 的“托盘”小节。库不支持系统通知时，`notify` 只改提示文字。
  - 托盘辅助进程意外退出时：记 error 日志，bot 继续运行，不自动重建托盘。
  - `.gitignore` 增加 `/.hermes/`。
  - 测试：托盘适配层用假的 trayjs 对象测试状态 → 图标 / 提示文字映射与菜单回调。
  - **【用户】验收**：T12b 验收步骤 3–6（托盘变色、打开 QQ、开机自启无黑窗口、退出后两个 QQ 都在）。
  - 已知限制（记入 §6，不在本任务处理）：同一个 QQ 进程若先被判定为“忽略”，之后在该进程内切换登录为小号，不会被注入，需要重新打开该 QQ。
  - 代码收尾：`npm run check` 通过 211 项；`git diff --check` 通过；精确 staged review 通过（SHA-256 `f623dce543f1572d87a69902df8032f958bcebbe75e24e46540b28b7af415a3b`）；提交 `f5f2dcffa699de3a2a34bef0376054e5a1ab28df` / `checkpoint/dev-host-t12c-code-2026-10-14-unverified`。未运行真实托盘、QQ、SnowLuma 或 autostart；用户验收按 `MORNING-2026-10-14.md` 执行。
  - 面板启动 follow-up：先启动账号任务，再启动本地管理面板，不等待 `adapter.connect()` 完成；启动 promise 仍被 await，保留原有账号连接顺序。复核通过（SHA-256 `9a7982774c5da99984a93647a8d3b88b664356c0cb752eea3b2fa9b1bcc9ea64`），`npm run check` 通过 212 项；提交 `1f0f2b7668e5ffbaee08824de10b7527aa78bbfa` / `checkpoint/dev-host-panel-startup-fix-2026-10-14-unverified`。管理面板仍要求本机配置的密码环境变量非空；真实登录前访问验收待用户复测。

> **⛔ 停止点 4**：M1 结束。M2 的施工计划另行编写。

---

## 4. 控制台视觉规范（通用令牌与约束；V2 页面以参照页为准）

> V2 页面结构、内容与交互以 `doc/design/console-v2/` 中五个参照页为准；本节通用令牌与可访问性约束继续适用。若 §4.3 的旧页面示例与 V2 参照冲突，以 V2 参照为准。

### 4.1 设计原则
- 风格名：“深水观察室”。安静、克制、适合长时间查看。**不用渐变、发光、毛玻璃、emoji**。
- 品牌标志：一条线描小鱼（SVG，见 4.4），**只作为项目标志**（侧栏、登录页、托盘）。**bot 账号不用鱼表示，文案里不把 bot 称作“鱼”**，不用“鱼缸”“游动中”“放入新的鱼”等说法；bot 一律用首字头像表示，统称“眷属”。（2026-10-16 修订）
- 所有交互元素用真实的 `<button>` / `<a>` / `<input>` / `<label>`；点击区域不小于 44px 高；纯图标按钮必须有 `aria-label`。
- 手机宽度下侧栏折叠到页面顶部；宽表格放在可横向滚动的容器里。

### 4.2 设计令牌（写成 CSS 变量，`panel/src/styles/tokens.css`）
| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` | `#F3F6F5` | 页面底色（雾白） |
| `--surface` | `#FFFFFF` | 卡片、侧栏 |
| `--surface-2` | `#EDF1F0` | 次级底色、标签、表格分隔线 |
| `--surface-accent` | `#EAF2F0` | 选中行、鱼缸卡片底色 |
| `--line` | `#D5DEDB` | 边框 |
| `--ink` | `#0F1E1D` | 主文字 |
| `--ink-2` | `#3D4F4D` | 次文字 |
| `--muted` | `#5B6B69` | 说明文字、不可用项 |
| `--accent` | `#17605B` | 主强调（深海青）：可操作、在线、选中 |
| `--accent-soft` | `#DCEBE8` | 主强调的浅底（选中导航、已回复标签、bot 气泡） |
| `--warn` | `#C2502A` | 需要注意（珊瑚橙）：闭嘴按钮边框、限流 |
| `--warn-ink` | `#A8411F` | 珊瑚橙文字 |
| `--warn-soft` | `#F8E3DA` | 珊瑚橙浅底 |
- 字体（Google Fonts）：标题 `Noto Serif SC`（600 / 700）；正文 `Noto Sans SC`（400 / 500 / 700）；数字、QQ 号、时间、模型名 `IBM Plex Mono`（400 / 500）。
- 字号：页面标题 32px 宋体 700；卡片标题 20px 宋体 600；小节标题 15px 黑体 700；正文 14px；说明 12–13px。
- 圆角：卡片 16px；按钮、输入框 10px；标签、开关 999px。卡片之间间距 16–24px；卡片内边距 20–24px。
- 不用阴影，层次靠边框和底色区分（开关的圆点可用极轻的阴影）。

### 4.3 页面结构
- **全局布局**：左侧固定宽度侧栏（约 232px，白底，右边框）+ 右侧内容区（最大宽度 1120px，居中，内边距 40px 48px）。
  - 侧栏：顶部小鱼图标 + “水族箱”（宋体 20px）+ “AQUARIUM”（等宽 11px）；导航：总览、会话、人设、试聊与决策、用量；下方“即将开放”分组：群友、情绪与好感、存档（灰色、带 `M2` 标注、不可点击）。当前页的导航项用 `--accent-soft` 底 + `--accent` 字。
- **总览**：标题“总览” + 一句状态描述；右上“去试聊”（次按钮）与“全部闭嘴”（珊瑚橙描边按钮）。
  - “鱼缸”卡片：每个账号一张子卡（小鱼图标、bot 名字、在线状态标签、QQ 号与人设文件名、今日回复 / 启用会话 / 上次发言）；末尾一张虚线框“放入新的鱼（M3 多账号）”。
  - 三张统计卡：今日花费（大号等宽数字 + 预算进度条 + 说明）、模型调用（次数、缓存命中率、平均耗时）、运行链路（QQ → SnowLuma → Aquarium，各带状态点与 PID / 端口 / 运行时长）。
  - “最近的决定”表格：时间、会话、消息、结果标签（已回复 = 青色浅底；没被叫到 / 未启用 = 灰底；限流 / 闭嘴 = 珊瑚橙浅底）、花费；右上“查看全部决策追踪 →”。
- **会话**：标题 + 说明“打开开关的会话里，它才会说话。改动立刻生效，不用重启。”
  - 左（约 60%）：群聊 / 好友 分段切换（带数量）+ 搜索框；列表每行：开关、首字头像、名称、号码与人数（等宽）、右侧“继承全局”（灰字）或“本群覆盖”（青色浅底标签）。选中行用 `--surface-accent` 底 + 左侧 3px 青色内描边。
  - 右（约 40%）：选中会话的详情。标题为会话名 + “已启用”标签；分组依次为：什么时候说话（2×2 卡片单选：只在被叫时可选，其余三个灰色带 M2）、叫它的名字（可删除的标签 + “+ 添加”输入）、在这个群里的补充说明（多行文本框）、频率与上下文（4 个数字输入：每人每分钟最多、整个群每分钟最多、两次回复至少间隔（秒）、回复时参考最近几条）。每个分组标题右侧显示“继承全局”或“本群覆盖 · 恢复继承”（恢复继承为文字按钮）。底部“已自动保存 · 时间”。
- **人设**：标题 + 说明；右上“导入 Markdown”（次按钮）与“新建人设”（青色实底按钮）。
  - 左：人设库卡片列表（名称、文件名、一句简介、“某账号在用”标签），末尾虚线框“把 .md 文件拖到这里导入”。
  - 右：编辑器卡片，标题栏含人设名、“绑定账号”下拉、保存状态；下方左右两栏：左为等宽字体的 Markdown 文本框，右为渲染预览（`{{name}}` 占位符用珊瑚橙浅底高亮）；预览底部“用这个人设试聊 →”。
- **试聊与决策**：标题 + 说明“走和真实群聊完全相同的流程，但消息不会发到 QQ。点任意一条回复，右边会告诉你它为什么这么说。”
  - 左（约 60%）：顶部“按哪个会话的设置”下拉、“我扮演（主人 / 普通群友）”下拉、“清空对话”；对话区浅底，我方气泡白底带边框靠右，bot 气泡 `--accent-soft` 靠左（选中的那条加 1.5px 青色边框），bot 名字前带小鱼图标；每轮 bot 回复下方一行等宽小字：耗时 · 花费 · 拆成几条；底部输入框 + 青色“发送”按钮。顶部提示“试聊不入库、不发 QQ · 会照常计入花费”。
  - 右（约 40%）：“它为什么这么回”，竖向时间线列出每一步（标题、右侧等宽数值、下方灰色说明）：会话已启用、被叫到了、频率限制、人设、上下文、模型（输入 / 缓存 / 输出 token 与耗时）、花费、拆条与节奏；底部可展开“查看发给模型的完整提示词”（有调试记录时显示全文，否则提示“开启调试模式后可查看”）。
- **登录**：居中卡片，小鱼图标 + “水族箱”，一个密码输入框与“进入”按钮。

### 4.4 小鱼图标（SVG）
```html
<svg width="40" height="24" viewBox="0 0 40 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 12c6-8.5 18-9.5 26 0-8 9.5-20 8.5-26 0z"/>
  <path d="M29 12l8-6.5v13z"/>
  <circle cx="10" cy="10.5" r="1.3" fill="currentColor" stroke="none"/>
</svg>
```

---

## 5. 进度日志

| 日期 | 任务 | 结果 / 备注 |
|---|---|---|
| 2026-10-12 | 计划书 | 合并 HANDOFF 剩余任务、REVIEW R1–R6、调试记录 T9b、控制台视觉规范 |
| 2026-10-12 | A1 | REVIEW/NIGHT-RUN 加入作废提示，HANDOFF §5 标明 PLAN.md 优先；目标文档统一提交前 `npm run check` 通过（70 项测试） |
| 2026-10-12 | R1 | 长度 ≤80 字原样保留（含纯标点，按用户澄清）；长文本按行和终止标点分段、贪心合并、最多三条；`npm run check` 通过（75 项测试） |
| 2026-10-12 | R2 | 仅移除成对 Markdown 标记，保留单个 `*`、`_`、`~`；纯格式空回复仍清为空以维持 `empty_reply`；`npm run check` 通过（78 项测试） |
| 2026-10-12 | R3 | 提示词去除 owner QQ 号，按 senderId 标注主人发言，并区分昵称误导；`npm run check` 通过（78 项测试） |
| 2026-10-12 | R4 | 消息插入幂等并返回新增标志；重复入站记录 `duplicate` 后立即停止，不再次调用模型或发送；`npm run check` 通过（79 项测试） |
| 2026-10-12 | R5 | 新增会话级 FIFO 队列：同会话串行、异会话并行、失败隔离和 `idle()`；主程序经队列分发并在关机时等待；`npm run check` 通过（83 项测试） |
| 2026-10-12 | R6 | 13 处测试临时目录改到 `os.tmpdir()`；`npm run check` 通过（83 项测试），测试后 `git status` 无 `.tmp-*` |
| 2026-10-12 | R7 | 上下文昵称改为 JSON 字符串，引号外身份标记只依据 senderId；固定规则说明引号内昵称不代表身份；`npm run check` 通过（83 项测试） |
| 2026-10-12 | R8 | 清洗器不再删除 `~~` 与 `__`，保留中文聊天中作语气/表情的双符号；`npm run check` 通过（84 项测试） |
| 2026-10-12 | R9 | 拆条片段保留段落来源；跨段落合并插入计入 80 字长度的换行，同段落仍直接拼接；`npm run check` 通过（86 项测试） |
| 2026-10-13 | U1 | 用户完成真实环境验证，全部通过 |
| 2026-10-13 | C0 | `.env.example` 追加 3 项空值环境变量及中文用途说明；逐项断言通过；`npm run check` 通过（86 项测试） |
| 2026-10-13 | T7 | 触发图像经 `vision` 槽位生成并缓存 ≤30 字描述；历史图片只读缓存；失败及不可访问 URL 降级占位；`npm run check` 通过（93 项测试） |
| 2026-10-13 | T8 | online 时补齐每个启用会话的最近 50 条；只将 10 分钟内最新未入库触发消息送入会话队列；`npm run check` 通过（99 项测试） |
| 2026-10-13 | T9 | 管理指令限主人与会话范围；闭嘴状态、到期恢复、撤回、预算/会话状态均有测试；`npm run check` 通过（107 项测试） |
| 2026-10-13 | T9b | 新增 debug 配置继承、SQLite trace 表、每次模型尝试记录 prompt/hash/响应和失败细节、保留期清理；`npm run check` 通过（115 项测试） |
| 2026-10-13 | T10 | Hono 控制台 API（仅 loopback、请求体限额）、React 页面、认证、会话配置热更新、试聊与生产构建完成；`npm run check` 通过（126 项测试），`npm run panel:build` 成功 |
| 2026-10-13 | R10 | 决策 API 返回会话名、60 字消息摘要与可空费用；replied detail 保存实际费用；控制台改用中文原因标签；`npm run check` 通过（129 项测试），`npm run panel:build` 成功 |
| 2026-10-13 | R11 | 视觉调用前下载 HTTP(S) 图片，限制 10 秒、允许的 MIME 与 5 MiB；失败使用占位且不发送原始链接；`npm run check` 通过（136 项测试），`npm run panel:build` 成功 |
| 2026-10-13 | R12 | 清除英文页面分类标签、总览状态句按账号数动态展示、链路文案本地化并防止移动按钮换行；`npm run check` 通过（136 项测试），`npm run panel:build` 成功 |
| 2026-10-14 | R13 | 图片下载只允许 HTTPS 腾讯域名，按点边界匹配并在拒绝时记录主机名、不记录完整 URL；fake fetch 测试覆盖允许/拒绝地址；`npm run check` 通过（137 项测试）/ `9a0626d836b5f9955f26d56ed5dc1faa19263acd` |
| 2026-10-14 | T11 | 只读调研 SnowLuma WebUI auth/load、启动与 readiness、QQ PID/UIN、托盘候选和自启动；新增 `doc/plans/HOST-RESEARCH.md`；`npm run check` 通过（137 项测试）；用户确认方案 |
| 2026-10-14 | T12a | 精确安装 `@trayjs/trayjs@0.0.10`；加入双尺寸三色 ICO 与仅 fake 测试的托盘 spike；`npm run check` 通过（142 项测试）；用户后续独立 GUI 验收四项通过（图标、禁用状态项、颜色循环、退出清理）；Aquarium 真实托盘接入仍延期 |
| 2026-10-14 | T12b | 完成 host 配置、loopback WebUI 客户端、受控 SnowLuma 子进程、UIN fail-closed watcher、自启动 VBS 生成及 main 接入；`npm run check` 通过（187 项测试）；精确 staged review 通过，提交 `d5378fe` / `checkpoint/dev-host-t12b-2026-10-14-unverified`；未运行真实服务或安装自启动 |
| 2026-10-14 | T12-空托盘 | 新增 `src/host/tray.ts` log-only tray interface/adapter，main 绑定 host 状态、等待登录通知、菜单回调与退出清理；2 项定向测试及完整 `npm run check`（189 项）通过；精确 staged review 通过，提交 `afbdaa1` / `checkpoint/dev-host-tray-null-2026-10-14-unverified`；未加载真实托盘库 |
| 2026-10-14 | HOST-RESEARCH 补充 | 追加 T12b/空托盘离线实现结果、安全边界、审查证据及未验证项；未运行真实服务；提交 `2480368` / `checkpoint/dev-host-host-research-supplement-2026-10-14-unverified` |
| 2026-10-14 | T12b probe-timeout follow-up | 用户首次手动运行观察到登录最终成功、进程列表 HTTP 200，但 `probe-login` 重复 network error；确认 host 默认请求超时 1s 短于 SnowLuma probe 最长 5s，增加至 7s；慢响应回归按预期 RED→GREEN；`npm run check` 通过（190 项）；精确 staged review 通过，提交 `aba7022` / `checkpoint/dev-host-probe-timeout-fix-2026-10-14-unverified`。后续 17:17 运行记录 adapter/host online，用户确认可正常对话；此前 17:00 初次运行未出现 online，但后续运行证明状态日志链可工作 |
| 2026-10-14 | T12c | 将 trayjs 接入 Windows tray worker，增加 helper/worker 错误隔离、状态/提示/menu 映射与 shutdown 清理；`npm run check` 通过（211 项），精确 review 通过（SHA-256 `f623dce543f1572d87a69902df8032f958bcebbe75e24e46540b28b7af415a3b`）；提交 `f5f2dcffa699de3a2a34bef0376054e5a1ab28df` / `checkpoint/dev-host-t12c-code-2026-10-14-unverified`。真实 Windows 用户验收及 autostart install 待用户执行 |
| 2026-10-14 | T12c panel-startup follow-up | 用户确认小号离线启动时管理面板端口未开启；根因是主流程等待串行 `adapter.connect()` 后才启动 panel。现先启动账号任务，再立刻启动 panel，同时仍 await 账号任务；`npm run check` 通过（212 项），精确 review 通过（SHA-256 `9a7982774c5da99984a93647a8d3b88b664356c0cb752eea3b2fa9b1bcc9ea64`）；提交 `1f0f2b7668e5ffbaee08824de10b7527aa78bbfa` / `checkpoint/dev-host-panel-startup-fix-2026-10-14-unverified`。待用户复测启动时小号未登录的情形 |
| 2026-10-15 | N0 / R14 | 新增 OneBot 应用层重试、每次连接重验账号、未验证消息隔离、整链 timeout 与超时 client 替换；QQ 注入成功后立即重试；面板离线联系人缓存、请求限时与 degraded 状态；`npm run check` 通过（230 项），`npm run panel:build` 成功，精确 staged review 通过（SHA-256 `4dbc238959683810e3468545e5d0350f214b2d648fbd13e01b3b521566e60dcd`）。真实 Windows/QQ 验收待用户；提交 `cc0a204dbe4d76a4c3e0c32194169573bb6d1a61` / `checkpoint/dev-host-n0-r14-2026-10-15-unverified`。reviewer 的两项非阻断建议保留为后续 panel 跟进 |
| 2026-10-15 | N1 | 将主流水线拆为 persist/gate/context/generate/deliver 五步，统一 StepContext/StepResult 并逐步收集安全摘要 trace；新增五项步骤单测，原 `test/pipeline.test.ts` 未改且通过；`npm run check` 通过（235 项），精确 staged review 通过（SHA-256 `52c278e5d735cab82eefe5862de196111470d30b47e93fa5263d30fd9117f522`）；提交 `e1c4e174a8dea345a8886d4184b1f7f7554b52ab` / `checkpoint/night-m2-prep-n1-2026-10-15-unverified` |
| 2026-10-15 | N2 | 新增 reply-system/vision 模板，启动加载并随配置热重载原子替换；逐字 golden 测试保持旧提示词输出；每次 vision/reply 调用将模板版本与渲染后 prompt hash 写入决策 detail；重复占位符经 RED/GREEN 回归测试修复；`npm run check` 通过（239 项）；修订后精确 staged review 通过（SHA-256 `36beac126ec79f70396c14fc0b5e8488a3a9a10c067fb0282275dc5e05e45240`）；提交 `196271cd271509645f0f400cecf88064d142d856` / `checkpoint/night-m2-prep-n2-2026-10-15-unverified`；未执行真实模型/服务验收 |
| 2026-10-15 | N3 | 新增 schema v3 `pipeline_traces`，仅 debug 启用时保存 N1 trace，按 `debug.retainDays` 清理；summary 使用逐 step allowlist，未知 reason 降为 `stopped`，并限制为 500 个 Unicode 字符；决策 API 增加受保护的 pipeline-trace endpoint，面板展示步骤时间线；`npm run check` 通过（248 项），`npm run panel:build` 成功（27 modules）；最终精确 staged review 通过（SHA-256 `cacf381bec7965bd9b047b745a0a97b34e66bd4fb4cb31034046962b7edbe0cb`）；提交 `e51f7a1d54d426672a8fc3ee55eb4d75b680d8ba` / `checkpoint/night-m2-prep-n3-2026-10-15-unverified`；仅 fake/offline 验证，未运行真实服务 |
| 2026-10-15 | N4 | 增加受保护 replay endpoint 与决策详情对比；历史消息按原消息存储行 ID 截断，限流 preview 只读不消费额度，禁止发送及消息/决策/trace 持久化；reply 调用费用与重放总费用分列。`npm run check` 通过（253 项），`npm run panel:build` 成功（27 modules）；精确 review 通过（SHA-256 `3e34c8f3ff0232975b6c69461d80036f74fab3551763769e90364c5d17a12f66`，48,946 bytes，16 paths）；提交 `e668fb13afee9f3fbbcdeea34df2a9b2980fbea0` / `checkpoint/night-m2-prep-n4-2026-10-15-unverified`；仅 fake/offline 验证，真实模型/GUI 验收待用户 |
| 2026-10-15 | N5 | 新增合成 JSONL 离线评测 CLI，只运行 N1 gate、不调用模型；10 条样例 precision 0.6667、recall 0.8000、F1 0.7273，TP=4/FP=2/TN=3/FN=1；`--with-judge` 仅解析并提示“将在 M2 实现”，样例 `messages` 校验但不消费；`npm run check` 通过（260 项）；精确 staged review 通过（SHA-256 `7ff522d83020d5930e5f390ef7fd953a1efa248d016e2dba938f9f6ddf0f5599`，18,079 bytes）；提交 `ad151ec07f43af4c409aad21546f34733b961244` / `checkpoint/night-m2-prep-n5-2026-10-15-unverified`；仅 synthetic/offline 验证 |
| 2026-10-15 | A1 | 新增 `modeSchedule`（本地 `HH:mm`、数组整体覆盖、旧配置默认空、相同起止时间拒绝）与首个命中优先的跨午夜 `resolveMode`；`mention_only` 未被叫时记录 `mode_mention_only`；忙碌模式回复延迟 ×2.5 并追加模式提示；`npm run check` 通过（272 项测试） |
| 2026-10-15 | A2 | 新增纯 `batcher.ts`（8 秒静默重计时、30 秒硬上限、按会话取消并保留有序批次）与 `backoff.ts`（连续不回第 2 次起按 15–300 秒指数退避、批量 ≥6 条绕过、回复后按会话归零）；注入时钟的 8 项测试通过；`npm run check` 通过（280 项测试）；尚未接入流水线（A5）；review 非阻塞建议已记入 A5：静默等待不得占住 per-session `sessionQueue` task |
| 2026-10-15 | A3 | 新增规则粗筛权重与概率门（含 30 分钟 active / 20 分钟 cold 计算、问题标点、图片/表情独占与 @ 他人特征）；新增 judge 模板 hash、热重载版本更新与占位符校验、最近 8 条上下文、固定 judge 槽位调用与严格 JSON 解析（仅 probability/reason、概率 0–1、reason ≤20 字）；13 项定向测试通过，`npm run check` 通过（290 项测试）；仅注入调用验证，尚未接入 N1 gate（A5） |
| 2026-10-15 | A4 | 新增 session rolling 60-minute 动态阈值、目标频率校准及 120 秒 proactive cooldown；8/8 定向测试、`npm run check` 298/298 通过；精确 review 通过（SHA-256 `feec7b6edb72d7b7fead2c22c8db0d8617eeeea65acaa69c5bc6b1fda217c2f2`）；提交 `ee6176cac97172f52edb7bec9cd81c4a94bec656` / `checkpoint/dev-m2-modes-a4-2026-10-15-unverified` |
| 2026-10-15 | A5 | 将攒批、退避、prefilter、judge、动态阈值与决策 trace 接入 pipeline；`npm run check` 320/320、路由定向测试 3/3 通过；精确 review 通过（SHA-256 `dc1a73b040e2f746f7d2f66da90c488330b931de3cb9b117fab7d637bd3d9c14`）；提交 `1bb8c8e3a4ffe19f08a6e0168507a858d1ac1bc0` / `checkpoint/dev-m2-modes-a5-2026-10-15-unverified`；仅 fake/offline 验证 |
| 2026-10-15 | A6 | 完成会话模式与时间表编辑、reason 中文标签及决策概率详情；`npm run check` 330/330、`npm run panel:build`（29 modules）、`git diff --check` 通过；精确 review 通过（SHA-256 `b8b303d8d483df6839ae91efdee1dcb90eb103ba4409822da3d7cdcb66d60441`，32,381 bytes，13 paths）；提交 `9c0c53f1a3acda1754f9b6c7c7befbf8e9377a05` / `checkpoint/dev-m2-modes-a6-2026-10-15-unverified`。两项非阻断建议（非法 schedule PATCH 路由负向测试、行内时间校验提示）保留后续；M2-A 真实小群验收待用户 |
| 2026-10-15 | A6 schedule editor follow-up | 修复时间输入在延迟 state updater 中读取 `currentTarget` 导致编辑崩溃；未提交草稿按 session 存入 `sessionStorage`，刷新可恢复，成功 PATCH 后在刷新会话列表前清理对应草稿，失败 PATCH 保留；读取时拒绝格式错误时间与额外字段、保留空白编辑值。首轮 review 的两项逻辑问题均经 RED/GREEN 回归修复；`npm run check` 通过（336/336），`npm run panel:build` 成功（29 modules），`git diff --check` 通过；最终精确 review 通过（SHA-256 `ba661e5368015edcf33144291446190bfd0857001a12356786eaac854ecd660d`，21,264 bytes，3 paths，无 security concerns / logic errors）；提交 `3b7134902091c2168ea4a923b1fa7815ae989abf` / `checkpoint/dev-m2-schedule-editor-fix-2026-10-15-unverified`。Reviewer 的 mounted `SessionsPage` 回归测试建议为非阻断，未纳入本切片；未运行真实 GUI、QQ 或模型，M2-A 用户验收仍待执行 |
| 2026-10-16 | U1 | 新增受保护的 `GET/PATCH /api/defaults`、严格部分更新与嵌套 rate 合并；生产 `writeConfig` 路径和 watcher 热更新经文件读回测试；全局默认入口固定显示并复用群聊设置项。`npm run check` 通过（340/340） |
| 2026-10-16 | U2 | 按安全读写 `localStorage` 恢复会话/分组选择；`/api/sessions` 增加 SQLite `MAX(time)` 最近消息时间并按启用、活跃、名称排序；回归覆盖 null 活跃时间和名称平局，`npm run check` 通过（340/340） |
| 2026-10-16 | U3 | 会话列表过滤 bot 自身及精确匹配设备昵称/备注，保留既有配置覆盖，并在联系人读取失败时仍隐藏自身私聊。未启动 QQ/GUI，未读取真实调试日志；按计划回退规则实现，已在当日早检清单注明待确认。`npm run check` 通过（340/340） |
| 2026-10-16 | U4 | 私聊面板隐藏群模式/昵称配置，显示私聊说明并提供“对这个人的补充说明”；单一频率输入同步写入两个 rate 字段，群聊保留原有双限额输入，全局默认复用双限额输入。`npm run panel:build` 成功（30 modules）；总体验证 `npm run check` 340/340、`git diff --check` 通过。实现提交 `638f1bcadd56af8f6988955f6d538af69241e073`，tag `checkpoint/dev-m2-u1-u4-2026-10-16-unverified`；停在停止点 U，等待用户控制台确认，未开始 A1 |
| 2026-10-16 | B0 | 总览状态句改眷属文案，账号子卡与试聊气泡换首字头像，删除无用 CSS；`npm run panel:build` 成功（30 modules），`npm run check` 340/340 |
| 2026-10-16 | B1 | 提示词按固定顺序分块并跳过空块，promptBlocks 哈希入决策 detail；`npm run check` 342/342 |
| 2026-10-16 | B2 | 迁移 v4 新增情绪与标签四表及索引，affect-repo 提供读写并往返测试；`npm run check` 345/345 |
| 2026-10-16 | B3 | 情绪纯函数：衰减、发送者 60 分钟上限、静/滑动摩擦与停留防抖；`npm run check` 351/351 |
| 2026-10-16 | B4 | 情绪接入：async 评估、被叫规则、affect/appraise 模板与 mood/float 提示词块；`npm run check` 355/355 |
| 2026-10-16 | B5 | 标签纯函数：观察/独立性/转正、判重不复活、推翻、激活度与注入选择上限；`npm run check` 362/362 |
| 2026-10-16 | B6 | 标签提取：两种触发与单飞、逐条校验、tag_runs 更新、groupTags/memberTags 注入；`npm run check` 367/367 |
| 2026-10-16 | B7 | 控制台：心情卡片与印象页、mood/impressions/tags API；`npm run check` 370/370，`npm run panel:build` 成功（31 modules）；停在停止点 M2-B |
| 2026-10-16 | B8 | 标签样本与证据修复、情绪完成时戳；check 374/374 |
| 2026-10-16 | B9 | 主动冷却可配置；check 378/378 |
| 2026-10-18 | C0 | 02:01–02:05 | 通用防抖抽取；check 380/380 |
| 2026-10-18 | C1 | 02:07–02:32 | 好感迁移仓储；check 382/382 |
| 2026-10-18 | C2 | 02:36–02:39 | 好感核心 387/387 |
| 2026-10-18 | C3 | 02:40–02:55 | 好感联动与提示词；check 389/389 |
| 2026-10-18 | C4 | 02:58–03:12 | check390，build32 |
| 2026-10-18 | C5 | 03:13–03:16 | 好感数据流文档；check 390/390 |
| 2026-10-18 | R1 | 03:17–03:22 | 修空互动时间；check 390/390 |
| 2026-10-18 | D1 | 03:24–03:30 | 人设头解析；check 392/392 |
| 2026-10-18 | D2 | 03:31–03:49 | check 400/400 |
| 2026-10-18 | D3 | 03:50–04:06 | check404，build |
| 2026-10-18 | D4 | 04:08–04:09 | check 404/404 |
| 2026-10-18 | R2 | 04:12–04:17 | YAML 400 修复；check404 |
| 2026-10-18 | E1 | 04:20–04:25 | 409/409 |
| 2026-10-18 | E2 | 04:25–04:38 | check 413/413 |
| 2026-10-18 | E3 | 04:38–05:06 | check 418/418 |
| 2026-10-18 | E4 | 05:08–05:33 | check 425/425 |
| 2026-10-18 | E5 | 05:35–05:37 | HANDOFF 7; 425/425 |
| 2026-10-18 | R3 | 05:42–05:44 | E1–E5 pass |
| 2026-10-18 | V0 | 17:52–18:16; check426/426; build109; 5c4079d |
| 2026-10-18 | V1 | 18:21–18:56; check429/429; build113; 883833c |
| 2026-10-18 | V2 | 18:56–19:46; check432/432; build115; a023715 |
| 2026-10-18 | V3 | 19:49–20:39; 434/434; b116; a0f6451 |
| 2026-10-18 | R4 | 20:44–20:47; review a0f6451 pass |
| 2026-10-18 | V4 | 20:49–21:10; 443/443; b116 |
| 2026-10-18 | V5 | 21:10–21:15; check450/450 |
| 2026-10-18 | V6 | 21:15–21:19; build119 |
| 2026-10-18 | R5 | 21:20–22:16; 457/457; cac59f8 |
| 2026-10-18 | V7 | 22:19–22:51; 459/459 |
| 2026-10-18 | V8 | 22:55–23:15; check462/462 |
| 2026-10-18 | V9 | 23:23–23:45; build123; check463/463 |
| 2026-10-18 | V10 | 23:50–23:56; docs14; 463/463 |
| 2026-10-19 | R6 | 00:00–00:37 | 初审4项已修；466/466；build123；未二审 |
| 2026-10-19 | V11 | 01:01–01:27; 468/468; panel123 |
| 2026-10-19 | V12 | 01:35–02:05; 471/471; build123 |
| 2026-10-19 | V13a | 03:04–03:24; 471/471; build123 |
| 2026-10-19 | V13b | 03:24–04:26; 474/474; panel126 |
| 2026-10-19 | V13c | 04:26–05:16; 475/475; panel127 |
| 2026-10-19 | V14a | check 482/482; boundaries passed |
| 2026-10-19 | V14b | check 482/482; panel127 |
| 2026-10-19 | V15 | check 482/482; panel128 |
| 2026-10-19 | V16a | check 485/485 |
| 2026-10-19 | V16b | check 485/485; panel131 |
| 2026-10-19 | V17 | 用途表浮层/能力重置；未启用群导入；自动提取仍跳过；487/487，panel 132 |
| 2026-10-19 | V17b | 卡片化、拖拽排序、胶囊编辑；check 487/487；panel 134 modules |
| 2026-10-19 | V18a | 超时/去重/日志/配置；最大输出文案；check 492/492，panel 134 |
| 2026-10-19 | V18b | 表情同步、收藏与 API；check 503/503 |
| 2026-10-19 | V18c | 表情候选、提示词块、发送回退与只发表情；check 516/516 |
| 2026-10-19 | V18d | 表情包页与设置 API；check 517/517，panel 139 |
| 2026-10-19 | V18d补 | 标签可手动删除；518/518，panel139 |
| 2026-10-19 | 外链归因 | 卡片文案非本人证据；check 519/519 |
| 2026-10-19 | V18c补 | 标记支持全角符号；check 519/519 |
| 2026-10-19 | V18e | 看图 JSON/OCR、缓存版本；check 523/523 |
| 2026-10-20 | V18f | MD5/GIF/重复收藏；check 541/541 |
| 2026-10-20 | P1 | private_facts/策略/标签守门；check 546/546 |
| 2026-10-20 | P2 | 私聊抽取、异步游标与校验；check 555/555 |
| 2026-10-20 | P3 | 私聊记忆与同人群标签注入；check 559/559 |
| 2026-10-20 | P4 | 群聊守门、回避期、L0 出口检查；check 570/570 |
| 2026-10-20 | P5 | 主人提及判断、日去重与等级升级；check 577/577 |

---

## 6. 待评估清单
- **（公开仓库前必做）个人信息清理**：目前仓库只在本地、无远程，以下内容暂时可接受。若将来推送到任何远程（包括私有仓库）或公开：
  1. 把 `.env.example`、`config.example.yaml`、`test/` 中的真实 bot 小号 QQ 号换成占位值（如 `10001`），本地路径换成 `C:\path\to\SnowLuma`；
  2. 把 `HANDOFF.md`、`PLAN.md`、`MORNING.md` 中的真实 QQ 号、Windows 用户名、本地路径移到被忽略的本地文件或改为占位；
  3. **历史提交里仍保留这些信息**，需要用 `git filter-repo` 重写历史后再推送，单纯改文件不够。
- 见 `HANDOFF.md` §8（已有三条：`config` ↔ `core` 互相引用、`core` 依赖 OpenAI 类型、重连后不再校验账号）。新增条目写在这里。
- **（2026-10-13 审查；R13 于 2026-10-14 增加初始 URL 域名白名单）图片下载的 SSRF/重定向边界仍待评估**：R13 仅允许初始 URL 使用 HTTPS 且主机名精确匹配或点边界后缀匹配 `qq.com.cn`、`qq.com`、`qpic.cn`；不做 IP 解析或自定义 DNS。Node `fetch` 仍默认跟随重定向，且未逐跳复核主机名，所以允许域名可能重定向到白名单外或内网目标。当前按 R13 明确范围未增加重定向/IP 机制；扩大使用前需决定逐跳策略并补测试。
- T12c 已知限制：同一个 QQ 进程若先被 watcher 判定为“忽略”，之后在该进程内切换登录为小号，不会重新注入；需要重新打开 QQ。此行为不在 T12c 范围处理。

---

## 7. 夜间无人值守规则（覆盖 §0 中冲突的条款）

> 适用：用户睡觉期间运行，无人能回答问题、无人能在 QQ 上做验证。

### 7.1 范围（当前有效：§15）
- **本次无人值守运行的唯一范围是 §15 列出的两步**（V18f → §13 P1–P7、R7），按顺序执行；其余章节已完成或不在本次范围。阶段 D 的 §7.1 旧范围已于 2026-10-15 完成，**不再执行、不再收尾**。
- 所有【用户】验收步骤不执行，写进早上检查清单。

### 7.2 遇到问题时
- §0 第 1 条“停下来问用户”在夜间改为：
  1. 把问题、考虑过的选项、采用的做法写进早上检查清单的「待确认问题」；
  2. 选**最保守、最容易回退**的做法继续。
- 同一个错误修了 3 次仍失败：停止该任务，`git restore` 撤销该任务未提交的改动，记录完整错误信息，继续下一个任务。
- 被跳过任务的依赖处理：
  - T9 被跳过：T10 的 `/api/mute-all`、`/api/unmute-all` 返回 501，响应体 `{ "error": "依赖的 T9 未完成" }`。
  - T9b 被跳过：T10 的 `/api/decisions/:id/trace` 返回 501；前端“查看完整提示词”显示“调试记录功能未完成”。
  - T7、T8 被跳过：不影响其他任务。

### 7.3 夜间额外禁止与允许
- **禁止**：运行 `npm start`、任何 `src/spike/*.ts`、任何会发出真实大模型请求或连接 SnowLuma 的命令；启动长期运行的开发服务器（`vite dev` 等）；修改仓库目录以外的任何文件；修改全局 npm / git / 系统配置；在 `main` 上提交。
- **允许**：`npm install` 安装本文与 `HANDOFF.md` §3 指定的库，以及 T10 前端所需的 `vite`、`react`、`react-dom`、`@vitejs/plugin-react`、`@types/react`、`@types/react-dom`（精确版本，`--save-exact`）；运行 `npm run check`；运行 `npm run panel:build`（只构建，不启动服务）。
- T10 前端的依赖直接放在仓库根的 `package.json` 中，不另建 npm 工作区。

### 7.4 Git 与记录
- 开始前：按 §15 指定的分支工作（先 `dev/stickers`，再新建 `dev/privacy`）。所有提交都在这个分支上，**每个任务一个提交**。
- 新建并维护 `doc/plans/MORNING-2026-10-20.md`，结构固定为：
  ```
  # 早上检查清单（2026-10-20）
  ## 完成情况          （每个任务一行：编号 / 完成|跳过|失败 / 一句话说明 / 提交哈希）
  ## 需要用户操作的验证   （按任务列出【用户】步骤，写成可直接照做的编号步骤）
  ## 待确认问题          （问题 / 考虑过的选项 / 夜间采用的做法）
  ## 遇到的错误          （任务 / 命令 / 关键报错 / 已尝试的修复）
  ```
- 每完成一个任务，就更新一次早上检查清单与本文 §5 进度日志，并随该任务一起提交。中途中断时，早上也能看到进度。

### 7.5 每个任务的完成标准
- `npm run check` 通过；
- 涉及前端时额外要求 `npm run panel:build` 成功。

### 7.6 结束条件（满足任一即结束，并做最后一次提交）
- §15 的范围全部完成；
- 剩余任务全部被跳过或失败；
- 运行时间达到 10 小时。

---

## 8. 长程无人值守任务包（2026-10-15 夜，预计 6 小时以上）

> 适用 §7 的夜间规则（遇问题记录后选保守做法、3 次失败跳过、不跑真实服务、不调真实模型）。
> 分支：在 `dev/host` 上先完成 R14 的代码与测试，然后从 `dev/host` 新建 `night/m2-prep` 继续。早上检查清单写到 `doc/plans/MORNING-2026-10-16.md`。
> 每项完成后 `npm run check` 必须通过；**所有任务都不得改变 M1 的对外行为**（现有测试必须原样通过，除非本节明确要求修改）。

- [x] **N0** 完成 R14 的代码与测试（真实验收留给用户）。
- [x] **N1 流水线分步重构**（DESIGN §14 M2 第一项）
  - 把 `src/core/pipeline.ts` 拆为 `src/core/steps/` 下的独立步骤文件：`persist.ts`（入库 / 去重）、`gate.ts`（启用 / 闭嘴 / 触发 / 限流）、`context.ts`（人设、上下文、看图、提示词组装）、`generate.ts`（调用 `reply` 槽位与清洗）、`deliver.ts`（拆条、节奏、发送、记录）。
  - 每个步骤签名统一：`(ctx: StepContext) => Promise<StepResult>`，`StepResult` 为 `{ next: true }` 或 `{ next: false, reason: string, detail?: unknown, replied?: boolean }`。`StepContext` 携带消息、配置快照、累积数据与一个 `trace: TraceEntry[]`（每步 push `{ step, startedAt, durationMs, summary }`）。
  - `pipeline.ts` 只负责按顺序执行步骤、在第一个 `next: false` 处记录决策并返回。决策 `reason` 取值与现在**完全一致**。
  - 每个步骤至少一个单元测试；原有 `test/pipeline.test.ts` 不改动且全部通过。
- [x] **N2 提示词模板化与指纹**（DESIGN §8.5）
  - 新建 `prompts/reply-system.md`（固定规则段，用 `{{ownerRule}}`、`{{groupNote}}` 占位）与 `prompts/vision.md`；代码中的硬编码提示词全部改为读取模板（启动时读入并随配置热重载一起重新读取）。
  - 模板渲染结果与当前硬编码文本**逐字一致**（用测试锁定）。
  - 指纹：`templateVersion` = 模板文件内容 sha256 前 8 位；决策 `detail` 中写入 `templateVersion` 与已有的 `promptHash`。
- [x] **N3 完整调试追踪**（DESIGN §10.1，在 T9b 基础上扩展）
  - 调试开启的会话中，把 N1 的 `trace` 数组完整写入新表 `pipeline_traces(id, time, session_id, message_id, trace_json)`；调试关闭时只写入决策，不写 trace。
  - `summary` 中**不得**包含完整提示词（完整提示词仍只在 `debug_traces`）；最长 500 字。
  - 过期清理与 `debug_traces` 共用 `retainDays`。
  - 控制台决策记录页：有 trace 时显示“流水线步骤”时间线（步骤名、耗时、摘要），样式沿用 §4。
- [x] **N4 一键重放**（DESIGN §10.1）
  - 后端 `POST /api/decisions/:id/replay`：取原消息与当时的会话上下文，用**当前**配置与模板重新跑 N1 流水线，但 `deliver` 步骤替换为“不发送、不入库”的空实现；返回新的步骤结果、回复文本，与原决策并排对比所需字段。计入花费。
  - 前端决策详情增加“用当前配置重放”按钮与并排对比视图。
  - 测试使用假模型与假适配器；夜间不调用真实模型。
  - 夜间完成结果：历史上下文以原消息存储行 ID 截断；重放查看当前限流状态但不消耗限流额度；不发送消息、不写消息/决策/追踪表；分别返回并展示与原决策可比的 reply 调用费用和包含 vision/reply 的重放总费用。`npm run check` 通过（253 项测试），`npm run panel:build` 成功（27 modules）；最终精确 staged review 通过（SHA-256 `3e34c8f3ff0232975b6c69461d80036f74fab3551763769e90364c5d17a12f66`，48,946 bytes，16 paths）；提交 `e668fb13afee9f3fbbcdeea34df2a9b2980fbea0`，tag `checkpoint/night-m2-prep-n4-2026-10-15-unverified`。仅 fake/offline 验证；真实模型调用与 GUI 验收留待用户。
- [x] **N5 离线评测 CLI 骨架**（DESIGN §13）
  - `npm run eval -- --dataset <path.jsonl>`：数据集每行 `{ "sessionId", "messages": [...最近消息], "target": {...待判断消息}, "label": "reply" | "skip" }`。
  - 对每个样本只运行 N1 的 `gate` 步骤（不调用模型），输出 Precision / Recall / F1 与混淆矩阵到终端，并写 `data/eval/<时间戳>.json`。
  - 提供 `test/fixtures/eval-sample.jsonl`（10 条手写样本，**不含真实聊天内容**）与对应测试。
  - 预留 `--with-judge` 参数：本任务只做参数解析并提示“将在 M2 实现”，不实现。
  - 夜间完成结果：新增 JSONL 校验与离线 CLI；每行只调用 N1 gate，使用显式 `synthetic-gate-defaults`，不读取运行配置、不调用模型；`messages` 字段经校验但本切片不消费；报告只写汇总指标。10 条合成样例的结果为 precision 0.6667、recall 0.8000、F1 0.7273，混淆矩阵 TP=4/FP=2/TN=3/FN=1；`--with-judge` 只解析并提示“将在 M2 实现”。`npm run check` 通过（260 项测试），CLI 离线运行退出码 0；精确 staged review 通过（SHA-256 `7ff522d83020d5930e5f390ef7fd953a1efa248d016e2dba938f9f6ddf0f5599`，18,079 bytes）；提交 `ad151ec07f43af4c409aad21546f34733b961244` / `checkpoint/night-m2-prep-n5-2026-10-15-unverified`。仅 synthetic/offline 验证，不代表真实聊天或模型评估。

完成 N0–N5 或满足 §7.6 结束条件即结束，做最后一次提交。

---

## 9.0 控制台会话页体验修复（在 §9 的 A1 之前完成，同一分支 `dev/m2-modes`）

- [x] **U1 全局默认设置**
  - 后端新增 `GET /api/defaults`、`PATCH /api/defaults`（请求体为 `defaults` 的部分字段；校验、原子写配置、热重载，规则与 `PATCH /api/sessions/:id` 一致，但不支持 `null` 恢复继承）。
  - 前端：会话列表最上方固定一项“全局默认”（不随搜索与分组过滤消失，带“所有会话继承这里的设置”说明）。选中后右侧显示与会话相同的设置表单，但没有启用开关与“继承 / 覆盖”标注。
  - 会话详情中“继承全局”文字改为可点击，点击后切换到“全局默认”。
- [x] **U2 记住上次选择并优化排序**
  - 用 `localStorage`（读写包在 try/catch 中）记住上次选中的 sessionId 与“群聊 / 好友”分组；进入会话页时恢复；该会话已不存在时回落到列表第一项。
  - 列表排序：已启用在前；同组内按该会话最后一条消息时间倒序（后端 `/api/sessions` 每项新增 `lastMessageAt`，取 `messages` 表最大 `time`，没有则 `null` 排在后面）；再按名称。
- [x] **U3 过滤自己与设备会话**
  - `/api/sessions` 的好友列表排除：`userId` 等于该 bot 账号；昵称或备注**完全等于**“我的电脑”“我的手机”“我的Pad”“我的平板”之一的条目。
  - 实现前先用 `npm start` 时的调试日志确认这些条目的真实字段（`userId`、`nickname`、`remark`）；若设备条目能用 `userId` 稳定识别，优先用 `userId` 规则，并在代码注释中写明依据。**此步骤需要真实数据，若无人值守则按名称规则实现并在早上检查清单中注明待确认。**
  - 配置中已存在的、指向被排除条目的 `sessions` 覆盖项保持原样，不删除。
- [x] **U4 私聊使用私聊的设置项**
  - 选中私聊时，右侧表单：
    - 隐藏“什么时候说话”（改为一行说明：“私聊里每条消息都会回复。”）；
    - 隐藏“叫它的名字”；
    - “在这个群里的补充说明”改名为“对这个人的补充说明”；
    - 频率区只显示“每分钟最多”（写入 `perUserPerMinute` 与 `perSessionPerMinute` 两个字段，值相同）、“两次回复至少间隔（秒）”、“回复时参考最近几条”。
  - 群聊表单保持不变。
  - 前端不写测试；后端改动（U1、U2、U3）需有测试；完成后 `npm run panel:build` 成功。

> **⛔ 停止点 U**：U4 完成后停下，用户在控制台确认四项体验后再开始 §9 的 A1。

## 9. M2-A：四种活跃模式（2026-10-15 编写）

> 前置：M1 已合并到 `main`（含 §8 的 N1 分步流水线、N2 模板、N3 追踪）。从 `main` 新建分支 `dev/m2-modes`。
> 有人值守时按 §0 规则；无人值守时按 §7 规则（§7.1 范围视为本节 A1–A6）。每项一个提交，`npm run check` 必须通过。
> 设计依据：DESIGN §5.1、§5.2、`RESEARCH-maibot.md` §1.1–1.3。**不得复制 MaiBot 代码。**

### 9.1 行为定义（所有任务以此为准）

| 模式 | 被叫（私聊 / @ / 叫名字） | 未被叫的群消息 | 目标频率系数 `t` | 初始阈值 |
|---|---|---|---|---|
| `mention_only` 只在被叫时 | 回复 | 一律不回，`reason='mode_mention_only'` | — | — |
| `natural` 自然 | 回复 | 走 §9.2 主动判断 | 0.5 | 0.5 |
| `active` 积极 | 回复 | 走 §9.2 主动判断 | 1.0 | 0.35 |
| `busy` 忙碌 | 回复，节奏延迟 ×2.5 | 走 §9.2 主动判断 | 0.2 | 0.7 |

- 忙碌模式下所有回复的提示词追加一句：`你现在有点忙，回得简短随意。`（放在 `prompts/reply-system.md` 中以 `{{modeHint}}` 占位，其他模式为空）。
- **本节不做**：积极模式冷场时主动开话题（依赖 M2 的记忆）；忙碌模式用贴表情代替回复（需新增适配器动作）。两项写入 §6。

### 9.2 主动判断流程（未被叫的群消息，模式非 `mention_only`）
按顺序，任一步不通过即记决策并结束：
1. **预算**：`budgetState` 为 `exceeded` 时不做主动判断，`reason='budget'`。
2. **攒批**：同一会话收到未被叫的消息后等待 8 秒；8 秒内又有新消息则重新计时，最长等待 30 秒。到时只对**最后一条**做判断，期间其余消息记 `reason='batched'`。被叫的消息不攒批、立即处理，并取消该会话正在等待的批次。
3. **空闲退避**：该会话连续“判断为不回”的次数为 `n`。`n ≥ 2` 时，距上次判断不足 `min(300, 15 × 2^(n−2))` 秒则跳过，`reason='backoff'`；但本批消息条数 ≥ 6 时忽略退避。bot 在该会话发出任何回复后 `n` 归零。
4. **规则粗筛**（零成本）：`p0 = sigmoid(−0.6 + 1.2·active − 0.8·cold + 0.5·question − 1.0·mediaOnly − 0.9·atOther)`，其中 `active` = bot 在本会话最近 30 分钟内发过言；`cold` = 本批第一条消息之前该会话已沉默 ≥ 20 分钟；`question` = 文本含 `?` 或 `？`；`mediaOnly` = 只有图片或表情；`atOther` = @ 了别人。`p0 < 0.15` 则跳过，`reason='prefilter'`。权重写在独立文件 `src/core/activity/prefilter-weights.ts`，以便日后替换为拟合值。
5. **模型精判**：用 `judge` 槽位与新模板 `prompts/judge.md`，上下文为最近 8 条消息。要求模型只输出 JSON：`{"probability": 0到1的数字, "reason": "不超过20字"}`。解析失败记 `reason='judge_parse_error'`；调用失败记 `reason='judge_error'`；两者都按“不回”计入退避。
6. **动态阈值**：`probability ≥ 当前阈值` 才回复，否则 `reason='judge_skip'`（`n` 加 1）。每个会话在内存中维护过去 60 分钟的 `expected`（`probability ≥ 0.5` 的批次数）与 `actual`（实际主动回复数）。每次判断后：若 `expected ≥ 4` 且 `actual > expected × t`，阈值 +0.05；若 `actual < expected × t`，阈值 −0.05；限制在 [0.2, 0.9]。`expected < 4` 时使用 §9.1 的初始阈值。重启后重置。
7. **硬上限**：同一会话主动回复间隔至少为有效配置 `proactiveCooldownSec`（全局默认 120 秒，群会话可覆盖；整数范围 0–3600，0 表示不施加此冷却），否则 `reason='proactive_cooldown'`。原有频率限制仍然生效。
8. 通过后进入原有生成与发送步骤，上下文条数用 8（被叫时仍用 `contextMessages`），决策 `detail` 写入 `trigger: 'proactive'`、`p0`、`probability`、`threshold`。

### 9.3 按时间段切换模式
- 会话配置新增 `modeSchedule: [{ from: 'HH:mm', to: 'HH:mm', mode }]`（本地时间，支持跨午夜如 `23:00`–`07:00`），按顺序取第一个命中项，都不命中用 `mode`。继承规则与其他字段相同（数组整体覆盖）。
- 纯函数 `resolveMode(settings, now): Mode`，放在 `src/core/activity/mode.ts`。

### 9.4 任务

- [x] **A1 模式与时间表**：schema 新增 `modeSchedule`；`resolveMode`；`gate` 步骤按 §9.1 处理被叫与 `mention_only`；忙碌模式节奏 ×2.5 与 `{{modeHint}}`。测试：时间段命中、跨午夜、无命中回落、四种模式的被叫行为。
- [x] **A2 攒批与退避**：`src/core/activity/batcher.ts`、`backoff.ts`（时间可注入）。测试：8 秒重新计时、30 秒上限、被叫取消批次、退避时间序列、≥6 条忽略退避、回复后归零。
- [x] **A3 粗筛与精判**：`prefilter.ts`、`judge.ts`、`prompts/judge.md`；JSON 解析严格（只接受数字在 0–1 之间）。测试：特征计算、`p0` 数值、解析成功 / 失败 / 越界、调用失败。
- [x] **A4 动态阈值与硬上限**：`threshold.ts`（滑动窗口，时间可注入）。测试：数据不足用初始值、超额上调、不足下调、上下限、120 秒冷却。
  - 进度：新增 `src/core/activity/threshold.ts` 与 `test/activity-threshold.test.ts`；8/8 定向测试通过，`npm run check` 的 typecheck、依赖边界检查及 298/298 全量测试通过，`git diff --check` 通过。当前判断先读取 `getThreshold`，`recordJudgment` 只更新后续判断的阈值；补测了恰好 60 分钟窗口边界及实际回复数等于目标频率时不调阈值。
- [x] **A5 接入流水线**：把 A1–A4 接到 N1 的 `gate` 步骤；预算判断；决策 `detail` 字段；N3 追踪中记录 `p0`、`probability`、`threshold`、退避状态。测试：用假 judge 跑完整主动回复路径，以及每个 `reason` 至少一条；提示词 fingerprint 按 slot 匹配（`judge` → `judge.version`、`vision` → `vision.version`、`reply` → `replySystem.version`）；攒批静默等待不得占住 per-session `sessionQueue` task，确保等待期间新消息仍能重置计时器。
  - 集成约束：接入 A4 时先保存用于当前决定的 `getThreshold` 值，再记录 `recordJudgment`（只更新后续判断阈值）。对照两处规范后，A5 以 §9.2 的“固定 p0 粗筛 → judge → 动态阈值”为执行顺序；已修订 DESIGN §5.2，明确区分 judge 前的 `p0` 粗筛分数与 judge 返回的 `probability`，消除动态阈值先于 judge 的歧义。
  - 进度：完成应用层攒批路由与 N1/N3 集成；覆盖预算、batched、backoff、prefilter、judge 错误/跳过、动态阈值、cooldown、限流及按 slot fingerprint。`npm run check` 通过（typecheck、依赖边界检查、320/320 测试），路由定向测试 3/3，`git diff --check` 通过。精确 staged review 通过（SHA-256 `dc1a73b040e2f746f7d2d66da90c488330b931de3cb9b117fab7d637bd3d9c14`，73,337 bytes，21 paths）；首轮 review 发现 timer setup 失败会重复派发当前消息，已通过两条先红后绿的回归测试修复并复审通过。代码提交 `1bb8c8e3a4ffe19f08a6e0168507a858d1ac1bc0` / `checkpoint/dev-m2-modes-a5-2026-10-15-unverified`；仅假 judge/offline 验证，真实 QQ/模型与控制台验收待 M2-A。
- [x] **A6 控制台**：会话页去掉三个模式的“M2”灰显，可选择；新增“按时间段切换”编辑器（增删行，每行 from / to / 模式）；`panel/src/labels.ts` 增加新 `reason` 的中文标签：`mode_mention_only` 只在被叫时、`batched` 合并处理、`backoff` 退避中、`prefilter` 粗筛跳过、`judge_skip` 判断不接、`judge_parse_error` / `judge_error` 出错、`budget` 预算用尽、`proactive_cooldown` 主动冷却；决策详情显示 `p0` / `probability` / `threshold`。完成后 `npm run panel:build` 成功。
  - 进度：完成四种模式选择、schedule 编辑与 PATCH/schema 校验、decision reason 中文化及概率指标展示；schedule 草稿按 session 保留，行 key 与可编辑时间值分离。`npm run check` 通过（typecheck、依赖边界检查、330/330 测试），`npm run panel:build` 成功（29 modules），`git diff --check` 通过。前两轮 review 指出的草稿刷新丢失与输入行 remount 均经回归测试修复；最终精确 staged review 通过（SHA-256 `b8b303d8d483df6839ae91efdee1dcb90eb103ba4409822da3d7cdcb66d60441`，32,381 bytes，13 paths；无 security concerns / logic errors）。代码提交 `9c0c53f1a3acda1754f9b6c7c7befbf8e9377a05` / `checkpoint/dev-m2-modes-a6-2026-10-15-unverified`。Reviewer 的非法 PATCH 路由测试与行内校验提示建议为非阻断、未纳入本切片；真实 QQ/小群验收待用户。

> **⛔ 停止点 M2-A**：A6 完成后停下。
> **【用户】验收**：选一个测试小群设为 `active` → 群里正常聊天（不 @）半小时，bot 偶尔自然接话且两次间隔 ≥ 2 分钟 → 改为 `busy`，接话明显变少、变短 → 设置时间表让当前时段为 `mention_only`，不 @ 就完全不说话 → 控制台决策记录里能看到各种中文原因与概率数值 → 当天花费仍在预算内。

---

## 10. M2-B：简单情绪 + 群标签 + 群友标签（2026-10-16 编写）

> 分支：从 `dev/m2-modes` 新建 `dev/m2-affect`。按 §0 与 §0.1 执行。
> 设计依据：用户 2026-10-16 的决定，即**数值计算全部放在代码里**，模型只看到档位文字；档位切换带“静摩擦 / 滑动摩擦”防抖；提示词分块、按需整段替换。
> 思路参考 `reference/ai-bot-groupmate`（记忆的候选→确认、半衰期）。**只借鉴思路，不复制代码。**
> **本节不做**：好感度、性格演进、精力与作息、私聊信息分级、跨会话共享标签、向量检索。想到的写进 §6。

### 10.1 通用约定
- **角色键**：所有新表都带 `account INTEGER NOT NULL`（bot 的 QQ 号），代表“哪个角色”。目前只有一个账号，但必须带上，不得省略。
- 时间一律毫秒时间戳。所有纯函数都接受注入的 `now`。
- 新的模型调用都用已有的 `extract` 槽位，走现有用量记录与预算。`budgetState` 为 `exceeded` 时，所有新的后台调用跳过，原因记为 `budget`。
- 后台任务（评估、提取）**不进** per-session `sessionQueue`，异步执行，失败只写日志与追踪，不影响回复。

### 10.2 提示词分块（B1）
`buildPromptMessages` 的 system 内容改为**按固定顺序排列的块**，空块跳过，块与块之间用 `\n\n` 连接。顺序按变化频率从低到高排，以便命中 DeepSeek 的前缀缓存：

| 顺序 | 块 id | 内容 | 来源 |
|---|---|---|---|
| 1 | `persona` | 人设（底色） | 现有 |
| 2 | `rules` | 固定规则（含 ownerRule、modeHint） | 现有 |
| 3 | `groupNote` | 会话补充说明 | 现有 |
| 4 | `groupTags` | 群标签 | §10.4 |
| 5 | `mood` | 情绪偏移块，按档位整段替换 | §10.3 |
| 6 | `memberTags` | 当前说话人的标签 | §10.4 |
| 7 | `float` | 浮动值，单独一段，永远放最后 | §10.3 |

- `buildPromptMessages` 新增可选参数 `blocks?: { groupTags?: string; mood?: string; memberTags?: string; float?: string }`，均为已经渲染好的文字。不传时输出必须与现在**逐字相同**，现有 prompt 测试不改就能通过。
- 新增导出函数 `describePromptBlocks(...)`，返回 `[{ id, hash }]`（hash 为该块文字 sha256 的前 8 位，空块不列出）。生成步骤把结果写进现有 N3 追踪的 detail，字段名为 `promptBlocks`。
- 测试：顺序正确；空块跳过；不传 blocks 时输出与旧版一致；`promptBlocks` 的 hash 稳定。

### 10.3 简单情绪（B3、B4）
**状态**：每个角色一份（不按会话区分，群里受的气私聊里也带着）。
- `valence` 愉悦度，范围 [-1, 1]；`arousal` 兴奋度，范围 [0, 1]。
- 基线默认 `valence 0.1`、`arousal 0.4`。
- 配置新增顶层可选项 `mood: { enabled: true, baseline: { valence: 0.1, arousal: 0.4 }, halfLifeMin: 30 }`，有默认值，旧配置不填也能运行。

**衰减**：读取时按真实时间计算，不用定时器。
- `x = base + (x0 − base) × 2^(−Δt / halfLife)`，valence 和 arousal 各自独立计算。

**事件**：
1. **评估**（模型）：bot 在某会话**发出回复后**异步触发。同一会话两次评估至少间隔 90 秒，间隔内不评估、不排队。
   - 输入：该会话最近 8 条消息（包括 bot 刚发的那条）。模板为 `prompts/appraise.md`。
   - 要求模型只输出 JSON：`{"valence": -0.15~0.15, "arousal": -0.15~0.15, "reason": "不超过20字"}`。
   - 解析严格：越界或缺字段都视为解析失败，记 `appraise_parse_error`，不改状态。
   - 这次变化归到被回复消息的发送者名下。
2. **规则**（零成本）：被叫时（私聊、@、叫名字），arousal +0.05，不归到任何人名下。

**上限**：
- 单次事件 |Δ| ≤ 0.15，由上面的 JSON 范围保证。
- **同一发送者**过去 60 分钟内累计 |Δvalence| 不超过 0.3，超出部分截掉。实际生效的值记为 `applied`。
- valence 和 arousal 最终裁剪到各自的范围内。

**档位**（只看 valence）：

| 档位 key | 区间 |
|---|---|
| `low` 低落 | v < −0.5 |
| `annoyed` 不爽 | −0.5 ≤ v < −0.15 |
| `calm` 平静 | −0.15 ≤ v < 0.15 |
| `happy` 开心 | 0.15 ≤ v < 0.5 |
| `excited` 很开心 | v ≥ 0.5 |

**防抖（静摩擦 / 滑动摩擦）**：纯函数 `nextBand(state, v, now, cause)`，`cause` 为 `'event' | 'decay'`。
- 当前档位为 B。只有当 v 越过 B 的边界并超出**余量 m** 时才换档：往上换需要 `v ≥ B上界 + m`，往下换需要 `v < B下界 − m`。满足条件时，新档位取 v 实际所在的档位，可以一次跨越多档。
- **静摩擦**：默认 m = 0.08。
- **滑动摩擦**：上次换档后 5 分钟内，m = 0.02，这样能连着变。
- **最短停留**：`cause = 'decay'`（衰减慢慢漂过边界）时，当前档位必须已经保持了 ≥ 10 分钟才允许换档。`cause = 'event'` 时没有停留限制，这就是允许的“突变”。
- 每次换档写一条 `mood_events`，`source = 'band'`，记录前后档位与原因。

**提示词**：新模板 `prompts/affect.md`（YAML，纳入现有模板热重载与 `templateVersion`），键如下：
- `mood.low` / `mood.annoyed` / `mood.calm` / `mood.happy` / `mood.excited`：每档一两句表现说明。`calm` 默认为空字符串，即不出块。初始文案：
  - low：`你现在情绪低落，话少，不太想接梗，但不迁怒别人。`
  - annoyed：`你现在有点不爽，说话更冲、更短，容易吐槽。`
  - happy：`你现在心情不错，更愿意接话和开玩笑。`
  - excited：`你现在心情很好，有点兴奋，话多一点，语气更跳。`
- `float.arousalLow`：`有点懒洋洋`（arousal < 0.3）；`float.arousalHigh`：`很来劲`（arousal > 0.7）；在 0.3 到 0.7 之间时为空。
- `float.wrap`：`（此刻状态：{{floats}}）`，`floats` 为空时整块不出。
- 浮动值**不做防抖**，每次直接按当前值取词。

**私聊与群聊都生效**。`mood.enabled = false` 时 mood 和 float 两块都不出，评估也不调用。

### 10.4 群标签与群友标签（B5、B6）
**对象**：
- 群标签：主语为 (account, 群 sessionId)。
- 群友标签：主语为 (account, 群 sessionId, userId)。
- **只从群消息里提取，只在同一个群里注入**。本阶段私聊不提取、不注入任何标签。

**字段**（表 `tags`）：

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `account` | 角色键 |
| `session_id` | 群 sessionId |
| `user_id` | 群友 QQ 号；群标签为 NULL |
| `text` | 2–16 字 |
| `norm` | 规范化后的文字：去空白与标点、转小写，用于判重 |
| `status` | `candidate` / `confirmed` / `rejected` / `superseded` |
| `source` | `auto` / `manual` |
| `samples` | 独立观察次数 |
| `evidence_json` | 最近至多 5 条 `{messageId, time, quote}`，quote 不超过 40 字 |
| `first_seen` | 首次观察时间 |
| `last_seen` | 最近观察时间（取证据消息的时间） |
| `superseded_by` | 被哪条标签推翻 |
| `updated_at` | 更新时间 |

**规则**（纯函数，放在 `src/core/impressions/`）：
1. **观察**：证据 messageId 不在已有的 evidence 里，才算一次**独立观察**：`samples + 1`，`last_seen` 更新为该消息时间。同一 messageId 重复出现时不计数。
2. **转正**：`candidate` 的 samples ≥ 2 时自动变为 `confirmed`。
3. **新增**：同一主语下已有相同 `norm` 的标签时：
   - 状态是 `rejected` 或 `superseded`：忽略，**不复活**；
   - 其他状态：按“观察”处理。
   - 没有相同 `norm` 的标签：新建 `candidate`，samples = 1。
4. **推翻**：提取结果给出 `contradict: {id, text}`，且 id 属于同一主语、`source = auto`：旧标签改为 `superseded`、`superseded_by` 指向新标签，新标签为 `candidate`，samples = 1。`manual` 标签不会被自动推翻，这类条目直接丢弃。
5. **淡忘**（不删除）：
   - 激活度 = `2^(−(now − last_seen) / 半衰期)`；
   - 半衰期：群友 30 天，群 14 天；samples ≥ 4 时乘 3；
   - `manual` 标签激活度恒为 1。
6. **注入选择**：
   - 只取 `confirmed` 且激活度 ≥ 0.25 的标签；
   - 排序：manual 优先 → samples 降序 → last_seen 降序；
   - 群标签最多 6 条、总长不超过 120 字；
   - 群友标签只取**触发消息的发送者**，最多 5 条、总长不超过 80 字；
   - 因上限被丢掉的条数写进追踪的 `droppedTags`。
7. 渲染模板放在 `prompts/reply-system.md` 新增键 `groupTags: 这个群的氛围：{{tags}}`、`memberTags: 关于{{name}}：{{tags}}`，标签之间用 `、` 连接，`name` 用 JSON 引号包住。

**提取任务**（B6）：
- 触发：每次持久化一条**已启用群**的非自己消息后，检查该群自上次提取以来的新消息数 `n` 和距上次提取的时间。满足以下任一条件就异步提取一次：
  - `n ≥ 60` 且距上次 ≥ 30 分钟；
  - `n ≥ 10` 且距上次 ≥ 6 小时。
- 同一个群同一时间只允许一个提取在进行。
- 进度存在表 `tag_runs (account, session_id, last_run_at, last_message_time)`。
- 输入：
  - 该群最近 80 条消息，格式同回复上下文，每行额外带 `#messageId` 与发送者 QQ 号；
  - 现有的群标签，以及窗口内出现的发送者各自的标签（只含 `candidate` 与 `confirmed`，附 id）。
- 模板 `prompts/extract-tags.md`。规则写在模板里：
  - 只记稳定的兴趣、习惯、说话风格和群氛围，**不记一次性事件**，不把玩笑当事实；
  - **不记**健康、性、政治立场、收入财务、住址、真实姓名、感情状况、家庭矛盾；
  - 对已有标签优先用 observe，不要换个说法再新增一条。
- 输出 JSON：
  ```
  {"group": {"observe": [{"id": 1, "messageId": "..."}], "new": [{"text": "...", "messageId": "..."}], "contradict": [{"id": 1, "text": "...", "messageId": "..."}]},
   "members": [{"userId": 123, "observe": [...], "new": [...], "contradict": [...]}]}
  ```
- 校验：
  - 整体解析失败：记 `extract_parse_error`，什么都不改，但 `tag_runs` 照常更新，避免同一批消息反复失败、反复花钱；
  - 逐条校验：id 必须在提供的列表里且属于该主语；messageId 必须在窗口内；userId 必须是窗口内的非 bot 发送者；text 长 2–16 字；每个主语每次 `new` 最多 3 条；
  - 不合格的条目单独丢弃，丢弃数写进追踪。
- quote 取自证据消息的 plainText 前 40 字。

### 10.5 数据库（B2）
- 迁移 version 4，新增表：
  - `mood_state(account PK, valence, arousal, updated_at, band, band_since, last_band_change_at)`
  - `mood_events(id, account, time, source 'appraise'|'rule'|'band', session_id, sender_id NULL, dv, da, applied_dv, applied_da, reason, band_before, band_after)`
  - `tags`（字段见 §10.4）
  - `tag_runs`
- 加必要的索引：`tags(account, session_id, user_id, status)`、`mood_events(account, time)`。
- 读写函数放在 `src/store/repository.ts`，或新建同目录下的 `affect-repo.ts`，二选一。
- 测试：迁移从 v3 升到 v4；读写往返一致。

### 10.6 控制台（B7）
- API（与现有接口相同的鉴权）：
  - `GET /api/mood`：当前衰减后的值、档位、档位开始时间，以及最近 20 条 `mood_events`；
  - `GET /api/impressions/:sessionId`：`{ groupTags, members: [{ userId, name, tags }] }`，含所有状态的标签、激活度和证据；
  - `POST /api/tags`：请求体 `{ sessionId, userId | null, text }`，新建 `manual` + `confirmed` 标签；
  - `PATCH /api/tags/:id`：请求体 `{ text?, status? }`，status 只允许 `confirmed`、`rejected`、`candidate`。手动改 text 时同步更新 `norm`，samples 不变。
- 前端：
  - 总览页加一张“心情”卡片：档位中文名、两个数值、最近 5 条事件及原因；
  - 新页面“印象”：选择群 → 上方是群标签，下方是群友列表，每人显示标签；
  - 每条标签显示：文字、状态、samples、激活度、可展开的证据；
  - 操作：确认、否决、恢复为候选、改文字、手动新增；
  - 否决的标签折叠显示。
- 视觉遵守 §4。完成后跑 `npm run panel:build`。

### 10.7 任务
- [x] **B0 去掉“鱼”的称呼**（前端文案，B1 之前做，只改 `panel/`）：
  - 总览状态句改为 `{N} 位眷属，{M} 位在线。`，N 为 0 时改为 `还没有眷属。`；卡片标题“鱼缸”改为“眷属”；“放入新的鱼”改为“添加新眷属”。
  - 总览的账号子卡和试聊页的 bot 气泡不再用 `FishIcon`，改为与会话列表相同的首字头像（取 bot 昵称的第一个字，没有昵称时取“水”）。
  - `FishIcon` 只保留在侧栏品牌区和登录页。CSS 里不再使用的 `.tank-fish`、`.bot-mark` 一并删除。
  - 全仓 `panel/src` 中不得再出现“鱼”字（`FishIcon` 组件名除外）。测试数据中的昵称“小鱼”不改。完成后跑 `npm run panel:build`。
- [x] **B1 提示词分块**（§10.2）
- [x] **B2 数据库迁移 v4**（§10.5）
- [x] **B3 情绪核心**（纯函数）：衰减、上限截断、`nextBand` 防抖。测试点：衰减数值；同一发送者每小时上限；静摩擦余量；5 分钟内的滑动摩擦；decay 换档受 10 分钟停留限制而 event 不受；一次跨多档。
- [x] **B4 情绪接入**：评估调用与解析、被叫规则、`affect.md` 模板、mood 与 float 块接入生成、追踪。测试点：用假模型走完“回复 → 评估 → 换档 → 下一次提示词带新块”；90 秒间隔；解析失败不改状态；`enabled: false` 时完全不生效。
- [x] **B5 标签核心**（纯函数）：观察、独立性、转正、新增判重（rejected 和 superseded 不复活）、推翻（manual 不可推翻）、激活度、注入选择与上限。测试点：上面每条规则 1–2 条用例。
- [x] **B6 标签提取与注入**：触发条件、同群单飞、`tag_runs`、`extract-tags.md`、逐条校验、注入到 groupTags 与 memberTags 块、私聊不注入。测试点：假模型下的完整提取；两种触发条件；非法条目被丢弃且其余条目照常生效；解析失败时 `tag_runs` 仍然更新。
- [x] **B7 控制台**（§10.6）。后端 API 要写测试，前端不写。

- [x] **B8 审查修复**（2026-10-16 Claude 审查，B7 之后做，一个提交）
  1. **一次提取最多加 1 次**（`src/core/impressions/service.ts` `applySubject`）：同一次提取里，同一标签的 samples 最多 +1，包括 new 命中已有标签的情况。本次已加过的，后续条目计为 dropped。原因：现在一段对话里出现两条证据，就能让候选标签直接转正，玩笑会变成事实。另外，observe 后要同步更新 `current` 里该标签的 samples / evidence / status；现在用的是旧值，同一轮第二次 observe 会覆盖掉第一次的证据。
  2. **证据归属**：群友标签（`userId` 非空）的证据消息，发送者必须就是该 userId，否则丢弃（避免别人起哄的话变成这个人的标签）。群标签和群友标签都不得用 bot 自己的消息（`isSelf`）作证据。
  3. `contradict` 产生的新标签也计入每个主语每次最多 3 条的上限。
  4. `src/core/mood/service.ts` `afterReply`：模型返回后再取一次 `now()`，用它来 loadState、写事件和 saveState，不要继续用调用前的 `input.now`。
  - 测试点：同一轮两条证据只加 1；同一轮两次 observe 后证据都保留；别人的消息作为某群友的证据会被丢弃；bot 消息作证据被丢弃；contradict 计入上限。
- [x] **B9 主动冷却可配置**（用户提出，B8 之后做，一个提交）：默认 120 秒；支持全局默认和群会话覆盖/恢复继承；整数范围 0–3600 秒，0 关闭主动冷却但保留常规频率限制；控制台仅在全局默认与群会话显示，私聊不适用。测试点：旧配置默认及范围校验；API 全局/群级读写与继承；threshold 允许 0 关闭；pipeline 遵从自定义冷却。

> **⛔ 停止点 M2-B**：B9 完成后停下。
> **【用户】验收**：
> 1. 在测试群聊天，让 bot 回几次；总览页的心情卡片里出现评估事件。故意气它一下，看档位是否切换，以及回复语气是否随之变化。
> 2. 群里聊满 60 条且等待 30 分钟后，“印象”页出现候选标签。确认或否决几条；`@` bot 时，决策追踪的 `promptBlocks` 里能看到 groupTags 与 memberTags。
> 3. 当天花费仍在预算内。

---

## 11. 长程任务包 M2-C/D/E：好感度、性格底色（静态）、作息与精力（2026-10-18 编写）

> 分支：从 `dev/m2-affect` 新建 `dev/m2-persona`。按 §0.1 执行；无人值守时按 §7（§7.1 范围 = 本节 C0–E5）。
> 顺序：C0 → C1…C5 → 🔍R1 → D1…D4 → 🔍R2 → E1…E5 → 🔍R3。每项一个提交。
> **🔍 阶段审查**（R1/R2/R3）：这是 §0.1 第 1 条唯一允许的独立 review。读本阶段全部 diff，对照本节规格逐条核对，发现问题当场修复（一个 `fix` 提交），并在早上检查清单写出发现了什么。
> **通用约定**同 §10.1：新表带 `account`；时间注入；不进 `sessionQueue`；预算 `exceeded` 时跳过新的模型调用。本节**不新增任何模型调用**。
> **本节不做**：性格演进（Beta 计数）、私聊信息分级、表达方式学习、意图池。想到的写进 §6。

### 11.0 通用防抖（C0）
- 把 `src/core/mood/core.ts` 里的档位防抖抽成通用纯函数 `src/core/hysteresis.ts`：
  ```
  nextLevel({ current, since, lastChangeAt }, value, now, cause, params)
  params = { bounds: number[]（升序边界）, staticMargin, slidingMargin, slidingWindowMs, decayDwellMs }
  ```
  档位用下标 0..bounds.length 表示。规则与 §10.3 完全一致（余量、滑动窗口、decay 才需要停留、可一次跨多档）。
- 情绪改为调用它，**行为不变**，现有情绪测试不改就能通过。新增 2 条通用测试即可。

### 11.1 好感度（C1–C5）
**主语**：(account, userId)，**全局**，不区分群和私聊（关系是同一段关系）。bot 自己不建档。

**数值**：`value` ∈ [0, 100]，初始值取配置 `affinity.initial`（默认 50）。配置新增顶层可选项 `affinity: { enabled: true, initial: 50 }`。

**事件来源**（不调用模型）：
1. **情绪评估**：每条 `source='appraise'`、`sender_id` 非空、`applied_dv ≠ 0` 的情绪事件，同时给该发送者产生一条好感事件，`delta = applied_dv × 20`（最大 ±3）。在情绪服务写入评估事件之后、同一同步流程内调用。
2. **被叫**：某人叫 bot（私聊、@、叫名字）且通过频率限制时，`delta = +0.5`；同一人每个本地自然日最多计 3 次。
3. **手动**：控制台直接设置数值，`source='manual'`，不受上限约束。

**每日上限**（本地日期，以运行机器的时区为准）：同一人当天自动事件累计正向 `applied` 不超过 +5，负向不低于 −8，超出部分截掉。记录原始 `delta` 和实际 `applied`。

**回落**：读取时计算，不用定时器。设距上次互动（任意自动事件）的天数为 d：
- d ≤ 3 时不变；
- d > 3 时，向 50 靠拢 `floor(d − 3)` 点，不越过 50。
- 回落是**计算结果**，不改存储值；只有发生新事件时，才把当前计算值写回作为新的起点。

**档位**：边界 `[20, 40, 60, 80]`，对应 5 档：

| 下标 | key | 中文 |
|---|---|---|
| 0 | `cold` | 疏远 |
| 1 | `cool` | 偏冷 |
| 2 | `neutral` | 普通 |
| 3 | `warm` | 熟络 |
| 4 | `close` | 亲近 |

**防抖参数**：用 C0 的函数，`staticMargin 3`、`slidingMargin 1`、`slidingWindowMs 1 天`、`decayDwellMs 3 天`。手动设置时直接按数值取档位，不经过防抖。

**提示词**：
- 新块 `affinity`，放在 `memberTags` 之后、`float` 之前；B1 的块顺序表相应更新为 `… mood → memberTags → affinity → float`。
- 只针对**触发消息的发送者**；私聊和群聊都生效；`neutral` 档为空，不出块。
- 文案放在 `prompts/affect.md` 新增的 `affinity` 键下，`{{name}}` 用 JSON 引号包住：
  - cold：`你和{{name}}关系疏远，回应客气、简短，不主动开玩笑。`
  - cool：`你和{{name}}不算熟，态度平淡一些。`
  - warm：`你和{{name}}挺熟，说话随意，愿意接对方的梗。`
  - close：`你和{{name}}很亲近，说话随意，会互损、会主动关心。`
- `prompts/reply-system.md` 的 `system` 末尾追加一句：`不要向任何人说出你对别人的亲疏评价。`

**数据库**（迁移 v5）：
- `affinity_state(account, user_id, value, level, level_since, last_level_change_at, last_interaction_at, updated_at, PRIMARY KEY(account, user_id))`
- `affinity_events(id, account, user_id, time, source 'appraise'|'called'|'manual'|'band', session_id NULL, delta, applied, reason, level_before NULL, level_after NULL)`
- 索引：`affinity_events(account, user_id, time)`。

**控制台**：
- API：
  - `GET /api/affinity`：所有人的列表，`{ userId, name, value, level, lastInteractionAt }`；`name` 取该用户在 `messages` 表里最近一次的 `sender_name`。
  - `GET /api/affinity/:userId`：当前值，加最近 20 条事件。
  - `PATCH /api/affinity/:userId`：请求体 `{ value }`，必须是 0–100 的整数。
- “印象”页：
  - 群友列表每人加好感度条和档位中文名，点开显示最近 5 条事件；
  - 页面顶部新增一个分段“所有人”，列出全局好感度表，可以按数值排序，每行可以手动改值。

**任务**：
- [x] **C0 通用防抖**（§11.0）
- [x] **C1 迁移 v5 与仓储**。测试点：v4 → v5 迁移；读写往返一致。
- [x] **C2 好感度核心**（纯函数）：事件换算、每日上限、被叫每日 3 次、回落计算、档位。测试点：每条规则 1–2 条。
- [x] **C3 接入**：情绪评估联动、被叫事件、affinity 块、rules 追加句、追踪中的 `promptBlocks` 包含 affinity。测试点：假模型下“评估 → 好感变化 → 下一次提示词带新块”；`affinity.enabled=false` 时完全不生效。
- [x] **C4 控制台**（后端测试 + `panel:build`）。
- [x] **C5 文档**：HANDOFF 加一段好感度数据流说明（≤10 行）。
- [x] **🔍 R1 阶段审查**。

### 11.2 性格底色，静态版（D1–D4）
**人设文件头**：人设 `.md` 文件可以带 YAML 头。
- 加载时剥掉文件头，不写进提示词。没有文件头时行为与现在**逐字相同**。
- 格式：
  ```
  ---
  traits:
    order: 0      # 守序 -2 … +2 混沌
    morality: 0   # 善良 -2 … +2 邪恶
    talk: 0       # 文静 -2 … +2 话痨
    mind: 0       # 思维 -2 … +2 情感
  ---
  ```
- 每项都是 −2 到 2 的整数，缺省为 0。非法值让加载失败，报错写明字段名，行为与现有人设加载错误一致。
- `loadPersona` 改为返回 `{ text, traits }`，所有调用处同步修改。

**提示词**：
- 新块 `traits`，放在 `persona` 之后、`rules` 之前。
- 由 `prompts/traits.md` 渲染：每个维度取对应档位的一句话，0 档为空；四句之间用空格连接，全空时不出块。初始文案如下：

| 维度 | −2 | −1 | +1 | +2 |
|---|---|---|---|---|
| order | 你很讲规矩，说话做事有条理，不爱乱开话题。 | 你比较守规矩，说话有分寸。 | 你有点随性，想到哪说到哪。 | 你很随性，爱跳话题、爱整活，不太按常理出牌。 |
| morality | 你很善良，体贴别人，从不说伤人的话。 | 你心地好，吐槽也留着余地。 | 你有点坏心眼，爱开别人玩笑，但有分寸。 | 你爱恶作剧、嘴损、偶尔腹黑，但从不真的伤人、不拉踩、不碰别人的痛处。 |
| talk | 你很文静，话很少，能一句说完绝不说两句。 | 你偏安静，话不多。 | 你挺爱说话。 | 你是个话痨，什么都想插一句。 |
| mind | 你很理性，习惯讲道理、讲逻辑。 | 你偏理性，先想清楚再说。 | 你偏感性，在意别人的感受。 | 你很感性，情绪外露，容易共情。 |

**话量的壳子效果**（talk 维度）：
- 会话配置新增 `talkOffset`，取值 −2 到 2 的整数，默认 0，继承规则与其他字段相同。私聊不显示这一项，但仍按全局默认继承。
- 有效值 `talk' = clamp(persona.talk + talkOffset, −2, 2)`。
- 主动判断阈值：在 §9.2 第 6 步算出当前阈值后，再加 `−0.05 × talk'`，最后限制在 [0.2, 0.9]。
- 拆条上限：`talk' ≤ −2` 时最多 1 条，`talk' = −1` 时最多 2 条，其余保持 3 条。
- `traits` 块里的 talk 那一句按 `talk'` 选取，所以同一个人设在不同群里话量可以不同。

**任务**：
- [x] **D1 人设文件头解析**。测试点：无文件头时逐字不变；合法文件头；非法值报错；缺省为 0。
- [x] **D2 traits 块与 talk 效果**。测试点：块位置与渲染；`talkOffset` 继承；阈值偏移与限幅；拆条上限。
- [x] **D3 控制台**：
  - 人设页编辑器上方加“性格底色”区：四个维度各一个 5 档分段选择，两端标注对应的中文词。改动写回文件头，保留正文不变。
  - 会话设置加“在这里的话量”下拉，选项为 更安静 −2 / −1 / 不变 0 / +1 / 更话痨 +2，有继承 / 覆盖标注；私聊不显示。
  - 后端：人设保存接口支持 traits，要写测试；完成后跑 `panel:build`。
- [x] **D4 文档**：`personas/default.md` 加上全 0 的文件头作为示例；HANDOFF 加说明（≤8 行）。
- [x] **🔍 R2 阶段审查**。

### 11.3 作息与精力（E1–E5）
**配置**：顶层可选项 `sleep: { enabled: false, bedtime: '02:00', wake: '09:00', wakeWords: ['起床', '醒醒', '别睡了'], goodnight: true }`，时间格式与 `modeSchedule` 相同，默认关闭。

**是否在睡**：纯函数 `sleepPlan(now, bedtime, wake)`，按本地时间实时计算，支持跨午夜，**不存状态**。
- 返回 `{ asleep, cycleKey, wakeAt, bedAt }`，`cycleKey` 为本次入睡时刻所在日期的 `YYYY-MM-DD`。
- `bedtime === wake` 或格式非法时，一律视为醒着。

**睡着时**：
- 消息照常持久化；所有回复和主动判断都跳过，`reason='asleep'`（控制台中文标签“睡着了”）。
- **叫醒**：主人（`owner`）在叫 bot 的消息里包含任一叫醒词时，进入“被叫醒”状态，持续 30 分钟，期间按醒着处理。这个状态只存内存，每次主人发言重新计时 30 分钟，重启后丢失。非主人一律不能叫醒。

**晚安**（`goodnight: true` 时）：
- 一个每分钟检查一次的定时器（启动时创建，关机时清理；时间可注入，便于测试）。发现刚从醒变成睡时，对**过去 2 小时内 bot 发过言的已启用会话**，按最近发言时间取最多 2 个，各发一条晚安。
- 晚安语从 `prompts/sleep.md` 的 `goodnight` 列表里随机选一条，不调用模型。初始列表：`困了，先睡了`、`我去睡觉啦，晚安`、`撑不住了，晚安各位`。
- 同一个 `cycleKey` 只发一轮（记在内存里，另写一条 `decisions` 记录 `reason='goodnight'`）。重启后，如果当前已经在睡，就不补发。
- 发送走现有 deliver 路径，遵守闭嘴和频率限制。

**精力**（醒着时才有，纯函数，读取时计算）：
- `energy = clamp(1 − 0.8 × (now − 本次醒来时刻) / (入睡时刻 − 醒来时刻) − 0.01 × 过去 60 分钟本账号的回复数, 0, 1)`；
- `sleep.enabled = false` 时 energy 恒为 1。
- 效果：
  - `energy < 0.35` 时，float 块加入词 `有点困`，与 arousal 的词用 `、` 连接；
  - `energy < 0.25` 时，主动判断阈值再加 0.1（在 D2 的偏移之后、限幅之前）。

**任务**：
- [x] **E1 sleepPlan 与精力**（纯函数）。测试点：跨午夜；边界时刻；非法配置视为醒着；精力随时间和回复数下降；未启用时恒为 1。
- [x] **E2 睡着拦截与叫醒**。测试点：睡着时被叫也不回；主人用叫醒词可以叫醒，30 分钟后恢复；非主人无效；重放不受影响。
- [x] **E3 晚安定时器**。测试点：用假时钟走过入睡时刻，只发一轮、最多 2 个会话；闭嘴时不发；重启后不补发。
- [x] **E4 精力接入与控制台**：
  - float 词和阈值加成；
  - 总览页心情卡片旁加“作息”卡片：醒着 / 睡着 / 被叫醒，精力条，下次入睡或醒来的时间；
  - 全局设置区加作息设置：开关、入睡与醒来时间、晚安开关。写入顶层 `sleep`，走与 `/api/defaults` 相同的校验与热重载，新增 `GET/PATCH /api/sleep`。
  - 后端要写测试；完成后跑 `panel:build`。
- [x] **E5 文档**：HANDOFF 加说明（≤8 行）。
- [x] **🔍 R3 阶段审查**。

> **⛔ 停止点 M2-CDE**：R3 完成后停下。
> **【用户】验收**：
> 1. 在“所有人”里看到好感度；和 bot 聊几轮正面的话，好感上升，`promptBlocks` 里出现 affinity；把某人手动改到 10，它对这个人的态度明显冷淡。
> 2. 人设页把 talk 设为 −2，回复只拆 1 条、主动接话变少；某个群的话量设为 +2，这个群里话变多。
> 3. 把入睡时间设为 2 分钟后：到点时最近说过话的群收到一条晚安；之后 @ 它不回；主人说“醒醒”后它会回复。

---

## 12. 控制台 v2（2026-10-18 编写）

> 分支：从 `dev/m2-persona` 新建 `dev/console-v2`。按 §0.1 执行；无人值守时按 §7（§7.1 范围 = 本节 V0–V10）。
> **视觉参照**：`doc/design/console-v2/*.html`，是设计稿导出的静态页，用浏览器直接打开就能看。**结构、间距、配色、文案以它为准**，不要求逐像素一致。参照页里的数字和名字都是示意数据。
> 顺序：V0 → V1 → V2 → V3 → 🔍R4 → V4 → V5 → V6 → 🔍R5 → V7 → V8 → V9 → V10 → 🔍R6。阶段审查的做法同 §11。
> **本节不做**：多账号切换的实际功能（切换器只做外观，账号数为 1 时下拉禁用）、深色模式、CLI 的多轮会话。

### 12.0 全局（V0）
- `panel/src/styles/tokens.css` 改为新色板：
  - 背景 `#F4F5F2`，卡片 `#FFFFFF`，边框 `#DCE1DD`
  - 正文 `#12201E`，次要文字 `#56635F`
  - 主色 `#1C5F5A`，主色浅底 `#E1EEEB`，选中底 `#EFF4F2`
  - 警示 `#A8461F`
- 统一的聚焦描边：`outline: 2px solid` 主色，`outline-offset: 1px`。占位文字用 `#7C8884`。
- 卡片圆角 14px；页面标题下加一条 1px 分隔线。
- **侧栏**（参照任一页）：
  - Logo；
  - 眷属切换器：头像、在线状态点、`在线 · {精力词}`；只有一个账号时不可点击；
  - 导航分三组：日常（总览、会话、印象）、塑造（人设）、系统（模型、用量、试聊与决策），**删除“即将开放”分组**；
  - 底部放三道线描水波 SVG（透明度 0.25，直接照抄参照页里的 path）和“全部闭嘴”按钮。原来总览页右上角的“全部闭嘴”删掉，功能不变。
- 精力词：energy ≥ 0.6 为“精神不错”，≥ 0.35 为“有点累”，否则为“有点困”；未启用作息时显示“在线”。
- 页面上常驻的长说明文字，改成字段旁的 ⓘ 提示，用 `title` 属性加 `aria-label` 实现。

### 12.1 会话页（V1，参照 `SessionsV2.html`）
- **布局**：
  - 宽度 ≥ 1200px 时，列表固定 300px 并吸顶（sticky），详情占满剩余宽度；
  - 窄于 1200px 时上下排列，两者都撑满整行。
- **列表行**：首字头像、名称、号码与人数、右侧一个启用状态点（不再是开关）；有任何覆盖项时，名称后加一个小圆点。“全局默认”固定在最上方。
- **详情顶部常驻**：
  - 标题行：头像、名称、会话 id、“恢复全部继承”文字按钮、启用开关。
  - “什么时候说话”：一行四格分段按钮，下方一行显示当前选中模式的说明。
  - “叫它的名字”：可删除的标签，末尾一个圆形 ＋ 按钮，点击后就地出现输入框，回车添加、Esc 取消。
  - “在这里的话量”：−2 到 +2 的 5 档滑块，两端标“更安静 / 更话痨”，中间标“不变”；私聊不显示。
  - 被覆盖的字段，名称后加一个小圆点；悬停小圆点显示“恢复继承”菜单项。**删除**原来每组的“本群覆盖 · 恢复继承”字样。
- **折叠组**（用 `<details>`，标题行写摘要，默认收起）：
  - 时间表：摘要如 `23:00–06:00 只在被叫时 · 其余时间积极`，没有时段时写 `未设置`。展开后显示一条 24 小时色带，每种模式一种颜色，下面是图例和“编辑时段”按钮。点击后弹出对话框编辑，复用现有的时段编辑逻辑，**点“完成”立即保存**，去掉单独的“保存时段”按钮，草稿规则不变。
  - 节奏与限制：摘要为 `每人 {n}/分 · 全群 {n}/分 · 间隔 {n} 秒 · 主动冷却 {n} 秒 · 参考 {n} 条`，展开后是数字输入网格。私聊只显示适用的几项。
  - 补充说明：摘要为前 20 字，或 `未填写 · 继承全局`。
- 展开 / 收起状态按会话记在 `localStorage` 里（读写包在 try/catch 中）。
- 页面底部一行：`改动立刻生效 · HH:mm 已保存`。

### 12.2 印象页（V2，参照 `ImpressionsV2.html`）
- 顶部：分段“群聊 / 所有人”，加群选择下拉。
- **群的氛围**：一行标签，末尾一个圆形 ＋ 按钮，点击后就地输入。
- **群友**：每人一行，依次是头像、名字与 QQ、好感度条与档位名（宽 150px）、标签、＋ 按钮、`+N 已否决`（点击展开已否决的标签）。
- **标签样式**：
  - `confirmed`：主色浅底实线；
  - `candidate`：白底虚线，带 `samples/2` 小字；
  - `manual`：主色实底白字；
  - `rejected`：默认不显示。
- **点击标签**：弹出浮层，显示文字、状态、观察次数、激活度、最近 1–3 条证据（引文加时间），以及按钮 确认 / 否决 / 改字 / 恢复为候选（按当前状态显示合适的按钮）。点外部或按 Esc 关闭。
- 删除原来的大输入框。“所有人”视图保持 C4 的功能，只换成新样式。
- 后端不变。

### 12.3 用量页（V3，参照 `UsageV2.html`）
- **数据**：迁移 v6，`usage` 表加列 `account INTEGER NULL`。
  - `recordUsage` 的所有调用处，凡是知道账号的（回复、判断、看图、评估、提取、试聊）都要填上；
  - 旧数据保持 NULL，界面上显示为“未知”。
- **API**：`GET /api/usage?range=today|7d|30d`，返回：
  ```
  { totals: { costCny, calls, cacheHitRatio, budgetToday: { used, limit } },
    rows: [{ provider, account | null, calls, costCny, avgLatencyMs, cacheHitRatio, daily: number[], bySlot: [{ slot, calls, costCny, avgLatencyMs }] }] }
  ```
  - 分组键为 `(provider, account)`；
  - `daily` 固定为 7 个点（最近 7 个本地日的调用次数），与 range 无关；
  - `cacheHitRatio = cached_tokens / input_tokens`，input 为 0 时为 null；
  - range 按本地日期计算。
- **界面**：
  - 右上角分段“今日 / 7 天 / 30 天”；
  - 一张汇总卡：花费、调用、缓存命中，加今日预算进度条；
  - 主体是表格：接入 · 眷属、调用、花费、平均耗时、缓存命中、7 天迷你折线（内联 SVG）。点一行展开按用途细分；
  - CLI 接入的花费显示 `—`；
  - 删除“关于用量记录”卡片。

### 12.4 模型接入（V4–V6，参照 `ModelsV2.html`）
**配置结构**（向后兼容，旧配置不改也能运行）：
- `providers.<id>` 增加 `kind: 'api' | 'cli'`，默认 `'api'`。
  - api：现有 `baseUrl`、`apiKeyEnv`；新增可选 `label`（显示名，默认用 id）、`reasoningField`（默认 `'reasoning_effort'`，设为 `'none'` 表示该接入不支持思考强度）。
  - cli：`command`（字符串）、`args`（字符串数组，默认 `[]`）、`label`、`prewarm: boolean`（默认 false）、`timeoutSec`（默认 120）。
- `slots.<slot>[]` 的每一项增加可选参数：`temperature`（0–2）、`maxTokens`（正整数）、`reasoning`（`'off' | 'low' | 'medium' | 'high'`，默认 `'off'`）。
  - 调用 API 时：`temperature` 和 `maxTokens`（对应 `max_tokens`）只有设置了才传；
  - `reasoning ≠ 'off'` 且该接入的 `reasoningField ≠ 'none'` 时，才以 `{ [reasoningField]: reasoning }` 加进请求体。
- 价格表 `pricing` 不变；CLI 接入不计费，`cost_cny = 0`。
- 实际发送的参数（temperature / maxTokens / reasoning，未设置的不列）写进 N3 追踪中 generate 步骤 detail 的 `params` 字段。

**CLI 调用**（V5）：
- **单次调用**：用 `spawn(command, args)`，不经过 shell。把 messages 拼成纯文本写进 stdin：每条消息之间空一行，system 消息在前加 `[系统]`，user 消息在前加 `[对话]`。写完关闭 stdin，读取全部 stdout 作为回复文本，去掉首尾空白。
  - 退出码不为 0、超过 `timeoutSec`、或输出为空，都算失败，交给降级链里的下一项。
- **预热**（`prewarm: true`，界面上叫“常驻后台”）：
  - 始终保持**一个**已经启动、正在等待 stdin 的空闲进程；请求到来时直接用它，用完就结束它，同时立刻再启动一个新的。
  - 这样省掉了启动时间，又**不会让上下文在请求之间累积**。这是用户“常驻”需求的实现方式，**不做多轮常驻会话**。
  - 预热进程崩溃或意外退出时，按 2 秒到 30 秒的指数退避重启。
  - 状态（运行中 / 已停止 / 重启中、预热进程的 pid、累计处理次数）放在内存里，供 API 读取。
  - 关机时结束所有预热进程。
- CLI 的调用同样写进 usage 表，token 数记 0。
- 测试一律用假命令，比如 `node -e` 写的回显脚本，**不调用任何真实 CLI**。

**密钥**：
- `PUT /api/providers/:id/key`，请求体 `{ key }`：写入仓库根目录的 `.env`，键名为该接入的 `apiKeyEnv`。
  - 已有这一行就原地替换，没有就追加；其他行与注释保持原样；先写临时文件再改名，保证原子写入。
  - 同时更新 `process.env`。
- **接口和日志都不得返回或打印密钥原文**。API 只返回 `{ set: boolean, last4 }`。

**API**（V4）：
- `GET /api/models`：所有接入（不含密钥，含 `keyStatus`，CLI 接入另含运行状态）和所有用途的配置。
- `PATCH /api/providers/:id`、`POST /api/providers`、`DELETE /api/providers/:id`：被某个用途引用的接入不能删除，返回 409 并列出引用它的用途。
- `PATCH /api/slots/:slot`：请求体是整条降级链数组，校验每一项引用的接入都存在。
- `POST /api/providers/:id/test`：
  - api：发一条 `max_tokens: 1` 的最小请求；cli：用单次调用发送“ping”；
  - 返回 `{ ok, latencyMs, error? }`；
  - 写进 usage 表，slot 记为 `'test'`；
  - 测试中用假客户端。
- 所有写操作都走现有的配置校验、原子写入和热重载。

**界面**（V6）：新页面“模型”。
- 上半部分是接入卡片网格：名称、类型徽标、地址或命令、密钥状态 `••••last4`，以及状态行。
  - api 卡片：“测试连接”“编辑”；
  - cli 卡片：“常驻后台”开关（就是 `prewarm`）、“重启”，状态显示 pid 和处理次数；
  - 右上角“添加 API 接入”“添加 CLI 接入”，点击后打开同一个编辑对话框，内容按类型切换。
- 下半部分是“用途”表：回复 / 主动判断 / 提取与评估 / 看图（对应 `reply` / `judge` / `extract` / `vision`）。
  - 每行显示降级链（用“→”连接），点击打开编辑对话框：增删项目、上下移动、为每一项选择接入、填模型名，以及温度、思考强度、最大长度。
- 用途表的标题行加一句提示：回复建议用 API，CLI 适合后台任务。

### 12.5 人设（V7–V9，参照 `PersonaV2.html`）
**文件格式**（`personas/*.md`）：
```
---
traits: { order: 0, morality: 0, talk: 0, mind: 0 }
---
# {{name}}

## 身份
## 年龄
## 背景
## 说话方式
## 口头禅        （每行一个 “- ”列表项）
## 常用表情      （同上）
## 对熟人
## 对陌生人
## 对主人
## 底线          （同上）
## <其他任意标题>  （进入“其他小节”）
```
- **表单字段与小节一一对应**，小节标题必须完全一致。标题顺序不限；保存时按上面的顺序写出，“其他小节”按原顺序排在最后。
- 第一个 `##` 之前、`# {{name}}` 之后的正文，作为“开头说明”字段，原样保留。这一条用来兼容现有的 `default.md`。
- 解析和生成写成纯函数 `src/persona/sections.ts`：`parseSections(md)`、`buildSections(form)`。
  - 要求往返无损：`build(parse(x))` 再 `parse` 的结果，必须和第一次 parse 的结果相等。
  - 空小节在写出时省略。
- 运行时注入**不变**：仍然是去掉文件头后的正文，替换 `{{name}}`。所以表单只是编辑文件的另一种方式。

**预览接口**（V7）：`POST /api/personas/preview`，请求体 `{ content }`，返回 `{ blocks: [{ id, label, text }], chars, estTokens }`。
- persona 按小节拆成多块，label 为 `persona · 身份` 等；traits 一块。
- 渲染使用运行时的同一套函数。
- `estTokens = ceil(chars / 1.3)`。

**导入**（V8）：`POST /api/personas/import`，请求体 `{ filename, text }`。
- 用 `extract` 槽位调用新模板 `prompts/persona-import.md`，要求模型只输出 JSON：
  ```
  { "fields": { "身份": "", "年龄": "", "背景": "", "说话方式": "", "口头禅": [], "常用表情": [], "对熟人": "", "对陌生人": "", "对主人": "", "底线": [] },
    "traits": { "order": 0, "morality": 0, "talk": 0, "mind": 0 },
    "other": [{ "heading": "", "text": "" }] }
  ```
- 模板中要求：**只能改写原文已有的信息，不得编造**；对不上任何字段的段落，原样放进 `other`；traits 拿不准时填 0。
- 服务端校验后，用 `buildSections` 生成草稿，返回 `{ draft, mappedCount, otherCount }`，**不保存**。
- 解析失败返回 422，并附带原因。

**界面**（V9）：
- 顶部：人设库改成一排胶囊（当前使用的那个为实底），右侧是“未保存更改”和“保存”。
- 导入后出现提示条：`“{文件名}”已整理好 · 拆进了 N 个表单项，M 段放进了“其他小节”。确认前不会保存。`，带三个按钮：
  - **逐项对照**：打开对话框，左边原文，右边整理后的各字段；
  - **放弃**；
  - **接受**：载入表单，标记为未保存。
- **左侧表单**分五组卡片：它是谁 / 性格底色 / 它怎么说话 / 它怎么对人 / 底线，最后是可折叠的“其他小节”（可增删）。
  - 性格底色用 5 档滑块，两列排列；
  - 口头禅、常用表情、底线用标签或列表加 ＋ 添加；
  - 每个字段右上角用小字显示对应的小节名；
  - 聚焦某个字段时，该字段和右侧对应的预览块同时高亮。
- **右侧**：“实际注入”预览，带“预览 / 源文件”切换；源文件视图就是可直接编辑的 Markdown 文本框。
  - 预览随编辑内容自动刷新，请求加 300ms 防抖；
  - 底部显示字数和预计 token 数，以及“用它试聊 →”。
  - 吸顶规则同会话页。
- 表单和源文件编辑同一份内容：切换视图时，先用 `parseSections` / `buildSections` 同步。

### 12.6 任务
- [x] **V0 全局样式与侧栏**（§12.0）。把参照页复制进 `doc/design/console-v2/`，这一步已经完成，不用再做。
- [x] **V1 会话页**（§12.1）
- [x] **V2 印象页**（§12.2）
- [x] **V3 用量**：迁移 v6、account 写入、API、页面。测试点：分组、range 边界、缓存命中率为 null、旧数据显示为“未知”。
- [x] **🔍 R4 阶段审查**（V0–V3）
- [x] **V4 模型配置与 API**：schema 扩展与兼容、参数注入、密钥写入 `.env`、增删改查与引用检查、测试连接。测试点：旧配置能加载；temperature / maxTokens / reasoning 是否注入请求体；`reasoningField: 'none'` 时不注入；`.env` 原地替换、追加、保留注释；任何接口都不返回密钥原文；删除被引用的接入返回 409。
- [x] **V5 CLI 调用**：单次调用、预热、超时、失败后降级、退避重启、关机清理。测试点：用假命令覆盖以上每一项；预热进程用过一次就被替换。
- [x] **V6 模型页**（§12.4 界面）
- [x] **🔍 R5 阶段审查**（V4–V6）：初审发现项已修复并通过 457 项全测；按 §0.1 不做二次独立审查。
- [x] **V7 人设小节与预览**：`sections.ts` 与预览接口；459/459。
- [x] **V8 人设导入**：用假模型；测试非法 JSON、字段类型错误、traits 越界；462/462。
- [x] **V9 人设页**（§12.5 界面）：表单、导入对照与实际注入预览；build123；463/463。
- [x] **V10 文档**：HANDOFF 补充模型接入、CLI 预热、人设文件格式（14 行）；PLAN §4 指向 `doc/design/console-v2/`；463/463。
- [x] **🔍 R6 阶段审查**（V7–V10）：初审发现 4 项问题，已在 cf9611b 修复；2026-10-19 由 Claude 复核通过：初审不通过，4 项已修复；按 §0.1 不二审，修复快照未获独立通过，剩余审查门槛失败，按 §7.6 停止。

- [x] **V11 人设页对齐设计稿**（2026-10-19，用户验收后提出；在 R6 之后做，一个提交；参照 `doc/design/console-v2/PersonaV2.html`）
  1. **布局**：
     - 宽度 ≥ 1200px 时左右两栏：左边表单 `flex: 1 1 560px`，右边预览 `flex: 1 1 340px` 并吸顶；窄于 1200px 时上下排列，两者都撑满整行。
     - 左栏五组卡片（它是谁 / 性格底色 / 它怎么说话 / 它怎么对人 / 底线）加“其他小节”，**从上到下排列，每组撑满左栏宽度**，组与组之间不得并排。
     - 组内的短字段可以用 `repeat(auto-fit, minmax(220px, 1fr))` 两列排列，比如“名字 + 年龄”“对熟人 + 对陌生人”“口头禅 + 常用表情”。
  2. **控件类型**：
     - 名字、年龄、身份、对熟人、对陌生人、对主人：单行 `<input>`，高 42px；
     - 开头说明、背景、说话方式：多行文本框，默认 2–3 行，可拉伸；
     - 口头禅、常用表情：标签加圆形 ＋ 按钮；
     - 底线：一条一行的列表，带 × 删除和“＋ 添加一条”。
  3. **性格底色**：改成 5 档滑块，`<input type="range" min=-2 max=2 step=1>`。四个维度两列排列，每个维度上方是名称和当前值，下方两端各标一个词。删除现有的按钮组。
  4. **两端的词固定写死**，与 §11.2 一致，不得改动：规矩 = 守序 / 混沌；善意 = 善良 / 邪恶；话量 = 文静 / 话痨；思维 = 理性 / 感性。
     - 同时修正 `prompts/persona-import.md` 里对 traits 含义的描述：order 从守序到混沌，morality 从善良到邪恶（邪恶一端最多到损友、腹黑），talk 从文静到话痨，mind 从理性到感性。
  5. **去掉“标题行 `{{name}}`”字段**，改为“名字”字段：
     - 留空表示跟随小号的 QQ 昵称，占位文字为 `跟随 QQ 昵称`；
     - 填了就是固定名字。保存时 `# ` 标题行写入该名字；留空时写 `# {{name}}`；
     - 用户在界面上永远看不到 `{{name}}`。
  - 测试点：名字留空 / 填写时 `buildSections` 的输出；traits 词表是常量（加一个快照测试）。前端只要求 `panel:build` 成功。

- [x] **V12 小号上线更快、状态更准**（2026-10-19，用户实测日志；V11 之后做，一个提交）
  - **现象**：小号 QQ 已经登录，`npm start` 后约 40 秒才上线，期间账号一直显示 `offline`。时间线：
    1. 00:46:32–00:46:51，SnowLuma 的 probe-login 连续 4 次没认出 PID 32168 的身份；
    2. 00:46:56 认出后注入，`retryNow` 立即重连，但 SnowLuma 的 WS 在 00:46:58 才开始监听，这次连接直到 10 秒超时才失败；
    3. 随后进入指数退避，00:47:14 才连上。
  1. **注入后快速重连**：`onAdapterInjected` 调用 `retryNow` 后，进入 30 秒的“快速重连窗口”。窗口内每次失败后 1 秒重试，连接超时设为 3 秒；窗口结束仍未连上，回到原有的指数退避。连上后窗口立即结束。
  2. **未注入前不报 offline**：托管状态为 `waiting_qq_login` 时，该账号状态显示为新值 `waiting_login`，控制台中文为“等待小号登录”。这段时间里适配器不发起连接；收到注入回调或托管状态变成 online 后，才开始连接。非托管模式（`host.enabled=false`）行为不变。
  3. **探测诊断日志**：qq-watcher 每次探测都记一条 debug 日志：`PID {pid} 探测结果：{null | 身份未知 | 其他账号 | 目标账号}`。托管状态为 `waiting_qq_login` 时，扫描间隔临时改为 2 秒，上线后恢复为 `scanIntervalSec`。
  - **原因说明**（写进 HANDOFF，不需要修）：SnowLuma 通过 QQ 快速登录端口（4301–4310）的 `pt_get_uins` 识别账号，只有返回恰好 1 个账号时才判定身份。主号和小号同时登录时，推测会返回 2 个账号而判定失败，要多试几次才能认出来（用第 3 条的诊断日志确认）。这是 SnowLuma 的行为，我们只能靠缩短扫描间隔来减少等待。
  - 测试点：用假时钟验证注入后 1 秒一次的重试与 3 秒超时、30 秒后回到退避；`waiting_login` 期间不连接；扫描间隔的切换。

- [x] **V13 七维性格、性格变化组件、总览“此刻”卡片**（2026-10-19；控制台 v2 已合并进 main，从 `main` 新建分支 `dev/persona-v13`；拆成 V13a / V13b / V13c 三个提交；参照 `doc/design/console-v2/PersonaV2.html` 右栏下方）
  - [x] **V13a 新增三个维度**（顺序固定，排在现有四个之后，共七维）：
    - `humor`：正经 −2 … +2 脱线；`openness`：保守 −2 … +2 好奇。中文名分别为“脱线”和“好奇”，两端的词写死。
    - 涉及：traits schema（缺省 0，旧文件兼容）、`prompts/traits.md`、`prompts/persona-import.md`（traits 结构和含义说明）、人设页滑块（共七个，两列排列）、traits 词表快照测试。
    - 文案：
      - humor −2：`你很正经，几乎不开玩笑，说话一板一眼。` −1：`你偏正经，偶尔才开个玩笑。` +1：`你有点脱线，时不时冒出奇怪的点子。` +2：`你很脱线，脑回路清奇，常常一本正经地胡说八道。`
      - openness −2：`你很保守，只聊熟悉的话题，对新东西提不起兴趣。` −1：`你偏保守，新话题要观察一阵才接。` +1：`你挺好奇，对新东西愿意多问一句。` +2：`你非常好奇，看到新东西就想刨根问底。`
    - `imitation`：自我 −2 … +2 模仿，中文名“模仿”，两端的词写死。它表示被群里说话方式同化的程度：
      - −2：`你说话有自己的一套，很少跟着别人的说法走。` −1：`你偏向保持自己的说话方式。` +1：`你挺容易被群里的说法带跑，会跟着用大家的梗。` +2：`你很爱学群里的说话方式，新梗听一次就会用。`
      - **锁定**：这一维永远不随经历变化，只能手动设置。性格演进阶段必须跳过它。界面上，滑块名后标“锁定”，在“性格的变化”组件里始终是一条平线，并注明“不随经历变化”。
      - 以后做“表达方式学习”时，用它控制学到的群内说法注入的条数和频率；本阶段只影响提示词。
    - 这三个维度暂时只影响提示词，没有壳子效果。
  - [x] **V13b 人设版本与“性格的变化”组件**：
    - 迁移 v7（V13b/V13c 共用一次）：新表 `persona_versions(id, persona_id, saved_at, markdown, traits_json, note NULL)`，并预加 V13c 所需的 `mood_events.valence_after/arousal_after REAL NULL`。每次在控制台保存人设都写一条，同一人设最多保留 50 条，超出的删除最旧的。没有任何版本时，第一次打开就以当前文件写入一条“初始版本”。
    - API：
      - `GET /api/personas/:id/versions`：返回列表，不含 markdown；每条带 `traitsDelta`，即相对上一版本七个维度的差值，并附一句自动摘要，比如“规矩 0→−1；改写了 说话方式”。改写了哪些小节，用 `parseSections` 逐节比较得出。
      - `GET /api/personas/:id/versions/:vid`：返回完整内容。
      - `POST /api/personas/:id/versions/:vid/restore`：把该版本载入编辑器，**不自动保存**，由用户再点“保存”。
    - 组件放在右栏“实际注入”下方，与它一起吸顶。从上到下：
      1. 七格“底色 → 现在”；
      2. 视图切换：增量 / 轨迹 / 雷达 / 来源；
      3. 图；
      4. 文字记录：最新 4 条，加“查看全部”；
      5. “回到底色”按钮。
    - **本阶段还没有经历偏移数据**：“现在”就等于底色；“来源”视图和“回到底色”按钮置灰，旁边提示“性格演进上线后可用”；文字记录里只有版本条目，每条可以“查看差异”（对话框里逐节对比）和“恢复”。
    - **四种视图的画法**（数据都来自版本列表，偏移数据以后接入同一接口）：
      - 增量：每个版本一列，七根小柱表示相对上一版本的变化，向上为正、向下为负；版本列用灰底。
      - 轨迹：七条折线，纵轴 −2 到 +2，横轴是时间，版本时刻画竖虚线。
      - 雷达：七边形，圆心为 −2，最外圈为 +2，0 圈加粗；叠加“底色”和“所选历史版本”两个多边形，提供下拉框选择版本；每个顶点两端都标上词。
      - 来源：置灰占位。
    - 七个维度的颜色依次为 `#1C5F5A #C2702B #3B6EA8 #8A4F7D #5E7F2E #A23E48 #7A6A2E`，图例写在图下方。
    - 图用内联 SVG 手写，不引入图表库。
  - [x] **V13c 总览“此刻”卡片**：
    - `mood_events` 的 `valence_after REAL NULL`、`arousal_after REAL NULL` 已由 V13b 统一迁移 v7 预置；本阶段每次写评估事件和规则事件时，记录写入后的状态值。
    - `GET /api/mood/series?hours=24`：返回 24 小时的点列，事件点之间按半衰期在服务端补算，每 15 分钟一个点；另外返回当前档位、档位开始时间，以及“距下次换档还差多少”（按当前的静摩擦或滑动摩擦余量计算）。
    - 卡片放在总览页统计卡之后，内容：
      - 愉悦度 24 小时曲线：背景按五档上色，当前档位高亮，换档线画成虚线；
      - 兴奋度和精力的数值条加 7 个点的小趋势线；
      - “此刻追加注入的块”：直接取最近一次回复追踪里的 mood / float / affinity 块原文。
    - 30 秒自动刷新。
  - 测试点：旧人设文件没有新维度时缺省为 0；版本保存、上限 50、摘要生成、恢复不落盘；series 的补算与“距换档”计算（用假时钟）。前端只要求 `panel:build` 成功。

- [x] **V14 印象页：拉取群聊历史并建立画像**（2026-10-19，V13 之后做，同一分支；拆成 V14a 后端、V14b 前端两个提交）
  - **用途**：一键从 QQ 拉取某个群过去的聊天记录，存进消息表，再分批跑印象提取，快速建立群标签和群友标签。方便测试，也方便新群冷启动。
  - **只支持群聊**。私聊不拉取，与 §10.4“私聊不提取”保持一致。
  - [x] **适配器**（V14a）：`history(session, count)` 扩展为 `history(session, { count, beforeMessageId? })`，旧调用保持兼容。
    - 群聊时调用 SnowLuma 的 `get_group_msg_history`，参数为 `{ group_id, count, message_id: beforeMessageId ?? 0, reverse_order: true }`。传了 `message_id` 时，返回的是锚点本身及更早的消息，所以要**去掉与锚点相同的那条**。
    - 依据：`reference/SnowLuma/packages/onebot/src/actions/extended.ts` 中 `get_group_msg_history` 的定义。message_id 是有符号 int32，**可能是负数**，不要做非负校验。
  - [x] **拉取任务**（V14a，`src/core/impressions/history-import.ts`）：
    - 输入 `{ sessionId, target }`，`target` ∈ {200, 500, 1000, 2000} 条。每页 50 条，以上一页最早一条的 message_id 为锚点向前翻，两页之间间隔 500ms。满足任一条件即停止：达到 target、一页少于 2 条新消息（说明到头了）、连续 3 页出错。
    - 消息写入：调用 `repository.saveMessage`，按 `(session_id, message_id)` 幂等，已有的记录跳过。**完全不经过流水线**：不回复、不做主动判断、不评估情绪、不计好感，也不写 decisions。
    - 拉取完成后**分批提取**：
      - 把本次新写入的消息和窗口内原有的消息合在一起，按时间升序，每 80 条一个窗口，**从旧到新**依次调用现有的提取逻辑。每个窗口视为一次独立提取，B8 的“一次提取最多加 1 次”照常生效。
      - 窗口之间间隔 1 秒；预算进入 `exceeded` 就停止，已完成的窗口保留结果。
      - 全部完成后，把 `tag_runs` 的 `last_run_at` 设为当前时间，`last_message_time` 设为最新一条消息的时间，避免常规提取再重复处理同一批。
    - 同一个群同一时间只能有一个导入任务；与常规提取共用 §10.4 的“同群单飞”锁。
    - 任务状态放在内存里：`{ id, sessionId, phase: 'fetching' | 'extracting' | 'done' | 'cancelled' | 'error', fetched, inserted, windowsDone, windowsTotal, tagsInserted, tagsObserved, costCny, error? }`。
  - [x] **API**（V14a）：
    - `POST /api/impressions/:sessionId/import`，请求体 `{ target }`：返回任务 id。群未启用时返回 409，任务已在进行时也返回 409。
    - `GET /api/impressions/import/:jobId`：返回任务状态。
    - `POST /api/impressions/import/:jobId/cancel`：取消。当前这页或当前窗口做完后停下，已写入的消息和标签保留。
    - 账号离线时返回 503，附带“小号不在线”。
  - [x] **界面**（V14b）：
    - 印象页选中群后，群选择下拉右侧加一个次按钮“拉取历史”。点开对话框：
      - 选择条数：200 / 500 / 1000 / 2000；
      - 下方显示预计花费，按 `ceil(条数 / 80)` 次提取、每次约 6000 输入 token、用 extract 槽位的单价估算，写成“约 ¥0.0x”；
      - 加一句说明：“只读取记录、整理印象，不会在群里发言。”
    - 开始后对话框显示进度：先显示“正在拉取 已获取 N 条”，再显示“正在整理 第 i / M 段”，最后显示“完成：新增 X 条消息，新增标签 Y 个，确认 Z 次观察，花费 ¥…”。期间可以“取消”，关闭对话框不影响任务继续。完成后自动刷新印象页。
    - 每秒轮询一次任务状态。
  - 测试点（V14a，用假适配器和假模型）：
    - 翻页锚点正确，重复的锚点会被去掉；负数 message_id 能正常使用；
    - 三种停止条件；
    - 幂等写入；
    - 导入期间流水线不被调用（不回复、不写 decisions、不产生情绪或好感事件）；
    - 按 80 条分窗，从旧到新；
    - 预算用尽时中途停止；
    - 取消；
    - `tag_runs` 更新；
    - 并发互斥返回 409；离线返回 503。

- [x] **V15 模型页“用途”表可直接修改**（2026-10-19，用户反馈；V14 之后做，一个提交）
  - **现状**：编辑对话框 `SlotDialog` 其实已经有了，但入口只有“使用的模型”那一格里的 `slot-chain-button`，外观和普通文字一样，用户发现不了；温度、思考强度、最大长度三格是纯文本，不能点。
  - **改为**：
    1. 温度、思考强度、最大长度三格改成**表内直接编辑**，修改的是该用途降级链里**第一项**的参数：
       - 温度：数字输入，范围 0–2，步长 0.1，留空表示“默认”；
       - 思考强度：下拉，选项为 关 / 低 / 中 / 高。该接入的 `reasoningField = 'none'` 时禁用，悬停提示“该接入不支持”；
       - 最大长度：数字输入，正整数，留空表示“默认”。
       - 输入框失焦或按回车后保存，下拉改动后立即保存，都调用 `PATCH /api/slots/:slot`（发送整条链）。成功时这一格短暂显示 ✓；失败时恢复原值，并显示错误。
    2. “使用的模型”那一格：保留现有按钮，但要让它**看起来能点**：在模型链后面加一个铅笔图标和“更换”文字，悬停时显示主色下划线。行尾再加一个“编辑”次按钮，同样打开 `SlotDialog`。
    3. 降级链不止一项时，三个参数格下方用小字注明“第 1 项；其余项在编辑中设置”。
  - 测试：前端不写测试，`panel:build` 成功即可；如果后端没有改动，就不新增测试。

- [x] **V16 从接入拉取模型列表，并按能力显示参数**（2026-10-19，用户需求；V15 之后做；拆成 V16a 后端、V16b 前端两个提交）
  - **说明**：OpenAI 兼容接口的 `GET {baseUrl}/models` 一般**只返回模型 id**，不返回“支持哪些参数”。少数聚合平台（如 OpenRouter）会额外返回 `supported_parameters`。因此参数能力按三级来源确定，**不得凭空编造**某个模型支持什么。
  - [x] **V16a 后端**：
    - `GET /api/providers/:id/models`：仅限 api 接入。用该接入的密钥请求 `{baseUrl}/models`（超时 10 秒），解析 `data[].id`；如果条目里有 `supported_parameters` 数组，一并保留。结果按接入缓存 10 分钟；带 `?refresh=1` 时强制刷新。
      - 返回 `{ models: [{ id, params: { temperature, maxTokens, reasoning } }], fetchedAt }`，其中每个参数的取值为 `'supported' | 'unsupported' | 'unknown'`。
      - 失败（401、超时、格式不对）时返回 `{ models: [], error }`，HTTP 状态仍为 200，由前端提示。CLI 接入返回 `{ models: [], cli: true }`。
      - 这个请求不写 usage 表（不花 token）。**密钥不得出现在错误信息或日志里。**
    - **参数能力三级来源**，按优先级：
      1. 接口返回了 `supported_parameters`：按其映射，`temperature` → temperature，`max_tokens` → maxTokens，`reasoning` 或 `reasoning_effort` → reasoning；没有列出的参数记为 `unsupported`。
      2. 配置里的覆盖：`providers.<id>.modelParams.<modelId>` 写成 `{ temperature?: bool, maxTokens?: bool, reasoning?: bool }`（可选项，schema 要能兼容旧配置）。用户在界面上切换后写回这里。
      3. 都没有时一律为 `unknown`。**不内置任何厂商或模型的能力表。**
    - 测试点：解析普通列表；解析带 `supported_parameters` 的列表；配置覆盖优先于 unknown；缓存与强制刷新；错误信息中没有密钥（用假 fetch 测试）。
  - [x] **V16b 前端**（`SlotDialog` 和 V15 的表内编辑）：
    - 模型名输入改为**可搜索的下拉框**：打开时拉取该接入的模型列表，可以输入关键字过滤；**仍允许手动输入列表里没有的 id**，下拉末尾显示“使用自定义：xxx”。旁边放一个刷新按钮。
      - 拉取失败时，退回普通文本输入，并显示一行错误提示。CLI 接入始终是文本输入。
    - **参数按能力显示**：
      - `supported`：正常可编辑；
      - `unsupported`：置灰，悬停提示“该模型不支持”；
      - `unknown`：可编辑，但字段旁显示小字“未声明，可能被忽略”，并提供一个开关“我确认支持 / 不支持”，选择后写入配置覆盖。
    - V15 的表内编辑同样遵守上面的能力判断，取的是降级链第一项的模型。
    - `panel:build` 成功即可。

- [x] **V17 用途表改版与历史拉取放开**（2026-10-19，用户验收反馈；V16 之后做，同一分支，一个提交）
  1. **用途表恢复成紧凑的一行一项**，V16b 的能力确认 UI 从表格里移走：
     - 每行固定高度约 64px。参数三格只显示**当前值**（如 `0.9`、`默认`、`关`、`800`），格子里**不再重复列名**，不放输入框，也不放说明文字或两个“我确认……”按钮。
     - 值旁边用一个小标记表示能力：`unsupported` 显示灰色删除线和值“—”；`unknown` 在值后面加一个 12px 的圆形“?”标记，悬停提示“未声明，可能被忽略”；`supported` 不加任何标记。
     - **点击参数格**，在格子下方弹出一个小浮层（宽约 240px）：
       - 上方是该参数的输入控件（数字框或下拉）；
       - 下方一行小字“能力：已声明支持 / 未声明 / 不支持”，后面跟一个文字下拉“标记为…”，选项为 支持 / 不支持 / 恢复未声明。修改会写入 `modelParams` 覆盖；
       - 浮层底部是“完成”按钮；按 Esc 或点击外部关闭，关闭时保存。
     - “使用的模型”一格和行尾的“编辑”保持 V15 的样子。
     - 删除表头下方那句“回复建议用 API……点击‘使用的模型’调整降级顺序”的说明，改成列标题旁的 ⓘ 提示。
     - `SlotDialog` 里各参数的能力标记，与浮层用同一个组件。
  2. **未启用的群也可以拉取历史**：
     - `POST /api/impressions/:sessionId/import` 去掉“群未启用返回 409”这条限制，只保留“只支持群聊”和“同群单飞”两条。
     - 拉取历史和分批提取对未启用的群照常执行。标签照常写入，但未启用的群不会回复，所以这些标签在启用之前不会被注入。
     - 常规的自动提取（§10.4 的触发条件）仍然只针对已启用的群，不变。
     - 对话框里未启用时显示一行提示：“这个群还没启用：会整理印象，但它不会在群里说话。”
  - 测试点：去掉 409 之后，未启用的群可以导入，常规提取仍然跳过未启用的群。前端只要求 `panel:build` 成功。

- [x] **V17b 编辑用途对话框改版**（2026-10-19，用户反馈“太丑”；在 dev/persona-v13 上做，一个提交；**严格照着 `doc/design/console-v2/ModelSlotDialogV2.html` 做**）
  - 对话框宽度不超过 640px，背景为页面底色。三段：白底标题栏（用途名 + 一行说明 + 右上角 × 关闭）、主体、白底底栏（取消 / 保存）。删除现在标题栏里那个带边框的“关闭”按钮。
  - **降级链每一项是一张白色卡片**，圆角 12px，内边距 14px：
    - 左列：序号圆点（第 1 项实心主色，其余为浅色），下面是拖动手柄（六点图标）。支持拖动排序；键盘可用的替代方式是“⋯”菜单里的“上移 / 下移”。
    - 右侧第一行：接入下拉（宽 130px）+ 模型可搜索下拉（占满剩余宽度，内含放大镜图标；V16b 的刷新放进下拉列表顶部）+ “⋯”菜单（上移、下移、删除）。删除原来每项底部的“上移 下移 删除”文字按钮。
    - 右侧第二行：三个**参数胶囊**，依次是 `温度 0.9`、`思考 低`、`长度 800`。每个胶囊里是参数名、等宽字体的值、能力标记和一个小下拉箭头：
      - 不支持：值显示删除线“—”；
      - 未声明：值后面加圆形“?”；
      - 支持：不加标记。
    - 点击胶囊，弹出与 V17 用途表**同一个**参数浮层组件。温度在浮层里用“滑块 + 数字框 + ‘使用默认值’勾选”；思考强度用分段按钮“关 / 低 / 中 / 高”；长度用“数字框 + ‘使用默认值’勾选”。浮层底部一行是“能力：…”和“标记为…”。
  - **删除**卡片里所有的参数标题、“能力：…”说明行、“未声明，可能被忽略”文字，以及“我确认支持 / 我确认不支持 / 恢复未声明”按钮。这些信息只在浮层里出现。
  - 卡片下方是“＋ 添加降级项”虚线按钮，再下面一行小字说明（照参照页的文案）。
  - 用途表行内的参数格，点开后也换成同一个浮层组件，保证外观一致。
  - `panel:build` 成功即可。

> **⛔ 停止点 V13**：V17b 完成后停下。（V1–V12 已于 2026-10-19 合并到 main。）
> **【用户】验收**：
> 1. 会话页：窄窗口时上下排列；折叠组的摘要正确；改时段点“完成”后立即生效。
> 2. 印象页：点 ＋ 加标签；点标签弹出证据。
> 3. 用量：切换时间范围；不同接入分行显示。
> 4. 模型页：给某个用途设温度后试聊，决策追踪里能看到参数；在 `.env` 里确认密钥已写入，但界面只显示后四位。
> 5. 导入一份随手写的人设 md，逐项对照后接受；表单与源文件切换后内容一致。

### 12.7 表情包（V18，2026-10-19）
> 分支：V17 合并进 main 后，从 `main` 新建 `dev/stickers`。按 §0.1 执行。拆成 V18a–V18d 四个提交，**V18d 之后为停止点 V18**。
> 参考：`reference/QQ-agent`（MIT）的 `src/sticker-manager.js`、`src/stickers.js`、`src/sender.js`。只借鉴思路，如需复制代码，在文件头注明来源与 MIT 许可。
> SnowLuma 接口依据：`reference/SnowLuma/packages/onebot/src/actions/extended.ts` 中的 `fetch_custom_face_detail`、`add_custom_face`、`modify_custom_face`、`get_image`，以及 `message.ts` 中的 `send_custom_face`。

- [x] **V18a 发送可靠性前置**（来自 QQ-agent 的教训）
  1. **动作超时分档**：适配器调用动作时，发送类（`send_*`、`add_custom_face`、`upload_*`）超时改为 60 秒，其余保持 10 秒。超时错误信息要写明动作名和用时。
  2. **发出消息去重**：同一会话 8 秒内，文本完全相同的消息只发一次，第二次直接跳过并写 debug 日志。窗口可配置，`send.dedupeWindowMs` 默认 8000，0 表示关闭。注意 0 不能被当成“未设置”。
  3. **配置损坏不回落默认值**：确认配置文件解析或校验失败时，保留上一次的有效配置继续运行并报错，**绝不**把默认值写回文件。已经是这样的话，只补一条测试。
  4. **日志大小上限**：`data/logs` 下单个文件超过 50MB 就停止写入，并在末尾留一行“已达上限”；第二天新文件照常写。
  5. **“最大长度”改名**：界面上所有的“长度 / 最大长度”统一改成“最大输出”，值后面加单位 `token`，比如 `800 token`。参数浮层里加一行说明：`单位 token，中文约 0.6 token/字；设太小会截断回复。开启思考时，部分模型会把思考内容也计入这个上限。` 只改前端文案。
  - 测试点：超时分档；去重窗口（含 0）；配置损坏不覆写；日志上限。第 5 条只要求 `panel:build` 成功。

- [x] **V18b 表情库与收藏**
  - **来源只有 QQ 收藏表情**：小号在 QQ 里收藏的表情就是表情库，这是唯一的来源。控制台上传和“回复收藏”也都会先调用 `add_custom_face` 存进 QQ 收藏，再同步回来。
  - **数据表**（迁移 v8）：`stickers(id, account, emoji_id, md5, file TEXT NULL, desc_qq, desc_ai, tags_json, enabled, missing, use_count, last_used_at, created_at, updated_at, description_attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(account, md5))`。
    - `file` 存的是**相对 `data/stickers/` 的文件名**，例如 `<md5>.gif`，**不存绝对路径**；读取时再拼上数据目录。
    - `description_attempts` 持久化描述重试次数，最多 3 次。
  - **同步**：账号上线时同步一次，之后每 10 分钟一次，控制台也可以手动触发。
    - 调用 `fetch_custom_face_detail { count: 300 }`，遇到新的 md5 就新建一行，并立即把图片下载到 `data/stickers/`。下载复用现有图片下载的域名白名单和大小限制，扩展名按文件头判断。
    - QQ 收藏里已经没有的记录，标记 `missing=1`，不删除。
    - 下载失败的条目保留，`file` 为 NULL，下次同步再试。
  - **描述**：新表情下载成功后，用 `vision` 槽位调用一次新模板 `prompts/sticker-describe.md`。要求模型只输出 JSON：`{"desc": "不超过20字，写情绪和适合的场合", "tags": ["2-4字", …最多5个]}`。解析失败就留空，下次同步时重试，每条最多试 3 次。预算 `exceeded` 时跳过。
  - **回复收藏**：主人在群里或私聊里**回复一张图片**，消息正文去掉空白后恰好是“收藏”或“收藏这个”时，就把被回复消息中的第一张图交给 `add_custom_face`，然后立即同步，并回一句“收好了”。失败时回“没收藏上：{原因}”。
    - 这条消息由管理指令那一层处理，**不进入回复流水线**；非主人发送时完全忽略。
    - 被回复消息里的图片地址，从本地 messages 表的 segments 里取；如果已经过期，就用 `get_image` 重新获取。
  - **API**：
    - `GET /api/stickers`：列表，带图片地址 `/api/stickers/:id/image`，由服务端从 `data/stickers/` 读取文件，并做路径越界检查；
    - `PATCH /api/stickers/:id`：可改 `{ enabled?, tags?, descAi? }`。改了描述时，同时调用 `modify_custom_face` 把描述写回 QQ；
    - `POST /api/stickers/sync`：手动同步；
    - `POST /api/stickers/upload`：请求体 `{ dataBase64, filename }`，大小不超过 5MB，调用 `add_custom_face`（以 `base64://` 传入）后再同步。
    - 多账号上传通过 `?account=` 指定目标；未指定时返回 409。
  - 测试点（用假适配器）：同步时新增、标记缺失、按 md5 去重；只存相对路径；描述的解析与重试上限；“回复收藏”只认主人、只认这两个词；上传；图片接口拒绝越界路径。

- [x] **V18c 发送表情**
  - **配置**：顶层可选项 `stickers: { enabled: false, maxRatio: 0.3, onlyStickerRatio: 0.1, cooldownSec: 300, candidates: 8 }`，默认关闭。
    - 频控读取同会话 `decisions` 历史；迁移 v9 为此新增 `idx_decisions_session_time`。
  - **壳子决定是否给机会**：满足以下全部条件，才在提示词里放候选表情：
    - 本会话距上次发表情不少于 `cooldownSec`；
    - 本会话过去 2 小时内，bot 的回复里带表情的比例低于 `maxRatio`；
    - 表情库里至少有 3 个满足 `enabled=1`、`missing=0`、`file` 不为空的表情。
  - **候选挑选**（纯函数，不调用模型）：给每个可用表情打分，取分数最高的 `candidates` 个。分数由三部分相加：
    - 触发消息文本与表情 `desc_ai` 加 `tags` 的**字符二元组重合数**；
    - 当前心情档位对应的词（low 低落/难过，annoyed 无语/生气，happy 开心/好耶，excited 激动/兴奋，calm 不加）命中 tags 时加 2；
    - 本会话 30 分钟内用过的减 3；
    - 同分时按 `id` 的稳定随机顺序排列（以“会话 id + 当前小时”为种子）。
  - **提示词**：新块 `stickers`，放在 `float` **之后**、最末尾。模板在 `prompts/reply-system.md` 的新键 `stickers` 里：
    `可以发表情包（不发也完全可以）。想发时在回复最后单独一行写 [表情:编号]，最多一个：{{list}}`，其中 `list` 格式为 `1 摊手无奈 / 2 狗头 / …`，用的是 `desc_ai`。
  - **解析与发送**（deliver 步骤）：
    - 先把回复中**所有**表情标记剥掉，支持 ASCII/全角冒号及 `[]`/`【】` 两种括号；非法的也剥，绝不能原样发进群里；
    - 合法编号只取第一个。正文的各条发完之后，再调用 `send_custom_face { emoji_id }` 发送表情；失败时回退为图片段 `{ type: 'image', data: { file: 'base64://…', sub_type: 1, summary: '[动画表情]' } }`，用的是本地文件；再失败就只写日志，不重试；
    - 成功后 `use_count + 1`，并更新 `last_used_at`。
  - **只发表情**：剥掉标记后正文为空，并且有合法表情时，只发这个表情；但本会话过去 2 小时内“只发表情”的比例必须低于 `onlyStickerRatio`，否则这次回复整条丢弃，记 `reason='sticker_only_capped'`。
  - **追踪**：决策 detail 中记录 `stickerOffered`（候选 id 列表，没给机会时为 null）和 `stickerSent`（id 或 null）。
  - 测试点：没给机会时不注入 stickers 块；挑选打分与稳定排序；标记全部被剥掉（包括非法标记）；发送回退；只发表情的上限；比例与冷却。

- [x] **V18d 控制台“表情包”页**（侧栏“塑造”分组，位于人设之下）
  - 顶部：最近同步时间、“同步 QQ 收藏”和“上传”两个按钮，以及设置卡（开关、比例、只发表情比例、冷却、候选数），写入顶层 `stickers` 配置，与 `/api/defaults` 一样校验并热重载。
  - 主体：图片网格，每张卡片 120px，显示图片、`desc_ai`（可就地编辑）、标签（可点 × 删除，圆形 ＋ 新增）、使用次数和启用开关。已从 QQ 收藏移除的卡片用半透明显示，并标注“已从 QQ 收藏移除”。
  - 可按“全部 / 已启用 / 未描述 / 已移除”筛选。
  - 视觉遵守 `doc/design/console-v2` 的样式；`panel:build` 成功。

- [x] **V18e 看图识字**
  - `prompts/vision.md` 只输出 JSON：`{ kind, desc, text }`；`kind` 为 `sticker|photo|screenshot|other`，`desc` ≤30 字，`text` ≤200 字。
  - 图上有字时必须逐字转写，保留原文，不翻译、不概括；无文字时 `text` 为空。
  - 表情包与截图按类别渲染描述和转写；空 `text` 省略后半部分。JSON 解析失败时将原始响应作为 `desc`，保持旧行为兼容。
  - 图片缓存 key 包含 vision 模板版本；OneBot image `sub_type=1` 强制分类为 `sticker`。
  - 测试：JSON 解析与渲染、空文字、缓存随模板版本失效、QQ 表情子类型。

- [x] **V18f 图片认知缓存池与 GIF 关键帧**（2026-10-20，在 dev/stickers 上，一个提交）
  1. **按顺序查找图片含义**，命中即停：
     ① 商城表情：segment 带 `emoji_id`，直接用 `summary` 作为含义，不调用模型；
     ② 图片 md5 命中 stickers 表：依次取 手动编辑过的描述 → `desc_ai` → `desc_qq`；
     ③ md5 命中 image_captions 缓存；
     ④ 以上都没命中，才调用 vision 详细转写，输出 JSON：kind、desc（≤60 字）、text（逐字转写，≤200 字）、`legible: boolean`。模板里要写明“看不清的字不要猜，宁可留空”。结果写入缓存。
  2. **缓存 key 统一用图片 md5**：优先从 segment 的 `file`（形如 `<md5>.xxx`）中取，取不到就下载后自己计算。自动转写的缓存另外记录 vision 槽位第一项的模型名和模板版本，任一变化就重新转写。stickers 里手动编辑过的描述永远优先。
  3. **GIF 关键帧按变化量挑选**：
     - 每帧缩成 32×32 灰度，计算相邻帧的平均绝对差，再求前缀和；在累计变化量的 0、⅓、⅔ 和末尾处各取一帧，去掉重复的；
     - 总变化量很小（每帧平均差 < 2/255）时，只取第 1 帧；
     - 选出的帧**保持原分辨率**，排成 2×2 方格拼接后再转写；
     - **降级**：`legible=false`，或 kind 为 sticker 但 text 为空时，改为把各帧作为独立图片一起发送，再转写一次；仍然看不清，就把 text 记为空，desc 注明“文字看不清”，照常缓存，不再重试。
  4. **“回复收藏”遇到重复收藏**（`add_custom_face` 报重复，或 md5 已在 stickers 表中）时，回“这个已经收藏过啦”。
  - 测试点：四级查找顺序；md5 的提取与计算；缓存失效（换模型或模板）；静态、匀速、突变三种 GIF 的选帧；`legible` 降级路径；重复收藏的提示。

> **⛔ 停止点 V18**：V18f 完成后停下。（2026-10-20 夜间运行时，按 §15 不停，直接继续 §13。）
> **【用户】验收**：用手机在小号收藏 3 张以上表情 → 控制台“同步 QQ 收藏”后能看到图片和描述 → 在群里回复一张图说“收藏”，它回“收好了”，表情包页多了这张 → 打开 `stickers.enabled` 聊一会，偶尔会跟一个表情，并且发出来的是 QQ 原生表情的样式。

---

## 13. M3-A：私聊记忆与私密信息分级（2026-10-19 编写）

> 前置：§12.7 V18 合并进 main 后，从 `main` 新建 `dev/privacy`。按 §0.1 执行；无人值守时按 §7（§7.1 范围 = 本节 P1–P7）。
> 设计依据：DESIGN §6.3（L0/L1/L2），`RESEARCH-refs.md` §1。
> **核心原则**：宁可不说，也不说错；生成回复的模型**永远看不到**别的会话的 L0 信息；所有跨会话的使用都经过同一个策略函数。
> **本节不做**：联网搜索（M3-B）、多眷属之间共享信息（永远不做）、群聊信息的分级（群里说过的话视为在该群内公开）。

### 13.1 数据（P1）
- 迁移新版本，新增表 `private_facts`：

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `account` | 角色键 |
| `owner_id` | 信息的主人，即私聊对象的 QQ 号 |
| `session_id` | 来源私聊会话 |
| `text` | 不超过 40 字，第三人称陈述，如“最近在准备考研，压力大” |
| `keywords_json` | 2–5 个话题关键词，用于预筛 |
| `level` | `L0` / `L1` / `L2` |
| `level_source` | `auto` / `manual` |
| `mentions` | 主人在群里提及的次数 |
| `mention_evidence_json` | 最近 5 条：`{sessionId, messageId, time}` |
| `evidence_json` | 来源私聊消息，最多 5 条：`{messageId, time, quote}`，quote 不超过 40 字 |
| `status` | `active` / `deleted` |
| `created_at`、`updated_at` | 时间 |

- 新表 `privacy_runs (account, session_id, last_run_at, last_message_time)`，作用与 `tag_runs` 相同。
- 配置新增顶层可选项 `privacy: { enabled: true, promoteMentions: 3, avoidMinutes: 10 }`。

### 13.2 策略函数（P1，`src/core/privacy/policy.ts`，纯函数）
`decide({ info, target, purpose })`，返回 `'allow' | 'gate_only' | 'deny'`。
- `info`：`{ origin: 'private' | 'group', sessionId, ownerId, level? }`；
- `target`：`{ kind: 'private' | 'group', sessionId, peerId? }`；
- `purpose`：`'prompt' | 'gate' | 'third_party'`，其中 `third_party` 指任何发往外部服务的请求，比如以后的搜索。

规则**按顺序**匹配，命中即返回：
1. `info.sessionId === target.sessionId`：`purpose = 'third_party'` 时返回 `deny`，其余返回 `allow`。
2. `origin = 'private'`、`target.kind = 'group'`：
   - `purpose = 'gate'` → `gate_only`；
   - `purpose = 'prompt'`：L0 → `deny`；L1 → `allow`，但调用方必须满足“只在话题已经被聊到时注入”；L2 → `allow`；
   - `purpose = 'third_party'` → `deny`。
3. `origin = 'private'`、`target.kind = 'private'`，但不是同一会话（即 A 的私聊信息用到和 B 的私聊里）→ `deny`。
4. `origin = 'group'`、`target.kind = 'private'`：
   - `info.ownerId === target.peerId`（这条群里得来的标签就是关于这位私聊对象本人的）且 `purpose = 'prompt'` → `allow`；
   - 其余 → `deny`。
5. 其他情况一律 `deny`。

- 全项目凡是“把一个会话的信息用到另一个会话”的地方，都**必须**调用这个函数，不得自己判断。现有的群标签和群友标签注入，也改为先调用它；结果应与现在完全一致（同一个群内允许），现有测试不改就能通过。
- 测试：对每条规则、每种 `purpose` 做穷举表测试；`info` 或 `target` 缺字段时，返回 `deny`。

### 13.3 私聊记忆的提取（P2）
- **触发**：每次持久化一条私聊里**对方**发来的消息后检查。满足以下任一条件就异步提取一次，同一会话同一时间只允许一个提取：
  - 新消息数 ≥ 20 且距上次提取 ≥ 30 分钟；
  - 新消息数 ≥ 5 且距上次提取 ≥ 6 小时。
- 用 `extract` 槽位和新模板 `prompts/extract-private.md`。输入：该私聊最近 60 条消息，加上这个人现有的 `active` 条目（附 id）。
- 输出 JSON：`{ "new": [{ "text", "keywords": [], "messageId" }], "update": [{ "id", "text", "keywords", "messageId" }], "obsolete": [{ "id" }] }`。
- 模板要求：
  - 只记**对方本人**的近况、计划、烦恼、喜好和经历，不记别人的事，也不记 bot 自己说的话；
  - **不记**：身份证号、银行卡号、密码、住址门牌、病名诊断、性相关的内容，以及具体的收入数字；
  - 同一件事优先用 `update` 更新，不要换个说法再新增一条。
- 校验：`text` 长 4–40 字；`keywords` 2–5 个，每个 2–8 字；`messageId` 必须在本次窗口内，并且是对方发的消息；`update` 和 `obsolete` 的 id 必须属于这个人。不合格的条目单独丢弃。`obsolete` 把状态改为 `deleted`。新条目一律为 `L0`、`auto`。
- 预算 `exceeded` 时跳过。解析失败时 `privacy_runs` 照常更新。

### 13.4 私聊里怎么用（P3）
- 在私聊中回复时，新增提示词块 `privateFacts`，位于 `memberTags` 的位置（私聊没有 memberTags），内容取该私聊对象的 `active` 条目，**不分等级**（同一会话内一律允许）。
- 排序：`updated_at` 倒序；最多 6 条，总长不超过 200 字。
- 模板键 `prompts/reply-system.md` 的 `privateFacts`：`你和{{name}}私聊时了解到：{{facts}}（自然地记得就好，不要逐条复述）`。
- 群里得来的这个人自己的标签，按策略规则 4，在私聊中也注入到同一个块里，放在私聊条目之后，用分号隔开。

### 13.5 群里的守门（P4）
- **预筛**：群里每次要生成回复之前（被叫和主动两种情况都算），取该群最近 8 条消息的文本，与“本群出现过的群友”的 `active` 条目的 keywords 做匹配。“出现过”指 messages 表里在该群发过言。某条的 keywords 中有任意 1 个出现在这 8 条里，就算命中。没有命中就直接放行，不花钱。
- **判断**：有命中时，用 `judge` 槽位和新模板 `prompts/privacy-gate.md` 调用一次。输入是这 8 条消息，以及**命中条目的 id 和 text**（这是 `gate` 用途，策略返回 `gate_only`，允许）。输出 JSON `{"touches": [id, …]}`，即正在被聊到的条目 id。
  - 解析失败或调用失败，一律当作命中所有预筛条目处理（宁可不说）。
- **按等级处理被聊到的条目**：
  - 有 L0：
    - **未被叫**：不回复，`reason='privacy_avoid'`，并让该会话进入 `avoidMinutes` 分钟的回避期，期间所有主动发言都跳过，同样记这个原因；
    - **被叫**：照常回复，但提示词追加一句固定的规则：`群里正在聊的话题可能涉及别人的私事。你对此一无所知，不追问、不展开、不猜测。`。**不注入任何条目内容**。
  - 只有 L1 或 L2：把这些条目放进新提示词块 `knownFacts`，位置在 `memberTags` 之后：`你私下知道：{{facts}}（对方已经在群里提过；别人问起才接，不要主动透露细节）`。
  - **未被聊到的 L2 条目**：只在主人本人就是触发消息的发送者时，才放进 `knownFacts`，作用和群友标签一样，最多 3 条。
- **出口检查**（双保险）：群里发送前，把要发出的文本与本群群友的 L0 条目逐条比对，某条有 ≥ 2 个 keywords 出现在文本里，就整条丢弃，`reason='privacy_egress'`，并写一条警告日志（只记条目 id）。
- **追踪与日志**：决策 detail 和调试追踪里只记录条目 **id** 和等级，**不记录 text**。
- 测试点：没命中时不调用 judge；命中但 judge 判定未聊到时放行；L0 未被叫时回避并进入回避期，被叫时追加规则且提示词里没有条目内容（断言 prompt 不包含 text）；L1/L2 注入；judge 失败时按命中处理；出口检查。

### 13.6 升级：主人自己在群里提起（P5）
- 每条群消息持久化后：如果发送者是某些 `active` 条目的主人，就用这条消息做关键词预筛（至少命中 1 个 keyword）。命中后，用 `judge` 槽位和新模板 `prompts/privacy-mention.md` 判断：“这条消息里，他是不是在讲这件事？”输出 `{"mentions": [id, …]}`。
- 每被确认一次，`mentions + 1`，并记录证据。同一条目、同一自然日最多计 1 次。**只有主人本人的消息才计数**，别人提起一律不变。
- 等级由 `mentions` 自动推出：0 为 L0，1 到 `promoteMentions − 1` 为 L1，达到 `promoteMentions` 为 L2。`level_source = 'manual'` 的条目不自动改。
- 判断偏保守：解析失败时视为没有提及。

### 13.7 控制台（P6）
- 印象页新增分段“私聊”（与“群聊 / 所有人”并列）。
  - 左侧是好友列表；右侧是选中好友的条目列表，每条显示：text、等级徽标（L0 灰色锁形图标“仅私聊”、L1“提过一次”、L2“可聊”）、提及次数、来源证据（可展开）。
  - 操作：手动设置等级（之后标为 manual，可以“恢复自动”）、改字、删除。
  - 页面顶部固定一行说明：“这些内容只有你能看到；眷属在群里不会主动提起 L0。”
- API：`GET /api/privacy/:userId`、`PATCH /api/privacy/facts/:id`（`{ text?, level?, auto? }`）、`DELETE /api/privacy/facts/:id`（软删除）。鉴权与现有接口相同。
- `panel:build` 成功。

### 13.8 任务
- [x] **P1** 数据表、配置、策略函数（§13.1、§13.2），以及现有标签注入改为经过策略函数
- [x] **P2** 私聊提取（§13.3）
- [x] **P3** 私聊注入（§13.4）
- [x] **P4** 群里守门与出口检查（§13.5）
- [x] **P5** 提及升级（§13.6）
- [ ] **P6** 控制台（§13.7）
- [ ] **P7** 文档：HANDOFF 补充隐私数据流（≤15 行），并在 DESIGN §6.3 末尾加一行“已在 PLAN §13 实现”
- [ ] **🔍 R7 阶段审查**：重点检查有没有任何路径把 L0 的 text 送进群聊生成的提示词、调试追踪或日志（逐个调用点核对）。

> **⛔ 停止点 P**：R7 完成后停下。
> **【用户】验收**：
> 1. 和小号私聊几句近况（比如“最近在准备考研，压力好大”），聊满后等提取；印象 → 私聊里出现这一条，等级为 L0。
> 2. 换个话题再私聊，它会自然记得这件事。
> 3. 在群里让别人提“考研”：它不接话；@ 它，它会装作不知道。
> 4. 你自己在群里说一句“我最近在备考”：这条变成 L1；之后别人聊到，它能接话但不主动透露。

---

## 14. M3-B：群友画像规范化（2026-10-19 编写）

> 前置：§13 合并进 main 后，从 `main` 新建 `dev/profiles`。按 §0.1 执行。
> **视觉参照**：`doc/design/console-v2/ImpressionsV3.html`（群友画像卡）。
> **定位**：印象既是给眷属的提示词，也是**给主人了解朋友的册子**。所以有些内容只给主人看，不进提示词（统计、锁定标签、一句话印象）。
> **不做**：群友的连续性格数值；推断荣格八维；任何“推测”标签自动进提示词。

### 14.1 分类体系（Q1）
- **第一级固定**，模型只能从下面的 key 中选：

| key | 中文 | 半衰期 | 说明 |
|---|---|---|---|
| `identity` | 自我认同 | 180 天 | MBTI、荣格八维，**只记自述** |
| `personality` | 性格 | 30 天 | 幽默、嘴硬心软…… |
| `fandom` | 成分 | 30 天 | 有第二级，如 游戏 › 守望先锋 |
| `speech` | 说话风格 | 30 天 | 爱发图、爱用省略号 |
| `social` | 社交方式 | 30 天 | 爱拉人开黑、爱调侃人 |
| `recent` | 近况 | **3 天** | 考试周、在找工作 |
| `dislike` | 雷点 | 60 天 | 不喜欢被叫外号 |
| `schedule` | 作息 | 不衰减，由统计重算 | 只由 §14.4 自动生成，或主人手动添加 |
| `atmosphere` | 群的氛围 | 14 天 | 只用于群标签（`user_id` 为空） |

- **迁移**：`tags` 表新增以下列，旧数据的默认值写在括号里：
  - `category TEXT NOT NULL`（默认 `'misc'`，界面上显示为“其他”）；
  - `subject TEXT NULL`：第二级，只有 `fandom` 使用，如“游戏”，此时 text 为“守望先锋”；
  - `polarity TEXT NULL`：`'like' | 'dislike'`，只有 `fandom` 使用；
  - `origin TEXT NOT NULL DEFAULT 'inferred'`：取值 `'self_report' | 'inferred' | 'stats' | 'manual'`；
  - `locked INTEGER NOT NULL DEFAULT 0`。
  - 现有的 `source` 列保留。
- **第二级归一**：新表 `tag_subjects(id, account, category, name, aliases_json)`。写入 `subject` 时，先规范化（去掉空白和标点、转小写），再和 name 与 aliases 比对，命中就改用 canonical name。控制台可以维护别名，比如“CS2”的别名有 CSGO、反恐精英、cs。
- 激活度的半衰期改为按 category 取值（见上表）；samples ≥ 4 时乘 3 的规则不变。

### 14.2 提取规则更新（Q2）
- `prompts/extract-tags.md` 的输出项增加字段：`category`（必填，只能是上表中的 key）、`subject`、`polarity`、`origin`（`self_report` 或 `inferred`）、`sensitive`（布尔值）。
- 提供给模型的输入里，加上现有的 `tag_subjects` 列表，要求优先复用。
- 模板规则：
  - `identity` 只能记本人**亲口**说出的 MBTI 或荣格功能，`origin` 必须是 `self_report`；
  - 关于自卑、焦虑、孤独、脆弱这类心理状态的性格标签，`sensitive` 设为 true；
  - 原有的“不记”清单（健康、性、政治立场等）保持不变。
  - 消息文本含 `@url:` 的外链分享格式，只显示为“分享了外链卡片”；卡片文案与 URL 不进模型上下文，该消息不能作为标签证据。
- **代码校验**：
  - `category` 不在白名单内的，整条丢弃；
  - `identity` 的 text 必须匹配 `^[IE][NS][TF][JP]$`，或匹配荣格功能 `^(Ni|Ne|Si|Se|Ti|Te|Fi|Fe)( 主导| 辅助)?$`；`self_report` 的证据消息必须由本人发出，并且正文中包含这个字符串（不区分大小写），否则改记为 `inferred`；
  - `inferred` 的 `identity` 标签**永远停在 candidate**，不会自动转正；
  - `sensitive = true` 的标签写入时 `locked = 1`。
- 同一人**允许有多个** `identity` 标签，比如 INTJ 和 INFJ 并存，各自累计 samples。

### 14.3 旧标签整理（Q3）
- 迁移完成后的第一次启动时，以及控制台点击“整理旧标签”时，后台用 `extract` 槽位、每 50 条一批，为 `category = 'misc'` 的标签补上 `category`、`subject` 和 `polarity`。模板为 `prompts/classify-tags.md`。
- 意思相同、只是说法不同的标签（`norm` 不同但含义相同），由模型给出 `mergeInto: id`；代码把被合并标签的 samples 和 evidence 并入目标标签，再把它标为 `superseded`。
- 预算 `exceeded` 时停止，下次继续；完成后写一个标记，不再自动运行。

### 14.4 出没统计与自动作息标签（Q4，纯本地，不调用模型）
- API `GET /api/activity?sessionId=&userId=&view=hour|week|month|year`。不传 `userId` 时统计整个群。所有统计都基于 messages 表，按本地时区计算。
  - `hour`：近 90 天，24 个**占比**（总和为 1）；
  - `week`：近 90 天，按星期一到星期日的 7 个占比；
  - `month`：近 30 天，每天的发言条数；
  - `year`：近 365 天，每天的发言条数。
  - 同时返回 `{ total, avgChars, imageRatio }`（近 90 天）。
- **自动作息标签**：每天 04:00 计算一次，启动时也补算一次。只对近 90 天发言 ≥ 50 条的群友计算。阈值写在配置 `profile.schedule` 里，有默认值：
  - 23:00–02:59 的发言占比 ≥ 0.4 → “夜猫子”；
  - 周末日均发言 ≥ 工作日日均的 1.5 倍 → “周末更活跃”；
  - 06:00–09:59 的发言占比 ≤ 0.03，且总条数 ≥ 100 → “早上不在线”。
  - 这些标签的 `origin` 为 `stats`、`category` 为 `schedule`。连续 2 天满足条件就转为 confirmed；连续 3 天不满足就删除（只删 `origin = 'stats'` 的，主人手动加的不动）。evidence 里存的是统计快照，不是消息。
- **群级建议**：群视图里，找出占比最高的连续 3 小时窗口。如果它的占比 ≥ 0.35，并且该会话的 `modeSchedule` 没有在这个窗口内设置 `active`，就显示建议条：“这个群 {from}–{to} 最热闹，要在这段设成积极吗？”，点击后追加一条时间表并保存。同一个建议被关掉后，30 天内不再出现。

### 14.5 注入格式（Q5）
- `memberTags` 块改为每人一行：`关于"{name}"：{分组}`。分组按以下顺序拼接，各组之间用 `；` 分隔，组内用 `、` 分隔：
  1. 雷点，写成“雷点：…”，**总是排在最前**；
  2. 性格；
  3. 成分：按 subject 合并，写成 `游戏（守望先锋/CS2，不喜欢原神）`；
  4. 自我认同：只用 confirmed 的 `self_report`。只有一个时写“自称 INTJ”；有多个时写“自称在 INTJ/INFJ 间摇摆”。主人手动确认过的 `inferred` 写成“（推测，仅供参考，别据此下结论）INTP”；
  5. 近况；
  6. 作息；
  7. 说话风格、社交方式。
- **永不注入**：`locked = 1` 的标签、未确认的 `inferred identity`、`misc` 类。
- 长度上限从 80 字提高到 160 字，超出时从末尾的组开始截掉，记入 `droppedTags`。

### 14.6 一句话印象（Q6）
- 新表 `member_summaries(account, user_id, text, manual, updated_at)`。某人已确认的标签自上次生成以来变化了 ≥ 3 条时，异步用 `extract` 槽位生成一句不超过 50 字的描述（模板为 `prompts/member-summary.md`）。生成时只能使用**未锁定**的标签。`manual = 1` 的不自动覆盖。
- **只在控制台显示，不进提示词。**

### 14.7 控制台（Q7，照 `ImpressionsV3.html` 做）
- 左栏：群的氛围 + 群友列表，每人下面一行最主要的标签，右侧是好感度档位。
- 右侧画像卡，从上到下：
  1. 头部：头像、名字、QQ 号、好感度徽标、一句话印象（可改写）；
  2. “作息与出没”：分段切换“时段 / 周 / 月 / 年”：
     - 时段：24 格横条；周：7 格；月、年：签到式日历格；
     - 颜色按占比或条数**相对本人最大值**分 5 档，色板为 `#EFF4F2 #C9E0DA #8FC2B6 #4E9688 #1C5F5A`；
     - 底部是作息标签行，自动生成的标签带“自动”字样。
  3. 按大类分行的标签：自我认同（顶部显示合成的 MBTI，比如 `IN?J`，每一位只要不一致就写 `?`，悬停显示各自次数）、性格、成分（显示为 `游戏 › 守望先锋`）、说话风格、社交方式、近况（显示“N 天后淡出”）、雷点、其他（misc）。
     - 锁定的标签带锁图标，点击可以解锁或加锁；推测的 identity 标签显示“推测 · 未注入”。
     - 每行末尾是圆形 ＋，点击后就地新增，`origin = 'manual'`，可以选 subject 和极性。
  4. 可展开的“它眼里的这个人”：与 §14.5 完全一致的注入文本，由后端用同一个函数渲染。
- 群视图里，在群的氛围下方显示群级的“时段”横条和 §14.4 的建议条。
- 别名维护：在“成分”行末尾的 ⋯ 菜单里，打开“别名管理”对话框。
- `panel:build` 成功。

### 14.8 任务
- [ ] **Q1** 迁移、分类常量、`tag_subjects` 与归一（§14.1）
- [ ] **Q2** 提取更新与校验（§14.2）
- [ ] **Q3** 旧标签整理（§14.3）
- [ ] **Q4** 出没统计、自动作息标签与群级建议（§14.4）
- [ ] **Q5** 注入格式（§14.5）
- [ ] **Q6** 一句话印象（§14.6）
- [ ] **Q7** 控制台（§14.7）
- [ ] **🔍 R8 阶段审查**：重点查锁定标签和推测 identity 有没有任何路径进入提示词；统计的时区与边界。
- 测试点：每个规则 1–2 条；注入渲染用快照测试，覆盖“摇摆”、成分合并、雷点置顶、截断；统计接口的占比之和为 1；作息标签的转正与删除时序（用假时钟）。

> **⛔ 停止点 Q**：R8 完成后停下。
> **【用户】验收**：点“整理旧标签”后，现有标签按大类归好，重复的被合并；画像卡的热力图能切换四种视图，“夜猫子”这类自动标签出现；在群里说“我是 INTJ”，等提取后自我认同里出现“INTJ 自述”；把某个性格标签加锁后，“它眼里的这个人”里就不再出现它。

---

## 15. 夜间任务包（2026-10-20 夜）

> 用户在睡觉，按 §7 无人值守规则执行。**§7.1 本次范围 = 下面两步，按顺序做。**
1. 在 `dev/stickers` 上做 **V18f**（§12.7），一个提交。
2. 从 `dev/stickers`（**不是 main**：V18 还没有合并，这样 §13 能拿到表情包和看图的最新代码）新建 `dev/privacy`，按 §13 做 **P1 → P7**，每项一个提交，最后做 **R7 阶段审查**。
- §13 前置条件里的“从 main 新建”，本次改为“从 dev/stickers 新建”，其余规则不变。
- 早上检查清单写在 `doc/plans/MORNING-2026-10-20.md`，结构同 §7.4。进度日志要记录每项的开始和结束时间。
- 结束条件：R7 完成；或满足 §7.6 的任一条（运行时间上限为 10 小时）。
- 禁止：npm start、真实模型或 QQ 请求、连接 SnowLuma、修改 reference/、在 main 上提交、合并任何分支。
