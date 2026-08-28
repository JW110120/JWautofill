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

try {
    Log "=== JWautofill daemon install start ==="

    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        Log "Created install dir: $installDir"
    }

    $exePath = Join-Path $installDir $exeName

    if (-not (Test-Path $exePath)) {
        Log "exe not found, building via dotnet publish..."
        $src = $PSScriptRoot
        Push-Location $src
        try {
            dotnet publish -c Release -r win-x64 --self-contained -o $publishDir
            if (-not (Test-Path (Join-Path $publishDir $exeName))) {
                throw "dotnet publish failed: exe not produced."
            }
            Copy-Item -Path (Join-Path $publishDir $exeName) -Destination $exePath -Force
            Log "Built and copied exe."
        } finally {
            Pop-Location
        }
    } else {
        Log "exe already exists: $exePath"
    }

    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $cmd = "`"$exePath`" --autostart"
    Set-ItemProperty -Path $runKey -Name "JWautofillHotkeyDaemon" -Value $cmd -Type String
    Log "Added startup entry to HKCU\Run"

    Start-Process -FilePath $exePath -ArgumentList "--autostart" -WindowStyle Hidden
    Log "Started daemon (hidden). Install finished successfully."
} catch {
    Log "ERROR: $_"
    Write-Host "ERROR: $_"
}

Read-Host "Install finished, press Enter to close"
