# 外部审阅报告：核实结果与修复清单（2026-10-24）

基准：HEAD `889a1a7`。报告里的行号有漂移（多数偏 30~40 行），下面给的是当前行号。
核实结论：✅ 成立 / 🟡 部分成立 / ❌ 不成立。

**硬约束（Hermes 必读）**
- 不要运行 `npm start`，不要启动 QQ / SnowLuma。只跑 `npm test`、类型检查、依赖边界检查。
- 每个批次单独提交，提交信息写清楚改了哪条（如 `fix(budget): R1 ...`）。
- 改完更新 `doc/plans/STATE.md`，并在本文件对应条目后标 `[done <commit>]`。

---

## 第 1 批：预算硬上限（报告 #1）✅

现状：
- `src/core/conversation/steps/gate.ts:164-195`：被 @/昵称/人设必回（`trigger !== 'none' || personaMustReply`）分支直接 `return next:true`，预算检查在 `:202`，只有主动搭话会走到。
- `src/llm/slots.ts:153-157`：`reply` 槽超限时只把链截成最后一项，照样发起付费调用；其它槽（印象、摘要、标签分类、judge…）超限时完全不受限。
- `test/budget.test.ts:20` 名为「budget 为零时阻止任何回复调用」，实际只断言 `budgetState(...) === 'exceeded'`，名不副实。
- `src/config/schema.ts` 不校验链尾是否最便宜。

修复：
- R1.1 在 `callSlot` 开头加硬拦截：`budgetState === 'exceeded'` 时，对 `provider.kind === 'api'` 且有定价的项一律不调用，抛出可识别的 `BudgetExceededError`（`kind: 'cli'` 或零定价的项可以放行）。截链逻辑改为「从链里过滤出免费项」，没有就拒绝。[done eb99ffd]
- R1.2 调用方处理 `BudgetExceededError`：回复路径记 decision `reason: 'budget'` 并静默；后台服务（印象/摘要/标签/私聊事实等）跳过本轮，不报错刷屏（日志限频一条/小时即可）。隐私 judge 拿到该错误必须按现有规则「保守沉默」，不能放行。[done eb99ffd]
- R1.3 `gate.ts` 在 @ 分支里也提前判一次预算（省掉后续 prompt 组装），与 R1.1 双保险。[done eb99ffd]
- R1.4 重写 `test/budget.test.ts:20`：真的走 `callSlot`/管线，断言 `dailyCny: 0` 时被 @ 不产生 API 调用；再加一条「非 reply 槽超限也被拦」。[done eb99ffd]
- R1.5（可选）若要保留「超限降级到某个便宜模型」，改为在 config 里显式声明 `budget.overflowEntry`，不要靠「链尾」隐含假设。
- R1.6 顺带修 `slots.ts:264-279`：API 成功但 `usage` 为 null 时按 0 入账。改为记一条 warn，并按 `max_tokens`/输入长度估算成本入账（宁多勿少）。

## 第 2 批：索引 + 清理（报告 #3）🟡

现状：
- `usage` 表（v01）没有任何索引，`panel-queries.ts:75-112` 的所有用量聚合都 `WHERE time >= ? AND time < ?` 全表扫。✅
- `decisions` **有**索引 `idx_decisions_session_time (session_id, time, id)`（v09），报告说「无索引」不准确；但 `replyCountToday`（`panel-queries.ts:114-134`）用 `session_id LIKE ?` + time 或只按 time 查，用不上这个索引，`repository.ts:186-191` 的 `ORDER BY time DESC LIMIT ?` 也扫。实际效果依然是全表扫。🟡
- `messages` 只有 `(session_id, time)`，`repository.ts:95-100` 的 `selectProfileActivitySessions` 按 time 单独查，全表扫。✅
- `usage` / `decisions` 无任何清理；只有 debug/pipeline trace 有 7 天清理（`repository.ts:561,591`）。✅

修复：
- R2.1 新迁移 v31：`CREATE INDEX IF NOT EXISTS idx_usage_time ON usage (time)`、`idx_usage_account_time ON usage (account, time)`、`idx_decisions_time ON decisions (time, id)`、`idx_decisions_replied_time ON decisions (replied, time)`（或部分索引 `WHERE replied = 1`）、`idx_messages_time ON messages (time)`。
- R2.2 `session_id LIKE '账号:%'` 的账号过滤：要么给 decisions 加 `account` 列（迁移回填），要么改成范围查询 `session_id >= ? AND session_id < ?` 让索引可用。推荐后者，改动小。
- R2.3 清理任务：挂在现有 `debugPruneTimer`（`main.ts:101`，6 小时一次）里。`decisions` 保留 90 天（被 debug trace / 事件引用的行注意外键或孤儿引用，先查一下有没有表引用 `decisions.id`）；`usage` 不删明细前先按天汇总到 `usage_daily`（provider/account/slot/day），明细保留 90 天，用量页长区间查询改读汇总表。保留天数做成 config 项，默认 90。
- R2.4 用 `EXPLAIN QUERY PLAN` 写一个测试，断言上述几条热查询走索引（`SEARCH ... USING INDEX`）。

