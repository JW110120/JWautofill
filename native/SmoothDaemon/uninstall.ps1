# JWautofill 套索平滑服务卸载脚本
# 完整撤销 install.ps1 的所有改动：
#   1) 结束运行中的服务进程（仅按进程名精确匹配，不触碰其它进程）
#   2) 移除开机自启注册表值（仅移除本程序创建的那个）
#   3) 删除安装目录（仅限已知固定路径，并做路径校验防止误删）
#   4) 清理临时发布目录（仅清理本程序创建的那个）
#   5) 重置系统键盘钩子超时设置（LowLevelHooksTimeout 过大时恢复系统默认）
#   6) 清理 %LOCALAPPDATA%\JWautofill 下的残留文件
#
# 重要约定：
#   - 平滑服务不持有任何用户数据（参数存在 PS 的 PluginData 里，不在此目录），
#     因此没有任何需要保留的文件，也无需向用户介绍任何「已保留」信息。
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

$daemonName   = "JWautofillSmoothDaemon"
$exeName      = "JWautofillSmoothDaemon.exe"
$installDir   = Join-Path $env:LOCALAPPDATA "JWautofill\smooth"
$jwRoot       = Join-Path $env:LOCALAPPDATA "JWautofill"
$runKey       = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "JWautofillSmoothDaemon"
$desktopKey   = "HKCU:\Control Panel\Desktop"
$hookTimeoutName = "LowLevelHooksTimeout"
$log          = Join-Path $env:TEMP "jwautofill_smooth_uninstall.log"
$publishDir   = Join-Path $env:TEMP "jwauto_publish"

function Log($msg) {
    $t = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$t  $msg" | Out-File -FilePath $log -Append -Encoding utf8
    Write-Host $msg
}

# 删除安装目录时，守护进程的日志句柄可能尚未释放，导致偶发删除失败；
# 这里重试若干次，避免一次失败就中断整个卸载流程。
# ⚠️ 重试次数 × 等待时长 = 最长阻塞时间，别调太大（原来 12×800ms ≈ 9.6s 的静默等待，
#    用户会以为脚本卡死了）。4 秒足够覆盖「刚被杀的进程释放句柄」这种瞬时占用；
#    真正的长期占用（Photoshop 加载着注入的 DLL）等再久也没用，应当直接报原因。
function Remove-DirWithRetry($path, $attempts = 8) {
    for ($i = 0; $i -lt $attempts; $i++) {
        if (-not (Test-Path $path)) { return $true }
        try {
            Remove-Item -Path $path -Recurse -Force -ErrorAction Stop
            if (-not (Test-Path $path)) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# 删除失败时给出**确切原因**。
#   安装目录里只剩 exe 与日志（hook DLL 已挪到 %TEMP%\JWautofill\hooks），所以删不掉
#   几乎只有两种可能：① 某个守护进程实例还活着（占着 exe/日志）；② 升级前留下的
#   hook DLL 还在目录里、且正被 **Photoshop** 加载 —— 被加载的文件会把**整个目录**锁住。
function Explain-DeleteFailure($path) {
    $left = @(Get-ChildItem -Path $path -Force -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
        Log ("仍残留 " + $left.Count + " 个项目：" + (($left | ForEach-Object { $_.Name }) -join ", "))
        $hook = @($left | Where-Object { $_.Name -like "JWautofillWintabHook*.dll" })
        if ($hook.Count -gt 0) {
            Log "残留的是注入用的 hook DLL：它被 Photoshop 加载中，文件所在【目录】因此无法删除。"
            Log "处置：关闭 Photoshop 后再点一次「卸载套索平滑服务」，即可删干净。"
        }
    }
    $ps = Get-Process -Name "Photoshop" -ErrorAction SilentlyContinue
    if ($ps) { Log "（检测到 Photoshop 正在运行：PID " + (($ps | ForEach-Object { $_.Id }) -join ",") + "）" }
    $rp = Get-Process -Name $daemonName -ErrorAction SilentlyContinue
    if ($rp) { Log "（检测到服务进程仍在运行：PID " + (($rp | ForEach-Object { $_.Id }) -join ",") + "）" }
}

$exitCode = 0
try {
    Log "=================================================="
    Log " JWautofill 套索平滑服务卸载"
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
        if ($parent -eq $expectedParent -and $leaf -eq "smooth") {
            if (Remove-DirWithRetry $installDir) {
                Log "已删除安装目录：$installDir"
            } else {
                # ⛔ 这里**不 throw**：throw 会跳到 catch，把后面「清理残留 / 重置钩子超时」
                #    全部跳过 —— 实测就是这样留下半拉子状态的（日志里最后两行只有错误）。
                #    删除失败只是**一项**失败，其余清理该照做。
                Log "错误：无法删除安装目录（文件仍被占用？）：$installDir"
                Explain-DeleteFailure $installDir
                $exitCode = 1
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

    # 6) 目录回收（**只回收空目录，绝不删内容**）
    #   ⛔⛔ 2026-10-13 修复：这里原来是 Get-ChildItem | Remove-Item -Recurse -Force，
    #      它会把 %LOCALAPPDATA%\JWautofill 下的**所有东西**删掉，包括：
    #        · configpath.txt —— 「用户热键配置存在哪」的唯一指针。删掉它，热键守护进程
    #          下次启动就会回落到默认路径、读到空配置 ⇒ 面板以为「首次使用」、
    #          回写默认条目，把用户的笔刷热键整份冲掉（用户报的「关掉 PS 重载后热键全没了」）。
    #        · 另一个角色的安装目录（daemon\ / smooth\ 互为兄弟），
    #          与「两个服务必须互不影响」的承诺直接冲突。
    #      ⇒ 自己的安装目录已由上面第 3 步精确删除，这里只做空目录回收。
    if (Test-Path $jwRoot) {
        $left = @(Get-ChildItem -Path $jwRoot -Force -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) {
            Remove-Item -Path $jwRoot -Force -ErrorAction SilentlyContinue
            Log "已清理空的残留目录：$jwRoot"
        } else {
            Log "保留 $($left.Count) 个项目（配置指针 / 另一服务的安装目录，均不属于本服务）：$jwRoot"
        }
    }

    Log "=================================================="
    Log " 卸载完成"
    Log "=================================================="
    Write-Host ""
    Write-Host "卸载完成：服务已停止，开机自启已移除，安装目录已删除。" -ForegroundColor Green
} catch {
    Log "错误：$_"
    Write-Host "错误：$_"
    $exitCode = 1
}

Write-Host ""
Write-Host "日志文件：$log"
Write-Host ""

# 全程无交互：不等待任何按键输入，统一倒计时后自动关闭。
# ⛔ 倒计时是**唯一的**收尾机制（.bat 里的 `pause` 已删除）：卸载失败时
#    `if errorlevel 1 pause` 会让窗口永远停在「请按任意键继续」——
#    用户报的「倒计时到 0 了也无法自动关闭」就是它。
# ⚠️ 成功 5s / 失败 15s，与快捷键服务卸载脚本**逐字一致**（两边表现必须相同）。
$seconds = if ($exitCode -eq 0) { 5 } else { 15 }
for ($i = $seconds; $i -ge 1; $i--) {
    if ($exitCode -eq 0) {
        Write-Host ("`r卸载完成，本窗口将在 " + $i + " 秒后自动关闭…   ") -NoNewline
    } else {
        Write-Host ("`r卸载未完全成功（详见上面的错误与日志），本窗口将在 " + $i + " 秒后自动关闭…   ") -NoNewline
    }
    Start-Sleep -Seconds 1
}
Write-Host ""
exit $exitCode
