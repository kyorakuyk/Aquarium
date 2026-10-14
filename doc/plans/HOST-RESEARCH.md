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

## 阶段 D 补充：T12b 与空托盘实现的离线结果（2026-10-14）

> 本节补充 T11 研究经用户确认后形成的阶段 D 实现证据与剩余边界；不改变前文对 SnowLuma/QQ 真实环境未启动、未调用 API、未注入的记录。以下结论来自代码检查和 fake/offline 自动化测试，不等同于 Windows 用户环境验收。

### T12b 实施对原研究结论的落实

- Aquarium 托管子进程启动前读取 `runtime.json`；若 `hookAutoLoad=true` 则 fail-closed。由于 SnowLuma 进程环境变量可覆盖该文件，受控 spawn 会移除继承的 auto-load、WebUI listener/TLS/password overrides，再显式固定 `SNOWLUMA_HOOK_AUTOLOAD=false` 与已校验的 loopback host/port/TLS；Aquarium 的 `SNOWLUMA_WEBUI_PASSWORD` 不传给子进程。
- `startSnowLuma=false` 是对外部手动进程的 unmanaged attach。宿主会拒绝 Aquarium 当前环境中可见的 auto-load 或非 loopback override 并记录警告，但不能读取另一个已运行进程的有效环境；使用该模式仍须由用户确认实际服务关闭 auto-load 且只绑定 loopback。
- WebUI 认证只使用 loopback URL，禁止 redirect，密码和 Bearer token 不写入日志；401 只重登一次，最终认证失败会停止 watcher。JSON body 解析也在请求 timeout 内，未消费的错误响应 body 会取消。
- QQ 注入保持 fail-closed：只有 `probe-login` 返回 `identityKnown=true` 且 UIN 精确匹配配置账号时才调用 load。身份未知、非匹配、PID 消失或探测失败均不放宽为自动注入。
- Node env-proxy 不应把 loopback 登录密码或 Bearer token 转交给代理。客户端在每次认证请求前检查环境、启动参数、Node 配置旗标及当前 `node:http`/`node:https` global agent；包括客户端创建后由 `setGlobalProxyFromEnv()` 动态切换的情形。回归使用替身 fetch 验证请求被拒绝，未发出网络请求。
- SIGINT/SIGTERM 与异步 host startup 的竞态已加门禁：host 在 `start()` 前交给 shutdown 管理；收到 shutdown 后停止 host、避免启动 watcher，且 adapter/panel 启动路径在关闭后不再继续。该边界由延迟 fake startup 覆盖。
- 开机自启 VBS 使用 Aquarium 所有权标记；临时目录测试验证不覆盖或删除未归 Aquarium 所有的同名文件。**没有运行真实 Startup install/uninstall。**

### 空托盘接口范围

- `src/host/tray.ts` 定义 HostStatus、tooltip、菜单 action、notify 与 dispose 接口；当前由 `createLogOnlyTray()` 提供空实现，所有方法只记录日志。`bindHostTray()` 把宿主状态映射为 tooltip，并在进入 `waiting_qq_login` 时记录一次通知；菜单 callback 仅登记，不执行打开 QQ、控制台、闭嘴、重启或退出动作。
- 本实现不导入 `@trayjs/trayjs`，不创建 helper，不显示系统通知，也没有真实托盘 UI；真实库接入和 T12a spike 用户 GUI 验收仍待白天进行。

### 离线验证、审查与残余

- 最终 `npm run check` 通过：TypeScript、依赖边界检查及 **189 项测试**均通过；`git diff --check` 与 staged production additions 静态扫描通过。T12b 精确代码快照提交 `d5378fe370799c61269d70ec85d056ec410f3ef4`，独立 review fingerprint `91b51c187fc793be3b7d54bb3640c25f163b4776bb7af19d0c9d11a29853b9c7`；空托盘快照提交 `afbdaa152dc3ef4ce601dcf9f111bb4797951386`，独立 review fingerprint `85d1fb8211092322b11e90e6589639ad5021c0ae5aebaff075ea48ef30d88103`。
- Review 留下两条非阻塞建议：并发重复 `Host.stop()` 时后续调用可能早于首次清理完成返回；watcher 停止后在途的最终 401 仍可能让 host 状态转为 `error`。当前不因此重启扫描或进程；这两项未纳入本轮夜间修复。
- 未运行 `npm start`、真实 SnowLuma/QQ、tray spike/helper、GUI 或 `autostart:install`；未验证 WebUI TOTP、自签名 TLS 信任和真实 Windows helper/杀软/退出兼容。相应验收留在 `MORNING-2026-10-14.md`。

## 阶段 D §7.1 范围与证据对照（2026-10-15）

> 本表把计划范围、代码切片和验收边界对齐；测试数字对应各自历史提交，不能相加为一次测试运行。

