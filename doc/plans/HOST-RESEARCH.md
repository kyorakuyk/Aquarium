# T11 托管层调研

> 日期：2026-10-14；分支：`dev/host`（从 `main` 的 `2bd281ad68ffc271ec8893c37f9e827e9f3c57b1` 创建）。
> 本文只记录调研与建议，不实现正式代码；没有启动 SnowLuma/QQ、发送 API 请求或执行注入。

## 研究范围与版本

- Aquarium：`dev/host`，基线 `2bd281ad68ffc271ec8893c37f9e827e9f3c57b1`。
- SnowLuma：`reference/SnowLuma` v1.14.22，嵌套仓库 HEAD `87527cb7641a5a42f8f0efb73cb066102e004dee`；研究时嵌套工作树干净。仅将它作为只读参考，没有复制实现代码。
- 外部资料均于 2026-10-14 查看；因资料未给出准确发行大小或腾讯未公布固定路径的地方，明确标为未知，不以猜测补齐。

## 1. SnowLuma WebUI 鉴权与指定 PID load

### 鉴权流程

`server.ts` 对 `/api/*` 安装 Bearer middleware；仅 `/api/login` 与 `/api/ui/public` 免登录。其余 API 要求 `Authorization: Bearer <token>`，token 必须存在于当前服务的会话表且未过期；未带或过期返回 HTTP 401。若用户协议未同意或要求改密码，还可能返回 403（`reference/SnowLuma/packages/core/src/webui/server.ts:625-660`）。

`POST /api/login` 接收 JSON 登录信息，校验密码及可能启用的 TOTP/恢复码，并带有失败尝试限流；成功后生成 32 字节随机十六进制会话 token，返回 `{ success, token, mustChangePassword }`。源码配置的 token 有效期为 24 小时，token 存在进程内 map 中；服务重启后应重新登录（`server.ts:123, 668-714`；`webui-login.ts:21-44`）。不要把登录密码、TOTP 或会话 token 写到命令行参数、日志或本文件。

### `POST /api/processes/:pid/load`

```http
POST /api/processes/<pid>/load HTTP/1.1
Host: 127.0.0.1:<webuiPort>
Authorization: Bearer <session-token>
Content-Length: 0
```

无请求体。路由先将路径参数解析为 PID，并要求其为 `1..4,194,304` 的整数；HookManager 未初始化时为 503；调用 `hookManager.loadProcess(pid)` 后以 `{ success, process }` 返回，若返回状态为 `error`，HTTP 仍可能是 200 但 `success:false`；抛出异常则返回 500（`server.ts:1473-1494`）。这是**实际向指定 PID 注入/重连**的操作，不是只读探测；本次没有调用它。Aquarium 的 T12 必须先完成 PID/账号匹配，再发起此 POST。

`GET /api/status` 也受相同 Bearer middleware 保护；token 有效时返回 `{"status":"running"}`（`server.ts:1025-1032`）。匿名访问得到的 401 只能说明请求到达了受保护 API 路径，不能作为应用健康的充分判据。

## 2. 无窗口启动与 readiness

### 启动入口与工作目录

当前 SnowLuma 源码仓库根目录的 `start` 脚本是 `node dist/index.mjs`；`dev:mode` 则先切到 `dist` 再运行 `node index.mjs`（`reference/SnowLuma/package.json:8-31`）。发行布局检查以 `dist` 为默认 release root 并要求其中有 `index.mjs`（`tools/check-release-layout.mjs:4-11`）。因此 `node index.mjs` 只适用于经确认的发行目录本身就是 `index.mjs` 所在目录的情况；源码仓库根目录不能照抄该命令。部署归档的实际根目录仍应对目标发行包核验。

建议未来宿主启动**已选定的发行目录**中的 `index.mjs`，并把 `cwd` 显式设为该文件所在目录；若运行源码 checkout，则执行 `node dist/index.mjs` 且 `cwd` 为仓库根。Node 的 `spawn` 支持显式 `cwd`；`windowsHide:true` 只隐藏 Windows 上通常会创建的子进程控制台窗口；spawn 成功后 `child.pid` 是被启动子进程的 PID，启动失败则可能没有 PID。它不证明该 PID 一定是 QQ 的最终主进程，也不证明服务已就绪。citeturn7search0

WebUI 只有在发行构建包含 WebUI（core 的 `build:all` 设置 `BUILD_WEBUI=true`，Vite 将其映射为 `__BUILD_WEBUI__`）或设置 `SNOWLUMA_DEV_WEBUI=1` 时才会启动。WebUI 启动失败会被记录，但 SnowLuma 主程序继续运行，所以只看子进程存在不够（`reference/SnowLuma/packages/core/package.json:35-39`；`packages/core/src/index.ts:86-103`；`packages/core/vite.config.ts:182-185`）。

