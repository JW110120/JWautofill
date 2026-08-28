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
            try { $p.Stop(); $p.WaitForExit(5000) } catch { try { $p.Kill() } catch { } }
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }
    Copy-Item -Path $srcExe -Destination (Join-Path $installDir $exeName) -Force
}

try {
    Log "=== JWautofill daemon install start ==="

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

    # Register autostart (current user, no admin required)
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $cmd = "`"$exePath`" --autostart"
    Set-ItemProperty -Path $runKey -Name "JWautofillHotkeyDaemon" -Value $cmd -Type String
    Log "Added startup entry to HKCU\Run"

    # Launch the daemon (hidden). install.bat is invoked by the panel; the panel also
    # polls for the daemon and will not relaunch if already connected.
    # stdout/stderr are redirected to daemon.log: the daemon is a windowless console
    # app, and its startup/config/error logs are invaluable for diagnosing issues.
    if (-not (Get-Process -Name "JWautofillHotkeyDaemon" -ErrorAction SilentlyContinue)) {
        $daemonLog = Join-Path $installDir "daemon.log"
        Start-Process -FilePath $exePath -ArgumentList "--autostart" -WindowStyle Hidden `
            -RedirectStandardOutput $daemonLog -RedirectStandardError (Join-Path $installDir "daemon.err.log")
        Log "Started daemon (hidden), log: $daemonLog"
    } else {
        Log "Daemon already running."
    }
    Log "Install finished successfully."
} catch {
    Log "ERROR: $_"
    Write-Host "ERROR: $_"
}

Read-Host "Install finished, press Enter to close"
