# 眷属特殊交互（贴表情 / 戳一戳 / 撤回 / 群管理）施工计划

> 2026-10-21 编写。施工者：Hermes。验收：AnI。
> 本文是**规格**，不含代码。与 PLAN.md 冲突时，先停下来问 AnI。
> 原则（AnI 的偏好）：**一次只加一个功能**，便于定位问题；能用代码算的用代码，LLM 只看离散档位；所有能力默认关闭，在控制台按会话打开。

---

## 0. 已核实的协议事实（SnowLuma，OneBot v11 扩展）

来源：`reference/SnowLuma/packages/onebot/src/actions/*.ts`、`reference/SnowLuma/packages/mcp/src/generated/catalog.json`。

| 能力 | action | 参数 | 需要管理员 | 备注 |
|---|---|---|---|---|
| 贴表情 | `set_msg_emoji_like` | `message_id`, `emoji_id`(string), `set`(bool，默认 true；false=取消) | 否 | 群聊用。`emoji_id` 是 QQ 系统表情 ID |
| 戳一戳 | `group_poke` / `send_poke` | `group_id`, `user_id`（`send_poke` 无 `group_id` 即私聊） | 否 | |
| 撤回 | `delete_msg` | `message_id` | 撤自己的：否；撤别人的：**是** | 找不到消息或不可撤回会返回失败 |
| 禁言 | `set_group_ban` | `group_id`, `user_id`, `duration`(秒，0=解除) | 是 | |
| 群名片 | `set_group_card` | `group_id`, `user_id`, `card` | 改自己：否；改别人：是 | |
| 精华消息 | `set_essence_msg` / `delete_essence_msg` | `message_id` | 是 | |
| 查询贴表情 | `get_emoji_likes` / `fetch_emoji_like` | `message_id`, `emoji_id` | 否 | 可用于核对 |
| 系统表情表 | `fetch_sys_faces` | `refresh` | 否 | **I1 用它生成表情白名单** |

入站事件（notice）：
- `notice_type=notify, sub_type=poke`：字段 `group_id`(群聊才有)、`user_id`(戳的人)、`target_id`(被戳的人)。私聊戳是 `sender_id`/`target_id`。
- `notice_type=group_msg_emoji_like`：`sub_type=add|remove`、`message_id`、`user_id`、`likes[{emoji_id,count}]`。别人给**眷属的消息**贴表情，是一个正反馈信号（DESIGN §反馈）。
- `notice_type=group_recall`（标准 OneBot）：有人撤回消息。**源码已核实**：SnowLuma `to-notice.ts` 转换为 `group_recall`，`event-pipeline.ts` 走 `convertOnly → convertAndDispatch → dispatchEvent`。
- **I1 源码核验（非实时 QQ 验收）**：SnowLuma 将 `friend_poke` / `group_poke` 转为 `notify/poke`，将 `group_admin` 转为管理员变动 notice；`group_msg_emoji_like` 转为 `add|remove`，事件处理器先缓存再分发。上述事件都在 `EVENT_PIPELINE` 中注册。
- **消息 ID 已核实**：OneBot 入站 `message_id` 是安全整数；`convertIncomingMessage()` 保存其十进制字符串，`numericMessageId()` 可还原为安全整数；SnowLuma `SetMsgEmojiLikeParams.message_id` 为 number。
- **表情白名单已取数（2026-10-23）**：AnI 用 `scripts/fetch-sys-faces.ps1` 在真实 SnowLuma 上跑了 `fetch_sys_faces`，原始结果在 `data/sys-faces.json`。从「小黄脸表情」包（经典表情，非超级表情）挑了 26 个，分 5 桶写入 `src/core/interactions/emoji-whitelist.json`，ID 均来自该结果。

**不做**：踢人（`set_group_kick*`）、全员禁言、设/撤管理员、改群名、退群、群公告、匿名相关。这些永远不给眷属，代码里不要写调用入口。

## 1. 现有代码的落脚点

