# Aquarium 实施计划与交接文档（M1）

> 写给接手编码的模型。**先完整读完本文，再读 `DESIGN.md`（设计依据）**。
> 本文与 `DESIGN.md` 冲突时，**以本文为准**，并在完成任务后提醒用户同步修正 `DESIGN.md`。
> 本文只把 **M1** 写到可执行粒度；M2 及以后在 M1 完成后另写计划，**不要提前实现**。
> 最后更新：2026-10-12。

---

## 0. 工作规则（必须遵守）

1. **一次只做一个任务**（§5 的 T 编号），按顺序做。完成后：
   - 运行 `npm run typecheck` 和 `npm test`，全部通过；
   - 在本文 §5 把该任务的 `[ ]` 改成 `[x]`，并在 §7「进度日志」追加一行；
   - 用一个 git 提交收尾，提交信息格式：`<类型>(<范围>): <中文描述>`，如 `feat(adapter): 实现 OneBot v11 适配器`。类型用 feat / fix / chore / docs / test / refactor。
2. **不确定就停下来问用户**，不要猜。尤其是：需要真实 QQ 账号操作、需要密钥、需要改变本文已定的决定。
3. **不要扩大范围**。没写在任务里的功能不做；想到的点子写进 §8「待评估清单」。
4. **绝对禁止**：
   - 修改 `reference/` 下的任何文件（只读参考）；
   - 提交 `.env`、`data/`、任何 API key / token / 聊天记录；
   - 用 CQ 码字符串发消息（必须用消息段数组）；
   - 在开发测试中让 bot 主动在真实群里发言（测试只用私聊或 `/aq ping` 这类显式指令）；
   - 接入或操作 bot 小号以外的任何 QQ 账号；
   - 在 `src/adapters/onebot/` 以外的地方 import `@snowluma/sdk`。
5. 代码与注释：TypeScript，**注释用中文**，标识符用英文。只用可擦除的 TS 语法（不用 `enum`、`namespace`、参数属性），因为 Node 直接运行 `.ts`。
6. 相对导入必须写完整扩展名：`import { x } from './foo.ts'`。

---

## 1. 环境事实（已核实）

| 项 | 值 |
|---|---|
| 操作系统 | Windows（用户个人 PC）。将来可能迁移 Linux，**核心代码不得使用 Windows 专有 API**（见 §3 分层） |
| 仓库路径 | `E:\Teamworks\Aquarium`（git 已初始化，分支 `main`） |
| Node | 用户机器 v22.23.2。`engines` 写 `>=22.18`。推荐将来升级 Node 24 LTS，但**不阻塞任何任务** |
| 运行 TS | `node xxx.ts`（Node 22.18+ 默认支持类型擦除），不用 tsx / ts-node / 构建步骤 |
| 包管理 | npm（已有 `package-lock.json`） |
| TypeScript | 7.0.2（仅用于 `tsc --noEmit` 类型检查） |
| SnowLuma | 发行包 `E:\bot\SnowLuma-v1.14.22-win-x64-lite`，版本 1.14.22，用 `launcher.bat`（即 `node ./index.mjs`）启动；WebUI `http://127.0.0.1:5099` |
| bot 小号 | QQ `900000001` |
| OneBot 配置 | `E:\bot\SnowLuma-v1.14.22-win-x64-lite\config\onebot_900000001.json`：WS 服务端 `127.0.0.1:3001`，`path: /`，有 `accessToken`，`messageFormat: array`，`reportSelfMessage: false`；HTTP 服务端 `127.0.0.1:3000` |
| SnowLuma 运行时配置 | `config/runtime.json`：`hookAutoLoad: false`（不会自动注入任何 QQ），`webuiHost: 127.0.0.1` |
| 模型 | DeepSeek、小米 MiMo 有直连 key；其余经中转站（OpenAI 兼容） |
| 参考代码 | `reference/`：`SnowLuma`（源码）、`ai-bot-groupmate`（Apache-2.0，主要设计参考）、`qq-bridge`（MIT）、`Tulpa`（反面教材） |

**许可证**：SnowLuma 及 `@snowluma/sdk` 是“源码可见非商业许可”，不是开源。仓库当前私有，可以依赖 SDK；但 SDK 只能出现在适配器里（§0 第 4 条），以便将来公开时替换。不得把 SnowLuma 的任何文件复制进本仓库。

---

## 2. 当前状态（交接时）

已完成：
- `doc/plans/DESIGN.md`（v0.4）、`doc/plans/RESEARCH-qqnt-ecosystem.md`、本文。
- `.gitignore`（已排除 `reference/`、`data/`、`.env`、`node_modules/`、`doc/growth/` 等）、`.gitattributes`（LF；`.bat/.cmd/.ps1` 用 CRLF）。
- `package.json`（`type: module`，依赖 `@snowluma/sdk@1.14.22`，开发依赖 `typescript@7.0.2`、`@types/node@22.20.5`）、`tsconfig.json`、`.env.example`、`.env`（已从 example 复制，内容即 example，未提交）。
- `src/spike/ping.ts`：验证用小程序（逻辑已写好）。

