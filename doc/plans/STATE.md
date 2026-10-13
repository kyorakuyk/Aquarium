# 当前状态摘要（给新对话中的 Claude 读，2026-10-13）

## 项目
Aquarium（水族箱）：运行在用户 Windows 电脑上的 QQ AI 群友 bot。TS + Node（用户机器 v26.7.0），协议层为 SnowLuma（OneBot v11，`E:\bot\SnowLuma-v1.14.22-win-x64-lite`），bot 小号 900000001，模型主用 DeepSeek。仓库 `E:\Teamworks\Aquarium`，私有、无远程。

## 文档分工（都在 doc/plans/）
- `PLAN.md`：**唯一任务清单**（含阶段、停止点、夜间规则 §7、控制台视觉规范 §4）
- `HANDOFF.md`：架构、接口、环境参考；`DESIGN.md`（v0.5）：设计依据
- `RESEARCH-*.md`：生态与 MaiBot 调研；`MORNING-*.md`：夜间运行记录
- `REVIEW-2026-10-12.md`、`NIGHT-RUN.md`：已作废

## 分工
- 编码：用户的 Hermes Agent（便宜模型），按 PLAN.md 施工
- Claude：设计、写无歧义规格、审查、调研。用户在意额度：**回复要简短，审查只读必要的文件**

## 进度
- M1 阶段 A、B（R1–R9）完成并合并到 main；U1 真实验证通过
- 阶段 C（C0、T7–T10）完成，在分支 `night/2026-10-13`；R10 已提交
- **进行中**：R11 已暂存未提交；Hermes 在暂存版之后写了规格外的 SSRF 防护（未暂存），已让用户指示 Hermes 丢弃未暂存改动、提交 R11、再做 R12
- 下一步：R12 → ⛔停止点 2 → 用户做 PLAN 中「U2 真实环境验证」→ Claude 审查 → 合并 main → 阶段 D（T11 托管调研）
- 待议：U2 时查看真实图片 URL 的域名，若都是腾讯域名，用域名白名单替代 SSRF 方案

## Claude 在此仓库的操作约定
- 只读审查：git 命令加 `--no-optional-locks`；验证脚本放 `/tmp`，**不要在仓库里建文件**
- 远程会话默认无删除权限；任何会写 `.git` 的操作（commit 等）前先申请删除权限，否则会残留 `.lock`
- 前端检查：把 `panel/dist` 拷到云端，用 Playwright（`executablePath: '/opt/pw-browsers/chromium'`）加模拟 API 截图
- MaiBot 为 GPL-3.0：只借鉴思路，不复制代码或提示词
