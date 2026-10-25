# Memo 改为事件切片（已定稿，2026-10-26，待 Hermes 实现）

## 现在是怎样的（读代码确认）
- `persist.ts` 每收到一条消息就 `recordMemo()`，把原文整句复制进 `persona_memos`（v26），所以记忆页是逐句流水账。这些原文其实 `messages` 表里本来就有一份。
- 夜间整理 `persona-memory.ts organizeAtSleep()`：把待整理 memo 按会话切窗，跑群聊标签/事件抽取（extract-tags，含事件簿 `events`）和私聊事实抽取，然后**把原句拼起来**当日记（`diaryText()`，没有模型总结）。
- 有 personaMemoryService 时，白天的群聊实时抽取被跳过（persist.ts 里 `else if group → maybeExtract`），全部推到夜里。
- 夜间整理只由 `sleep/goodnight.ts` 的入睡时刻触发；`config.sleep.enabled` 为 false 时永不触发 → memo 一直堆着「待夜间整理」，事件簿也一直不更新。
- 唤醒词（`gate.ts`）只把 wakeState 置醒，睡着期间的消息被 gate 以 `asleep` 丢弃（已入库但无人处理）；自然醒来也不处理积压。

## 目标结构
```
SnowLuma ──► messages 表（= 暂存区，不再复制）
                │  每会话一个游标 organized_until
                ▼
        切段（纯规则，不调模型）
                │  段落闭合
                ▼
        事件整理（便宜模型，一段一次调用）
          ├─► memo（整理过的事件，per 眷属账号）
          ├─► 群段：同一次调用写事件簿 events（不再另抽）
          └─► 私聊段：事实 / 事件注解照旧（policy.ts 级别不变）
                ▼
        休息时刻：日记（输入 = 当天 memo + 未覆盖的零散尾巴）
                ▼
        游标推进；原文保留 N 天作历史缓存后清理
```

### 1. 暂存区 = messages 表 + 游标
- 不再逐条写 `persona_memos`。新表 `memory_cursors(account, session_id, organized_until_message_time, open_segment_start)`。
- 「暂存区」= 每会话游标之后的 messages。面板记忆页上方显示一行「暂存 37 条，3 段进行中」，不再逐句列。

### 2. 事件边界（规则切段，零模型成本）
一段在以下任一条件成立时闭合：
- 静默：群聊 ≥ 20 分钟、私聊 ≥ 40 分钟没有新消息；
- 过长：段内 ≥ 80 条（群）/ 60 条（私聊），按最后一个 ≥ 3 分钟的间隙切；
- 到了整理时刻（休息/固定时刻）：强制闭合所有开着的段。
闭合后先过滤：段内 < 4 条、且没有眷属发言 / 没被 @ / 没出现眷属名字与别名 → 判为闲聊，不调模型，直接并入「零散尾巴」留给日记。

### 3. 事件整理（一段一次便宜模型调用）
- 用 `extract` 槽（现有便宜模型、走 budget）。输入该段原文，输出 0..n 个事件：标题 ≤ 16、经过 ≤ 120、当事人、起止消息 id、值得记住（是/否）。一段可以拆出两件事，也可以一件都没有。
- 群段：这次调用**同时**产出事件簿 event（复用 v28 `events`，memo 带 `event_id` 外键），取代现在 extract-tags 里另起的 events 输出，避免同一件事抽两遍。标签抽取仍在这次调用里一起做（就是现在夜间那次调用改为段落闭合时做）。
- 私聊段：memo 级别继承 policy.ts（默认 L0，只给本人会话用）；关于群事件的解释照旧写 event_notes。
- 新 `persona_memos` 结构（迁移 v36，旧表改名归档）：`account, session_id, event_id?, title, summary, participants, start_msg, end_msg, level, created_at, diary_cycle?`。

### 4. 日记（休息时刻，一天一次调用）
- 输入：当天 memo（标题+经过）+ 零散尾巴的抽样（≤ 40 条）。memo 已覆盖的原文不再送。
- 输出眷属口吻的日记 ≤ 600 字，`persona_diaries` 改为存模型生成的正文 + 引用的 memo id。
- 之后推进游标；原文保留 `memory.rawRetentionDays`（默认 7）天，作为下次 history-import / 拉取历史的缓存，过期清理。
- 手动清缓存：面板记忆页加「清除暂存缓存」按钮（可选范围：某会话 / 全部；仅清已整理过、游标之前的原文，未整理的不动），二次确认后执行；对应 panel-server 路由。memo、日记、事件簿不受影响。

