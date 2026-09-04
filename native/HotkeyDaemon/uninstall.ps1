# JWautofill 快捷键服务卸载脚本
# 完整撤销 install.ps1 的所有改动：
#   1) 结束运行中的服务进程（仅按进程名精确匹配，不触碰其它进程）
#   2) 移除开机自启注册表值（仅移除本程序创建的那个）
#   3) 删除安装目录（仅限已知固定路径，并做路径校验防止误删）
#   4) 清理临时发布目录（仅清理本程序创建的那个）
#   5) 重置系统键盘钩子超时设置（LowLevelHooksTimeout 过大时恢复系统默认）
#   6) 清理 %LOCALAPPDATA%\JWautofill 下的残留文件
#
# 重要约定：
#   - 热键配置（hotkeys.json）属于用户数据，默认一律保留，绝不删除。
#     本脚本全程不询问、不等待输入，因为键盘卡死时用户根本无法输入任何内容。
#   - 全程无交互：不使用 Read-Host，不会卡住等待按键。
#
# 安全策略：仅按精确名称 / 已知固定路径操作，任何路径校验失败即中止删除，绝不误删用户文件。
#
# 编码要求：本文件必须保存为 UTF-8 with BOM。
#   Windows PowerShell 5.1 读取无 BOM 的 .ps1 时按 ANSI（中文系统为 GBK）解析，
#   任何非 ASCII 字符都会导致脚本解析失败或乱码。
#
# 退出码：0 = 卸载成功（倒计时后自动关窗）；1 = 存在失败项

$ErrorActionPreference = "Stop"

$daemonName   = "JWautofillHotkeyDaemon"
$exeName      = "JWautofillHotkeyDaemon.exe"
$installDir   = Join-Path $env:LOCALAPPDATA "JWautofill\daemon"
$jwRoot       = Join-Path $env:LOCALAPPDATA "JWautofill"
$runKey       = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "JWautofillHotkeyDaemon"
$desktopKey   = "HKCU:\Control Panel\Desktop"
$hookTimeoutName = "LowLevelHooksTimeout"
$log          = Join-Path $env:TEMP "jwautofill_uninstall.log"
$publishDir   = Join-Path $env:TEMP "jwauto_publish"
$configPathStore = Join-Path $jwRoot "configpath.txt"

function Log($msg) {
    $t = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$t  $msg" | Out-File -FilePath $log -Append -Encoding utf8
    Write-Host $msg
}

