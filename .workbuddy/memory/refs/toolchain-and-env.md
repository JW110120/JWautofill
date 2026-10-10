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
- **菜单项数组是「唯一来源」**（2026-10-10 重构）：两份菜单提到模块级常量
  `APP_MENU_ITEMS` / `ADJUSTMENT_MENU_ITEMS`（`src/utils/MenuManager.ts` 顶部），
  `entrypoints.setup()` 只引用它们；各类「按 id 遍历」的静态字段（如门控用的 `appMenuIds`）
  也**从同一数组派生**（`filter(id => id.indexOf("spacer") !== 0)` 去分隔符）⇒ 增删项只改一处，杜绝 id 漂移。
- **注册（激活）面板打开期间「整菜单门控」**（2026-10-10 用户要求）：`MenuManager.setLicenseDialogOpen(open)`
  把两个父面板的菜单项按白名单写 `enabled`：APP 白名单 = `openLicenseDialog` + `openDocsFill`，
  工具箱白名单 = `openDocsToolbox`（工具箱本就无激活入口，设计上激活只在选区填充面板做）；
  其余（含 `resetLicense` / `toggleCompactMode` / 各布局与功能项）一律置灰。关闭后按「默认可用态」还原
  （`defaultMenuItemEnabled`：仅 `resetLicense` 依 `appLicenseActive`，其余恒 true）。
  · 幂等：类内 `licenseMenuGated` 记住上次门控态，态未变直接返回，不重复写宿主菜单。
  · 调用点 = `app.tsx::syncLicenseDialogClass()`（唯一 body 类派生点，每次 render 调用）。
  · 底层统一走 `updateMenuItem(panelId, id, patch)`（getItem → updateItem → 数组项 三级降级），
    `setLicenseLogoutEnabled` / `setCompactModeLabel` 也已改走它。
  · ⚠️ `setLicenseLogoutEnabled` 在门控期强制写 `false`（避免有路径越过门控把「注销激活状态」点亮）；
    门控解除时由 `applyPanelMenuGating(false)` 按 `appLicenseActive` 重新还原。

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

## ⛔⛔ 文件落盘铁律：必须「临时文件 + moveTo 原子替换」（2026-10-10 丢数据事故定论）
- ⛔ **禁止 `createFile(正式文件名, {overwrite:true})` 后直接 `write()`**：`overwrite:true` 会
  **先把文件截断为 0 字节**再写内容。写入窗口内任何中断（**UDT Reload 会直接杀死 UXP 宿主**、
  大文件写入数秒~数十秒、宿主异常）都会把正式文件**永久留在 0 字节** ⇒ 下次加载解析失败 ⇒ 数据全丢。
- ⛔⛔⛔ **`Entry.moveTo(folder, ...)` 第二参是「选项对象」，不是字符串**：
  正确签名 `moveTo(folder, { newName: 'x.json', overwrite: true })`。
  传字符串 ⇒ UXP 原生绑定严格校验抛错（`Argument 2 has an invalid type`），
  而调用点普遍包在 `try{…}catch(_){}` 里 ⇒ **错误被静默吞掉、移动从未发生**。
  ⚠️ **上一条铁律旧版就是这么写错的**（写成了 `tmpFile.moveTo(folder, 正式文件名)`），
  于是「原子替换」的最后一步恒失败 ⇒ 2026-10-10 图案预设只剩 `.tmp`、正式文件消失。
  统一走 `PresetManager.moveEntryTo(entry, folder, newName)`（内部只此一处拼装选项对象）。
- ✅ 正确顺序：① `createFile(name + '.tmp', {overwrite:true})` → `write()`；
  ② 备份现有正式文件（`moveEntryTo(现有文件, folder, '….backup')`，带 overwrite ⇒ 不必先删旧备份）；
  ③ `moveEntryTo(tmpFile, folder, 正式文件名)` 替换（带 overwrite ⇒ 不必先删目标再重试）。
  ⇒ 写 tmp 失败时正式文件**分毫未动**；任何时刻磁盘上至少有一份完整数据。
  ⚠️ **不要**写「moveTo 失败先删目标再重试」：目标被删而重试又失败时，数据就没了。
- ⛔ 图案预设**绝不回退到 `createFile(overwrite)+write`**（那正是清零来源）；
  渐变预设 1~2KB、毫秒写完，**允许**保留该兜底（见 `saveGradientPresets`）。
- 加载侧必须配恢复链：**正式文件缺失或不可解析 → `.tmp`（严格 `JSON.parse`，残缺不采信）→ `.backup`
  （可用「掐头去尾」修复）**。⚠️ 只处理「存在但解析失败」不够 —— 原子替换是两步改名，
  进程在两步之间被打断会让正式文件**直接不存在**，旧实现此时直接掉 bundle ⇒ 预设全空。
  恢复动作 = 把该文件 `moveEntryTo` 回正式文件名（**补完那次被打断的替换**），
  比 `createFile+write` 安全得多。
- ⚠️ **教训**：同一 `PresetManager` 里两条保存路径实现不一致时，小数据那条的健壮性会**掩盖**
  大数据那条的缺陷（渐变有 `createFile+write` 兜底，即使 moveTo 写错签名也「看起来正常」
  ⇒ 无人察觉 pattern 路径的原子替换恒失败）。

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
