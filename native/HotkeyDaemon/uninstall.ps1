# JWautofill daemon uninstall script
# Fully reverts install.ps1 effects:
#   1) Stop the running daemon process (only by exact process name; never touches other processes)
#   2) Remove the startup registry value (only the one we created)
#   3) Delete the install directory (only the known path, with path verification to prevent accidental deletion)
#   4) Clean the temp publish directory (only the one we created)
#   5) Optional: delete user config hotkeys.json (user data; kept by default, removed only after prompt)
#   6) Clean %LOCALAPPDATA%\JWautofill leftovers (configpath.txt, legacy hotkeys.json)
#
# Safety: operate only by exact name / known fixed path. Any path verification failure aborts deletion.
# Never deletes any other user files.
#
# IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as ANSI (GBK on Chinese Windows), so any non-ASCII byte corrupts parsing.
# Exit code: 0 = uninstall succeeded (window auto-closes after a 5s countdown)
#            1 = something failed (window stays open so the user can read the error)

$ErrorActionPreference = "Stop"

$daemonName   = "JWautofillHotkeyDaemon"
$exeName      = "JWautofillHotkeyDaemon.exe"
$installDir   = Join-Path $env:LOCALAPPDATA "JWautofill\daemon"
$jwRoot       = Join-Path $env:LOCALAPPDATA "JWautofill"
$runKey       = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "JWautofillHotkeyDaemon"
$log          = Join-Path $env:TEMP "jwautofill_uninstall.log"
$publishDir   = Join-Path $env:TEMP "jwauto_publish"
$configPathStore = Join-Path $jwRoot "configpath.txt"

function Log($msg) {
    $t = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$t  $msg" | Out-File -FilePath $log -Append -Encoding utf8
    Write-Host $msg
}

# Read-Host throws in non-interactive sessions (and when stdin is piped), which
# would otherwise abort the whole uninstall at the optional prompts below.
function Ask-YesNo($prompt) {
    try {
        if (-not [Environment]::UserInteractive) { return $false }
        $a = Read-Host $prompt
        return ($a -match '^[yY]')
    } catch {
        return $false
    }
}

function Wait-ForUser($prompt) {
    try { [void](Read-Host $prompt) }
    catch { Start-Sleep -Seconds 30 }   # non-interactive: at least keep the window up
}

# Deleting the install dir can fail transiently while the daemon's log handles are
# being released; retry a few times instead of failing the whole uninstall.
function Remove-DirWithRetry($path, $attempts = 12) {
    for ($i = 0; $i -lt $attempts; $i++) {
        if (-not (Test-Path $path)) { return $true }
        try {
            Remove-Item -Path $path -Recurse -Force -ErrorAction Stop
            if (-not (Test-Path $path)) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

$exitCode = 0
try {
    Log "=== JWautofill daemon uninstall start ==="

    # 1) Stop the running daemon (exact process name only)
    #    NOTE: System.Diagnostics.Process has no Stop() method (that belongs to
    #    ServiceController). Calling $p.Stop() throws "does not contain a method
    #    named 'Stop'" and left the daemon running, which in turn locked
    #    daemon.err.log and made the directory deletion below fail.
    $procs = Get-Process -Name $daemonName -ErrorAction SilentlyContinue
    if ($procs) {
        foreach ($p in $procs) {
            try {
                Log "Stopping process $($p.Id) ($exeName)"
                Stop-Process -Id $p.Id -Force -ErrorAction Stop
                $p.WaitForExit(5000)
            } catch {
                Log "Warn: failed to stop process $($p.Id): $_"
            }
        }
        Start-Sleep -Milliseconds 1200
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
            if (Remove-DirWithRetry $installDir) {
                Log "Removed install dir: $installDir"
            } else {
                Log "ERROR: could not remove install dir (files still locked?): $installDir"
                throw "Failed to remove install dir: $installDir"
            }
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

    # 5) Optional: delete user config hotkeys.json.
    #    Since 2026-08-29 the config lives in the Photoshop PluginData folder
    #    (same place as license/pattern data). The daemon records that path in
    #    configpath.txt, so we can offer to clean it up here as well.
    $candidates = New-Object System.Collections.ArrayList
    $savedPath = $null
    if (Test-Path $configPathStore) {
        try { $savedPath = (Get-Content $configPathStore -Raw).Trim() } catch { $savedPath = $null }
    }
    if (-not [string]::IsNullOrWhiteSpace($savedPath)) { [void]$candidates.Add($savedPath) }
    $legacy = Join-Path $jwRoot "hotkeys.json"
    if (Test-Path $legacy) { [void]$candidates.Add($legacy) }

    foreach ($cfg in $candidates) {
        if ([string]::IsNullOrWhiteSpace($cfg)) { continue }
        if (-not (Test-Path $cfg)) { continue }
        if (Ask-YesNo "Also delete the hotkey config file? [$cfg] [y/N]") {
            Remove-Item -Path $cfg -Force -ErrorAction SilentlyContinue
            Log "Removed config: $cfg"
        } else {
            Log "Kept config: $cfg"
        }
    }

    # 6) Clean remaining leftovers under %LOCALAPPDATA%\JWautofill
    if (Test-Path $jwRoot) {
        Get-ChildItem -Path $jwRoot -Force -ErrorAction SilentlyContinue | ForEach-Object {
            try { Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue } catch { }
        }
        $left = @(Get-ChildItem -Path $jwRoot -Force -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) {
            Remove-Item -Path $jwRoot -Force -ErrorAction SilentlyContinue
            Log "Removed empty leftover dir: $jwRoot"
        } else {
            Log "Leftover dir kept (still contains $($left.Count) item(s)): $jwRoot"
        }
    }

    Log "=== Uninstall finished ==="
    Write-Host ""
    Write-Host "Uninstall complete. Daemon stopped, startup entry removed, install directory deleted."
} catch {
    Log "ERROR: $_"
    Write-Host "ERROR: $_"
    $exitCode = 1
}

# Success -> 5s countdown then auto-close. Failure -> stay open for the user to read.
if ($exitCode -eq 0) {
    Write-Host ""
    for ($i = 5; $i -ge 1; $i--) {
        Write-Host ("`rUninstalled. This window closes in " + $i + " seconds...   ") -NoNewline
        Start-Sleep -Seconds 1
    }
    Write-Host ""
    exit 0
} else {
    Write-Host ""
    Wait-ForUser "Uninstall FAILED. Press Enter to close this window"
    exit 1
}