### 就绪信号

- 默认监听地址 `127.0.0.1:5099`；可由 `config/runtime.json` 改写（`packages/common/src/runtime.ts:27-31, 40-49`）。
- WebUI 选出实际可用端口并完成 `serve` 监听后，记录 `listening http(s)://<host>:<port>`；端口冲突时会换到另一个可用端口并记录告警（`packages/core/src/webui/server.ts:1799-1819`）。因此若宿主要用端口探测，应读取实际端口，而不是永远假定 5099。
- 建议 T12 将就绪拆成两级：①监视 `spawn`/`error`/`exit`；②以受控超时等待实际 WebUI listener（监听日志或经认证的 `GET /api/status`）。有合法会话 token 时 `/api/status` 返回 `status: running`；没有 token 时不要把 401 误报为业务健康，也不要用重复错误登录来探活。

## 3. QQ.exe 路径、PID 与小号/主号识别

### 安装路径

本次未找到腾讯官方承诺的、对所有 Windows 安装都适用的固定 `QQ.exe` 默认路径；不能把某个常见目录写死为可靠默认值。Windows Installer 可以将 `ARPINSTALLLOCATION` 用作应用主目录并写入卸载注册信息，但是否存在该值取决于安装包，不保证 QQ 安装一定提供。实际产品应优先读取 QQ 开始菜单快捷方式目标/可用的卸载注册信息并检查目标文件；找不到或多条候选时，让用户选择 `QQ.exe`，将选择作为本地配置保存。citeturn8search3

SnowLuma 当前进程枚举器只把 PID 映射成配置的显示名和空路径（`path: ''`），所以 `/api/processes` 不能作为安装路径发现机制（`packages/bridge/src/process-enumerator.ts:89-93`）。

### PID 与账号确认

- 以已验证的 `QQ.exe` 完整路径直接 `spawn`，设置 `cwd` 为其目录并取 `ChildProcess.pid`；不经 shell、不按进程列表顺序猜测。Node 文档说明的 PID 是**被 spawn 的子进程** PID；如果 QQ 启动器将请求交给已有 QQ 实例或再派生客户端，返回的 PID 可能不是最终承载账号的进程，必须验证后才能注入。citeturn7search0
- SnowLuma 有 `GET /api/processes/:pid/probe-login`：它按 PID 查询本地监听端口，再尝试 QQ Ptlogin 的本地 `pt_get_uins` 端点；只在返回单一账号时给出 UIN 和 `identityKnown:true`。无端口时可能只返回 `identityKnown:false`；多进程/网络异常/超时可能返回 `null`。该 route 直接调用 `probeQqLoginInfo(pid)`，不执行 `injector.inject`，所以可在 load 前探测已登录进程。实现依赖 QQ 当前本地端口和响应行为，不是腾讯承诺的稳定接口（`server.ts:1496-1508`；`packages/bridge/src/hook-manager.ts:222-225`；`packages/bridge/src/qq-port-probe.ts:14-29, 110-125, 129-209, 212-228`）。
- 安全建议：T12 先确认没有正在运行、可能被 QQ 单实例机制复用的其他 `QQ.exe`；然后从用户选择的完整路径启动 QQ 并持有 `child.pid`，让用户完成登录/扫码，再只对该 PID 有界轮询 `probe-login`。只有 `identityKnown:true` 且 UIN 与用户明确选择的小号一致时才调用 load；未知、超时、PID/路径不一致或账号不匹配时中止，不注入、不回退到“找第一个 `QQ.exe`”。注入并建立 OneBot 会话后再校验一次登录 UIN，验证通过前不得启用 Aquarium。若 QQ 启动器复用既有实例、改派到不同 PID，或探测接口变化，就必须停止并要求用户处理；不能把 spawn 返回的 PID 自动视为账号身份。
- `hookAutoLoad` 默认 false，但可由配置/`SNOWLUMA_HOOK_AUTOLOAD` 覆盖；开启时每个发现的 QQ PID 都可能自动注入。手动 `loadProcess(pid)` 本身不经过 auto-load 筛选。T12 应显式保持 auto-load 关闭，仅在匹配通过后请求一个 PID（`packages/common/src/runtime.ts:6-9, 47-49`；`packages/core/src/index.ts:63-76`；`packages/bridge/src/hook-manager.ts:195-205, 255-260, 509-512`）。

