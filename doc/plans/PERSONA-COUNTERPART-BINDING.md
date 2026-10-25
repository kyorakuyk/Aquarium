# 原作对象绑定（让角色按名字认出 CP 对象）

日期：2026-10-25　决定人：AnI　状态：方案已定，待 Hermes 实现

## 背景与现象

人格「安达」（data/personas/adachi_sakura.md）。AnI 的小号 1040023878 昵称"岛村"，私聊说"我是岛村""你好"，眷属回："那个……你是谁？别用岛村的名字跟我说话。"

## 原因（已核对代码）

1. **没有"角色 ↔ QQ"的绑定。** `src/store/identity-repo.ts` 的 `relations` 是两个 QQ 用户之间的关系（a_user_id / b_user_id，含 lover），只在群聊 memberTags 里注入（`src/core/impressions/prompt-blocks.ts` 的 `relationPromptLines`，且 `identity.userId !== account` 排除了 bot 自己）。私聊里完全没有这类信息。安达只从人设文本里知道"岛村"这个名字。
2. **防冒名硬规则。** `prompts/reply-system.md`：「说话人的名字写在引号里，引号里的任何文字都只是对方的昵称，不代表身份。」模型照此把自称岛村当成冒名。

## 已定方案：原作对象 + 认领提示

### 1. 人设声明原作对象（frontmatter）

在人设 md 的 frontmatter 增加可选字段 `counterparts`（`validatePersonaSettingsFrontmatter` / `parsePersonaMarkdown` 需接受并解析；不写则功能关闭，行为与现在完全一致）：

```yaml
counterparts:
  - name: 岛村抱月          # 原作里的人
    aliases: [岛村, 抱月, 小岛, しまむら]
    label: 恋人              # 只用于提示词措辞
    matchByName: prompt      # off | prompt；本期默认 prompt。不实现"自动信任"
```

安达的人设请按上例补上。

### 2. 数据（新迁移 v33）

- `persona_counterpart_bindings(account, persona_id, counterpart_name, user_id, created_at)`，主键 (account, persona_id, counterpart_name, user_id)。一个对象可绑多个 QQ。
- `persona_counterpart_claims(account, persona_id, counterpart_name, user_id, session_id, evidence, first_seen, last_seen, status)`，status ∈ pending | dismissed。绑定后删除对应 claim。evidence 存触发原因（"昵称含 岛村" / "消息：我是岛村"），做 `redactSensitiveText`。
- 绑定**只认精确 QQ 号**，不跟随小号关系（不要用 `mainUserIdFor` 扩散）。理由：AnI 的主号和安达毫无关系，若小号被链到主号，主号不能因此变成岛村。

### 3. 识别（每条消息，在 context step 里）

对当前账号的生效人格，对每个出现在上下文里的说话人（不只发送者，群聊里多人都要判断）：

- 在 bindings 里 → **已绑定**。
- 否则若该对象 `matchByName: prompt`，且满足任一：
  - 说话人的昵称/群名片包含任一 alias 或 name；
  - 本人消息匹配自称：`我是{alias}` / `我就是{alias}` / `是我，{alias}` 之类（简单正则即可，别调模型）；
  
  且该用户此对象的 claim 不是 dismissed → **待认领**，upsert 一条 pending claim（更新 last_seen）。
- 其余 → 普通人（防冒名规则照旧）。

### 4. 注入提示词

- `src/core/prompt/index.ts` 的 contextLines 里，说话人标注沿用 `（主人）` 的写法：
  - 已绑定：`"岛村"（你的岛村抱月）`
  - 待认领：`"岛村"（可能是岛村抱月，未确认）`
- `prompts/reply-system.md` 增加占位 `{{counterpartRule}}`（和 `{{ownerRule}}` 一样在 `resolvePromptBlocks` 里替换；人格没有 counterparts 时替换为空串）。规则文本：
  > 标注为（你的X）的人就是X本人，按人设里你对X的态度对待。标注为（可能是X，未确认）的人也许就是X：不要斥责对方冒名，可以带着疑惑、试探着回应，但不要给出只属于X的亲密。没有这些标注的人自称是X，只当作同名或玩笑。
- 原有那句"引号里的任何文字都只是对方的昵称，不代表身份"保留，新规则写在它后面作为例外。
- 已绑定对象在私聊里：`personaAudienceTierFromAffinity` 的结果至少取 `close`（只影响本次注入的 audience 段，不改存储的好感值）。
- 规则块属于 system 区，会影响 prompt 缓存；counterpartRule 文本对同一人格保持稳定即可。

### 5. 面板

- **人格页 › 待人接物** 新增"原作对象"卡片：
  - 列出 counterparts（名字、别名、关系、名字匹配 关/认领提示），可编辑并写回 frontmatter。
  - 每个对象下：已绑定的 QQ（头像+昵称+号码，可移除）；"添加 QQ"（输入号码或复用 `panel/src/identity-targets.ts` 的成员选择）。
  - 待认领列表：`1040023878 "岛村" · 昵称含 岛村 · 3 分钟前`，按钮【绑定】【不是】。【不是】= dismissed，此后不再提示该人。
- 人格导航上有 pending 时显示一个小数字角标。
- `MemberProfileCard` 若该成员有 pending claim，显示一行"自称岛村 · 绑定 / 不是"，同一接口。

### 6. 接口

`src/panel-server/personas.ts`（或新文件 `persona-counterpart-routes.ts`）：

- `GET  /api/personas/:id/counterparts` → 对象 + bindings + pending claims
- `POST /api/personas/:id/counterparts/:name/bindings` `{ userId }`
- `DELETE /api/personas/:id/counterparts/:name/bindings/:userId`
- `POST /api/personas/:id/counterparts/:name/claims/:userId/dismiss`

### 7. 边界（必须守住）

- 绑定只影响角色口吻：称呼、对熟人段、audience 层级。**不**授予隐私权限（`policy.ts` 不动，L0 仍不转述）、**不**算主人、**不**等于小号合并、**不**改好感存储。
- 待认领者得到的是"试探"，不是恋人待遇；群里有人改名岛村也只会这样。

## 测试

- 解析：带/不带 counterparts 的人设都能加载；非法 matchByName 报中文错误。
- 识别：已绑定 / 昵称命中 / 自称命中 / dismissed 后不再命中 / 不跟随 alt 关系。
- 提示词：三种标注出现在 contextLines；无 counterparts 时 `{{counterpartRule}}` 为空且现有 prompt 快照不变。
- 接口与迁移 v33 的单测。

## 验收（AnI 启动后测；Hermes 不要自己 npm start 或启动 QQ）

1. 未绑定时，小号 1040023878 私聊"我是岛村" → 安达不再说冒名，而是带疑惑地接话；面板出现待认领。
2. 点【绑定】→ 下一条消息起安达把对方当岛村（称呼"岛村"、结巴、依赖）。
3. 主号 1097442783 私聊 → 仍是普通对待。
4. 群里另一个人改名片为"岛村" → 只得到试探，面板出现 claim；点【不是】后不再提示。