**未完成 / 已知问题（T0 要解决）**：
1. `@snowluma/sdk@1.14.22` 的 npm 包有打包缺陷：`dist/**/*.js` 和 `dist/**/*.d.ts` 里的相对导入缺少 `.js` 扩展名（例：`export { SnowLumaApiClient } from './client/api-client';`）。后果：
   - 运行时报 `ERR_MODULE_NOT_FOUND`；
   - 类型声明解析失败，`tsc` 报 `ping.ts(47,22): Parameter 'event' implicitly has an 'any' type`。
2. 尚未在用户机器上实际连通 SnowLuma 验证。
3. 上述文件尚未提交（`git status` 显示 `.gitignore`、`DESIGN.md` 已修改，其余未跟踪）。

**托管登录识别延迟（V12 待验证假设）**：SnowLuma 通过 QQ 快速登录端口（4301–4310）的 `pt_get_uins` 识别账号；当前推测是它只在返回恰好一个 UIN 时确认身份，主号和小号同时登录可能返回两个 UIN 而暂时被判为未知。此判断须由 PID 探测诊断日志验证，按 SnowLuma 侧行为处理，不改动 `reference/SnowLuma/`；Aquarium 侧以缩短等待扫描间隔和记录探测结果来减少等待并确认原因。

---

## 3. 架构与目录（M1 目标形态）

```
Aquarium/
├─ src/
│  ├─ app/            入口与装配：main.ts（读配置 → 建 store → 建适配器 → 建 pipeline → 启控制台）
│  ├─ core/           平台无关核心：事件模型、会话、处理管线（pipeline）、节奏、限流、决策追踪
│  ├─ adapters/
│  │  ├─ types.ts     ProtocolAdapter 接口（核心只依赖这个）
│  │  └─ onebot/      OneBot v11 适配器 —— 全仓库唯一允许 import @snowluma/sdk 的目录
│  ├─ host/           平台托管层：types.ts（Host 接口）、windows/（当前实现）；linux/ 将来再做
│  ├─ config/         配置 schema、加载、继承解析、热重载、原子写
│  ├─ llm/            模型提供方、槽位、降级链、用量与预算
│  ├─ store/          SQLite（node:sqlite）与迁移
│  ├─ panel-server/   控制台后端 HTTP API
│  ├─ persona/        人设卡加载与导入
│  └─ spike/          一次性验证脚本（不被正式代码引用）
├─ panel/             控制台前端（T10 才创建）
├─ personas/          人设卡 Markdown（default.md 可提交；用户自己的人设放 data/personas/）
├─ scripts/           辅助脚本（如 SDK 修补、边界检查）
├─ test/              测试（node:test），文件名 *.test.ts
├─ data/              运行时数据（gitignored）：config.yaml、aquarium.db、personas/、logs/
├─ config.example.yaml 配置示例（可提交）
└─ doc/plans/         设计、计划、调研
```

**依赖方向（必须遵守）**：`app` → 所有；`core` → `adapters/types.ts`、`config`、`llm`、`store`、`persona`；`adapters/onebot` → `adapters/types.ts`、`core/events.ts`；`host` → 无核心依赖。`core` **不得** import `adapters/onebot`、`host/windows`、`node:child_process`。T1 会写一个脚本自动检查。

**选定的库（不要替换）**：
| 用途 | 选择 |
|---|---|
| 配置文件格式 | YAML，库 `yaml` |
| 校验 | `zod` |
| SQLite | 内置 `node:sqlite`（`DatabaseSync`）。若在 Node 22.23 上导入报错或需要 flag，**停下来告诉用户**，不要自行换库 |
| 大模型调用 | 官方 `openai` npm 包，通过 `baseURL` 接 DeepSeek / MiMo / 中转站 |
| 控制台后端 | `hono` + `@hono/node-server` |
| 控制台前端 | Vite + React + TypeScript（T10） |
| 测试 | 内置 `node:test` + `node:assert/strict`，命令 `node --test test/` |
| 日志 | 自写极简 logger（`src/core/logger.ts`），输出到控制台与 `data/logs/` |

---

## 4. 关键接口（照此实现，字段名不要改）

### 4.1 内部事件模型 `src/core/events.ts`
```ts
export type ChatKind = 'group' | 'private';

/** 会话唯一标识。peer：群聊为群号，私聊为对方 QQ 号 */
export interface SessionKey { account: number; kind: ChatKind; peer: number }

/** 会话键的字符串形式，用于 Map 键与配置文件：`${account}:${kind}:${peer}` */
export function sessionId(k: SessionKey): string;

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'at'; target: number | 'all' }
  | { type: 'image'; url: string; file?: string }
  | { type: 'reply'; messageId: string }
  | { type: 'face'; id: string }
  | { type: 'unknown'; raw: unknown };

export interface IncomingMessage {
  session: SessionKey;
  messageId: string;
  senderId: number;
  senderName: string;      // 群名片优先，其次昵称
  segments: Segment[];
  plainText: string;       // 仅拼接 text 段
  mentionsSelf: boolean;   // 含 at 自己（不含 at all）
  replyToSelf: boolean;    // 引用了自己发的消息（M1 可先恒为 false，留 TODO）
  time: number;            // 毫秒时间戳
}
```

