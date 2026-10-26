# MOOD-HOLD-DECAY 续做（2026-10-26）

主计划书仍是 `doc/plans/MOOD-HOLD-DECAY.md`。步骤 1（`b0edfc0`，`holdDecay` / `reanchor` / `advanceMoodState`）已提交，不要重写。本文件只改下面几点，其余照主计划书。

## 必须改的

1. **迁移号用 v42，不能用 v36。** 记忆切片已经用到 v41，`src/store/db.ts` 只执行 `version > 当前库版本` 的迁移，v36 在已升到 v41 的库上会被静默跳过。开工时先看 `src/store/migrations/` 最新号，在其后顺延。
2. **步骤 2 拆成两个提交**，每个提交前 `npm run check` 全绿：
   - **2a 存储**：迁移 v42（`mood_state` 加 6 个 `*_d0` / `*_u` 列，mood 事件表加 3 个 `*_u_after` 列，全部可空），`MoodStateRecord` / `ResolvedMoodState` / `affect-repo.ts` 读写同步，旧数据为空时视为 `d0 = 当前值 − 基线, u = 0`。**这一步不改任何数值行为**，现有测试应原样通过；只加迁移和读写往返测试。
   - **2b 施加**：`state.ts` 与 `service.ts` 里所有改 valence/arousal/dominance 的地方，算完新值后调用 core.ts 的 `reanchor` 更新锚点并写回。不要在 state.ts / service.ts 里重新实现 Hill 公式。
3. **上次失败的测试**：`returns current state with stale tag after an apply boundary and expires with stale cursor data` 不在现有测试文件里，是上次步骤 2 新写的。这次若要写类似测试，先用旧的指数实现算一遍，确认这个断言在步骤 2 之前的行为下本来就成立，再改成 Hill 版的期望值。
4. 面板构建命令是 `npm run panel:build`。

## 失败规则

同一步连续两次不绿：丢弃这一步未提交的改动，**在报告里写出失败测试的完整名字、断言的 actual 与 expected、相关文件行号**，然后停下，不做后续步骤。

## 顺序

2a → 2b → 3（series.ts 采样与重放，读 `*_u_after`）→ 4（配置、人设覆盖、面板「停留感」卡）。

## 不要做

不运行 `npm start`，不启动 QQ / SnowLuma，不 push。只 `git add` 具体路径；不提交 `personas/input/` 和 `data/`，`data/personas/adachi_sakura.md` 的未提交改动保持原样。

## 收尾

在 `doc/plans/MORNING-2026-10-26.md` 末尾追加「续做」一节：每步提交 hash、最终 `npm run check` 测试数、实际用的迁移号。单独提交。

---

# 续做第二轮：步骤 3 怎么修（2026-10-26 Claude 核对）

2a（`3a078f6`）、2b（`aed8eca`）已核对，没问题，不要改。上次步骤 3 的两次失败都**不是实现方向错了**，是下面两件事：

1. **`panel-mood-series.test.ts:168` 的 109 ≠ 97 是测试期望过时。** 24 小时窗口仍是 15 分钟网格（97 点），新增的是每个事件后的 `+τ10` / `+T50` 补采样点（3 个事件 × valence 与 arousal 各两个 = 12）。把期望改成「网格 97 点 + 补采样点」，最好按公式算出来再断言，不要只写死 109；同时断言 97 个网格时刻都还在。补采样点若和网格时刻重合要去重。
2. **`:178` 的插值失败是采样点改变了模拟。** 补采样点把「事件 → +15 分钟」这一块切成了几小块，而 T50 按每块开始时的 reserve 算，reserve 在块内会变，所以结果和一整块推进不一致。修法：**主模拟只在网格时刻和事件时刻推进**（块长仍 ≤ 15 分钟，≤ 12 小时窗口时网格为 5 分钟）；补采样点只从上一个主模拟检查点**复制一份状态**向前推进求值，不写回主模拟。这样加不加补采样点，网格点的数值都完全一样，`:178` 原有期望不需要改。
3. 加一条测试：同一组事件，开启与关闭补采样时，所有网格点的数值逐一相等（误差 < 1e-12）。

其余照主计划书步骤 3、4 做，规则同上（每步一提交、`npm run check` 全绿，步骤 4 还要 `npm run panel:build`；连续两次失败就停下并写出测试名、actual/expected、行号）。完成后在 `doc/plans/MORNING-2026-10-26.md` 末尾追加「续做二」一节，单独提交。
