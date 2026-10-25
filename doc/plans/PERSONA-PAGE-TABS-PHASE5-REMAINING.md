# 人设页改版 · 阶段 5 收尾：情绪编辑器

日期：2026-10-24 · 上游文档：`E:\Teamworks\Aquarium\doc\plans\PERSONA-PAGE-TABS.md`（阶段 5 一节和文末「与状态机交接的对齐」）

**规矩**：不要运行 `npm start`，也不要启动 QQ/SnowLuma，不要 push。

## 现状（2026-10-24 对照工作区核过）

- 阶段 1–4 已提交（0f5ffde / 889a1a7 / 196486d / a3356f6）。
- 阶段 5 在工作区里，**还没提交**。44 个已跟踪文件有改动，另有以下新文件：
  - `src/core/mood/emotions.ts`
  - `src/persona/mood.ts`
  - `src/app/persona-mood.ts`
  - `src/store/migrations/v32.ts`
  - `panel/src/pages/persona-mood-utils.ts`
  - `panel/src/styles/mood-now.css`
  - `test/persona-mood-editor.test.ts`
- 已完成的部分：
  - 后端：PAD 模型、v32 迁移、appraise/提示词字段、运行时情绪解析
  - 面板：五区域图表和总览
  - 心情带改名：表情白名单、`reaction-rules.ts`、`stickers/selection.ts` 改用 `oppressed / unpleasant / calm / aroused / excited`
- **缺口**：
  - 面板「参数 › 心情」还是占位卡。`panel/src/pages/PersonaParametersPanel.tsx` 只给 `affinity` 和 `energy` 接了编辑器，其余子页签都走 `PERSONA_PARAMETER_PLACEHOLDERS`。
  - `persona-mood-utils.ts` 没有任何组件引用。
  - `test/persona-mood-editor.test.ts` 现在有 4 个测试，上一轮有一处补丁（hunk 3）没打上去。
- 工作区里还有几样东西**不属于阶段 5**，不要一起提交：`notes/`、`personas/input/`、`scripts/fetch-sys-faces.ps1`。`doc/plans/` 下未跟踪的文档也不要提交。

## 要做的事

### 1. 补上失败的测试修改

先看 `E:\Teamworks\Aquarium\test\persona-mood-editor.test.ts` 的现状，再把上一轮想加的测试补上。改的时候换成能唯一匹配的锚点：上次失败就是因为 old_string 匹配到 11 处。下面几项至少都要覆盖：

- `updateMoodCoordinate`：拖动后写进 `coordinates` 覆盖项；拖回库默认值时，覆盖项要被删掉。
- 删掉一个库情绪再单个加回来（比如「开心」），坐标和所有相关边回到库默认值，没有残留的覆盖项。
- 添加一个和库同名的情绪，不报错（除非集合里已经有了），并且继承库数据。
- 自定义情绪的边按距离公式算：`margin = 0.02 + 0.12·dist`，`jump = dist < 1.45`。
- 三条例外边（害羞→生气、满足→害怕、生气→害羞）默认 `jump = false`。

### 2. 情绪编辑器组件

新建 `panel/src/pages/PersonaMoodEditor.tsx`，样式写进 `panel/src/styles/personas.css`。在 `PersonaParametersPanel.tsx` 里加一个 `parameterTab === 'mood'` 分支，接法照 `PersonaEnergyEditor`（`form`、`onChange`、`disabled`），心情子页签从占位表里去掉。

所有数据操作都走 `persona-mood-utils.ts` 里现有的函数，组件里不要再写一套逻辑。

参考：
- `E:\Teamworks\Aquarium\doc\plans\persona-tabs\mock-emotions.png`
- `E:\Teamworks\Aquarium\doc\plans\persona-tabs\mock-mood-graph.png`
- `E:\Teamworks\Aquarium\doc\plans\persona-tabs\Main.dc.html`：文案在 `isMood` 那段模板里，逻辑参考 `emoVals()`。

从上到下五张卡：

1. **我的情绪**
   - 标签列表，每个带 × 删除。
   - 输入框加「添加」按钮，回车也能添加；名字重复时显示「已经有了」。
   - 下面一行「情绪库里还有：+名字」，点一下加回来（`restoreMissingMoodEmotions`，或者单个添加）。
