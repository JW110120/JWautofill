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
#   6) 软重置键盘设备（程序化重新插拔）：
#      —— 真实案例证明还存在第二类冻结：HID/USB 设备层（中断管道卡死、USB 省电唤醒失败）。
#         症状是全局钩子全部释放后键盘仍打不出字，只有重新插拔键盘才能恢复
#         （重插 = 重新枚举设备 = 复位设备状态，不经过钩子层）。
#         本步用 pnputil 重启键盘设备节点及其 HID/USB 祖先链，程序化复现重插效果。
#      —— 2026-09-07 新观察：该层还有第三种表现——「按下某键后它不停重复，重插才恢复」。
#         键盘的 key-up 报文在 USB 挂起/唤醒窗口丢失，HID 层把该键卡在「按下」状态，
#         系统持续收到自动重复；重插复位设备即恢复，仍属设备层，与本步修法相同。
#         应急自救：不拔线，把同一个键再按一次（补一对按下/抬起报文，通常即可覆盖卡住的状态）。
#   7) 关闭 USB 省电策略（HID 设备「允许计算机关闭此设备」+ 电源计划「USB 选择性挂起」），
#      根治第 6 步那类冻结的复发诱因。
#
# 权限说明：第 6/7 步需要管理员权限，脚本开头会自动弹 UAC 自提权（UAC 弹窗用鼠标点击，
# 不依赖键盘）；用户拒绝授权时仅跳过第 6/7 步，前 5 步照常执行。
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

param([switch]$JwElevated)

$ErrorActionPreference = "Continue"

$daemonName   = "JWautofillHotkeyDaemon"
$runKey       = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "JWautofillHotkeyDaemon"
$desktopKey   = "HKCU:\Control Panel\Desktop"
$hookTimeoutName = "LowLevelHooksTimeout"
$log          = Join-Path $env:TEMP "jwautofill_fixkeyboard.log"