### 4.2 协议适配器 `src/adapters/types.ts`
```ts
export interface ContactGroup { groupId: number; name: string; memberCount?: number }
export interface ContactFriend { userId: number; nickname: string; remark?: string }

export type AdapterStatus = 'connecting' | 'online' | 'offline';

export interface ProtocolAdapter {
  readonly account: number;
  connect(): Promise<void>;                       // 连接并校验登录账号 === account，不一致抛错
  close(): void;
  onMessage(cb: (m: IncomingMessage) => void): () => void;   // 已过滤掉自己发的消息
  onStatus(cb: (s: AdapterStatus) => void): () => void;
  send(session: SessionKey, segments: Segment[]): Promise<{ messageId: string }>;
  listGroups(): Promise<ContactGroup[]>;
  listFriends(): Promise<ContactFriend[]>;
  history(session: SessionKey, count: number): Promise<IncomingMessage[]>;  // 由旧到新
  markRead(session: SessionKey): Promise<void>;
  setTyping(session: SessionKey): Promise<void>;  // 仅私聊有效，群聊直接 resolve
  recall(messageId: string): Promise<void>;
}
```
对应 OneBot 动作：`get_login_info`、`send_group_msg` / `send_private_msg`（`message` 传消息段数组）、`get_group_list`、`get_friend_list`、`get_group_msg_history` / `get_friend_msg_history`、`mark_msg_as_read`、`set_input_status`、`delete_msg`。SDK 未封装的动作用其 Raw Action 调用（见 `reference/SnowLuma/packages/sdk/README.md` 的「Raw Action」一节）。

### 4.3 配置 `data/config.yaml`（schema 写在 `src/config/schema.ts`，用 zod）
```yaml
owner: 0                      # 主人（用户本人）的 QQ 号；0 表示未设置 —— 未设置时管理指令全部禁用
accounts:
  - uin: 900000001
    persona: default          # 对应 personas/default.md 或 data/personas/default.md（后者优先）
    snowlumaDir: 'E:\bot\SnowLuma-v1.14.22-win-x64-lite'   # 从其 config/onebot_<uin>.json 读 WS 端口与 token
providers:                    # 密钥只写环境变量名，真实值放 .env
  deepseek: { baseUrl: 'https://api.deepseek.com', apiKeyEnv: DEEPSEEK_API_KEY }
  mimo:     { baseUrl: '<待用户填写>', apiKeyEnv: MIMO_API_KEY }
slots:                        # 每个槽位是降级链，按顺序尝试
  reply:  [ { provider: deepseek, model: deepseek-v4-pro }, { provider: deepseek, model: deepseek-flash } ]
  judge:  [ { provider: deepseek, model: deepseek-flash } ]
  extract:[ { provider: deepseek, model: deepseek-flash } ]
  vision: [ { provider: deepseek, model: deepseek-flash } ]
pricing:                      # 每百万 token 人民币价格，用于预算估算（用户可改）
  deepseek-v4-pro: { input: 4.8, cachedInput: 0.16, output: 14.4 }
  deepseek-flash:  { input: 1.1, cachedInput: 0.02, output: 4.3 }
budget: { dailyCny: 5, warnRatio: 0.8 }
defaults:                     # 会话默认值；所有会话继承
  enabled: false              # 默认不启用，需在控制台勾选
  mode: mention_only          # M1 只实现 mention_only；其余模式值（active/natural/busy）先保留在 schema 中但不生效
  nicknames: []               # 被叫这些名字视为“叫到它”
  contextMessages: 20
  rate: { perUserPerMinute: 4, perSessionPerMinute: 8, minIntervalSec: 3 }
  groupNote: ''               # “在这个群里的补充说明”
sessions: {}                  # 键为 sessionId，值为对 defaults 的部分覆盖，例如：
#  '900000001:group:123456': { enabled: true, nicknames: ['小鱼'] }
panel: { host: 127.0.0.1, port: 5180, passwordEnv: AQUARIUM_PANEL_PASSWORD }
```
- **继承解析**：`resolveSession(cfg, key)` = `deepMerge(defaults, sessions[sessionId(key)] ?? {})`。
- **白名单兜底**：所有会话都 `enabled: false` 时照常启动（这是正常状态），但启动日志要提示“当前没有启用任何会话”。
- pricing 中的数值是按 DeepSeek 官方**非高峰**美元价 ×7.2 粗估的占位值（工作日高峰时段北京时间 9–12、14–18 点价格翻倍，M1 不区分时段，统一按此估算），提醒用户核对。

