# Aquarium 施工导读：从骨架到 Impressions V4 M3

> 本文是随代码一起更新的学习材料。目标不是让你记住所有 API，而是让你能回答：程序分成哪些部分、每一层负责什么、为什么选这些库，以及每个任务怎样验证。前文记录 T0–T6、阶段 B 的 R1–R9、阶段 C/D、M2-A A1–A6 和 §9.0 U1–U4；§15 补充 2026-10-20 的 V18f 图片认知和 §13 P1–P6 隐私记忆；§16 补充 2026-10-21 的 S1–S4、K1–K3 与 Impressions V4 M1–M3。M4–M8 和 R9 尚未在本节覆盖。真实 SnowLuma/QQ、模型、Windows GUI 与用户验收仍按各自清单执行。
>
> 自动化测试和生产构建不等于真实运行验收。夜间运行不会替代真实 SnowLuma/QQ、模型、Windows GUI 或控制台体验确认。

## 1. 先建立整体地图

Aquarium 想做的是一个能在 QQ 群聊和私聊中工作的 AI 群友。项目不会让每个功能都直接操作 QQ，而是把“聊天规则”和“QQ 协议细节”分开：

```text
SnowLuma / OneBot WebSocket
            ↓
 @snowluma/sdk（外部协议客户端）
            ↓
 src/adapters/onebot（把 OneBot 翻译成 Aquarium 接口）
            ↓
 src/core/shared/events.ts（Aquarium 自己的消息词汇）
            ↓
 src/core/conversation/pipeline.ts（判断是否回复、如何回复）
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

T0 的自动测试在 `os.tmpdir()` 下创建临时的假 SDK 目录，验证补 `.js`、使用 `index.js`、保留未命中路径、只改目标包以及第二次运行不再修改。它不连接 SnowLuma，也不会把夹具留在仓库里。

## 4. T1：logger、边界和测试为什么这样安排

### logger

`src/core/logger.ts` 提供 `createLogger(scope)`，统一生成时间、级别、模块名和消息，并追加到 `data/logs/aquarium-YYYY-MM-DD.log`。它使用 Node 内置的 `node:fs` 和 `node:util`，因此这部分**不需要新增 npm 日志库**。

日志格式统一后，排查错误时可以快速看出“什么时候、哪个模块、什么级别”。单元测试不会往真实 `data/` 写文件：它在 `os.tmpdir()` 下建立临时工作目录，启动子进程，并在测试结束时删除。这样既验证真实文件写入，又不污染用户数据或仓库。

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

SnowLuma 的事件类型属于外部 SDK；如果核心代码到处使用它，换掉 SDK 就会牵动全项目。因此 `src/core/shared/events.ts` 定义 Aquarium 自己的数据结构：

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

测试把所有读写都放在 `os.tmpdir()` 下的 `aquarium-config-*` 临时目录，结束时删除；不会读取或写入真实 `data/`。测试覆盖示例配置、非法配置、字段继承/数组替换、首次复制、写入覆盖、失败保留、无效热重载和有效 `changed` 事件。T3 检查点的实际结果是类型检查与边界检查通过、30 项测试通过、0 失败。

密钥只保存环境变量名称（如 `DEEPSEEK_API_KEY`），配置 YAML 不应出现真实 API key。之后模型客户端从环境变量读取实际值；不要把 `.env` 放入版本控制。

## 7. T4：SQLite 数据库和仓储

SQLite 是一个把数据库存进本地文件的嵌入式数据库。当前 Node 提供 `node:sqlite`，因此 T4 没有新增数据库 npm 依赖。`DatabaseSync` 是同步 API：代码调用后立刻得到结果，适合 Aquarium 当前简单、本地的数据库操作；不要把长时间网络请求放进数据库事务里。

存储分为两层：

1. `src/store/db.ts` 只负责打开 `data/aquarium.db`、启用 WAL、创建 `schema_version` 并按序执行迁移。迁移在事务里运行：建表成功才把版本号推进；失败则回滚。下一次启动不会重复执行已完成的版本。
2. `src/store/repository.ts` 只负责把 Aquarium 数据映射到 SQL 表。它从外部接收已打开的数据库连接，不自己开第二个连接；SQL 使用 `?` 参数绑定，避免把消息文本拼进 SQL 字符串。

第一版四张数据表分别保存消息、模型用量、图片描述缓存、回复决策。消息表的 `(session_id, message_id)` 唯一约束避免同一会话消息重复落库；`(session_id,time)` 索引让“取某会话最近 N 条”不用扫描整张表。最近消息先取最新 N 条，再反转为旧到新，便于之后直接拼成上下文。图片描述按 key upsert；用量按**本机时区**的当天零点到次日零点汇总，结束时间不包含次日零点，因此跨夏令时的日期长度也正确。

SQLite 测试使用 `os.tmpdir()` 下 `aquarium-store-*` 的**文件数据库**，因为真实程序同样使用文件和 WAL，而不是只用内存 DB。Windows 会锁住仍打开的数据库文件；所以测试必须先 `DatabaseSync.close()`，再删临时目录。T4 的数据库/仓储测试覆盖迁移可重复启动、WAL、表/索引、消息排序和去重、自然日用量、图片缓存 upsert、决策最近记录。T4 checkpoint 时 `npm run check` 实测为 36 项测试通过、0 失败。

## 8. T5：模型槽位、容错与预算

项目已经有依赖 `openai@6.40.0`，不需要再为 DeepSeek 单独安装一个 SDK。OpenAI SDK 支持 `baseURL`，因此 `src/llm/client.ts` 能用同一客户端访问 OpenAI-compatible 服务商；配置里只写 `apiKeyEnv` 环境变量名，真实 key 由 `.env` 提供，错误信息也只指出缺少哪个变量，不打印 key。客户端按 provider 缓存，provider 的地址或变量名更改后会重建。

`src/llm/slots.ts` 将“回复、判断、识图”等用途称为槽位；每个槽位配置有序模型列表。例如 `reply` 先试主模型，遇到可恢复故障再试降级模型。SDK 自带重试被关闭，原因是每次真实尝试都要产生一条 `usage` 记录，否则 SDK 在内部重试会让账单和日志对不上。默认单次请求超时 30 秒；408、429、5xx、连接错误和超时会尝试下一项；400/401/403/404 等配置、权限或请求错误会原样抛出，不用另一个模型掩盖问题。每个失败尝试也写入 `ok=false`、零 token 的记录。

成功结果会解析 prompt/completion token 和缓存 token。模型价格按每百万 token 配置，估算方式为“未缓存输入 × input 价 + 缓存输入 × cachedInput 价 + 输出 × output 价”，再除以一百万；价格项缺失时发请求前 fail-closed，避免把未知费用当作 ¥0。`budgetState(config, costToday)` 在 80% 预算处进入 `warn`，达到 100% 进入 `exceeded`；超限时 `reply` 仍然可以回复，但只调用降级链最后一项（示例中是 `deepseek-flash`）。

单测用假客户端返回假响应或抛假 HTTP/网络错误，不读取真实密钥、不发网请求。T5 完成后的 `npm run check` 实测为 47 项测试通过、0 失败。

真实模型连通性单独留给用户手动执行：在 `.env` 填 `DEEPSEEK_API_KEY` 后运行 `npm run spike:llm-ping`。该脚本会真实请求一次 `reply` 模型并估算费用；不要把 `.env` 或 key 发给他人。夜间施工没有运行此脚本。

## 9. T6：从收到消息到自然回复

T6 把前面做好的配置、OneBot 适配器、SQLite 和模型槽位串成一条消息管线。新增代码按职责拆开，不让一个大文件同时懂 QQ 协议、数据库、提示词和回复排版：

1. `src/app/main.ts` 是装配入口：读取配置、开数据库、启动配置 watcher、为每个账号建立 OneBot adapter、连接并把消息交给 pipeline。收到一条消息时，pipeline 通过 getter 取**当前**配置，所以启用开关、昵称、人设、提示词补充和模型槽位的热重载对下一条消息生效。运行时改账号列表或 SnowLuma 路径不会自动重连，入口会提醒重启。
2. `src/core/conversation/pipeline.ts` 是业务顺序的协调者：先把收到的消息存起来；会话关闭就记录 `disabled`；私聊直接算被叫，群聊必须 `mentionsSelf` 或文字包含配置昵称；否则记 `not_mentioned`。触发后检查限流，再加载账号绑定的人设、读最近上下文、调用 `reply` 槽位、清洗并拆分文本，最后按节奏经 adapter 发送并存下自己的消息，写一条最终决策。
3. `src/core/rate-limit.ts` 用内存时间窗口跟踪同一账号下的用户、会话和会话最小间隔。只有已被叫的消息才消耗额度；不符合条件时不请求模型、不发送，并把具体限流原因写入决策详情。它不需要 Redis 等外部服务，因为 M1 只运行一个本地进程。
4. `src/persona/load.ts` 从 `data/personas/<id>.md` 先找用户私有版本，再回退到仓库内 `personas/<id>.md`。默认人设可安全提交，用户修改留在 gitignore 的 `data/`；文件名只接受安全 ID，避免配置值变成任意路径。OneBot 登录校验后提供账号昵称，用来替换 `{{name}}`。
5. `src/core/prompt/index.ts` 把不变的人设、规则和会话补充按固定顺序放进一条 system 消息；最近 N 条历史则按本地时间 `[HH:mm] 名字: 内容` 拼成**一条** user 消息，bot 自己说过的话标作“你”。固定规则提醒模型口语短句、不用 Markdown、不声称自己是 AI 助手、不泄露设定，并区分主人指令；owner 为 0 时明确表示主人尚未设置。
6. `src/core/text.ts` 去掉常见 Markdown 外壳、链接 URL 和已知昵称前缀；若结果为空，记 `empty_reply` 并不发消息。`src/core/split.ts` 按中英文句末标点、换行和 Unicode 字符边界拆条；最多三条，溢出内容并入最后一条。这样不依赖第三方文本库，也不会把 emoji 的 UTF-16 半个代理字符切坏。
7. `src/core/pacing.ts` 只负责根据字符数计算延迟，不负责网络或状态：先夹紧 `600 + 字数×120ms` 到 800–6000ms，再乘 0.8–1.3 的随机抖动。pipeline 先标已读，私聊再设输入状态，每条发送前等待；这些等待和随机源可注入，让单测不真的睡好几秒。
8. 发送结果写回 `messages`，`is_self=true`，使之后的上下文能知道自己说过什么；群聊第一条用 reply 段引用原消息，后续拆分段不重复引用。每条输入最后都会有决策原因，包含 `disabled`、`not_mentioned`、`rate_limited`、`empty_reply`、`llm_error`、`send_error` 或 `replied`。

T6 没增加 npm 依赖：限流、文件读取、计时、SQLite 和测试分别使用 Node 内置模块；OpenAI-compatible 协议使用前面已经安装的 `openai` SDK。pipeline 单测用**真实临时 SQLite 文件**验证消息和决策落盘，但 OneBot 与模型均用假对象，不连账号、不发 API 请求，也不读写 `data/`。最终 `npm run check` 实测为 70 项测试通过、0 失败。

真实端到端验收留给用户：编辑 `data/config.yaml` 启用一个测试会话、准备 `.env` 的模型 key、在 SnowLuma WebUI 手动加载账号后运行 `npm start`，验证被叫回复、群聊引用、禁用会话不答，最后用 Ctrl+C 关闭。`npm start` 会连接真实 QQ；被叫后会请求真实模型并可能产生费用，夜间没有执行。

## 10. 阶段 B R1–R6：修复消息处理审查问题（已完成）

这一组任务没有增加 npm 依赖，主要是在已有的 TypeScript 纯逻辑、SQLite 仓储和 Node 内置能力上补足边界条件。阅读实现时，可以把每个测试理解成一条“以后修改代码也不能破坏”的具体约定。

### 10.1 R1：让长回复自然拆条

**为什么改：** 旧拆条规则会把短句也拆开、可能切断连续标点或半角小数点，也可能产生只有标点的消息。聊天回复应该尽量保持短句完整，同时不能丢字。

**实现：** `src/core/split.ts` 以 Unicode 字符计数；不超过 80 字就原样作为一条。长文本先按换行，再按中文及英文问叹号等终止标点拆分；连续终止标点视作整体，半角 `.` 不作为句界。之后贪心合并能放进 80 字的相邻片段；超长单句再按字符上限切开，最多三条，超出的内容并到第三条。因此第三条在触发“三条上限”时可以超过 80 字，这是在消息数量上限与不丢文字之间的取舍。

**测试怎样证明：** `test/split.test.ts` 检查短句原样保留、连续标点不单独成条、小数 `3.5` 不被误切、长句合并、emoji 不从中间切开，以及 200/250 字输入最多三条且拼回后与原文一致。R9 后，跨段落合并会保留一个计入长度的换行，同段落片段仍直接拼接。测试证明字符串结果符合边界，不证明 QQ 客户端怎样显示消息。

### 10.2 R2：只清理成对的格式标记

**为什么改：** 把所有 `*`、`_`、`~` 一律删除，会破坏颜文字或中文聊天内容；但模型有时会用 Markdown 包住回复，仍需要清掉外层格式。

**实现：** R2 先把“全局删标点”收窄为只清理成对格式标记；R8 随后确认中文聊天里的 `~~`、`__` 也可能是普通语气符号，因此当前 `src/core/text.ts` 只移除 `**重点**` 和 `` `代码` ``，保留 `~~删除线样式~~`、`__强调样式__` 以及单个 `*`、`_`、`~`。若只剩纯粗体/反引号格式标记，则仍返回空文本，让管线沿用 `empty_reply` 路径。实现只用 JavaScript 正则，不需要新增库。

**测试怎样证明：** `test/text.test.ts` 用 `好呀~~那走吧~~`、`好__耶__`、`(__) 趴下了`、单个标记、成对粗体、行内代码和纯格式回复逐项断言清理结果，也检查已知昵称前缀处理没有被破坏。R8 完成后的 `npm run check` 有 84 项测试通过。

### 10.3 R3：依据账号 ID 标记主人

**为什么改：** 仅在提示词里写主人 QQ 号会把账号信息交给模型，而且只看昵称无法确认发言者身份；昵称本身也可能含“主人”二字。

**实现：** `src/core/prompt/index.ts` 的参数使用 `ownerId`。只有 `ownerId` 非零且消息的 `senderId` 与之相等时，才在上下文说话人后加 `（主人）`；系统规则要求只相信这个标记。主人未设置（`ownerId === 0`）时则明确要求不要把任何人视为主人。主人 QQ 号不再写入 system 或 user 提示词。`pipeline.ts` 负责把配置中的主人 ID 传给提示词构造器；没有新增依赖。

**测试怎样证明：** `test/prompt.test.ts` 检查 system 与 user 内容都不包含主人 ID、匹配 ID 的发言得到标记、未设置主人时规则正确，也用昵称含“主人”的非主人样例说明判定来自 `senderId` 而不是文字。R7 又把所有非自己说话人昵称用 `JSON.stringify(name)` 包在引号里，并将真实主人标记放在引号外；固定规则说明引号内内容只是昵称。这样 `"张三（主人）"` 仍只是昵称，而 `"阿伟"（主人）` 才有系统添加的身份标记；昵称中的双引号会由 JSON 序列化转义。R7 后完整检查为 83 项通过。

### 10.4 R4：重复入站消息只处理一次

**为什么改：** WebSocket 重连或重复投递可能让同一条消息再次进入管线；如果不去重，机器人会重复调用模型、产生费用并重复回复。

**实现：** T4 已有 `(session_id, message_id)` 唯一约束。`src/store/repository.ts` 用 SQLite 的 `INSERT OR IGNORE` 忽略重复记录，并让 `saveMessage()` 返回布尔值表示是否新插入。`src/core/conversation/pipeline.ts` 在消息刚入库后检查该结果；若为重复，就记录 `reason='duplicate'` 并立即结束，不再读配置、调用模型或发送。依赖仍是项目已有的 `node:sqlite`，无需安装新库。

**测试怎样证明：** `test/repository.test.ts` 断言第一次保存返回 `true`、同会话同 ID 再保存返回 `false`；`test/pipeline.test.ts` 把同一输入交给管线两次，检查只调用模型并发送一次，第二次留下 `duplicate` 决策。

### 10.5 R5：同一会话按顺序处理消息

**为什么改：** 模型请求和发送都要等待。如果同一个群的两条消息并行处理，后到的回复可能先发出，或两条流程同时读取/修改会话状态。

**实现：** 新增 `src/core/session-queue.ts`，用内存 `Map` 为每个会话保存 Promise 队尾：同一会话排队执行，不同会话各自运行而不互相阻塞。队列只吞掉内部用于衔接的失败状态，调用者仍能收到原任务错误；这样一次失败不会卡住下一条。`src/app/main.ts` 将消息按 `sessionId` 放入队列；关机时先停止接收，再 `idle()` 等待在途任务完成，之后才关闭数据库。实现使用 Node/JavaScript 内置 Promise 和 Map，没有新增依赖。

**测试怎样证明：** `test/session-queue.test.ts` 用可控 Promise 检查同会话顺序、不同会话并行、前一个任务失败后队列仍继续，以及 `idle()` 确实等到所有任务结束。它测试队列本身，不需要连接 QQ 或真实模型。

### 10.6 R6：把测试临时文件放到系统临时目录

**为什么改：** 把 `.tmp-*` 测试目录放在仓库里，测试中断时可能留下垃圾文件、干扰 `git status`，还容易被误当成项目内容提交。

**实现：** 测试用 Node 内置 `node:os` 的 `os.tmpdir()` 配合 `fs.mkdtempSync()` 创建唯一的 `aquarium-*` 目录，并在结束时清理；需要删除 SQLite 文件的测试会先关闭数据库，避免 Windows 文件锁阻止清理。R6 涉及测试夹具，不改变 Aquarium 运行时行为，也没有新增依赖。

**测试怎样证明：** 对照 R6 的范围，13 处临时目录创建改到系统临时路径。回归检查仍运行相同的测试；验收还检查测试结束后仓库中没有 `.tmp-*`。R6 检查点记录 `npm run check` 的类型检查和边界检查通过、83 项测试通过，仓库无 `.tmp-*` 残留。

## 11. 阶段 B R7–R9：身份边界、聊天符号与段落边界（已完成）

R7–R9 是在 R1–R6 之后补上的第二轮审查修正。它们都没有新增 npm 依赖：分别使用已有的 JSON 序列化、正则清理和拆条模块。下面解释为什么要补，以及测试实际验证了什么。

### 11.1 R7：让昵称不能伪装成主人（已完成）

**为什么改：** R3 会在主人昵称后追加 `（主人）`，但如果非主人把群名片设为 `张三（主人）`，模型看到的上下文就可能把昵称文字误当身份标签。昵称是用户可控数据，不能把它直接拼成可信身份标记。

**实现：** `src/core/prompt/index.ts` 对所有非 bot 说话人的名字调用 `JSON.stringify(name)`，让昵称成为带双引号的 JSON 字符串；只有 `senderId === ownerId && ownerId !== 0` 时，程序才在字符串外添加 `（主人）`。bot 自己的行继续写成 `你`。system 规则也明确说明，引号内部只是昵称、不代表身份。JSON 序列化会转义名字中的双引号和控制字符，因此昵称不能闭合边界。该改动只用 JavaScript 内置的 `JSON.stringify`。

**测试怎样证明：** `test/prompt.test.ts` 检查伪装昵称只出现在引号内、真正主人标记在引号外、昵称中的双引号被转义、owner 未设置时无人被标为主人，并再次断言主人 ID 不在提示词中。R7 的 `npm run check` 实测为 83 项测试通过、0 失败。

### 11.2 R8：保留中文聊天里的 `~~` 和 `__`（已完成）

**为什么改：** 在中文聊天里，`~~` 常用来表达停顿、语气或玩笑，`__` 也可能出现在颜文字中。把它们当作 Markdown 删除线/强调格式清掉，会改写用户原文。

**实现：** `src/core/text.ts` 删除了清理 `~~x~~` 和 `__x__` 的规则，也不再把只有这两种符号的文本误判成“纯格式空回复”。当前只清理成对粗体 `**x**` 和成对反引号 `` `x` ``；单个 `*`、`_`、`~` 仍保留。实现不需要额外 Markdown 库。

**测试怎样证明：** `test/text.test.ts` 覆盖 `好呀~~那走吧~~`、`冲冲冲~~ 今晚~~`、`好__耶__`、`(__) 趴下了` 原样保留，同时确认 `**重点**` 和行内代码仍会清理。R8 的 `npm run check` 实测为 84 项测试通过、0 失败。

### 11.3 R9：跨段落拆条时保留换行（已完成）

**为什么改：** R1 会先按换行拆段，但贪心合并时只拼接字符串，来源于不同段落的文字会连在一起，读起来像同一句。

**实现：** `src/core/split.ts` 的片段现在保留首尾段落编号。合并时若前一片段的末段与后一片段的首段不同，就插入一个 `\n`；同一段落内仍直接拼接。长度判断使用 Unicode 字符数，因此跨段落插入的换行也计入 80 字限制。最多三条及最后一条合并溢出内容的 R1 规则仍然保留。

**测试怎样证明：** `test/split.test.ts` 用超过 80 字的构造输入验证跨段落合并保留换行，也用两个各 40 字、加换行后为 81 字的段落验证不会错误合并超限；同段落的原有合并与硬切测试继续通过。R9 后完整 `npm run check` 实测为 86 项测试通过、0 失败。

## 12. 阶段 C：从运行保障到本地控制台

C0–T10 的代码和单元测试现已完成；这不代表真实 QQ、SnowLuma、视觉模型或浏览器人工验收已经完成。夜间检查使用假适配器、隔离 SQLite 和假模型客户端，不能替代早上检查清单里的人工操作。

### 12.1 C0：环境变量示例不放真实密钥

`.env.example` 只列出程序需要的变量名、空值和用途说明。实际密钥由用户写入被忽略的 `.env`，不写进 YAML、源码、测试日志或提交。C0 的检查脚本逐项确认变量存在、值为空且有中文用途注释；这验证的是模板结构，不是密钥是否有效。C0 后 `npm run check` 为 86 项测试通过。

### 12.2 T7：只在触发消息时描述图片

`src/core/images/` 为当前触发消息中的每张未缓存图片调用 `vision` 槽位，生成不超过 30 字的说明并按文件标识或 URL 哈希缓存。构造历史提示词时不重新识图：有缓存用文字说明，无缓存用 `[图片]`。为避免向远程模型暴露本地任意文件，实现只接受 HTTP(S) 或图片 data URL；本地路径和读取失败都会降级，而不是访问磁盘。

`test/image-pipeline.test.ts` 用假模型验证缓存命中、多图、未触发消息、失败降级和本地路径拒绝；测试不发真实视觉请求。T7 后完整检查为 93 项测试通过。

### 12.3 T8：online 后补齐短时间离线消息

`src/core/history-catchup.ts` 在账号 online 时枚举启用会话并请求最近 50 条历史。只有最近 10 分钟内、数据库中尚不存在且满足触发条件的最新消息会进入正常会话队列；历史拉取等待不会阻塞实时消息。补课先入库再调用 pipeline，因此 pipeline 的 `alreadySaved` 选项避免重复写消息。

测试使用假历史和可控队列，覆盖过期、重复、最新触发消息和实时队列不阻塞；它不连接 QQ。T8 后 `npm run check` 为 99 项测试通过。

### 12.4 T9：主人命令复用会话状态

`src/core/management.ts` 在普通消息管线前处理 `/aq ping`、`/aq mute [分钟]`、`/aq unmute`、`/aq recall` 和 `/aq status`。权限只依据已校验的主人 ID；闭嘴按会话记忆并在期限后自动恢复。全局闭嘴状态通过同一控制器暴露给控制台，管理指令仍在会话队列中串行执行。

FakeAdapter 测试覆盖权限、闭嘴/恢复、撤回、状态和全局开关；没有向真实 QQ 发指令。T9 后完整检查为 107 项测试通过。

### 12.5 T9b：调试全文默认关闭并有保留期限

调试配置的总开关默认关闭，会话布尔覆盖优先；旧 YAML 缺少新 `debug` 字段时由 schema 填入安全默认值。SQLite 迁移 v2 新增 `debug_traces`；某会话启用调试后，`callSlot` 每次模型尝试（含失败）记录实际 messages、原始响应/错误细节和 prompt hash，决策中也保留 hash。启动时及每 6 小时清理超过保留期的记录，默认 7 天。调试写入失败不能阻断回复。

由于提示词可能含用户私密内容，启用前要确认该会话允许保存；默认关闭不等于脱敏，L0 脱敏仍是 M2 TODO。T9b 单测使用假模型客户端；没有真实模型调用。T9b 后完整检查为 115 项测试通过。

### 12.6 T10：把本地状态做成可观察的管理面板

`src/panel-server/` 用 Hono 注册 API、`@hono/node-server` 提供 Node HTTP 服务；主程序只有在 `AQUARIUM_PANEL_PASSWORD` 非空时才启动控制台，密码缺失或面板启动失败不会阻止机器人运行。明文 HTTP 仅绑定 `127.0.0.1` 或 `::1`；其他 host fail-closed。所有 `/api/*` 使用 Bearer 认证和等长摘要上的 `timingSafeEqual`，请求体在 JSON 解析前限制为 2 MiB。不要把面板改绑到 `0.0.0.0`；如需远程访问，先设计 TLS/反向代理与信任边界。

会话 PATCH 对每个字段做严格校验，`null` 删除覆盖项；配置由 `writeConfig` 原子替换，并同步更新 `ConfigWatcher`，因此下一条消息立即读取新值。人设 ID 限于小写字母、数字、下划线和连字符；导入使用排他创建避免覆盖冲突文件。决策/用量 API 读取 SQLite 仓储；撤回只允许唯一匹配到的 bot 自己消息。

`POST /api/sandbox/chat` 复用正式 `buildPromptMessages` 和 `reply` 槽位，会计入用量，但不调用适配器、不写 `messages`。它不会运行正式触发判定或频率限制，所以 UI 明确把它称为手动试聊，而不声称是完整 pipeline 干跑。owner 为 0 时 UI 禁用“主人”身份，后端也把 `asOwner` 降为普通群友。

前端依赖 Vite、React 和 TypeScript，密码只放 `sessionStorage`；401 清除会话并返回登录页。页面/视觉规范按 §4 实现，`panel/dist/` 忽略且不提交。账号人设绑定没有对应写 API，所以编辑页只读显示当前绑定关系。前端没有自动化测试；`npm run panel:build` 负责类型检查和生产构建。

T10 后 `npm run check` 实测为 126 项测试通过、依赖边界检查通过；`npm run panel:build` 成功。单测覆盖鉴权、loopback 限制、认证前请求体限额、PATCH 恢复继承和并发更新、真实临时配置读回、sandbox 无消息写入、owner=0、人设导入、决策 trace、全局闭嘴及 recall。夜间没有启动 `npm start` 或 Vite 服务，也没有浏览器人工验收；请按 `doc/plans/MORNING-2026-10-13.md` 操作。

### 12.7 R10：让决策记录能直接读懂

`GET /api/decisions` 为每条记录解析群名、好友备注/昵称；联系人查询失败或会话已不存在时退回 `sessionId`。仓储按 `(session_id, message_id)` 精确查找原消息，只返回前 60 个 Unicode 字符，未找到返回 `null`。`costCny` 只接受 `detail.costCny` 中的有限数字，否则是 `null`；`src/core/conversation/pipeline.ts` 在 `replied` 决策中记录本次 reply 槽位真实成本，因此零成本仍显示为 `¥0.0000`，缺失成本显示 `—`。

`panel/src/labels.ts` 将已知 reason 映射为中文与正向/中性/警示样式；`command_ignored` 单独显示“指令已忽略”，其他 `command_*` 显示“管理指令”，未识别原因保留原值。总览和决策列表 UI 不再显示专门列出的原始会话/消息 ID；若联系人信息缺失，`sessionName` 会按设计回退为 `sessionId`。API 仍保留这两个 ID 供调试追踪使用。测试覆盖群名、好友备注优先、联系人查询失败回退、复合键不跨会话匹配、缺原消息/非法费用、Unicode 60 字截断、replied 成本写入及前端标签/语气。R10 后 `npm run check` 通过 129 项测试，`npm run panel:build` 成功。

### 12.8 R11：把图片取回后再送视觉槽位

`src/core/images/` 通过 `downloadImageAsDataUrl` 下载 HTTP(S) 图片，默认 fetch 使用 10 秒 `AbortSignal.timeout`；只接受 `image/jpeg`、`image/png`、`image/gif`、`image/webp`，并同时检查 `Content-Length` 与流式实际字节数，最大 5 MiB。成功后构造 `data:<mime>;base64,...` 交给 vision；原本已是图片 data URL 的输入保持不变。

下载函数经 `MessagePipelineOptions.downloadImage` 注入，单测使用假的 `Response`/fetcher，不访问网络。超时、非 2xx、MIME 不支持、内容超限或下载异常都由现有图片错误路径记录，并让 vision 收不到原始链接、回复上下文只显示 `[图片]`。缓存命中在下载前短路。U2 还需用户确认真实 OneBot 图片 URL 可由本机下载，且配置的 vision 服务接受对应 data URL。R11 后 `npm run check` 通过 136 项测试，`npm run panel:build` 成功。

### 12.9 R12：把控制台的状态文案说清楚

所有页面标题上方的英文分类眉题已移除；会话详情把 `GROUP/FRIEND` 改成“群聊/好友”。总览按 `status.accounts` 计算账号数与 `connectionStatus === 'online'` 数量，显示“缸里有 N 条鱼，M 条在游动。”；零账号时单独显示“缸里还没有鱼。”。运行链路显示“QQ（小号）”。在移动断点内，`.header-actions .button` 设置 `white-space: nowrap`，避免“全部闭嘴”等按钮文字折行。

按 PLAN 要求，R12 不新增前端单测，以 `npm run panel:build` 做 TS/生产构建检查；整个任务也通过 `npm run check`。浏览器与真实运行验收留给 U2 清单，不会仅凭构建结果宣称已验证。

### 12.10 R13：限制图片下载的初始主机

`downloadImageAsDataUrl` 现在只接受 HTTPS，且初始 URL 的主机名必须等于或以点边界后缀匹配 `qq.com.cn`、`qq.com`、`qpic.cn`。因此 `multimedia.nt.qq.com.cn` 可下载，而 `evil-qq.com`、`qq.com.evil.cn`、HTTP 和 IP 地址会在 fetch 前拒绝，图片后续沿现有路径降级为 `[图片]`。

拒绝错误只携带 `hostname` 与 `IMAGE_HOST_NOT_ALLOWED`；`main.ts` 的错误摘要只记录主机名，不记录完整签名 URL。测试对允许/拒绝 URL 注入 fake fetch，确认拒绝时 fetch 未调用；未做公网请求，也未做 IP 解析或自定义 DNS。

**边界仍需注意：** Node `fetch` 默认跟随重定向，R13 只校验初始 URL、不会逐跳复核跳转主机。该残余 SSRF/重定向风险已记入 PLAN §6，没有在本任务增加未约定的机制。R13 后 `npm run check` 通过 137 项测试。

### 12.11 T12c：在 Windows host 接入真实托盘

`src/host/tray.ts` 保留宿主稳定的 `Tray` 接口；真实 `@trayjs/trayjs@0.0.10` 实例放在 `src/host/windows/tray-worker.ts` 的 Worker 线程中，主线程通过 message bridge 转发 host 状态、动态闭嘴状态与菜单动作。这样 helper 的异步 spawn/通信错误进入 Worker 错误通道，不把 trayjs helper 的 ChildProcess 事件泄漏为主线程未处理错误；helper/worker 失败记录 error、保持 bot 运行且不自动重建。父端 MessagePort 关闭时，worker 清理 tray 并 settle 在途菜单状态请求。

托盘使用已有青/黄/红双尺寸 ICO，菜单包含打开控制台、可选打开 QQ、全部闭嘴/恢复、重启 SnowLuma 与退出；无系统通知 API 时只更新 tooltip。显示 tooltip 与状态菜单文本分开管理，`ready` 时重新设置最新图标和当前显示文本。`bindHostTrayAfterLoad` 负责 shutdown race：延迟 worker 加载完成时若 host 已关闭则 dispose，不绑定回调。测试用 fake tray/worker 覆盖 helper ready、parent-port close、worker 错误、菜单动作及 shutdown queue。

T12c 质量门：`npm run check` 通过 211 项（TypeScript、依赖边界检查、211 tests），`git diff --check` 通过；精确 staged review fingerprint `f623dce543f1572d87a69902df8032f958bcebbe75e24e46540b28b7af415a3b` 通过。代码提交 `f5f2dcffa699de3a2a34bef0376054e5a1ab28df`，标签 `checkpoint/dev-host-t12c-code-2026-10-14-unverified`。本轮未运行真实 tray/helper、QQ、SnowLuma、GUI 或 `autostart:install`；Windows 用户验收步骤见 `doc/plans/MORNING-2026-10-14.md`。Reviewer 有一条非阻塞建议：异步菜单 refresh 与 dispose 并发还没有专项测试，留作用户集成验收观察项。

**面板启动 follow-up：**用户验收发现小号在启动时离线会使 `adapter.connect()` 等待，从而阻挡原先排在所有账号连接之后的管理面板启动。`main.ts` 现在先启动账号任务，随后立即启动面板，再继续 await 账号任务；面板仍有独立的密码环境变量 gate。Deferred-promise regression 验证账号连接未完成时面板启动回调已运行。`npm run check` 通过 212 项；精确 review fingerprint `9a7982774c5da99984a93647a8d3b88b664356c0cb752eea3b2fa9b1bcc9ea64` 通过；提交 `1f0f2b7668e5ffbaee08824de10b7527aa78bbfa`，标签 `checkpoint/dev-host-panel-startup-fix-2026-10-14-unverified`。还需用户在小号离线时实测面板端口先行监听。

### 12.12 阶段 D：区分宿主接口、空实现与真实托盘

PLAN §7.1 的托盘工作分成三个不同层次：先离线检查 T12a spike 和图标，再完成不含托盘的 T12b host，最后只给主程序接入一个 log-only `Tray` 实现。`src/host/tray.ts` 是接口边界；`createLogOnlyTray()` 让 `main.ts` 可以接上状态和生命周期，而不启动 helper 或改变桌面环境。这个阶段验证的是“宿主怎样调用托盘能力”，不是“Windows 托盘已经可见”。

后来的 T12c 才把真实 trayjs helper 放进 Worker；Worker/假托盘测试证明通信、错误隔离和关闭路径，但仍不能替代真实 Aquarium GUI 验收。对照阅读 `doc/plans/HOST-RESEARCH.md` 的阶段 D 证据表，再按 `doc/plans/MORNING-2026-10-14.md` 执行用户步骤：T12a 独立 spike 的四项 GUI 检查已经由用户确认；T12c 集成托盘和 autostart 仍待用户验收。

| 证据 | 能说明什么 | 不能说明什么 |
|---|---|---|
| `npm run check` 的 189 项结果 | 当时的 TypeScript、依赖边界和自动化测试通过；log-only 接线可由 fake 验证 | 不证明真实 helper、QQ、SnowLuma 或 Startup 文件夹行为 |
| T12c 的 211 项检查与独立 review | 被审代码快照的自动化行为和静态审查通过 | 不证明托盘图标在当前 Windows 用户会话出现；review tag 仍为 `unverified` |
| 面板启动 follow-up 的 212 项检查 | 延迟账号连接期间，启动编排已允许管理面板先启动 | 不证明用户本机密码配置正确或真实端口已由用户复测 |

计划与证据索引：`doc/plans/PLAN.md` §7.1/§7.6、`doc/plans/HOST-RESEARCH.md`、`doc/plans/MORNING-2026-10-14.md`。阅读测试数字时应保留它们各自对应的提交，不把不同时间的 gate 相加或当成一次运行。

## 13. 之后的阶段

T0–T10 与 R10–R13 的代码和自动化检查均已完成；此前 T7/R11 图片下载切片的 U2 真实环境验收已由用户于 2026-10-14 完成，反馈无重大问题。T11 方案已由用户确认。dev/host 已完成 T12a spike、T12b host、T12c Aquarium trayjs worker 集成及面板启动 follow-up；T12a 四项 spike GUI 验收通过，T12b 测试账号可正常对话。M2-A A1–A6 与 §9.0 U1–U4 的代码切片和自动化验证均已完成；截至 2026-10-16，`npm run check` 通过 340 项测试，`npm run panel:build` 成功（30 modules）。真实 Aquarium Windows 托盘/QQ 与自启动、M2-A 真实 QQ/模型/成本验收，以及 U1–U4 控制台体验确认仍待用户；`autostart:install` 未执行。当前按 PLAN §9.0 停在停止点 U，不开始后续任务。

每个章节都以实际代码和真实测试结果为准；还没实现的部分会明确标为“计划”，不把计划写成已完成事实。

## 14. M2：活跃模式与会话设置

M2 不是另起一套聊天管线，而是在现有 pipeline 上增加可配置的群聊参与节奏，并让控制台能够查看、修改全局默认值和会话覆盖。

### 14.1 四种模式与时间表

`src/core/activity/mode.ts` 的 `resolveMode(settings, now)` 按本地时间选择第一个命中的 `modeSchedule` 项；时间段可以跨午夜，均未命中时回落到 `mode`。四种模式分别是：

| 模式 | 被叫时 | 未被叫的群消息 |
|---|---|---|
| `mention_only` | 回复 | 不做主动判断 |
| `natural` | 回复 | 按主动判断流程决定 |
| `active` | 回复 | 更积极地判断 |
| `busy` | 回复较慢、较简短 | 更少主动回复 |

被叫消息和私聊仍沿用正式消息路径；未被叫的群消息才进入主动判断。主控位置在 `src/app/activity-routing.ts`、`src/core/conversation/steps/gate.ts`，分离的策略模块位于 `src/core/activity/`。

### 14.2 主动判断不是一次模型调用

非 `mention_only` 的未被叫群消息先受预算限制，再经过攒批、空闲退避和零成本规则粗筛；只有通过这些关卡才调用 `judge` 槽位。`src/core/activity/batcher.ts` 使用安静窗口并有最长等待上限，`backoff.ts` 控制连续不回复后的退避，`prefilter.ts` 计算粗筛概率，`judge.ts` 严格解析模型 JSON，`threshold.ts` 按近期行为更新后续判断阈值。最终仍受每会话主动回复冷却和既有频率限制约束。决策原因、概率与阈值会进入可读记录和 trace。

这些限制把“是否值得主动说话”拆成可观察的规则步骤，避免每条群消息都调用模型；自动化测试使用 fake judge，不代表真实模型判断质量或真实群聊体验。

### 14.3 全局默认、会话覆盖与列表状态

- `src/panel-server/session-routes.ts` 提供受保护的 `GET/PATCH /api/defaults`。请求通过 schema 校验；PATCH 支持部分更新，嵌套 `rate` 只合并提交字段，再走原子配置写入与 watcher 热更新路径。
- `panel/src/pages/SessionsPage.tsx` 把“全局默认”固定在列表中；`panel/src/pages/SessionSettingsPanel.tsx` 复用设置表单，并区分继承与覆盖。会话选择和分组状态经 `localStorage` 安全读写；已不存在的会话会回落到有效列表项。
- `/api/sessions` 为每个会话提供 `lastMessageAt`，仓储以 `messages` 表的 `MAX(time)` 计算；列表优先呈现启用状态，再结合最近消息时间和名称稳定排序。
- 联系人读取时排除 bot 自身及昵称/备注完全等于“我的电脑”“我的手机”“我的Pad”“我的平板”的条目；这是 U3 在没有真实 QQ 调试数据时采用的计划回退规则，不表示已验证真实 `userId` 字段。过滤只影响列表展示，已有配置覆盖不会被删除。
- 私聊面板隐藏群模式和昵称配置，改为私聊说明及“对这个人的补充说明”；单个“每分钟最多”输入同步写入 `perUserPerMinute` 与 `perSessionPerMinute`。群聊仍保留原有群设置项。

### 14.4 测试边界与文件规模

为避免测试文件持续膨胀，pipeline 测试按普通消息、历史重放、主动判断拆到 `test/pipeline.test.ts`、`test/pipeline-replay.test.ts`、`test/pipeline-activity.test.ts`，共用夹具放在 `test/pipeline-test-helpers.ts`；OneBot 适配器测试按生命周期和公开行为拆到 `test/onebot-adapter.test.ts` 与 `test/onebot-adapter-contract.test.ts`，共用夹具放在 `test/onebot-adapter-test-helpers.ts`。结构拆分前两个旧测试文件合计 46 项均通过；拆分后定向回归仍为 46/46，全量 gate 为 340/340。

维护规则：代码文件超过 400 行就检查职责边界、停止继续堆无关功能；超过 600 行必须拆分。2026-10-16 的 Aquarium 代码文件清单（不含 `reference/` 只读目录）有 163 个文件，0 个超过 600 行；以下 8 个已超过 400 行，后续新增前先评估拆分或转移职责：

| 文件 | 行数 | 当前处理 |
|---|---:|---|
| `test/panel-server.test.ts` | 539 | 接近上限；会话相关测试已分到 `panel-sessions.test.ts` |
| `src/adapters/onebot/adapter.ts` | 515 | 后续适配器改动先检查职责边界 |
| `src/store/repository.ts` | 464 | 新增仓储行为前检查是否应按领域拆分 |
| `src/panel-server/app.ts` | 445 | 会话路由已拆到 `session-routes.ts`，继续控制增长 |
| `test/debug-traces.test.ts` | 426 | 按功能增加测试时检查是否需要拆分 |
| `src/host/windows/snowluma-process.ts` | 413 | 后续 host 改动先检查生命周期边界 |
| `test/windows-host.test.ts` | 412 | 按行为域拆分测试，避免继续堆积 |
| `test/snowluma-webui.test.ts` | 404 | 后续认证与请求行为改动先检查职责边界 |

截至 2026-10-16 的 M2-A/U1–U4 验证，`npm run check` 包含 TypeScript、依赖边界检查及 340 项测试；`npm run panel:build` 完成前端类型检查和生产构建。该阶段没有启动 QQ、GUI、模型或 `npm start`。§9.0 的 U1–U4 仍等待用户在控制台确认；U3 设备联系人的真实字段也仍待确认。

## 15. V18f 图片认知与 M3-A 私聊隐私记忆（2026-10-20）

### 15.1 V18f：图片含义与收藏

`src/core/images/` 将输入图片归一为内容 MD5，并把识别结果按 `kind`、描述、文字可读性、vision 模型和模板版本写入图片缓存。GIF 会解码并选择关键帧，拼成 PNG 再交给 vision；缓存命中且模型/模板版本一致时不会再次下载或识图。OneBot 的 `mface` 被映射成收藏表情，重复收藏按内容指纹去重。重点测试在 `test/vision.test.ts`、`test/image-meaning.test.ts` 与 repository 测试；都使用假模型或临时 SQLite，不发送真实请求。

### 15.2 P1–P6：私聊事实的隔离与展示

迁移 v11 新增 `private_facts` 和 `privacy_runs`：事实带账号、主人、来源会话、关键词、证据、等级/来源、提及计数与状态；游标单独保存提取进度。`privacy.enabled` 默认开启，自动晋级阈值 `promoteMentions` 默认 3，L0 命中主动回避期 `avoidMinutes` 默认 10；配置校验、范围授权和文本长度校验在写入前执行。

私聊提取是异步且受预算限制的；模型失败、解析失败或预算超限不阻断正常回复。私聊回复只读取同一信息主人可见的事实，并限制为最多 6 条、合计 200 字；同一用户的群聊标签按策略单独合并。来源证据用于审计，事实内容不进入普通日志。

群聊路径先按当前群成员与关键词预筛，再用独立 privacy gate 判断。若未被叫的主动路径触及 L0，会跳过回复并进入 `avoidMinutes` 冷却；冷却期间后续主动发言（包括路由批次中的较早消息）都以 `reason='privacy_avoid'` 跳过。若被叫路径触及 L0，则照常生成回复，但只加入固定隐私规则、不注入条目文本。L0 原文不会进入群聊回复提示词；群聊决策/调试 trace 和日志仅保留条目 ID、等级等安全字段。已在本群出现的 L1/L2 按策略注入；未被聊到的 L2 仅在主人本人触发群聊回复时注入，最多 3 条。发送前还有 fail-closed 出口检查，检测到可能泄露的回复不会交给 adapter。只有信息主人本人的群聊提及计数，每个本地自然日对每条事实最多计一次；手动等级不会被自动晋级覆盖。

印象页的“私聊”分段读取好友和有效事实，可查看等级、计数及来源证据，支持手动等级、恢复自动、改字与软删除。`GET /api/privacy/:userId`、`PATCH /api/privacy/facts/:id`、`DELETE /api/privacy/facts/:id` 与其他 `/api/*` 共用 Bearer 鉴权；请求按账号隔离，API 响应中的事实文字、关键词、证据引文和名称都经过敏感文本遮蔽。

### 15.3 本地验证与验收边界

`npm run check` 运行 TypeScript、依赖边界检查和 `node:test`；隐私测试使用假模型、假适配器与临时 SQLite，覆盖策略、提取/注入、群聊守门/出口、主人提及、API CRUD、软删除及回避期内的真实 router+pipeline 批处理。R7 最终实测 `npm run check` 为 583/583；P6 的 `npm run panel:build` 成功，Vite 仍提示主 bundle 501.79 kB 略超默认 500 kB 阈值，私聊面板为独立 7.57 kB 动态 chunk。

这些门只证明离线代码路径；本轮未运行 `npm start`、真实 QQ/SnowLuma、模型或 GUI。私聊提取、群聊回避和等级变化的真实体验仍按 `doc/plans/PLAN.md` §13.8 由用户确认；面板没有做 GUI 视觉验收。

## 16. Impressions V4：结构整理、提示词前缀与标签分类 v2（2026-10-21）

本节补充 §16 夜间任务中已完成的 S1–S4、K1–K3 和 M1–M4。各任务的细项与停止点以 `doc/plans/PLAN.md` §16 为准；这里记录新目录的职责和关键设计，方便从当前代码继续阅读。

### 16.1 S1–S4：迁移与 core 的职责边界

- `src/store/db.ts` 负责打开数据库并按版本顺序执行迁移；每个版本的 SQL 变更在 `src/store/migrations/v01.ts` 至 `v18.ts` 中独立审查。新增 schema 时追加迁移，不改写已发布版本；迁移测试也验证版本连续、旧数据保留和重复打开的幂等性。
- `StoreRepository` 的接口与存储 DTO 位于 `src/store/repository-types.ts`，由 `src/store/repository.ts` 继续 re-export；实现文件聚焦查询组合和读写逻辑，避免契约堆叠继续扩大。
- 标签分类、适用范围、半衰期、subject 路径等纯规则位于 `src/core/impressions/tag-model.ts`，不依赖 SQLite。为避免 `store` 与 `core` 互相耦合，边界检查只给 `store` 到该纯模型模块开了一个明确白名单。
- 出没统计归 `src/core/profiles/presence.ts`，统计作息标签的协调归 `presence-service.ts`；`src/core/conversation/`、`shared/`、`prompt/` 等目录按职责组织会话、共同类型和提示词能力。

### 16.2 K1–K3：让可缓存前缀和上下文稳定

- system 消息保留慢变化的固定说明，随请求变化的 mode、心情、好感、私聊事实、画像标签、贴图候选和当前请求放进 user 消息尾部。提示词块 ID 与追踪结构保持不变，避免为了缓存重排而丢失可观测性。
- `src/core/conversation/context-window.ts` 为每个会话记住窗口起点：窗口未超过 `ceil(1.5N)` 时追加新消息；超出后回到最近 N 条；锚点被删或不在最近 2N 条时重新锚定。主动模式仍用 8 条窗口，历史 replay 仍按 messageId 截取。
- judge、extract、摘要、分类和隐私判断等多用途模板，把固定说明放在变化输入之前。对应测试比较不同输入的固定提示词前缀；这里调整的是顺序，不是规则措辞。

### 16.3 M1：标签分类 v2 与可验证写法

- `tag-model.ts` 是类别白名单、scope、半衰期及文本规则的唯一纯逻辑来源；API 和提取入口都执行 scope 校验。`schedule` 不能由模型写入，只由统计服务或主人手动创建。
- `topic`、`fandom` 用最多两级的 `subject` 路径加末级 `text` 表示主题；路径的每一级分别按 `tag_subjects` 的 canonical 名称与 aliases 归一。面板展示成 `游戏 › FPS › CS2`。群梗与口头禅必须是证据里的原话，长度上限 12，显示时加「」；其他标签去掉指定的喜好/习惯前缀，限制短名词，并拒绝被判定为作息的文本。
- migration v16 为旧群标签增加 `needs_reclassification`，保留旧分类并标记可重新整理的行；后台复用已有分类流程，逐批处理、合并同义项并清除已完成标记。迁移先检测 tags 表和回填所需字段；只有结构具备 `user_id`、`category`、`locked`、`status` 时才回填并建索引，避免把字段不全的历史库误当作可重分类。正式 schema v15 满足这些条件，会标记未锁定且未 superseded 的旧群标签。
- 统计服务用最近 90 个本地日的消息计算群和群友最活跃的连续三小时窗口；窗口占比至少 0.35 才生成标签。群标签用“最热闹”，群友用“最活跃”；群另按某星期占比至少 0.25 生成“周 X 最热闹”。不满足条件的统计标签连续三天后删除；模型生成的作息词会作为 `schedule_by_stats` 丢弃理由进入追踪。
- 标签正文、证据引文和提示块仍走原有敏感文本脱敏；仅名称显示路径按既定规则处理，不能把显示豁免扩展到标签内容。

### 16.4 M2：删除并不再学

- migration v17 新增 `tag_vetoes`，用账号、会话、对象、分类、规范化 subject 路径和规范化文本表达一次精确否决。删除标签与写入否决在同一事务完成；重复删除同一规范化标签不会堆出重复记录。删除否决只移除规则，不会立刻复活标签。
- `DELETE /api/tags/:id` 创建否决并硬删除标签；`GET /api/tag-vetoes?sessionId=` 只列出指定群的规则，`DELETE /api/tag-vetoes/:id` 撤销。UI 在标签 hover/focus 时显示 ×，标签详情也有“删除并不再学”；“印象数据”菜单可列出规则并撤销。
- 自动提取的 observe/new/contradict 和分类整理在落库前都按上述完整键精确匹配；subject 的每一级先按 canonical 名称/别名归一。命中后不写入并记录 `droppedTags` 的 `vetoed` reason；不会做语义相似匹配。所有正文/路径仍保留既有敏感文本脱敏。

### 16.5 M3：增量历史导入、确认预览与证据去重

- 历史导入每页先识别是否含数据库已存 messageId，仍先保存同页新消息，再停止继续翻页。增量模式（默认）只提取 `time > tag_runs.lastMessageTime`；“重新整理全部”忽略水位线，处理本次拉取时间范围内的全部消息。消息按 80 条分窗；一个窗口成功或按重试策略跳过后，水位线推进到该窗口最新时间；预算在下一窗口前中止时保留上一个水位线。
- 拉取和确认等待阶段不持有画像提取会话锁；用户确认时才取得锁。确认前显示新消息数和预估费用；预估为提取槽位最近 30 条 usage 记录的平均花费乘窗口数，没历史时显示“—”。确认期间水位线若变化，会刷新预览并要求再次确认。确认等待时各任务访问路径惰性检查 15 分钟 TTL；逾期转为 expired 并释放会话占用。已经拉取的消息仍在 messages 表。
- 任务及待确认预览保存在进程内存中；进程重启会丢失预览状态，不会删除已经落盘的消息。日常提取与历史整理共用证据 messageId 去重：重复证据不会增加 samples、追加 evidence 或刷新 lastSeen。

### 16.6 验证边界

M3 收尾实测：`npm run check` 通过 TypeScript、依赖边界检查和 **691/691** 项测试；`npm run panel:build` 成功（148 个模块），Vite 仍提示主 bundle **529.36 kB** 超过默认 500 kB 提示线。新增测试覆盖已存 ID 停页、增量/全量水位线、逐窗口推进、重复证据、确认前不提取、预览变化重确认、15 分钟释放和最近 30 次估价；假模型离线验证。M4 实现与边界见 §16.7。夜间均未运行 `npm start`、真实模型、QQ、SnowLuma 或 GUI；真实体验验收仍在 R9 后由用户执行。

### 16.7 M4：QQ 资料缓存、自述与受限提示注入

- OneBot adapter 只通过 `client.raw(action, params)` 调用计划列出的资料动作，并从响应中挑选允许字段；各动作沿用现有超时包装，单项失败变为该字段不可用，不增加重试或输出原始响应。`qq_group_profiles` 按账号/群、`qq_member_profiles` 按账号/群/用户隔离；打开群印象页时 24 小时 TTL 控制自动刷新，手动按钮强制刷新，成员名册成功后整组替换以清除过期成员。
- `get_stranger_info.long_nick` 只有在包含独立 MBTI 整词时才生成 `identity / self_report / confirmed` 标签；原始签名作为 `kind: signature` evidence，MBTI 变化会更新该标签，签名不再包含 MBTI 时只删除签名来源标签。否决机制仍生效；message evidence 与 signature evidence 是不同联合类型，重复 messageId 判重和分类引文处理不会把签名误当作聊天消息。
- 提示词只取群名片、群主/管理员身份和头衔；群名片/头衔先脱敏并 JSON 引用。性别、年龄、Q 龄、群等级、入群时间、最后发言时间及个性签名正文都不注入。当前群视图顶部常驻显示“群资料”和“QQ 资料”两块；群资料块显示人数、建群时间、群等级与简介，QQ 资料块显示不可用字段、荣誉、公告、精华数量、地区（固定“QQ 不提供”）及性别/入群时长两条构成条形图。成员详情也显示对应 QQ 资料；性别、年龄、Q 龄、等级与入群时间带锁标记。响应只公开筛选后的资料，签名 evidence、公告、简介、头衔等内容仍走原有脱敏路径。
- 项目运行依赖与只读 `reference/SnowLuma` 均仍标记 `@snowluma/sdk` 1.14.22；M4 按 PLAN 指定的 v2.0.3 action/schema 使用通用 `raw` 调用，没有升级依赖。假 adapter 与接口契约测试覆盖字段映射；由于夜间禁止启动 SnowLuma/QQ，真实运行兼容性仍未验证。
- M4 收尾实测：`npm run check` 通过 TypeScript、依赖边界检查和 **702/702** 项测试；`npm run panel:build` 成功（150 个模块），Vite 主 bundle **537.11 kB**，仍高于默认 500 kB 提示线。签名写入/更新/删除、否决、提示不含性别年龄、内容脱敏、缓存 TTL、手动刷新及构成统计都有离线测试。未进行 GUI 验收；R9 后用户执行 §16.4 体验清单。
