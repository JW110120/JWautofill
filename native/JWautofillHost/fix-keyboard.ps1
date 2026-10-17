# JWautofill 键盘一键修复脚本（设备层）
# 用途：当系统键盘「打不出字 / 某个键按下后不停重复」时，一键程序化重插键盘
#       并关闭 USB 省电策略。
#
# ⛔⛔ 2026-10-17 起本脚本**只保留设备层两步**（原第 1~5 步全部删除）。理由：
#   · 原第 1/2 步（结束快捷键服务进程 / 移除开机自启项）针对的
#     JWautofillHotkeyDaemon 常驻进程已随 M3/M4 退役 —— 快捷键改由 Photoshop
#     进程内的 JWautofillHost.8li 承载，没有可杀的常驻进程；自启项清理也由
#     .8li 启动时的旧 daemon 迁移自动完成。留着只会打出「已停止」的假日志。
#   · 原第 3/4/5 步（复位 LowLevelHooksTimeout / 释放修饰键 / 重启 ctfmon）
#     已由 .8li 在唤起本脚本**之前**于进程内无权限完成（keyhook.c 的
#     kh_do_repair，规则相同且幂等）—— 在这里重复一遍只会把两份日志搅浑。
#   · 原第 4 步的 Add-Type（keybd_event P/Invoke）在本机被安全策略拦截
#     （"compiles and loads .NET code at runtime"），从来就没执行成功过。
#
# 本脚本依次执行：
#   1) 软重置键盘设备（程序化重新插拔）：用 pnputil 重启键盘设备节点及其
#      HID/USB 祖先链，复现重插效果，无需用户动手拔线。
#      —— 真实案例：全局钩子全部释放后键盘仍打不出字，只有重新插拔才能恢复
#         （HID/USB 中断管道卡死、USB 省电唤醒失败），与本插件钩子无因果。
#      —— 2026-09-07 观察到的第三种表现「按下某键后不停重复」同样由本步解除：
#         key-up 报文在 USB 挂起/唤醒窗口丢失，HID 层把该键卡在「按下」状态。
#   2) 关闭 USB 省电策略（HID 设备「允许计算机关闭此设备」+ 电源计划
#      「USB 选择性挂起」），根治第 1 步那类冻结的复发诱因。
#
# 权限说明：两步都需要管理员权限，脚本开头自动弹 UAC 自提权（UAC 弹窗用鼠标
#   点击，不依赖键盘）；用户拒绝授权时脚本直接退出 —— 钩子层基础修复已由
#   .8li 先行完成，不受影响，只是设备层修不了。
#
# 设计约束：
#   - 全程无交互：绝不出现 Read-Host 等待输入（键盘卡死时用户根本无法输入）
#   - 不删除任何用户数据：热键配置、安装目录一律保留，修复后可继续正常使用
#   - 每一步独立容错：单步失败只记录，不影响后续步骤
#   - 倒计时 5s 自动关窗（原为 15s：实测过长的前台占用会诱发 Photoshop 的
#     Wintab 断流 —— 非前台上下文不收包，15s 窗口足以让笔输入停摆 20s+）
#
# 编码要求：本文件必须保存为 UTF-8 with BOM。
#   Windows PowerShell 5.1 读取无 BOM 的 .ps1 时按 ANSI（中文系统为 GBK）解析，
#   任何非 ASCII 字符都会导致脚本解析失败或乱码。
#
# 退出码：0 = 修复完成；1 = 严重失败

param([switch]$JwElevated)

$ErrorActionPreference = "Continue"

$log = Join-Path $env:TEMP "jwautofill_fixkeyboard.log"

# ---------- 0) 管理员自提权 ----------
# 设备软重置与 USB 省电策略都需要管理员权限。缺权限时自动弹 UAC 重新以管理员
# 身份运行本脚本（UAC 弹窗用鼠标点击即可，不依赖键盘）。
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
        Write-Host "未获得管理员授权：设备层修复已跳过。" -ForegroundColor Yellow
        Write-Host "钩子层基础修复（卸钩 / 复位超时 / 释放修饰键 / 重启输入法）已由插件先行完成。"
        Write-Host "若键盘仍异常，请手动重新插拔键盘。"
        try { Start-Sleep -Seconds 8 } catch { }
        exit 0
    }
}

function Log($msg) {
    $t = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try { "$t  $msg" | Out-File -FilePath $log -Append -Encoding utf8 } catch { }
    Write-Host $msg
}

$exitCode = 0

Log "=================================================="
Log " JWautofill 键盘一键修复（设备层）"
Log "=================================================="
Write-Host ""

# ---------- 1) 软重置键盘设备（程序化重新插拔） ----------
# 真实案例：键盘冻结发生在 HID/USB 设备层（中断管道卡死、USB 省电唤醒失败），
# 此时全局钩子早已释放、软件层一切正常，杀进程/重启输入法均无效，
# 只有「重新插拔键盘」能恢复。本步用 PnP API 复现重插效果，无需用户动手拔线。
Log "[1/2] 正在软重置键盘设备（程序化重新插拔）…"
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
        ForEach-Object {
            try { Enable-PnpDevice -InstanceId $_.InstanceId -Confirm:$false -ErrorAction Stop | Out-Null } catch { }
        }
} catch { }

# ---------- 2) 关闭 USB 省电策略（防止设备层冻结复发） ----------
# 「重插键盘才恢复」型冻结的典型诱因：USB 选择性挂起后设备唤醒失败。
Log "[2/2] 正在关闭 USB 省电策略（防止复发）…"
# 2a) 设备级：HID 设备与 USB 根集线器的「允许计算机关闭此设备以节约电源」
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
# 2b) 电源计划级：USB 选择性挂起 → 已禁用（交流/电池均生效，立即生效无需重启）
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
Write-Host "  · 已尝试软重置键盘设备（程序化重新插拔）并关闭 USB 省电策略。"
Write-Host "  · 若此前症状是「某个键按下后不停重复」，由设备重置解除（键被卡在按下态）。"
Write-Host "  · 钩子层修复（卸钩 / 复位 LowLevelHooksTimeout / 释放修饰键 / 重启输入法）"
Write-Host "    已由插件在唤起本窗口之前完成，本窗口不再重复。"
Write-Host "  · 你的热键配置与程序文件均已保留，未删除任何数据。"
Write-Host "  · 快捷键开关保持关闭，确认键盘正常后可在面板重新打开。"
Write-Host "  · 若完成本修复后仍无法输入，多为键盘硬件或 USB 接口层问题，请更换接口/键盘测试。"
Write-Host ""
Write-Host "日志文件：$log"
Write-Host ""

for ($i = 5; $i -ge 1; $i--) {
    Write-Host ("`r本窗口将在 " + $i + " 秒后自动关闭…   ") -NoNewline
    Start-Sleep -Seconds 1
}
Write-Host ""
exit $exitCode
