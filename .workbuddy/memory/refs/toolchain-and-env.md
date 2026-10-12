# 环境 / 工具链 / 守护进程（JWautofill）

> `MEMORY.md` 的展开页。构建、调试、菜单、文件 IO、原生守护进程相关。

## 一、面板与菜单

- 两块面板共用同一 `document.body` ⇒ body 状态类名按面板分（主面板 `license-dialog-open` / `secondary-panel-open` / `app-visibility-panel-open`；工具箱 `visibility-panel-open` / `adjustment-lock-open`）。**隐藏规则必须「属主类名 + 属主根节点」成对写**，否则出现代偿现象（一块面板的浮窗没修好、开另一块才生效）。
- ⛔ **menuItems id 插件级全局唯一，且菜单项只能置灰、绝不能删**：
  - 同名 id → `entrypoints.setup()` 抛「already exists」、**两块面板一起空白**。
  - 🔴 `removeAt()` 与宿主内部状态不同步 ⇒「removeAt + insertAt 挂回」反复执行后菜单项越来越少 ⇒ **只能用 `enabled` 做隐藏/禁用，绝不 removeAt/insertAt**；找项按 id 遍历（不能按固定下标）。
  - ⚠️ 工具箱改 `id` 同样撞「already exists」⇒ 只改 label。APP 增删项必须多处同步（`registerAppCallbacks` 类型+赋值、`handleAppFlyout` case、menuItems 数组、app.tsx 注册处）。
- ⛔ **菜单项数组是「唯一来源」**（`src/utils/MenuManager.ts` 顶部 `APP_MENU_ITEMS` / `ADJUSTMENT_MENU_ITEMS`）：`entrypoints.setup()` 只引用它们；各类「按 id 遍历」的静态字段（如门控用的 `appMenuIds`）也**从同一数组派生**（`filter(id => id.indexOf("spacer") !== 0)` 去分隔符）⇒ 增删项只改一处、杜绝 id 漂移。
- ⛔ **注册（激活）面板打开期间「整菜单门控」**：`MenuManager.setLicenseDialogOpen(open)` 把两个父面板的菜单项按白名单写 `enabled`：
  - APP 白名单 = `openLicenseDialog` + `openDocsFill`；工具箱白名单 = `openDocsToolbox`（工具箱本就无激活入口，激活只在选区填充面板做）。其余（含 `resetLicense` / `toggleCompactMode` / 各布局与功能项）一律置灰。
  - 关闭后按「默认可用态」还原（`defaultMenuItemEnabled`：仅 `resetLicense` 依 `appLicenseActive`，其余恒 true）。
  - 幂等：类内 `licenseMenuGated` 记住上次门控态，未变直接返回。调用点 = `app.tsx::syncLicenseDialogClass()`（唯一 body 类派生点，每次 render 调用）。
  - 底层统一走 `updateMenuItem(panelId, id, patch)`（`getItem` → `updateItem` → 数组项 三级降级）；`setLicenseLogoutEnabled` / `setCompactModeLabel` 也走它。
  - ⚠️ `setLicenseLogoutEnabled` 在门控期强制写 `false`；门控解除时按 `appLicenseActive` 重新还原。

## 二、文件与 IO

- UXP 无内置 `fs` / `os`（编译期正常、运行期才炸）；落盘只用 `localFileSystem`（URL 写 `file:/C:/…`）；用户自选路径用 `getFileForSaving`（**必须在 `executeAsModal` 之外**调）。
- ⚠️ **写文件禁用不可见控制字符做分隔符**：用可见分隔符（`|`），别用 U+0000/U+0001（会变成模板字符串里的字面分隔符，且让 grep 把源码当 binary）。改完用 `node -e` 扫字节确认控制符为 0。

## 三、⛔⛔ 文件落盘铁律：「临时文件 + moveTo 原子替换」