### 5. 固定整理时刻
- 新配置 `memory.organizeAt`（默认 `04:00`）。开了作息就在入睡时整理；没开作息就在 organizeAt 整理。调度器从 goodnight 里拆出来，单独一个 `memory/scheduler.ts`。

### 6. 睡着与醒来
- 睡着：gate 照旧不回复，消息照旧入 messages；切段/整理**暂停**（醒来一起做，省钱也符合「睡着」）。
- 自然醒（wake 时刻）：闭合睡眠期所有段 → 整理成 memo → 生成一段「睡着时发生的事」注入各相关会话上下文（有效 6 小时，≤ 5 条）→ 找出未回复的：私聊里对她说的话、群里 @她/叫她名字的 → 进「补回复」队列：私聊里的就在该私聊回，群里的就在该群回（同一个群的多条合成一条，@ 到相关的人）。按积极模式频率限制和 budget 逐个发，睡着时不发。
- 唤醒词唤醒：只取唤醒词那条消息前后同会话的段（最近一段 + 前 20 条）立即整理并作为上下文回复；更早的积压在这轮对话静默 10 分钟后，再走上面的「醒来」流程，主动问起。

## 雪的决定（2026-10-26）
1. 没开作息时固定整理时刻默认 04:00。
2. 没回的消息在哪来就在哪回：群里的在群里回，私聊的在私聊回。
3. 原文暂存 7 天后删除；同时支持在面板手动清除缓存。

## 分步（定稿后转 Hermes）
1. 游标表 + 规则切段 + 面板暂存计数（不调模型）。
2. 事件整理调用 + 新 memo 表 + 群段同时写事件簿；移除逐句 recordMemo。
3. 日记改为模型生成 + 游标推进 + 7 天清理 + 面板手动清缓存 + 固定整理时刻调度器（04:00）。
4. 醒来整理 + 「睡着时发生的事」注入 + 补回复队列（原处回复）。
5. 唤醒词：就近优先，稍后补问。

每步一个提交，跑 npm run check 与 npm run panel:build。不运行 npm start，不启动 QQ 或 SnowLuma。

## 给 Hermes 的提示词
请读 E:\Teamworks\Aquarium\doc\plans\MEMO-EVENT-SLICES.md，按「分步」1→5 实现，每步一个提交，每步完成后跑 npm run check 和 npm run panel:build。相关代码：E:\Teamworks\Aquarium\src\core\persona-memory.ts、E:\Teamworks\Aquarium\src\core\persona-memory-prompt.ts、E:\Teamworks\Aquarium\src\app\persona-memory-processor.ts、E:\Teamworks\Aquarium\src\app\main.ts（personaMemoryService 与 onSleep 部分）、E:\Teamworks\Aquarium\src\store\persona-memory-repo.ts、E:\Teamworks\Aquarium\src\store\migrations\v26.ts 与 v28.ts（事件簿 events），E:\Teamworks\Aquarium\src\core\conversation\steps\persist.ts、gate.ts、context.ts，E:\Teamworks\Aquarium\src\core\sleep\goodnight.ts 与 index.ts，E:\Teamworks\Aquarium\src\core\impressions\extract.ts，E:\Teamworks\Aquarium\src\core\impressions\history-import.ts，E:\Teamworks\Aquarium\src\core\privacy\policy.ts，E:\Teamworks\Aquarium\src\config\schema.ts，E:\Teamworks\Aquarium\src\panel-server\persona-memory-routes.ts，E:\Teamworks\Aquarium\panel\src\components\PersonaMemoryPanel.tsx，提示词在 E:\Teamworks\Aquarium\prompts\。新迁移号接在当前最新（v35）之后。隐私规则只在 policy.ts 的 decide() 里加，不另立。模型调用一律走 extract 槽和 budget 检查。不运行 npm start，不启动 QQ 或 SnowLuma，需要时请 AnI 自己启动。