## 第 3 批：shutdown 健壮化（报告 #2）✅

现状（`src/app/main.ts:263-292`）：
- unsubscribe、`panelServer.close()`、`adapter.close()`、`configWatcher.close()` 都没 try/catch，任一抛错后面 `database.close()` 不执行。
- `sessionQueue.idle()` 等各 `idle()` 无超时，在途 LLM/打字延迟可能永久挂住。
- adapter 在排空队列**之前**关闭，队列里已生成的回复发不出去。
- 全 `src` 无 `unhandledRejection` / `uncaughtException` 处理器。

修复：
- R3.1 写一个 `step(name, fn)` 小工具：每步独立 try/catch + 记日志。
- R3.2 顺序改为：停止接收新消息（unsubscribe、panel close、停 scheduler）→ 等 `sessionQueue.idle()` 等，**整体限时 10 秒**（`Promise.race`），超时记日志并继续 → 关 adapter → 关 managedHost → `cliRuntime.stopAll()` → `database.close()` → 释放锁。
- R3.3 第二次 SIGINT 直接走「立即关库 + 释放锁 + `process.exit(1)`」。
- R3.4 加 `process.on('unhandledRejection')` 只记日志不退出；`uncaughtException` 记日志后走 `shutdown('uncaughtException')` 再退出。
- R3.5 shutdown 逻辑抽到可测试的模块，加测试：某一步抛错时 db 仍被关闭；idle 永不 resolve 时超时后仍关闭。

## 第 4 批：JSON 容错（报告 #4）✅ + SnowLuma 进程/连接（报告 #5）✅

JSON 容错现状：`repository.ts`（306/323/362/377/393/408/509/525/557/587）、`panel-queries.ts`（44/304/318）、`tag-repo.ts:173`、`tag-subject-repo.ts:44`、`sticker-repo.ts:86`、`privacy-repo.ts:160`、`event-repo.ts:99/107`、`interaction-log-repo.ts:73` 都是裸 `JSON.parse`。注意：报告说 `persona-memory-repo.ts:167` 「已有容错」也不准确，它只是换了个错误信息照样抛。
- R4.1 在 `src/store/` 加 `parseJsonColumn(value, field, fallback)`：解析失败时记一条 warn（带表名+行 id，同一行限频），返回 fallback（数组列返回 `[]`，对象列返回 `null`/`{}`）。
- R4.2 批量查询里逐行降级，不让一行坏掉整批。隐私相关列（`privacy-repo.ts`）例外：解析失败时那条事实按**最严格**处理（视为 L0、不注入、不转述），不能降级成「空 = 放行」。
- R4.3 测试：手工写一行坏的 `segments_json`，`recentMessages` 仍返回其他行。

SnowLuma 连接：
- R5.1 `src/adapters/onebot/adapter.ts:212-226`：确认 SDK `websocket-client.js:248-251` 会把 `dispatchEvent` 里监听器抛出的错误也 emit 成 `error`，`:228` 非 JSON 帧也是。修法：`onMessage` 回调里每个 listener 单独 try/catch（仿 `interaction-notice.ts:71-75`）；`error` 处理里区分 `SnowLumaParseError` 和监听器错误 → 只记日志，不 reset 健康、不置 offline；只有 socket 级错误/close 才走重连。
- R5.2 空闲半开检测：`OneBotConnectionHealth` 已有 `lastPacketAt` 和心跳间隔，但只在动作超时时探测（`action-timeout.ts:112`）。加一个定时 watchdog（间隔 = 心跳间隔×1，超过 3 倍心跳没收到任何包就主动 retire client 重连）。注入时钟，写纯函数测试。

SnowLuma 进程（`src/host/windows/snowluma-process.ts`）：
- R5.3 启动前检测 WebUI 端口（默认 5099）与 WS 端口是否已被占用。被占用时先通过 WebUI 或 `netstat -ano` + 进程名确认是不是残留的 SnowLuma；是就 `taskkill /PID <pid> /T /F` 后再启动，不是就报明确错误并**停止**退避重启（新状态 `port-conflict`，托盘/面板显示原因）。
- R5.4 `waitUntilReady` 要防「孤儿 WebUI 先应答 login」被误判 ready：ready 前确认子进程仍存活（`child.exitCode === null`），或校验 WebUI 返回的 pid 等于子进程 pid。
- R5.5 连续 N 次（如 5 次）在 ready 后 30 秒内退出就停止自动重启，转 `error` 等人工处理。
- R5.6（可选，难度高）Windows Job Object 让子进程随父进程死亡。Node 无原生 API，可以先不做，用 R5.3 的启动前清理兜底；在 `src/host/windows/` 写一个 pid 文件记录子进程 pid，启动时据此清理更可靠。

