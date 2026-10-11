# QQNT Bot 生态调研（2026-10）

> 目的：为 Aquarium 选协议层、找设计参考、明确差异化。
> 调研方式：网页检索 + 本地参考项目源码。第三方页面的数据（星数、版本）以抓取时为准，可能已变化。

---

## 1. 接入 QQ 的三条路线

| 路线 | 原理 | 代表项目 | 现状 |
|---|---|---|---|
| **注入 / Hook 官方 NT 客户端** | 运行真实的 QQNT，注入后调用其内核 API，对外暴露 OneBot / Satori 等接口 | **SnowLuma**（TS）、**NapCatQQ**（无 GUI，可无头运行）、**LLOneBot / LLBot**（基于 LiteLoaderQQNT）、**Chronocat**（Satori 协议） | 主流、仍在维护。NapCat 约 1.09 万星，活跃。QQ 客户端一更新就可能失效，**建议锁定 QQ 版本、关闭自动更新**。LLBot v8.0.9 起可能需要开发者群发放的 AUTH TOKEN。 |
| **协议重实现（第三方客户端）** | 逆向 NTQQ 协议，自己扮演客户端，不需要运行官方 QQ | **Lagrange.Core / Lagrange.OneBot**（C#）、**acidify / Yogurt**（Kotlin 多平台，走 Milky 协议，npm 有预编译包） | 仍在维护，但需要签名服务（Signer Token）。Yogurt 1.6.3 约 3 个月前发布。 |
| **官方 QQ 机器人** | QQ 开放平台的官方 Bot API | — | 唯一被 QQ 认可的方式，无封号风险；但它是“官方机器人”而不是普通账号，做不出“像真人群友”的效果。 |

**已淘汰**：go-cqhttp、QSign（海豹文档明确标注弃用、Android 协议版基本不可用）、mirai（受腾讯反制后式微）。

### 共同风险（所有非官方路线）
- QQ 把第三方 bot 方案当作类似外挂的东西：可能**警告、封号、临时或永久冻结**。→ 必须用小号，接受账号可能丢失。
- **同一账号不能同时登录 PC QQ**；可能需要定期重新登录。
- 协议端会开额外的本地端口：**不要暴露到公网**，否则必须设强密码。

### 对 Aquarium 的启示
1. 协议层选 **SnowLuma 是合理的**：TS、注入路线、自带多账号与 SDK。
2. 适配层要抽象：内部定义自己的事件 / 动作模型，**先实现 OneBot v11 适配器**；以后可加 **Milky**（Lagrange 系的新一代标准，HTTP + WS）或 Satori 适配器，不改核心。
3. Supervisor 要检测 QQ 版本，版本变化时告警（QQ 更新导致注入失效是最常见的故障）。
4. ⚠️ 待验证：Windows 上 QQNT 多开（多账号同时登录）的方式；SnowLuma 多账号时每个账号的 OneBot 端口与配置（`config/onebot_<uin>.json`）。

---

## 2. Bot 框架 / “大脑”层

