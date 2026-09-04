# JWautofill 键盘一键修复脚本
# 用途：当系统键盘「打不出字」（通常是某个全局低层键盘钩子卡住）时，一键解除。
#
# 本脚本依次执行：
#   1) 结束 JWautofill 快捷键服务进程（释放它安装的全局键盘钩子）
#   2) 移除开机自启项（避免重启后再次拉起钩子）
#   3) 重置 LowLevelHooksTimeout 到系统默认
#      —— 这是「键盘彻底卡死」的头号放大器：该值被设得过大（如 25000 毫秒）时，
#         任何全局键盘钩子只要卡一下，整个系统的键盘就会被冻结几十秒乃至永久无响应。
#         恢复系统默认后，钩子卡住最多造成一次极短延迟，随后会被系统自动摘除。
#   4) 释放可能卡住的修饰键（Ctrl/Alt/Shift/Win 各发送一次抬起事件）
#   5) 重启输入法程序 ctfmon（仅处理输入法假死，失败不影响）
#
# 设计约束：
#   - 全程无交互：绝不出现 Read-Host 等待输入（键盘卡死时用户根本无法输入）
#   - 不删除任何用户数据：热键配置、安装目录一律保留，修复后可继续正常使用
#   - 每一步独立容错：单步失败只记录，不影响后续步骤
#
# 编码要求：本文件必须保存为 UTF-8 with BOM。
#   Windows PowerShell 5.1 读取无 BOM 的 .ps1 时按 ANSI（中文系统为 GBK）解析，
#   任何非 ASCII 字符都会导致脚本解析失败或乱码。
#
# 退出码：0 = 修复完成；1 = 严重失败

$ErrorActionPreference = "Continue"

$daemonName   = "JWautofillHotkeyDaemon"
$runKey       = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "JWautofillHotkeyDaemon"
$desktopKey   = "HKCU:\Control Panel\Desktop"
$hookTimeoutName = "LowLevelHooksTimeout"
$log          = Join-Path $env:TEMP "jwautofill_fixkeyboard.log"

function Log($msg) {
    $t = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try { "$t  $msg" | Out-File -FilePath $log -Append -Encoding utf8 } catch { }
    Write-Host $msg
}

# 记录本次修复前的原始值，便于用户还原
$oldHookTimeout = $null
$exitCode = 0
$daemonWasRunning = $false

Log "=================================================="
Log " JWautofill 键盘一键修复"
Log "=================================================="
Write-Host ""

# ---------- 1) 结束守护进程，释放全局键盘钩子 ----------
Log "[1/5] 正在结束快捷键服务进程…"
try {
    $procs = Get-Process -Name $daemonName -ErrorAction SilentlyContinue
    if ($procs) {
        $daemonWasRunning = $true
        foreach ($p in $procs) {
            try {
                Log "      结束进程 pid=$($p.Id)"
                Stop-Process -Id $p.Id -Force -ErrorAction Stop
            } catch {
                Log "      警告：进程 pid=$($p.Id) 结束失败，尝试命令行强杀"
                try { & taskkill.exe /PID $p.Id /F /T 2>&1 | Out-Null } catch { }
            }
        }
        Start-Sleep -Milliseconds 800
        $still = Get-Process -Name $daemonName -ErrorAction SilentlyContinue
        if ($still) {
            Log "      仍有残留进程，钩子可能未完全释放"
            $exitCode = 1
        } else {
            Log "      已完成：快捷键服务已停止，全局键盘钩子已释放"
        }
    } else {
        Log "      未发现运行中的快捷键服务（跳过）"
    }
} catch {
    Log "      结束进程时出错：$_"
}

# ---------- 2) 移除开机自启 ----------
Log "[2/5] 正在移除开机自启项…"
try {
    if (Test-Path $runKey) {
        $existing = Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue
        if ($existing) {
            Remove-ItemProperty -Path $runKey -Name $runValueName -Force
            Log "      已移除开机自启项：$runValueName"
        } else {
            Log "      开机自启项本就不存在（跳过）"
        }
    } else {
        Log "      注册表项不存在（跳过）"
    }
} catch {
    Log "      移除开机自启项失败：$_"
}

