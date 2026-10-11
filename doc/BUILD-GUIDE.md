# Aquarium 从骨架到 M1：初学者施工导读

> 本文是随代码一起更新的学习材料。目标不是让你记住所有 API，而是让你能回答：程序分成哪些部分、每一层负责什么、为什么选这些库，以及每个任务怎样验证。当前覆盖 T0–T2；后续 T3–T6 完成时会继续补章节。
>
> 当前代码已经通过单元测试，但真实 SnowLuma/QQ 操作属于用户验收步骤，夜间运行不会代替你执行。

## 1. 先建立整体地图

Aquarium 想做的是一个能在 QQ 群聊和私聊中工作的 AI 群友。项目不会让每个功能都直接操作 QQ，而是把“聊天规则”和“QQ 协议细节”分开：

```text
SnowLuma / OneBot WebSocket
            ↓
 @snowluma/sdk（外部协议客户端）
            ↓
 src/adapters/onebot（把 OneBot 翻译成 Aquarium 接口）
            ↓
 src/core/events.ts（Aquarium 自己的消息词汇）
            ↓
 后续：src/core/pipeline.ts（判断是否回复、如何回复）
            ↓
 ProtocolAdapter.send（把 Aquarium 消息再翻译回 OneBot）
```

目录的职责是：

| 位置 | 负责什么 | 初学者可以这样理解 |
|---|---|---|
| `src/core/` | 平台无关的事件和核心逻辑 | Aquarium 自己的业务语言 |
| `src/adapters/types.ts` | 适配器共同接口 | 核心与具体聊天平台之间的插座规格 |
| `src/adapters/onebot/` | SnowLuma/OneBot 的连接与消息转换 | 把插头接到当前 QQ 协议上 |
| `src/config/` | 配置读写与校验（T3） | 用户可以调整的设置入口 |
| `src/store/` | SQLite 数据库（T4） | 长期保存消息和用量 |
| `src/llm/` | 模型调用与预算（T5） | 统一的 AI 服务入口 |
| `src/app/` | 程序启动和组装（T6） | 把配置、数据库、适配器、管线接起来 |
| `src/spike/` | 用户手动运行的真实环境验证脚本 | 不属于自动测试，不会在夜间连接 QQ |
| `scripts/` | 开发辅助脚本 | 修 SDK 发布包、检查依赖边界 |
| `test/` | 不连接网络的单元测试 | 用假输入证明纯逻辑符合预期 |
| `doc/plans/` | 设计、交接和施工计划 | 说明“要做什么”和“为什么” |

目录不是为了看起来整齐。最重要的是依赖方向：核心逻辑依赖 Aquarium 自己定义的接口，而不是反过来让整个核心绑死在某个 QQ SDK 上。将来换协议时，主要替换适配器，而不应重写消息管线。

## 2. 工程里哪些东西需要外部库

外部库是别人维护、通过 npm 安装并锁定版本的代码。它们能省掉大量重复工作，但也会带来升级、兼容和供应链责任，所以只在有明确职责时引入。

| 依赖 | 在项目中的职责 | 为什么不自己重写 |
|---|---|---|
| `@snowluma/sdk` | 当前 OneBot/WebSocket 客户端；只允许在 OneBot 适配器边界使用 | 连接、动作和消息类型已有实现；Aquarium 只负责转换自己的接口 |
| `typescript`、`@types/node` | TypeScript 类型检查和 Node API 类型 | 编译/类型错误能在运行前被发现；Node 内置能力仍由 Node 提供 |
| `yaml` | T3 读取 YAML 配置 | YAML 有引号、数组、缩进等格式规则，成熟解析器比手写解析安全 |
| `zod` | T3 校验配置形状和数值 | 配置文件是外部输入；要在使用前验证，而不是假设它一定正确 |
| `openai` | T5 通过 OpenAI 兼容接口调用模型 | 复用成熟请求、超时和响应类型封装；不在单元测试里发真实请求 |
| `hono`、`@hono/node-server` | T10 控制台 HTTP API 与 Node 服务 | 提供路由与 Node HTTP 适配，不影响核心消息模型 |

这些依赖在 `package.json` 中使用**精确版本**，`package-lock.json` 记录完整依赖树，便于不同机器安装出相同版本。当前 Aquarium 的 SQLite 计划使用 Node 自带的 `node:sqlite`，不是再装一个 SQLite npm 包。

## 3. T0：为什么要给 SDK 修补扩展名

