# JWautofill daemon uninstall script
# Fully reverts install.ps1 effects:
#   1) Stop the running daemon process (only by exact process name; never touches other processes)
#   2) Remove the startup registry value (only the one we created)
#   3) Delete the install directory (only the known path, with path verification to prevent accidental deletion)
#   4) Clean the temp publish directory (only the one we created)
#   5) Optional: delete user config hotkeys.json (user data; kept by default, removed only after prompt)
#
# Safety: operate only by exact name / known fixed path. Any path verification failure aborts deletion.
# Never deletes any other user files.

$ErrorActionPreference = "Stop"

$daemonName   = "JWautofillHotkeyDaemon"
$exeName      = "JWautofillHotkeyDaemon.exe"
$installDir   = Join-Path $env:LOCALAPPDATA "JWautofill\daemon"
$runKey       = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "JWautofillHotkeyDaemon"
$log          = Join-Path $env:TEMP "jwautofill_uninstall.log"
$publishDir   = Join-Path $env:TEMP "jwauto_publish"

function Log($msg) {
    $t = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$t  $msg" | Out-File -FilePath $log -Append -Encoding utf8
    Write-Host $msg
}

try {
    Log "=== JWautofill daemon uninstall start ==="

    # 1) Stop the running daemon (exact process name only)
    $procs = Get-Process -Name $daemonName -ErrorAction SilentlyContinue
    if ($procs) {
        foreach ($p in $procs) {
            try {
                Log "Stopping process $($p.Id) ($exeName)"
                $p.Stop()
                $p.WaitForExit(5000)
            } catch {
                Log "Warn: failed to stop process $($p.Id): $_"
            }
        }
    } else {
        Log "No running daemon process found."
    }

    # 2) Remove the startup registry value (only the one we wrote)
    if (Test-Path $runKey) {
        $existing = Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue
        if ($existing) {
            Remove-ItemProperty -Path $runKey -Name $runValueName -Force
            Log "Removed startup registry value: $runValueName"
        } else {
            Log "Startup registry value not present, skip."
        }
    } else {
        Log "Run key not present, skip."
    }

    # 3) Delete the install directory (known path only, with verification)
    if (Test-Path $installDir) {
        $installDir = (Resolve-Path $installDir).Path
        $la           = (Resolve-Path $env:LOCALAPPDATA).Path
        $expectedParent = Join-Path $la "JWautofill"
        $parent = Split-Path $installDir -Parent
        $leaf   = Split-Path $installDir -Leaf
        if ($parent -eq $expectedParent -and $leaf -eq "daemon") {
            Remove-Item -Path $installDir -Recurse -Force
            Log "Removed install dir: $installDir"
        } else {
            Log "ERROR: path verification failed, refusing deletion to prevent data loss: $installDir"
            throw "Unsafe path, abort deletion: $installDir"
        }
    } else {
        Log "Install dir not present, skip."
    }

    # 4) Clean the temp publish directory (only the one we created)
    if (Test-Path $publishDir) {
        Remove-Item -Path $publishDir -Recurse -Force -ErrorAction SilentlyContinue
        Log "Removed temp publish dir: $publishDir"
    }

    # 5) Optional: delete user config hotkeys.json (user data; kept by default)
    $configPath = Join-Path $env:LOCALAPPDATA "JWautofill\hotkeys.json"
    if (Test-Path $configPath) {
        $answer = Read-Host "Also delete the hotkey config file hotkeys.json? [y/N]"
        if ($answer -match '^[yY]') {
            Remove-Item -Path $configPath -Force
            Log "Removed config: $configPath"
        } else {
            Log "Kept config: $configPath"
        }
    }

    Log "=== Uninstall finished ==="
    Write-Host "Uninstall complete. Daemon stopped, startup entry removed, install directory deleted (if present)."
} catch {
    Log "ERROR: $_"
    Write-Host "ERROR: $_"
}

Read-Host "Uninstall finished, press Enter to close"