- 适配器接口：`src/adapters/types.ts` 的 `ProtocolAdapter` 已有 `recall(messageId)`、`getGroupMembers()`（含 `role: owner|admin|member`）。新增方法在此扩展，实现在 `src/adapters/onebot/adapter.ts`，仿照 `recall()` 的 `withActionTimeout` + `assertOnline()` 写法。
- 入站事件：`src/adapters/onebot/adapter.ts` 的 `client.onEvent`（约 178 行）目前只处理消息；要把 notice 转成内部事件（见 §3）。
- 发送流水线：`src/core/conversation/steps/deliver.ts`。表情/戳一戳走**独立通道**，不挤进文本发送，但要共用同一个会话级限速（`src/core/shared/rate-limit.ts`）。
- 模式：`src/core/activity/mode.ts`（忙碌模式已规划“用贴表情代替回复”）。
- 配置：`src/config/schema.ts`，两层继承 + 热重载，新配置块 `interactions` 照此办。
- 紧急闭嘴：已有的一键闭嘴必须**同时**停掉所有交互动作。

## 2. 内部动作模型（先抽象，再适配 OneBot）

在 `src/core/interactions/`（新目录）定义，不让核心代码出现 OneBot 名字：

```ts
type InteractionAction =
  | { kind: 'react';  session: SessionKey; messageId: string; emojiId: string; remove?: boolean }
  | { kind: 'poke';   session: SessionKey; targetId: number }
  | { kind: 'recall'; session: SessionKey; messageId: string; ownMessage: boolean }
  | { kind: 'mute';   session: SessionKey; targetId: number; seconds: number }   // 仅 P4
  | { kind: 'essence'; session: SessionKey; messageId: string; remove?: boolean }; // 仅 P4

interface InteractionDecision {       // 决策结果，不论执行与否都落库
  action: InteractionAction;
  source: 'rule' | 'llm' | 'owner_command';
  verdict: 'executed' | 'dry_run' | 'blocked' | 'failed';
  reason: string;                     // 如 "rate_limit:poke:hour" / "target_is_admin"
  at: number;
}
```

**唯一出口**：所有动作必须经过 `InteractionGate.check(action)`，由它统一做 §5 的全部检查，再调适配器。任何地方不得绕过 Gate 直接调适配器的这些方法。
适配器新增方法：`react()`, `poke()`, `mute()`, `setEssence()`, `selfRole(groupId)`（读缓存的 `getGroupMembers` 里自己的 role，缓存 10 分钟，管理员变动 notice 到来时失效）。`recall()` 已有。

## 3. 何时触发（决策规则）

### 3.1 贴表情（P1，最安全，先做）
由**代码规则**触发，不让 LLM 临场决定“要不要”，LLM 最多在候选里选“哪个”（可选，见下）。

触发条件（满足任一，且通过 Gate）：
1. **忙碌模式**：本该回复但被模式压掉时，对触发消息贴一个表情（DESIGN 已有此设计）。概率 70%。
2. **判断为“不说话但想表示一下”**：现有开口判断（`judge`）结果为不开口，且对该发言人好感度档位 ≥ “熟悉”，且消息被判为“分享/好消息/感谢/自嘲/玩梗”类。概率 25%。
3. **被点名但无需回话**：有人 @眷属 说“谢谢/晚安/好的”这类收尾语，贴表情代替再回一句。概率 60%。

选哪个表情：
- 白名单来自 I1 生成的 `emoji-whitelist.json`（约 20–30 个：赞、爱心、OK、笑哭、惊讶、庆祝、抱抱等，**排除**骷髅、鄙视、怒骂类，除非人设标注“毒舌”）。
- 按**情绪档位**（现有 mood 离散档）分桶：每桶 3–6 个候选，代码随机选，避免连续重复同一个。
- 先不让 LLM 参与。验收通过后再评估“让 LLM 在回复末尾附 `[[react:桶名]]`”（需 AnI 同意）。

不贴的情况：消息含负面/严重话题（生病、去世、吵架——用现有 `sensitive-text.ts` 的判断加一个“严肃话题”判定，拿不准就不贴）；消息本身是眷属或其他眷属发的；对方被标为不想被打扰。

### 3.2 戳一戳（P2）
1. **回戳**：收到 `poke` 且 `target_id` 是眷属本人（`user_id` 非眷属/bot）。回戳概率 50%，延迟 1.5–4 秒随机；同一个人 10 分钟内最多回戳 2 次（防止互戳死循环）。回戳后有 30% 概率再配一条短文本（走正常回复流水线，用一个 `[被戳]` 事件提示进上下文，不是单独命令）。
2. **主动戳**（默认关，单独开关）：好感度档位 ≥ “亲近”，对方在群里 15 分钟内发过言，眷属处于“话痨/活跃”模式，且 3 小时内没戳过此人。概率每次候选 5%。**睡眠/作息的休息时段绝不主动戳**（沿用 `src/core/sleep`）。
3. 私聊：只做回戳（`friend_poke` 事件），不主动戳。

