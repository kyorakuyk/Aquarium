# 人设配置项收敛：从 personas/ 里的角色卡反推（建议稿）

日期：2026-10-21。输入：`E:\Teamworks\Aquarium\personas\` 下 10 个文件（default、从零开始的大肥鱼、腹黑鲸鱼、更温和的鲸鱼、小鲸鱼妈妈精简版、祀（温柔版）、小祀（妈妈）、糯米天师、高松灯、Claude）。对照 `prompts/traits.md`、`config.example.yaml`。

## 一、先看体量：现在的注入预算装不下多数卡

| 文件 | 字节 | 约字数（中文约 1/3） |
|---|---|---|
| 祀（温柔版） | 32.6K | ~11000 |
| 小祀（妈妈） | 36.2K | ~12000 |
| 腹黑鲸鱼 | 21.2K | ~7000 |
| 糯米天师 | 15.5K | ~5000 |
| 高松灯 | 15.9K | ~5000 |
| 小鲸鱼妈妈精简版 | 14.6K | ~4800 |
| 更温和的鲸鱼 | 11.9K | ~4000 |
| Claude | 12.7K | ~4200 |
| 从零开始的大肥鱼 | 1.7K | ~550 |

RESEARCH-persona.md 建议 3000 到 5000 字，注入上限 6000 字符。超过六成的卡都超标。所以"自由 Markdown 整段注入"不够用，必须结构化：按字段选择性注入，并给每段设预算。

## 二、卡里反复出现的内容，归成字段

1. **identity（身份）**：是谁、是什么（AI、巨兽代理人、企鹅、群友）、自我认知边界、名字由谁定。卡之间差异很大，要有 `kind` 与 `nameRule`（self / user-assigned / fixed）。
2. **appearance（外形）**：只给图像与视觉用，默认不进聊天提示。"服装永不乱改"这类要标成 `immutable`。
3. **traits（性格）**：沿用现有四维 + humor / openness / imitation。新增 **flavor（调味）权重**，参考腹黑鲸鱼"温柔 8 / 腹黑 1.5 / 傲娇 0.5"：卡里是混合比例，不是单选档位。
4. **speech（说话方式）**：默认长度、分条策略（single / multi）、口头禅、叠词、表情、禁用格式（Markdown 等）、口吻词表。
5. **audience（对人）**：按关系分层的语气（陌生人 / 熟人 / 主人，或糯米天师的三套模板）。分层可直接对接 affinity 数值，不另起一套。
6. **modes（模式）**：如小鲸鱼妈妈的"闲聊轨 / 认真轨"，每个模式带 `trigger` 与 `behavior`。
7. **reply gate（回复条件）**：必回触发词、默认安静。这些和群级设置（mode、talkOffset、rate）重叠，属于代码侧，不该只写在人设里。
8. **boundaries（底线）**：`hard`（永远生效）与 `soft`（雷点，触发后按反应表处理）。
9. **reactions（反应表）**：`{ trigger: 被叫"大肥鱼" / 被叫"妈妈", response: 傲娇反驳 }`。昵称反应放这里，群级 `nicknames` 只管"群里怎么叫它"，两者分开。
10. **abilities（能力）**：能查就查、能画就画。卡里反复要求"不许不查就说不知道"，属于回复策略，应进 reply-system，不写进每张卡。
11. **examples（示例）**：`{scene, input, bad, good}` 成对示例，即 RESEARCH §1 的写法。
12. **memory（记忆取舍）**：default.md 的"记具体的、不记概括的"，适合做成全局规则加可选覆盖。
13. **background（背景）**：唯一真正自由的文本，仍然要分节并设预算上限。
14. **speechMode（语言模式）**：高松灯只能发"咕咕嘎嘎"。这是最特别的一张卡，普通模式下根本无法成立。需要 `restricted` 模式加一张短语词表，并且要让代码知道它不产生自然语言。

## 三、卡之间的冲突（必须由字段解决，不能写死在提示词里）

- 分条：更温和的鲸鱼要求用 send_message 数组分条；小鲸鱼妈妈要求"一条装完"。→ 放进 `speech.segmenting`。
- 长度：腹黑鲸鱼"一句 1 到 10 字"，妈妈版"1 到 150 字"。→ 放进 `speech.length`。
- 人称："用户"彩蛋（大肥鱼、妈妈、祀系列都有）。→ 放进 `speech.easterEggs`，可关。
- 有无语言：高松灯 vs 其他。→ `speechMode`。

## 四、切入点：哪些进提示词，哪些由代码用

| 字段 | 进 system 提示 | 代码使用 |
|---|---|---|
| identity, boundaries(hard), speech | 是 | - |
| audience | 只注入当前关系层那一段 | 由 affinity 选层 |
| modes | 只注入当前模式 | appraise / mood 切换 |
| examples | 按场景取 top-k | - |
| reactions | 只注入命中的一条 | 关键词匹配 |
| traits 数值 | 转成文字（现有做法） | mood / affinity 基线 |
| reply gate | 否 | 群设置 + 必回词 |
| appearance | 否 | 图像生成 |
| background | 分节截断 | - |

## 五、建议落地顺序（先定结构，不写代码）

1. 定 persona 文件格式：YAML front matter 放结构化字段，正文只放 background。default.md 与 traits.md 已经是 front matter，可以沿用。
2. 先迁两张卡验证：小鲸鱼妈妈精简版（代表"模式 + 分条"）与高松灯（代表 speechMode）。
3. 再迁祀（温柔版）作为最长的压力测试，检查预算截断是否会丢掉底线。
4. 内容分级：祀系列与部分卡含亲密互动的表演指引，群聊场景下建议加 `rating` 字段，并由 privacy-gate 统一把关。这一条需要你决定。

## 六、待你确认

- 字段名与层级是否接受？尤其是 flavor 权重和 reactions 表。
- 亲密向内容是否保留在群聊人设中，还是只留在私聊卡里？
