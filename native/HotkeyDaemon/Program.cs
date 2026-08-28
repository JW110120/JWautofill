// JWautofill 全局热键守护进程 (Windows)
// 职责：
//   1. 持有共享配置文件 hotkeys.json（默认 %LOCALAPPDATA%/JWautofill/hotkeys.json；
//      由 UXP 面板在连接后指定为 PS 的 PluginData 目录，与密钥/图案等数据统一管理）
//   2. 用一个「常驻 WH_KEYBOARD_LL 低层键盘钩子」捕获全局组合键
//      —— 注意：这里刻意不用 RegisterHotKey。实测（2026-08-29）RegisterHotKey 能注册成功
//         （返回 true，无冲突），但 WM_HOTKEY 永远投递不到我们的消息窗口：
//         守护进程用 HWND_MESSAGE(message-only window) 承载热键，而 WM_HOTKEY 不会派发到
//         message-only window，导致「录制的快捷键完全不生效」。低层钩子还带来一个额外好处：
//         命中后可以 return 1 吞掉按键，Photoshop 不会再抢走这个组合键（例如
//         Ctrl+Alt+Shift+K 在 PS 里是「键盘快捷键」对话框，RegisterHotKey 方案下会同时触发）。
//   3. 监听本地 WebSocket (127.0.0.1:18923)：
//      - 客户端连接后自动推送当前配置
//      - 收到 {type:"getConfig"} 返回当前配置
//      - 收到 {type:"config", payload:[...]} 落盘并重载热键
//      - 热键触发时向所有已连接客户端广播 {type:"hotkey", ...}
//   4. 监听配置文件变化，热更新注册
//
// 设计为无第三方依赖（手写最小 WebSocket），确保离线可编译、易维护。

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace JWautofillHotkeyDaemon
{
    public class HotkeyItem
    {
        public string Id { get; set; } = "";
        public string Combo { get; set; } = "";   // 例如 "Ctrl+Shift+R"、"Alt+F1"、"B"
        public string Action { get; set; } = "";   // "toggleMain" | "applyBrush"
        public string Brush { get; set; } = "";    // applyBrush 时使用的笔刷标识
    }

    internal static class Win32
    {
        public const int WM_HOTKEY = 0x0312;
        public const int WM_RELOAD = 0x8001; // 自定义：请求重新加载配置
        public const int MOD_ALT = 0x0001;
        public const int MOD_CONTROL = 0x0002;
        public const int MOD_SHIFT = 0x0004;
        public const int MOD_WIN = 0x0008;
        public static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

        public delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct WNDCLASSEX
        {
            public uint cbSize;
            public uint style;
            public IntPtr lpfnWndProc;
            public int cbClsExtra;
            public int cbWndExtra;
            public IntPtr hInstance;
            public IntPtr hIcon;
            public IntPtr hCursor;
            public IntPtr hbrBackground;
            public string lpszMenuName;
            public string lpszClassName;
            public IntPtr hIconSm;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr CreateWindowEx(int dwExStyle, string lpClassName, string lpWindowName,
            int dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu,
            IntPtr hInstance, IntPtr lpParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        public static extern bool TranslateMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        public static extern IntPtr DispatchMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern short VkKeyScanW(char ch);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetModuleHandle(string? lpModuleName);

        [DllImport("kernel32.dll")]
        public static extern int GetCurrentThreadId();

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool PostThreadMessage(int idThread, uint msg, IntPtr wParam, IntPtr lParam);

        // ===== 全局键盘钩子（用于录制组合键）=====
        public const int WH_KEYBOARD_LL = 13;
        public const int WM_KEYDOWN = 0x0100;
        public const int WM_SYSKEYDOWN = 0x0104;

        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public int x;
            public int y;
        }
    }

    internal static class Program
    {
        // 构建版本标识：用于区分安装目录里的新旧 daemon（历史上两次因版本错位误判问题）
        internal const string Version = "2026-08-29.3";

        private static readonly int PORT = 18923;
        private static readonly string DefaultConfigPath =
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "JWautofill", "hotkeys.json");

        // UXP 面板连接后会把它希望使用的配置路径（PS 的 PluginData 目录，与密钥/图案等
        // 持久化数据放在一起）告知守护进程；这里记下最后一次的路径，使得开机自启、
        // 面板尚未连接时守护进程也能直接读同一份配置。
        private static readonly string ConfigPathStore =
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "JWautofill", "configpath.txt");

        private static string _configPath = "";
        // 组合键 -> 配置条目。命中判定完全在内存里做（不再依赖 RegisterHotKey，
        // 因此不存在「注册失败 = 快捷键静默失效」的情况）。
        private static Dictionary<string, HotkeyItem> _comboMap = new(StringComparer.OrdinalIgnoreCase);
        private static List<HotkeyItem> _currentItems = new();
        private static bool _active = false;
        private static readonly object _clientsLock = new();
        private static readonly List<TcpClient> _clients = new();
        private static IntPtr _hwnd;
        private static FileSystemWatcher? _watcher;
        // 主线程 ID：钩子命中后通过线程消息把「命中事件」交给主线程广播，
        // 避免在键盘钩子里做网络 I/O（钩子有严格超时，超时会被系统静默摘除）。
        private static int _mainThreadId = 0;
        private static readonly ConcurrentQueue<string> _hitQueue = new();

        // ===== 组合键录制（全局键盘钩子）=====
        private const int WM_RECORD_START = 0x8002; // 录制线程：开始录制（常驻钩子已在运行）
        private const int WM_RECORD_STOP = 0x8003;  // 录制线程：结束录制
        private const int WM_HOTKEY_HIT = 0x8004;   // 主线程：钩子命中热键，去 _hitQueue 取出并广播
        private const int WM_HOOK_INSTALL = 0x8005; // 录制线程：安装常驻低层键盘钩子
        private static readonly object _recLock = new();
        private static IntPtr _hookId = IntPtr.Zero;
        private static Win32.LowLevelKeyboardProc? _hookProc;
        private static TcpClient? _recordingClient;
        private static string? _recordingBrush;
        // 录制线程：持有独立消息循环，全局键盘钩子必须装在带消息循环的线程上
        private static int _recThreadId = 0;
        private static readonly ManualResetEventSlim _recThreadReady = new(false);

        private static Win32.WndProcDelegate? _wndProcDelegate; // 必须保持引用，避免 GC

        // 统一的 JSON 序列化选项：
        // - CamelCase：落盘/回传给 UXP 的字段为小写驼峰（id/combo/action/brush），与 UXP 端一致
        // - PropertyNameCaseInsensitive：兼容反序列化 UXP 推来的小写键名。
        //   System.Text.Json 默认大小写敏感，之前 UXP 推 {"combo":...} 反序列化到 PascalCase 属性
        //   会全部得到空字符串，快捷键因此永远无法注册。
        // - UnsafeRelaxedJsonEscaping：不要把中文/'+' 转义成 \u96C6\u4E2D / \u002B，
        //   落盘后直接是 "brush":"集中/小"、"combo":"Ctrl+Alt+K"，便于人工查看与排查。
        //   这里只用于本地配置文件与本地 WebSocket，不存在 XSS 场景。
        private static readonly JsonSerializerOptions JsonOpts = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            WriteIndented = true
        };

        static void Main(string[] args)
        {
            _mainThreadId = Win32.GetCurrentThreadId();

            // 仅当参数是文件路径（不以 - 开头）时才当作配置文件，避免把 --autostart 等标志误当路径
            foreach (var a in args)
            {
                if (!string.IsNullOrWhiteSpace(a) && !a.StartsWith("-") && File.Exists(a))
                {
                    _configPath = a;
                    break;
                }
            }
            // 未通过命令行指定时，优先沿用 UXP 面板上一次告知的路径（PS PluginData 目录），
            // 最后才回落到默认路径。
            // 关键兜底：之前 _configPath 初始值是 ""，DefaultConfigPath 定义了却从未使用，
            // 导致 SaveConfig 抛 "The value cannot be an empty string (Parameter 'path')"，
            // 配置永远无法落盘、快捷键从未真正注册过（2026-08-29 ws 链路测试定位）。
            if (string.IsNullOrWhiteSpace(_configPath) && File.Exists(ConfigPathStore))
            {
                try
                {
                    var saved = File.ReadAllText(ConfigPathStore).Trim();
                    if (!string.IsNullOrWhiteSpace(saved)) _configPath = saved;
                }
                catch { /* ignore */ }
            }
            if (string.IsNullOrWhiteSpace(_configPath))
                _configPath = DefaultConfigPath;
            Console.WriteLine("[HotkeyDaemon] 版本: " + Version);
            Console.WriteLine("[HotkeyDaemon] 配置路径: " + _configPath);

            SetupConfigWatcher();
            ReloadConfig();

            // 启动录制线程（独立消息循环，承载常驻低层键盘钩子）
            var recThread = new Thread(RecordingThreadProc) { IsBackground = true };
            recThread.Start();
            // 录制指令仍走 PostThreadMessage：此时录制线程已进入消息循环，队列必然存在
            _recThreadReady.Wait(5000);

            _ = Task.Run(() => RunWebSocketServer());
            _ = Task.Run(WatchPhotoshop);

            _wndProcDelegate = WndProc;
            var wc = new Win32.WNDCLASSEX
            {
                cbSize = (uint)Marshal.SizeOf<Win32.WNDCLASSEX>(),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProcDelegate),
                hInstance = Win32.GetModuleHandle(null),
                lpszClassName = "JWautofillHotkeyMessageWindow"
            };
            Win32.RegisterClassEx(ref wc);
            _hwnd = Win32.CreateWindowEx(0, wc.lpszClassName, string.Empty, 0, 0,  0, 0, 0, Win32.HWND_MESSAGE,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);

            Console.WriteLine("[HotkeyDaemon] 已就绪，等待快捷键...");
            var msg = new Win32.MSG();
            while (Win32.GetMessage(out msg, IntPtr.Zero, 0, 0) != 0)
            {
                // 线程消息（PostThreadMessage）没有窗口句柄，DispatchMessage 不会派发，必须显式处理
                if (msg.hwnd == IntPtr.Zero && msg.message == WM_HOTKEY_HIT)
                {
                    HandleHotkeyHits();
                    continue;
                }
                Win32.TranslateMessage(ref msg);
                Win32.DispatchMessage(ref msg);
            }
        }

        // 配置文件变化监听；切换配置路径时需要重建
        private static void SetupConfigWatcher()
        {
            try
            {
                if (_watcher != null) { _watcher.EnableRaisingEvents = false; _watcher.Dispose(); _watcher = null; }
            }
            catch { /* ignore */ }
            try
            {
                var dir = Path.GetDirectoryName(_configPath);
                var name = Path.GetFileName(_configPath);
                if (string.IsNullOrEmpty(dir) || string.IsNullOrEmpty(name)) return;
                Directory.CreateDirectory(dir);
                if (!File.Exists(_configPath)) return; // 文件不存在时 FileSystemWatcher 无法建立
                _watcher = new FileSystemWatcher(dir, name) { NotifyFilter = NotifyFilters.LastWrite };
                _watcher.Changed += (_, _) => Win32.PostMessage(_hwnd, Win32.WM_RELOAD, IntPtr.Zero, IntPtr.Zero);
                _watcher.Created += (_, _) => Win32.PostMessage(_hwnd, Win32.WM_RELOAD, IntPtr.Zero, IntPtr.Zero);
                _watcher.EnableRaisingEvents = true;
            }
            catch (Exception ex)
            {
                Console.WriteLine("[HotkeyDaemon] 配置监听初始化失败: " + ex.Message);
            }
        }

        // UXP 面板指定配置路径（PS 的 PluginData 目录）。切换后立刻迁移旧配置并重载。
        private static void SetConfigPath(string newPath)
        {
            if (string.IsNullOrWhiteSpace(newPath)) return;
            newPath = newPath.Trim();
            if (string.Equals(newPath, _configPath, StringComparison.OrdinalIgnoreCase)) return;

            var oldPath = _configPath;
            _configPath = newPath;
            Console.WriteLine("[HotkeyDaemon] 配置路径已切换: " + newPath);
            try
            {
                var dir = Path.GetDirectoryName(newPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                // 迁移：新路径还没有配置文件、旧路径有时，把旧内容搬过去，避免用户重新录制
                if (!File.Exists(newPath) && !string.IsNullOrEmpty(oldPath) && File.Exists(oldPath))
                {
                    File.Copy(oldPath, newPath, true);
                    Console.WriteLine("[HotkeyDaemon] 已迁移旧配置到新路径");
                }
                var storeDir = Path.GetDirectoryName(ConfigPathStore);
                if (!string.IsNullOrEmpty(storeDir)) Directory.CreateDirectory(storeDir);
                File.WriteAllText(ConfigPathStore, newPath);
            }
            catch (Exception ex)
            {
                Console.WriteLine("[HotkeyDaemon] 切换配置路径失败: " + ex.Message);
            }
            SetupConfigWatcher();
            ReloadConfig();
        }

        private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            if (msg == Win32.WM_RELOAD)
            {
                try { ReloadConfig(); }
                catch (Exception ex) { Console.WriteLine("[HotkeyDaemon] 重载配置失败: " + ex.Message); }
                return IntPtr.Zero;
            }
            return IntPtr.Zero;
        }

        // 在主线程把钩子命中的热键广播给所有 UXP 客户端（网络 I/O 绝不能放进键盘钩子里）
        private static void HandleHotkeyHits()
        {
            while (_hitQueue.TryDequeue(out var combo))
            {
                if (!_comboMap.TryGetValue(combo, out var item)) continue;
                Console.WriteLine("[HotkeyDaemon] 热键命中: " + combo + " -> " + item.Action +
                    (string.IsNullOrEmpty(item.Brush) ? "" : (" / " + item.Brush)));
                Broadcast(JsonSerializer.Serialize(new
                {
                    type = "hotkey",
                    id = item.Id,
                    combo = item.Combo,
                    action = item.Action,
                    brush = item.Brush
                }, JsonOpts));
            }
        }

        // 仅读取配置文件 -> 列表（不注册）
        private static List<HotkeyItem> ReadConfigFile()
        {
            if (!File.Exists(_configPath)) return new List<HotkeyItem>();
            try
            {
                var json = File.ReadAllText(_configPath);
                return JsonSerializer.Deserialize<List<HotkeyItem>>(json, JsonOpts) ?? new List<HotkeyItem>();
            }
            catch (Exception ex)
            {
                Console.WriteLine("[HotkeyDaemon] 解析配置失败: " + ex.Message);
                return new List<HotkeyItem>();
            }
        }

        // 读取配置并重载：仅在 Photoshop 运行时才真正注册热键
        private static void ReloadConfig()
        {
            _currentItems = ReadConfigFile();
            if (_active) RegisterAll();
            else BroadcastConfig();
        }

        // 装载热键表（纯内存匹配，不再调用 RegisterHotKey）
        private static void RegisterAll()
        {
            var map = new Dictionary<string, HotkeyItem>(StringComparer.OrdinalIgnoreCase);
            foreach (var it in _currentItems)
            {
                if (string.IsNullOrWhiteSpace(it.Combo)) continue;
                if (map.ContainsKey(it.Combo))
                {
                    Console.WriteLine("[HotkeyDaemon] 跳过重复组合键: " + it.Combo);
                    continue;
                }
                map[it.Combo] = it;
                Console.WriteLine("[HotkeyDaemon] 已装载热键: " + it.Combo + " -> " + it.Action +
                    (string.IsNullOrEmpty(it.Brush) ? "" : (" / " + it.Brush)));
            }
            _comboMap = map;
            _active = true;
            BroadcastConfig();
        }

        // 卸载热键表（Photoshop 未运行时不响应快捷键）
        private static void UnregisterAll()
        {
            _comboMap = new Dictionary<string, HotkeyItem>(StringComparer.OrdinalIgnoreCase);
            _active = false;
        }

        // 落盘并热更新
        private static void SaveConfig(List<HotkeyItem> items)
        {
            try
            {
                var dir = Path.GetDirectoryName(_configPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(_configPath, JsonSerializer.Serialize(items, JsonOpts));
                ReloadConfig();
            }
            catch (Exception ex)
            {
                Console.WriteLine("[HotkeyDaemon] 写入配置失败: " + ex.Message);
            }
        }

        // 命名键 -> VirtualKeyCode（与 UXP 端 NAMED_KEYS 保持一致）
        private static readonly Dictionary<string, int> NamedVk = new()
        {
            { "backspace", 0x08 }, { "tab", 0x09 }, { "enter", 0x0D }, { "escape", 0x1B },
            { "space", 0x20 }, { "delete", 0x2E }, { "insert", 0x2D },
            { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
            { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 }
        };

        // 进程监控：守护进程默认常驻，仅在 Photoshop 运行时才激活全局热键；
        // 若设置环境变量 JWAUTO_EXIT_WHEN_PS_CLOSED=1，则 PS 关闭后立即退出（需由启动器/插件再次拉起）。
        // 这样天然实现「随 PS 开启时开启、PS 关闭后关闭（或取消激活）」。
        private static void WatchPhotoshop()
        {
            bool exitWhenClosed = Environment.GetEnvironmentVariable("JWAUTO_EXIT_WHEN_PS_CLOSED") == "1";
            bool sawPs = false;
            while (true)
            {
                Thread.Sleep(3000);
                bool psRunning = false;
                try { psRunning = Process.GetProcessesByName("photoshop").Length > 0; } catch { }
                if (psRunning)
                {
                    sawPs = true;
                    if (!_active) RegisterAll();
                }
                else
                {
                    if (_active) UnregisterAll();
                    if (exitWhenClosed && sawPs)
                    {
                        Console.WriteLine("[HotkeyDaemon] Photoshop 已关闭，退出守护进程。");
                        Environment.Exit(0);
                    }
                }
            }
        }

        // 解析 "Ctrl+Shift+R"、"Alt+F1"、"Backspace" 等 -> (modifiers, virtualKey)
        private static (int, int) ParseCombo(string combo)
        {
            int mods = 0;
            int vk = 0;
            foreach (var part in combo.Split('+'))
            {
                var p = part.Trim().ToLowerInvariant();
                if (p == "ctrl" || p == "control") mods |= Win32.MOD_CONTROL;
                else if (p == "shift") mods |= Win32.MOD_SHIFT;
                else if (p == "alt") mods |= Win32.MOD_ALT;
                else if (p == "win" || p == "super") mods |= Win32.MOD_WIN;
                else if (p.StartsWith("f") && int.TryParse(p.Substring(1), out int f) && f >= 1 && f <= 24)
                    vk = 0x70 + (f - 1);
                else if (NamedVk.TryGetValue(p, out int nv)) vk = nv;
                else if (p.Length == 1) vk = (byte)Win32.VkKeyScanW(p[0]);
                // 其余情况 vk 保持 0，调用方需跳过注册
            }
            return (mods, vk);
        }

        // ===== 常驻低层键盘钩子 =====
        // 钩子在进程启动时安装一次，同时服务于「录制组合键」与「触发快捷键」两件事。
        // 它运行在独立的带消息循环的线程上（低层钩子要求安装线程必须泵消息）。
        private static void InstallPermanentHook()
        {
            lock (_recLock)
            {
                if (_hookId != IntPtr.Zero) { Win32.UnhookWindowsHookEx(_hookId); _hookId = IntPtr.Zero; }
                _hookProc = LowLevelKeyboardProc; // 保持委托引用，避免被 GC 后钩子崩溃
                _hookId = Win32.SetWindowsHookEx(Win32.WH_KEYBOARD_LL, _hookProc, Win32.GetModuleHandle(null), 0);
                if (_hookId == IntPtr.Zero)
                    Console.WriteLine("[HotkeyDaemon] ❌ 常驻键盘钩子安装失败，快捷键将完全不生效");
                else
                    Console.WriteLine("[HotkeyDaemon] 常驻键盘钩子已安装");
            }
        }

        // 开始录制：常驻钩子已在运行，这里只标注「正在等录制的那一次按键」
        private static void StartRecordingInternal()
        {
            if (_hookId == IntPtr.Zero) InstallPermanentHook();
            Console.WriteLine("[HotkeyDaemon] 录制已开始，等待组合键…");
        }

        // combo 为 null 表示取消（ESC 或 UXP 主动取消）
        private static void FinishRecordingInternal(string? combo)
        {
            lock (_recLock)
            {
                var client = _recordingClient;
                _recordingClient = null;
                string brush = _recordingBrush ?? "";
                _recordingBrush = null;
                if (client == null) return;
                try
                {
                    if (combo == null)
                        SendToClient(client, JsonSerializer.Serialize(new { type = "recordCancel", brush }, JsonOpts));
                    else
                        SendToClient(client, JsonSerializer.Serialize(new { type = "recordResult", brush, combo }, JsonOpts));
                }
                catch { try { client.Close(); } catch { } }
            }
        }

        // 录制线程：独立消息循环，专门用于承载 WH_KEYBOARD_LL 钩子。
        // 通过 PostThreadMessage 接收 WM_HOOK_INSTALL / WM_RECORD_START / WM_RECORD_STOP。
        private static void RecordingThreadProc()
        {
            _recThreadId = Win32.GetCurrentThreadId();
            _recThreadReady.Set();
            Console.WriteLine("[HotkeyDaemon] 钩子线程已启动 tid=" + _recThreadId);
            // 常驻钩子必须由「承载它的那个线程」自己安装：它随后立刻进入消息循环，
            // 之前改成主线程 PostThreadMessage 通知安装会失败——线程消息队列在
            // GetMessage 之前尚未创建，PostThreadMessage 返回 false，钩子永远装不上。
            InstallPermanentHook();
            var msg = new Win32.MSG();
            while (Win32.GetMessage(out msg, IntPtr.Zero, 0, 0) != 0)
            {
                if (msg.message == WM_HOOK_INSTALL) InstallPermanentHook();
                else if (msg.message == WM_RECORD_START) StartRecordingInternal();
                else if (msg.message == WM_RECORD_STOP) FinishRecordingInternal(null);
                // 线程消息（PostThreadMessage）没有窗口，无需 DispatchMessage
            }
            Console.WriteLine("[HotkeyDaemon] 钩子线程已退出");
        }

        private static IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == Win32.WM_KEYDOWN || msg == Win32.WM_SYSKEYDOWN)
                {
                    int vk = Marshal.ReadInt32(lParam);              // KBDLLHOOKSTRUCT.vkCode 为首字段
                    uint flags = (uint)Marshal.ReadInt32(lParam, 8); // flags 偏移 8
                    // bit 30 = 上一帧按键状态（1 表示此前已按下，即系统自动重复），忽略重复
                    bool repeat = (flags & (1u << 30)) != 0;

                    if (!repeat)
                    {
                        bool recording;
                        lock (_recLock) recording = _recordingClient != null;

                        if (recording)
                        {
                            if (vk == 0x1B) // Escape => 取消录制
                            {
                                Console.WriteLine("[HotkeyDaemon] 录制取消 (Esc)");
                                FinishRecordingInternal(null);
                                return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);
                            }

                            bool isModifier = vk == 0x11 || vk == 0x12 || vk == 0x10 || vk == 0x5B || vk == 0x5C;
                            if (!isModifier)
                            {
                                string? combo = BuildCombo(vk);
                                if (!string.IsNullOrEmpty(combo))
                                {
                                    Console.WriteLine("[HotkeyDaemon] 录制到组合键: " + combo);
                                    FinishRecordingInternal(combo);
                                }
                            }
                            return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);
                        }

                        // 非录制状态：与已装载的热键表做匹配
                        if (_active && _comboMap.Count > 0)
                        {
                            string? combo = BuildCombo(vk);
                            if (combo != null && _comboMap.TryGetValue(combo, out var hit))
                            {
                                // 命中：把组合键丢进队列交给主线程广播，然后吞掉这个按键。
                                // 吞掉很关键——否则 Photoshop 会同时收到该组合键并执行它自己的
                                // 快捷键（如 Ctrl+Alt+Shift+K 弹出「键盘快捷键」对话框）。
                                _hitQueue.Enqueue(hit.Combo);
                                Win32.PostThreadMessage(_mainThreadId, WM_HOTKEY_HIT, IntPtr.Zero, IntPtr.Zero);
                                return (IntPtr)1;
                            }
                        }
                    }
                }
            }
            return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);
        }

        private static string? BuildCombo(int vk)
        {
            var parts = new List<string>();
            if ((Win32.GetAsyncKeyState(0x11) & 0x8000) != 0) parts.Add("Ctrl");
            if ((Win32.GetAsyncKeyState(0x12) & 0x8000) != 0) parts.Add("Alt");
            if ((Win32.GetAsyncKeyState(0x10) & 0x8000) != 0) parts.Add("Shift");
            if ((Win32.GetAsyncKeyState(0x5B) & 0x8000) != 0 || (Win32.GetAsyncKeyState(0x5C) & 0x8000) != 0) parts.Add("Win");
            string? key = KeyToToken(vk);
            if (string.IsNullOrEmpty(key)) return null;
            parts.Add(key);
            return string.Join("+", parts);
        }

        private static string? KeyToToken(int vk)
        {
            if (vk >= 0x41 && vk <= 0x5A) return ((char)vk).ToString();
            if (vk >= 0x30 && vk <= 0x39) return ((char)vk).ToString();
            if (vk >= 0x70 && vk <= 0x87) return "F" + (vk - 0x70 + 1);
            switch (vk)
            {
                case 0x08: return "Backspace";
                case 0x09: return "Tab";
                case 0x0D: return "Enter";
                case 0x1B: return "Escape";
                case 0x20: return "Space";
                case 0x2D: return "Insert";
                case 0x23: return "End";
                case 0x24: return "Home";
                case 0x21: return "PageUp";
                case 0x22: return "PageDown";
                case 0x26: return "Up";
                case 0x28: return "Down";
                case 0x25: return "Left";
                case 0x27: return "Right";
                case 0x2E: return "Delete";
                default: return null;
            }
        }

        private static async Task RunWebSocketServer()
        {
            var listener = new TcpListener(IPAddress.Loopback, PORT);
            listener.Start();
            Console.WriteLine("[HotkeyDaemon] WebSocket 监听 ws://127.0.0.1:" + PORT);
            while (true)
            {
                try
                {
                    var client = await listener.AcceptTcpClientAsync();
                    _ = Task.Run(() => HandleClient(client));
                }
                catch (Exception ex)
                {
                    Console.WriteLine("[HotkeyDaemon] 接受连接失败: " + ex.Message);
                }
            }
        }

        private static async Task HandleClient(TcpClient client)
        {
            try
            {
                var stream = client.GetStream();
                var buf = new byte[4096];
                int read = await stream.ReadAsync(buf, 0, buf.Length);
                if (read == 0) { client.Close(); return; }
                string header = Encoding.ASCII.GetString(buf, 0, read);
                var match = System.Text.RegularExpressions.Regex.Match(header, "Sec-WebSocket-Key:\\s*(.+)");
                if (!match.Success)
                {
                    client.Close();
                    return;
                }
                string key = match.Groups[1].Value.Trim();
                string accept = ComputeAccept(key);
                string response =
                    "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(response));

                lock (_clientsLock) _clients.Add(client);

                // 连接后推送当前配置
                SendConfigToClient(client);

                // 监听入站帧（客户端→服务端必然 masked）
                while (true)
                {
                    var text = await ReadTextFrameAsync(stream);
                    if (text == null) break;
                    if (text.Length == 0) continue; // 心跳/控制帧，无需解析
                    try
                    {
                        using var doc = JsonDocument.Parse(text);
                        if (!doc.RootElement.TryGetProperty("type", out var typeEl)) continue;
                        var type = typeEl.GetString();
                        if (type == "setConfigPath")
                        {
                            // UXP 面板告知：配置统一存到 PS 的 PluginData 目录（与密钥/图案等数据同源）
                            if (doc.RootElement.TryGetProperty("path", out var pathEl))
                            {
                                var p = pathEl.GetString();
                                if (!string.IsNullOrWhiteSpace(p)) SetConfigPath(p!);
                            }
                        }
                        else if (type == "shutdown")
                        {
                            // 面板点「断开守护进程」：优雅退出，让卸载脚本能顺利删除安装目录
                            Console.WriteLine("[HotkeyDaemon] 收到断开指令，正在退出…");
                            try { SendToClient(client, JsonSerializer.Serialize(new { type = "bye" }, JsonOpts)); } catch { }
                            _ = Task.Run(async () => { await Task.Delay(300); Environment.Exit(0); });
                        }
                        else if (type == "config")
                        {
                            if (doc.RootElement.TryGetProperty("payload", out var payload))
                            {
                                var items = JsonSerializer.Deserialize<List<HotkeyItem>>(payload.GetRawText(), JsonOpts) ?? new List<HotkeyItem>();
                                SaveConfig(items);
                            }
                        }
                        else if (type == "getConfig")
                        {
                            SendConfigToClient(client);
                        }
                        else if (type == "recordStart")
                        {
                            // 记录请求方，并在「录制线程」安装全局键盘钩子
                            // （钩子必须在带消息循环的线程上安装；我们用独立录制线程 + PostThreadMessage）
                            string? brush = null;
                            if (doc.RootElement.TryGetProperty("brush", out var bEl)) brush = bEl.GetString();
                            lock (_recLock) { _recordingClient = client; _recordingBrush = brush; }
                            Win32.PostThreadMessage(_recThreadId, WM_RECORD_START, IntPtr.Zero, IntPtr.Zero);
                        }
                        else if (type == "recordCancel")
                        {
                            Win32.PostThreadMessage(_recThreadId, WM_RECORD_STOP, IntPtr.Zero, IntPtr.Zero);
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("[HotkeyDaemon] 处理消息失败: " + ex.Message);
                    }
                }
            }
            catch { }
            finally
            {
                // 若断开的是正在录制的一方，取消录制（卸载钩子）
                if (_recordingClient == client)
                    Win32.PostThreadMessage(_recThreadId, WM_RECORD_STOP, IntPtr.Zero, IntPtr.Zero);
                lock (_clientsLock) _clients.Remove(client);
                try { client.Close(); } catch { }
            }
        }

        private static void SendConfigToClient(TcpClient client)
        {
            var items = ReadConfigFile();
            SendToClient(client, JsonSerializer.Serialize(new { type = "config", payload = items }, JsonOpts));
        }

        private static void BroadcastConfig()
        {
            var items = ReadConfigFile();
            var msg = JsonSerializer.Serialize(new { type = "config", payload = items }, JsonOpts);
            lock (_clientsLock)
            {
                foreach (var c in _clients.ToArray())
                {
                    try { SendToClient(c, msg); }
                    catch { try { c.Close(); } catch { } }
                }
            }
        }

        // 服务端→客户端帧（不掩码）
        private static void SendToClient(TcpClient client, string message)
        {
            var bytes = Encoding.UTF8.GetBytes(message);
            var header = new List<byte>();
            header.Add(0x81); // FIN + 文本帧
            if (bytes.Length < 126)
            {
                header.Add((byte)bytes.Length);
            }
            else if (bytes.Length < 65536)
            {
                header.Add(126);
                header.Add((byte)(bytes.Length >> 8));
                header.Add((byte)(bytes.Length & 0xFF));
            }
            else
            {
                header.Add(127);
                for (int i = 7; i >= 0; i--)
                    header.Add((byte)(bytes.Length >> (8 * i)));
            }
            client.GetStream().Write(header.ToArray(), 0, header.Count);
            client.GetStream().Write(bytes, 0, bytes.Length);
        }

        // 客户端→服务端帧（必掩码），读取一个文本帧；返回 null 表示连接关闭
        private static async Task<string?> ReadTextFrameAsync(Stream stream)
        {
            var head = new byte[2];
            int got = 0;
            while (got < 2)
            {
                int r = await stream.ReadAsync(head, got, 2 - got);
                if (r == 0) return null;
                got += r;
            }
            bool masked = (head[1] & 0x80) != 0;
            int opcode = head[0] & 0x0F;
            long len = head[1] & 0x7F;
            if (len == 126)
            {
                var ext = new byte[2]; int g = 0;
                while (g < 2) { int r = await stream.ReadAsync(ext, g, 2 - g); if (r == 0) return null; g += r; }
                len = (ext[0] << 8) | ext[1];
            }
            else if (len == 127)
            {
                var ext = new byte[ 8]; int g = 0;
                while (g < 8) { int r = await stream.ReadAsync(ext, g, 8 - g); if (r == 0) return null; g += r; }
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | ext[i];
            }
            byte[] mask = null!;
            if (masked)
            {
                mask = new byte[4]; int g = 0;
                while (g < 4) { int r = await stream.ReadAsync(mask, g, 4 - g); if (r == 0) return null; g += r; }
            }
            var payload = new byte[len];
            int p = 0;
            while (p < len)
            {
                int r = await stream.ReadAsync(payload, p, (int)len - p);
                if (r == 0) return null;
                p += r;
            }
            if (masked) for (int i = 0; i < len; i++) payload[i] ^= mask[i % 4];
            if (opcode == 0x8) return null;           // close
            if (opcode == 0x9)                        // ping：回一个 pong，避免 UXP 端心跳超时
            {
                try { SendPong(stream, payload); } catch { }
                return "";
            }
            if (opcode != 0x1) return "";             // 其余控制帧忽略（pong 等）
            return Encoding.UTF8.GetString(payload);
        }

        private static void SendPong(Stream stream, byte[] payload)
        {
            var header = new List<byte> { 0x8A };
            if (payload.Length < 126) header.Add((byte)payload.Length);
            else if (payload.Length < 65536)
            {
                header.Add(126);
                header.Add((byte)(payload.Length >> 8));
                header.Add((byte)(payload.Length & 0xFF));
            }
            else
            {
                header.Add(127);
                for (int i = 7; i >= 0; i--) header.Add((byte)(payload.Length >> (8 * i)));
            }
            stream.Write(header.ToArray(), 0, header.Count);
            if (payload.Length > 0) stream.Write(payload, 0, payload.Length);
        }

        private static void Broadcast(string message)
        {
            lock (_clientsLock)
            {
                foreach (var c in _clients.ToArray())
                {
                    try { SendToClient(c, message); }
                    catch { try { c.Close(); } catch { } }
                }
            }
        }

        private static string ComputeAccept(string key)
        {
            const string GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
            using var sha1 = SHA1.Create();
            var hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(key + GUID));
            return Convert.ToBase64String(hash);
        }
    }
}