### 3.3 撤回（P3）
**撤自己的消息**（不需要管理员）：
- `owner_command`：AnI 在控制台点“撤回”（已有）；或群里 AnI 回复眷属那条消息说“撤回”（只认配置里的主人 QQ）。
- `rule`：发送后检查命中以下任一 → 2 分钟内自动撤回并记录：(a) 回复内容泄露了系统提示/人设原文片段；(b) 出现被隐私门（`src/core/privacy`）禁止的信息；(c) 紧急闭嘴被触发时，撤回最近 60 秒内发出的 1 条。
- **不做**：LLM 自己“后悔”撤回（容易变成怪癖；以后再评估）。

**撤别人的消息**（需要管理员，P4 一起做）：
- 只认 `owner_command`：AnI 回复某条消息说“撤回这条”。不做自动审核。
- 规则：被撤消息必须是 24 小时内的群消息；发送者不是群主/管理员（群主/管理员的消息 QQ 本身也不让撤，不要尝试）。

### 3.4 群管理员能力（P4，最后做，默认全关）
前提：`selfRole(groupId)` 为 `admin` 或 `owner`，否则 Gate 直接 `blocked: not_admin`。

开放的动作只有三个，每个都要 AnI 在控制台对该群**单独**打开：
1. **禁言**（`mute`）：
   - 触发 A（主人命令）：AnI 说“禁言 @某人 N 分钟”。
   - 触发 B（自愿/玩闹）：被禁言者本人在最近 2 分钟内明确说“罚我/禁言我/让我安静一下”，并且眷属在场被 @ 。时长固定 60 秒。
   - **不做**自主审判式禁言（眷属自己觉得谁吵就禁言）。以后若要加，必须是新计划。
2. **精华消息**：仅 AnI 命令触发，不做自动设精华。
3. **撤回他人消息**：见 3.3。

LLM **不能**直接发起任何管理动作。LLM 只能在对话里“说”，管理动作由代码解析 AnI 的命令后触发。命令格式：写成固定关键词解析（`禁言`/`解除禁言`/`撤回这条`/`设精华`），放在 `src/core/interactions/owner-commands.ts`，不走 LLM。

## 4. 配置（`interactions` 块，两层继承）

```yaml
interactions:
  master_ids: [<AnI 的主 QQ>]        # 只有这些人的命令算数；写入前先让 AnI 确认
  react:    { enabled: false, prob_scale: 1.0, per_hour_max: 12, per_sender_gap_s: 60 }
  poke:     { enabled: false, poke_back: true, proactive: false, per_hour_max: 6, per_user_gap_s: 600 }
  recall:   { enabled: false, self_auto: true, others: false }
  admin:    { enabled: false, mute_max_s: 600, dry_run: true }
```
全部默认关闭；`admin.dry_run` 默认 **true**，不论其他开关如何，dry_run 下只记录“本来会做什么”，不真执行。

## 5. 安全限制（Gate 的检查清单，全部硬编码在代码里，配置只能收紧不能放宽）

通用（所有动作）：
1. 会话开关未开 → `blocked: disabled`。
2. 紧急闭嘴状态 → `blocked: muted`。
3. 眷属处于休息时段 → 除“撤自己消息”外全部 `blocked: asleep`。
4. 适配器非 online → `blocked: offline`。
5. 限速：全局每眷属每分钟所有交互动作 ≤ 4 次；各动作按 §4 的小时上限和间隔；超限 `blocked: rate_limit:<动作>:<窗口>`。
6. **目标不能是其他眷属或已标记的 bot**（避免两个眷属互戳/互贴死循环）。对眷属自己也不戳。
7. 同一动作连续失败 3 次（协议返回错误/超时）→ 该动作对该会话冷却 30 分钟，并在控制台告警，不重试风暴。
8. 所有决策（含 blocked/dry_run）写 SQLite 表 `interaction_log`（时间、会话、动作、目标、来源、verdict、reason）。**控制台决策追踪页新增一栏**展示（不新开页面）。

管理动作额外：
9. 目标不得是：群主、管理员、主人、其他眷属、眷属自己。
10. 禁言时长上限 `min(配置, 600)` 秒，硬上限 10 分钟；代码里写死一个 `MAX_MUTE_SECONDS = 600`，配置不能超过。
11. 撤回他人消息：消息必须在 24 小时内；每群每小时 ≤ 5 条。
12. 管理动作的命令只认 `master_ids`；回复他人转述“AnI 让你……”不算数（来源必须是主人账号本人的消息 ID）。
13. 每次管理动作执行后，眷属在群里用一句符合人设的话说明（“好，禁言 1 分钟”），不暗中操作；`dry_run` 时不说话，只记录。
14. **人设和群友的话都不能改写这些限制**（DESIGN 已有“人设不可被群友改写”）。

