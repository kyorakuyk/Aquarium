# 情绪幅度调参 + 心灵能量（交接给 Hermes）

日期：2026-10-22（第 3 版：第二轨改为雪提出的「水库 / 心灵能量」，回能方式按 I/E 区分）
仓库：`E:\Teamworks\Aquarium`
原则不变：情绪数值全部由代码计算，模型只看到档位文字，看不到任何数字。

## 一、现象与原因

面板「此刻」页：24 小时 valence 一直贴着 0.1，偶尔小起伏很快回落，档位总是「平静」；兴奋度却常年 70%～100%。

数据来自 `data/aquarium.db` 的 `mood_events`（10-21 17:55 ～ 10-22 14:03，全部是同一个私聊）。

1. **同一发送者 60 分钟累计上限把负向情绪直接掐死。** `src/core/mood/core.ts` 的 `SENDER_VALENCE_CAP = 0.3`，按 |Δv| 累加、硬截断。私聊只有一个发送者，所以 1 小时内 valence 最多动 0.3。10-22 13:52 之后的 6 次评估（-0.10 ～ -0.12）`applied_dv` 全部是 0 或 -0.01。
2. **从「平静」降到「不爽」几乎够不着。** 基线 0.1，「不爽」下界 -0.15 加静摩擦 0.08，要求 v < -0.23，即从基线往下走 0.33，超过上限 0.3，中间还在按 30 分钟半衰期回拉。
3. **评估模型给的增量很小。** `prompts/appraise.md` 写了三次「轻微」，范围 ±0.15。30 次有效评估平均 |dv| = 0.066。
4. **只有一个半衰期（30 分钟）**，所有情绪都是「冒一下就平」，表达不了「一直忍着突然爆了」和「被伤到后慢慢稳住」。
5. **兴奋度只升不降。** `CALLED_AROUSAL_BUMP = 0.05` 每条被叫消息都加，没有冷却；评估给的 arousal 30 次全是正数，连续私聊十几条就顶到 1.0。

## 二、双轨模型：表层 + 心灵能量（核心改动）

### 思路

- **表层 surface（s）**：每件事带来的即时起伏，就是现在的 valence 增量。总心情 `v = baseline + s`，定档仍按 v。
- **心灵能量 reserve（R，0～1）**：一个「水库」。和兴奋度、精力并列，是第三条状态。它做三件事：
  1. **缓冲**：小的负面事件大部分被水库吸收，表面看不出来，但水位下降。
  2. **放水稳住**：心情掉下去以后往回恢复，水位越高恢复越快；恢复的过程本身也会消耗一点水。
  3. **抽干后崩**：水位低时缓冲失效、恢复变慢，一件小事就全部打在表面上。这就是「好好的突然爆炸」，不需要单独算导数。
- **回能方式按人格的 I/E 区分**（简中 MBTI 社区的说法：I 人向内获取能量，E 人向外获取能量）：I 人放完水要独处才回得来，E 人要有人陪才回得来。

精力（`energy`，和作息、睡眠相关）保持原样，和心灵能量是两回事：精力是「困不困」，心灵能量是「心累不累」。

### 数值（全部做成 `core.ts` 里的导出常量，方便以后调）

- 初始 / 无数据时 R = **0.8**。
- **缓冲**：负向 `dv`（软上限之后）里被吸收的部分
  `absorbed = min(|dv| × 0.85 × min(1, R / 0.5), 0.05)`，表层实际得到 `dv + absorbed`，水位 `R −= absorbed × 1.5`。
  单次最多吸收 0.05，所以真正的大事（-0.25 以上）照样会表现出来；正向 dv 不经过水库。
- **放水稳住**：表层半衰期随水位变化 `surfaceHalfLife = 40 × 1.4 / (0.4 + R)` 分钟（R=1 时 40 分钟，R=0 时 140 分钟）。表层为负、往回恢复时，恢复了多少就扣 `恢复量 × 0.3` 的水位。表层为正时回落不扣水。
- **回能**（读取时按时间补算，目标 1）：
  - 「独处」= 该账号最近 15 分钟内没有发过回复；「有人陪」= 最近 15 分钟内有回复，并且这段时间的评估 valence 平均 ≥ 0（不是在吵架）。
  - `inner`（I）：独处时回能半衰期 **2 小时**；有人陪时不回能，且每发一条回复 `R −= 0.01`（社交耗能）。
  - `outer`（E）：有人陪时半衰期 **2 小时**，另外每次正向评估额外 `R += dv × 0.5`；独处时半衰期 **8 小时**。
  - `mixed`（默认）：任何时候半衰期 **4 小时**，没有社交耗能。
  - 当前 v < baseline − 0.15（正在难过）时暂停回能。
