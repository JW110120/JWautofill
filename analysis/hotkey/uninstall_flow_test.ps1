$ErrorActionPreference = "Continue"
$ErrorActionPreferencePreference = "Continue"

Write-Host "=== BEFORE ==="
$beforeProc = Get-Process -Name JWautofillHotkeyDaemon -ErrorAction SilentlyContinue
if ($beforeProc) { "daemon running PID=" + ($beforeProc | ForEach-Object { $_.Id }) } else { "daemon not running" }
"reg=" + ((Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name JWautofillHotkeyDaemon -ErrorAction SilentlyContinue).JWautofillHotkeyDaemon)
"installdir exists=" + (Test-Path "$env:LOCALAPPDATA\JWautofill\daemon")

Write-Host "=== RUN UNINSTALL (answering N to config deletion) ==="
$out = & cmd /c "echo n | powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"F:\Coding\JWautofill\native\HotkeyDaemon\uninstall.ps1`"" 2>&1
$code = $LASTEXITCODE
$out | ForEach-Object { Write-Host ("  | " + $_) }
"EXITCODE=" + $code

Write-Host "=== AFTER ==="
$afterProc = Get-Process -Name JWautofillHotkeyDaemon -ErrorAction SilentlyContinue
if ($afterProc) { "daemon still running PID=" + ($afterProc | ForEach-Object { $_.Id }) } else { "daemon stopped" }
"reg=" + ((Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name JWautofillHotkeyDaemon -ErrorAction SilentlyContinue).JWautofillHotkeyDaemon)
"installdir exists=" + (Test-Path "$env:LOCALAPPDATA\JWautofill\daemon")
"jwroot exists=" + (Test-Path "$env:LOCALAPPDATA\JWautofill")

Write-Host "=== REINSTALL ==="
$out2 = & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "F:\Coding\JWautofill\native\HotkeyDaemon\install.ps1" 2>&1
$code2 = $LASTEXITCODE
$out2 | ForEach-Object { Write-Host ("  | " + $_) }
"INSTALL_EXITCODE=" + $code2

Start-Sleep -Seconds 2
Write-Host "=== FINAL ==="
$p = Get-Process -Name JWautofillHotkeyDaemon -ErrorAction SilentlyContinue
if ($p) { "daemon running PID=" + ($p | ForEach-Object { $_.Id }) } else { "daemon NOT running" }
"reg=" + ((Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name JWautofillHotkeyDaemon -ErrorAction SilentlyContinue).JWautofillHotkeyDaemon)
"installdir exists=" + (Test-Path "$env:LOCALAPPDATA\JWautofill\daemon")