### 4.4 `.env`（不提交）
```
DEEPSEEK_API_KEY=
MIMO_API_KEY=
AQUARIUM_PANEL_PASSWORD=
```
（`SNOWLUMA_DIR`、`BOT_UIN` 只供 `src/spike/ping.ts` 使用，T0 之后保留不删。）

---

## 5. 任务清单（M1）

> ⚠️ 本节任务清单已迁移到 doc/plans/PLAN.md，以 PLAN.md 为准；本节仅保留历史。

> 每个任务都给出：要做什么 / 验收标准。验收标准里标 **【用户】** 的步骤需要用户在自己的电脑上操作，完成代码后请明确告诉用户要做什么。

### 可用里程碑 U1：手动启动 SnowLuma 后，bot 能在启用的会话里被 @ 时回复

- [x] **T0 修复 SDK 并跑通 spike**（夜间代码/单测完成；真实 SnowLuma 与 QQ 验收待用户）
  - 新建 `scripts/patch-snowluma-sdk.mjs`：移植 `reference/qq-bridge/scripts/patch-snowluma-sdk.mjs`（MIT，文件头注明出处与版权），**扩展为同时处理 `.d.ts` 文件**：对 `dist/**/*.js` 与 `dist/**/*.d.ts` 中 `from '<相对路径>'` 的导入，若目标 `<路径>.js`（对 `.d.ts` 检查 `<路径>.d.ts`）存在则补 `.js`；若 `<路径>/index.js` 存在则改成 `<路径>/index.js`。只处理 `@snowluma/sdk`。脚本幂等。
  - `package.json` 加 `"postinstall": "node scripts/patch-snowluma-sdk.mjs"`，然后执行一次 `npm install`。
  - 验收：`npm run typecheck` 无错误；`node -e "import('@snowluma/sdk').then(m=>console.log(Object.keys(m).length))"` 输出数字。
  - **【用户】** 验收：启动 SnowLuma → 在 WebUI 的进程列表里手动对小号 QQ 进程点“加载”→ 运行 `npm run spike:ping` → 看到“已连接：…(900000001)” → 用主号私聊小号发 `/aq ping`，收到 `pong 🐟 水族箱已连接`。
  - 完成后把当前所有未提交文件一并提交（含 `DESIGN.md` v0.4 与 `.gitignore` 的修改）。

- [x] **T1 项目骨架**（夜间代码/单测完成；Windows 上目录参数不可用，测试脚本改用显式文件模式；T0 spike 的 SDK 临时豁免见 MORNING.md）
  - 按 §3 建目录；安装 `yaml`、`zod`、`openai`、`hono`、`@hono/node-server`（精确版本，`--save-exact`）。
  - `src/core/logger.ts`：`createLogger(scope)` → `{ debug, info, warn, error }`，格式 `[HH:mm:ss] [LEVEL] [scope] msg`，同时追加写入 `data/logs/aquarium-YYYY-MM-DD.log`（目录不存在则创建）。
  - `scripts/check-boundaries.mjs`：扫描 `src/**/*.ts`，违反 §3 依赖方向或在 `src/adapters/onebot/` 外 import `@snowluma/sdk` 时以非零码退出并打印违规文件。
  - `package.json` scripts：`"test": "node --test test/"`、`"check": "npm run typecheck && node scripts/check-boundaries.mjs && npm test"`、`"start": "node --env-file-if-exists=.env src/app/main.ts"`。
  - `config.example.yaml`：即 §4.3 内容。
  - 验收：`npm run check` 通过（至少有一个 logger 的测试）。

- [x] **T2 事件模型与 OneBot 适配器**（夜间代码/单测完成；真实 SnowLuma/QQ 验收待用户，见 MORNING.md）
  - 实现 §4.1、§4.2。适配器文件：`src/adapters/onebot/adapter.ts`（类 `OneBotAdapter implements ProtocolAdapter`），构造参数 `{ account, snowlumaDir }`，从 `onebot_<account>.json` 读第一个 `wsServers`，`reconnect: true`。
  - `src/adapters/onebot/convert.ts`：OneBot 消息段 ⇄ `Segment` 双向转换（纯函数）；未知类型转为 `unknown`，发送时丢弃 `unknown`。
  - 过滤：`user_id === account` 的消息不分发。
  - 测试：`test/onebot-convert.test.ts` 覆盖 text / at（含 all）/ image / reply / face / 未知类型，以及 `mentionsSelf`、`plainText` 的计算。
  - 验收：`npm run check` 通过；把 `src/spike/ping.ts` 复制为 `src/spike/adapter-ping.ts` 改用 `OneBotAdapter` 实现同样的行为，**【用户】** 用私聊 `/aq ping` 验证。

- [x] **T3 配置**（夜间代码/单测完成）
  - `src/config/schema.ts`（zod）、`load.ts`（读 `data/config.yaml`；不存在时复制 `config.example.yaml` 过去并提示用户编辑）、`resolve.ts`（`resolveSession`、`deepMerge`，数组整体覆盖不合并）、`watch.ts`（`fs.watch` + 300ms 防抖；新配置校验失败则保留旧配置并记 error 日志；成功则发出 `changed` 事件）、`write.ts`（原子写：写 `*.tmp` 再 `rename`）。
  - 测试：继承解析、数组覆盖、非法配置被拒且旧配置保留、原子写。
  - 验收：`npm run check` 通过。