---

## 第 5 批：中优先级（按需排期）

| 编号 | 结论 | 位置 | 修复 |
|---|---|---|---|
| M1 面板副作用无确认 | ✅ | `panel-server/event-routes.ts:131-139` 改为 advocate+L2+active 即 `ensureEventAdvocacyPending`，`app/event-advocacy-scheduler.ts` 60s 轮询会真发；`sticker-routes.ts` 同理 | 前端对这几个操作加确认对话框（代言要预览将发送的文字和目标群）；后端不改语义 |
| M2 配置写回丢注释 | ✅ | `config/write.ts:19` `yaml.stringify(result.data)` | 改用 `yaml.parseDocument` 读原文件，只对改动字段 `doc.setIn(path, value)` 后 `doc.toString()`；只写入用户显式设置/改动过的值，不写满默认值 |
| M3 出口拦截偏弱 | ✅ | `core/privacy/group-gate.ts:294` 要求 `>= 2` 个关键词 | 关键词数 ≤2 的事实命中 1 个即拦；或命中 1 个且该关键词长度 ≥4 字即拦。先加测试看误拦率 |
| M4 入站无去重 | ❌ | 已有：`messages UNIQUE(session_id,message_id)` + `INSERT OR IGNORE` + `steps/persist.ts:31-33` 返回 `duplicate` | 不用改 |
| M4b 无心跳 watchdog | ✅ | 见 R5.2 | 已并入第 4 批 |
| M5 非 owner 收藏被吞 | ✅ | `core/conversation/management.ts:141-143` 非 owner 直接 `return true` | 非 owner 时 `return false`，让消息照常进管线（保存+决策） |
| M6 账号启动无隔离 | ✅ | `main.ts:372` 起的启动回调只包了 adapter 构造；`host/bootstrap.ts:58-67` `runStartupTasks` 逐个 await，一个抛错后续账号全不启动 | `runStartupTasks` 里每个 task try/catch + 记日志，继续下一个账号 |
| M7 前端竞态 | ✅（抽查 Overview） | `panel/src/pages/OverviewPage.tsx:86-90` 成功不清 error；其余三页首屏无卸载防护；`ImpressionsPage` 快切群 | 写 `usePolling(fetcher, intervalMs, deps)` hook：内部 active 标记/AbortController、成功清 error、deps 变化丢弃旧响应；四页改用 |

## 第 6 批：小问题

| 编号 | 结论 | 说明 / 修复 |
|---|---|---|
| S1 usage null 按 0 计 | ✅ | 已并入 R1.6 |
| S2 客户端缓存不含密钥值 | ✅ | `llm/client.ts:23` 签名是 `baseUrl + apiKeyEnv`（变量名）。把 `process.env[apiKeyEnv]` 的 sha256 前 8 位加进签名 |
| S3 CQ 字符串消息丢失 | ✅ | `adapters/onebot/convert.ts:75-78` 字符串整体当一个 segment。字符串时至少转成 `{type:'text'}`，或简单解析 CQ 码；同时在连接时要求 array 格式 |
| S4 补丁无版本校验 | ✅ | `scripts/patch-snowluma-sdk.mjs` 无版本判断。读 `node_modules/@snowluma/sdk/package.json` 版本 ≠ `1.14.22` 或补丁锚点找不到时 **报错退出**，不要静默 |
| S5 路由不校验账号归属 | 🟡 | `affect-routes.ts` 的 `?account=` 路由已校验（`:104-107`）；按 sessionId 的路由与 `tag-veto-routes.ts` 不校验（`DELETE /api/tag-vetoes/:id` 也不看账号）。面板单用户有密码，风险低；统一加「session 的账号在当前 accounts 里」检查即可 |
| S6 nicknames/groupNote 无长度上限 | 未逐一核 | schema 里加 `max`（昵称每项 32 字、最多 20 项；groupNote 500 字） |
| S7 前端类型手工重复 | ✅（设计层面） | 暂不改，长期做共享类型模块 |

---

## 建议顺序
第 1 批 → 第 2 批 → 第 3 批 → 第 4 批 → M5、M6（小且实惠）→ 其余。每批结束跑 `npm test` + 类型检查 + 依赖边界检查，全绿再提交。