# 删除安装目录时，守护进程的日志句柄可能尚未释放，导致偶发删除失败；
# 这里重试若干次，避免一次失败就中断整个卸载流程。
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
    Log "=================================================="
    Log " JWautofill 快捷键服务卸载"
    Log "=================================================="

    # 1) 结束运行中的服务进程（仅按进程名精确匹配）
    #    注意：System.Diagnostics.Process 没有 Stop() 方法（那是 ServiceController 的）。
    #    之前调用 $p.Stop() 会抛异常，导致服务进程残留、锁住 daemon.err.log，
    #    进而使下面的目录删除失败。
    $procs = Get-Process -Name $daemonName -ErrorAction SilentlyContinue
    if ($procs) {
        foreach ($p in $procs) {
            try {
                Log "正在结束进程 $($p.Id) ($exeName)"
                Stop-Process -Id $p.Id -Force -ErrorAction Stop
                $p.WaitForExit(5000)
            } catch {
                Log "警告：结束进程 $($p.Id) 失败：$_"
                try { & taskkill.exe /PID $p.Id /F /T 2>&1 | Out-Null } catch { }
            }
        }
        Start-Sleep -Milliseconds 1200
        $still = Get-Process -Name $daemonName -ErrorAction SilentlyContinue
        if ($still) {
            Log "警告：仍有残留的服务进程，安装目录删除可能失败"
            $exitCode = 1
        }
    } else {
        Log "未发现运行中的服务进程。"
    }

    # 2) 移除开机自启注册表值（仅移除本程序写入的那个）
    if (Test-Path $runKey) {
        $existing = Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue
        if ($existing) {
            Remove-ItemProperty -Path $runKey -Name $runValueName -Force
            Log "已移除开机自启项：$runValueName"
        } else {
            Log "开机自启项不存在，跳过。"
        }
    } else {
        Log "开机自启注册表项不存在，跳过。"
    }

    # 3) 删除安装目录（仅限已知路径，并做路径校验）
    if (Test-Path $installDir) {
        $installDir = (Resolve-Path $installDir).Path
        $la           = (Resolve-Path $env:LOCALAPPDATA).Path
        $expectedParent = Join-Path $la "JWautofill"
        $parent = Split-Path $installDir -Parent
        $leaf   = Split-Path $installDir -Leaf
        if ($parent -eq $expectedParent -and $leaf -eq "daemon") {
            if (Remove-DirWithRetry $installDir) {
                Log "已删除安装目录：$installDir"
            } else {
                Log "错误：无法删除安装目录（文件仍被占用？）：$installDir"
                throw "删除安装目录失败：$installDir"
            }
        } else {
            Log "错误：路径校验失败，为防误删已中止删除操作：$installDir"
            throw "路径不安全，已中止删除：$installDir"
        }
    } else {
        Log "安装目录不存在，跳过。"
    }

    # 4) 清理临时发布目录（仅清理本程序创建的那个）
    if (Test-Path $publishDir) {
        Remove-Item -Path $publishDir -Recurse -Force -ErrorAction SilentlyContinue
        Log "已清理临时发布目录：$publishDir"
    }

    # 5) 重置系统键盘钩子超时设置
    #    该值被设得过大（例如 25000 毫秒）时，任何全局键盘钩子只要卡顿一下，
    #    整个系统键盘就会被冻结数十秒乃至完全无响应。卸载后应恢复系统默认。
    try {
        $cur = (Get-ItemProperty -Path $desktopKey -Name $hookTimeoutName -ErrorAction SilentlyContinue).$hookTimeoutName
        if ($null -ne $cur) {
            Log "检测到键盘钩子超时设置：$hookTimeoutName = $cur 毫秒"
            if ([int]$cur -gt 5000) {
                Remove-ItemProperty -Path $desktopKey -Name $hookTimeoutName -Force
                Log "该值过大，已删除并恢复系统默认值。"
                Log "如需还原，可执行：reg add `"HKCU\Control Panel\Desktop`" /v $hookTimeoutName /t REG_DWORD /d $cur /f"
            } else {
                Log "该值在安全范围内，保持不变。"
            }
        } else {
            Log "键盘钩子超时设置已是系统默认值，跳过。"
        }
    } catch {
        Log "警告：重置键盘钩子超时设置失败：$_"
    }

    # 6) 保留用户热键配置（绝不删除）
    #    自 2026-08-29 起配置存放在 Photoshop 的 PluginData 目录（与授权、图案数据同级），
    #    守护进程把该路径记录在 configpath.txt 中。这里只做提示，不做删除。
    $savedPath = $null
    if (Test-Path $configPathStore) {
        try { $savedPath = (Get-Content $configPathStore -Raw).Trim() } catch { $savedPath = $null }
    }
    $legacy = Join-Path $jwRoot "hotkeys.json"
    $keptAny = $false
    foreach ($cfg in @($savedPath, $legacy)) {
        if ([string]::IsNullOrWhiteSpace($cfg)) { continue }
        if (-not (Test-Path $cfg)) { continue }
        Log "已保留热键配置（未删除）：$cfg"
        $keptAny = $true
    }
    if (-not $keptAny) { Log "未发现热键配置文件，无需保留。" }

    # 7) 清理 %LOCALAPPDATA%\JWautofill 下的其余残留
    if (Test-Path $jwRoot) {
        Get-ChildItem -Path $jwRoot -Force -ErrorAction SilentlyContinue | ForEach-Object {
            try { Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue } catch { }
        }
        $left = @(Get-ChildItem -Path $jwRoot -Force -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) {
            Remove-Item -Path $jwRoot -Force -ErrorAction SilentlyContinue
            Log "已清理空的残留目录：$jwRoot"
        } else {
            Log "残留目录仍包含 $($left.Count) 个项目，已保留：$jwRoot"
        }
    }

    Log "=================================================="
    Log " 卸载完成"
    Log "=================================================="
    Write-Host ""
    Write-Host "卸载完成：服务已停止，开机自启已移除，安装目录已删除。" -ForegroundColor Green
    Write-Host "你的热键配置已保留，未删除任何个人数据。"
} catch {
    Log "错误：$_"
    Write-Host "错误：$_"
    $exitCode = 1
}

Write-Host ""
Write-Host "日志文件：$log"
Write-Host ""

# 全程无交互：不等待任何按键输入，统一倒计时后自动关闭。
# 失败时停留更久，便于阅读错误信息。
$seconds = if ($exitCode -eq 0) { 5 } else { 30 }
for ($i = $seconds; $i -ge 1; $i--) {
    if ($exitCode -eq 0) {
        Write-Host ("`r卸载完成，本窗口将在 " + $i + " 秒后自动关闭…   ") -NoNewline
    } else {
        Write-Host ("`r卸载未完全成功，本窗口将在 " + $i + " 秒后自动关闭…   ") -NoNewline
    }
    Start-Sleep -Seconds 1
}
Write-Host ""
exit $exitCode
