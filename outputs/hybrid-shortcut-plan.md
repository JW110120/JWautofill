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

## 构建与运行

1. 守护进程（Windows）：
   ```
   cd native/HotkeyDaemon
   dotnet publish -c Release -r win-x64 --self-contained true
   ```
   产物在 `bin/Release/net8.0/win-x64/publish/JWautofillHotkeyDaemon.exe`，双击或后台启动即可（无需管理员）。
2. UXP 插件：正常 `npm run build`，载入 PS 后自动连接 `ws://127.0.0.1:18923`（失败会每 1.5s 重连）。

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

## 未决风险 / 下一步

- **笔刷切换 batchPlay 需在真实 PS 中验证**：`currentTool:'paintbrush'` 与 `select brush(preset)+name` 是 Alchemist 标准产物，但不同 PS 版本偶有不同的笔刷描述符形态；若切换失败需用 Alchemist 重新录制并修正 `applyBrush`。
- **常驻进程**：守护进程需随 PS/系统自启（建议注册为 Windows 启动项或配套安装器），否则快捷键不生效。
- **冲突**：组合键若与 PS 原生快捷键冲突，`RegisterHotKey` 会失败并在控制台打印「注册失败(可能冲突)」，面板会提示。
- 跨平台（macOS）未实现；当前仅 Windows。

## 结论

可行性已落地为可编译代码：守护进程捕获全局热键、UXP 直接切笔刷与总开关均已打通；剩余工作量集中在 PS 实机验证笔刷描述符与守护进程的自启动分发。