# ---------- 0) 管理员自提权 ----------
# 第 6/7 步（设备软重置、USB 省电策略）需要管理员权限。缺权限时自动弹 UAC
# 重新以管理员身份运行本脚本（UAC 弹窗用鼠标点击即可，不依赖键盘）。
# JwElevated 开关防止 UAC 被拒后无限循环重弹。
$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
if (-not $isAdmin -and -not $JwElevated) {
    Write-Host "正在请求管理员权限（用于重置键盘设备与修改 USB 省电策略）…" -ForegroundColor Yellow
    Write-Host "请在弹出的授权窗口中点击「是」。" -ForegroundColor Yellow
    try {
        Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @("-ExecutionPolicy", "Bypass", "-NoProfile", "-File", "`"$PSCommandPath`"", "-JwElevated")
        exit 0
    } catch {
        Write-Host "未获得管理员授权，将只执行无需权限的基础修复步骤。" -ForegroundColor Yellow
        Write-Host ""
    }
}

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
Log "[1/7] 正在结束快捷键服务进程…"
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
Log "[2/7] 正在移除开机自启项…"
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
Log "[3/7] 正在重置系统键盘钩子超时设置…"
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
Log "[4/7] 正在释放可能卡住的修饰键…"
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
Log "[5/7] 正在重启输入法程序（ctfmon）…"
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

# ---------- 6) 软重置键盘设备（程序化重新插拔） ----------
# 真实案例：键盘冻结发生在 HID/USB 设备层（中断管道卡死、USB 省电唤醒失败），
# 此时全局钩子早已释放、软件层一切正常，杀进程/重启输入法均无效，
# 只有「重新插拔键盘」能恢复。本步用 PnP API 复现重插效果，无需用户动手拔线。
Log "[6/7] 正在软重置键盘设备（程序化重新插拔）…"
if (-not $isAdmin) {
    Log "      无管理员权限，已跳过本步（设备层冻结将无法修复，请手动重新插拔键盘）"
} else {
    try {
        $kbds = @(Get-PnpDevice -Class Keyboard -ErrorAction Stop | Where-Object { $_.Present })
        if ($kbds.Count -eq 0) {
            Log "      未发现已连接的键盘设备（跳过）"
        } else {
            $done = @{}
            foreach ($kbd in $kbds) {
                # 从键盘设备节点向上收集 HID/USB 祖先链（顶层在前），跳过根集线器：
                # 重启父设备会连带重启子设备，比只重启键盘节点更接近真实重插效果
                $chain = @()
                $cur = $kbd.InstanceId
                for ($i = 0; $i -lt 3; $i++) {
                    try {
                        $p = (Get-PnpDeviceProperty -InstanceId $cur -KeyName "DEVPKEY_Device_Parent" -ErrorAction Stop).Data
                    } catch { break }
                    if ([string]::IsNullOrEmpty($p)) { break }
                    if ($p -notmatch "^(HID|USB)\\" -or $p -match "ROOT_HUB") { break }
                    $chain = @($p) + $chain
                    $cur = $p
                }
                foreach ($target in (@($chain) + @($kbd.InstanceId))) {
                    if ($done.ContainsKey($target)) { continue }
                    $done[$target] = $true
                    # 首选 pnputil /restart-device：单命令原子重启（Win10 2004+），无停用间隙
                    $okRestart = $false
                    try {
                        & pnputil.exe /restart-device "$target" 2>&1 | Out-Null
                        if ($LASTEXITCODE -eq 0) { $okRestart = $true }
                    } catch { }
                    if (-not $okRestart) {
                        # 旧系统退回 Disable→Enable；finally 保证即使中途出错也会重新启用
                        try {
                            Disable-PnpDevice -InstanceId $target -Confirm:$false -ErrorAction Stop | Out-Null
                            try { Start-Sleep -Milliseconds 300 } catch { }
                        } finally {
                            try { Enable-PnpDevice -InstanceId $target -Confirm:$false -ErrorAction Stop | Out-Null } catch { }
                        }
                    }
                }
                Log "      已重启设备链：$($kbd.FriendlyName)"
            }
            Log "      已完成 $($done.Count) 个设备节点的软重置（等价于重新插拔键盘）"
        }
    } catch {
        Log "      软重置键盘设备失败：$_"
    }
    # 兜底：确保没有任何键盘设备停留在「已禁用」状态
    try {
        Get-PnpDevice -Class Keyboard -ErrorAction SilentlyContinue |
            Where-Object { $_.Status -eq "Error" } |
            ForEach-Object { try { Enable-PnpDevice -InstanceId $_.InstanceId -Confirm:$false -ErrorAction Stop | Out-Null } catch { } }
    } catch { }
}

# ---------- 7) 关闭 USB 省电策略（防止设备层冻结复发） ----------
# 「重插键盘才恢复」型冻结的典型诱因：USB 选择性挂起后设备唤醒失败。
Log "[7/7] 正在关闭 USB 省电策略（防止复发）…"
if (-not $isAdmin) {
    Log "      无管理员权限，已跳过本步"
} else {
    # 7a) 设备级：HID 设备与 USB 根集线器的「允许计算机关闭此设备以节约电源」
    #     优先走 WMI（MSPower_DeviceEnable）；部分系统该类返回 0 个实例
    #     （Win11 25H2 实测如此），此时退回注册表全局开关 DisableSelectiveSuspend。
    try {
        $cnt = 0
        $powerDevs = @(Get-CimInstance -Namespace root\wmi -ClassName MSPower_DeviceEnable -ErrorAction SilentlyContinue |
            Where-Object { $_.InstanceName -match "^HID\\" -or $_.InstanceName -match "^USB\\ROOT_HUB" })
        foreach ($d in $powerDevs) {
            try {
                if ($d.Enable) {
                    $d.Enable = $false
                    Set-CimInstance -InputObject $d -ErrorAction Stop
                    $cnt++
                }
            } catch { }
        }
        if ($powerDevs.Count -gt 0) {
            Log "      已为 $cnt 个 HID/USB 根集线器设备关闭「允许计算机关闭此设备以节约电源」"
        } else {
            $usbSrv = "HKLM:\SYSTEM\CurrentControlSet\Services\USB"
            if (-not (Test-Path $usbSrv)) { New-Item -Path $usbSrv -Force -ErrorAction Stop | Out-Null }
            New-ItemProperty -Path $usbSrv -Name "DisableSelectiveSuspend" -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
            Log "      本机无逐设备省电开关（WMI 返回空），已在注册表全局禁用 USB 选择性挂起"
            Log "      （DisableSelectiveSuspend=1，重启电脑后完全生效）"
        }
    } catch {
        Log "      设备级省电设置失败：$_"
    }
    # 7b) 电源计划级：USB 选择性挂起 → 已禁用（交流/电池均生效，立即生效无需重启）
    try {
        & powercfg.exe /SETACVALUEINDEX SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebbaa308ab 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "SETACVALUEINDEX 退出码 $LASTEXITCODE" }
        & powercfg.exe /SETDCVALUEINDEX SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebbaa308ab 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "SETDCVALUEINDEX 退出码 $LASTEXITCODE" }
        & powercfg.exe /SETACTIVE SCHEME_CURRENT | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "SETACTIVE 退出码 $LASTEXITCODE" }
        Log "      已在电源计划中禁用「USB 选择性挂起」"
    } catch {
        Log "      禁用 USB 选择性挂起失败：$_"
    }
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
Write-Host "  · 已尝试软重置键盘设备（程序化重新插拔）并关闭 USB 省电策略。"
Write-Host "  · 若此前症状是「某个键按下后不停重复」，同样由第 6 步解除（键被卡在按下态）。"
Write-Host "  · 你的热键配置与程序文件均已保留，未删除任何数据。"
Write-Host "  · 如需重新使用快捷键，在面板里重新启动快捷键服务即可。"
Write-Host "  · 若完成本修复后仍无法输入，多为键盘硬件或 USB 接口层问题，请更换接口/键盘测试。"
if ($null -ne $oldHookTimeout) {
    Write-Host "  · 本次检测到键盘钩子超时设置原为 $oldHookTimeout 毫秒，已按上述规则处理。"
}
Write-Host ""
Write-Host "日志文件：$log"
Write-Host ""

for ($i = 15; $i -ge 1; $i--) {
    Write-Host ("`r本窗口将在 " + $i + " 秒后自动关闭…   ") -NoNewline
    Start-Sleep -Seconds 1
}
Write-Host ""
exit $exitCode