Aquarium 使用 Node 的 ES Modules（ESM）直接运行 `.ts`。在 ESM 中，`import './file'` 不一定会自动猜成 `./file.js`。当前 SnowLuma SDK 的发布文件里有未带扩展名的相对导入，所以会出现：

1. Node 运行时找不到 SDK 内部模块；
2. TypeScript 读取 `.d.ts` 声明时也可能解析失败。

`scripts/patch-snowluma-sdk.mjs` 只处理安装好的 `node_modules/@snowluma/sdk/dist/`：

1. 扫描 `.js` 与 `.d.ts` 文件；
2. 只查找相对 `from './...'` 导入；
3. 先确认对应的实际 `.js` / `.d.ts` 文件存在，或目录入口 `index.js` 存在，再改路径；
4. 已经正确或找不到目标时保持原样。

“先确认目标存在”避免把路径改成不存在的位置；“只处理 SDK”避免影响其他包；重复运行不再改变文件，这叫**幂等**。`postinstall` 是 npm 安装依赖后的脚本钩子，因此正常安装会自动应用修补；锁文件中的安装脚本标记也由 npm 自己更新。不要手动改 `node_modules` 当作长期修复，因为重装会覆盖它。

T0 的自动测试在仓库内创建临时的假 SDK 目录，验证补 `.js`、使用 `index.js`、保留未命中路径、只改目标包以及第二次运行不再修改。它不连接 SnowLuma。

## 4. T1：logger、边界和测试为什么这样安排

### logger

`src/core/logger.ts` 提供 `createLogger(scope)`，统一生成时间、级别、模块名和消息，并追加到 `data/logs/aquarium-YYYY-MM-DD.log`。它使用 Node 内置的 `node:fs` 和 `node:util`，因此这部分**不需要新增 npm 日志库**。

日志格式统一后，排查错误时可以快速看出“什么时候、哪个模块、什么级别”。单元测试不会往真实 `data/` 写文件：它在仓库内建立一个临时工作目录，启动子进程，并在测试结束时删除。这样既验证真实文件写入，又不污染用户数据。

### 依赖边界检查

`scripts/check-boundaries.mjs` 扫描 `src/**/*.ts` 中的导入，并检查核心层、宿主层和 OneBot 适配器的依赖规则。T1 测试故意构造合法和非法导入，确认脚本会分别通过或打印违规文件并失败。

目前有一个明确记录的临时例外：T0 的 `src/spike/ping.ts` 仍直接导入 SDK，所以边界检查只豁免这个精确文件，不豁免整个 `spike/` 目录。其他层不能借此直接依赖 SDK。该例外以及移除条件见 `doc/plans/MORNING.md`；在例外收回之前，不要把“边界检查通过”误读为 SDK 已完全只有一个入口。

### 自动检查入口

- `npm run typecheck`：只做 TypeScript 类型检查，不连接任何服务。
- `npm test`：运行 `test/` 中单元测试。
- `npm run check`：依次运行类型检查、依赖边界检查和单元测试。

当前 Windows/Node 环境下，`node --test test/` 把目录参数当成模块路径而失败，因此 `npm test` 使用明确的测试文件模式。不要改成裸 `node --test`：Node 会自动发现 `reference/` 只读参考仓库里的测试，而那些测试不是 Aquarium 的质量门。

## 5. T2：把 QQ 消息翻译成 Aquarium 的消息

### 5.1 为什么要有自己的事件类型

SnowLuma 的事件类型属于外部 SDK；如果核心代码到处使用它，换掉 SDK 就会牵动全项目。因此 `src/core/events.ts` 定义 Aquarium 自己的数据结构：

- `SessionKey`：`account + kind + peer`，唯一描述“哪个账号、群聊还是私聊、对端是谁”；
- `Segment`：文本、@、图片、回复、表情或未知内容；
- `IncomingMessage`：会话、发送者、消息段、纯文本、是否 @ 到自己和毫秒时间。

`sessionId()` 把会话键编码为稳定字符串，例如 `账号:group:群号`。设置、存储和管线以后可以使用同一套会话键，而不依赖 OneBot 的字段命名。

### 5.2 双向转换

`src/adapters/onebot/convert.ts` 是纯转换层，不负责网络或数据库：

| OneBot 输入 | Aquarium 内部值 | 说明 |
|---|---|---|
| `text.data.text` | `{type:'text', text}` | 只有文本段进入 `plainText` |
| `at.data.qq` | `{type:'at', target}` | 数字目标可匹配账号；`all` 不算 @ 到 bot |
| `image.data.file/url` | `{type:'image', file?, url}` | 保留发送需要的文件标识和可读 URL |
| `reply.data.id` | `{type:'reply', messageId}` | 统一转成字符串 ID |
| `face.data.id` | `{type:'face', id}` | 统一转成字符串 ID |
| 未支持的类型或格式错误 | `{type:'unknown', raw}` | 接收时保留现场，避免数据静默丢失 |

