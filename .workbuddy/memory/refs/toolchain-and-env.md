# 环境 / 工具链 / 守护进程（JWautofill）

> 由 MEMORY.md 下沉（2026-10-08，控制 MEMORY.md 体积）。构建、调试、菜单、原生守护进程相关。

## 面板与菜单
- 两块面板共用同一 `document.body` ⇒ body 状态类名按面板分（主面板 license-dialog-open / secondary-panel-open / app-visibility-panel-open；
  工具箱 visibility-panel-open / adjustment-lock-open）。**隐藏规则必须「属主类名 + 属主根节点」成对写**，否则出现代偿现象（技能 ⑱）。
- **menuItems id 插件级全局唯一，且菜单项只能置灰、绝不能删**：
  同名 id → `entrypoints.setup()` 抛 "already exists"、**两块面板一起空白**。
  🔴 **`removeAt()` 与宿主内部状态不同步**（官方论坛确认）：「removeAt + insertAt 挂回」反复执行后**菜单项越来越少**。
  ⇒ **只能用 `enabled` 做隐藏/禁用，绝不 removeAt/insertAt**；找项按 id 遍历（不能按固定下标）。
  ⚠️ 工具箱改 `id` 同样撞 "already exists" ⇒ 只改 label。APP 增删项必须四处同步：
  `registerAppCallbacks` 类型+赋值、`handleAppFlyout` case、menuItems 数组、app.tsx 注册处（技能 ⑰）。

## 文件与 IO
- UXP 无内置 `fs`/`os`（编译期正常、运行期才炸）；落盘只用 `localFileSystem`（URL 写 `file:/C:/…`）；
  用户自选路径用 `getFileForSaving`（必须在 `executeAsModal` **之外**调）。技能 ⑲。
- **写文件禁用不可见控制字符做分隔符**：用可见分隔符（`|`），别用 U+0000/U+0001
  （会变成模板字符串里的字面分隔符，且让 grep 把源码当 binary 报误导性行数）。改完用 `node -e` 扫字节确认 NUL/控制符为 0。

## 编辑与版本控制
- ⚠️ Edit 常「报成功但没落盘」；本仓行尾不统一（部分文件 CRLF、.tsx LF）⇒ 改前确认行尾，**改完必须 grep 复核**。
  ⚠️ 大段中文注释的改动，用脚本按锚点精确替换比反复试 Edit 快（Edit 对空格/全角半角差异会匹配失败）。
- ⚠️ `.git/refs/remotes/origin/` 曾缺失 → fetch 假成功、status 恒 ahead；修法 mkdir 后 `git update-ref`。
  推送用 `git -c credential.helper=wincred push`。dist/、analysis/、outputs/ 已 gitignore。
- 前端改完须 UDT Reload；daemon 重编 SDK 8.0.424 在 `C:\Users\Administrator\.dotnet-sdk`（**永不删**）。

## 构建 / 类型检查
- 构建 `node node_modules/webpack/bin/webpack.js --mode=production`（或 `yarn build`）。
  ⚠️ `transpileOnly:true` ⇒ 只转译不做类型检查，漏加接口字段/漏转发**不报错、只静默失效**。
  类型校验用 `tsc -p analysis/line_vis/tsconfig.tc.json`（必须 `types:[]` 绕开 `@types/node/ffi.d.ts` 的 TS1109，否则 tsc 提前中止 = **假通过**）。
- ⚠️ 本机工具：**bash（Git Bash）现可用**（历史上曾 PATH 损坏）；`dangerouslyDisableSandbox` 之外的普通命令一律走 bash 更省事。
  PowerShell 工具 **stdout 不回显** ⇒ 需读输出时显式 `Out-File` 再用 Read（UTF-8 落盘，避免 GBK 乱码）。
- 术语：APP 与 AdjustmentPanel 皆「父面板」；纯色/图案/渐变/描边 = 「子面板」（`src/app.tsx` 内 absolute）。

## 守护进程
- C#/.NET8 daemon（`native/HotkeyDaemon/Program.cs`）：WH_KEYBOARD_LL 独立线程，钩子线程严禁阻塞 I/O，
  焦点闸门 `IsPhotoshopForeground` 否则放行。WS 127.0.0.1:18923。冻结三形态与 ps1 七步见技能
  `windows-keyboard-device-reset`；改 ps1 后同步 dist/。`shell.openPath` 受 manifest 扩展名白名单管控。