- [x] **T4 存储**（夜间代码/单测完成）
  - `src/store/db.ts`：打开 `data/aquarium.db`（`node:sqlite`），`PRAGMA journal_mode=WAL`；简单迁移机制（`schema_version` 表 + 按序执行的迁移数组）。
  - 迁移 1 建表：
    - `messages(id INTEGER PK, session_id TEXT, message_id TEXT, sender_id INTEGER, sender_name TEXT, is_self INTEGER, plain_text TEXT, segments_json TEXT, time INTEGER)`，索引 `(session_id, time)`；`UNIQUE(session_id, message_id)`。
    - `usage(id INTEGER PK, time INTEGER, slot TEXT, provider TEXT, model TEXT, input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, cost_cny REAL, latency_ms INTEGER, ok INTEGER)`。
    - `image_captions(key TEXT PK, caption TEXT, time INTEGER)`。
    - `decisions(id INTEGER PK, time INTEGER, session_id TEXT, message_id TEXT, replied INTEGER, reason TEXT, detail_json TEXT)`。
  - 仓储函数放在 `src/store/repository.ts`，只依赖打开的数据库连接：`saveMessage`、`recentMessages(sessionId, n)`（由旧到新）、`recordUsage`、`costToday()`（按本地时区的自然日）、`getCaption/setCaption`、`recordDecision`、`recentDecisions(n)`。
  - 测试使用临时文件数据库。验收：`npm run check` 通过。

- [x] **T5 模型层**（夜间代码/单测完成，真实模型调用待用户）
  - `src/llm/client.ts`：按 provider 缓存 OpenAI-compatible 客户端；provider 的 base URL 或环境变量名变化时重建。SDK 内部重试关闭，由槽位降级链负责尝试和逐次记账。
  - `src/llm/slots.ts`：`callSlot(slot, messages, opts)` 按降级链尝试；400/401/403/404 不降级；408/429/5xx、网络错误和超时（默认 30s）降级。每次尝试都 `recordUsage`，失败也写 `ok=0`。使用量读取响应字段，缓存 token 支持 DeepSeek 顶层字段和 OpenAI-compatible 嵌套字段。
  - `src/llm/budget.ts`：纯函数 `budgetState(config, costToday)` 返回 `ok | warn | exceeded`；`exceeded` 时 `reply` 只调用链中最后一项。模型价格缺失时在请求前拒绝发送，避免把未知成本记成 0。
  - 假客户端单测覆盖降级、错误分类、超时、用量与预算；未发真实请求。验收：`npm run check` 通过（47 项测试）。
  - 用户验收：运行 `npm run spike:llm-ping`，以 `reply` 槽位询问“你好”并查看回复与用量；需用户配置 `.env`，**不要在夜间执行**。

- [x] **T6 回复管线（M1 只做“被叫必回”；夜间代码/单测完成，真实账号验收待用户）**
  - `src/persona/load.ts` 优先读取 `data/personas/<id>.md`，再读取 `personas/<id>.md`；拒绝路径型 ID；新建简短中性 `personas/default.md`，用已校验登录昵称替换 `{{name}}`。
  - `src/core/pipeline.ts` 先存消息，再按当前配置决定 disabled / trigger / rate limit / prompt / reply / clean / split / pacing / send / self-message storage / decision。私聊总是触发，群聊只在 `mentionsSelf` 或包含已配置昵称时触发。每个新消息通过配置 getter 读取最新热重载配置。
  - 辅助模块各自单一职责：`rate-limit.ts` 是按用户、会话与最小间隔的内存滑动窗口；`prompt.ts` 固定 system 前缀、按时间组装一条 user 上下文；`text.ts` 清理 Markdown 和已知昵称前缀；`split.ts` 按标点/换行切分且最多三条；`pacing.ts` 计算每条的抖动延迟。群聊仅第一条发送引用段；私聊发送前设置输入状态。
  - `src/app/main.ts` 装配配置 watcher、SQLite repository、OneBotAdapter 与 pipeline；处理各账号独立连接错误；Ctrl+C/SIGTERM 取消订阅、断开适配器并等待正在处理的消息后再关闭数据库。会话配置热重载即时生效；账号列表或 SnowLuma 路径变化需重启连接。
  - 使用临时文件数据库、假适配器与假 LLM 的单测覆盖触发、限流、提示快照、清洗、拆条、群聊/私聊发送与决策落库。最终 `npm run check` 通过（70 项测试）；未运行真实 QQ 或模型请求。
  - 用户验收：`npm run check` 通过；**【用户】** 在 `data/config.yaml` 填 owner、启用一个测试用私聊或小群 → 启动 SnowLuma 并手动加载小号 → `npm start` → @ 小号，收到符合人设的回复；未启用的群里 @ 小号不回复。

