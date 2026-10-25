# 分条发送修复交接（给 Hermes）

## 现象
bot 一次回复里的两句短话（中间是空行 `\n\n`）被塞进同一个 QQ 气泡，例如「诶？突然说这个干嘛呀\n\n……再说一遍嘛」。人设（default.md 等）明确要求「一条消息只发一行 / 想补一句就作为下一条」，实际没有分开发。

## 根因（已读码确认，未运行）
文件 `src/core/shared/split.ts` 的 `splitReply`：
1. 开头 `if (characterCount(text) <= 80) return [text]`：总长不超过 80 字就原样一条，**根本不看换行**。短句回复几乎全走这条，所以空行永远不会拆。
2. 即使超过 80 字，`mergeAdjacentParts` 也会把相邻段落贪心合并回 80 字以内（用 `\n` 连接），所以「两行短句」仍会被合回去。
3. 调用点 `src/core/conversation/steps/deliver.ts`（`replayDeliverStep` 与 `deliverStep` 各一处）把 `splitReply(replyText, maxPartsForContext(ctx))` 的结果逐条 `adapter.send`，这里本身没问题，条与条之间已有 `replyDelayMs` 延迟。

另：`prompts/reply-system.md` 没有分条规则，分条完全靠人设文字 + 这个函数。

## 要改什么
让「换行 = 分条」成为默认，并给人设字段留出口：

1. `splitReply(text, maxParts, options?)` 增加 `options.segmenting?: 'multi' | 'one_message'`，默认 `'multi'`。
   - `'multi'`：先按 `\r?\n` 拆（连续空行视为一个分隔，空行/纯空白段丢弃），**每个非空行就是一条**，不再做 80 字内的贪心合并。单行超过 80 字时仍沿用现有的按句末标点切分 + `limitPartLength`。条数超过 `maxParts` 时，多出来的并入最后一条（用 `\n` 连接，沿用现有 `joinParts` 行为）。
   - `'one_message'`：整段作为一条（保持现有 ≤80 的行为；超过 80 字沿用现有切分逻辑）。小鲸鱼妈妈精简版这类「一条装完」的人设用它。
2. 去掉开头那个「≤80 直接返回」对多行文本的短路：只有**不含换行**且 ≤80 时才直接返回 `[text]`。
3. `deliver.ts` 两处调用传入 `segmenting`。取值来源：人设 `speech.segmenting`（见 `doc/plans/PERSONA-SCHEMA-HANDOFF.md`、`notes/persona-schema-example.md`）；字段还没落地前读不到就用默认 `'multi'`。取值用函数/getter 包一层，等 PERSONA-SCHEMA 任务合并后只需接线，不用再改 `splitReply`。
4. 不改 `prompts/reply-system.md`，不改 `replyPartLimitForTalk`（条数上限仍由话痨度决定）。

## 测试（`test/split.test.ts`）
- 新增：`'诶？突然说这个干嘛呀\n\n……再说一遍嘛'` → `['诶？突然说这个干嘛呀', '……再说一遍嘛']`。
- 新增：三行短句、maxParts=2 时第三行并入第二条。
- 新增：`segmenting: 'one_message'` 时上面第一例仍为一条。
- 修改/删除与新默认冲突的旧用例：「先按换行拆分长回复」「合并跨段落片段时保留并计入换行」「把跨段落换行计入 80 字上限」，按新行为重写，其余（标点不单独成条、超长无标点切分、不丢字符）保持通过。
- 跑 `npm test`（只跑测试，不要 `npm start`，不要启动 QQ 或 SnowLuma）。

## 验收
- 回复里每个空行/换行分隔的短句各自成一条气泡，条数不超过 `maxParts`。
- 单行长文本行为与改动前一致，不丢字符。
- `speech.segmenting: one_message` 时不拆行。

## 边界
只改 `split.ts`、`deliver.ts` 的调用、`test/split.test.ts`。与 PERSONA-SCHEMA 任务有交叉时，以 `speech.segmenting` 字段为准，不要在这里重复解析人设。
