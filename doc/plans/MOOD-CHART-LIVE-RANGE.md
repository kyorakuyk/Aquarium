# MOOD-CHART-LIVE-RANGE：此刻心情曲线实时刷新 + 时间范围切换

基于 HEAD 2a0925a（MOOD-HOLD-DECAY 已完成）。AnI 2026-10-26 提出：此刻卡片的曲线应当“实时”，且除 24 小时外应有其他时间刻度。

## 现状（已核对代码）

- `panel/src/pages/MoodNowCard.tsx:132` 固定请求 `/api/mood/series?hours=24`，`:142` 每 30 秒轮询一次；`:91` 横轴左端写死“24 小时前”，`:62` aria-label 写死“过去 24 小时”。
- 后端 `src/panel-server/mood-routes.ts:173` 已支持 `hours=1..168`，不用改校验。
- `src/core/mood/series.ts:15-16,89-92`：窗口 ≤ 长窗口阈值用 5 分钟网格，更长用 15 分钟；支持 `intervalMs` 入参但路由没传。1 小时窗口用 5 分钟网格只有 12 个点，太粗。
- 情绪事件写入在 `src/core/mood/service.ts`；`src/panel-server/impressions-status-routes.ts:40-75` 已有一个可照抄的 SSE 写法（ReadableStream + subscribe + abort 清理）。
- 所以“不实时”的实际表现：新事件最多晚 30 秒才出现在图上；事件之间曲线只是衰减，30 秒轮询本身够用。

## 步骤 1：时间范围切换（前端为主）

1. 在卡片标题行（“更新于 …”左侧）加一组分段按钮：`1 小时 / 6 小时 / 24 小时 / 7 天`，对应 `hours=1/6/24/168`，默认 24。选择存 `localStorage`（键 `aquarium.moodNow.range`，读写包 try/catch）。
2. 请求改为 `/api/mood/series?hours=${hours}`；切换时立即重新请求，并丢弃过期响应（用请求序号或 AbortController，避免慢的旧请求覆盖新的）。
3. `MoodChart` 接收 `hours`：左下标签改为 `1 小时前 / 6 小时前 / 24 小时前 / 7 天前`；aria-label 同步。再加 3 个中间刻度（四等分处的时刻，≤24h 显示 `HH:mm`，7 天显示 `MM/DD`），用现有 `mood-now-axis-label` 样式。
4. 下方四个小 sparkline 继续用同一份 series，不另请求。
5. 后端 `mood-routes.ts` 调 `buildMoodSeriesPoints` 时按窗口传 `intervalMs`：`hours ≤ 1 → 1 分钟`，`≤ 6 → 2 分钟`，`≤ 24 → 5 分钟`，`> 24 → 15 分钟`（后两档与现有默认一致，可只对前两档显式传）。

测试：路由测试 `hours=1` 的网格点间隔为 1 分钟、`hours=168` 为 15 分钟；面板测试切换按钮后请求的 `hours` 参数正确、标签文字正确。

## 步骤 2：事件推送（真正的“实时”）

1. `src/core/mood/service.ts` 增加一个进程内订阅：`subscribeMoodChange(listener)`，在写入情绪事件、区域（band）切换、睡眠/叫醒状态改变时发 `{ account, time }`。不要在衰减采样上发事件。
2. 新路由 `GET /api/mood/stream`：照 `impressions-status-routes.ts` 的 SSE 写法，只推主账号的变化，消息体只带 `{ time }`；连接后 25 秒发一次注释行心跳（`: ping`）防代理断连；abort 时退订。
3. `MoodNowCard`：
   - 用 `EventSource('/api/mood/stream')`（若面板 API 需要鉴权头而 EventSource 带不上，就沿用 impressions 那边前端的读取方式，保持一致）；收到消息后 500ms 防抖再拉一次 series。
   - 轮询保留作兜底，但间隔随范围变：`1h → 15 秒`、`6h → 30 秒`、`24h → 60 秒`、`7d → 5 分钟`；`document.hidden` 时暂停，`visibilitychange` 回到可见时立刻拉一次。
   - 流连接正常时标题行显示 `更新于 HH:mm · 实时`；断开时退回 `· N 秒刷新`。
4. 不做逐帧动画/前端自己外推曲线：曲线形状由后端 Hill 衰减重放算出，前端外推会和后端对不上。

测试：service 写事件后 listener 被调用一次；SSE 路由能收到一条 `data:`，abort 后退订（参考 impressions-status 的现有测试）；面板测试收到流消息后会重新请求。

## 验收（AnI 手动）

- 切到 1 小时，曲线明显更细；切到 7 天，能看到多日的起伏，横轴刻度是日期。刷新页面后保留上次选择。
- 在 QQ 里触发一次明显的情绪事件，几秒内（不用等 30 秒）面板上出现新的事件点；标题行显示“实时”。
- 切到别的浏览器标签再回来，图立即更新。

## 交付

两步各一个提交；全量测试通过；更新 `doc\STATE.md`。