**完成 U1 后停下来，请用户实际使用一两天再继续。**

### 可用里程碑 U2：日常可用

- [ ] **T7 看图**：消息含 `image` 段且本次会触发回复时，对每张图调用 `vision` 槽位生成一句中文描述（缓存键：`file` 字段，没有则用 url 的 sha1），在上下文里把图片替换为 `[图片：描述]`。不触发回复的消息不识图（省钱）。单张识图失败则用 `[图片]` 占位，不影响回复。
- [ ] **T8 离线补课**：适配器 `online` 时，对每个已启用会话拉取 `history(session, 50)`，与库中最后一条消息比对补齐入库；找出补齐部分里提到自己的消息，若最新一条的时间距今 ≤ 10 分钟，则只针对**最新那一条**走一次正常回复流程（上下文自然包含补齐的消息）；更早的只入库不回复。
- [ ] **T9 管理指令**（仅 `owner` 发出时生效，其他人发出则当普通消息）：`/aq ping`（回复 pong）、`/aq mute [分钟]`（本会话闭嘴，默认 60 分钟，存内存）、`/aq unmute`、`/aq recall`（撤回本会话中 bot 最近发的一条）、`/aq status`（今日花费、预算状态、已启用会话数）。指令消息本身不进入回复流程。
- [ ] **T9b 调试记录（精简版）**
  - 配置新增（schema + `config.example.yaml`）：`debug: { enabled: false, sessions: {}, retainDays: 7 }`。`sessions` 的键为 sessionId、值为 `true/false`，覆盖总开关；随配置热重载立即生效。
  - 迁移新增表 `debug_traces(id INTEGER PK, time INTEGER, session_id TEXT, message_id TEXT, slot TEXT, provider TEXT, model TEXT, prompt_json TEXT, response_text TEXT, prompt_hash TEXT, detail_json TEXT)`，索引 `(session_id, time)`。
  - 当某会话的调试开启时，`callSlot` 的每次尝试（含失败）都写一条：完整 messages 数组、模型原始返回文本（失败则为空，`detail_json` 记错误名与状态码）、`prompt_hash` = messages 序列化后的 sha256 前 16 位。决策记录 `detail_json` 中同时写入该 `prompt_hash`。
  - 调试关闭时**不写入**任何全文。
  - 过期清理：启动时及之后每 6 小时删除 `time` 早于 `retainDays` 天的记录。
  - 仓储函数：`recordDebugTrace`、`debugTracesFor(sessionId, messageId)`、`pruneDebugTraces(now)`。T10 控制台的决策追踪页在有调试记录时显示“查看完整提示词 / 原始返回”。
  - 注意：M2 引入私密信息分级后，调试记录必须对 L0 内容脱敏（DESIGN §10.1）；M1 尚无此概念，在代码中留 TODO 注释指向该条。
  - 测试：开关继承（总开关 / 会话覆盖）、关闭时不写入、过期清理、失败调用也有记录。

- [ ] **T10 控制台**：
  - 后端 `src/panel-server/`（hono）：只监听配置中的 host/port；所有 `/api/*` 需要 `Authorization: Bearer <密码>`（与 `AQUARIUM_PANEL_PASSWORD` 比较，用常数时间比较）；密码未设置时**拒绝启动控制台**并打印提示。接口：`GET /api/status`、`GET /api/sessions`（合并 `listGroups`、`listFriends` 与配置中的启用状态）、`PATCH /api/sessions/:sessionId`（写入 `sessions` 覆盖项，原子写配置）、`GET/PUT /api/personas/:id`、`POST /api/personas/import`（上传 Markdown）、`GET /api/decisions?limit=`、`GET /api/usage/today`、`POST /api/sandbox/chat`（试聊：走完全相同的提示词组装与 `reply` 槽位，但不调用适配器发送、不入 `messages` 表）、`POST /api/recall/:messageId`。
  - 前端 `panel/`（Vite + React）：登录页、会话列表（按群 / 好友分组，勾选启用，可编辑 nicknames 与 groupNote）、人设编辑与导入、决策追踪列表、今日用量、试聊窗口。构建产物由 panel-server 静态托管。界面文案层级清晰：每页一个标题、每组设置一个小标题、每项一句说明。
  - 验收：**【用户】** 浏览器打开控制台，勾选一个会话后无需重启即生效。

### 可用里程碑 U3：一键启动（DESIGN §2）

- [ ] **T11 托管层调研（只调研，写结论，不写正式代码）**：在 `doc/plans/` 写 `HOST-RESEARCH.md`，回答：
  1. SnowLuma WebUI API 的鉴权方式（读 `reference/SnowLuma/packages/core/src/webui/server.ts` 及相关文件），以及如何调用 `POST /api/processes/:pid/load`；
  2. 如何以无窗口方式启动 SnowLuma（`node index.mjs`，cwd 为其目录，`windowsHide: true`）及如何判断其就绪；
  3. 用户机器上 QQ.exe 的路径、如何启动并拿到 PID、如何区分小号进程与主号进程（若无法可靠区分，提出“只注入由我们启动的那个 PID”的方案并说明局限）；
  4. Windows 托盘的候选方案（至少比较两种：基于预编译二进制的 npm 托盘库 vs 其他），各自的依赖、体积、是否需要原生扩展；
  5. 开机自启的方式（启动文件夹快捷方式 / 计划任务），推荐其一。
  - 写完后**停下来请用户确认方案**，再进入 T12。