| §7.1 内容 | 代码与记录 | 已有证据 | 不能据此推断 |
|---|---|---|---|
| T12a 离线核对与 spike | `src/spike/tray.ts`、`assets/tray/`；本文件“T12a 结果” | 安装占用实测 193,191 bytes；完整 `npm run check` 142 项；用户后来确认独立 spike 的图标、菜单禁用、颜色循环和退出清理 | 不证明 Aquarium 主程序已接入托盘；阶段 D 夜间没有启动 tray spike/helper |
| T12b 非托盘 host | `src/host/windows/`、`src/app/main.ts`、`scripts/autostart.mjs`；本文件“阶段 D 补充”与“probe 请求超时边界” | T12b 实现质量门 187 项；probe-timeout follow-up 190 项；用户后续报告测试账号可对话，后续日志记录 host/adapter online | 不证明已安装 autostart，也不覆盖 TOTP、自签名 TLS 和所有真实 Windows 进程情形 |
| 空托盘接口 | `src/host/tray.ts` 与 `createLogOnlyTray()`；本文件“空托盘接口范围” | `npm run check` 189 项；独立 review fingerprint `85d1fb8211092322b11e90e6589639ad5021c0ae5aebaff075ea48ef30d88103`；提交 `afbdaa152dc3ef4ce601dcf9f111bb4797951386` | 只证明接口、log-only wiring 和 fake 行为；不加载 trayjs、不创建真实托盘或系统通知 |

后续 T12c 才把 trayjs helper 接入 Worker；代码提交 `f5f2dcffa699de3a2a34bef0376054e5a1ab28df` 与面板启动 follow-up `1f0f2b7668e5ffbaee08824de10b7527aa78bbfa` 均有独立记录，但真实 Aquarium 托盘验收仍按 `MORNING-2026-10-14.md` 留给用户。阶段 D 的“空实现”与后来的“真实托盘代码”是不同验收层级，不要用后者的 fake 测试代替用户 GUI 验收。

## T12b 用户验收后续：probe 请求超时边界（2026-10-14）

> 以下仅记录用户手动运行后提供的脱敏日志现象与仓库内复现；不保存账号 UIN、PID、路径或凭据。用户报告按 Ctrl+C 后 Aquarium 正常退出。

- 现场表现：WebUI 登录首次请求记录 network error，紧接着重试得到 HTTP 200；后续 `/api/processes` 多次 HTTP 200，但 `/api/processes/<pid>/probe-login` 持续 network error，host 保持 `waiting_qq_login`。这证明登录/列表路径已通，但不证明该 PID 已成功识别或注入；此时不得把 T12b 真实验收判为通过。
- Aquarium 代码的 `createSnowLumaProcess()` 默认 WebUI 请求预算原为 1,000ms，并传给 login、process list、probe 与 load；只读参考 SnowLuma 的 `probeQqLoginInfo()` 自身最长等待 5,000ms。WebUI client 将 fetch-level 拒绝统一记成 network error，现场日志未保留底层异常，因此超时不匹配是高概率解释，不是对当次 OS/network 异常的唯一证明。
- 已将托管默认请求预算提高到 7,000ms，为 SnowLuma 5 秒探测及 HTTP 返回留出余量。新 `test/snowluma-probe-timeout.test.ts` 用可取消的 fake fetch 模拟 5.1 秒响应：旧 1 秒默认下测试在约 1.035 秒失败且没有 load；调整后约 5.13 秒通过，身份匹配、load 一次并进入 online。该测试不连接真实服务。
- 修复快照独立 review 通过，fingerprint `d093c51c7773e694295d46b15e23be671a1129ce19b7dffc104033d667e2b516`；`npm run check` 的 TypeScript、依赖边界检查及 190 项测试通过；代码提交 `aba7022a1eb231497ba7666efb5392e5316553ab`，标签 `checkpoint/dev-host-probe-timeout-fix-2026-10-14-unverified`。
- Reviewer 的非阻塞建议：7 秒预算也作用于 login、process list 和 load；本轮保留单一有界请求时限，若以后要求这些快路径更快失败，可拆为 probe 专用超时。

## T12b 修复后用户功能冒烟结果（2026-10-14）

- 用户报告用测试账号登录后可以正常对话；随后 Ctrl+C 退出 Aquarium，QQ 仍运行。按用户可见端到端行为，这证明该测试账号的消息路径可用，且 host 退出没有关闭 QQ。
- Aquarium 本机日志脱敏汇总：登录最终 HTTP 200；进程列表 56 次 HTTP 200；probe-login 4 次 HTTP 200、0 次 network error；load 1 次 HTTP 200、无加载失败 warning。日志中只有 `waiting_qq_login` 与初始 adapter `offline`，没有 `Windows 托管状态：online` 或 adapter `online` 行。
- 上述日志统计只覆盖第一次 17:00–17:10 运行；当时确实没有 online 行，用户随后确认测试账号能正常对话并完成退出。

### 完整日志窗口补查

