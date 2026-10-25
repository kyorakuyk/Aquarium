# 知识 / 印象拆分方案（2026-10-22）

状态：设计已与 AnI 讨论定稿，待 Hermes 实现。前置：V4 验收修复（V4-ACCEPTANCE-FIXES.md）先收尾，再动本方案。
范围：不改好感度与情绪算法，不改 reply-system 固定规则，不运行 npm start、不启动 QQ/SnowLuma。

## 目标
- 面板「日常/印象」改名「知识」：客观中立的事实，同一眷属组内共有。
- 面板「塑造」新增「印象」：每个人格自己的主观看法。

## 数据
1. 标签表加 `kind`（fact | view），按 category 回填：
   - fact：positioning topic norms meme recent schedule identity fandom catchphrase；关系线属 fact。
   - view：atmosphere personality speech social dislike；polarity 非空的一律 view。
   - locked / manual 的标签保持原状，只补 kind。
2. 新表 persona_impressions：(persona_id, account, session_id, user_id|null, text, norm, category, certain 0|1, source, first_seen, last_seen, evidence_json)。初期由 inferred 标签与好感度笔记迁入，certain=0；manual 与被反复印证的为 1。
3. 眷属组：新表 kin_groups（手动在面板勾选，不自动推断）。知识按 (kin_group, 会话, 成员) 共有。
4. 新表 persona_memos、persona_diaries（见「作息」）。

## 共有知识：置信度与注入
- 置信度 = 现有 activation（samples、last_seen、半衰期）；被再次提到或命中则升高，不命中按半衰期衰减。
- 数值不进提示词。阈值选条目：升到 0.5 才进、降到 0.35 才出（迟滞，防抖）。入选条目按固定顺序（category 再 norm）排列，不按分数排，保证前缀稳定、缓存命中。
- 面板照旧显示置信度与来源（self_report / stats / inferred / manual / 转述）。
- 沿用 GROUP_TAGS_LIMIT 与 MEMBER_TAGS_LIMIT。

## 私有印象：确定 / 不确定
- 只有两态。不确定的条目注入时文本后加半角 `?`（借 TS 可选语法），如 `喜欢猫?`；确定的不加。
- 提示词块位于知识块之后，措辞「以下是你个人的看法，不确定的带 ?，可与他人不同」；单独小额度，不挤占人设预算（boundaries.hard、speech 优先保留）。
- 升级为确定：多次印证或手动确认；长期不印证则淘汰。

## 眷属私下交流：转述
- 默认仍按 `src/core/privacy/policy.ts`：私聊内容不直接进别的眷属的知识。
- 新增流向「转述」：A 私聊所得，仅当 A、B 同属一个眷属组，且信息主人的级别为 L1/L2 时，生成给 B 的「听 A 说的」条目，来源=转述，置信度从低位开始。L0 永不转述。
- 转述必须走 `decide()`（目标改为眷属），不另立规则。

## 作息
- 白天：每个人格只写 memo（今天谁说了什么、未确认的事），不改知识与印象。
- 「睡着」时整理：memo 合并进知识（走置信度增减）；更新自己的印象（不确定的升级或淘汰）；分发转述；可写一篇日记，作为近期回忆只注入给本人格。日记默认面板可见，可设为仅人格自知。
- 夜间集中调用模型，受现有预算（budgetState）约束，超限则跳过并记录。

## 面板
- 「知识」页：沿用 V4 成员页、对话框、历史导入，隐藏 view 类 category，增加置信度/来源列与眷属组选择。
- 「塑造/印象」页（新设计）：按人格、按成员列看法，确定/不确定（?）标记，「提升为知识」操作，日记与 memo 查看。

## 分步
1. 加 kind 与回填迁移，只改注入，页面不动。
2. 页面改名「知识」，置信度阈值与迟滞注入。
3. persona_impressions、「塑造/印象」页、? 标记注入。
4. 眷属组、转述、memo/日记与睡眠整理。
每步一个提交，跑 `npm run check` 与 `npm run panel:build`。

## 验收
- 回填后旧库打开无报错，标签总数不变。
- 同一批数据多次注入，知识块字节级一致（缓存前缀稳定）；阈值边界不抖动。
- 私聊 L0 信息不出现在别的眷属提示词里；L1/L2 只以「听 A 说」形式出现。
- 不确定印象在提示词里带 `?`，确定的不带。

## 给 Hermes 的提示词
请读 E:\Teamworks\Aquarium\doc\plans\KNOWLEDGE-IMPRESSION-SPLIT.md 和 E:\Teamworks\Aquarium\doc\plans\V4-ACCEPTANCE-FIXES.md，先确认 V4 验收修复已完成，再按「分步」从第 1 步做起，每步一个提交。参考代码：E:\Teamworks\Aquarium\src\core\impressions\（tag-model.ts、tags.ts、prompt-blocks.ts）、E:\Teamworks\Aquarium\src\core\privacy\policy.ts、E:\Teamworks\Aquarium\src\store\tag-repo.ts。不运行 npm start，不启动 QQ 或 SnowLuma，需要时请 AnI 自己启动。每步完成后跑 npm run check 和 npm run panel:build。
