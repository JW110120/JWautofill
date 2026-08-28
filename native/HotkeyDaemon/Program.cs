// JWautofill 全局热键守护进程 (Windows)
// 职责：
//   1. 持有共享配置文件 hotkeys.json（默认 %LOCALAPPDATA%/JWautofill/hotkeys.json），并支持命令行指定路径
//   2. 用 RegisterHotKey 注册全局组合键（支持 Ctrl/Shift/Alt/Win）
//   3. 监听本地 WebSocket (127.0.0.1:18923)：
//      - 客户端连接后自动推送当前配置
//      - 收到 {type:"getConfig"} 返回当前配置
//      - 收到 {type:"config", payload:[...]} 落盘并重载热键
//      - 热键触发时向所有已连接客户端广播 {type:"hotkey", ...}
//   4. 监听配置文件变化，热更新注册
//
// 设计为无第三方依赖（手写最小 WebSocket），确保离线可编译、易维护。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
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
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, int fsModifiers, int vk);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

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
        private static readonly int PORT = 18923;
        private static readonly string DefaultConfigPath =
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "JWautofill", "hotkeys.json");

        private static string _configPath = "";
        private static readonly Dictionary<int, HotkeyItem> _idToItem = new();
        private static List<HotkeyItem> _currentItems = new();
        private static int _nextId = 1;
        private static bool _active = false;
        private static readonly object _clientsLock = new();
        private static readonly List<TcpClient> _clients = new();
        private static IntPtr _hwnd;

        private static Win32.WndProcDelegate? _wndProcDelegate; // 必须保持引用，避免 GC

        static void Main(string[] args)
        {
            // 仅当参数是文件路径（不以 - 开头）时才当作配置文件，避免把 --autostart 等标志误当路径
            foreach (var a in args)
            {
                if (!string.IsNullOrWhiteSpace(a) && !a.StartsWith("-") && File.Exists(a))
                {
                    _configPath = a;
                    break;
                }
            }
            Console.WriteLine("[HotkeyDaemon] 配置路径: " + _configPath);

            ReloadConfig();

            _ = Task.Run(() => RunWebSocketServer());
            _ = Task.Run(WatchPhotoshop);

            if (File.Exists(_configPath))
            {
                var dir = Path.GetDirectoryName(_configPath) ?? ".";
                var watcher = new FileSystemWatcher(dir, Path.GetFileName(_configPath))
                {
                    NotifyFilter = NotifyFilters.LastWrite,
                    EnableRaisingEvents = true
                };
                watcher.Changed += (_, _) => Win32.PostMessage(_hwnd, Win32.WM_RELOAD, IntPtr.Zero, IntPtr.Zero);
                watcher.Created += (_, _) => Win32.PostMessage(_hwnd, Win32.WM_RELOAD, IntPtr.Zero, IntPtr.Zero);
            }

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
                Win32.TranslateMessage(ref msg);
                Win32.DispatchMessage(ref msg);
            }
        }

        private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            if (msg == Win32.WM_HOTKEY)
            {
                int id = wParam.ToInt32();
                if (_idToItem.TryGetValue(id, out var item))
                {
                    Broadcast(JsonSerializer.Serialize(new
                    {
                        type = "hotkey",
                        id = item.Id,
                        action = item.Action,
                        brush = item.Brush
                    }));
                }
                return IntPtr.Zero;
            }
            if (msg == Win32.WM_RELOAD)
            {
                try { ReloadConfig(); }
                catch (Exception ex) { Console.WriteLine("[HotkeyDaemon] 重载配置失败: " + ex.Message); }
                return IntPtr.Zero;
            }
            return IntPtr.Zero;
        }

        // 仅读取配置文件 -> 列表（不注册）
        private static List<HotkeyItem> ReadConfigFile()
        {
            if (!File.Exists(_configPath)) return new List<HotkeyItem>();
            try
            {
                var json = File.ReadAllText(_configPath);
                return JsonSerializer.Deserialize<List<HotkeyItem>>(json) ?? new List<HotkeyItem>();
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

        private static void RegisterAll()
        {
            UnregisterAll();
            foreach (var it in _currentItems)
            {
                if (string.IsNullOrWhiteSpace(it.Combo)) continue;
                var (mods, vk) = ParseCombo(it.Combo);
                if (vk == 0)
                {
                    Console.WriteLine("[HotkeyDaemon] 跳过无效组合键(无法解析实体键): " + it.Combo);
                    continue;
                }
                int id = _nextId++;
                if (Win32.RegisterHotKey(_hwnd, id, mods, vk))
                    _idToItem[id] = it;
                else
                    Console.WriteLine("[HotkeyDaemon] 注册失败(可能冲突): " + it.Combo);
            }
            _active = true;
            BroadcastConfig();
        }

        private static void UnregisterAll()
        {
            foreach (var id in _idToItem.Keys) Win32.UnregisterHotKey(_hwnd, id);
            _idToItem.Clear();
            _nextId = 1;
            _active = false;
        }

        // 落盘并热更新
        private static void SaveConfig(List<HotkeyItem> items)
        {
            try
            {
                var dir = Path.GetDirectoryName(_configPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(_configPath, JsonSerializer.Serialize(items, new JsonSerializerOptions { WriteIndented = true }));
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
                    try
                    {
                        using var doc = JsonDocument.Parse(text);
                        if (!doc.RootElement.TryGetProperty("type", out var typeEl)) continue;
                        var type = typeEl.GetString();
                        if (type == "config")
                        {
                            if (doc.RootElement.TryGetProperty("payload", out var payload))
                            {
                                var items = JsonSerializer.Deserialize<List<HotkeyItem>>(payload.GetRawText()) ?? new List<HotkeyItem>();
                                SaveConfig(items);
                            }
                        }
                        else if (type == "getConfig")
                        {
                            SendConfigToClient(client);
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
                lock (_clientsLock) _clients.Remove(client);
                try { client.Close(); } catch { }
            }
        }

        private static void SendConfigToClient(TcpClient client)
        {
            var items = ReadConfigFile();
            SendToClient(client, JsonSerializer.Serialize(new { type = "config", payload = items }));
        }

        private static void BroadcastConfig()
        {
            var items = ReadConfigFile();
            var msg = JsonSerializer.Serialize(new { type = "config", payload = items });
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
            if (opcode == 0x8) return null;       // close
            if (opcode != 0x1) return "";          // 非文本帧忽略
            return Encoding.UTF8.GetString(payload);
        }

        private static void Broadcast(string message)
        {
            var bytes = Encoding.UTF8.GetBytes(message);
            var frame = new byte[2 + bytes.Length];
            frame[0] = 0x81; // FIN + 文本帧
            frame[1] = (byte)bytes.Length; // 假设消息 < 126 字节（足够 JSON 短消息）
            Array.Copy(bytes, 0, frame, 2, bytes.Length);
            lock (_clientsLock)
            {
                foreach (var c in _clients.ToArray())
                {
                    try { c.GetStream().Write(frame, 0, frame.Length); }
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
