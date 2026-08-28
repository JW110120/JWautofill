# JWautofill 全局快捷键（Hybrid 方案）实现说明

> 目标：在 UXP 插件里给「总开关」和「指定笔刷」绑定全局快捷键。UXP 无全局快捷键 API、`manifest.shortcut` 官方未实现，所以采用 **原生 Hybrid**：Windows 守护进程（C#）捕获全局按键 → 本地 WebSocket 通知 UXP → 插件直接执行。

## 架构

```
[ Photoshop ]  ← 画布/面板焦点无关
     ↑ 全局按键 (RegisterHotKey, Win32)
[ HotkeyDaemon.exe ]  (Windows 原生, 无第三方依赖)
     │  ws://127.0.0.1:18923
     ├── 连接时推送当前配置 {type:"config"}
     ├── 接收 {type:"config", payload:[...]} 落盘并重载热键
     └── 热键触发时广播 {type:"hotkey", ...}
[ UXP 插件 ]
     ├── HotkeyBridge.ts   连接守护进程 / 直接 select 笔刷
     └── BrushHotkeySection.tsx  调整面板内的「笔刷热键」分区
```

**关键设计**：配置（`hotkeys.json`，默认 `%LOCALAPPDATA%/JWautofill/hotkeys.json`）由守护进程持有并落盘，UXP 不直接读写文件（UXP 沙箱没有 Node 的 fs/os）。UXP 通过 WebSocket 的 `getConfig`/`config` 与守护进程同步。

## 生成的/修改的文件

- `native/HotkeyDaemon/Program.cs` — 守护进程源码（已编译通过，0 错误）。零依赖手写 WebSocket，支持 Ctrl/Shift/Alt/Win；消息：
  - `getConfig` → 返回 `{type:"config", payload:[...]}`
  - `config` → 落盘 + 热更新热键
  - 热键触发 → 广播 `{type:"hotkey", id, action, brush}`
- `src/hotkey/HotkeyBridge.ts` — UXP 侧桥接：连接守护进程、`applyBrush()`（直接切笔刷）、`enumerateBrushes()`、`onConfig`/`pushConfig`。
- `src/hotkey/BrushHotkeySection.tsx` — 调整面板新增「笔刷热键（全局）」分区：选笔刷→录制组合键→保存；支持笔刷枚举失败时降级为手动输入笔刷名。
- `src/adjustments/AdjustmentPanel.tsx` — 挂载上述分区。
- `src/app.tsx` — 注册总开关回调 `registerMainToggleHandler(() => this.handleButtonClick())` 并 `connectHotkeyDaemon()`。

## 随 Photoshop 启停（关键）

守护进程内置进程监控 `WatchPhotoshop()`：

- **默认（常驻）**：守护进程一直运行，但只在 **Photoshop 进程存在时** 才注册全局热键；Photoshop 关闭则自动取消注册（停止拦截）。再次打开 PS 会自动重新激活——无需任何外部触发器，最稳。
- **可选退出**：若设置环境变量 `JWAUTO_EXIT_WHEN_PS_CLOSED=1`，则 PS 关闭后守护进程直接退出（进程消失）。此时需由「开机启动项 / 插件拉起」在下次 PS 会话再次启动它。

**保证「随 PS 开启时开启」的做法**：双击 `native/HotkeyDaemon/install.bat`（或右键 `install.ps1`「用 PowerShell 运行」）。脚本会：自动编译 exe（若缺失）→ 复制到 `%LOCALAPPDATA%\JWautofill\daemon\` → 写入 HKCU\Run 开机自启 → 立即启动。面板「启动」按钮也可用 `UXP shell.openPath` 直接拉起已安装的 exe。

> ⚠️「启动」按钮只接受 **.exe** 路径。如果把 `install.ps1` 填进去会被当文件打开（显示源码），这是 Windows 对 .ps1 的默认关联，不是执行。请用 install.bat / install.ps1 安装，再把生成的 exe 路径填进面板。

## 构建与运行

1. **一键安装（推荐）**：双击 `native/HotkeyDaemon/install.bat`（窗口会保持打开并显示进度/日志）。
   脚本内部会在 exe 缺失时自动执行 `dotnet publish -c Release -r win-x64 --self-contained`，再把 exe 装到 `%LOCALAPPDATA%\JWautofill\daemon\JWautofillHotkeyDaemon.exe`。
2. 手动编译：
   ```
   cd native/HotkeyDaemon
   dotnet publish -c Release -r win-x64 --self-contained
   ```
3. UXP 插件：yarn watch 会自动编译；载入 PS 后自动连接 `ws://127.0.0.1:18923`（失败每 1.5s 重连）；面板「守护进程状态」显示实时连接状态。

## 「直接绑笔刷」原理（仿 Brusherator）

不录制动作。守护进程捕获组合键后，UXP 用 `action.batchPlay` 直接选中笔刷预设：

```js
await core.executeAsModal(async () => {
  await action.batchPlay([{ _obj:'set', _target:[{_ref:'application',_enum:'ordinal',_value:'targetEnum'}],
    to:{ _obj:'application', currentTool:'paintbrush' } }], { synchronousExecution:true });
  await action.batchPlay([{ _obj:'select',
    _target:[{_ref:'brush',_enum:'brush',_value:'preset'},{_ref:'application',_enum:'ordinal',_value:'targetEnum'}],
    name: brushName }], { synchronousExecution:true });
}, { commandName:'切换笔刷' });
```

描述符来自 Alchemist 录制「在笔刷面板选择预设」的标准输出。

## 已修复的问题（本轮）

- **组合键录不上**：原录制用 `once:true` 导致修饰键（Ctrl/Shift）按下即结束监听，后面的字母收不到。现改为持续监听直到实体键；首个修饰键会被忽略继续等待实体键，组合键（如 Ctrl+Shift+R）可正常录制。
- **命名键误判**：原 `VkKeyScanW` 会把 Backspace 等命名键误判成字符，现用 `NamedVk` 表（Backspace=0x08、Enter=0x0D、Space=0x20 等）与 UXP 端 `NAMED_KEYS` 对齐。
- **推送配置失败**：之前守护进程没在运行。现已加连接状态订阅 + 面板「启动」按钮（`shell.openPath` 拉起 exe）+ 默认安装路径自动填充。

## 未决风险 / 下一步

- **笔刷切换 batchPlay 需在真实 PS 中验证**：`currentTool:'paintbrush'` 与 `select brush(preset)+name` 是 Alchemist 标准产物，但不同 PS 版本偶有不同的笔刷描述符形态；若切换失败需用 Alchemist 重新录制并修正 `applyBrush`。
- **默认路径硬编码**：面板默认守护进程路径写死为 `C:\Users\Administrator\...`，换机器需手动改；或在 install.ps1 安装后由用户填写。
- **冲突**：组合键若与 PS 原生快捷键冲突，`RegisterHotKey` 会失败并在控制台打印「注册失败(可能冲突)」，面板会提示。
- 跨平台（macOS）未实现；当前仅 Windows。

## 结论

可行性已落地为可编译、可打包代码：守护进程捕获全局热键、随 PS 启停、UXP 直接切笔刷与总开关均已打通；剩余工作量集中在 PS 实机验证笔刷描述符与守护进程的自启动分发。
