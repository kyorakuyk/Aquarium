# 参考项目调研汇总（2026-10-19）

> 用途：写 M3 规格时引用。**只借思路**的项目不得复制代码与提示词原文。
> 许可证：QQ-agent MIT（可移植，需署名）· Tulpa MIT（可移植，需署名）· ai-bot-groupmate Apache-2.0（可移植，需署名）· MaiBot GPL-3.0（只借思路）· qq-bridge 自定义长许可、引用 SnowLuma EULA（**只借思路，不碰代码**）· SnowLuma 非商业源码可见（只在适配层用 SDK）。

## 1. 私聊信息分级（M3 第一项，后续一切的前提）
- **决策集中在一个纯函数**（qq-bridge `src/core/session-router.mjs`）：输入“信息来源会话、目标会话、信息级别”，输出允许或禁止；遇到无法识别的情况一律禁止。全项目只调这一处，可以单测。
- **按方向分开关，默认全关**（MaiBot `memory/heuristic_injector.py`）：私聊→群、群→私聊各一个开关；同一会话内永远允许。
- **结构约束与提示词约束双保险**：私聊信息在代码层面就不进群聊提示词；提示词里再写一句“不要把私聊内容带到群里”（MaiBot `chat_loop_service.py`）。
- **出口闸门**（ai-bot-groupmate `src/egress.js`）：发送前统一检查，拦截密钥、本机路径这类内容。
- **能力位思路**（Tulpa `chatlocal/mcp_access.py`）：每项能力是一个独立开关，默认关闭，并按会话限定范围。
- **教训**：qq-bridge 的 `web_search` 会把关键词发给 Bing。任何第三方请求（搜索、抓取）都不得包含 L1/L2 信息。

## 2. 表达方式与黑话学习
- **口头禅用纯统计**（groupmate `src/style-profile.js`）：只统计 60 字以内的消息，取 2–4 字滑窗，出现 3 次以上才采用，每人最多 24 个，停用词整词匹配。不调用模型。
- **黑话按出现次数分档推断**（MaiBot `learners/jargon_miner.py`）：第 4、8、25、100 次出现时各调用一次模型推断，到 100 次后不再推断；只有推断结果与旧释义不同才判为黑话。
- **注入上限**（MaiBot `jargon_context_matcher.py`）：每轮最多 10 条；非全局的黑话只在它所在的会话里匹配。
- **允许选 0 条**（Tulpa `select_chat_expressions`、MaiBot `expression_checked_only`）：模型可以这次不用学来的表达；也可以只用经过审核的表达。
- **抽取门槛**（MaiBot `expression_learner.py`）：至少攒满 10 条可学的消息才抽取一次；并发设上限。
- **从第一天就设上限**：qq-bridge 的 `slang.json` 只增不减，后来才补 2000 条上限。
- 与我们的“模仿”维度对接：用它控制注入的条数和频率。

## 3. 回复效果追踪
- MaiBot `maisaka/reply_effect/`：观察窗口 1800 秒，每会话最多看 15 条后续消息；分数 ≈ 是否有人回应 0.45 + 回应人数 0.25 + 回应深度 0.20；用模型做裁判，最多带 20 条上下文。
- **必须剔除**：其中的 `activity_lift`（发言量提升）本质是在优化互动量，违反 GOALS §5.4。
- MaiBot 的评分只存不用，没有闭环。我们如果做闭环，**只用来调整发言时机和表达方式**。

## 4. 意图池（跟进、承诺、未完的话题）
- 几个项目都没有现成实现，要自己设计。可借鉴的零件：
  - **限流加租约**（qq-bridge 唤醒机制）：每分钟最多 1 次、每小时最多 12 次，挂起超过 30 分钟就释放，防止意图永远挂着；
  - **承诺只认自己明确说出口的**（Tulpa `chatlocal/llm.py`）；
  - **按新鲜度过期**（groupmate `session-archive.js`：超过 6 小时不恢复）；
  - **结果未知不重发**（qq-bridge `mcp-snowluma-safe.js`、Tulpa `mcp_reactions.py`）；
  - **主动发言与被动回复分开限流**（groupmate `proactive.js`）。

## 5. 多个眷属互动防循环
- 几个项目都只识别“自己”，**没有一个识别别的 bot**，需要从零设计：一份已知眷属列表、眷属之间连续轮数设上限、分层限流（groupmate `brain.js` 的每分钟和每小时限制）、只认带发送回执的回显（Tulpa `consume_sent_echoes`）。

## 6. 表情包（已写入 PLAN §12.7）
- 来自 QQ-agent `src/sticker-manager.js`：QQ 图床链接约 1 小时过期，必须转存到本地；只存相对路径（它曾因数据目录搬家，导致 16 条收藏全部失效）；发送前检查，按 本地 → `get_image` → base64 回退。
- SnowLuma 的 `send_custom_face` 按 emoji_id 发送，保留 QQ 原生表情样式，并且每次取最新链接。

## 7. 可靠性教训（QQ-agent，已部分写入 V18a）
- 动作超时要按类型分档：1.5–2MB 的图片在 15 秒内必然超时。
- 发出的消息 8 秒内去重：超时看似失败、实际已经发出，重试就会重复发。
- 配置损坏不能回落默认值，否则下一次保存会覆盖用户的全部配置。
- 日志要有上限：它出过一次递归事故，单日日志写到 15GB。
- 中转站可能返回非 JSON 的响应体（空串、截断），要当作可重试错误处理。
- 不要让模型用工具循环来决定发什么：会导致重复发送和内心戏外泄（它为此专门写了 reply-rescue）。

## 8. 联网搜索与网页抓取（DeepSeek 官方，2026-10-19 开放）
- 搜索：`POST https://api.deepseek.com/v1/tools/search`。参数：`query`（1–128 字，支持 `site:` `lang:` `after:` `before:`）、`count`（默认 10，最多 50）、`ori_question`、`localization`、`need_content`（默认 false）。每条结果有 `rerank_score`（0–3）、`authority`（0–4）、`date`。
- 抓取：`POST https://api.deepseek.com/v1/tools/fetch`，传 `url`（最长 8192 字符），返回 `title` 和 Markdown 格式的 `content`。
- 鉴权：Bearer，与 Chat Completions 共用密钥。计费：2026-11-01 起，每个接口每千次成功请求 0.75 美元；限流为每个接口 5 QPS。
- Responses API 里的 `web_search` 已于 2026-09 下线，相关字段会被静默忽略，**不要用**。
- 设计方向：由壳子决定是否搜索（判断那一步输出 `needSearch` 和搜索词），壳子去调用接口，结果整理成提示词块；降级链为 DeepSeek → Bing 等搜索引擎。群友分享链接时，可以用 fetch 读取摘要。**排在私聊分级之后做**。
- 来源：七牛新闻 <https://news.qiniu.com/archives/1792373734665>；LINUX DO <https://linux.do/t/topic/2894368>；80aj <https://www.80aj.com/2026/08/05/deepseek-api-web-search/>。参数以官方文档为准，实现前需再核对一次。

## M3 建议顺序
私聊分级 → 联网搜索与链接抓取 → 表达方式学习 → 意图池 → 回复效果追踪 → 多眷属互动。