反向转换时，发送消息段数组；`unknown` 会被丢弃，因为系统不能猜测未知格式是否可安全发送。图片、@、引用等具体 OneBot 结构只在适配器内构造。

`convertIncomingMessage()` 同时把群号/好友号变成 `SessionKey`，把群名片优先用作显示名，并把 OneBot 秒时间戳转换成毫秒。`mentionsSelf` 只对匹配当前账号的数字 @ 生效，不把 `@all` 当作点名。

### 5.3 适配器和外部 SDK

`ProtocolAdapter` 是“插座规格”；`OneBotAdapter` 是当前插头。适配器负责：

1. 按账号读取 SnowLuma 配置的**第一个** `wsServers`；
2. 创建 SDK 客户端并打开自动重连；
3. 连接后读取登录账号，若与配置账号不一致就关闭并报错；
4. 把 SDK 消息转换后分发，并过滤 bot 自己发出的消息；
5. 将 send、联系人列表、历史、已读、输入状态和撤回映射到 SDK 动作。

构造函数保留计划要求的 `{account, snowlumaDir}`，另有一个可选 client factory 测试缝。生产环境使用真正 SDK 客户端；单元测试注入假客户端，因此可以验证“账号不一致会拒绝”“自己消息不会进入管线”等行为，而不连接网络。

SnowLuma 的“标记已读”动作要求一个具体 `message_id`，但 Aquarium 接口只有 `markRead(session)`。因此适配器先只查询当前会话最新一条消息，再对该消息调用对应的群/私聊已读动作；没有消息时不做任何操作。不能用全局 `markAllAsRead()` 代替，否则会越过会话边界。私聊输入状态使用 SDK 的 `set_input_status` raw action；群聊直接完成，不发送该动作。

### 5.4 哪些测试不能替代真实验收

T2 单测使用假配置、假 SDK 客户端和 OneBot 事件对象，验证转换、账号校验、消息过滤、联系人映射、历史排序、已读范围、发消息和撤回调用；`npm run check` 实测为类型检查、依赖边界检查通过，20 项测试通过、0 失败。它不证明本机 SnowLuma 正在运行、端口可连或 QQ 客户端实际显示了回复。

`npm run spike:adapter-ping` 是留给用户的真实环境步骤，不是测试命令。不要在无人值守的自动测试中运行它。

## 6. T3：配置是输入，必须先校验再使用

配置文件由用户编辑，因此它是不可信输入，不能假设 YAML 语法正确、字段齐全或端口范围合理。T3 将配置路径拆成四个小模块：

1. `schema.ts` 用 Zod 描述允许的数据形状，并负责拒绝错误类型、未知字段和越界端口。Zod 是这里明确需要的外部库；它把运行时数据验证和 TypeScript 推断连在一起。
2. `load.ts` 用 `yaml` 解析文本，再交给 schema 校验。`yaml` 只负责“文本变成 JS 值”，Zod 负责“这个 JS 值是否符合 Aquarium 规则”，两者不能互相替代。首次没有 `data/config.yaml` 时，只复制 `config.example.yaml` 并提示用户编辑；后续坏配置不会被示例静默覆盖。
3. `resolve.ts` 把 `defaults` 与 `sessions[sessionId]` 合并。对象字段递归覆盖；数组整体替换，不按下标拼接。例如默认昵称 `['小鱼','鱼']` 被会话设置 `['阿鱼']` 替换后，结果就是 `['阿鱼']`。局部 `rate` 可只改其中一个限制，其余仍继承默认值。
4. `watch.ts` 监听配置所在目录，默认防抖 300ms。目录监听能看到 `write.ts` 用临时文件 `rename` 替换配置文件的变化；连续通知会合并成一次读取。新配置校验失败时只记录错误并保留上一份有效内存配置；通过时更新当前配置并发出 `changed` 事件。
5. `write.ts` 写入前再次校验，然后在目标文件旁创建唯一 `.tmp` 文件，完整写好后再 `rename` 覆盖目标。先写同目录临时文件再重命名，可以避免程序读到“只写了一半”的配置；校验失败则旧文件不动，临时文件会清理。

