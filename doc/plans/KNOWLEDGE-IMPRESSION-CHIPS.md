# 知识 / 印象页改版：色卡化

日期：2026-10-23　状态：前端实现完成，待 AnI 重启面板验收
设计稿（静态 HTML，可直接用浏览器打开）：`E:\Teamworks\Aquarium\doc\plans\knowledge-impressions-mock.html`

只改面板前端展示，不改数据库、不改提示词注入。唯一可选的后端改动见第 3.4 节。

---

## 1. 背景

- 「知识」页（`#/impressions`）：每个标签是一条拉满整行的胶囊，右边再挂「置信度 0.97 / 来源 推断」两列和一个锁按钮，一个群的分类标签要占一屏半。空类别每个占一行“暂无 ＋”。
- 「印象」页（`#/personal-impressions`）：每个人一张大卡，卡里通常只有一条印象，却有三个按钮和一行灰字说明。没有按类别分组，也没有左侧选择，显得乱。
- 雪的方向：知识页改成色卡，置信度越高颜色越深，来源放进点开后的菜单；印象页做成“简化版知识页”，固有材料（作息与出没、身份与关系、成分、口头禅等）只在知识页，印象页只留人设视角的看法。

## 2. 知识页

涉及文件：
- `panel/src/components/MemberTagRows.tsx`（`KnowledgeTagEntry`、`TagRow`、`MemberTagRows`、`PROFILE_ROWS`、`GROUP_ROWS`）
- `panel/src/components/ImpressionTag.tsx`（`ImpressionTag` 色卡按钮与弹层）
- `panel/src/styles/impressions.css`（`.profile-tag-*`、`.tag-lock-toggle`、`.tag-delete-toggle`）
- `panel/src/styles/pages.css` 第 256–276 行附近的 `.tag-chip*`、`.tag-popover`
- `panel/src/impressions-model.ts`（新增分档函数）

### 2.1 色卡

1. `KnowledgeTagEntry` 去掉两列 `profile-tag-meta`（置信度、来源），只渲染 `ImpressionTag`。`.profile-tag-entry` 不再 `flex: 1 1 100%` 和三列 grid，色卡宽度跟文字走，同类别的色卡在一行里换行排列（`.profile-tag-content` 已经是 `flex-wrap`）。
2. 色卡高度 30px 左右、圆角 7px、字号 13px，不再是 44px 胶囊。为了触屏可点，按钮外留透明 padding 或用 `::before` 扩大点击区，不要回到 44px 的视觉高度。
3. 填色按置信度（`tag.activation`）分 5 档，在 `impressions-model.ts` 新增并写测试：
   ```ts
   export function confidenceLevel(value: number): 1 | 2 | 3 | 4 | 5
   // <0.4 → 1, <0.6 → 2, <0.8 → 3, <0.9 → 4, 其余 → 5（边界含下限）
   ```
   色值在 `styles/tokens.css` 新增 `--conf-1`…`--conf-5` 及对应文字色 `--conf-1-ink`…，参考设计稿：`#EAF2F0 / #CFE3DE / #9CC6BE / #4F8F87 / #1C5F5A`，后两档白字。tokens.css 目前没有暗色主题，不用补。
4. 状态不再决定填色，只决定边框：
   - 已确认：无边框。
   - 候选：1.5px 虚线框（深色档时用 outline 虚线，保证看得见），保留 `1/2` 观察计数小字。
   - 手动：色卡右侧一个小圆点。
   - 已锁定：色卡内一个小“锁”字（现有 `tag-lock-indicator`）。
   - 未进入提示词（低于注入阈值，或已锁定）：加一圈 1px `--line` 细框。阈值沿用现有注入逻辑的判断；如果前端拿不到“是否注入”，这一条先跳过，在交付说明里写明。
   - 已否决：保持现在“+N 已否决”折叠，展开后用 `--warn-soft` 底色。
5. 徽记小尾巴（`displayText()` 里拼的 `· 自动`、`· 自述 ×3`、近况衰减提示）从色卡文字里拿掉，改进弹层。色卡上只留标签本身（成分的 `主题 › 文字` 保留）。