- **评估里的 reserve 字段**直接改水位：`R += reserve × 2`（reserve 范围 ±0.15，所以一次最多 ±0.3）。「表面没事、心里不安」就是 valence≈0、reserve 为负。
- R clamp 到 [0, 1]。

用一串 -0.08 的小事（每 3 分钟一次，满水位起步）粗算：前 6 次心情只从 0.1 落到 0.03 左右，水位从 1 掉到 0.4；之后开始加速，第 11 次掉到 -0.2 附近。

### 能量档位（模型只看到文字）

- 三档 `full / tired / drained`，边界 [0.3, 0.6]，复用 `hysteresis.ts` 的 `nextLevel`，静摩擦 0.05、滑动 0.02、decay 换档需保持 10 分钟。
- `full` 不输出。`tired` / `drained` 时在情绪块后追加一句，文字按 I/E 取，放进 `prompts/affect.md` 模板：
  - inner：「有点累，想一个人待会儿」/「很累，只想安静待着」
  - outer：「有点累，想有人陪着说说话」/「很累，很需要有人陪」
  - mixed：「有点累」/「很累」
  措辞雪可以自己改。不输出任何数字。

### 人格设置

- 人格 schema 增加可选字段 **能量来源** `energySource: 'inner' | 'outer' | 'mixed'`，默认 `mixed`。放在「性格四维」附近（参考 `notes` 里的人格字段约定，选填区）。
- 面板人格页加一个三选一控件；改了以后不用重启，下一次读取状态就按新规则回能。

### 实现要点（`src/core/mood/core.ts`、`service.ts`）

- `mood_state` 新增 `reserve` 列；`valence` 列仍存总 v。读取顺序：先按当前 R 算出表层半衰期并衰减 s（同时扣放水的水位），再按 I/E 规则补回能，最后算能量档位。一次跨很长时间时，按 15 分钟一步分段补算，避免半衰期和水位互相依赖时误差太大。
- 事件应用顺序：软上限 → 水库缓冲 → 加到表层 → `reserve` 字段改水位 → 定档（心情档位和能量档位都算）。
- 社交耗能在发出回复时记（`afterReply` 开头，不受 90 秒评估间隔限制）。

## 三、其余调参

### A. 发送者上限改软上限（`core.ts`）

- `capSenderValenceDelta` 改成递减：`applied = delta × max(0, 1 − used / CAP)`。
- 表层上限 `SENDER_VALENCE_CAP` 0.3 → **0.8**；`reserve` 字段单独一个上限 `SENDER_RESERVE_CAP = 0.3`，同样递减、同样 60 分钟窗口（用 `applied_dr` 累计）。
- 群聊里单人刷屏的保护仍然在。

### B. 评估输出四个字段（`prompts/appraise.md`、`src/core/mood/appraise.ts`）

- JSON 改为恰好四个字段：`valence`、`reserve`、`arousal`、`reason`。
- 范围：`valence`、`arousal` ±**0.3**；`reserve` ±**0.15**。把这几个上限提成导出常量，提示词里的数字和 `parseAppraiseResponse` 共用（提示词渲染时替换占位符即可）。
- 提示词去掉「轻微」，给锚点，并明确三个值都可以为负：
  - valence：0～±0.05 日常寒暄；±0.1～±0.15 明显的开心或不舒服；±0.2～±0.3 强烈事件（被表白、被认真道谢；被骂、被拒绝、被嫌麻烦、敏感话题被追问）。
  - reserve：这段对话让人心里更有底气还是更累。0 = 不影响（大多数对话）；负 = 耗神、留下不安（没解决的争执、被冷落、在意的话题悬着、要一直顾着对方情绪）；正 = 被充电（被认真对待、和好、被关心、有了约定）。
  - arousal：激动、紧张、吵闹为正；冷场、无聊、被安抚、疲惫为负。
- 同步 `test/mood.test.ts` 里依赖三字段和 ±0.15 的用例。

### C. 摩擦略降（`core.ts`）

- `STATIC_FRICTION` 0.08 → **0.05**。`MOOD_BAND_BOUNDS` 不动。平静→不爽需 v < -0.2，平静→开心需 v ≥ 0.2。

### D. 兴奋度修正（`service.ts`）

- `recordCalled`：同一会话 10 分钟内只加一次（`Map<sessionId, lastCalledAt>`，写法同 `lastAppraiseAt`）。
- 正向增量饱和：`arousal += da × (1 − arousal)`；负向照常相加。在 `core.ts` 加 `applyArousalDelta(current, da)`，被叫加成和评估共用。
- 兴奋度半衰期 `arousalHalfLifeMin` 默认 **40**。

