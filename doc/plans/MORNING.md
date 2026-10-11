# 早上检查清单

## 完成情况
- T0 / 完成（夜间代码与单测；真实账号验收待用户） / 修补脚本覆盖 JS、声明文件、目录入口、未命中与幂等；typecheck 通过，SDK 导出数 53 / 提交号将在下一任务记录中回填
- T1 / 完成（夜间代码与单测；边界检查有临时豁免） / logger、依赖边界检查、配置示例与项目脚本完成；依赖按精确版本离线安装；`npm run check` 通过，5 项测试全过 / `checkpoint/night-t1-unverified`

## 需要用户操作的验证
- T0：
  1. 启动 SnowLuma。
  2. 在 SnowLuma WebUI 的进程列表中，手动对 bot 小号 QQ 进程点击“加载”。
  3. 在 Aquarium 仓库运行 `npm run spike:ping`。
  4. 确认终端显示“已连接：…(900000001)”。
  5. 用主号私聊小号发送 `/aq ping`，确认收到 `pong 🐟 水族箱已连接`。

## 待确认问题
- Node 版本文档不一致：HANDOFF 记为 v22.23.2、DESIGN 指定 Node 24 LTS，当前实际为 v26.7.0。考虑过切换/降级 Node，或按现有运行时继续；夜间采用保守方案：不改系统或项目运行时，使用当前 Node v26.7.0，并以实测通过的 `node:sqlite` 和 TypeScript 检查为准。请早上确认项目应固定的 Node 主版本。
- HANDOFF 禁止 `src/adapters/onebot/` 外导入 SDK，但 T0 的 `src/spike/ping.ts` 仍直接导入 SDK，导致 T1 边界检查无法通过。考虑过让 T1 检查失败、提前实现 T2 适配器或临时放行 spike；夜间选最小可回退方案：只豁免当前 `src/spike/ping.ts`，并在 T2 适配器完成后移除此豁免、重新验证。当前边界门并未完全满足 HANDOFF 的 SDK 单一入口约束。
- HANDOFF 的 `node --test test/` 在当前 Windows Node v26.7.0 上被解释为模块路径并报 `Cannot find module ...\\test`。已用实测可行且仍限定 `test/` 范围的显式模式 `node --test test/*.test.ts test/*.test.mjs` 替代；请早上确认是否接受该平台兼容写法。

## 遇到的错误
- T0 基线 `npm run typecheck`：`tsc` 未找到；随后执行离线安装，恢复依赖并通过。
- T0 基线 SDK import：`ERR_MODULE_NOT_FOUND`；新增 postinstall 修补后 import 成功，导出数为 53。
- T0 基线 `npm test`：缺少 `test` script；T1 按 HANDOFF 加入测试脚本。
- T0 基线 `npm test` 自动生成用户级日志 `C:\\Users\\rnfmabj\\AppData\\Local\\npm-cache\\_logs\\2026-10-11T19_01_47_524Z-debug-0.log`；未访问、修改或清理该文件，后续 npm 命令均使用 `--logs-max=0`。
- T1 首次 `npm run check`：`node --test test/` 报 `Cannot find module 'E:\\Teamworks\\Aquarium\\test'`；改为显式测试文件模式后，完整 `npm run check` 通过（typecheck、边界检查、5 项测试）。
- T1 试跑裸 `node --test` 时，Node 自动发现了 `reference/` 下的只读参考项目测试并产生大量失败（包括缺少 Vitest）；已核对 SnowLuma、ai-bot-groupmate、qq-bridge、Tulpa 四个嵌套仓库的 Git 状态均干净，未再运行全仓自动发现。终端工具生成的完整输出缓存路径为 `D:\\Hermes\\cache\\terminal-output\\out-1791746637-57704-b490.log`，未访问或修改该文件。