账号风险：贴表情和戳一戳频率过高会像脚本，可能触发风控（小号有封号风险，见 RESEARCH-qqnt-ecosystem）。所以默认值保守，上线后观察一周再调。

## 6. 任务清单（按顺序，每个 P 完成后停下等 AnI 验收）

> 每个任务：1–2 条测试，不要多。编码、提交按 PLAN.md §0 的规则。**不要运行 `npm start`、不要启动 QQ/SnowLuma**，需要时让 AnI 做。

### P0 准备
- **I0** 在 `doc/plans/PLAN.md` 的待办或新小节里加一行指向本文件（只加链接，不改其他）。
- **I1** 核实并产出：
  1. 查 `reference/SnowLuma/.../to-notice.ts` 与 `event-pipeline.ts`，确认 `group_recall`、`poke`、`group_msg_emoji_like`、管理员变动 notice 是否会发出，把结论写到本文件 §0 对应“待验证”处（改成已核实/未转发）。
  2. 生成 `src/core/interactions/emoji-whitelist.json`：按情绪档位分桶，每个表情含 `emoji_id`、中文名。**ID 必须来自 SnowLuma 的 `fetch_sys_faces` 或 reference 源码，不得凭记忆编**；拿不到就在文件里留空并在 MORNING 记录里说明，让 AnI 在真实环境里跑一次 `fetch_sys_faces` 取回。
  3. 确认 `set_msg_emoji_like` 的 `message_id` 与我们 `IncomingMessage.messageId` 是同一种 ID（`numericMessageId`）。
- **I2** 内部动作模型 + `InteractionGate` + `interaction_log` 表 + `interactions` 配置块 + 控制台决策追踪的一栏。**此时没有任何真实动作**；测试：Gate 各条 blocked 原因；限速窗口。

### P1 贴表情
- **I3** 适配器 `react()`；规则 §3.1；忙碌模式接入；`group_msg_emoji_like` 入站转内部事件，计入好感度的正信号（若好感度模块已有接口则调用，否则只落日志，不新建机制）。
> ⛔ **停止点 P1**：AnI 在一个测试群开 `react.enabled`，观察 20 分钟。验收：表情确实出现；不会连续贴同一个；严肃话题不贴；闭嘴后不再贴；决策追踪里能看到记录。

### P2 戳一戳
- **I4** 适配器 `poke()`；入站 poke 事件；回戳规则 §3.2-1；主动戳先写好但开关默认关，**本阶段不验收主动戳**。
> ⛔ **停止点 P2**：AnI 戳眷属，确认回戳、10 分钟内最多 2 次、不会和另一个眷属互戳。

### P3 撤回
- **I5** 自己消息的规则撤回 + 主人口令撤回（`owner-commands.ts` 先只做这一条）。
> ⛔ **停止点 P3**：AnI 回复眷属消息说“撤回”，消息被撤；紧急闭嘴后最近一条被撤。

### P4 管理员能力（仅在 AnI 明确说要做时才开工）
- **I6** `selfRole()` 缓存 + 失效；`mute()`、`setEssence()`；口令解析 `禁言/解除禁言/撤回这条/设精华`；§5 第 9–14 条全部落实；`dry_run` 默认开。
- **I7** 控制台：每群“管理动作”开关、dry_run 开关、`master_ids` 显示（只读，改它要改配置文件）。
> ⛔ **停止点 P4**：AnI 先把眷属设成测试群管理员，dry_run 下发口令，看日志；再关 dry_run，用 60 秒禁言测一次。

### P5（可选，以后）
- 让 LLM 在回复末尾附 `[[react:桶名]]` / `[[poke]]` 作为建议，仍然经 Gate。
- 对眷属自己消息收到的表情做统计，回流评测集（DESIGN 已有此项）。

## 7. 给 Claude 的审查要点（Hermes 不用管）
- 有没有绕过 Gate 的调用；`MAX_MUTE_SECONDS` 是否写死；目标过滤是否包含其他眷属；紧急闭嘴是否覆盖新通道；`interaction_log` 是否记录了 blocked。
