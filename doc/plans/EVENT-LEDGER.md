# 事件簿：群聊与私聊的上下汇总（方案稿，2026-10-23）

状态：已定稿，待 Hermes 实现。小号互通（ALT-ACCOUNT-MEMORY.md）作为第 0 步并入。

## 想覆盖的情况
群里发生了一件事 → 某成员私下来找眷属解释 → 眷属知道 ta 说的是哪件事 → 回到群里，眷属的认识也跟着更新。

## 现在为什么做不到
- 私聊里看不到群里刚发生的事：群 → 私聊只放行"这个人自己的群标签"（policy.ts 最后一条），群的近况、对话都不进私聊提示词。
- 私聊抽取只记"对方本人的事"，提示词明确写了"不记录别人的事情"（prompts/extract-private.md），所以对群事件的解释根本不会被存下来。
- 私聊 → 群：只有 L1/L2 能进群提示词，而抽取默认落 L0；L0 在群里会触发 group-gate 的"你对此一无所知"。

## 结构：像协调者 + 讨论串
- 「自我」= 每个眷属账号一本事件簿，不是额外的会聊天的模型，只是一个共享存储 + 路由规则（像协调者读各讨论串的摘要，再把需要的转给别的串）。
- 各会话 = 讨论串。群聊、私聊照旧各自有最近对话；它们往事件簿里写，按规则从事件簿里读。

### 往上：会话 → 事件簿
1. 群事件：群聊抽取窗口里多产出一类 `event`（标题 ≤ 16 字、摘要 ≤ 60 字、当事人、时间、来源群）。群聊内容本来就对群成员公开，按 group 来源存。复用现有 extract-tags 调用，不新增模型调用。
2. 事件注解：私聊抽取增加一类"关于某个群事件的解释"，挂到对应事件上，带 ownerId（主号）和级别。对方本人的私事仍走原来的私聊事实。

### 往下：事件簿 → 会话
3. 私聊里：与 X 私聊时，注入 X 所在群最近 48 小时的事件（≤ 3 条，优先与本条消息关键词重合的）。这样眷属知道"ta 说的是哪件事"。只给该群成员，不给群外的人。
4. 群聊里：注入本群最近事件，以及已放行的注解（见下）。注解永远不说出处，不出现"某某私下跟我说"。
5. 同一人（已链接小号）的私聊之间互通：同 ALT-ACCOUNT-MEMORY.md。

## 哪些能回到群里
| 内容 | 级别 | 回群 |
|---|---|---|
| 群里本来就发生的事 | 群来源 | 能 |
| 对方本人私事、情绪、秘密 | L0（默认） | 永不，群里照旧回避 |
| 对群事件的解释 | 见待定默认值 | 放行后能，不提出处 |
| 对方在群里自己说出来的私聊内容 | 由 promoteMentions 升 L1 | 能（现有逻辑） |

全部经过 policy.ts 的 `decide()`，只在那里加规则：
- group → private：新增"事件对该群成员可见"（target.peerId 是来源群成员时 allow）。
- private 注解 → group：沿用现有 L1/L2 allow、L0 deny，不另立。

## 私下解释的三种意图（雪定，2026-10-23）
私聊抽取给每条事件注解标一个 intent，直接对应 DESIGN.md 的 L0/L1/L2 含义：
| intent | 例子 | 级别 | 群里怎么用 |
|---|---|---|---|
| confide 只告诉眷属 | "跟你说，其实我那天…你别跟别人讲" | L0 | 永不回群，群里照旧回避 |
| clarify 此人的私下澄清 | 同一番解释发给好几个人，为了不让事情更乱 | L1 | 别人聊到这件事时可以接话、可以说"X 说过是…"，不主动开启 |
| advocate 请眷属出面 | "你帮我在群里说一下" | L2 | 可主动提起；并触发一次出面澄清（见下） |

判定规则：
- 抽取模型只在有明确线索时标 clarify/advocate（如"大家都误会了""我也跟别人解释了""帮我说一下"）；拿不准一律 confide。宁可少带，不替人说漏。
- 同一事件、同一人后来说"别说出去"，立即降 L0，并同步撤掉已入群的注解（沿用 4a 里"升级私聊事实时同步转述"的那套实时复核）。
- 对方之后在群里自己提起，照旧走 promoteMentions 升级。
- 出处：clarify/advocate 可以说是 X 的说法；confide 永不出现出处。

出面澄清（advocate）：
- 眷属先在私聊里回一句确认（"那我去群里说一下？"），对方肯定后才发；不确认不发。
- 每个事件最多出面一次；受现有积极模式频率限制、作息（睡着不发）和 budgetState 约束。
- 发言基于注解原意转述，不加料；转述文本经 redactSensitiveText。
- 面板事件簿里能看到每条注解的 intent/级别，并可手动改。

## 分步（定稿后转交接）
0. 小号互通（已写好）。
1. events / event_notes 表与迁移；群抽取产出 event。
2. 私聊注入群事件 + policy 新规则。
3. 私聊抽取产出注解（intent + 级别）+ 降级撤回 + 群聊注入。
4. advocate 出面澄清（私聊确认 → 群里发一次）+ 面板事件簿查看与改级别。
每步一个提交，跑 npm run check 与 npm run panel:build。

## 给 Hermes 的提示词
请读 E:\Teamworks\Aquarium\doc\plans\EVENT-LEDGER.md 和 E:\Teamworks\Aquarium\doc\plans\ALT-ACCOUNT-MEMORY.md，按 EVENT-LEDGER.md「分步」从第 0 步（即 ALT-ACCOUNT-MEMORY.md）做起，每步一个提交。若昨晚任务三（情绪心灵能量）还没提交，先收尾。隐私规则只在 E:\Teamworks\Aquarium\src\core\privacy\policy.ts 的 decide() 里加，不另立。相关代码：E:\Teamworks\Aquarium\src\core\privacy\（prompt.ts、group-gate.ts、mentions.ts、kin-relay.ts）、E:\Teamworks\Aquarium\src\core\impressions\（service.ts、extract.ts、prompt-blocks.ts）、E:\Teamworks\Aquarium\src\core\conversation\steps\context.ts、E:\Teamworks\Aquarium\prompts\extract-private.md、E:\Teamworks\Aquarium\prompts\extract-tags.md、E:\Teamworks\Aquarium\prompts\reply-system.md，级别含义见 E:\Teamworks\Aquarium\doc\plans\DESIGN.md 的 L0/L1/L2 表。迁移号接在当前最新之后。不运行 npm start，不启动 QQ 或 SnowLuma，需要时请 AnI 自己启动。每步完成后跑 npm run check 和 npm run panel:build。
