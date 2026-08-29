$ErrorActionPreference = "Continue"
param([string]$Keys)
$ws = New-Object -ComObject WScript.Shell
Start-Process notepad
Start-Sleep -Milliseconds 1500
$np = Get-Process notepad | Select-Object -First 1
$null = $ws.AppActivate($np.Id)
Start-Sleep -Milliseconds 800
[void]$ws.SendKeys($Keys)
Start-Sleep -Milliseconds 1500
Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue
"sent"
