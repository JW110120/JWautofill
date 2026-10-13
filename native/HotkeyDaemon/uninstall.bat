@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0uninstall.ps1"
rem ⛔ 绝不在这里用 `if errorlevel 1 pause`：卸载失败（errorlevel=1）时 pause 会让窗口
rem    永远停在「请按任意键继续」，而倒计时早已结束 —— 用户报的
rem    「倒计时为 0 了也无法自动关闭」就是它。收尾交给 PowerShell 的倒计时
rem    （成功 5s / 失败 15s，足够看清错误与日志路径）。
rem    只有「PowerShell 根本没起来」（9009 = 命令找不到）才需要停下来看原因。
if errorlevel 9009 pause