测试把所有读写都放在仓库内的 `.tmp-config-*` 临时目录，结束时删除；不会读取或写入真实 `data/`。测试覆盖示例配置、非法配置、字段继承/数组替换、首次复制、写入覆盖、失败保留、无效热重载和有效 `changed` 事件。当前 `npm run check` 的实际结果是类型检查与边界检查通过、30 项测试通过、0 失败。

密钥只保存环境变量名称（如 `DEEPSEEK_API_KEY`），配置 YAML 不应出现真实 API key。之后模型客户端从环境变量读取实际值；不要把 `.env` 放入版本控制。

## 7. T4：SQLite 数据库和仓储

SQLite 是一个把数据库存进本地文件的嵌入式数据库。当前 Node 提供 `node:sqlite`，因此 T4 没有新增数据库 npm 依赖。`DatabaseSync` 是同步 API：代码调用后立刻得到结果，适合 Aquarium 当前简单、本地的数据库操作；不要把长时间网络请求放进数据库事务里。

存储分为两层：

1. `src/store/db.ts` 只负责打开 `data/aquarium.db`、启用 WAL、创建 `schema_version` 并按序执行迁移。迁移在事务里运行：建表成功才把版本号推进；失败则回滚。下一次启动不会重复执行已完成的版本。
2. `src/store/repository.ts` 只负责把 Aquarium 数据映射到 SQL 表。它从外部接收已打开的数据库连接，不自己开第二个连接；SQL 使用 `?` 参数绑定，避免把消息文本拼进 SQL 字符串。

第一版四张数据表分别保存消息、模型用量、图片描述缓存、回复决策。消息表的 `(session_id, message_id)` 唯一约束避免同一会话消息重复落库；`(session_id,time)` 索引让“取某会话最近 N 条”不用扫描整张表。最近消息先取最新 N 条，再反转为旧到新，便于之后直接拼成上下文。图片描述按 key upsert；用量按**本机时区**的当天零点到次日零点汇总，结束时间不包含次日零点，因此跨夏令时的日期长度也正确。

SQLite 测试使用仓库内 `.tmp-store-*` 的**文件数据库**，因为真实程序同样使用文件和 WAL，而不是只用内存 DB。Windows 会锁住仍打开的数据库文件；所以测试必须先 `DatabaseSync.close()`，再删临时目录。T4 的数据库/仓储测试覆盖迁移可重复启动、WAL、表/索引、消息排序和去重、自然日用量、图片缓存 upsert、决策最近记录。T4 checkpoint 时 `npm run check` 实测为 36 项测试通过、0 失败。

## 8. T5：模型槽位、容错与预算

项目已经有依赖 `openai@6.40.0`，不需要再为 DeepSeek 单独安装一个 SDK。OpenAI SDK 支持 `baseURL`，因此 `src/llm/client.ts` 能用同一客户端访问 OpenAI-compatible 服务商；配置里只写 `apiKeyEnv` 环境变量名，真实 key 由 `.env` 提供，错误信息也只指出缺少哪个变量，不打印 key。客户端按 provider 缓存，provider 的地址或变量名更改后会重建。

`src/llm/slots.ts` 将“回复、判断、识图”等用途称为槽位；每个槽位配置有序模型列表。例如 `reply` 先试主模型，遇到可恢复故障再试降级模型。SDK 自带重试被关闭，原因是每次真实尝试都要产生一条 `usage` 记录，否则 SDK 在内部重试会让账单和日志对不上。默认单次请求超时 30 秒；408、429、5xx、连接错误和超时会尝试下一项；400/401/403/404 等配置、权限或请求错误会原样抛出，不用另一个模型掩盖问题。每个失败尝试也写入 `ok=false`、零 token 的记录。

成功结果会解析 prompt/completion token 和缓存 token。模型价格按每百万 token 配置，估算方式为“未缓存输入 × input 价 + 缓存输入 × cachedInput 价 + 输出 × output 价”，再除以一百万；价格项缺失时发请求前 fail-closed，避免把未知费用当作 ¥0。`budgetState(config, costToday)` 在 80% 预算处进入 `warn`，达到 100% 进入 `exceeded`；超限时 `reply` 仍然可以回复，但只调用降级链最后一项（示例中是 `deepseek-flash`）。

单测用假客户端返回假响应或抛假 HTTP/网络错误，不读取真实密钥、不发网请求。T5 完成后的 `npm run check` 实测为 47 项测试通过、0 失败。

真实模型连通性单独留给用户手动执行：在 `.env` 填 `DEEPSEEK_API_KEY` 后运行 `npm run spike:llm-ping`。该脚本会真实请求一次 `reply` 模型并估算费用；不要把 `.env` 或 key 发给他人。夜间施工没有运行此脚本。

