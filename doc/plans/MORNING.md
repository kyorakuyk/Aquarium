# 早上检查清单

## 完成情况
- T0 / 完成（夜间代码与单测；真实账号验收待用户） / 修补脚本覆盖 JS、声明文件、目录入口、未命中与幂等；typecheck 通过，SDK 导出数 53 / `1c420e86ad56e92473b51d2674824b7817698794`
- T1 / 完成（夜间代码与单测；边界检查有临时豁免） / logger、依赖边界检查、配置示例与项目脚本完成；依赖按精确版本离线安装；`npm run check` 通过，5 项测试全过 / `89bdf01ce748ee2ab9d98477dda50938827f1bc7`
- T2 / 完成（夜间代码与单测；真实 SnowLuma/QQ 验收待用户） / 事件模型、双向段转换、账号校验和 OneBot 适配器完成；`npm run check` 通过，20 项测试全过；新增 `doc/BUILD-GUIDE.md` / `d645b5ac0cebd16c2c13bb9a1597c87a60d3d015`
- T3 / 完成 / 配置 schema、YAML load、deepMerge/resolve、fs.watch 防抖与原子写完成；`npm run check` 通过，30 项测试全过；初学者施工指南已加入 T3 / `ae0643b16520001441d0229ac085b2b18c3dbb4c`
- T4 / 完成 / `node:sqlite` WAL/迁移及 repository CRUD、自然日成本汇总完成；`npm run check` 通过，36 项测试全过；Node 内置 SQLite 实测可用 / `fa70efa6c2354a477df9a4e82eb4173d49189f53`
- T5 / 完成（真实模型调用待用户） / OpenAI-compatible provider 缓存、降级/用量记录与预算门槛完成；`npm run check` 通过，47 项测试全过；未访问外网 / `52372d632ce0e51bd5abf19f3a7cd9932344ecd6`
- T6 / 完成（真实 QQ/模型端到端验收待用户） / 被叫必回 pipeline、人设、触发、限流、上下文、清洗、拆条、节奏、消息/决策落库与 main 装配完成；`npm run check` 通过，70 项测试全过 / `checkpoint/night-t6-unverified`

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
- T5：
  1. 确认 `.env` 中已设置 `DEEPSEEK_API_KEY`（只在本机填写，不要发到聊天或提交）。
  2. 在仓库根目录运行 `npm run spike:llm-ping`；此操作会向模型服务发送真实请求，并可能产生少量 API 费用。
  3. 确认终端输出模型名、中文回复、输入/缓存/输出 token 与估算费用；失败时只分享已脱敏的错误信息。
- T6：
  1. 确认 `.env` 有 `DEEPSEEK_API_KEY`；在 `data/config.yaml` 填好自己的 `owner`，只启用一个测试私聊或小群（其他会话保持禁用）。群聊测试时设置一个 `nicknames`，或使用真实 @。
  2. 启动 SnowLuma，并在 WebUI 对小号 QQ 进程手动点击“加载”。
  3. 在仓库运行 `npm start`。此操作会连接真实 QQ；被叫后还会发真实模型请求并可能产生 API 费用。
  4. 在启用的私聊发送一句话，或在启用小群 @ 小号；确认回复符合人设，并且群聊引用了原消息。再在一个未启用的群 @ 小号，确认不回复。
  5. 按 Ctrl+C，确认日志显示 Aquarium 已关闭。

## 待确认问题
- Node 版本文档不一致：HANDOFF 记为 v22.23.2、DESIGN 指定 Node 24 LTS，当前实际为 v26.7.0。考虑过切换/降级 Node，或按现有运行时继续；夜间采用保守方案：不改系统或项目运行时，使用当前 Node v26.7.0，并以实测通过的 `node:sqlite` 和 TypeScript 检查为准。请早上确认项目应固定的 Node 主版本。
- HANDOFF 禁止 `src/adapters/onebot/` 外导入 SDK，但 T0 的 `src/spike/ping.ts` 仍直接导入 SDK。T2 已新增使用 `OneBotAdapter` 的 `src/spike/adapter-ping.ts`，但 T0 原验证脚本仍需供用户验证。考虑过现在重写/删除 T0 脚本，或保留精确单文件豁免；夜间选择保留原验证入口，只豁免 `src/spike/ping.ts`，待用户完成 T0 验收后再决定将其迁移到适配器并收回豁免。当前边界检查仍有这个已知例外。
- HANDOFF 的 `node --test test/` 在当前 Windows Node v26.7.0 上被解释为模块路径并报 `Cannot find module ...\\test`。已用实测可行且仍限定 `test/` 范围的显式模式 `node --test test/*.test.ts test/*.test.mjs` 替代；请早上确认是否接受该平台兼容写法。
- HANDOFF 的 `markRead(session)` 没有 message ID，但 SnowLuma 的群/私聊已读动作必须带 message ID。考虑过全局标记已读、扩展 Aquarium 接口或查询当前会话最新消息后单独标记；夜间拒绝会影响其他会话的全局动作，采用最后一种最小方案：只查当前会话最新一条，有消息才标记该消息；无消息时不操作。
- T5 定价配置缺少模型条目时如何估算：考虑过记作 ¥0（会低估预算）或拒绝请求；夜间选择 fail-closed，在发请求前报出缺少价格配置，不把未知成本伪装成零。请在加入新模型时同步填写 `pricing`。
- T6 热重载时修改账号列表或 SnowLuma 路径：考虑过运行中动态重建连接，或要求重启；夜间选择不做账号连接热切换，配置 watcher 只让后续消息使用新的人设/会话/模型配置，并明确警告账号连接变化需要重启。

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
- T5 最终 `npm --logs-max=0 run check`：TypeScript、依赖边界检查通过；47 项测试通过、0 失败。模型单测只使用假客户端；按 NIGHT-RUN 规则未执行 `src/spike/llm-ping.ts`，真实 API 验收留给用户。
- T6 首次最终检查报 `src/app/main.ts(91,5): TS2322`：pipeline Promise 返回 `PipelineResult`，但关机跟踪集合要求 `Promise<void>`；用 `.then(() => undefined)` 归一返回类型后，最终 `npm --logs-max=0 run check` 通过，70 项测试通过、0 失败。真实 QQ 和模型调用均未执行。
