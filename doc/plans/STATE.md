# 当前状态摘要（给新对话中的助手读，2026-10-26）

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

## 进度（2026-10-26）
- 当前工作分支：`dev/impressions-v4`；夜间代码 HEAD：`109a6ae16ebdbb424772461bf1655c6e6bbad356`。本轮未 push。
- overnight 步骤 0：MEMO-EVENT-SLICES 定稿与任务书提交 `4285f77`。
- SELF-SETTINGS-AND-ONEOFF：只读核对，计划列出的实现与测试均有对应；本轮未改其代码。
- MOOD-HOLD-DECAY：步骤 1 提交 `b0edfc0`；步骤 2 连续两次完整检查失败后回滚，v36 未使用，按规则跳过步骤 3–4。情绪计划未完整交付。
- MEMO-EVENT-SLICES：步骤 1–5 分别由 `adb7d4d`、`dd47591`、`a6d938f`、`b57fb24`、`109a6ae` 完成；步骤 2 的独立复审发现 >200 事件漏 memo，修复提交 `4fb19ab`。原 `dd47591` 审查 verdict 仍为 fail；修复未获独立 reviewer verdict，见 `MORNING-2026-10-26.md`。
- 实际迁移：v37、v38、v39、v40、v41；v36 未应用。
- 代码 HEAD 全量 `npm run check`：1051/1051 通过；`npm run panel:build`：306 modules，成功。完整历史逐步结果、基线 1032/1032 复跑及审查边界见晨报。
- AnI 手动运行验收尚待完成；未运行 `npm start`，未启动 QQ/SnowLuma。MOOD 步骤 2–4 缺失，Mood 端到端 UI 验收暂不具备条件。
- 收尾时唯一工作区修改仍是用户文件 `data/personas/adachi_sakura.md`；未暂存、未恢复、未提交。晨报及其收尾提交只包含计划文档。
- 详细提交表、手动验收清单和失败记录：`doc/plans/MORNING-2026-10-26.md`。

## Claude 在此仓库的操作约定
- 只读审查：git 命令加 `--no-optional-locks`；验证脚本放 `/tmp`，**不要在仓库里建文件**
- 远程会话默认无删除权限；任何会写 `.git` 的操作（commit 等）前先申请删除权限，否则会残留 `.lock`
- 前端检查：把 `panel/dist` 拷到云端，用 Playwright（`executablePath: '/opt/pw-browsers/chromium'`）加模拟 API 截图
- MaiBot 为 GPL-3.0：只借鉴思路，不复制代码或提示词
