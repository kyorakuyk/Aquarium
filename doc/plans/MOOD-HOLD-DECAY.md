# MOOD-HOLD-DECAY：情绪先停留、再衰减

状态：AnI 已同意（2026-10-25），先实现再看效果调参。
相关：`doc/plans/MOOD-AMPLITUDE-TUNING.md`（半衰期、心灵能量）、`doc/plans/PERSONA-PAGE-TABS.md`（参数 → 心情 页）。

## 问题

`src/core/mood/core.ts` 的 `decayValue` 是纯指数：`x = base + (x0 − base) × 2^(−Δt / halfLife)`。
它没有记忆，事件刚发生时下降速度就是最快的，所以图上看不到"先停一会儿"。
真实的情绪是三段：先停留，中段回落得快，靠近基线时变慢。

## 方案：Hill 曲线 + 每个维度一个"锚点"

剩余比例 `S(u) = 1 / (1 + u^n)`，其中 `u = 已经过的有效时间 / T50`。

- **T50** = 现有半衰期，含义不变（回落一半要多久）。valence 仍是 `surfaceHalfLifeMin(reserve, base)`，所以心灵能量继续调快调慢；arousal 和 dominance 仍用 `arousalHalfLifeMin`。
- **n** = 新参数"停留感"。默认 valence n=3，arousal 和 dominance n=2。n=1 时没有停留段，接近旧的感觉。

参考值（valence，n=3，T50=40 分钟；括号里是旧的指数）：
10 分钟 98%（84%），20 分钟 89%（71%），40 分钟 50%（50%），80 分钟 11%（25%），2 小时 4%（13%）。

### 状态

Hill 曲线不是无记忆的，所以每个维度（valence / arousal / dominance）要存：
- `d0`：锚点偏移量（相对基线）
- `u`：从锚点开始的**归一化**有效时间（单位是 T50）

当前值 = `base + d0 × S(u)`。

### 推进（`advanceMoodState`，每个 ≤15 分钟的块）

`u += elapsedMs / (T50_eff × 60_000)`，其中 T50_eff 按块开始时的 reserve 计算（和现在一样）。
reserve 变化只改变 u 走得快慢，不会让值跳变。
valence 回升时扣心灵能量（`RESERVE_RECOVERY_COST`）等逻辑保持不变，仍然用这一块前后 valence 的差值。

要求：reserve 不变时，一次推进 60 分钟和分 4 次各推进 15 分钟，结果一致（误差 < 1e-9）。

### 事件施加规则（appraise、被叫到、回复等所有会改 valence/arousal/dominance 的地方）

先像现在一样算出新值（软上限、缓冲、`applyArousalDelta` 等都不动），再更新锚点：
`d_cur` = 施加前偏移，`d_new` = 施加后偏移，EPS = 0.005。

1. `|d_cur| < EPS`，或者同号且 `|d_new| > |d_cur|`（同方向的新刺激）：`u = 0`，`d0 = d_new`，停留期重新开始。
2. 同号且 `|d_new| ≤ |d_cur|`（往回拉，比如被安慰）：保持 u，`d0 = d_new / S(u)`，不重开停留期。
3. 异号（被拉过了基线）：`u = 0`，`d0 = d_new`，从反方向重新开始。
4. `|d_new| < EPS`：`d0 = 0`，`u = 0`。

把这个写成 core.ts 里的纯函数（比如 `reanchor(dCur, dNew, u, n)`），state.ts、series.ts、service.ts 共用。

### 不变的部分（不要重复实现）

- 档位滞回（静摩擦 0.05、滑动摩擦 0.02、`MIN_BAND_DWELL_MS` 10 分钟）作用在档位层，保持不变。
- 情绪边 dwell 加随机系数（phase 5，`emotions.ts`）作用在情绪标签层，保持不变。
- 本方案只改**数值**怎么回落。心灵能量 R 自身的恢复（`recoverReserve`）仍是指数，不改。

## 存储与迁移

- 新迁移 `src/store/migrations/v35.ts`（如果 v35 已被占用就顺延）：
  - `mood_state` 加 `valence_d0, valence_u, arousal_d0, arousal_u, dominance_d0, dominance_u`（REAL，可空）。
  - mood 事件表加 `valence_u_after, arousal_u_after, dominance_u_after`（REAL，可空），供曲线重放用。
- 旧数据：可空即视为 `d0 = 当前值 − 基线`，`u = 0`（相当于从现在起重新停留一次，无害）。
- `MoodStateRecord`、`ResolvedMoodState`、`affect-repo.ts` 读写同步更新。

## 曲线重放（`series.ts`）

- 事件点：用事件的 `*After` 值和 `*_u_after` 还原锚点（`d0 = (after − base) / S(u_after)`）；`u_after` 为空时用 0。
- 窗口 ≤ 12 小时：`MOOD_SERIES_INTERVAL_MS` 改为 5 分钟，否则约 20 分钟的停留段会被 15 分钟采样抹平；更长的窗口保持 15 分钟。
- 每个事件后在 `+τ10` 和 `+T50` 处补采样点（`τ10 = T50 × (1/9)^(1/n)`，即回落 10% 的时刻），让拐点画得出来。
- 要求：series 末点与 `resolveMoodState` 同一时刻的结果一致。

## 配置与人设

- `src/config/schema.ts` 的 `mood`：加 `surfaceHoldShape`（默认 3）和 `arousalHoldShape`（默认 2），范围 1–6。
- 人设 → 参数 → 心情：可覆盖这两个值（放在现有人设心情设置里，没填就回退到全局配置）。

## 面板

- 人设 → 参数 → 心情 页（`panel/src/pages/PersonaMoodCards.tsx` 一带）加一张"停留感"小卡：
  - 两个滑条：心情停留感（valence n）、兴奋停留感（arousal n），1.0–6.0，步长 0.5；旁边写档位词（1 无 / 2 短 / 3 中 / 4+ 长）。
  - 一张小预览图：x 轴 0–4×T50 分钟，灰线是旧的指数，主色线是当前 Hill；标出"约 X 分钟后开始明显回落"（τ10）和"半程 T50 分钟"两个点。样式跟着现有参数页的图表走。
- 总览心情卡（`MoodNowCard.tsx`）：数据来自 series，按上面的采样改动后会自然出现先平、再陡、再缓的形状，不需要单独改 UI。

## 测试（`test/`）

1. `S(0)=1`，`S(1)=0.5`，单调递减；n=1 时 `S(u)=1/(1+u)`。
2. 分块一致性（见上）。
3. `reanchor` 四条规则各一例，包括"被安慰不重开停留"和"越过基线重开"。
4. reserve 低时 T50 变长、回落变慢（沿用 `surfaceHalfLifeMin`）。
5. 迁移：旧行可读，`u=0`；新列能读写往返。
6. series 末点 = resolveMoodState。
7. 现有 mood 测试里写死指数值的断言，按新曲线更新期望值（不能删掉或跳过）。

## 步骤与提交

1. core.ts：`holdDecay(d0, u, n)`、`reanchor`、改 `advanceMoodState`；单测。提交。
2. 迁移 + repo + state.ts + service.ts 的事件施加；测试。提交。
3. series.ts 采样与重放；测试。提交。
4. 配置、人设覆盖、面板停留感卡；`npm run build`（面板）通过。提交。

每步跑 `npx tsc --noEmit` 和相关测试。**不要运行 `npm start`，也不要启动 QQ / SnowLuma**，跑起来看效果由 AnI 自己来。
