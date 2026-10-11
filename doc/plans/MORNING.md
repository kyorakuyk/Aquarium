# 早上检查清单

## 完成情况
- T0 / 完成（夜间代码与单测；真实账号验收待用户） / 修补脚本覆盖 JS、声明文件、目录入口、未命中与幂等；typecheck 通过，SDK 导出数 53 / 提交号将在下一任务记录中回填

## 需要用户操作的验证
- T0：
  1. 启动 SnowLuma。
  2. 在 SnowLuma WebUI 的进程列表中，手动对 bot 小号 QQ 进程点击“加载”。
  3. 在 Aquarium 仓库运行 `npm run spike:ping`。
  4. 确认终端显示“已连接：…(900000001)”。
  5. 用主号私聊小号发送 `/aq ping`，确认收到 `pong 🐟 水族箱已连接`。

## 待确认问题
- Node 版本文档不一致：HANDOFF 记为 v22.23.2、DESIGN 指定 Node 24 LTS，当前实际为 v26.7.0。考虑过切换/降级 Node，或按现有运行时继续；夜间采用保守方案：不改系统或项目运行时，使用当前 Node v26.7.0，并以实测通过的 `node:sqlite` 和 TypeScript 检查为准。请早上确认项目应固定的 Node 主版本。

## 遇到的错误
- T0 基线 `npm run typecheck`：`tsc` 未找到；随后执行离线安装，恢复依赖并通过。
- T0 基线 SDK import：`ERR_MODULE_NOT_FOUND`；新增 postinstall 修补后 import 成功，导出数为 53。
- T0 基线 `npm test`：缺少 `test` script；T1 按 HANDOFF 加入测试脚本。
- 基线 `npm test` 自动写出了用户级 npm cache 日志（仓库外）；后续 npm 命令关闭 npm 日志输出，未再主动访问或修改仓库外文件。
