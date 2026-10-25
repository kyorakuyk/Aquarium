# 括号心声显示开关（INNER-VOICE-DISPLAY）

日期：2026-10-25　基线：7c6d171　决定人：AnI

## 背景

安达樱在 QQ 里频繁写整段括号旁白，比如：

> （看到那三个字，整个人僵在屏幕前，耳根一路烧到脖子，好半天才动手指）

原因（已读代码确认）：

1. `prompts/reply-system.md` 的 system 规则完全没提括号或旁白。安达的人设正文有大量身体反应和心理机制描写，模型就把这些写成了舞台旁白。小祀、Claude 那两份是在人设正文里自己禁掉的，并没有统一的机制。
2. `src/core/shared/split.ts` 不认识括号，只按段落和句末标点切。括号有时自成一条，有时夹在正文中间，最多 3 条、每条 80 字的限制也把括号算进去了。
3. `src/core/conversation/steps/deliver.ts` 把发出去的每一条原样 `saveMessage` 进历史，下一轮上下文里能看到自己写过的旁白，所以会越写越多。

## 决定

三档开关，`默认 = 轻量`：

| 档位 | 键值 | 发给 QQ 的内容 | 旁白去向 |
|---|---|---|---|
| 完整 | `full` | 保留旁白，但规整：每段旁白固定单独成一条，一次回复最多 1 段，不占分条上限 | 原样发出，也记成心声 |
| 轻量（默认） | `light` | 只保留短动作，比如（捂脸）（小声），≤ 8 字，最多 1 个，留在原句里。长旁白不发 | 长旁白记成心声 |
| 隐藏 | `hidden` | 一句旁白都不发 | 全部记成心声 |

- 人设给默认值，会话可以单独覆盖：会话设置 > 人设 > `light`。
- “心声”保存下来：面板能看到，也作为情绪评估（appraise）的参考输入。
- 历史里只存实际发出去的文字，心声不进回复上下文，避免自我强化。

## 实现步骤

### 1. 配置

- `src/persona/load.ts`：`speech` 加可选字段 `innerVoice: 'full' | 'light' | 'hidden'`。缺省时为 undefined，由解析链补成 `light`。非法值照现有风格报错（中文错误信息）。
- `src/config/schema.ts`：`sessionOverrideSchema` 加 `innerVoice: z.enum(['full','light','hidden']).optional()`。`sessionSettingsSchema` 不加，不强制全局默认。
- 写一个小函数 `resolveInnerVoice(sessionOverride, persona)`，返回最终档位。放在 `src/core/conversation/steps/` 附近，deliver 和 prompt 都用它。

### 2. 提示词（主手段，过滤只是兜底）

在 `prompts/reply-system.md` 加三个模板键，按档位注入一个（可以放在 persona 注入的 speech 块后面，见 `src/persona/injection.ts` 的 `speechBlock`）：

- `innerVoiceFull`：可以用全角括号写动作和心理，但每次最多一段，单独一行，放在说出口的话前面或后面，不超过 40 字。
- `innerVoiceLight`：这是在 QQ 上打字，不是写小说。不要写括号旁白或心理描写。想表现动作，最多用一个很短的括号，比如（捂脸）（小声），不超过 8 个字。神态和心情放进说话方式里。
- `innerVoiceHidden`：这是在 QQ 上打字，不要写任何括号旁白、动作或心理描写。只写说出口的话。

措辞可以调，但要短，不要和现有 system 规则冲突。

### 3. 解析：把旁白从回复里拆出来

新文件 `src/core/shared/inner-voice.ts`，导出：

```ts
export interface InnerVoiceSplit { spoken: string; asides: string[]; }
export function extractAsides(text: string, mode: 'full' | 'light' | 'hidden'): InnerVoiceSplit;
```

“旁白”的判定，要避免误伤正常括号，比如“樽见（她初中朋友）”：

- 用全角（）或半角 () 括起来，并且满足下面任一条：
  - 独占一行（去掉首尾空白后整行就是括号）；
  - 位于行首或句末标点之后，且括号内 ≥ 9 字。
- 夹在句中、前面紧跟汉字或字母的短括号是注释，不算旁白，原样保留。
- `light`：括号内 ≤ 8 字的保留（最多 1 个，多余的移入 asides）；更长的移入 asides。
- `hidden`：所有判定为旁白的都移入 asides。
- `full`：asides 也记录全部旁白，但 spoken 里保留。
- 拆完之后清理多余空行和行首尾空白；如果 spoken 变成空串，走现有 `empty_reply` 逻辑（有表情包就只发表情包）。

在 `src/core/conversation/steps/generate.ts` 里，`cleanReply` → `parseStickerReply` 之后调用，把 `ctx.state.replyText` 设成 spoken，把 asides 存到 `ctx.state.innerVoice`（types.ts 里补字段）。`replay` 路径同样处理。

### 4. 分条（split.ts）

- `full` 档：在 deliver 里先把每段旁白切成独立一条，再对其余文字走 `splitReply`。旁白那条不计入 `maxParts`，但一次回复最多 1 条旁白（多余的合并或丢进心声）。
- `light` / `hidden`：spoken 里已经没有长旁白，`splitReply` 不用改。
- 给 `splitReply` 加一个单测：带短括号（捂脸）的句子不能被切成只剩括号的一条。

### 5. 存储与面板

- 心声存法：在发出去的第一条消息记录上挂一个 `innerVoice: string[]` 元数据（如果 messages 表没有合适的 JSON 列，就新建一张 `inner_voice(session_id, message_id, text, time)` 表，加迁移）。不要把它拼进 `plainText`，回复上下文只读 plainText。
- 面板：调试记录或会话消息视图里，在对应的 bot 消息下面用浅色斜体显示“心声：……”。会话设置页加一个三选一“括号心声：完整 / 轻量 / 隐藏（跟随人设）”。人设页“待人接物 > 说话方式”加同样的三选一。
- 情绪评估：`moodService.afterReply` 多传一个可选 `innerVoice` 文本；`prompts/appraise.md` 里注明“以下是她没说出口的心声，可作为情绪证据，但不是对方说的话”。没有心声时不注入。

### 6. 人设

- `data/personas/adachi_sakura.md` 的 `speech` 写 `innerVoice: full`，保持她现在的风格（AnI 可在面板改）。
- 其他人设不写，走默认 `light`。小祀、Claude 正文里原有的“别用括号刷内心戏”保持不动。

## 验收

- `npm test` 全绿，新增：`extractAsides` 三档各至少 3 个用例（含“樽见（她初中朋友）”不误伤、整行旁白、句末长旁白、多个短括号）；schema 和 persona 加载接受/拒绝新字段；full 档旁白独立成条且不占上限。
- 用面板的回复预览（不启动 QQ）给安达和默认人设各跑一条，确认：light 档长旁白不出现在发送内容里、出现在心声里；full 档旁白单独一条。
- 不要运行 `npm start`，不要启动 QQ 或 SnowLuma。需要实机验证时告诉 AnI，由 AnI 来启动。

## 不做

- 不让模型输出 JSON 结构来区分心声（成本高、和现有表情包解析冲突）。
- 不改心声以外的回复风格规则。