- ⛔ **禁止 `createFile(正式文件名, {overwrite:true})` 后直接 `write()`**：`overwrite:true` 会**先把文件截断为 0 字节**再写内容。写入窗口内任何中断（**UDT Reload 会直接杀死 UXP 宿主**、大文件写数秒~数十秒、宿主异常）都会把正式文件**永久留在 0 字节** ⇒ 下次加载解析失败 ⇒ 数据全丢。
- ⛔⛔⛔ **`Entry.moveTo(folder, ...)` 第二参是「选项对象」，不是字符串**：正确签名 `moveTo(folder, { newName: 'x.json', overwrite: true })`。传字符串 ⇒ UXP 原生绑定严格校验抛错（`Argument 2 has an invalid type`），而调用点普遍包在 `try{…}catch(_){}` 里 ⇒ **错误被静默吞掉、移动从未发生**。
  - 统一走 `PresetManager.moveEntryTo(entry, folder, newName)`（内部只此一处拼装选项对象）。
- ✅ 正确顺序：① `createFile(name + '.tmp', {overwrite:true})` → `write()`；② 备份现有正式文件（`moveEntryTo(现有文件, folder, '….backup')`，带 overwrite ⇒ 不必先删旧备份）；③ `moveEntryTo(tmpFile, folder, 正式文件名)` 替换。
  - ⇒ 写 tmp 失败时正式文件**分毫未动**；任何时刻磁盘上至少有一份完整数据。
  - ⚠️ **不要**写「moveTo 失败先删目标再重试」：目标被删而重试又失败时数据就没了。
- ⛔ 加载侧必须配恢复链：**正式文件缺失或不可解析 → `.tmp`（严格 `JSON.parse`，残缺不采信）→ `.backup`（可用「掐头去尾」修复）**。恢复动作 = 把该文件 `moveEntryTo` 回正式文件名（补完被打断的替换），比 `createFile+write` 安全得多。
- ⚠️ **教训**：同一个 `PresetManager` 里两条保存路径实现不一致时，小数据那条的兜底会**掩盖**大数据那条的缺陷（渐变有 `createFile+write` 兜底 ⇒ 即使 moveTo 写错签名也「看起来正常」，无人察觉 pattern 路径的原子替换恒失败）。

## 四、编辑与版本控制

- ⚠️ Edit 常「报成功但没落盘」；本仓行尾不统一（部分文件 CRLF、`.tsx` LF）⇒ 改前确认行尾，**改完必须 grep 复核**。
- ⚠️ 大段中文注释的改动，用脚本按锚点精确替换比反复试 Edit 快（Edit 对空格/全角半角差异会匹配失败）。
- ⚠️ `.git/refs/remotes/origin/` 曾缺失 → fetch 假成功、status 恒 ahead；修法 mkdir 后 `git update-ref`。推送用 `git -c credential.helper=wincred push`。
- `dist/`、`analysis/`、`outputs/` 已 gitignore（`analysis/`、`outputs/` 是本地临时产物、**不跨机同步**）。
- 前端改完须 **UDT Reload**；daemon 重编需 SDK 8.0.424（在 `C:\Users\Administrator\.dotnet-sdk`，**永不删**）。

## 五、构建 / 类型检查

- 构建 `node node_modules/webpack/bin/webpack.js --mode=production`（或 `yarn build`）。
  - ⚠️ `transpileOnly:true` ⇒ 只转译不做类型检查，漏加接口字段/漏转发**不报错、只静默失效**。
- 类型校验用 `npx tsc --noEmit`（判据：**只看 `src/` 有无新增报错**；全仓既有噪声来自依赖 `@types/node/ffi.d.ts`）。
- ⚠️ 本机工具：**bash（Git Bash）现可用**；PowerShell 工具 **stdout 可能整体不回显** ⇒ 需读输出时显式 `Out-File ... -Encoding utf8` 再用 Read（避免 GBK 乱码），别用管道。

### 原生工具链：便携 zig（2026-10-12 定案，用于写注入 DLL）

- ⛔ 本机**没有任何原生编译器**（无 MSVC / Windows Kits / gcc / clang / zig），连 NativeAOT 也要 MSVC 的
  `link.exe` ⇒ 要写注入 DLL（inline-hook Wintab）**必须自带工具链**。
