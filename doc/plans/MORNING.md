# 早上检查清单

## 完成情况
- T0 / 完成（夜间代码与单测；真实账号验收待用户） / 修补脚本覆盖 JS、声明文件、目录入口、未命中与幂等；typecheck 通过，SDK 导出数 53 / 提交号将在下一任务记录中回填
- T1 / 完成（夜间代码与单测；边界检查有临时豁免） / logger、依赖边界检查、配置示例与项目脚本完成；依赖按精确版本离线安装；`npm run check` 通过，5 项测试全过 / `checkpoint/night-t1-unverified`
- T2 / 完成（夜间代码与单测；真实 SnowLuma/QQ 验收待用户） / 事件模型、双向段转换、账号校验和 OneBot 适配器完成；`npm run check` 通过，20 项测试全过；新增 `doc/BUILD-GUIDE.md` / `checkpoint/night-t2-unverified`
- T3 / 完成 / 配置 schema、YAML load、deepMerge/resolve、fs.watch 防抖与原子写完成；`npm run check` 通过，30 项测试全过；初学者施工指南已加入 T3 / `checkpoint/night-t3-unverified`
- T4 / 完成 / `node:sqlite` WAL/迁移及 repository CRUD、自然日成本汇总完成；`npm run check` 通过，36 项测试全过；Node 内置 SQLite 实测可用 / `checkpoint/night-t4-unverified`

## 需要用户操作的验证
- T0：
  1. 启动 SnowLuma。
  2. 在 SnowLuma WebUI 的进程列表中，手动对 bot 小号 QQ 进程点击“加载”。
  3. 在 Aquarium 仓库运行 `npm run spike:ping`。
  4. 确认终端显示“已连接：…(900000001)”。
  5. 用主号私聊小号发送 `/aq ping`，确认收到 `pong 🐟 水族箱已连接`。
- T2：
  1. 启动 SnowLuma。
  2. 在 SnowLuma WebUI 的进程列表中，手动对 bot 小号 QQ 进程点击“加载”。
  3. 在 Aquarium 仓库运行 `npm run spike:adapter-ping`。
  4. 确认终端显示已连接账号 `900000001`。
  5. 用主号私聊小号发送 `/aq ping`，确认收到 `pong 🐟 水族箱已连接`；按 Ctrl+C 退出。

## 待确认问题
- Node 版本文档不一致：HANDOFF 记为 v22.23.2、DESIGN 指定 Node 24 LTS，当前实际为 v26.7.0。考虑过切换/降级 Node，或按现有运行时继续；夜间采用保守方案：不改系统或项目运行时，使用当前 Node v26.7.0，并以实测通过的 `node:sqlite` 和 TypeScript 检查为准。请早上确认项目应固定的 Node 主版本。
- HANDOFF 禁止 `src/adapters/onebot/` 外导入 SDK，但 T0 的 `src/spike/ping.ts` 仍直接导入 SDK。T2 已新增使用 `OneBotAdapter` 的 `src/spike/adapter-ping.ts`，但 T0 原验证脚本仍需供用户验证。考虑过现在重写/删除 T0 脚本，或保留精确单文件豁免；夜间选择保留原验证入口，只豁免 `src/spike/ping.ts`，待用户完成 T0 验收后再决定将其迁移到适配器并收回豁免。当前边界检查仍有这个已知例外。
- HANDOFF 的 `node --test test/` 在当前 Windows Node v26.7.0 上被解释为模块路径并报 `Cannot find module ...\\test`。已用实测可行且仍限定 `test/` 范围的显式模式 `node --test test/*.test.ts test/*.test.mjs` 替代；请早上确认是否接受该平台兼容写法。
- HANDOFF 的 `markRead(session)` 没有 message ID，但 SnowLuma 的群/私聊已读动作必须带 message ID。考虑过全局标记已读、扩展 Aquarium 接口或查询当前会话最新消息后单独标记；夜间拒绝会影响其他会话的全局动作，采用最后一种最小方案：只查当前会话最新一条，有消息才标记该消息；无消息时不操作。

## 遇到的错误
- T0 基线 `npm run typecheck`：`tsc` 未找到；随后执行离线安装，恢复依赖并通过。
- T0 基线 SDK import：`ERR_MODULE_NOT_FOUND`；新增 postinstall 修补后 import 成功，导出数为 53。
- T0 基线 `npm test`：缺少 `test` script；T1 按 HANDOFF 加入测试脚本。
- T0 基线 `npm test` 自动生成用户级日志 `C:\\Users\\rnfmabj\\AppData\\Local\\npm-cache\\_logs\\2026-10-11T19_01_47_524Z-debug-0.log`；未访问、修改或清理该文件，后续 npm 命令均使用 `--logs-max=0`。
- T1 首次 `npm run check`：`node --test test/` 报 `Cannot find module 'E:\\Teamworks\\Aquarium\\test'`；改为显式测试文件模式后，完整 `npm run check` 通过（typecheck、边界检查、5 项测试）。
- T1 试跑裸 `node --test` 时，Node 自动发现了 `reference/` 下的只读参考项目测试并产生大量失败（包括缺少 Vitest）；已核对 SnowLuma、ai-bot-groupmate、qq-bridge、Tulpa 四个嵌套仓库的 Git 状态均干净，未再运行全仓自动发现。终端工具生成的完整输出缓存路径为 `D:\\Hermes\\cache\\terminal-output\\out-1791746637-57704-b490.log`，未访问或修改该文件。
- T2 `npm run check`：typecheck 与依赖边界检查通过；Vitest-independent Node test runner 共 20 项通过、0 失败。真实 SnowLuma/QQ 未连接；只在 T0/T2 的 `MORNING.md` 步骤由用户手动验证。
- T3 首次 `npm run check`：TypeScript 报 `src/config/resolve.ts(28,21): TS7053`，因为合并基对象被推断成 `{}`；为 record 显式标注 `Record<string, unknown>` 后通过。最终 `npm run check`：typecheck、依赖边界检查通过，30 项测试通过、0 失败。
- T4 首次数据库测试在 after hook 删除目录时收到 Windows `EPERM`，原因是测试清理顺序没有先关闭 `DatabaseSync`。改为在 `finally` 中先关闭所有连接再删除仓库内临时 fixture；分别重跑 `node --test test/store.test.ts` 与 `node --test test/repository.test.ts` 均通过，临时目录已清空。
