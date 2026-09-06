@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0fix-keyboard.ps1"
REM ⚠️ 故意不写 `if errorlevel 1 pause`：键盘卡死时 pause 会等待按键输入 → 自身成为死锁。
REM    修复脚本全程无交互，失败信息已写入 %TEMP%\jwautofill_fixkeyboard.log。