## 4. Windows 托盘候选方案

| 候选 | 依赖与集成 | 体积 / 原生边界 | 判断 |
|---|---|---|---|
| `@trayjs/trayjs`（npm 0.0.10） | Node API；平台对应的可执行托盘二进制通过 npm optional dependencies 安装，Node 与 helper 通过 stdin/stdout JSON-lines 通信；npm 页面显示 0 个普通依赖。 | 需要随发布包带 Windows x64/arm64 的原生 helper；页面未提供可核验的安装体积，不能报精确大小。页面显示 78 次周下载、1 个 dependent、版本发布约 7 个月，成熟度/维护活跃度风险偏高。 | 与 Aquarium 的 Node 宿主最贴近、没有 Electron 框架，但必须做 Windows 打包、退出清理、AV 误报和断管测试；先作为 T12 spike 候选，不直接认定为生产依赖。citeturn5search0turn7search2 |
| WinForms `NotifyIcon` 独立 helper | C#/.NET Windows Forms 提供图标、tooltip、菜单与事件；Aquarium 需通过本地 IPC/stdin 管理另一个进程。无需 Node 原生 addon。 | framework-dependent 需要目标机器具备相应 .NET Desktop Runtime；self-contained 单文件会把 runtime/framework libraries 一并带上，Microsoft 明确说明体积会较大，但没有本项目可用的确切数字。 | Windows 原生 UI 语义清楚，但增加另一种运行时、构建产物和 IPC 生命周期；若用户机器已具备兼容 Runtime，才可能有吸引力。citeturn8search4turn8search6turn8search8 |
| Electron `Tray` | Electron 主进程直接提供托盘图标、右键菜单、点击事件；不要求额外编写 Node 原生 addon。 | Electron 安装文档要求获取并分发对应平台的预编译 runtime；没有为所有版本/打包方式通用的最终大小。本项目未测量，选定版本后需实测。 | API 成熟、UI 直接，但 Aquarium 只需要托盘而无桌面窗口，单为托盘再打包一套桌面运行时会带来额外体积与升级面；具体大小属待测项。citeturn7search1turn9search0 |

低层替代是由单独 native helper 调用 Win32 `Shell_NotifyIcon`；这避免 Electron 和 .NET runtime，但需要自己维护窗口消息循环、GUID、菜单与通知回调，且有 native 编译/分发边界。citeturn7search3

**建议供用户确认：**T12 先对 `@trayjs/trayjs` 做一次可丢弃 spike，重点验证退出时 helper 不残留、Windows x64 包能运行、菜单和状态图标可更新、二进制大小与签名/杀软行为；若不满足，再比较 .NET helper。仅为托盘不引入 Electron。当前 npm 体积没有可核验数据，因此“更轻”是架构推断，不是已测结论。

## 5. 开机自启比较与推荐

| 方式 | 优点 | 边界/成本 |
|---|---|---|
| 当前用户 Startup 文件夹快捷方式（`shell:startup`） | Microsoft 文档定义为当前用户登录后启动；路径在用户 profile；通过删快捷方式即可关闭。无需管理员，天然处于可显示托盘的用户交互会话。 | 不是登录前启动；崩溃重启需宿主自身负责；移动/删除安装目录后快捷方式失效。 |
| Task Scheduler 登录触发 | 可指定用户、登录触发和延迟；适合需要策略、触发条件或任务级重试的场景。 | 配置面更复杂。若要显示托盘/桌面通知，必须选择交互式登录 token，让任务运行在用户已登录的现有会话；使用非交互式任务不能作为可见托盘宿主。不要为规避配置而以 SYSTEM 身份运行 GUI。 |

**MVP 推荐：当前用户 Startup 快捷方式。**T12 需要用户已登录、能查看托盘和处理 QQ 登录/扫码；Startup 文件夹是最简单、可发现且可撤销的方式。若将来确实需要登录前启动或更细的失败恢复，再由用户决定是否引入 Task Scheduler。Microsoft 文档说明 Startup 快捷方式在用户登录时运行、可从该文件夹删除；Task Scheduler 的交互式 token 要求用户已登录且只在现有交互会话运行。不得把密码、TOTP、token 放入快捷方式目标或任务参数。citeturn8search0turn8search1turn8search2

## T12 前必须由用户确认的选择