### 2.2 弹层菜单（`ImpressionTag` 的 `tag-popover`）

点色卡弹出，内容自上而下：
1. 标题：标签文字。
2. 键值区：状态（加“已锁定”）、置信度（两位小数 + 一句话档位“很笃定/比较笃定/一般/还很弱” + 一条细进度条）、来源（`tagOriginLabel` + 原先的徽记，如“统计 · 自动”“自述 ×3”）+ 观察 N 次、类别与主题、喜欢/不喜欢、身份注入标签。
3. 证据：最多 3 条，保持现有渲染。
4. 操作菜单（竖排文字按钮）：确认 / 否决 / 恢复为候选 / 改字 / 锁定或解锁 / 删除并不再学（警示色）。
- 删掉色卡外挂的 `tag-lock-toggle` 和 hover 才出现的 `tag-delete-toggle`，两者的功能都在菜单里。`onLock`、`onDelete` 回调不变。
- 改字表单、敏感词清除逻辑、Esc/点外部关闭都保持不变。

### 2.3 类别行

代码里 `tagKindFor()`（`src/core/impressions/tag-model.ts`）把 `atmosphere, personality, speech, social, dislike, misc` 以及任何带 `polarity` 的标签算作 `view`。`MemberTagRows` 已经用 `knowledgeTags()` 过滤掉 view，所以这些类别在知识页永远显示“暂无”，而手动 ＋ 进去的标签会变成 view，又从知识页消失。改为：

- 群：`作息, 定位, 话题, 群梗, 规矩, 近况`
- 群友：`作息, 自我认同, 成分, 口头禅, 近况`
- 从 `PROFILE_ROWS` / `GROUP_ROWS` 删掉性格、说话风格、社交方式、雷点、氛围、其他。
- 成分行新增时去掉“喜欢/不喜欢”极性选择（带极性就是 view，会跑去印象页）。
- 空类别：不再每类一行“暂无 ＋”。有标签的类别正常成行；所有空类别合成底部一行“还没有：近况 ＋ 规矩 ＋ …”，点某个就在那里展开现有的 `ProfileTagAdd` 表单。

### 2.4 不动的部分

左栏群卡与成员列表、QQ 资料卡、好感度、活跃图、身份与关系面板、眷属组、实际注入的一行，都不在本次范围。`ImpressionsGroupCard` 里定位小标签用的是 `.tag-chip` 全局类，改 `.tag-chip` 样式时注意别把它弄坏；建议新色卡用新类名（如 `.k-chip`）而不是改全局 `.tag-chip`。

## 3. 印象页

涉及文件：`panel/src/pages/PersonalImpressionsPage.tsx`、`panel/src/styles/personal-impressions.css`。

### 3.1 结构：简化版知识页

```
[页头] 印象 ／ 一句说明 ／ 右侧图例（确定 · 不确定? · 待观察?）＋ 多账号时的账号下拉
[左栏 200px]                 [右侧详情卡]
 群                           头像 名字 / 会话 · N 条印象
  群 1004200446   2           类别行：标签 | 色卡 色卡 …
 群友                         类别行 …
  薯条            5
  saki            3
```
- 左栏由现有 `ViewImpression[]` 推出来：按 `sessionId` 分组，先列群自身（`userId === null`），再列该群里有印象的人，右侧数字是条数。多会话就是多段。私聊来源的人放到“私聊”段。默认选中第一项。窄屏（≤680px）左栏变成顶部横向滚动的一行。
- 只列有印象的对象，不需要拉成员列表。
- 右侧详情卡：按类别分行，行标签 + 色卡，样式复用知识页的类别行 CSS。空类别不显示，也没有 ＋（印象页不提供手动新增）。

### 3.2 类别行

- 群（`userId === null`）：氛围（atmosphere）、其他（misc）。
- 群友：性格（personality）、说话风格（speech）、社交方式（social）、喜恶（dislike 类别 + 任何 `polarity !== null` 的标签，显示为 `文字 · 喜欢/不喜欢`）、其他（misc）。
- 落不进以上任何一行的 view 标签放进“其他”，不要丢。
- 类别中文名统一用知识页 `MemberTagRows` 那套（说话风格、社交方式），去掉本页自带的另一套 `CATEGORY_LABELS`（“说话方式”“社交”），避免两页叫法不同。