- 为核实是否需要修复 online 日志，随后补查 17:16–17:19 的完整本机 Aquarium 日志：第二次运行在 17:17:07 记录 adapter `online`，17:17:12 记录 host `online`；同一窗口还记录一次 load HTTP 200，之后 process polling 持续正常，没有 probe network error 或 load failure warning。
- 因此不存在“online 日志始终不产生”的代码问题；第一次运行的日志缺少 online，与其当时的 adapter offline/waiting 状态一致。后续运行产生了预期状态事件，用户也确认测试账号可正常对话，无需为 online 日志另改代码。
- 真实托盘 GUI 与 autostart 未包含在这次测试中。

## T12a 独立托盘 spike 用户 GUI 验收（2026-10-14）

- 用户确认四项均通过：系统托盘出现图标；“状态：测试中”不可点击；“切换颜色”按青、黄、红循环；点击“退出”后 spike 与 tray helper 退出且图标清理。
- 此结果只证明 `src/spike/tray.ts` 独立 spike 在该 Windows 用户环境可启动、操作和退出；不代表 `main.ts` 已接入真实托盘库。Aquarium 当前的 `createLogOnlyTray()` 仍只写日志，系统通知 API 也未获验证。

## T12c 真实托盘接入结果（2026-10-14；代码复核通过，用户验收待进行）

> 本节记录 Aquarium 集成代码和 fake/offline 验证，不表示本轮运行过真实 tray helper、QQ、SnowLuma、GUI 或自启动。

- `src/host/tray.ts` 现以 `worker_threads` 承载 `@trayjs/trayjs@0.0.10`，主线程只持有 `Tray` 接口代理；helper 异步启动错误通过 Worker `error/exit` 通道记录，bot 继续运行且不自动重建。Worker 收到 parent port `close` 时会解决在途闭嘴状态请求并 dispose tray，避免 helper 因父端断开而遗留。
- Host 状态映射青/黄/红 ICO 与状态 tooltip；系统通知 API 不存在时 `notify` 只更新 tooltip。显示中的通知 tooltip 与菜单状态行分开保存，helper `ready` 时重新应用最新图标和显示文字；后续状态变更会恢复状态 tooltip。
- 菜单实现控制台、（需本地 QQ 路径时才启用的）打开 QQ、全局闭嘴/恢复、SnowLuma restart 与退出。SnowLuma restart 进入 host lifecycle queue；shutdown 等待在途 restart，并在 tray worker 延迟加载完成时 gate bind 或 dispose。
- Fake tray/worker 测试覆盖状态与菜单、ready 延迟、helper 意外退出、Worker 启动/通信错误、parent-port close、延迟加载时 shutdown 与不重建。完整 `npm run check` 通过 211 项；`git diff --check` 通过。
- 精确 staged snapshot review 通过：fingerprint `f623dce543f1572d87a69902df8032f958bcebbe75e24e46540b28b7af415a3b`；security/logic findings 为空。代码提交 `f5f2dcffa699de3a2a34bef0376054e5a1ab28df`，本地标签 `checkpoint/dev-host-t12c-code-2026-10-14-unverified`。标签保持 `unverified`，因为真实 Windows 用户验收仍待完成。
- 非阻塞 reviewer 建议：异步菜单状态刷新与 dispose 并发时尚无专门回归；本轮未扩大范围。真实托盘/菜单关闭验收留给用户；未运行 `npm start`、tray、QQ、SnowLuma、GUI 或 `autostart:install`。

## T12c 用户验收 follow-up：面板启动不再依赖 QQ 登录（2026-10-14）

- 用户实测发现：若 `npm start` 时小号 QQ 尚未登录，随后手动登录也不会让 5180 端口开始监听；只有启动时 QQ 已在线才可访问。源码追踪确认 `main.ts` 先 await 串行 `runStartupTasks()`，每个任务又 await `adapter.connect()`，而面板在全部账号任务后才启动；连接等待会挡住面板初始化。
- 修复后主程序先启动账号任务，再在其 `adapter.connect()` 仍等待时立即启动面板；主流程仍 await 原 startup promise，保留原账号启动/错误处理顺序。面板原有 `panel.passwordEnv` 非空门槛和 shutdown guard 不变。
- 新增 deferred-promise regression：账号连接仍 pending 时，面板启动回调必须已经运行。测试先因 ordering helper 缺失按预期 RED，修复后 GREEN。
- `npm run check` 通过 212 项（TypeScript、依赖边界检查及测试）；精确 staged review 通过，fingerprint `9a7982774c5da99984a93647a8d3b88b664356c0cb752eea3b2fa9b1bcc9ea64`。代码提交 `1f0f2b7668e5ffbaee08824de10b7527aa78bbfa`，标签 `checkpoint/dev-host-panel-startup-fix-2026-10-14-unverified`。
- 未运行 `npm start`、真实 QQ/SnowLuma、浏览器或 panel server；待用户复测“小号启动时离线、先打开 panel、再登录小号”。Reviewer 非阻塞建议：`Aquarium 已启动` 日志可能出现在账号连接完成前；新增回归验证 helper ordering，但未直接实例化 main composition。
