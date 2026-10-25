# 新卡对比与常驻 / 选填字段划分（建议稿）

日期：2026-10-21。新增：personas\安达樱.md、personas\岛村抱月.md（Gemini 据小说原文整理，英文键名，分节为 Profile / Personality / Tone / OOC / Psychology）。

## 一、新卡和现有字段的对应

| 新卡分节 | 对应字段 | 备注 |
|---|---|---|
| Name / Aliases | identity.name、name.aliases | 别名是"别人怎么叫它"，要与群级 nicknames 分开 |
| Gender / Age | identity.gender、identity.age | 原表没有这两项。年龄对内容分级有影响，见第四节 |
| Appearance | appearance | 只给图像用 |
| Background | background | 自由文本，预算截断 |
| Personality & Psychology | traits（四维）+ 新增 psychology | 新卡没有四维数值，要从描述推断，或让用户手填 |
| Tone & Speech Style | speech + audience | "对谁用什么称呼"是新增需求，原表只有泛化的 audience |
| OOC Rules | boundaries.hard | 和现有"底线"同类，直接并入 |
| Psychological Depth | psychology（新增） | 创伤、防御、触发点，没有对应字段 |

新卡带来两件原表没有的东西：**按对象指定称呼**（安达对岛村叫"抱……抱月"，对别人冷淡），以及**心理机制**（触发点、防御方式）。

## 二、常驻表单（必填，表单默认展开，不填则不能保存）

1. **名字与称呼**：name、aliases。
2. **身份**：identity.kind、selfAwareness、nameRule。
3. **性格**：traits 四维（默认 0），不填时按中性注入。
4. **说话方式**：first person、length、segmenting、catchphrases（可空），以及 speechMode（默认 normal）。
5. **底线**：boundaries.hard（至少一条）。新卡的 OOC 规则并入这里。

理由：这五组在 12 张卡里都有对应内容，缺任何一组，注入的提示都会不完整或不能跑。

## 三、选填（用户主动添加，表单里是"+ 添加"按钮）

- 外形 appearance（只给图像用）
- 调味 flavor（腹黑鲸鱼那种混合比例）
- 按对象称呼 audience（安达的例子）
- 心理机制 psychology（创伤、防御、触发）
- 模式 modes（闲聊 / 认真等）
- 反应表 reactions / nicknameReactions
- 示例 examples
- 能力 abilities、记忆规则 memory
- 背景 background
- 内容分级 rating

## 四、需要你决定的一件事：内容分级

安达樱与岛村抱月都标注为 16 到 17 岁，原作的情感线里有大量肌肤接触与亲密描写（牵手、大腿枕、拥抱、接吻）。这类内容放进群聊人设不合适。我的建议：

- 新卡只保留性格、说话方式、称呼与心理机制。
- 不迁入亲密与肢体接触的描写，包括 OOC 与微表情里的相关条目。
- 如果要保留这两张卡，请先在卡上标 rating: restricted，并且群聊不启用。

这一条我没有替你做决定。请回复：是只保留性格与语气，还是要其它处理。

## 五、建议

先把"常驻五组"做成表单必填，其余做成可添加的小节。新卡的亲密相关条目先不迁入。

## 六、已确定（2026-10-21，AnI 确认）

- 常驻（必填）：名字与称呼、身份、性格四维、说话方式、底线。
- 添加（选填）：外形、调味、按对象称呼、心理机制、模式、反应表、示例、能力与记忆、背景、内容分级。
- 安达樱与岛村抱月只作为字段测试数据，不用于群聊。其中亲密相关内容不迁入群聊卡。
- 字段名：persona-schema-example.md 的字段名已确认（AnI 回复"定了，出吧"）。以该示例为准，实现时按它来。
- 未定事项（暂不实现）：persona-config-convergence.md 中的待确认事项，包括内容分级的具体做法、按对象称呼（audience）是否进第一版、心理机制（psychology）是否进第一版。这些等 AnI 确认后再做。
- 本节为最终版。第二、三节与本节一致；第四节的内容分级仍按第六节"亲密相关内容不迁入群聊卡"执行。
