# 让眷属自己决定贴表情（LLM 贴表情）

日期：2026-10-24　需求方：AnI（“想让眷属们能自由贴表情”）
前置：INTERACTIONS.md 的 I2、I3（P1 贴表情）已完成（提交 82d1f37）。本文是 INTERACTIONS.md §3.1 末尾“让 LLM 附标记”那一步，AnI 已同意。

## 现象（为什么要做）
群 1101772952 里 AnI @眷属说“给这条消息随便贴一个表情喔”，眷属回“贴好了”，但实际没贴。
原因：贴表情现在只由 §3.1 的三条代码规则触发，LLM 没有任何贴表情的出口；她回复里的“贴好了”是编的。`interaction_log` 表为空，一次都没触发过。

## 目标
1. 眷属在回复时可以自己决定给“触发这次回复的那条消息”贴一个表情。
2. 可以“只贴表情不说话”。
3. 她不再说自己做了其实没做的事。
4. 原有三条规则保留不动。

## 做法：照抄表情包标记的路子
参考现有实现：`prompts/reply-system.md` 的 `stickers` 字段、`src/core/stickers/parse.ts`、`src/core/conversation/steps/generate.ts`（第 43–63 行）、`deliver.ts`。

### 1. 提示词
在 `prompts/reply-system.md` 新增字段 `reactions`（和 `stickers` 一样必须非空、带 `{{list}}` 占位符；同步改 `src/core/prompt/templates/reply-system.ts` 的校验与类型）。文案：

```
reactions: 可以给对方这条消息贴一个 QQ 表情（像点赞那样，贴在消息上，不是发出去）。什么时候贴：这条消息需要你回应，但不值得回一整句时（对方说“好”“收到”“谢谢”、顺口一提、事情已经在办），贴一个表示“我看到了”，这时整条回复只写这一行。对方问了问题、需要你拿主意、或者你要说坏消息时，要好好说话，不要只贴表情。话已经说完了就别再补表情。贴时在回复最后单独一行写 [贴:表情名]，一次只贴一个。可选：{{list}}。只有写了这一行才算贴上，没写就别在话里说“贴好了”。
```

- `{{list}}` = 白名单全部表情名，用顿号连起来；把**当前心情档**那一桶放在最前面（`moodService.currentBand()`），其余按 low/annoyed/calm/happy/excited 顺序接后面。不出现 emoji_id。
- 只有在下面“何时提供”全部满足时才注入这段，否则不注入。

### 2. 何时提供（不满足就不注入，且解析时直接丢弃标记）
- 群聊（`session.kind === 'group'`）；私聊不注入。
- `resolveInteractions(config, session).react.enabled === true`。
- 不是 replay。
- 触发消息不是敏感/严肃话题（复用 `containsSensitiveText`、`isSeriousTopic`）。

### 3. 解析
新文件 `src/core/interactions/react-marker.ts`，导出 `parseReactMarker(text, whitelist)`：
- 标记正则：`[贴:名]`、`[贴：名]`、`【贴:名】`、`【贴：名】`。
- 无论是否有效，**所有**标记都从文本里删掉（和 parse.ts 一样）。
- 取第一个有效的：名字精确等于白名单里某项的 `name`，返回该项 `emoji_id`。名字不在白名单 → 当作没贴，不要模糊匹配。
- 在 `generate.ts` 里与 `parseStickerReply` 同处调用（先去 react 标记再交给 sticker 解析也行，顺序不影响）。结果放 `ctx.state.chosenReaction = { emojiId, name }`。

### 4. 执行
- 动作：`{ kind: 'react', session, messageId: ctx.message.messageId, emojiId }`，`source: 'llm'`，走现有 Gate（`src/core/interactions/gate.ts`），共用 `per_hour_max`、`per_sender_gap_s` 限速，记 `interaction_log`。
- 不走概率（LLM 已经决定了），不受 `prob_scale` 影响。
- 时机：在 `deliver.ts` 发文字之前贴（像人先点个表情再回话）。贴失败或被 Gate 拦下只记日志，不影响后面的文字回复。
- 只贴不说：去掉标记后文字为空、且有有效 `chosenReaction`、且没有表情包 → 不发任何消息，只贴表情，决策记为新原因 `react_only`。
  若有效标记被 Gate 拦了且没有文字，也不发消息，决策原因 `react_only_blocked`。
- 同一条消息本轮已被规则贴过（§3.1 三条规则），LLM 标记就跳过，避免贴两个。

### 5. 控制台
决策追踪里已有贴表情那一栏：来源显示“自己决定”（llm）/“规则”（rule），并显示表情名。无需新页面。

## 补充（2026-10-26，AnI 认可）：何时贴的规矩
上面的 reactions 文案已经写进了这条规矩：值得回一整句就说话；不值得但想表示“我在”就只贴一个；有问题/要决定/坏消息必须说话；话说完不补表情；一次一个。
代码侧配合一条：同一轮里既有文字又有 [贴:…] 时仍然照贴（不强行拦），规矩只靠提示词约束；验收时观察“文字+表情”出现得多不多，多了再说。

## 测试（test/ 下新增，跟现有风格一致）
1. `parseReactMarker`：四种括号写法；名字不在白名单 → 无结果但标记被删；多个标记只取第一个有效的。
2. 私聊、`react.enabled=false`、严肃话题 → 提示词里没有 reactions 段，回复里写了标记也不会贴。
3. 只写标记 → 不发消息，`react()` 被调一次，原因 `react_only`。
4. 文字 + 标记 → 先 `react()` 再发文字，文字里没有标记残留。
5. Gate 限速拦截 → 文字照常发，`interaction_log` 记 blocked。
6. 规则已贴过同一条 → LLM 标记不再贴。

## 停止点（等 AnI 验收）
AnI 在群 1101772952 @眷属说“给这条贴个表情”，验收：
- 表情真的出现在那条消息上；
- 她不会再嘴上说贴了却没贴；
- 连续几次不总是同一个；
- 控制台决策追踪里能看到来源“自己决定”。
