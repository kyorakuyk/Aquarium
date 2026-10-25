# 今晚任务书（2026-10-26 夜间，Hermes 单独跑）

分支：`dev/impressions-v4`（起点 HEAD `1e95448`）。工作目录：`E:\Teamworks\Aquarium`。按顺序做，一次只做一件事。

## 全局规则

1. **每一步一个提交**，提交前 `npm run check` 必须全绿；碰到面板代码的步骤还要 `npm run panel:build` 通过。提交信息用中文，带计划名和步骤号，例如 `feat(mood): MOOD-HOLD-DECAY 步骤1 Hill 曲线`。
2. **失败规则**：同一步骤连续修两次仍不绿，就 `git restore`/`git stash` 掉这一步的未提交改动，在晨报里写清楚卡在哪（报错原文、怀疑原因），**跳过这份计划剩下的步骤**，进入下一份计划。
3. **迁移号**：当前最新是 `v35`（心声，已占用）。本晚分配：MOOD-HOLD-DECAY 用 **v36**，MEMO-EVENT-SLICES 用 **v37**（需要第二个就 v38）。计划书里写的号码以这里为准；如果开工时发现号码已被占用，就顺延，并在晨报里注明。
4. **禁止**：不运行 `npm start`，不启动 QQ / SnowLuma，不 `git push`，不改 git 历史。
5. **不要提交**：`personas/input/`、`data/` 下的运行时文件。`data/personas/adachi_sakura.md` 有一处面板保存的未提交改动，**保持原样，不要 add、不要 restore**。每次提交用 `git add <具体路径>`，不要 `git add -A`。
6. 计划书里写"待雪确认/待定"的地方，以本任务书和计划书里"雪的决定"小节为准；仍有歧义就选最小、最可回退的做法，并记进晨报。

## 0. 起步（不提交代码）

- `git status` 确认只有 `data/personas/adachi_sakura.md` 一处改动；`npm run check` 跑一次作为基线，结果记进晨报。
- `doc/plans/MEMO-EVENT-SLICES.md` 已替换为定稿版（含"雪的决定"小节和 5 步分步）。单独提交：`docs(plan): MEMO-EVENT-SLICES 定稿与今晚任务书`，同时把本文件一起提交。

## 1. SELF-SETTINGS-AND-ONEOFF：只核对，不施工

四个步骤都已提交（`eb99ffd`、`4214c15`、`f86559f`、`523f3f5`，R1.1–R1.4 随步骤1落地，见 `de21225`）。今晚**不改代码**，只在晨报里写一句：对照 `doc/plans/SELF-SETTINGS-AND-ONEOFF.md`「实施顺序」逐条确认是否都有对应实现和测试；发现缺漏只记录，不补。

## 2. MOOD-HOLD-DECAY（4 步）

计划书：`doc/plans/MOOD-HOLD-DECAY.md`，按其「步骤与提交」1→4。注意：
- 迁移用 **v36**（计划书里写的 v35 已被心声占用）。
- 步骤4 的面板构建命令是 `npm run panel:build`（计划书里写的 `npm run build` 不存在）。

## 3. MEMO-EVENT-SLICES（5 步）

计划书：`doc/plans/MEMO-EVENT-SLICES.md`（定稿版），按「分步」1→5。已定：
- 没开作息时，固定 **04:00** 整理。
- 睡着时没回的消息，醒来**在哪来就在哪回**：群里的在群里回（同群合并一条，@ 相关的人），私聊的在私聊回。
- 原文暂存 **7 天**后删除；面板提供**手动清除缓存**按钮。
- 迁移用 **v37**（计划书里写的 v36 改为 v37，需要更多就顺延）。
- 隐私规则只在 `src/core/privacy/policy.ts` 的 `decide()` 里加；模型调用一律走 `extract` 槽并过 budget 检查。

## 4. 晨报（最后一个提交）

写 `doc/plans/MORNING-2026-10-26.md`，并更新 `doc/plans/STATE.md` 顶部的进度小节，内容：
- 每份计划：完成到哪一步，对应提交 hash + 一句话说明；跳过/失败的写原因和报错摘要。
- 迁移号实际用了哪些。
- 基线与最终的 `npm run check` 结果（测试数、是否全绿）。
- **AnI 手动验收清单**（需要启动 bot 才能看的）：
  - 心情：被戳一下后，心情在面板曲线上先停一阵再回落；人设→参数→心情的「停留感」卡可调、重启后生效。
  - 记忆：聊一段后面板出现"暂存 N 条"，静默后闭合成一条事件 memo（不再逐句）；群段同时出现在事件簿。
  - 日记/整理：未开作息时 04:00 自动整理；手动清除缓存按钮可用。
  - 醒来：睡着期间被 @ 的群消息，醒后在原群补一句；私聊在私聊补。
  - 唤醒词：叫醒后先回最近的事，约 10 分钟后再问起更早的。
- 最后 `git status` 的输出（应只剩 `data/personas/adachi_sakura.md`）。

完成后停下，等 AnI 早上看。