- ✅ 已装：`bash native/get-zig.sh` → `%USERPROFILE%\zig-toolchain\zig.exe`（zig 0.16.0，约 35 秒）。
  编译：`"$USERPROFILE/zig-toolchain/zig.exe" cc -target x86_64-windows-gnu -shared -O2 -o x.dll x.c`
  首次约 2 分钟建缓存，之后 **2 秒**；产出 x64 PE DLL（Machine `0x8664` + DLL 位），已验证可
  `LoadLibrary` 并调通导出函数。
- ⛔ **坑（别改路径）**：zig 由 exe 所在位置推导 `lib_dir`；放在过深路径下会推成**相对路径**，
  其内部子编译换 cwd 后解析失败 ⇒ 报 `unable to load 'std.zig': AccessDenied`
  —— 看着像权限 / 杀软，其实是路径问题。装在 `%USERPROFILE%\zig-toolchain` 就是为了绕开它。
- ⚠️ **下载不走官网**：ziglang.org 实测 18KB/s（100MB 要 1.5 小时）；走 PyPI 官方 `ziglang` wheel +
  清华镜像 = 2.8MB/s。
- ⚠️ 沙箱会拦 zig 的**子编译进程**读标准库 ⇒ 编译类命令需在沙箱外执行。

## 六、契约守卫脚本（`scripts/`，随仓库同步）

| 脚本 | 作用 | 何时跑 |
| --- | --- | --- |
| `node scripts/_css_comment_guard.cjs` | CSS 注释配对 / 游离结束符 / 大括号配对（扫 `src/styles/*.css`） | 每次改 CSS |
| `node scripts/_modal_contract_guard.cjs` | 模态契约：opts 分岔 / WeakMap 记忆化 / 置入图层事件注册 | 改 `psAccess` / `psProbe` / 模态调用点 |
| `node scripts/_color_picker_contract_guard.cjs` | 拾色器初值必须是真实色（从仓库根运行） | 改拾色器 / 灰态显示 |

## 七、术语与守护进程

- 术语：APP 与 AdjustmentPanel 皆「父面板」；纯色/图案/渐变/描边/清除 = 「子面板」（`src/app.tsx` 内 absolute）。
- C#/.NET8 daemon（`native/HotkeyDaemon/Program.cs`）：`WH_KEYBOARD_LL` 独立线程，钩子线程严禁阻塞 I/O，焦点闸门 `IsPhotoshopForeground` 否则放行。WS `127.0.0.1:18923`。冻结形态与 ps1 修复步骤见技能 `windows-keyboard-device-reset`；改 ps1 后同步 dist/。`shell.openPath` 受 manifest 扩展名白名单管控。
- 原生可执行物有**两个独立项目**，必须**分别发布**（主 csproj `HotkeyDaemon.csproj` 用 `DefaultItemExcludes` 排除了 `FixKeyboard/**`）：① 守护进程 → `native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe`；② 键盘修复器 → `native/HotkeyDaemon/FixKeyboard/publish/FixKeyboard.exe`。webpack 分别拷到 `dist/native/HotkeyDaemon/publish/…` 与 `dist/native/HotkeyDaemon/FixKeyboard.exe`（**扁平**，与 `fix-keyboard.ps1` 同层——exe 按 `AppContext.BaseDirectory` 读同目录脚本，放子目录会找不到）。⛔ **改 exe 后必须「发布 + `yarn build`」两步**，只 publish 不 build 分发包会带旧版。发布命令与 Git Bash 环境变量坑位见技能 `dotnet-publish-windows`。

---

## 守护进程双钩子（键盘热键 / 鼠标套索平滑）— 由 MEMORY.md 下沉（2026-10-12）

- ⛔ **两个钩子结构对称、状态零共享**：键盘钩子（`WH_KEYBOARD_LL` / `_hookId` / `_hotkeyArmed` /
  `_hookSafeMode` / `HotkeyWatchdog`）与鼠标钩子（`WH_MOUSE_LL` / `_mouseHookId` / `_smoothArm` /
  `_mouseHookSafeMode` / `SmoothWatchdog`）各有独立的**线程、句柄、布防标志、熔断标志、看护线程、
  状态消息**（`hotkeyState` / `smoothState`）。`hotkeyArm` = 热键侧独立装卸
  （运行期可真卸钩子，不再只能清空热键表让它空转）。
