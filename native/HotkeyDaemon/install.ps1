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
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }
    Copy-Item -Path $srcExe -Destination (Join-Path $installDir $exeName) -Force
}

try {
    Log "=== JWautofill daemon install start ==="

    $exePath = Join-Path $installDir $exeName
    $prebuilt = Join-Path $PSScriptRoot "publish\$exeName"

    if (Test-Path $exePath) {
        Log "exe already installed: $exePath"
    } else {
        # 1) Prefer the prebuilt self-contained exe shipped with the plugin.
        #    It runs on any Windows machine with zero prerequisites (no .NET SDK/runtime needed).
        if (Test-Path $prebuilt) {
            Log "Using prebuilt exe: $prebuilt"
            CopyExe $prebuilt
            Log "Copied prebuilt exe."
        } else {
            # 2) Fallback: build it locally if the .NET SDK is available (developer machines).
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
        }
    }

    # Register autostart (current user, no admin required)
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $cmd = "`"$exePath`" --autostart"
    Set-ItemProperty -Path $runKey -Name "JWautofillHotkeyDaemon" -Value $cmd -Type String
    Log "Added startup entry to HKCU\Run"

    # Launch the daemon (hidden). install.bat is invoked by the panel; the panel also
    # polls for the daemon and will not relaunch if already connected.
    if (-not (Get-Process -Name "JWautofillHotkeyDaemon" -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $exePath -ArgumentList "--autostart" -WindowStyle Hidden
        Log "Started daemon (hidden)."
    } else {
        Log "Daemon already running."
    }
    Log "Install finished successfully."
} catch {
    Log "ERROR: $_"
    Write-Host "ERROR: $_"
}

Read-Host "Install finished, press Enter to close"