- [ ] **T12 Windows 托管实现**：按 T11 确认的方案实现 `src/host/types.ts`（`Host` 接口：`start()`、`stop()`、`status()`、`onStatus(cb)`）与 `src/host/windows/`：依次启动 SnowLuma → QQ → 注入指定 PID → 等待适配器 `online` 且登录账号校验通过；子进程退出按 1s→30s 指数退避重启；需要扫码时托盘变色并弹通知；托盘菜单：状态、打开控制台、紧急闭嘴（全部会话）、重启、退出。

---

## 6. 测试与验收约定

- 单元测试不得访问网络、不得连接真实 SnowLuma、不得读写 `data/`（用临时目录）。
- 需要真实环境的验证一律写成 `src/spike/*.ts` 小脚本，由用户运行。
- 每个任务结束时 `npm run check` 必须通过（T1 起）。

---

## 7. 进度日志

| 日期 | 任务 | 结果 / 备注 |
|---|---|---|
| 2026-10-12 | 交接 | 骨架与 spike 已写好，SDK 打包缺陷待 T0 修复 |
| 2026-10-12 | T0 | 新增仅修补 `@snowluma/sdk` 的幂等 postinstall 脚本与单测；离线安装后 typecheck 通过，SDK 导出数 53；真实 QQ 验收列入 MORNING.md |
| 2026-10-12 | T1 | 增加 logger、依赖边界检查、项目脚本与精确依赖；`npm run check` 通过（5 项测试）；边界检查暂豁免 T0 spike，待 T2 适配器完成后收回 |
| 2026-10-12 | T2 | 新增 Aquarium 事件模型、OneBot 双向段转换和 SDK 适配器；`npm run check` 通过（20 项测试）；真实 QQ 验收列入 MORNING.md，T0 旧 spike 的单文件 SDK 豁免暂保留 |
| 2026-10-12 | T3 | 完成 Zod 配置 schema、YAML 加载/继承、fs.watch 热重载与原子写；`npm run check` 通过（30 项测试） |
| 2026-10-12 | T4 | 以 Node 内置 `node:sqlite` 完成 WAL、版本迁移和消息/用量/图片/决策仓储；`npm run check` 通过（36 项测试） |
| 2026-10-12 | T5 | 完成 OpenAI-compatible 客户端缓存、模型降级、用量和预算控制；`npm run check` 通过（47 项测试）；真实模型 spike 留给用户 |
| 2026-10-12 | T6 | 完成被叫必回 pipeline、人设、限流、提示词、清洗、拆条、发送节奏和入口装配；`npm run check` 通过（70 项测试）；真实 QQ 验收留给用户 |

---

## 8. 待评估清单（想到但不在 M1 范围内的点子写这里）

- （2026-10-12 审查）**`config` ↔ `core` 目录互相引用**：`config` 只用到 `core/logger.ts` 与 `core/events.ts`。将来把这两个文件移到 `src/shared/`，使依赖变为单向。
- （2026-10-12 审查）**`core` 依赖 OpenAI 类型**：`core/pipeline.ts`、`core/prompt.ts` 直接使用 `openai` 包的消息类型。接入 CLI 后端（M4）前，在 `src/llm/` 定义自有的 `ChatMessage` 类型并替换。
- （2026-10-12 审查）**适配器断线重连后不再校验登录账号**：只在首次 `connect` 时校验。

## 9. 好感度数据流（M2-C）
- 主键为 `(account,userId)`，群聊和私聊共用关系；bot 自身不建档。
- 被叫通过频率限制后记 `called`，每人每天最多 3 次，原始 +0.5 仍受自动事件日上限约束。
- 情绪评估成功后，非零 `appliedDv` 按 ×20 转为好感变化，单次最多 ±3。
- 自动事件分别记入 `affinity_events` 的原始 `delta` 与限额后的 `applied`；状态写入 `affinity_state`。
- 查询值按距上次自动互动天数向 50 回落；只在新自动事件发生时写回回落结果。
- 五档使用共享 `nextLevel` 防抖；档位转换另记 `band` 事件。
- 回复仅注入触发发送者的非 neutral `affinity` 块，名字以 JSON 引号包裹。
- 控制台手动设置写 `manual` 事件，不受自动上限或档位防抖影响。