### 3.3 色卡样式与菜单

- 印象没有置信度，不分深浅：
  - 确定（`certain`）：实心，用 `--conf-4` 底色白字。
  - 不确定：白底、1px 虚线 `--accent` 框、文字后面跟一个强调色的 `?`（沿用 `displayedText()` 的规则，文字本身已带 ? 时不重复）。
  - 待观察（`status === 'candidate'`）：同“不确定”，但虚线和文字用灰色。
  - 已锁定：色卡内小“锁”字。
- 点色卡弹出菜单（复用知识页弹层的外观，不复用 `ImpressionTag` 组件本身，因为动作不同）：
  1. 标题（带 ?）。
  2. 键值：类别、来源（`tagOriginLabel`）、状态、来源会话。
  3. 菜单：确认为确定（仅不确定且 candidate/confirmed 时显示）／提升为知识（不能提升时 disabled，原因用小字写在按钮下面）／删除（警示色）。
- 页面上不再有那行说明小字和三个大按钮。`runAction()`、两次 `window.confirm`、`pendingId` 逻辑不变，只是入口从按钮移到菜单。
- 提升原因里的英文类别名（`factPromotionUnavailableReason()` 返回 `「atmosphere」分类…`）在页面里显示成中文类别名：前端拿到 reason 后把 `「${category}」` 替换为中文标签，或给 `factPromotionUnavailableReason` 加一个可选 label 参数。不要改它在服务端的其他调用含义。

### 3.4 可选的后端小改动

`ViewImpression` 没有 `subject` 字段，带极性的成分印象只能显示文字，看不出主题。可以在 `src/panel-server/view-impressions-routes.ts` 的 `impressionView()` 里加 `subject: tag.subject`（并同步 `panel/src/api.ts` 的类型），喜恶行显示成 `主题 › 文字 · 不喜欢`。不做也行。

### 3.5 保留 P0 已做的东西

- `personalImpressionsErrorText()`、`showEmptyPersonalImpressions()`（`panel/src/panel-feedback.ts`）以及 404 时的中文提示和空状态互斥逻辑都要保留，`test/panel-feedback.test.ts` 必须继续通过。
- 侧栏导航名和路由 id（`personal-impressions`）不改。
- 即时保存回执组件和作息入口（P0-2、P0-3）与本次无关，不要碰。

## 4. 验收

1. `npm run typecheck` 和 `npm test` 通过；为 `confidenceLevel()` 和印象页的“按会话/人分组 + 类别归行”纯函数各补测试（放进 `test/impressions-model.test.ts` 或新文件）。
2. 知识页：截图里那个群（群 1004200446）的分类标签区，在 1440 宽下应在一屏内看完；色卡上看不到置信度数字和来源；点开能看到置信度、来源、观察次数、证据和全部操作。
3. 知识页不再出现性格、说话风格、社交方式、雷点、氛围、其他这几行。
4. 印象页：左栏能切换群和人；右侧按类别成行；确定/不确定/待观察三种样式一眼可分；页面上没有常驻的按钮和说明小字。
5. 404、空数据、加载中三种状态的提示与改版前一致。
6. 不运行 `npm start`，不启动 QQ / SnowLuma；交付后由雪自己重启面板验收。

## 实施记录

- 主改造提交：`5cf6509 feat(panel): 改造知识与印象色卡`。
- 收尾修正：知识标签新增不再提供极性选择，所有手动新增标签的 `polarity` 固定为 `null`；已包含于 `5cf6509`。
- 自动化验收：`npm run check` 通过（920/920，0 skipped，依赖边界检查通过）；`npm run panel:build` 成功，仍有 500 kB chunk 警告。
- 视觉验收待 AnI 重启实际面板确认；前端 `TagView` 没有“是否已注入”字段，因此未显示未注入标记，也未扩展后端。