## 9. T6：从收到消息到自然回复

T6 把前面做好的配置、OneBot 适配器、SQLite 和模型槽位串成一条消息管线。新增代码按职责拆开，不让一个大文件同时懂 QQ 协议、数据库、提示词和回复排版：

1. `src/app/main.ts` 是装配入口：读取配置、开数据库、启动配置 watcher、为每个账号建立 OneBot adapter、连接并把消息交给 pipeline。收到一条消息时，pipeline 通过 getter 取**当前**配置，所以启用开关、昵称、人设、提示词补充和模型槽位的热重载对下一条消息生效。运行时改账号列表或 SnowLuma 路径不会自动重连，入口会提醒重启。
2. `src/core/pipeline.ts` 是业务顺序的协调者：先把收到的消息存起来；会话关闭就记录 `disabled`；私聊直接算被叫，群聊必须 `mentionsSelf` 或文字包含配置昵称；否则记 `not_mentioned`。触发后检查限流，再加载账号绑定的人设、读最近上下文、调用 `reply` 槽位、清洗并拆分文本，最后按节奏经 adapter 发送并存下自己的消息，写一条最终决策。
3. `src/core/rate-limit.ts` 用内存时间窗口跟踪同一账号下的用户、会话和会话最小间隔。只有已被叫的消息才消耗额度；不符合条件时不请求模型、不发送，并把具体限流原因写入决策详情。它不需要 Redis 等外部服务，因为 M1 只运行一个本地进程。
4. `src/persona/load.ts` 从 `data/personas/<id>.md` 先找用户私有版本，再回退到仓库内 `personas/<id>.md`。默认人设可安全提交，用户修改留在 gitignore 的 `data/`；文件名只接受安全 ID，避免配置值变成任意路径。OneBot 登录校验后提供账号昵称，用来替换 `{{name}}`。
5. `src/core/prompt.ts` 把不变的人设、规则和会话补充按固定顺序放进一条 system 消息；最近 N 条历史则按本地时间 `[HH:mm] 名字: 内容` 拼成**一条** user 消息，bot 自己说过的话标作“你”。固定规则提醒模型口语短句、不用 Markdown、不声称自己是 AI 助手、不泄露设定，并区分主人指令；owner 为 0 时明确表示主人尚未设置。
6. `src/core/text.ts` 去掉常见 Markdown 外壳、链接 URL 和已知昵称前缀；若结果为空，记 `empty_reply` 并不发消息。`src/core/split.ts` 按中英文句末标点、换行和 Unicode 字符边界拆条；最多三条，溢出内容并入最后一条。这样不依赖第三方文本库，也不会把 emoji 的 UTF-16 半个代理字符切坏。
7. `src/core/pacing.ts` 只负责根据字符数计算延迟，不负责网络或状态：先夹紧 `600 + 字数×120ms` 到 800–6000ms，再乘 0.8–1.3 的随机抖动。pipeline 先标已读，私聊再设输入状态，每条发送前等待；这些等待和随机源可注入，让单测不真的睡好几秒。
8. 发送结果写回 `messages`，`is_self=true`，使之后的上下文能知道自己说过什么；群聊第一条用 reply 段引用原消息，后续拆分段不重复引用。每条输入最后都会有决策原因，包含 `disabled`、`not_mentioned`、`rate_limited`、`empty_reply`、`llm_error`、`send_error` 或 `replied`。

T6 没增加 npm 依赖：限流、文件读取、计时、SQLite 和测试分别使用 Node 内置模块；OpenAI-compatible 协议使用前面已经安装的 `openai` SDK。pipeline 单测用**真实临时 SQLite 文件**验证消息和决策落盘，但 OneBot 与模型均用假对象，不连账号、不发 API 请求，也不读写 `data/`。最终 `npm run check` 实测为 70 项测试通过、0 失败。

真实端到端验收留给用户：编辑 `data/config.yaml` 启用一个测试会话、准备 `.env` 的模型 key、在 SnowLuma WebUI 手动加载账号后运行 `npm start`，验证被叫回复、群聊引用、禁用会话不答，最后用 Ctrl+C 关闭。`npm start` 会连接真实 QQ；被叫后会请求真实模型并可能产生费用，夜间没有执行。

## 10. 之后的阶段

T0–T6 是本轮范围；T7 看图、T8 离线补课、T9 管理指令及 T10 控制台仍属于后续计划，尚未实现，也不应把它们当作已验收功能。

每个章节都以实际代码和真实测试结果为准；还没实现的部分会明确标为“计划”，不把计划写成已完成事实。
