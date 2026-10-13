// JWautofill 卸载 —— 可见 CMD 窗口启动器
// ----------------------------------------------------------------------------
// 为什么需要这个 .exe：
//   UXP 插件的 shell.openPath 对 .bat 的行为**不稳定**（同一台机器上实测：
//   热键卸载什么都不出现，平滑卸载只有一个窗口一闪而过）。对 .exe 才会稳定地
//   以 ShellExecute 执行并**带出可见控制台窗口** —— FixKeyboard.exe 已经用这条路
//   验证过（键盘修复窗口是能看到的）。
//
// 本程序只做一件事：在自带的控制台窗口里运行**同目录**的 uninstall.ps1，
// 把脚本的逐步输出原样呈现给用户；脚本自身负责倒计时自动关窗（成功 5s / 失败 15s）。
// 因此同一个 exe 可以原样放进两个角色目录（native/HotkeyDaemon、native/SmoothDaemon），
// 各自跑自己那份 uninstall.ps1，不需要参数、不需要区分角色。
//
// ⛔ 全程无交互：不读取任何按键输入（脚本可能删掉键盘钩子相关设置，期间键盘未必可用）。
// ----------------------------------------------------------------------------

using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace JWautofill
{
    static class JWUninstall
    {
        static int Main()
        {
            try { Console.OutputEncoding = System.Text.Encoding.UTF8; }
            catch { /* ignore */ }

            Console.WriteLine("==================================================");
            Console.WriteLine(" JWautofill 服务卸载（启动器）");
            Console.WriteLine("==================================================");
            Console.WriteLine("");

            string baseDir = AppContext.BaseDirectory;
            string ps1 = Path.Combine(baseDir, "uninstall.ps1");
            if (!File.Exists(ps1))
            {
                ps1 = Path.Combine(Directory.GetCurrentDirectory(), "uninstall.ps1");
            }

            if (!File.Exists(ps1))
            {
                Console.WriteLine("⚠️ 未找到卸载脚本 uninstall.ps1");
                Console.WriteLine("   期望位置：" + Path.Combine(baseDir, "uninstall.ps1"));
                WaitAndClose(15);
                return 1;
            }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-ExecutionPolicy Bypass -NoProfile -File \"" + ps1 + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = false,
                };
                using (var p = Process.Start(psi))
                {
                    if (p == null)
                    {
                        Console.WriteLine("⚠️ 无法启动 powershell.exe，请确认系统已安装 PowerShell。");
                        WaitAndClose(15);
                        return 1;
                    }
                    p.WaitForExit();
                    int code = p.ExitCode;
                    if (code != 0)
                    {
                        Console.WriteLine("");
                        Console.WriteLine("⚠️ 卸载脚本返回非零退出码：" + code + "（详见上方日志）");
                        WaitAndClose(15);
                    }
                    // 脚本自己已做倒计时，正常路径无需重复等待
                    return code;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("⚠️ 卸载启动失败：" + ex.Message);
                WaitAndClose(15);
                return 1;
            }
        }

        // 异常路径专用：脚本没跑起来时，这里等待若干秒让用户读到信息
        static void WaitAndClose(int secs)
        {
            for (int i = secs; i >= 1; i--)
            {
                Console.Write("\r本窗口将在 " + i + " 秒后自动关闭…   ");
                Thread.Sleep(1000);
            }
            Console.WriteLine("");
        }
    }
}
