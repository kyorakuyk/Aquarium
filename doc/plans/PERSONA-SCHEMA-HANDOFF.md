# 人设结构化交接（给 Hermes）

依据：`notes/persona-config-convergence.md`、`notes/persona-schema-example.md`（均在项目文件夹）。
范围：只做人设文件的结构化解析与分段注入。不改群设置、不改好感度与心情算法、不改 reply-system 的固定规则。

## 目标
1. 人设文件改为 YAML front matter + 正文（正文仅作 background）。字段见示例文件。
2. 注入按字段选择性进入 system 提示：identity、boundaries.hard、speech 常驻；audience 只注入当前关系层；modes 只注入当前模式；reactions 只注入命中的一条；examples 按场景取 top-k；background 分节截断。
3. 各段设预算，合计默认上限 6000 字符，截断优先保留 boundaries.hard 与 speech。
4. 代码侧使用：traits 数值交给 mood / affinity 基线；speech.segmenting 决定分条发送；reply.mustReply 与群设置一起决定是否回复；appearance 不进聊天提示。
5. speechMode 为 restricted 时（如高松灯），只注入词表，不注入"自然语言"类规则。

## 不做
- 不引入新的好感度或状态系统。
- 不改 prompts/reply-system.md，只允许人设字段覆盖其中的"分条数、长度"两条，并以字段为准。
- 不删除现有 default.md 与 traits.md 的读取路径，保持向后兼容。

## 验收
- default.md（只有 traits 与一段正文）加载结果与改动前一致。
- 小鲸鱼妈妈精简版迁移后，不超过预算，"认真轨"触发时模式段被注入、闲聊段不注入。
- 高松灯（restricted）迁移后，提示中不出现分条或长度规则。
- 祀（温柔版）迁移后，boundaries.hard 在截断后仍保留。

## 边界
- 不运行 npm start，也不启动 QQ 或 SnowLuma；需要时请 AnI 自己启动。
- 亲密向表演内容暂不迁入群聊卡，等 AnI 决定分级方案。
