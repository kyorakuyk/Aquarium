# 小号记忆互通（2026-10-23）

状态：待 Hermes 实现。范围：只改"已在面板链接为小号（alt）的两个号"之间的私聊记忆；不改好感度/情绪算法；不运行 npm start、不启动 QQ/SnowLuma。

## 现象
雪用 A 号私聊眷属，再用 B 号提起刚才的事，眷属不知道。

## 原因（按代码核对）
设计如此：
1. 最近对话按会话取。`src/core/conversation/steps/context.ts` 只读 `recentMessages(ctx.currentSessionId, …)`；私聊会话 ID 是 `account:private:对方QQ`，换号就是另一个会话。
2. 私聊之间永不互通。`src/core/privacy/policy.ts` 的 `decide()`：private → 另一个 private 一律 deny，与 L0/L1/L2 无关。
3. 私聊事实是异步批量抽取的（privacy_runs），"刚才"的话即使能跨会话，也多半还没抽成事实；且抽取默认落 L0。
4. 系统不知道两个号是同一人：库里 `relations`、`account_kinds` 都是空的，面板 IdentityRelationsPanel 没做过"小号"链接。

缺陷（即使链接了小号也不会生效）：
5. 链接小号目前只合并了标签、好感度、群聊发言者映射（`mainUserIdFor` / `mapMessageToMainIdentity`），私聊三处仍按原始 QQ 号与精确会话判断：
   - `src/core/privacy/prompt.ts` `buildPrivateFactsBlock`：`fact.ownerId === input.session.peer`、`tag.userId === ownerId` 用的是原始号；`decide()` 目标是当前会话，另一个号的会话被 deny。
   - `src/core/persona-memory-prompt.ts`：日记条目 `ownerId: source.peer`，只允许精确来源会话。
   - `context.ts`：最近对话不含同一人其他号的私聊。
   与好感度已按主号合并的行为不一致。

另：本机库 `schema_version` 还是 21，而代码已有 v22–v26 迁移，说明昨晚 4a/4b（眷属组、memo、日记）还没在运行实例里生效，雪下次重启后才会迁移。

## 要做的
1. policy.ts 增加一条"同一主人"规则（唯一来源，不在别处另立）：
   `info.origin === 'private' && target.kind === 'private' && info.ownerId !== null && info.ownerId === target.peerId && purpose === 'prompt'` → allow（L0 也允许，这是本人）。`third_party`/`gate` 仍 deny。
   约定：调用方传入的 `ownerId`、`peerId` 必须先经 `repository.mainUserIdFor(account, id)` 映射为主号。policy.ts 本身保持纯函数，不查库。
2. prompt.ts：`ownerId`、`fact.ownerId`、`tag.userId`、`target.peerId` 都换成主号后比较。
3. persona-memory-prompt.ts：日记来源的 `ownerId` 与 target 的 `peerId` 同样映射主号。
4. context.ts 新增"另一个号的近况"块（不混进 context，保持主上下文与缓存前缀稳定）：
   - 仅私聊、仅当前发言人有已链接的小号/主号时。
   - 取同一主号的其他私聊会话（同一 account）最近 6 小时内、最多 12 条、合计 ≤ 800 字的消息，按时间排序，每条前缀"（用另一个号）"。
   - 每条走 `decide()`（info 为来源会话、ownerId 主号；target 为当前会话），并经 `redactSensitiveText`。
   - 在 reply-system 模板加一个块 `altRecent`，措辞："这是对方用另一个号刚和你聊的，你记得。" 记录进 `describePromptBlocks`。
   - 群聊不做；群聊里的同人已由 `mapMessageToMainIdentity` 处理。
5. 面板不改；链接仍由雪在 IdentityRelationsPanel 手动选"小号"。

## 测试
- policy：同主人 private→private 的 prompt allow，third_party/gate deny；不同主人仍 deny；未映射主号时行为与现在一致。
- 未链接的两个号：提示词里无对方内容（回归）。
- 链接后：B 号私聊提示词包含 A 号的私聊事实（含 L0）、日记条目和 `altRecent` 块；别人的私聊仍不出现。
- `altRecent` 时间窗、条数、字数上限与脱敏。
- 跑 `npm run check` 与 `npm run panel:build`，一个提交。

## 给 Hermes 的提示词
请读 E:\Teamworks\Aquarium\doc\plans\ALT-ACCOUNT-MEMORY.md，按「要做的」实现小号私聊记忆互通，一个提交。相关代码：E:\Teamworks\Aquarium\src\core\privacy\policy.ts、E:\Teamworks\Aquarium\src\core\privacy\prompt.ts、E:\Teamworks\Aquarium\src\core\persona-memory-prompt.ts、E:\Teamworks\Aquarium\src\core\conversation\steps\context.ts、E:\Teamworks\Aquarium\src\core\profiles\account-identity.ts、E:\Teamworks\Aquarium\src\store\identity-repo.ts，以及 E:\Teamworks\Aquarium\prompts\ 下的 reply-system 模板。若昨晚任务三（情绪心灵能量）还没提交，先把它收尾。不运行 npm start，不启动 QQ 或 SnowLuma，需要时请 AnI 自己启动。完成后跑 npm run check 和 npm run panel:build。
