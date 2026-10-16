# Aquarium 施工计划书（唯一任务清单）

> 写给接手编码的模型。最后更新：2026-10-16。**当前任务：§10 M2-B；所有任务先遵守 §0.1 提速规则。**
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

1. **不做**精确 staged review、SHA-256 记录、checkpoint tag、reviewer 子代理复审。每个任务提交前自己看一遍 `git diff`，就够了。只有任务标 🔍 时才做一轮独立 review（最多一轮）。
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

## 4. 控制台视觉规范（T10 必须遵守）

> 设计稿是用户私有的 claude.ai 画布，接手模型可能打不开；**以本节文字为准**。

### 4.1 设计原则
- 风格名：“深水观察室”。安静、克制、适合长时间查看。**不用渐变、发光、毛玻璃、emoji**。
- 品牌标志：一条线描小鱼（SVG，见 4.4），每个 bot 账号用它表示。文案里可用“鱼缸”“游动中”等说法，界面本身保持素净。
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

### 7.1 范围（当前有效：§10 M2-B）
- **本次夜间运行的唯一范围是 §10 的 B1–B7**，按顺序执行；§8 N0–N5 已完成，不再执行。阶段 D 的 §7.1 旧范围已于 2026-10-15 完成，**不再执行、不再收尾**。
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
- 开始前：切换到分支 `dev/host`。所有提交都在这个分支上，**每个任务一个提交**。
- 新建并维护 `doc/plans/MORNING-2026-10-14.md`，结构固定为：
  ```
  # 早上检查清单（2026-10-14）
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
- 本次 §7.1 列出的阶段 D 夜间范围全部完成；
- 剩余任务全部被跳过或失败；
- 运行时间达到 9 小时。

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
7. **硬上限**：同一会话两次主动回复间隔不得少于 120 秒，否则 `reason='proactive_cooldown'`。原有频率限制仍然生效。
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
- [ ] **B1 提示词分块**（§10.2）
- [ ] **B2 数据库迁移 v4**（§10.5）
- [ ] **B3 情绪核心**（纯函数）：衰减、上限截断、`nextBand` 防抖。测试点：衰减数值；同一发送者每小时上限；静摩擦余量；5 分钟内的滑动摩擦；decay 换档受 10 分钟停留限制而 event 不受；一次跨多档。
- [ ] **B4 情绪接入**：评估调用与解析、被叫规则、`affect.md` 模板、mood 与 float 块接入生成、追踪。测试点：用假模型走完“回复 → 评估 → 换档 → 下一次提示词带新块”；90 秒间隔；解析失败不改状态；`enabled: false` 时完全不生效。
- [ ] **B5 标签核心**（纯函数）：观察、独立性、转正、新增判重（rejected 和 superseded 不复活）、推翻（manual 不可推翻）、激活度、注入选择与上限。测试点：上面每条规则 1–2 条用例。
- [ ] **B6 标签提取与注入**：触发条件、同群单飞、`tag_runs`、`extract-tags.md`、逐条校验、注入到 groupTags 与 memberTags 块、私聊不注入。测试点：假模型下的完整提取；两种触发条件；非法条目被丢弃且其余条目照常生效；解析失败时 `tag_runs` 仍然更新。
- [ ] **B7 控制台**（§10.6）。后端 API 要写测试，前端不写。

> **⛔ 停止点 M2-B**：B7 完成后停下。
> **【用户】验收**：
> 1. 在测试群聊天，让 bot 回几次；总览页的心情卡片里出现评估事件。故意气它一下，看档位是否切换，以及回复语气是否随之变化。
> 2. 群里聊满 60 条且等待 30 分钟后，“印象”页出现候选标签。确认或否决几条；`@` bot 时，决策追踪的 `promptBlocks` 里能看到 groupTags 与 memberTags。
> 3. 当天花费仍在预算内。