- ⛔ **进程级 ≠ 子系统级**：面板的「启动 / 停止服务」`shell.openPath` + `{"type":"shutdown"}`、
  「卸载」`{"type":"uninstall"}`、开机自启都是**进程级** —— 进程一没，两种钩子同时消失。
  要做到「停掉 / 卸载热键服务而平滑继续」只能**拆成两个进程**（如 `--role hotkey|smooth` + 双端口）。
  UXP 侧唯一的耦合点：`HotkeyBridge` 的 `ws.onclose` 里同时 `connected=false` 与
  `setLassoSmoothConnected(false)` ⇒ 平滑状态行必然显示「未连接快捷键服务」。
- ⛔⛔ **钩子线程的消息循环必须逐轮 `try/catch`**：循环里的指令直接调 Win32，一次未捕获异常就让
  **整条线程消失**，而低层钩子挂在这条线程上 ⇒ 钩子被系统连带摘除、`_threadId` 变死地址
  （`PostThreadMessage` 不报错但消息进死队列）⇒ 该侧永久失效。
  看护线程的 `Thread.IsAlive` 探针 + 线程体自行装配是唯一出路。
- ⛔ **看护线程不合并**：合并后任一侧循环卡住 / 抛异常都会拖住另一侧。
- ⛔⛔ **能力协商**：旧版 daemon 对未知 type（`smoothArm`）**静默丢弃** ⇒ 面板永远收不到 `smoothState`
  ⇒ 会把「版本过旧」误报成「被安全软件拦截」。UXP 侧一律「建连后主动询问 + 超时窗口内无回帧
  ⇒ 标记 `unsupported`」，文案如实说「守护进程版本过旧」。`getState` 提供 `protocol` / `features`。
- ⛔⛔ **安装目录副本不会自己更新**：`launchDaemon` 无人调用；daemon 由开机自启从
  `%LOCALAPPDATA%\JWautofill\daemon\` 拉起。更新只有一条路：从插件目录启动 → 比对新旧 →
  停旧副本 → 拷贝 → 从安装目录重新拉起。**面板侧的正确姿势：服务开关「先关再开」**。
- ⛔ **`Process.Kill()` 是异步请求**：停旧副本后必须 `WaitForExit`，否则
  ① `File.Copy` 撞文件锁（被 catch 吞掉 ⇒ 安装目录仍是旧 exe）
  ② 紧接着的「安装副本是否在跑」枚举把刚杀的进程算作在跑 ⇒ 跳过拉起 ⇒ **机器上零守护进程**（真机复现过）。
- ⛔ `PostThreadMessage(int, **uint** msg, ...)`：`cond ? A : B` 不是常量表达式 ⇒
  拿不到 C# 常量隐式转换，必须显式 `(uint)`；`MSG.message` 是 `uint`，取出来要转 `int` 才能与 `WM_*` 常量比较。
- ⚠️ 诊断：日志 `%LOCALAPPDATA%\JWautofill\daemon\daemon.log` —— **追加模式 + 每次启动写分隔行
  （含时间 / 版本 / 进程号），超 1MB 截断**；`AppDomain.UnhandledException` / `ProcessExit` /
  `UnobservedTaskException` 一律走**绕过队列的同步落盘**（`DirectLog`）。以前是 `FileMode.Create`
  ⇒ 每次重启抹掉上一轮 ⇒「守护进程忽然没了」事后永远查不到（真机踩过）。
  活体查询见 `refs/lasso-smoothing.md` §8 的诊断脚本表。
- ⛔ 改 `native/HotkeyDaemon/Program.cs` 后必须**两步**：先
  `dotnet publish HotkeyDaemon.csproj -c Release -o publish`，再 `yarn build`
  （webpack 只是把 `publish/*.exe` 拷进 `dist/`）。漏掉第一步 = 代码改了、插件包里仍是旧 exe。