1. 确认宿主运行的 SnowLuma 发布目录与构建是否包含 WebUI；源码仓库根的 `node index.mjs` 不是当前有效命令。
2. 确认 WebUI 登录凭据/TOTP 如何由本机宿主安全取得与更新；本调研没有提出把密码写入命令行或日志的做法。
3. 确认 QQ 可执行文件如何由用户选择、是否要求启动前无其他 `QQ.exe`、预期小号 UIN 如何保存/核验；将 `probe-login` 的 pre-load 等待步骤加入 T12 流程。无法确认 PID 与 UIN 时必须拒绝注入。
4. 确认是否先 spike `@trayjs/trayjs`，及其失败后的 .NET helper 备选；当前没有精确包体积或真实 Windows GUI 验收。
5. 确认 MVP 使用当前用户 Startup 文件夹，而非 Task Scheduler。

## 未验证项与风险

- 没有在真实 SnowLuma 发行包上运行启动命令；入口判断仅依据 v1.14.22 仓库源码与发行布局检查脚本。
- 没有启动 QQ 或调用 `probe-login`；账号探测是 SnowLuma 当前实现的经验机制，不能替代 fail-closed 校验。
- 未测托盘候选的真实安装体积、Windows SmartScreen/杀软行为、开机启动和崩溃恢复。
- 本文不授权开始 T12；到 PLAN 停止点 3 停下，等用户确认上述选择。

## 来源

### Aquarium / SnowLuma 源码（只读）

- `reference/SnowLuma/package.json:8-31`、`packages/core/package.json:1-42`：版本、start 与开发脚本。
- `tools/check-release-layout.mjs:4-11`、`packages/core/vite.config.ts:143-185`、`packages/core/src/index.ts:43-103`：发行入口、WebUI 构建标志、启动开关与失败行为。
- `packages/common/src/runtime.ts:4-15,27-49`、`packages/core/src/webui/server.ts:625-714,1025-1032,1473-1508,1799-1819`：运行时默认值、鉴权、状态与进程 API。
- `packages/bridge/src/process-enumerator.ts:89-93`、`hook-manager.ts:176-225,255-260,509-512`、`qq-port-probe.ts:110-125,129-209,212-228`：进程字段、注入与 UIN 探测行为。

### 官方外部文档（访问日期：2026-10-14）

- Node.js v22.18.0 `child_process` API：`cwd`、`windowsHide`、`ChildProcess.pid` 与 spawn 错误语义。citeturn7search0
- Microsoft Windows Installer `ARPINSTALLLOCATION` 与卸载注册表映射：只说明安装器可提供安装路径，不能证明 QQ 一定设置。citeturn8search3
- Electron `Tray` API 与安装/发行说明；官方资料不提供本项目的统一打包大小。citeturn7search1turn9search0
- `@trayjs/trayjs` 上游仓库与 npm 包页面：平台二进制、JSON-lines 通信、依赖和页面所示的包活跃度指标。citeturn5search0turn7search2
- Microsoft WinForms `NotifyIcon` 与 .NET 单文件部署说明。citeturn8search4turn8search6turn8search8
- Microsoft Windows 通知区 `Shell_NotifyIcon`、Startup 文件夹和 Task Scheduler 登录触发/交互式 token 文档。citeturn7search3turn8search0turn8search1turn8search2

## T12a 结果（2026-10-14；离线检查，未运行托盘程序）

- 固定安装 `@trayjs/trayjs@0.0.10`。Windows x64 实际安装 `node_modules/@trayjs/trayjs`（18,713 bytes）与 `node_modules/@trayjs/win32-x64`（174,478 bytes）；`du -sb node_modules/@trayjs` 实测总占用 **193,191 bytes**。当前 x64 环境没有安装 arm64 optional binary。
- 包 README 描述 Node wrapper 通过 stdin/stdout JSON-lines 启动独立 Windows 原生 `tray.exe`；没有声明另需 .NET/Electron runtime，但也没有执行二进制验证其系统运行库依赖。
- README/API 提供 icon、菜单、tooltip、quit 与 ready/close；**没有文档化的 Windows 系统通知/气泡提示 API**。因此 T12b 的扫码通知只能先更新托盘提示文字；不能把本 spike 当作系统通知支持的证明。
- 图标为 `assets/tray/{teal,yellow,red}.ico`，每个包含 16×16 与 32×32 图像。`node --test test/tray-assets.test.ts test/tray-spike.test.ts` 通过 5 项；`npm run typecheck` 与完整 `npm run check` 通过，完整检查 142 项测试全绿。
- `src/spike/tray.ts` 只有直接执行该文件时才动态导入 `Tray` 并启动 helper；单元测试注入 fake tray，**本次未运行 `node src/spike/tray.ts`、未创建真实托盘进程、未做用户 GUI 验收**。