### E. 配置（`src/config/schema.ts`、`config.example.yaml`）

- `mood` 下新增 `surfaceHalfLifeMin`(40，水位为 1 时的表层半衰期)、`arousalHalfLifeMin`(40)、`reserve: { initial: 0.8 }`。回能半衰期等常量先放在 `core.ts`，不进配置。
- 兼容旧字段 `halfLifeMin`：只写了它时，表层和兴奋度都用它。
- 完成后提醒雪：本地配置里如果写着 `halfLifeMin: 30`，要删掉才能用上新默认值。

### F. 数据库迁移（`src/store/migrations/v25.ts`，并在 `index.ts` 注册）

- `mood_state` 加列：`reserve REAL NOT NULL DEFAULT 0.8`、`reserve_band TEXT NOT NULL DEFAULT 'full'`（CHECK `full/tired/drained`）、`reserve_band_since INTEGER`、`reserve_last_change_at INTEGER`、`last_reply_at INTEGER`（判断独处 / 有人陪用）。
- `mood_events` 加列：`dr REAL NOT NULL DEFAULT 0`、`applied_dr REAL NOT NULL DEFAULT 0`、`absorbed REAL NOT NULL DEFAULT 0`、`reserve_after REAL`。能量换档用 `source='band'` 记录，`reason` 写 `reserve_event` / `reserve_decay`；社交耗能用 `source='rule'`、`reason='social_cost'`。
- 人格的 `energySource` 跟着人格存储走（按现有人格版本 `persona_versions` 的做法），不放 mood 表。
- 同步 `src/store/affect-repo.ts`、`repository-types.ts` 的类型和读写。

### G. 面板（`src/core/mood/series.ts`、`src/panel-server/affect-routes.ts`、`panel/src/mood-series-api.ts` 及「此刻」页视图）

- 「此刻」页下方现在是「兴奋度」「精力」两栏，加第三栏 **心灵能量**，样式一致（百分比 + 进度条 + 小折线），旁边显示能量档位文字（充沛 / 有点累 / 耗尽）和能量来源（I / E / 混合）。
- 序列点增加 `reserve`；旧事件 `reserve_after` 为 null 时按 0.8。
- 主曲线上，被水库吸收的事件点可以画成空心小点并在提示框里显示「吸收了 x」，方便调参时看出「表面没动但水位在掉」。
- 人格页加「能量来源」三选一。

## 四、不要动的

- 模型只看档位：不在任何提示词里输出 valence / reserve / arousal 数字。
- 精力（`energy`）的计算不改。
- 90 秒评估间隔、预算超限跳过评估的逻辑不改。
- 睡眠和心灵能量的联动（例如睡一觉回满一部分）以后再做，这次不做。

## 五、验收

1. `npm test` 全部通过（更新受影响的断言，不要删测试、不要跳过）。
2. 新增单元测试：
   - 软上限：同一发送者连续 6 次 valence -0.12，第 6 次 applied 不为 0，累计不超过 0.8。
   - 水位为 0 时，从基线 0.1 连续 4 次 valence -0.15（间隔 2 分钟）后档位为 `annoyed`。
   - 缓冲：满水位时一次 -0.08，表层只变化 -0.03 左右，水位下降约 0.075；水位为 0 时同样事件表层变化 -0.08。
   - 「突然爆炸」：满水位起每 3 分钟一次 -0.08，前 5 次后档位仍为 `calm`，继续到第 11 次后档位为 `annoyed`（按公式算出确切次数再写断言）。
   - 恢复速度：同样一次 -0.25，水位 1 时 1 小时后的 v 高于水位 0.2 时的 v。
   - 回能：`inner` 独处 2 小时后水位缺口减半；`inner` 连续回复时水位不升反降；`outer` 独处 2 小时回能明显少于有人陪 2 小时；`mixed` 两种情况相同。
   - 正在难过（v < baseline − 0.15）时不回能。
   - 能量档位文字按 `energySource` 取，`full` 时不输出。
   - 连续 20 次 `recordCalled`（间隔 1 分钟）后 arousal 不会到 1.0。
   - 只配置旧 `halfLifeMin` 时，表层和兴奋度半衰期等于它。
   - 迁移：旧库迁移后 `reserve = 0.8`，旧事件能正常画出曲线。
3. 不要运行 `npm start`，不要启动 QQ 或 SnowLuma；实机验证由雪来做。
