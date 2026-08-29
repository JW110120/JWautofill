using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;

namespace KeyMapTest;

// Two independent checks, both run against the real daemon source:
//   1. Key mapping round-trip  - proves punctuation / numpad keys survive
//      KeyToToken (record path) -> ParseCombo (trigger path) unchanged.
//   2. Hook visibility         - proves whether synthetic keybd_event strokes
//      are visible to a WH_KEYBOARD_LL hook in this execution environment.
//      Without that, no end-to-end hotkey test can be trusted.
internal static class Runner
{
    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Msg lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);
    [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public Point pt; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    private const int WhKeyboardLl = 13;
    private const int WmKeyDown = 0x0100;
    private const int WmSysKeyDown = 0x0104;

    private static readonly List<int> Seen = new();
    private static readonly HookProc Proc = OnHook;
    private static IntPtr _hook = IntPtr.Zero;

    private static int Main()
    {
        int fail = 0;
        fail += KeyMapRoundTrip();
        Console.WriteLine();
        fail += HookSelfTest();
        Console.WriteLine();
        PhotoshopCheck();
        Console.WriteLine();
        Console.WriteLine(fail == 0 ? "ALL CHECKS PASSED" : "FAILURES: " + fail);
        return fail == 0 ? 0 : 1;
    }

    private static int KeyMapRoundTrip()
    {
        Console.WriteLine("=== 1. KeyToToken <-> ParseCombo round trip ===");

        var asm = typeof(Runner).Assembly;
        var prog = asm.GetTypes().First(t => t.Name == "Program");
        var parse = prog.GetMethod("ParseCombo", BindingFlags.NonPublic | BindingFlags.Static)
                    ?? throw new InvalidOperationException("ParseCombo not found");
        var toToken = prog.GetMethod("KeyToToken", BindingFlags.NonPublic | BindingFlags.Static)
                      ?? throw new InvalidOperationException("KeyToToken not found");

        (int, int) Parse(string combo) => ((int, int))parse.Invoke(null, new object[] { combo })!;
        string? Token(int vk) => (string?)toToken.Invoke(null, new object[] { vk });

        var vks = new List<int>();
        for (int v = 0xBA; v <= 0xC0; v++) vks.Add(v);   // ; = , - . /
        for (int v = 0xDB; v <= 0xDE; v++) vks.Add(v);   // [ \ ] '
        for (int v = 0x60; v <= 0x69; v++) vks.Add(v);   // numpad 0-9
        vks.AddRange(new[] { 0x6A, 0x6B, 0x6D, 0x6E, 0x6F }); // NumMul/Plus/Minus/Dot/Div
        vks.AddRange(new[] { 0x14, 0x90, 0x91, 0x13, 0x2C, 0x5D }); // Caps/Num/Scroll/Pause/PrintScreen/Apps
        vks.Add(0x7B);                                    // F12 control

        int fail = 0;
        foreach (var vk in vks)
        {
            var token = Token(vk);
            if (string.IsNullOrEmpty(token))
            {
                Console.WriteLine("  FAIL  vk=0x" + vk.ToString("X2") + " -> KeyToToken returned null");
                fail++;
                continue;
            }
            var (mods, back) = Parse("Ctrl+Alt+" + token);
            bool ok = back == vk;
            if (!ok) fail++;
            Console.WriteLine("  " + (ok ? "ok   " : "FAIL ") + "vk=0x" + vk.ToString("X2") +
                              "  token=" + token.PadRight(10) +
                              "  parse-back=0x" + back.ToString("X2") +
                              "  mods=" + mods);
        }
        return fail;
    }

    // The daemon only activates its hotkey table while Photoshop is running
    // (_active). If this returns 0 in the daemon's execution context, every
    // hotkey silently stops firing even though recording still works.
    private static void PhotoshopCheck()
    {
        Console.WriteLine("=== 3. Photoshop detection (drives daemon _active flag) ===");
        var all = Process.GetProcesses();
        var ps = Process.GetProcessesByName("photoshop");
        Console.WriteLine("  GetProcessesByName(\"photoshop\").Length = " + ps.Length);
        foreach (var p in ps) Console.WriteLine("    hit: " + p.Id + " " + p.ProcessName);
        var anyPs = all.Where(p =>
        {
            try { return p.ProcessName.IndexOf("photoshop", StringComparison.OrdinalIgnoreCase) >= 0; }
            catch { return false; }
        }).ToList();
        Console.WriteLine("  full scan (substring, case-insensitive) = " + anyPs.Count);
        foreach (var p in anyPs)
        {
            Console.WriteLine("    " + p.Id + " " + p.ProcessName);
        }
    }

    private static IntPtr OnHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        int msg = wParam.ToInt32();
        if (nCode >= 0 && (msg == WmKeyDown || msg == WmSysKeyDown))
        {
            int vk = Marshal.ReadInt32(lParam);
            lock (Seen) Seen.Add(vk);
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    private static int HookSelfTest()
    {
        Console.WriteLine("=== 2. Synthetic keybd_event visibility to WH_KEYBOARD_LL ===");

        _hook = SetWindowsHookEx(WhKeyboardLl, Proc, GetModuleHandle(null), 0);
        if (_hook == IntPtr.Zero)
        {
            Console.WriteLine("  hook install FAILED (cannot judge injection)");
            return 1;
        }
        Console.WriteLine("  hook installed");

        var inject = new Thread(() =>
        {
            Thread.Sleep(700);
            var z = UIntPtr.Zero;
            void Send(byte vk)
            {
                keybd_event(0x11, 0, 0, z);
                keybd_event(0x12, 0, 0, z);
                Thread.Sleep(120);
                keybd_event(vk, 0, 0, z);
                Thread.Sleep(120);
                keybd_event(vk, 0, 2, z);
                Thread.Sleep(120);
                keybd_event(0x12, 0, 2, z);
                keybd_event(0x11, 0, 2, z);
            }
            Send(0x7B); // F12
            Thread.Sleep(600);
            Send(0xBA); // ;
        });
        inject.IsBackground = true;
        inject.Start();

        var deadline = DateTime.UtcNow.AddSeconds(6);
        while (DateTime.UtcNow < deadline)
        {
            while (PeekMessage(out var m, IntPtr.Zero, 0, 0, 1)) { /* pump */ }
            Thread.Sleep(5);
        }
        UnhookWindowsHookEx(_hook);

        int[] wanted = { 0x7B, 0xBA };
        int fail = 0;
        foreach (var w in wanted)
        {
            bool saw = Seen.Contains(w);
            if (!saw) fail++;
            Console.WriteLine("  " + (saw ? "ok   " : "FAIL ") + "hook saw vk=0x" + w.ToString("X2"));
        }
        Console.WriteLine("  all keys seen by hook: " + string.Join(",", Seen.Select(v => "0x" + v.ToString("X2"))));
        return fail;
    }
}
