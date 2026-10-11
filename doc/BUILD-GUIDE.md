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

## 6. 后续章节

- T3：配置 schema、默认配置复制、继承、热重载和原子写；完成后补“配置错误如何处理”。
- T4：SQLite schema、迁移、仓储方法；完成后补“为什么用数据库、如何验证临时数据库”。
- T5：模型客户端、故障降级、用量和预算；完成后补“哪些错误应重试、为什么单测要假客户端”。
- T6：回复管线、人设、限流、文本整理和节奏；完成后补“从事件到回复的完整数据流”。

每个章节会以实际代码和真实测试结果为准；还没实现的部分会明确标为“计划”，不把计划写成已完成事实。
