# IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as ANSI (GBK on Chinese Windows), so any non-ASCII byte corrupts parsing.
$ErrorActionPreference = "Stop"
$exeName = "JWautofillHotkeyDaemon.exe"
$installDir = Join-Path $env:LOCALAPPDATA "JWautofill\daemon"
$log = Join-Path $env:TEMP "jwautofill_install.log"
$publishDir = Join-Path $env:TEMP "jwauto_publish"

function Log($msg) {
    $t = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$t  $msg" | Out-File -FilePath $log -Append -Encoding utf8
    Write-Host $msg
}

function CopyExe($srcExe) {
    # Stop a running daemon first: the exe file would be locked while running,
    # and a leftover old process would keep serving stale code after the copy.
    $running = Get-Process -Name "JWautofillHotkeyDaemon" -ErrorAction SilentlyContinue
    if ($running) {
        Log "Stopping running daemon before exe update..."
        foreach ($p in $running) {
            # NOTE: System.Diagnostics.Process has no Stop() method (that belongs to
            # ServiceController). Calling $p.Stop() throws "does not contain a method
            # named 'Stop'" and silently left the daemon running, which then locked
            # the exe/log files. Always use Stop-Process instead.
            try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
        }
        Start-Sleep -Milliseconds 800
    }
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }
    Copy-Item -Path $srcExe -Destination (Join-Path $installDir $exeName) -Force
}

# Start-Process throws "An item with the same key has already been added. Key: Path"
# on machines where the environment contains both "Path" and "PATH" keys, so try a
# couple of progressively simpler launch methods before giving up.
function Start-Daemon($exePath) {
    $daemonLog = Join-Path $installDir "daemon.log"
    $daemonErr = Join-Path $installDir "daemon.err.log"
    try {
        Start-Process -FilePath $exePath -ArgumentList "--autostart" -WindowStyle Hidden `
            -RedirectStandardOutput $daemonLog -RedirectStandardError $daemonErr -ErrorAction Stop
        return "Started daemon (hidden), log: $daemonLog"
    } catch {
        Log "Warn: Start-Process with log redirection failed: $_"
    }
    try {
        Start-Process -FilePath $exePath -ArgumentList "--autostart" -WindowStyle Hidden -ErrorAction Stop
        return "Started daemon (hidden), logging disabled."
    } catch {
        Log "Warn: Start-Process failed: $_"
    }
    & cmd /c start "" /b "`"$exePath`"" --autostart
    return "Started daemon via cmd /c start."
}

try {
    Log "=== JWautofill daemon install start ==="
    $exitCode = 0

    $exePath = Join-Path $installDir $exeName
    $prebuilt = Join-Path $PSScriptRoot "publish\$exeName"

    # Always sync the installed exe with the bundled prebuilt exe when they differ.
    # (Version skew between the installed copy and the one shipped with the plugin
    #  has caused hard-to-diagnose "old daemon" bugs twice; comparing hashes makes
    #  every install click a guaranteed update.)
    if (Test-Path $prebuilt) {
        $needCopy = $true
        if (Test-Path $exePath) {
            try {
                $h1 = (Get-FileHash $exePath -Algorithm MD5).Hash
                $h2 = (Get-FileHash $prebuilt -Algorithm MD5).Hash
                $needCopy = ($h1 -ne $h2)
            } catch { $needCopy = $true }
        }
        if ($needCopy) {
            Log "Using prebuilt exe: $prebuilt" 
            CopyExe $prebuilt
            Log "Copied/updated prebuilt exe."
        } else {
            Log "exe already up to date: $exePath"
        }
    } elseif (-not (Test-Path $exePath)) {
        # No prebuilt exe and nothing installed: try building locally if the .NET SDK exists.
        $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
        if ($dotnet) {
            Log "Prebuilt exe missing; building via dotnet publish..."
            if (-not (Test-Path $publishDir)) { New-Item -ItemType Directory -Path $publishDir -Force | Out-Null }
            Push-Location $PSScriptRoot
            try {
                & $dotnet.FullName publish -c Release -r win-x64 --self-contained -o $publishDir
                if (-not (Test-Path (Join-Path $publishDir $exeName))) {
                    throw "dotnet publish failed: exe not produced."
                }
            } finally {
                Pop-Location
            }
            CopyExe (Join-Path $publishDir $exeName)
            Log "Built and copied exe."
        } else {
            throw "No prebuilt exe found and .NET SDK is not installed. Please run the plugin's build step to produce native/HotkeyDaemon/publish/$exeName, or install the .NET 8 SDK."
        }
    } else {
        Log "exe already installed (no prebuilt copy present, kept existing): $exePath"
    }

    # Register autostart (current user, no admin required).
    # IMPORTANT: launch HIDDEN. The daemon is a console-subsystem exe, so running
    # it directly from HKCU\Run shows a black cmd window on every boot (which the
    # user might mistake for malware). Wrapping it in a PowerShell -WindowStyle
    # Hidden call keeps boot fully silent: no visible window at all.
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $startArg = "Start-Process -FilePath '$exePath' -ArgumentList '--autostart' -WindowStyle Hidden"
    $cmd = "powershell.exe -WindowStyle Hidden -Command `"$startArg`""
    Set-ItemProperty -Path $runKey -Name "JWautofillHotkeyDaemon" -Value $cmd -Type String
    Log "Added (hidden) startup entry to HKCU\Run"

    # Launch the daemon (hidden). install.bat is invoked by the panel; the panel also
    # polls for the daemon and will not relaunch if already connected.
    # stdout/stderr are redirected to daemon.log: the daemon is a windowless console
    # app, and its startup/config/error logs are invaluable for diagnosing issues.
    if (-not (Get-Process -Name "JWautofillHotkeyDaemon" -ErrorAction SilentlyContinue)) {
        Log (Start-Daemon $exePath)
    } else {
        Log "Daemon already running."
    }
    Log "Install finished successfully."
    Write-Host ""
    Write-Host "Daemon is ready."
} catch {
    Log "ERROR: $_"
    Write-Host "ERROR: $_"
    $exitCode = 1
}

# IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as ANSI (GBK on Chinese Windows), so any non-ASCII byte corrupts parsing.
#
# Success  -> 3s countdown, then the window closes by itself (feels like the
#             daemon was already there; the user does nothing).
# Failure  -> the window stays open so the user can read the error.
if ($exitCode -eq 0) {
    Write-Host ""
    for ($i = 3; $i -ge 1; $i--) {
        Write-Host ("`rLoaded. This window closes in " + $i + " seconds...   ") -NoNewline
        Start-Sleep -Seconds 1
    }
    Write-Host ""
    exit 0
} else {
    Write-Host ""
    Read-Host "Install FAILED. Press Enter to close this window"
    exit 1
}