# ---------- 3) 重置 LowLevelHooksTimeout ----------
Log "[3/5] 正在重置系统键盘钩子超时设置…"
try {
    $cur = (Get-ItemProperty -Path $desktopKey -Name $hookTimeoutName -ErrorAction SilentlyContinue).$hookTimeoutName
    if ($null -ne $cur) {
        $oldHookTimeout = $cur
        Log "      发现自定义值：$hookTimeoutName = $cur 毫秒"
        # 超过 5000 毫秒即视为危险值：钩子一旦卡顿，全系统键盘会被冻结数秒到数十秒
        if ([int]$cur -gt 5000) {
            Remove-ItemProperty -Path $desktopKey -Name $hookTimeoutName -Force
            Log "      该值过大，已删除并恢复系统默认值（危险值已清除）"
            Log "      如需还原，可执行："
            Log "      reg add `"HKCU\Control Panel\Desktop`" /v $hookTimeoutName /t REG_DWORD /d $cur /f"
        } else {
            Log "      该值在安全范围内，保持不变"
        }
    } else {
        Log "      已是系统默认值（跳过）"
    }
} catch {
    Log "      重置键盘钩子超时设置失败：$_"
}

# ---------- 4) 释放可能卡住的修饰键 ----------
Log "[4/5] 正在释放可能卡住的修饰键…"
try {
    $memberDef = @'
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
    $helper = Add-Type -MemberDefinition $memberDef -Name "JwKeyHelper" -Namespace "JWautofill" -PassThru -ErrorAction Stop
    # 0x0002 = KEYEVENTF_KEYUP。对每个修饰键都补发一次「抬起」，
    # 若此前因为钩子吞键导致系统认为按键仍处于按下状态，可在此解除。
    $keys = @(
        @{ v = 0xA2; n = "左Ctrl" },  @{ v = 0xA3; n = "右Ctrl" },
        @{ v = 0xA4; n = "左Alt" },   @{ v = 0xA5; n = "右Alt" },
        @{ v = 0xA0; n = "左Shift" }, @{ v = 0xA1; n = "右Shift" },
        @{ v = 0x5B; n = "左Win" },   @{ v = 0x5C; n = "右Win" }
    )
    foreach ($k in $keys) {
        try { $helper::keybd_event([byte]$k.v, 0, 0x0002, [System.UIntPtr]::Zero) } catch { }
    }
    Log "      已为 Ctrl / Alt / Shift / Win 补发抬起事件"
} catch {
    Log "      释放修饰键失败（不影响整体修复）：$_"
}

# ---------- 5) 重启输入法程序 ----------
Log "[5/5] 正在重启输入法程序（ctfmon）…"
try {
    $ctf = Get-Process -Name "ctfmon" -ErrorAction SilentlyContinue
    if ($ctf) {
        foreach ($c in $ctf) {
            try { Stop-Process -Id $c.Id -Force -ErrorAction Stop } catch { }
        }
        Start-Sleep -Milliseconds 300
    }
    $ctfPath = Join-Path $env:SystemRoot "System32\ctfmon.exe"
    if (Test-Path $ctfPath) {
        Start-Process -FilePath $ctfPath -ErrorAction Stop | Out-Null
        Log "      输入法程序已重启"
    } else {
        # 中文系统部分版本位于 SysWOW64，或由系统按需拉起
        $ctfPath2 = Join-Path $env:SystemRoot "SysWOW64\ctfmon.exe"
        if (Test-Path $ctfPath2) {
            Start-Process -FilePath $ctfPath2 -ErrorAction Stop | Out-Null
            Log "      输入法程序已重启"
        } else {
            Log "      未找到 ctfmon.exe（跳过，系统可能在下次输入时自动拉起）"
        }
    }
} catch {
    Log "      重启输入法程序失败（不影响整体修复）：$_"
}

# ---------- 结果汇总 ----------
Write-Host ""
Log "=================================================="
if ($exitCode -eq 0) {
    Log " 修复完成"
} else {
    Log " 修复完成，但有部分步骤未成功（详见上方日志）"
}
Log "=================================================="
Write-Host ""
Write-Host "修复已完成，请立即测试键盘是否恢复正常。" -ForegroundColor Green
Write-Host ""
Write-Host "说明：" -ForegroundColor Yellow
Write-Host "  · 快捷键服务已停止，开机自启已移除；键盘不会再被本插件的钩子影响。"
Write-Host "  · 你的热键配置与程序文件均已保留，未删除任何数据。"
Write-Host "  · 如需重新使用快捷键，在面板里重新启动快捷键服务即可。"
if ($null -ne $oldHookTimeout) {
    Write-Host "  · 本次检测到键盘钩子超时设置原为 $oldHookTimeout 毫秒，已按上述规则处理。"
}
Write-Host ""
Write-Host "日志文件：$log"
Write-Host ""

for ($i = 8; $i -ge 1; $i--) {
    Write-Host ("`r本窗口将在 " + $i + " 秒后自动关闭…   ") -NoNewline
    Start-Sleep -Seconds 1
}
Write-Host ""
exit $exitCode