## 10. 性格底色数据流（M2-D）
- 人设 YAML `traits` 加载后剥离，不进入 persona 正文；无头默认为全 0，非法档位报 `persona_error`。
- 非 0 档位按 `order → morality → talk → mind` 取 `prompts/traits.md` 句子，traits 块位于 persona 后、rules 前。
- 有效话量 `talk' = clamp(persona.talk + session.talkOffset, −2, 2)`；缺省 offset 为 0。
- 主动判断阈值在原值上减 `0.05 × talk'`，再限制到 `[0.2, 0.9]`。
- 拆条上限：`talk' ≤ −2` 为 1 条，`talk' = −1` 为 2 条，其余 3 条；溢出内容并入最后一条。
- `talkOffset` 从全局默认继承，可按群覆盖；面板私聊不显示该控制项。

## 11. 作息与精力数据流

- 顶层 `sleep` 默认关闭，时间为本地 `HH:mm`；`sleepPlan` 支持跨午夜，非法或相同时间视为醒着，`cycleKey` 为入睡日期。
- 入睡后消息仍先持久化，再以 `asleep` 跳过回复和主动判断；重放不拦截。主人在叫 bot 的消息里含醒词可叫醒 30 分钟，主人发言续期；重启丢失，非主人无效。
- 每分钟检测 awake→sleep；对近 2 小时 bot 发过言的已启用会话取最近前 2，随机发送 `prompts/sleep.md`，不调模型，复用 deliverStep/闭嘴/频率限制；cycleKey 内存去重并记 `goodnight` decision，启动已睡不补发，关机清理定时器。
- 醒着时 `energy=clamp(1−0.8×(now−wakeAt)/(bedAt−wakeAt)−0.01×account近60分钟回复数,0,1)`；作息关闭恒为 1，睡着时不计算。
- `energy<0.35` 时 float 加“有点困”（与 arousal 词用顿号）；`energy<0.25` 时在 talk 偏移后、阈值限幅前加 0.1。控制台通过 `/api/sleep` GET/PATCH 配置，作息卡显示状态、精力和下次变化时间。

## 12. 模型接入、CLI 预热与人设文件（T10）

- API provider 位于 `providers.<id>`，声明 `kind: api`、`baseUrl`、`apiKeyEnv`；真实凭据值仅放本机 `.env`。
- 模型接口只返回密钥状态 `keyStatus.set/last4` 和 `apiKeyEnv` 名，不返回密钥原文。
- `slots.<name>` 是按顺序尝试的降级链；条目可设置 `temperature`、`maxTokens` 与 `reasoning`；`reasoningField: 'none'` 不发送 reasoning 参数；调用追踪只记录安全参数。
- CLI provider 使用 `kind: cli`、`command`、`args`、`timeoutSec`、`prewarm`；命令参数数组执行，不经过 shell。
- `prewarm` 为每个 CLI provider 保留一个空闲进程；调用后替换，空闲 stdout/stderr 持续排空。
- 空闲进程意外退出后按指数退避重启；关机时调用 `stopAll()` 清理，自动测试只用假命令。
- 内置人设位于 `personas/<id>.md`，用户版本位于 `data/personas/<id>.md` 并优先读取。
- 可选 YAML front matter 的 `traits.order/morality/talk/mind` 为 -2..2 整数，缺省为 0。
- 主标题用 `# ...`，开头说明紧随其后；运行时剥离 YAML 并将 `{{name}}` 替换为昵称。
- 标准 `##` 小节依次为：身份、年龄、背景、说话方式、口头禅、常用表情、对熟人、对陌生人、对主人、底线。
- 口头禅、常用表情、底线用逐行 `- ` 列表；未知 `##` 小节按原顺序保留。
- 导入使用 `extract` 槽和 `prompts/persona-import.md` 生成未保存草稿；接受后仍需显式保存。

## M3-A 隐私记忆数据流（2026-10-20；详见 PLAN §13）
- SQLite v11 用 `private_facts` 保存带主人、账号、来源、证据和等级的事实，`privacy_runs` 保存提取游标。
- `privacy.enabled` 默认开启；`promoteMentions=3`，`avoidMinutes=10`，均由配置校验并可调整。
- 私聊提取异步运行且受预算限制，失败不阻断消息；事实只注入同一主人的私聊回复，最多 6 条、200 字。
- 跨场景标签仍经隐私策略；群聊守门先关键词预筛，再用独立 judge 判定候选 L0 话题。
- 未被叫的主动路径触及 L0 时回避并设置冷却；被叫路径触及时仍回复，但只加固定隐私规则、不注入事实文本。群聊回复提示词不含 L0 原文，决策/调试 trace 与日志仅保留安全 ID/等级；发出前还有 fail-closed 出口检查。
- L1/L2 只在策略允许且信息主人在本群出现后注入；主人提及按本地自然日对每条事实幂等计数。
- 自动等级阈值可配置；手动等级保留，用户可恢复自动模式。
- 印象页“私聊”分段支持事实查看、等级设置、恢复自动、改字和软删除。
- `/api/privacy/:userId`、`PATCH/DELETE /api/privacy/facts/:id` 受现有 Bearer 鉴权保护并按账号隔离。
- 隐私事实、关键词、证据与名称在 API 输出前遮蔽敏感文本；自动测试使用假模型和临时数据库。
