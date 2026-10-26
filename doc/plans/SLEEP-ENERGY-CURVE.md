# SLEEP-ENERGY-CURVE：作息精力改成「白天平、睡前陡」

2026-10-26 · 来源：AnI 反馈安达樱晚上九点就犯困（面板 20:58 显示精力 39%）

## 现状与原因

- 面板「精力」和 prompt 里的「有点困」都来自 `src/core/sleep/index.ts` 的 `sleepEnergy()`，和 MOOD-HOLD-DECAY / MEMO-EVENT-SLICES（v36–v42）无关，这两批提交没碰它。
- 公式是从醒来到入睡**线性**下降：`energy = 1 - 0.8 × r - 0.01 × 近一小时回复数`，`r = (now - wakeAt) / (bedAt - wakeAt)`。
- `src/core/mood/render.ts` 的 `renderFloatBlock()` 在 `energy < 0.35` 时往浮动块加「有点困」。线性曲线下这一刻固定落在清醒时段的约 81% 处，离入睡还有约 1/5 的清醒时长。
- 当前 `data/config.yaml`：`wake: 06:00`、`bedtime: 02:00`，清醒窗 20 小时。20:58 → r≈0.75 → 0.40，再减近一小时回复 → 39%（与面板一致）。22:15 左右无回复也会跌破 0.35；聊得多会提前到 21 点前后。

## 改动

### 步骤 1：曲线改成幂次（单函数，纯逻辑）

`src/core/sleep/index.ts` → `sleepEnergy()`：

```ts
const SLEEP_ENERGY_DROP = 0.8;
const SLEEP_ENERGY_SHAPE = 2; // 1 = 旧的线性；越大白天越平、睡前越陡
const ratio = Math.max(0, Math.min(1, (now - wakeAt) / awakeWindow));
return Math.max(0, Math.min(1, 1 - SLEEP_ENERGY_DROP * ratio ** SLEEP_ENERGY_SHAPE - replyPenalty));
```

- 只改 `elapsedRatio` 那一项，回复惩罚、睡着返回 null 的逻辑都不动。
- 注意 ratio 先夹到 [0,1]（被叫醒后可能越界），再求幂。
- 效果（无回复时跌破 0.35 的时刻）：wake 06:00 / bed 02:00 → 约 00:00；wake 09:00 / bed 02:00 → 约 00:20。入睡时仍是 0.2，和旧值一致。

### 步骤 2：测试

`test/sleep.test.ts`：

- 现有对线性值的断言改成新公式的值。
- 加一条：wake 06:00、bed 02:00、当天 21:00、0 回复 → energy > 0.5（旧实现约 0.40）。
- 加一条：入睡前 1 分钟 energy ≈ 0.2（误差 0.01 内）。
- 加一条：ratio 越界（now 早于 wakeAt）时不出 NaN、不超过 1。

### 步骤 3（可选，AnI 没要求就跳过）

不加配置项、不改面板。若以后要调，再把 `SLEEP_ENERGY_SHAPE` 提到 `sleep` 配置里。

## 验收

- `npx tsc --noEmit` 与 `npm test` 通过。
- 不运行 `npm start`、不启动 QQ/SnowLuma；由 AnI 自己重启后看面板：21:00 精力应在 55% 上下（视回复数），零点前后才跌破 35%。
- 提交信息：`fix(sleep): 精力曲线改为睡前陡降`