2. **切换难度**
   - 一张 600×360 的愉悦×唤醒图：五块区域着色，加区域名，每个情绪是一个点加名字。
   - 坐标换算用 `MOOD_CHART_VIEW` 和 `moodCoordinateFromPointer`，不要另写。
   - 点击一个情绪，选它为「从」；画出它所有出边。允许直接切换的画实线带箭头，不允许的画虚线，选中的那条用橙色。
   - 点一条边，选它为「到」。
   - 按住一个点拖动会改它的坐标（`updateMoodCoordinate`），用 pointer capture，松手才写进 form。
   - 图下面是编辑区，两栏：
     - 「从 → 到」标题，下面一行说明这条边是默认值还是改过的。
     - 切换门槛滑槽（0–0.5，步长 0.01）、至少停留滑槽（0–60 分钟）、允许直接切换开关，三项都走 `updateMoodEdgeSetting`。
     - 「这条边恢复默认」按钮。
     - 「从」情绪的坐标读数，和掌控感滑槽（−1..1，步长 0.05）。
3. **全部切换一览**
   - N×N 矩阵，行是从哪来，列是到哪去，对角线空着。
   - 格子颜色按 margin 深浅；不允许直接切换的格子加斜线；改过的格子加一个小点。
   - 点格子就选中那条边，并滚动到上面的编辑区。
4. **主情绪与副情绪**
   - 副情绪最多几个（0–4）、副情绪门槛（0.2–0.9，步长 0.05）两个滑槽。
   - 下面用当前预览账号的心情给一个实时例子：「现在是 X（主）· 副：Y、Z」。没有预览账号时用基线。
5. **其他**（占位）：回落速度、心情底色、单人影响上限。文案照草图，注明「还没做」。

要求：
- 情绪多到 20 个时，矩阵可以横向滚动，但整页不出现第二条竖滚动条（这是阶段 1 定下的规矩）。
- 键盘能操作：标签、边、格子都是 button，并且带 `aria-label`。
- 在 `test/` 下给组件写一个快照或渲染测试（照现有 panel 测试的写法），至少覆盖三点：五张卡都渲染出来、点情绪后出边数量正确、点矩阵格子后选中正确的边。

### 3. 核一遍后端行为

- 确认 `src/core/mood/core.ts` 切换主情绪时真的按每条边查 margin、dwell、jump。不允许直接切换的边要先经过中间情绪。随机停留系数（`dwellMultiplierForMessageId`）只乘在 dwell 上。
- 好感链不乘随机系数，见上游文档「与状态机交接的对齐」。
- `src/core/shared/hysteresis.ts` 原来的接口保留，好感还在用它。

### 3.5 预览报错文案（AnI 2026-10-24 截图）

现象：
- 「参数 › 好感」的「关系数据」卡显示 `Not found`。
- 「参数 › 心灵能量」显示「返回的 QQ 号或水位无效，请重新读取」。

原因：AnI 当时运行的服务端还是旧版本。新路由 `/api/personas/:id/affinity-preview` 在旧服务端上不存在，请求落到 `src/panel-server/app.ts` 第 502 行的兜底 404。旧版 `/api/mood` 也不返回心灵能量预览要校验的字段。代码本身没问题，重启服务端就好。

但这两处报错文案让人看不懂，要改：
- `panel/src/pages/PersonaAffinityEditor.tsx`（约第 259 行）：请求返回 404 时显示「服务端还是旧版本，重启后再看」。
- `panel/src/pages/PersonaEnergyEditor.tsx`（约第 107 行）：`isMoodPreview` 校验不过时也显示这句，同时在 `console.warn` 里打出实际返回的内容。
- 两处都留一个「重新读取」按钮。

### 4. 验证并提交

依次跑下面三条，三条都通过才提交：
1. `npm run check`
2. `npm run panel:build`
3. `git diff --check`

有失败就修好重跑，不要跳过测试，也不要把测试注释掉。

提交时只 `git add` 阶段 5 相关的文件（见上面的「现状」），提交信息写 `feat(persona): 情绪库与情绪编辑器`。然后在 `E:\Teamworks\Aquarium\doc\plans\PERSONA-PAGE-TABS.md` 末尾追加一行：`- 2026-10-2x · 阶段 5 · <提交号>`。

在交付说明里写上：请 AnI 启动后看「人设 › 参数 › 心情」和「总览」的心情卡。
