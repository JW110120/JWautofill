// JWautofill 键盘卡死一键修复 —— 启动器
// ----------------------------------------------------------------------------
// 为什么需要这个 .exe：
//   UXP 插件的 shell.openPath 对 .bat / .ps1 只会「用编辑器打开而非执行」，
//   对 .exe 才会真正运行（守护进程 JWautofillHotkeyDaemon.exe 正是这么启动的）。
//   因此「键盘卡死一键修复」菜单项必须唤起一个 .exe，由它再去跑真正的修复脚本，
//   才能弹出可见的 CMD 窗口并实际完成修复。
//
// 本程序只做一件事：在自带的控制台窗口里运行同目录下的 fix-keyboard.ps1，
// 把脚本的逐步输出原样呈现给用户，脚本自身负责 15 秒倒计时自动关闭。
// 若 powershell 无法启动或脚本缺失，则自行打印原因并等待 15 秒后退出，
// 绝不出现任何需要键盘输入的交互（键盘卡死场景用户无法打字）。
// ----------------------------------------------------------------------------

using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace JWautofill
{
    static class FixKeyboard
    {
        static int Main()
        {
            try { Console.OutputEncoding = System.Text.Encoding.UTF8; }
            catch { /* ignore */ }

            Console.WriteLine("==================================================");
            Console.WriteLine(" JWautofill 键盘一键修复（启动器）");
            Console.WriteLine("==================================================");
            Console.WriteLine("");

            // 修复脚本放在与本 .exe 同一目录（native/HotkeyDaemon/）
            string baseDir = AppContext.BaseDirectory;
            string ps1 = Path.Combine(baseDir, "fix-keyboard.ps1");
            if (!File.Exists(ps1))
            {
                // 兜底：有些部署会把 exe 与脚本放在不同层，再试一次当前目录
                ps1 = Path.Combine(Directory.GetCurrentDirectory(), "fix-keyboard.ps1");
            }

            if (!File.Exists(ps1))
            {
                Console.WriteLine("⚠️ 未找到修复脚本 fix-keyboard.ps1");
                Console.WriteLine("   期望位置：" + Path.Combine(baseDir, "fix-keyboard.ps1"));
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
                        Console.WriteLine("⚠️ 修复脚本返回非零退出码：" + code + "（详见上方日志）");
                    }
                    // 脚本自己已做 15 秒倒计时，正常路径无需重复等待
                    return code;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("⚠️ 修复启动失败：" + ex.Message);
                WaitAndClose(15);
                return 1;
            }
        }

        // 异常路径专用：脚本未自行倒计时时，这里等待若干秒让用户读到信息
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