| 项目 | 语言 | 定位 | 与我们的关系 |
|---|---|---|---|
| **MaiBot（麦麦）** | Python 3.12+，GPL-3.0，约 6.1k 星，v1.3.0 | **目标与我们最接近**：专做 QQ 群里的“生命体”，“更像人，而不只是更好”。懂得何时说话、何时插话、何时安静；模仿群友说话方式、学习黑话；基于人格理论积累对每个用户的偏好、特点、习惯的理解；有插件系统和 WebUI；通过 NapCat 接入 QQ。衍生 fork：MoFox_Bot。 | **最重要的竞品和参考**。它已经做了“开口时机 + 用户画像 + 表达学习”。GPL-3.0：可以借鉴思路，但**不能把它的代码搬进非 GPL 项目**。 |
| **AstrBot** | Python 3.12+，AGPL-3.0，约 4.09 万星，v4.28.1（2026-09-14） | 通用的 agent 化 IM 机器人基础设施：多平台（QQ / OneBot / Telegram / 飞书 / 钉钉 / Discord…）、WebUI、Agent 沙箱、知识库、技能、MCP、上下文自动压缩、1300+ 插件；支持 DeepSeek 等多家模型。 | 广度第一，不专注“像群友”。常见组合是 NapCat + AstrBot。可参考它的 MCP 与沙箱设计。 |
| **OpenClaw**（+ `@hyl_aa/napcat` 插件） | npm CLI | 通用 agent，接 NapCat 后有 45 个 `qq_*` 工具（禁言、踢人、公告…）；人设写在 `SOUL.md`；`groupPolicy`（open / allowlist / disabled）。 | 教程里的痛点（工具默认隐藏、token 不匹配 401、策略太严静默失败、端口冲突、扫码登录因版本而异）正好是我们 UX 要避开的反面教材。 |
| **Koishi** | TS | 大而全的插件化框架，社区内容丰富，Satori 生态 | 想做插件市场时可参考。 |
| **NoneBot2** | Python | 老牌框架，生态成熟（zhenxun_bot 基于它） | — |
| **LangBot** | Python | 多平台 LLM bot，有 Lagrange 接入文档 | — |
| **ai-bot-groupmate**（本地） | JS，Apache-2.0 | OneBot ↔ OpenAI 兼容模型的仿真群友 | 已作为主要设计参考（见 DESIGN.md §0）。 |

---

## 3. Aquarium 的差异化（被问“为什么不用 MaiBot / AstrBot”时）

1. **Windows 一键托管**：托盘程序统一拉起和监控 QQ、SnowLuma、bot，开机静默启动、掉线自愈。现有方案几乎都要求用户分别部署协议端和框架（OpenClaw 教程里的大部分故障都出在这一步）。
2. **多账号 + bot 之间的关系型互动**：多个 bot 知道彼此是 bot，有互相的关系状态；对话以“关系的展现”为重心，根据真人的实时反馈与双方情绪决定继续或收尾。调研范围内没有看到现成实现。
3. **可解释的群友画像 + 私密信息分级**：标签可追溯到原话、带可信度和衰减、排除敏感类；私聊信息按 L0/L1/L2 分级，守门与生成信息隔离。
4. **评测驱动**：离线回放评测（开口判断 F1、人设一致性 LLM-as-judge、成本 / 缓存命中率、私密信息泄露测试）。
5. **配置 UX**：所有设置任何时候都可改、两层继承、热重载，直接针对 Tulpa 的痛点。

**建议**：动手写 M2 的开口策略和画像之前，先实际跑一下 MaiBot、读它的设计文档，作为对照组；评测 CLI 也可以拿它当基线对比。

---

## Sources
- [QQ 机器人漫谈（yuier，2025-03）](https://yuier.com/posts/003-qq-bot-brief-introduce)
- [海豹骰 QQ 接入文档](https://docs.sealdice.com/deploy/platform-qq.html)
- [NapCatQQ（SourcePulse）](https://www.sourcepulse.org/projects/2411677)
- [acidify / Yogurt（klibs.io）](https://klibs.io/project/LagrangeDev/acidify)
- [MaiBot 文档](https://docs.mai-mai.org/en/about/) · [MaiBot GitHub](https://github.com/Mai-with-u/MaiBot)
- [AstrBot 调研（rywalker）](https://rywalker.com/research/astrbot)
- [OpenClaw + NapCat 搭建教程](https://aqua739085.github.io/2026/07/04/QQ%E6%9C%BA%E5%99%A8%E4%BA%BA%E6%90%AD%E5%BB%BA%E6%95%99%E7%A8%8B-OpenClaw-NapCat/index.html)
- [Lagrange 接入（LangBot 文档）](https://docs.langbot.app/zh/usage/platforms/qq/aiocqhttp/lagrange)
- [NapCat + AstrBot 教程（2026-03）](https://frozenyears.github.io/2026/03/22/QQ-Bot-Construction-Tutorial-with-NapCatQQ-and-AstrBot/index.html)
