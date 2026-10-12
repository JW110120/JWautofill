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
using Microsoft.Win32;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace JWautofillDaemon
{
    public class HotkeyItem
    {
        public string Id { get; set; } = "";
        public string Combo { get; set; } = "";   // 例如 "Ctrl+Shift+R"、"Alt+F1"、"B"
        public string Action { get; set; } = "";   // "toggleMain" | "applyBrush"
        public string Brush { get; set; } = "";    // applyBrush 时使用的笔刷标识
    }

    /// <summary>
    /// 套索实时平滑的参数快照（由 UXP 面板经 smoothParams 下发）。
    ///
    /// ⚠️ 设计成**不可变引用、整体替换**：鼠标钩子线程只做一次 volatile 读就拿走整份
    ///    参数，绝不在钩子回调里加锁（加锁 = 输入链冻结，与键盘钩子的铁律同源）。
    ///
    /// 字段语义见 docs/lasso-realtime-smoothing-plan.md 第 3.3 节：
    ///   Mode          0 = 标准（一阶低通）/ 1 = 拉绳 / 2 = 追笔
    ///   Strength      平滑强度 0–100（标准模式的主轴：越大越黏）
    ///   Radius        最大滞后距离（px）—— 三种模式统一收口的硬上限，同时是拉绳的绳长基准
    ///   Tension       拉绳松紧 0–100（映射到绳长占 Radius 的比例）
    ///   CatchUp       追笔速度 0–100（映射到 0.2–12.2 px/ms）
    ///   CornerAngle   拐角判定 0–90（夹角超过它即减弱平滑，保住尖角）
    ///   SpeedAdaptive 甩笔时自动减弱平滑
    ///   MinSampleDist 最小注入间距（px）—— 抽稀，减少无意义的事件注入
    /// </summary>
    internal sealed class LassoSmoothSettings
    {
        public int Mode { get; set; } = 0;
        public double Strength { get; set; } = 40;
        public double Radius { get; set; } = 8;
        public double Tension { get; set; } = 50;
        public double CatchUp { get; set; } = 50;
        public double CornerAngle { get; set; } = 45;
        public bool SpeedAdaptive { get; set; } = true;
        public double MinSampleDist { get; set; } = 1;
    }

    /// <summary>
    /// 拖拽轨迹滤波器：三种模式共用同一套骨架与同一份状态。
    ///
    /// ⛔ 本类的所有方法都在**鼠标钩子线程**上被调用，必须满足与键盘钩子完全相同的铁律：
    ///    均摊 O(1)、**零分配**、无锁、无 I/O、不抛异常。任何一帧的超时都会让 Windows
    ///    静默摘除低层钩子（LowLevelHooksTimeout），届时平滑无声失效、且不会被通知。
    ///
    /// 与「选区生成之后再平滑」的本质区别：这里作用的是**输入轨迹**，所以 PS 的套索、
    /// 历史记录、工具选项（羽化 / 抗锯齿 / 加减选）全部保持原生行为，零兼容成本。
    /// </summary>
    internal sealed class LassoMouseSmoother
    {
        // 输出位置保留小数：逐帧取整会丢亚像素位移，慢速拖动时会「粘住不动」
        private double _ox, _oy;
        private int _lastInX, _lastInY;     // 上一帧原始输入
        private double _speed;              // 低通后的输入速度（px/ms）
        private double _dirX, _dirY;        // 上一段输入方向（单位向量）
        private bool _hasDir;
        private long _lastTicks;
        private int _lastInjX, _lastInjY;   // 上一次真正注入的位置（最小采样间距的基准）

        private static double Clamp01(double v) => v < 0 ? 0 : (v > 1 ? 1 : v);

        /// <summary>
        /// 起笔锚定：输出点严格落在按下位置 —— 起笔不允许有任何跟随滞后，
        /// 否则套索的第一个点就会偏离用户按下的地方（表现为「选区起点被吃掉一块」）。
        /// </summary>
        internal void Reset(int x, int y, long nowMs)
        {
            _ox = x; _oy = y;
            _lastInX = x; _lastInY = y;
            _speed = 0;
            _dirX = 0; _dirY = 0; _hasDir = false;
            _lastTicks = nowMs;
            _lastInjX = x; _lastInjY = y;
        }

        /// <summary>
        /// 推进一帧。<paramref name="tx"/>/<paramref name="ty"/> 恒为该帧应处的输出位置；
        /// 返回 false 表示「位移不足 minSampleDist，本帧不注入」（调用方仍应吞掉原始事件）。
        /// </summary>
        internal bool Step(int x, int y, long nowMs, LassoSmoothSettings s, out int tx, out int ty)
        {
            long dt = nowMs - _lastTicks;
            if (dt < 1) dt = 1;
            else if (dt > 100) dt = 100;    // 卡顿/暂停之后不按超长时间片推进，避免凭空跳跃
            _lastTicks = nowMs;

            int idx = x - _lastInX;
            int idy = y - _lastInY;
            _lastInX = x; _lastInY = y;
            double segLen = Math.Sqrt((double)idx * idx + (double)idy * idy);

            // 速度低通：单帧抖动不该让「速度自适应」忽开忽关
            _speed = _speed * 0.72 + (segLen / dt) * 0.28;

            // 拐角检测：与上一段输入方向的夹角超过阈值 ⇒ 本帧减弱平滑，保住尖角
            bool corner = false;
            if (segLen > 0.01)
            {
                double ux = idx / segLen, uy = idy / segLen;
                if (_hasDir)
                {
                    double dot = ux * _dirX + uy * _dirY;
                    if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
                    if (Math.Acos(dot) * 180.0 / Math.PI >= s.CornerAngle) corner = true;
                }
                _dirX = ux; _dirY = uy; _hasDir = true;
            }

            double distX = x - _ox, distY = y - _oy;
            double dist = Math.Sqrt(distX * distX + distY * distY);

            if (s.Mode == 1)
            {
                // ===== 拉绳：光标与笔尖之间系一根「长度 = 绳长」的绳子 =====
                // 距离超过绳长 ⇒ 把输出点拖到恰好绳长处；未超过 ⇒ 只做轻微跟随
                // （纯拉绳在慢速移动时会完全停住，观感像卡死）。
                double rope = 1.0 + Math.Max(0.0, s.Radius - 1.0) * (0.15 + 0.85 * Clamp01(s.Tension / 100.0));
                if (dist > rope && dist > 0.0001)
                {
                    double f = rope / dist;
                    _ox += distX * f; _oy += distY * f;
                }
                else
                {
                    _ox += distX * 0.25; _oy += distY * 0.25;
                }
            }
            else if (s.Mode == 2)
            {
                // ===== 追笔：输出端以受限速度追赶光标，追上即贴合 =====
                double vmax = 0.2 + Clamp01(s.CatchUp / 100.0) * 12.0;   // px/ms
                double step = vmax * dt;
                if (dist > step && dist > 0.0001)
                {
                    double f = step / dist;
                    _ox += distX * f; _oy += distY * f;
                }
                else
                {
                    _ox = x; _oy = y;
                }
            }
            else
            {
                // ===== 标准：一阶低通（指数趋近）=====
                // k 随强度指数下降 ⇒ 滑杆低段细腻、高段仍能到「很黏」；强度 0 时 k = 1（不平滑）。
                double k = Math.Pow(0.18, Clamp01(s.Strength / 100.0));
                if (s.SpeedAdaptive)
                {
                    // 甩笔时自动减弱平滑：速度越高越贴手，避免「快速拖拽被甩在后面」
                    double boost = Math.Min(1.0, _speed / 1.2) * 0.5;
                    k += (1.0 - k) * boost;
                }
                if (corner) k = Math.Max(k, 0.75);
                _ox += distX * k; _oy += distY * k;
            }

            // ===== 全局「最大滞后」上限（Radius）=====
            // 三种模式统一收口：无论算法怎么算，输出点与光标的距离都不超过 Radius。
            // 一石二鸟：① 给强度滑杆一个直观上界；② 防止快速移动时过度甩尾、拐角被削圆。
            double lagX = x - _ox, lagY = y - _oy;
            double lag = Math.Sqrt(lagX * lagX + lagY * lagY);
            double radius = s.Radius < 1 ? 1 : s.Radius;
            if (lag > radius && lag > 0.0001)
            {
                double f = (lag - radius) / lag;
                _ox += lagX * f; _oy += lagY * f;
            }

            tx = (int)Math.Round(_ox);
            ty = (int)Math.Round(_oy);

            int dxi = tx - _lastInjX, dyi = ty - _lastInjY;
            double moved = Math.Sqrt((double)dxi * dxi + (double)dyi * dyi);
            if (moved < s.MinSampleDist) return false;   // 抽稀：位移不足 ⇒ 本帧只吞事件、不注入
            _lastInjX = tx; _lastInjY = ty;
            return true;
        }
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

        // ===== 全局鼠标钩子（套索实时平滑：输入层滤波）=====
        // 与键盘钩子同源，但**独立安装**在各自的线程上：Windows 把低层钩子回调串行派发到
        // 「安装它的那个线程」，共用线程会让鼠标回调的耗时连带拖慢键盘回调（反之亦然）。
        // 这里的职责只有一个：把拖拽过程中的原始鼠标位移替换成滤波后的位移（吞原事件 + 回注），
        // 从而让 Photoshop 的套索工具「天然」画出平滑轨迹 —— PS 侧完全不知情。
        public const int WH_MOUSE_LL = 14;
        public const int WM_MOUSEMOVE = 0x0200;
        public const int WM_LBUTTONDOWN = 0x0201;
        public const int WM_LBUTTONUP = 0x0202;
        /** 注入事件标志位：本进程注入的事件必须被识别并直接放行，否则会自激成输入风暴。 */
        public const uint LLMHF_INJECTED = 0x00000001;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

        // ⚠️ 必须写 EntryPoint：托管名与导出名不同（导出名仍是 SetWindowsHookEx）。
        [DllImport("user32.dll", EntryPoint = "SetWindowsHookEx", SetLastError = true)]
        public static extern IntPtr SetWindowsHookExMouse(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        // ===== DPI 感知（决定绝对注入的坐标口径）=====
        // ⛔ 为什么守护进程必须 DPI 感知：回注走 MOUSEEVENTF_ABSOLUTE | VIRTUALDESK，
        //    其分母来自 GetSystemMetrics(SM_*VIRTUALSCREEN)。DPI-unaware 进程拿到的是**被系统
        //    缩放后的逻辑尺寸**，而 SendInput 的绝对坐标按物理像素解释 ⇒ 非 100% 缩放的机器上
        //    光标会画到错误位置（本机 100% 缩放测不出来）。声明 PerMonitorV2 后，
        //    GetSystemMetrics / GetCursorPos / 低层钩子的 pt / WindowFromPoint 全部统一为物理像素。
        //    主手段是清单（native/app.manifest，加载期生效）；下面的运行时调用只作兜底。
        public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
        public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE = new IntPtr(-3);

        /** 运行时兜底：清单未生效时把本进程拉成 PerMonitorV2。已设定过则失败，属预期。 */
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetThreadDpiAwarenessContext();

        /** 返回 DPI_AWARENESS：0=unaware 1=system 2=permonitor -1=invalid。 */
        [DllImport("user32.dll", SetLastError = true)]
        public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);

        /** 读系统设置。SPI_GETMOUSE(0x0003) 取回 [threshold1, threshold2, acceleration]。 */
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, int[] pvParam, uint fWinIni);

        public const uint SPI_GETMOUSE = 0x0003;
        public const int SM_CXSCREEN = 0;
        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;

        /** 取某点所在窗口。用于把「拖拽是否起始于 Photoshop 窗口」作为布防的第四道闸门。 */
        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT point);

        // ===== 回注（SendInput）=====
        // 用 SendInput 而非已废弃的 mouse_event：前者在 UIPI / 输入栈层面更可靠，
        // 且能携带 dwExtraInfo（我们靠它给「自己注入的事件」打签名）。
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        // ⚠️ 这是 C 里 INPUT 的 union 的**最小可用投影**（只用到鼠标分支）。
        //    x64 下自然对齐会补出 4 字节填充 ⇒ 总长 40，与原生 INPUT 一致；
        //    改结构体布局前请先用 Marshal.SizeOf 复核，长度不符会让 SendInput 静默失败。
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public MOUSEINPUT mi;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        public const uint INPUT_MOUSE = 0;
        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

        // 焦点判断（用于「焦点不在 PS 时暂停监听」）：取当前前台窗口所属进程 PID。
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

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
        internal const string Version = "2026-10-12.6";

        // ===== 角色（编译期决定：一份源码 → 两个**互不共享**的独立产物）=====
        // ⛔ 为什么必须走到进程级：热键与平滑此前共用一个进程，于是面板的「停止 / 卸载快捷键服务」
        //    一执行，两个钩子一起消失，平滑状态行随即变成「未连接快捷键服务」。
        //    子系统级的 hotkeyArm 只能解决「运行期卸不卸钩子」，救不了进程级的启停/卸载。
        //    现在编译出两份 exe，各自拥有：exe 名、WS 端口、安装目录、开机自启项、卸载入口、
        //    日志文件 —— 停掉或卸载任意一侧，另一侧完全不受影响（进程都不同）。
        //
        // ⚠️ 默认（不定义 ROLE_SMOOTH）= 热键侧，且**保持既有全部行为与路径不变**
        //    （安装目录仍是 `%LOCALAPPDATA%\JWautofill\daemon`、端口仍是 18923），
        //    以免存量机器上的旧副本因为这次拆分而变成删不掉的孤儿。
#if ROLE_SMOOTH
        internal const string ProductName = "JWautofillSmoothDaemon";  // exe 名 / 自启项名 / 进程名
        internal const string RoleLabel = "平滑";
        private const string InstallFolderName = "smooth";             // %LOCALAPPDATA%\JWautofill\smooth
        private const int DefaultPort = 18924;
        private const string LogPrefix = "[SmoothDaemon]";
#else
        internal const string ProductName = "JWautofillHotkeyDaemon";
        internal const string RoleLabel = "热键";
        private const string InstallFolderName = "daemon";
        private const int DefaultPort = 18923;
        private const string LogPrefix = "[HotkeyDaemon]";
#endif

        // 协议版本与能力位：让面板能识别「连上的守护进程是不是支持某套子系统」。
        // ⛔ 为什么必须有：旧版守护进程收到 smoothArm 会**静默忽略**（未知 type 被丢弃），
        //    面板于是永远收不到 smoothState ⇒ hookInstalled 恒为 false ⇒ 被误报成
        //    「启动失败（被安全软件拦截）」，把排查引向安全软件这条完全错误的方向。
        //    有了它，面板可以如实报「守护进程版本过旧，请重启/更新」。
        // ⚠️ 拆分后 features **按角色给出**：面板据此判断「这个端口上跑的是哪一套服务」。
        internal const string ProtocolVersion = "2.0";
        internal static readonly string[] Features =
        {
#if ROLE_SMOOTH
            "smooth",           // 套索实时平滑（鼠标低层钩子 + 回注）
            "smoothState",      // 平滑健康状态上报
            "watchdogs",        // 独立看护线程（线程存活探针 + 熔断自愈）
#else
            "hotkey",           // 全局键盘钩子（热键 / 录制 / 退格删除）
            "hotkeyArm",        // 热键钩子可在运行期独立装卸
            "hotkeyState",      // 独立的热键健康状态上报
            "watchdogs",        // 独立看护线程（线程存活探针 + 熔断自愈）
#endif
        };

        private static readonly int PORT = DefaultPort;
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
        // ⚠️ 以下三个字段会被「键盘钩子线程」直接读取，同时被其它线程整体替换。
        // 必须声明为 volatile：保证钩子线程看到的是完整发布后的引用/值。
        // 更重要的是：钩子回调路径上绝不获取任何锁——一旦锁被其它线程持有，
        // 钩子回调就会阻塞，而低层键盘钩子阻塞 = 整个系统的键盘输入被冻结。
        // 若系统注册表的 LowLevelHooksTimeout 被设得过大（有的机器上高达 25000 毫秒），
        // 一次阻塞就会让键盘几十秒乃至持续无响应。这是「键盘打不出字」的根因。
        private static volatile Dictionary<string, HotkeyItem> _comboMap = new(StringComparer.OrdinalIgnoreCase);
        private static List<HotkeyItem> _currentItems = new();
        private static volatile bool _active = false;
        // 当前运行的 Photoshop 进程 PID 集合（由 WatchPhotoshop 周期刷新）。
        // 钩子线程在每次按键时据此判断前台窗口是否属 PS，避免在其它程序里拦截按键。
        // volatile：钩子线程每次按键都要读它，因此读取路径上绝不加锁
        // （锁竞争会阻塞钩子回调 → 全系统键盘冻结）。写入方整体替换集合后再发布引用。
        private static volatile HashSet<int> _psPids = new();
        private static readonly object _clientsLock = new();
        private static readonly List<TcpClient> _clients = new();
        private static IntPtr _hwnd;
        private static FileSystemWatcher? _watcher;
        // 主线程 ID：钩子命中后通过线程消息把「命中事件」交给主线程广播，
        // 避免在键盘钩子里做网络 I/O（钩子有严格超时，超时会被系统静默摘除）。
        private static int _mainThreadId = 0;
        private static readonly ConcurrentQueue<string> _hitQueue = new();
        // 日志统一走队列：任何线程（含键盘钩子线程）只入队、绝不直接做文件 I/O，
        // 由专门的日志线程落盘。此前钩子线程在 DrainLogQueue 里直接 Console.WriteLine 写文件，
        // 一旦写阻塞，钩子消息循环卡死 → 全键盘失灵（只有杀进程/卸载才恢复）。
        // Console.WriteLine 已重定向为「入队」，故钩子线程的日志也不会触碰文件句柄。
        private static readonly BlockingCollection<string> _logQueue =
            new(new ConcurrentQueue<string>());

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
        // 录制状态：钩子线程只读这个 volatile 布尔量，绝不进入 _recLock。
        private static volatile bool _recording = false;
        // 录制「待确认」组合键（两段式录制第二阶段）：
        // null = 捕获阶段（等待用户按下组合键）；非 null = 确认阶段（已捕获，等待回车确认）。
        // 只在钩子线程上读写（StartRecording / FinishRecording / HookDispatch 同在钩子线程串行执行），无需加锁。
        private static string? _recPendingCombo = null;
        // ===== 退格删除绑定（「单击选中条目 + 非录制态按退格 = 解绑」通路）=====
        // 面板里某条快捷键被单击选中后，面板发 armDelete 布防；此后在 PS 前台按退格，
        // 钩子把 backspaceDelete 回给布防的客户端并吞掉按键（PS 里退格会唤出「填充」对话框）。
        // 与录制互斥：录制期间退格不参与任何逻辑（既不绑定、也不删除）。
        private static volatile string? _deleteArmOwner = null; // null = 未布防
        private static TcpClient? _deleteArmClient;
        private static readonly object _armLock = new();
        // 熔断标志：一旦检测到钩子回调耗时超过预算，立即切换到「只放行、不处理」模式。
        // 宁可快捷键失效，也绝不让本进程的钩子再把系统键盘拖住。
        // ⚠️ 与 _mouseHookSafeMode **完全独立**：任一侧熔断只影响自己那一侧。
        private static volatile bool _hookSafeMode = false;
        // 熔断时刻（TickCount64；0 = 未熔断）。冷却期满由**本子系统自己的**看护线程复位并重挂。
        // ⛔ 熔断必须是可自愈的：低层钩子回调一次卡顿（GC/页面交换/驱动抖动）就会触发熔断，
        //    若做成单向闩锁，一次抖动就永久废掉快捷键（或平滑），只能重启进程才能恢复。
        private static long _hookSafeModeSince = 0;
        // 单次钩子回调的耗时预算（毫秒）。Windows 对低层钩子有超时限制，超时会被系统摘除；
        // 这里设得更保守，超预算即自我熔断，确保不会成为系统输入链的瓶颈。
        private const long HookBudgetMs = 100;
        /** 熔断冷却时长：期满自动复位该子系统的熔断标志并重挂钩子。 */
        private const long SafeModeCooldownMs = 30000;
        // 录制线程：持有独立消息循环，全局键盘钩子必须装在带消息循环的线程上
        private static int _recThreadId = 0;
        private static readonly ManualResetEventSlim _recThreadReady = new(false);
        /** 承载键盘钩子的线程对象：看护线程据此做存活探针（线程意外死亡 ⇒ 重建）。 */
        private static Thread? _recThreadRef;

        // ===== 键盘钩子的运行期启停（与鼠标钩子解耦的关键一环）=====
        // 此前键盘钩子只在进程启动时装一次、只有「全局卸载」才卸，因此「禁用热键」只能靠清空
        // 热键表让钩子空转 —— 钩子本身仍挂在系统输入链上，且没有任何运行期卸载通路。
        // 现在它与鼠标钩子一样有自己的装卸指令（WM_HOOK_INSTALL / WM_HOOK_UNINSTALL），
        // 装卸只作用于 _hookId，**绝不触碰 _mouseHookId / _smoothArm**。
        private static volatile bool _hotkeyArmed = true;
        private const int WM_HOOK_UNINSTALL = 0x8008; // 录制线程：卸载常驻低层键盘钩子

        // ===== 套索实时平滑：鼠标低层钩子的布防状态与健康指标 =====
        // 🔴 与键盘钩子**完全独立**的一整套状态：独立线程、独立句柄、独立熔断标志。
        //    理由：两者的失效模式完全不同（键盘失效 = 打不出字；鼠标失效 = 指针卡住），
        //    共用任何一项都会让「一边出问题导致另一边陪葬」。
        private const int WM_MOUSE_HOOK_INSTALL = 0x8006;
        private const int WM_MOUSE_HOOK_UNINSTALL = 0x8007;
        private static int _mouseThreadId = 0;
        private static readonly ManualResetEventSlim _mouseThreadReady = new(false);
        /** 承载鼠标钩子的线程对象：看护线程据此做存活探针（线程意外死亡 ⇒ 重建）。 */
        private static Thread? _mouseThreadRef;
        private static IntPtr _mouseHookId = IntPtr.Zero;
        private static Win32.LowLevelMouseProc? _mouseHookProc;   // 保持引用，避免被 GC 后钩子崩溃
        private static volatile bool _mouseHookSafeMode = false;
        /** 熔断时刻（TickCount64；0 = 未熔断）。与 _hookSafeModeSince 各自独立，冷却期满各自自愈。 */
        private static long _mouseSafeModeSince = 0;
        /**
         * 单次鼠标钩子回调的耗时预算（毫秒）。超预算即降级为「纯放行」，宁可平滑失效也不拖累系统输入。
         *
         * ⛔ 这个值的历史：原先取 120ms，是因为回调里**必然**含一次同步 `SendInput`，而它偶发会被
         *    输入栈阻塞到 Windows 的 LowLevelHooksTimeout（默认 300ms，真机实测 304~315ms）。
         *    那个设计本身是错的 —— 用「放宽预算」去迁就一个不该存在的阻塞，
         *    结果是熔断形同虚设（每笔只出现一帧超预算，连续计数总被清零），
         *    而每笔拖拽都在冻结全系统输入数百毫秒。
         *    现在回注已搬到独立线程（见 InjectThreadProc），回调里只剩「算法 + 3 次 volatile 写」，
         *    实测应长期稳定在亚毫秒级 ⇒ 预算收紧到 50ms，重新具备「早发现重活回归」的能力。
         */
        private const long MouseHookBudgetMs = 50;
        /**
         * **连续**超预算多少次才真正熔断。
         *
         * ⛔ 单次超预算不能熔断：托管环境的 GC 停顿、调度抖动都可能让某一帧偶发变慢，
         *    若「一次即断」，一次转瞬即逝的卡顿就毁掉接下来 30s 的平滑。
         *    ≥3 次连续才说明这条回路真的不健康（对照：曾经那 300ms 的阻塞是**每笔都可能出现**）。
         *    恢复正常即清零计数器。
         */
        private const int SafeModeStrikes = 3;
        /**
         * 是否已布防。只有它为真、**且** PS 处于前台、**且**左键按下、**且**按下点落在 PS 窗口上，
         * 才可能拦截鼠标事件（四道闸门缺一不可，见 SmoothMouseDispatch）。
         * 由 UXP 面板经 smoothArm 下发：当前工具是套索且平滑选项已启用时布防。
         */
        private static volatile bool _smoothArm = false;
        /** 参数快照：不可变引用整体替换（钩子线程只读一次、不加锁）。 */
        private static volatile LassoSmoothSettings _smoothParams = new LassoSmoothSettings();
        /** 是否正处在「本进程接管中的一次拖拽」。只在鼠标钩子线程上读写；看护线程只读一次做判断。 */
        private static volatile bool _smoothDragging = false;
        /** 本进程注入事件的签名：回注时写入 dwExtraInfo，钩子据此把自己的事件直接放行（防回环）。 */
        private static readonly IntPtr SmoothInjectSignature = new IntPtr(0x4A574155); // 'JWAU'
        private static readonly LassoMouseSmoother _smoother = new LassoMouseSmoother();
        /** 健康指标（Interlocked 累加，供 getState / smoothState 上报，排障时先看这里）。 */
        private static long _smoothHookCallbacks = 0;
        private static long _smoothInjected = 0;
        private static long _smoothLastCallbackTick = 0;
        private static long _smoothLastInstallTick = 0;
        /** 最近一次拖拽的原始点数 / 注入点数 —— 「吞了事件却没注入」这类异常最直接的判据。 */
        private static int _smoothLastDragRaw = 0;
        /** 本笔「已发布待回注」的目标点数（钩子线程侧计数）。 */
        private static int _smoothLastDragInjected = 0;
        /** 本笔回注线程**实际执行**的 SendInput 次数（合并后通常略少于发布数）。 */
        private static int _smoothLastDragFlushed = 0;
        private static int _smoothDragRaw = 0;
        private static int _smoothDragInjected = 0;
        private static int _injectDragDone = 0;

        // ===== 回注线程：把 `SendInput` 从钩子回调里彻底搬走 =====
        //
        // ⛔⛔ 为什么必须搬走（真机实测，本轮定案）：
        //    在 `WH_MOUSE_LL` 回调里**同步**调用 `SendInput`，注入事件要等本回调返回才能入队，
        //    而系统又在等回调返回 —— 直到 Windows 的 `LowLevelHooksTimeout`（默认 **300ms**）
        //    超时才解开。真机日志的每一次拖拽都长这样：
        //        「本次拖拽原始 191 点 / 注入 165 点（最差一帧 304ms，其中回注占 304ms）」
        //    最差帧 304~315ms 全部落在回注上，与 300ms 判据严丝合缝 ⇒ 每笔拖拽都可能把
        //    **整个系统输入队列冻结数百毫秒**；用户看到的就是「鼠标拖了很长、画布上只画了
        //    一小段，而且抖」。这也解释了为什么熔断（120ms×2 次）实际上从未触发：
        //    每笔只出现一帧超预算，连续计数总被清零。
        //
        // ✅ 现在的分工：钩子回调只写一个 volatile 目标位置 + 置事件（微秒级返回）；
        //    本线程独占 `SendInput`，且天然**合并**连续多帧 —— 只补最新位置，等价于抽稀。
        /** 钩子线程写入的「最新目标位置」；回注线程取走。volatile int 读写天然原子。 */
        private static volatile int _injectTargetX = 0;
        private static volatile int _injectTargetY = 0;
        private static volatile bool _injectRunning = false;
        private static Thread? _injectThread = null;
        private static readonly ManualResetEventSlim _injectSignal = new ManualResetEventSlim(false);
        /** 抬起时置真：等回注线程排空后再交看护线程打印本笔汇总（保证计数是最终值）。 */
        private static volatile bool _smoothDragLogArmed = false;
        /** 回注线程自身的耗时统计（不再参与钩子回调的预算判定，只做健康观测）。 */
        private static long _injectTotalCalls = 0;
        private static int _injectLastMs = 0;
        private static int _injectMaxMs = 0;
        private static long _injectOver100Ms = 0;
        /**
         * 回注线程「正在 SendInput」的起始时刻（TickCount64；0 = 空闲）。
         *
         * ⛔⛔ 这是本模块最重要的一道**安全网**。`SendInput` 在输入队列被别人占住时会
         *    **无限期**阻塞（不是超时，是死等）——真机已经复现：一次卡死之后，
         *    该进程即便收到退出指令也永远停不下来（线程卡在内核态不可中断，
         *    进程停在「已终止但对象不回收」的状态，端口也一直被占着）。
         *    而我们的钩子在「接管中」会**吞掉**原始鼠标移动 ⇒ 一旦回注线程卡住，
         *    光标就彻底不动了，用户会以为鼠标坏了。
         *    ⇒ 钩子每帧检查这个时间戳，超过 InjectStallGuardMs 未归还就**立即停止接管**
         *      （放行原始事件 + 熔断），宁可平滑失效也绝不让光标被我们冻住。
         */
        private static long _injectBusySince = 0;
        /** 回注线程单次 SendInput 超过这个时长即判定为「疑似卡死」，钩子停止接管。 */
        private const long InjectStallGuardMs = 400;

        // ===== 回调耗时拆解（零 I/O 埋点）=====
        // ⛔ 存在的意义：钩子回调里严禁 I/O，所以「为什么这一帧花了 306ms」不能靠打日志回答。
        //    这里只把耗时写进内存字段，由 SmoothWatchdog 经 smoothState 上报。
        //    ⚠️ 搬走回注之后，回调自身应当长期稳定在 **亚毫秒~2ms**；若 maxCbMs 再次飙到几十上百 ms，
        //       说明又有人在回调里做了重活（I/O / 分配 / 系统调用），直接查这里。
        private static int _mouseCbLastTotalMs = 0;    // 上一次回调总耗时
        private static int _mouseCbMaxTotalMs = 0;     // 本次拖拽窗口内的最差一帧（起笔时清零）
        /**
         * **历史最差的一次超预算帧**及其回注耗时（**永不重置**）。
         *
         * ⛔ 为什么必须有「永不重置」的一份：上面那份 max 随每一笔清零，等你去查的时候往往已经
         *    被下一次拖拽覆盖了。而真正要回答的问题是「那 306ms 里有多少是 `SendInput`」——
         *    这决定了修法：全是回注 ⇒ 得把回注挪出钩子回调；不是 ⇒ 得查其它分支。
         */
        private static int _mouseCbWorstOverTotalMs = 0;
        private static int _mouseCbWorstOverInjectMs = 0;
        private static long _mouseCbOverBudgetTotal = 0;  // 累计超预算次数
        private static int _mouseCbStrikes = 0;           // 当前连续超预算计数

        // ===== 钩子 → 看护线程的「待打印日志」（钩子内绝不做 I/O）=====
        // 真机教训：`Console.WriteLine` 放在回调里，即便已重定向为入队，仍会分配字符串、触碰共享队列；
        // 而实测「慢的那一帧」恰好是唯一带日志的分支（抬起那一下）。现在钩子只置一个 volatile 标志，
        // 由看护线程在下一轮（≤120ms）取走打印。
        private static volatile bool _smoothPendingDragLog = false;
        private static volatile bool _smoothPendingBreakLog = false;
        private static int _smoothBreakElapsedMs = 0;
        /** 熔断原因（钩子线程写、看护线程读）——决定日志措辞，也决定能不能自动复位。 */
        private static volatile int _smoothBreakReason = BreakReasonCallbackBudget;
        private const int BreakReasonCallbackBudget = 0;
        private const int BreakReasonInjectStall = 1;
        private static volatile bool _hotkeyPendingBreakLog = false;
        private static int _hotkeyBreakElapsedMs = 0;
        private static int _hookSafeModeStrikes = 0;   // 键盘侧的连续超预算计数（仅钩子线程读写）
        /** 布防方：该客户端断开时自动撤防（否则钩子会一直挂在系统上）。 */
        private static readonly object _smoothLock = new();
        private static TcpClient? _smoothArmClient;

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

        // 安装目录（与 install.ps1 保持一致）：拷贝到这里运行，避免锁住插件目录，
        // 且开机自启指向稳定路径。
        // ⚠️ 拆分后两个角色各占一个**独立子目录**：卸载任意一侧只会 rmdir 自己那一份，
        //    绝不会连带删掉另一侧（这正是「两个服务互不影响」在文件系统层面的落点）。
        private static string InstallDir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "JWautofill", InstallFolderName);
        private static string InstalledExePath => Path.Combine(InstallDir, ProductName + ".exe");

        // 把标准输出/错误重定向到日志文件：守护进程是 GUI 子系统、无控制台窗口，
        // 所有原本打向控制台的诊断信息改落盘，排障时不丢失。
        // 关键：Console 输出先入内存队列，由独立日志线程落盘——调用线程（含键盘钩子线程）
        // 绝不触碰文件句柄，避免文件写阻塞卡死钩子消息循环（会导致全键盘失灵）。
        private static StreamWriter? _logWriter;
        private static string LogFilePath => Path.Combine(InstallDir, "daemon.log");
        private static void RedirectConsoleToFile()
        {
            try
            {
                var dir = InstallDir;
                Directory.CreateDirectory(dir);
                // ⛔ 用 **Append 而不是 Create**：Create 会让每次重启都抹掉上一轮日志，
                //    于是「守护进程忽然没了」这类问题永远查不到原因（真机踩过：进程消失后
                //    日志已被新进程覆盖，只剩一个空白的启动序列，无从判断它是被指令停掉的、
                //    还是自己退出的）。改为追加 + 每次启动写分隔行，历史证据得以保留。
                //    单文件超 1MB 时截断，避免长期累积。
                var path = LogFilePath;
                try
                {
                    var fi = new FileInfo(path);
                    if (fi.Exists && fi.Length > 1024 * 1024)
                    {
                        File.WriteAllText(path, LogPrefix + " （日志超过 1MB，已截断）" + Environment.NewLine);
                    }
                }
                catch { }
                var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                _logWriter = new StreamWriter(fs, Encoding.UTF8) { AutoFlush = true };
                _logWriter.WriteLine("---------- " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") +
                    " 启动 v" + Version + "（进程 " + Environment.ProcessId + "） ----------");
                Console.SetOut(new QueueTextWriter());
                Console.SetError(new QueueTextWriter());
                var lt = new Thread(LoggerThreadProc) { IsBackground = true };
                lt.Start();
            }
            catch { /* 日志重定向失败不影响运行 */ }
        }

        /// <summary>
        /// 兜底异常/退出记录：直接同步写文件（不走队列）。
        ///
        /// ⛔ 为什么必须有：守护进程是 GUI 子系统、无控制台，进程一旦因**未捕获异常**在后台线程
        ///    上终止，外部只看到「服务忽然没了」，Windows 事件日志也未必有记录（真机取证时
        ///    Application 日志里查不到任何 .NET Runtime 条目）。这里把异常与退出码直接落盘，
        ///    让「静默死亡」变成可查。
        /// ⚠️ 崩溃路径上队列不可靠（日志线程可能先死），所以刻意绕过队列同步写。
        /// </summary>
        private static void InstallCrashHandlers()
        {
            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            {
                DirectLog("🛑 未捕获异常（进程即将终止）: " + (e.ExceptionObject as Exception)?.ToString() ?? "未知");
            };
            AppDomain.CurrentDomain.ProcessExit += (_, __) =>
            {
                DirectLog("进程退出（ProcessExit）");
            };
            TaskScheduler.UnobservedTaskException += (_, e) =>
            {
                DirectLog("⚠️ 未观察的 Task 异常: " + e.Exception);
                e.SetObserved();   // 不观察会按旧策略升级为进程终止
            };
        }

        /** 直接同步落盘一行（崩溃/退出路径专用）。 */
        private static void DirectLog(string line)
        {
            try
            {
                Directory.CreateDirectory(InstallDir);
                File.AppendAllText(LogFilePath, line + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        // 唯一持有 _logWriter 的线程：从队列取行落盘。写失败只忽略，绝不回堵生产者。
        private static void LoggerThreadProc()
        {
            try
            {
                foreach (var line in _logQueue.GetConsumingEnumerable())
                {
                    try { _logWriter?.WriteLine(line); } catch { }
                }
            }
            catch { }
        }

        // 把 Console 输出重定向到内存队列（不写盘），由日志线程异步落盘。
        private class QueueTextWriter : TextWriter
        {
            private readonly StringBuilder _sb = new();
            public override Encoding Encoding => Encoding.UTF8;
            public override void Write(char value)
            {
                if (value == '\r') return;        // 跳过 \r，兼容 \r\n
                if (value == '\n') { FlushLine(); return; }
                _sb.Append(value);
            }
            public override void Write(string? value)
            {
                if (value == null) return;
                foreach (var c in value) Write(c);
            }
            private void FlushLine()
            {
                try { _logQueue.Add(_sb.ToString()); } catch { }
                _sb.Clear();
            }
            public override void Flush() { if (_sb.Length > 0) FlushLine(); }
        }

        // 自安装：若当前 exe 不在安装目录，则拷贝/更新到安装目录并从那里重新拉起自身
        // （原进程退出），保证常驻的是安装目录副本（卸载脚本可干净停止）。
        // 无论是否已安装，都确保注册开机自启。全程无窗口。
        private static void EnsureSelfInstalled()
        {
            try
            {
                var self = Process.GetCurrentProcess().MainModule?.FileName ?? "";
                if (string.IsNullOrEmpty(self)) return;
                bool alreadyInstalled = string.Equals(Path.GetFullPath(self), Path.GetFullPath(InstalledExePath), StringComparison.OrdinalIgnoreCase);

                if (!alreadyInstalled)
                {
                    try
                    {
                        Directory.CreateDirectory(InstallDir);
                        bool needCopy = true;
                        if (File.Exists(InstalledExePath))
                        {
                            try { needCopy = !string.Equals(GetFileHash(self), GetFileHash(InstalledExePath), StringComparison.OrdinalIgnoreCase); }
                            catch { needCopy = true; }
                        }
                        if (needCopy)
                        {
                            // 先停掉占用旧副本的实例，避免文件被锁导致拷贝失败
                            // ⛔ 必须 **Kill 之后 WaitForExit**：Process.Kill() 只是「请求终止」，
                            //    进程要过几毫秒才真正退出。不等它就会出现两个连带故障：
                            //      ① File.Copy 撞上未释放的文件锁 ⇒ 抛异常 ⇒ 被外层 catch 吞掉
                            //         ⇒ 安装目录里仍是旧 exe（"代码改了但机器上还是旧版"）；
                            //      ② 下面「安装副本是否已在跑」的枚举仍会把**刚被杀的进程**算作在跑
                            //         ⇒ otherRunning = true ⇒ 跳过拉起 ⇒ 本进程退出后
                            //         **机器上再无任何守护进程**（面板显示服务未启动，热键全失效）。
                            //    真机复现：第一次从插件目录启动新版时，就是被 ② 留成了空窗。
                            int stopped = 0;
                            foreach (var p in Process.GetProcessesByName(ProductName))
                            {
                                try
                                {
                                    if (p.Id == Process.GetCurrentProcess().Id) continue;
                                    if (!string.Equals(Path.GetFullPath(p.MainModule?.FileName ?? ""), Path.GetFullPath(InstalledExePath), StringComparison.OrdinalIgnoreCase))
                                        continue;
                                    p.Kill();
                                    try { p.WaitForExit(3000); } catch { }
                                    stopped++;
                                }
                                catch { }
                            }
                            File.Copy(self, InstalledExePath, true);
                            if (stopped > 0)
                                Console.WriteLine(LogPrefix + " 已停掉并等待 " + stopped + " 个旧副本退出，随后更新安装目录副本");
                        }
                    }
                    catch (Exception ex) { Console.WriteLine(LogPrefix + " 拷贝到安装目录失败（将以当前位置运行）: " + ex.Message); }
                }

                RegisterAutostart(InstalledExePath);

                // 源自插件目录（非安装目录）时，尽量切换到安装目录副本运行：
                // - 安装副本存在且未在跑 → 拉起它，本进程退出；
                // - 安装副本已在跑 → 不重复拉起，本进程直接退出（由已有副本服务）；
                // - 安装副本不存在（拷贝失败）→ 不退出，直接以当前位置运行（本次会话仍可用）。
                if (!alreadyInstalled)
                {
                    bool otherRunning = false;
                    if (File.Exists(InstalledExePath))
                    {
                        foreach (var p in Process.GetProcessesByName(ProductName))
                        {
                            try
                            {
                                if (p.Id != Process.GetCurrentProcess().Id &&
                                    string.Equals(Path.GetFullPath(p.MainModule?.FileName ?? ""), Path.GetFullPath(InstalledExePath), StringComparison.OrdinalIgnoreCase))
                                { otherRunning = true; break; }
                            }
                            catch { }
                        }
                        if (!otherRunning)
                        {
                            var psi = new ProcessStartInfo(InstalledExePath, "--autostart")
                            {
                                UseShellExecute = true,
                                WindowStyle = ProcessWindowStyle.Hidden,
                                CreateNoWindow = true
                            };
                            Process.Start(psi);
                        }
                        Environment.Exit(0);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine(LogPrefix + " 自安装跳过（将以当前位置运行）: " + ex.Message);
            }
        }

        // 注册/更新开机自启（当前用户，无需管理员）。指向安装目录副本，隐藏启动。
        // ⚠️ 自启项名 = ProductName：两个角色各注册各的，卸载一侧只删自己那一项。
        private static void RegisterAutostart(string exePath)
        {
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
                key?.SetValue(ProductName, "\"" + exePath + "\" --autostart");
            }
            catch (Exception ex) { Console.WriteLine(LogPrefix + " 注册开机自启失败（不影响本次运行）: " + ex.Message); }
        }

        private static string GetFileHash(string path)
        {
            using var md5 = MD5.Create();
            using var fs = File.OpenRead(path);
            var hash = md5.ComputeHash(fs);
            return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
        }

        // 读取系统对「低层钩子」的超时设置（毫秒）。
        // 这是键盘安全的 total 关键项：该值过大时，任何全局键盘钩子只要卡顿一下，
        // 整个系统的键盘输入就会被冻结这么久，表现为「打着打着突然打不出字」。
        // 系统默认约 300~1000 毫秒；某些机器上会被改到 25000 毫秒，届时一次卡顿即长时间失灵。
        private static int ReadLowLevelHooksTimeout()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop");
                var v = key?.GetValue("LowLevelHooksTimeout");
                if (v == null) return 0; // 未设置 = 使用系统默认
                return Convert.ToInt32(v);
            }
            catch { return 0; }
        }

        // 启动自检：仅在日志里给出醒目告警，不擅自修改用户注册表。
        // 需要一键复位时请从面板菜单执行「键盘卡死一键修复」。
        private static void CheckHookTimeoutRisk()
        {
            var ms = ReadLowLevelHooksTimeout();
            if (ms > 5000)
            {
                Console.WriteLine(LogPrefix + " ⚠️⚠️ 检测到系统键盘钩子超时设置过大：" +
                    "LowLevelHooksTimeout=" + ms + "ms（系统默认约 300~1000ms）。");
                Console.WriteLine(LogPrefix + "    该值过大时，任何全局键盘钩子一次卡顿就会冻结全系统键盘 " +
                    ms + "ms，是「键盘突然打不出字」的常见放大器。");
                Console.WriteLine(LogPrefix + "    建议在面板菜单执行「键盘卡死一键修复」复位为系统默认值。");
            }
            else
            {
                Console.WriteLine(LogPrefix + " 键盘钩子超时设置检查通过（LowLevelHooksTimeout=" +
                    (ms == 0 ? "系统默认" : ms + "ms") + "）");
            }
        }

        // 卸载：移除开机自启并删除安装目录（含自身），随后退出。
        // 由面板「卸载」指令（WebSocket type:"uninstall"）触发，全程无窗口。
        private static void DoUninstall()
        {
            try
            {
                Console.WriteLine(LogPrefix + " 开始卸载…");
                try
                {
                    using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
                    key?.DeleteValue(ProductName, false);
                }
                catch (Exception ex) { Console.WriteLine(LogPrefix + " 移除开机自启失败: " + ex.Message); }

                // 进程退出后再删目录（此时 exe 已不在运行，rmdir 不会因文件占用失败）
                var psi = new ProcessStartInfo("cmd.exe", "/c timeout /t 1 /nobreak > nul & rmdir /s /q \"" + InstallDir + "\"")
                {
                    WindowStyle = ProcessWindowStyle.Hidden,
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                Process.Start(psi);
            }
            catch (Exception ex) { Console.WriteLine(LogPrefix + " 卸载异常: " + ex.Message); }
            finally {
                // 显式卸载两个全局钩子：即便 Environment.Exit 略有延迟，也先释放钩子，
                // 避免进程退出前钩子仍挂在系统输入链上造成键盘/鼠标短暂失灵。
                try { if (_hookId != IntPtr.Zero) Win32.UnhookWindowsHookEx(_hookId); } catch { }
                try { if (_mouseHookId != IntPtr.Zero) Win32.UnhookWindowsHookEx(_mouseHookId); } catch { }
                Environment.Exit(0);
            }
        }

        /// <summary>
        /// DPI 感知的运行期兜底（主手段是 native/app.manifest 的清单声明）。
        ///
        /// ⛔ 为什么绝对注入离不开它：回注用 MOUSEEVENTF_ABSOLUTE | VIRTUALDESK，
        ///    dx/dy 是「相对虚拟桌面的 0..65535 归一化值」，分母取自 GetSystemMetrics。
        ///    DPI-unaware 进程读到的是**被缩放过的逻辑尺寸**（125% 缩放下比物理值小），
        ///    而 SendInput 的绝对坐标是按物理像素解释的 ⇒ 二者口径不一致，光标会画到错位置。
        ///    本机是 3440x1440 / 100%，测不出这个错位；换台 125% 的机器立刻显形。
        ///
        /// ⚠️ 必须在创建任何窗口 / 做任何输入相关调用**之前**执行，故放在 Main 的第一行。
        /// ⚠️ 已被清单设定过的进程会返回 false + ERROR_ACCESS_DENIED —— 这是**预期结果**
        ///   （恰恰说明清单已生效），不记日志也不重试。
        /// </summary>
        private static void EnsureDpiAwareness()
        {
            try
            {
                Win32.SetProcessDpiAwarenessContext(Win32.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            catch
            {
                // Win10 1607 之前没有这个 API（EntryPointNotFoundException）：
                // 那类系统由清单里的 <dpiAware>true/pm</dpiAware> 兜住，静默即可。
            }
        }

        /// <summary>
        /// 上报本进程的 DPI 感知级别（`getState` 的诊断字段）。
        /// ⛔ 存在意义：注入坐标的正确性完全取决于它，而它在 100% 缩放的机器上**看不出差别**
        ///   ⇒ 一旦有人报「光标画偏了」，第一件事就是确认这里是不是 permonitor-v2。
        /// </summary>
        private static string DpiAwarenessLabel()
        {
            try
            {
                var ctx = Win32.GetThreadDpiAwarenessContext();
                if (Win32.AreDpiAwarenessContextsEqual(ctx, Win32.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
                    return "permonitor-v2";
                if (Win32.AreDpiAwarenessContextsEqual(ctx, Win32.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE))
                    return "permonitor";
                switch (Win32.GetAwarenessFromDpiAwarenessContext(ctx))
                {
                    case 0: return "unaware";     // 最糟：非 100% 缩放时坐标换算必错
                    case 1: return "system";
                    case 2: return "permonitor";
                    default: return "invalid";
                }
            }
            catch { return "n/a"; }
        }

        static void Main(string[] args)
        {
            // ⛔ 第一件事：DPI 感知只能在创建窗口 / 触碰输入 API 之前设定。
            EnsureDpiAwareness();

            RedirectConsoleToFile();
            InstallCrashHandlers();
            _mainThreadId = Win32.GetCurrentThreadId();

            // 卸载模式：由面板的「卸载」指令拉起（type:"uninstall"），无窗口完成清理后退出。
            if (args.Any(a => a == "--uninstall"))
            {
                DoUninstall();
                return;
            }

            // 仅当参数是文件路径（不以 - 开头）时才当作配置文件，避免把 --autostart 等标志误当路径
            // （配置只属于热键侧；平滑侧不读任何配置，参数全部由面板经 WS 下发）
#if !ROLE_SMOOTH
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
#endif
            // 自安装（拷贝到安装目录 + 注册开机自启，必要时重新拉起自身）。
            // 若触发重新拉起，本进程会在此退出。
            // ⚠️ 两个角色各自的安装目录 / 自启项名 / exe 名都不同（见 ProductName / InstallFolderName），
            //    因此这里天然只会更新「自己那一份」，绝不会碰到另一侧。
            EnsureSelfInstalled();
            Console.WriteLine(LogPrefix + " 版本: " + Version + "（角色：" + RoleLabel + "，端口 " + PORT + "）");

#if !ROLE_SMOOTH
            Console.WriteLine(LogPrefix + " 配置路径: " + _configPath);
            CheckHookTimeoutRisk();

            SetupConfigWatcher();
            ReloadConfig();

            // 启动录制线程（独立消息循环，承载常驻低层键盘钩子）
            // ⚠️ 线程引用必须在**启动看护线程之前**写入：看护线程用 ref 它做存活探针
            //    （为 null 时视为「尚未创建」而跳过，避免误建出第二条钩子线程）。
            var recThread = new Thread(RecordingThreadProc) { IsBackground = true, Name = "键盘钩子" };
            _recThreadRef = recThread;
            recThread.Start();
            // 录制指令仍走 PostThreadMessage：此时录制线程已进入消息循环，队列必然存在
            _recThreadReady.Wait(5000);
#else
            // 鼠标钩子线程（套索实时平滑）：必须自带消息循环；未布防时不安装钩子，
            // 因此对系统输入零开销。健康看护线程随后负责「被系统静默摘钩」后的自愈。
            var mouseThread = new Thread(MouseHookThreadProc) { IsBackground = true, Name = "鼠标钩子" };
            _mouseThreadRef = mouseThread;
            mouseThread.Start();
            _mouseThreadReady.Wait(5000);

            // 回注线程：独占 SendInput。⛔ 绝不能在钩子回调里回注 —— 注入事件要等回调返回
            // 才能入队，而系统又在等回调返回，直到 LowLevelHooksTimeout(300ms) 才解开
            // （真机实测最差一帧 304~315ms，且 100% 是回注耗时）。
            _injectRunning = true;
            _injectThread = new Thread(InjectThreadProc) { IsBackground = true, Name = "平滑回注" };
            _injectThread.Priority = ThreadPriority.AboveNormal;   // 回注越即时，光标滞后越小
            _injectThread.Start();
#endif

            // 只启动**本角色**的看护线程。拆分后每个进程只有一个子系统，
            // 「一侧卡住拖住另一侧」在进程边界上已经不可能发生。
#if !ROLE_SMOOTH
            var hotkeyWatchdog = new Thread(HotkeyWatchdog) { IsBackground = true, Name = "热键看护" };
            hotkeyWatchdog.Start();
#else
            var smoothWatchdog = new Thread(SmoothWatchdog) { IsBackground = true, Name = "平滑看护" };
            smoothWatchdog.Start();
#endif

            _ = Task.Run(() => RunWebSocketServer());
            _ = Task.Run(WatchPhotoshop);

#if !ROLE_SMOOTH
            // 热键侧需要一个消息窗口承载「钩子 → 主线程」的线程消息（WM_HOTKEY_HIT）。
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

            Console.WriteLine(LogPrefix + " 已就绪，等待快捷键...");
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
#else
            // 平滑侧不需要窗口：钩子线程自带消息循环，主线程只需常驻。
            Console.WriteLine(LogPrefix + " 已就绪，等待面板下发平滑布防...");
            Thread.Sleep(Timeout.Infinite);
#endif
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
                Console.WriteLine(LogPrefix + " 配置监听初始化失败: " + ex.Message);
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
            Console.WriteLine(LogPrefix + " 配置路径已切换: " + newPath);
            try
            {
                var dir = Path.GetDirectoryName(newPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                // 迁移：新路径还没有配置文件、旧路径有时，把旧内容搬过去，避免用户重新录制
                if (!File.Exists(newPath) && !string.IsNullOrEmpty(oldPath) && File.Exists(oldPath))
                {
                    File.Copy(oldPath, newPath, true);
                    Console.WriteLine(LogPrefix + " 已迁移旧配置到新路径");
                }
                var storeDir = Path.GetDirectoryName(ConfigPathStore);
                if (!string.IsNullOrEmpty(storeDir)) Directory.CreateDirectory(storeDir);
                File.WriteAllText(ConfigPathStore, newPath);
            }
            catch (Exception ex)
            {
                Console.WriteLine(LogPrefix + " 切换配置路径失败: " + ex.Message);
            }
            SetupConfigWatcher();
            ReloadConfig();
        }

        private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            if (msg == Win32.WM_RELOAD)
            {
                try { ReloadConfig(); }
                catch (Exception ex) { Console.WriteLine(LogPrefix + " 重载配置失败: " + ex.Message); }
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
                Console.WriteLine(LogPrefix + " 热键命中: " + combo + " -> " + item.Action +
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
                Console.WriteLine(LogPrefix + " 解析配置失败: " + ex.Message);
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
                    Console.WriteLine(LogPrefix + " 跳过重复组合键: " + it.Combo);
                    continue;
                }
                map[it.Combo] = it;
                Console.WriteLine(LogPrefix + " 已装载热键: " + it.Combo + " -> " + it.Action +
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
                Console.WriteLine(LogPrefix + " 写入配置失败: " + ex.Message);
            }
        }

        // 命名键 -> VirtualKeyCode。与 KeyToToken 严格互为逆运算：
        // 录制时 KeyToToken 把 vk 变成 token 落盘，触发时 ParseCombo 把 token 还原成 vk，
        // 两边必须用同一套命名，否则录出来的快捷键永远匹配不上。
        // 注意：token 里绝不能出现 '+'（ParseCombo 按 '+' 切分），故小键盘加号写作 numplus。
        private static readonly Dictionary<string, int> NamedVk = new(StringComparer.OrdinalIgnoreCase)
        {
            { "backspace", 0x08 }, { "tab", 0x09 }, { "enter", 0x0D }, { "escape", 0x1B },
            { "space", 0x20 }, { "delete", 0x2E }, { "insert", 0x2D },
            { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
            { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
            { "capslock", 0x14 }, { "numlock", 0x90 }, { "scrolllock", 0x91 },
            { "pause", 0x13 }, { "printscreen", 0x2C }, { "apps", 0x5D },
            // 标点符号键（OEM）：用户明确要求把 ; ' 等符号也纳入可录制范围
            { "semicolon", 0xBA }, { "equal", 0xBB }, { "comma", 0xBC },
            { "minus", 0xBD }, { "period", 0xBE }, { "slash", 0xBF },
            { "grave", 0xC0 }, { "bracketleft", 0xDB }, { "backslash", 0xDC },
            { "bracketright", 0xDD }, { "apostrophe", 0xDE },
            // 小键盘
            { "num0", 0x60 }, { "num1", 0x61 }, { "num2", 0x62 }, { "num3", 0x63 },
            { "num4", 0x64 }, { "num5", 0x65 }, { "num6", 0x66 }, { "num7", 0x67 },
            { "num8", 0x68 }, { "num9", 0x69 },
            { "nummul", 0x6A }, { "numplus", 0x6B }, { "numminus", 0x6D },
            { "numdot", 0x6E }, { "numdiv", 0x6F }
        };

        // 进程监控：守护进程默认常驻，仅在 Photoshop 运行时才激活全局热键；
        // 若设置环境变量 JWAUTO_EXIT_WHEN_PS_CLOSED=1，则 PS 关闭后立即退出（需由启动器/插件再次拉起）。
        // 这样天然实现「随 PS 开启时开启、PS 关闭后关闭（或取消激活）」。
        // 判断当前前台（焦点）窗口是否属于某个 Photoshop 进程。
        // 仅比较 PID，避免每次按键都创建 Process 对象（轻量、无分配）。
        private static bool IsPhotoshopForeground()
        {
            var hwnd = Win32.GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return false;
            uint pid;
            Win32.GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0) return false;
            // 无锁读取（volatile 引用整体替换）
            var pids = _psPids;
            return pids.Contains((int)pid);
        }

        // 刷新「当前运行的 Photoshop 进程 PID 集合」：钩子线程据此判断焦点是否落在 PS 上。
        private static void RefreshPsPids(bool running)
        {
            var set = new HashSet<int>();
            if (running)
            {
                try
                {
                    foreach (var p in Process.GetProcessesByName("photoshop"))
                    {
                        try { set.Add(p.Id); } catch { }
                    }
                }
                catch { }
            }
            // 集合构建完成后再整体发布（volatile 写），读取方无需加锁
            _psPids = set;
        }

        private static void WatchPhotoshop()
        {
            bool exitWhenClosed = Environment.GetEnvironmentVariable("JWAUTO_EXIT_WHEN_PS_CLOSED") == "1";
            bool sawPs = false;
            while (true)
            {
                Thread.Sleep(3000);
                // ⛔ 整轮包在 try/catch 里：本循环产物 _psPids 是**两个钩子共用的前置条件**
                //    （键盘侧与鼠标侧都靠它判断「焦点是否在 PS」）。此前只有取进程列表那一步
                //    包了 try，RefreshPsPids / RegisterAll / UnregisterAll 抛异常就会让整条
                //    探测线程消失 —— 两个钩子随后会同时「莫名失效」，且没有任何日志。
                try
                {
                    bool psRunning = false;
                    try { psRunning = Process.GetProcessesByName("photoshop").Length > 0; } catch { }
                    RefreshPsPids(psRunning);
                    if (psRunning) sawPs = true;
#if !ROLE_SMOOTH
                    // 热键表只在热键角色里装卸。⛔ 平滑角色绝不能碰 RegisterAll ——
                    //   它会安装全局键盘钩子，两个进程同时抢键盘钩子会互相打架（按键被重复处理）。
                    if (psRunning)
                    {
                        if (!_active) RegisterAll();
                    }
                    else
                    {
                        if (_active) UnregisterAll();
                    }
#endif
                    if (!psRunning && exitWhenClosed && sawPs)
                    {
                        Console.WriteLine(LogPrefix + " Photoshop 已关闭，退出守护进程。");
                        Environment.Exit(0);
                    }
                }
                catch (Exception ex) { Console.WriteLine(LogPrefix + " ⚠️ PS 探测本轮失败: " + ex.Message); }
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
                else if (p.Length == 1)
                {
                    // 标点/符号键（; ' [ ] \ / - = , . `）与字母数字统一走 VkKeyScan，
                    // 只要键盘布局上能打出这个字符就能绑定。返回 -1 表示当前布局无此键。
                    short scan = Win32.VkKeyScanW(p[0]);
                    if (scan != -1) vk = scan & 0xFF;
                }
                // 其余情况 vk 保持 0，调用方需跳过注册
            }
            return (mods, vk);
        }

        // ===== 常驻低层键盘钩子 =====
        // 进程启动时安装一次，同时服务于「录制组合键」与「触发快捷键」两件事。
        // 它运行在独立的带消息循环的线程上（低层钩子要求安装线程必须泵消息）。
        // ⚠️ 与鼠标钩子（套索平滑）**完全独立**：独立的线程、独立的句柄、独立的熔断标志、
        //    独立的看护线程。本方法只碰 _hookId，任何情况下都不会触碰 _mouseHookId。
        private static void InstallPermanentHook()
        {
            lock (_recLock)
            {
                if (_hookId != IntPtr.Zero) { Win32.UnhookWindowsHookEx(_hookId); _hookId = IntPtr.Zero; }
                if (!_hotkeyArmed)
                {
                    Console.WriteLine(LogPrefix + " 热键钩子处于禁用态，跳过安装");
                    return;
                }
                try
                {
                    _hookProc = LowLevelKeyboardProc; // 保持委托引用，避免被 GC 后钩子崩溃
                    _hookId = Win32.SetWindowsHookEx(Win32.WH_KEYBOARD_LL, _hookProc, Win32.GetModuleHandle(null), 0);
                }
                catch (Exception ex)
                {
                    // 绝不把异常留给调用方：这段跑在钩子线程的消息循环里，
                    // 一旦抛出会连带线程一起死掉（见 RecordingThreadProc 的异常隔离注释）。
                    _hookId = IntPtr.Zero;
                    Console.WriteLine(LogPrefix + " ❌ 常驻键盘钩子安装异常: " + ex.Message);
                    return;
                }
                if (_hookId == IntPtr.Zero)
                    Console.WriteLine(LogPrefix + " ❌ 常驻键盘钩子安装失败，快捷键将完全不生效");
                else
                    Console.WriteLine(LogPrefix + " 常驻键盘钩子已安装");
            }
        }

        // 卸载常驻键盘钩子（运行期禁用热键的唯一正确做法）。
        // 与 InstallPermanentHook 对称：只碰 _hookId。
        private static void UninstallPermanentHook()
        {
            lock (_recLock)
            {
                if (_hookId == IntPtr.Zero) return;
                try { Win32.UnhookWindowsHookEx(_hookId); } catch { }
                _hookId = IntPtr.Zero;
            }
            // 钩子没了就不可能再收到录制按键：清掉录制态，避免面板停在「等待按键」
            _recPendingCombo = null;
            Console.WriteLine(LogPrefix + " 常驻键盘钩子已卸载（热键禁用；鼠标/平滑不受影响）");
        }

        /// <summary>
        /// 热键钩子的布防 / 撤防（运行期独立装卸）。
        ///
        /// ⛔ 与 SetSmoothArm 严格对称且**互不引用**：这里只投递键盘钩子的装卸指令，
        ///    不读也不写任何平滑侧状态（_smoothArm / _mouseHookId / _mouseHookSafeMode）。
        /// ⛔ 与平滑侧一样**不在此处广播**：指令是异步投递给钩子线程执行的，
        ///    此刻句柄尚未变化，广播出去的 hookInstalled 必然过期。
        ///    状态统一由 HotkeyWatchdog 在检测到跃变后补播。
        /// </summary>
        private static void SetHotkeyArm(bool on)
        {
            _hotkeyArmed = on;
            if (_recThreadId != 0)
                // ⚠️ 必须显式转 uint：PostThreadMessage 的消息参数是 uint，
                //    而 `cond ? A : B` 不是常量表达式，拿不到 C# 的常量隐式转换。
                Win32.PostThreadMessage(_recThreadId, (uint)(on ? WM_HOOK_INSTALL : WM_HOOK_UNINSTALL), IntPtr.Zero, IntPtr.Zero);
            Console.WriteLine(LogPrefix + " 热键钩子" + (on ? "已布防" : "已撤防"));
        }

        // 开始录制：常驻钩子已在运行，这里只标注「正在等录制的那一次按键」
        private static void StartRecordingInternal()
        {
            // 热键钩子被禁用时不可能收到按键：立刻回一个「录制取消」，
            // 否则面板会一直停在「等待按键」界面（用户以为程序卡了）。
            if (!_hotkeyArmed)
            {
                Console.WriteLine(LogPrefix + " 热键钩子已禁用，拒绝本次录制");
                FinishRecordingInternal(null);
                return;
            }
            if (_hookId == IntPtr.Zero) InstallPermanentHook();
            if (_hookId == IntPtr.Zero) { FinishRecordingInternal(null); return; }
            // 清空上一轮遗留的待确认组合键，确保新录制从「捕获阶段」开始
            _recPendingCombo = null;
            // 先由 WebSocket 线程把 _recordingClient 写好，这里才把标志置为 true
            // （volatile 写保证钩子线程随后一定能看到已设置的 client）
            _recording = true;
            Console.WriteLine(LogPrefix + " 录制已开始，等待组合键…");
        }

        // combo 为 null 表示取消（ESC 或 UXP 主动取消）
        // 本方法可能在键盘钩子线程上被调用（钩子命中录制键时），故 SendToClient（同步网络写）
        // 必须移交线程池：绝不能阻塞钩子线程——写阻塞会卡死钩子消息循环，导致全键盘失灵
        // （只有杀进程/卸载才恢复）。这是「运行一段时间后键盘打不出字」的根因。
        private static void FinishRecordingInternal(string? combo)
        {
            // 先关掉录制标志：钩子线程后续按键立刻回到「不处理」路径，
            // 避免在下面的锁与序列化期间反复进入本方法。
            _recording = false;
            _recPendingCombo = null;
            TcpClient? clientToSend = null;
            string? payload = null;
            string brush;
            lock (_recLock)
            {
                var client = _recordingClient;
                _recordingClient = null;
                brush = _recordingBrush ?? "";
                _recordingBrush = null;
                if (client == null) return;
                clientToSend = client;
            }
            // JSON 序列化放在锁外：序列化有分配开销，不应持锁执行
            payload = combo == null
                ? JsonSerializer.Serialize(new { type = "recordCancel", brush }, JsonOpts)
                : JsonSerializer.Serialize(new { type = "recordResult", brush, combo }, JsonOpts);
            var c = clientToSend;
            var msg = payload!;
            Task.Run(() =>
            {
                try { SendToClient(c, msg); }
                catch { try { c.Close(); } catch { } }
            });
        }

        // 录制进度回显（两段式录制第一阶段）：捕获到组合键后立即推给面板显示「待确认」，
        // 录制会话继续保持，直到回车确认（recordResult）或 Esc 取消（recordCancel）。
        // 退格不参与录制（录制期既不绑定也不删除）；删除绑定走 armDelete/backspaceDelete 布防通路。
        // 与 FinishRecordingInternal 同样的铁律：可能在钩子线程上被调用——
        // 锁内只做引用快照（无 I/O），序列化与网络写全部移交线程池。
        private static void SendRecordingProgress(string combo)
        {
            TcpClient? client;
            string brush;
            lock (_recLock)
            {
                client = _recordingClient;
                brush = _recordingBrush ?? "";
            }
            if (client == null) return;
            var msg = JsonSerializer.Serialize(new { type = "recordCaptured", brush, combo }, JsonOpts);
            Task.Run(() =>
            {
                try { SendToClient(client, msg); }
                catch { try { client.Close(); } catch { } }
            });
        }

        // 录制线程：独立消息循环，专门用于承载 WH_KEYBOARD_LL 钩子。
        // 通过 PostThreadMessage 接收 WM_HOOK_INSTALL / WM_HOOK_UNINSTALL / WM_RECORD_START / WM_RECORD_STOP。
        //
        // ⛔ 异常隔离：本循环每一轮都包在 try/catch 内。这些指令（装/卸钩子、录制）都直接调
        //    Win32 / 网络序列化，任何一次未捕获异常都会让**整条线程消失** ——
        //    而低层钩子正是挂在这条线程上的，线程一死钩子即被系统摘除，且
        //    _recThreadId 仍指向一个不存在的线程，后续 PostThreadMessage 全部石沉大海：
        //    表现为「热键突然全失效且永不恢复」。看护线程的存活探针会重建它，
        //    但前提是这里不能让异常把线程带走。
        private static void RecordingThreadProc()
        {
            _recThreadId = Win32.GetCurrentThreadId();
            _recThreadReady.Set();
            Console.WriteLine(LogPrefix + " 钩子线程已启动 tid=" + _recThreadId);
            // 常驻钩子必须由「承载它的那个线程」自己安装：它随后立刻进入消息循环，
            // 之前改成主线程 PostThreadMessage 通知安装会失败——线程消息队列在
            // GetMessage 之前尚未创建，PostThreadMessage 返回 false，钩子永远装不上。
            TryQuiet(() => InstallPermanentHook(), "键盘钩子安装");
            var msg = new Win32.MSG();
            while (Win32.GetMessage(out msg, IntPtr.Zero, 0, 0) != 0)
            {
                int m = (int)msg.message;   // MSG.message 是 uint（原生类型），转 int 便于与常量比较
                TryQuiet(() =>
                {
                    if (m == WM_HOOK_INSTALL) InstallPermanentHook();
                    else if (m == WM_HOOK_UNINSTALL) UninstallPermanentHook();
                    else if (m == WM_RECORD_START) StartRecordingInternal();
                    else if (m == WM_RECORD_STOP) FinishRecordingInternal(null);
                    // 线程消息（PostThreadMessage）没有窗口，无需 DispatchMessage
                }, "钩子线程消息 " + m);
            }
            Console.WriteLine(LogPrefix + " 钩子线程已退出");
        }

        /// <summary>
        /// 吞掉异常并记日志的薄封装。
        ///
        /// ⛔ 用途仅限「跑在常驻线程消息循环里、绝不能让异常终止线程」的调用点
        ///    （钩子装卸、看护重建、PS 探测）。它不是通用的错误隐藏手段：
        ///    业务逻辑的异常仍应向上抛给调用方处理。
        /// </summary>
        private static void TryQuiet(Action act, string what)
        {
            try { act(); }
            catch (Exception ex) { Console.WriteLine(LogPrefix + " ⚠️ " + what + " 失败: " + ex.Message); }
        }

        // 钩子线程专用日志出口：只入队（Console.WriteLine 已重定向为内存队列），绝不在此处做文件 I/O。
        // 此前这里会 PostThreadMessage(WM_DRAIN_LOG) 让钩子线程自己写文件——写阻塞即卡死钩子。
        //
        // ⚠️ 使用范围已收紧：仅限「录制 / 解绑」这类**低频、一次用户动作一条**的路径。
        //    高频热路径（每一帧鼠标移动、每一次熔断判定）一律**不得**在此打日志 ——
        //    真机证据：唯一带日志的那一帧，恰好就是耗时 306ms 的那一帧。
        //    热路径的可观测性改走「零 I/O 内存埋点 + 看护线程代打」：
        //    埋点见 _mouseCbLastTotalMs / _mouseCbMaxInjectMs，代打见 _smoothPendingDragLog /
        //    _smoothPendingBreakLog / _hotkeyPendingBreakLog。
        private static void LogFromHook(string line)
        {
            Console.WriteLine(line);
        }

        // 低层键盘钩子入口。
        // ⚠️ 铁律：本方法内的每一步都必须是 O(1)、无锁、无 I/O、不向外抛异常。
        //    本方法一旦阻塞，等于冻结整个系统的键盘输入；若注册表的
        //    LowLevelHooksTimeout 被设得过大，一次阻塞就会演变为长时间「打不出字」。
        // 因此真正的逻辑放在 HookDispatch，外层只负责计时与熔断：
        // 只要发现一次回调耗时超预算，就降级为「纯放行」，宁可快捷键失效也不拖累系统；
        // 降级后可自愈（冷却期满由 HotkeyWatchdog 复位并重挂，见 SafeModeCooldownMs）。
        private static IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            long t0 = Stopwatch.GetTimestamp();
            IntPtr result;
            try
            {
                result = HookDispatch(nCode, wParam, lParam);
            }
            catch
            {
                // 绝不把异常抛回系统：钩子回调里抛异常会让输入链处于不稳定状态
                result = Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);
            }

            if (!_hookSafeMode)
            {
                long elapsedMs = (long)Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
                if (elapsedMs > HookBudgetMs)
                {
                    // ⛔ 只计数、不打日志：日志由 HotkeyWatchdog 代打（钩子回调严禁 I/O）。
                    //    且必须**连续**超预算才熔断，单次抖动不毁掉整个会话。
                    _hookSafeModeStrikes++;
                    if (_hookSafeModeStrikes >= SafeModeStrikes)
                    {
                        _hookSafeMode = true;
                        Interlocked.Exchange(ref _hookSafeModeSince, Environment.TickCount64);
                        _hotkeyBreakElapsedMs = (int)elapsedMs;
                        _hotkeyPendingBreakLog = true;
                    }
                }
                else
                {
                    _hookSafeModeStrikes = 0;   // 恢复正常即清零连续计数
                }
            }
            return result;
        }

        // 钩子实际逻辑（被 LowLevelKeyboardProc 包裹，便于统一计时熔断）
        private static IntPtr HookDispatch(int nCode, IntPtr wParam, IntPtr lParam)
        {
            // 已熔断：退化成纯放行
            if (_hookSafeMode)
                return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);

            if (nCode < 0)
                return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);

            int msg = wParam.ToInt32();
            if (msg != Win32.WM_KEYDOWN && msg != Win32.WM_SYSKEYDOWN)
                return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);

            // 焦点不在 Photoshop 时暂停监听：直接放行，不拦截、不录制。
            // 这样用户在其它程序里打字/用快捷键不会被本守护进程吞掉。
            if (!IsPhotoshopForeground())
                return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);

            int vk = Marshal.ReadInt32(lParam);              // KBDLLHOOKSTRUCT.vkCode 为首字段
            uint flags = (uint)Marshal.ReadInt32(lParam, 8); // flags 偏移 8
            // bit 30 = 上一帧按键状态（1 表示此前已按下，即系统自动重复），忽略重复
            if ((flags & (1u << 30)) != 0)
                return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);

            // 录制状态读 volatile 布尔量，不取任何锁（锁竞争会让钩子回调阻塞 → 全键盘冻结）
            if (_recording)
            {
                if (vk == 0x1B) // Escape => 取消录制（捕获/确认两阶段通用）
                {
                    LogFromHook(LogPrefix + " 录制取消 (Esc)");
                    FinishRecordingInternal(null);
                    return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);
                }

                bool isModifier = vk == 0x11 || vk == 0x12 || vk == 0x10 || vk == 0x5B || vk == 0x5C;
                if (!isModifier)
                {
                    // 退格在录制期间不参与任何逻辑：既不绑定为组合键（旧版会误把退格录进绑定），
                    // 也不承担「删除绑定」——删除统一走「单击选中条目 + 非录制态按退格」的布防通路。
                    if (vk == 0x08) return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);

                    if (_recPendingCombo != null)
                    {
                        // ===== 确认阶段：已捕获组合键，等待回车确认 / 其它按键重新捕获 =====
                        if (vk == 0x0D) // Enter => 确认，正常结束录制
                        {
                            string confirmed = _recPendingCombo;
                            LogFromHook(LogPrefix + " 录制确认 (Enter): " + confirmed);
                            FinishRecordingInternal(confirmed);
                            // 吞掉 Enter：确认键不该继续传给 Photoshop（画布上回车可能触发其它行为）
                            return (IntPtr)1;
                        }
                        // 其它非修饰键：重新捕获（替换待确认组合键），方便按错后直接改按正确的键
                        string? recapture = BuildCombo(vk);
                        if (!string.IsNullOrEmpty(recapture))
                        {
                            _recPendingCombo = recapture;
                            LogFromHook(LogPrefix + " 重新捕获组合键（待确认）: " + recapture);
                            SendRecordingProgress(recapture);
                        }
                        return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);
                    }

                    // ===== 捕获阶段：第一组非修饰键即被捕获，进入确认阶段（录制不结束）=====
                    string? combo = BuildCombo(vk);
                    if (!string.IsNullOrEmpty(combo))
                    {
                        _recPendingCombo = combo;
                        LogFromHook(LogPrefix + " 已捕获组合键（待确认）: " + combo);
                        SendRecordingProgress(combo);
                    }
                    return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);
                }
                return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);
            }

            // 退格删除绑定：面板已布防（用户单击选中了某条快捷键）时，退格 = 请求解绑该条。
            // 读路径与录制状态同理：volatile 快速失败，仅在真正命中时才短暂进锁取客户端引用。
            // 必须吞掉按键：PS 里退格会唤出「填充」对话框，绑定期不应穿透。
            if (vk == 0x08 && _deleteArmOwner != null)
            {
                TcpClient? armClient;
                string owner;
                lock (_armLock) { owner = _deleteArmOwner ?? ""; armClient = _deleteArmClient; }
                if (armClient != null)
                {
                    // ⚠️ 局部名不能用 msg：外层钩子回调已声明 int msg（wParam），同名会 CS0136
                    var delMsg = JsonSerializer.Serialize(new { type = "backspaceDelete", owner }, JsonOpts);
                    var c = armClient;
                    LogFromHook(LogPrefix + " 退格解绑请求 -> " + owner);
                    Task.Run(() =>
                    {
                        try { SendToClient(c, delMsg); }
                        catch { try { c.Close(); } catch { } }
                    });
                }
                return (IntPtr)1;
            }

            // 非录制状态：与已装载的热键表做匹配。
            // volatile 读取一次引用后再使用，避免多次读取期间表被整体替换造成不一致。
            if (_active)
            {
                var map = _comboMap;
                if (map.Count > 0)
                {
                    string? combo = BuildCombo(vk);
                    if (combo != null && map.TryGetValue(combo, out var hit))
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

            return Win32.CallNextHookEx(_hookId, nCode, wParam, lParam);
        }

        // ===== 套索实时平滑：鼠标钩子线程 =====
        // 与键盘钩子分线程的理由见字段区注释。钩子的安装/卸载都由本线程自己执行
        // （PostThreadMessage 只投递指令）：低层钩子必须由「承载它的那个带消息循环的线程」安装。
        //
        // ⛔ 异常隔离：与 RecordingThreadProc 同构 —— 本循环里的任何未捕获异常都会让线程消失，
        //    而缓存钩子正挂在这条线程上，线程一死钩子即被系统摘除且 _mouseThreadId 变成死地址，
        //    后续装卸指令全部石沉大海（表现为「平滑永久失效、状态一直启动失败」）。
        private static void MouseHookThreadProc()
        {
            _mouseThreadId = Win32.GetCurrentThreadId();
            _mouseThreadReady.Set();
            Console.WriteLine(LogPrefix + " 鼠标钩子线程已启动 tid=" + _mouseThreadId + "（未布防时不安装钩子）");
            // 线程体自行按当前意图装配：首启时未布防 ⇒ 什么都不做；
            // 被看护线程**重建**时布防可能仍为真 ⇒ 必须自己补装，否则重建后永远没有钩子
            // （重建路径不会再补发装卸指令，见 EnsureHookThreadAlive）。
            if (_smoothArm) TryQuiet(() => InstallMouseHook(), "鼠标钩子安装");
            var msg = new Win32.MSG();
            while (Win32.GetMessage(out msg, IntPtr.Zero, 0, 0) != 0)
            {
                int m = (int)msg.message;   // MSG.message 是 uint（原生类型），转 int 便于与常量比较
                TryQuiet(() =>
                {
                    if (m == WM_MOUSE_HOOK_INSTALL) InstallMouseHook();
                    else if (m == WM_MOUSE_HOOK_UNINSTALL) UninstallMouseHook();
                }, "鼠标钩子线程消息 " + m);
            }
            Console.WriteLine(LogPrefix + " 鼠标钩子线程已退出");
        }

        /// <summary>
        /// 安装（或重挂）鼠标钩子。**幂等**：句柄非空时先卸再挂，
        /// 因为「句柄非空」并不代表钩子还活着（系统会静默摘钩，见 SmoothWatchdog 注释）。
        /// </summary>
        private static void InstallMouseHook()
        {
            _smoothDragging = false;   // 重挂期间不做接管，避免半途丢事件
            if (_mouseHookId != IntPtr.Zero)
            {
                try { Win32.UnhookWindowsHookEx(_mouseHookId); } catch { }
                _mouseHookId = IntPtr.Zero;
            }
            try
            {
                _mouseHookProc = LowLevelMouseProc;   // 保持委托引用，避免被 GC 后钩子崩溃
                _mouseHookId = Win32.SetWindowsHookExMouse(Win32.WH_MOUSE_LL, _mouseHookProc, Win32.GetModuleHandle(null), 0);
            }
            catch (Exception ex)
            {
                _mouseHookId = IntPtr.Zero;
                _smoothLastInstallTick = Environment.TickCount64;
                Console.WriteLine(LogPrefix + " ❌ 鼠标钩子安装异常: " + ex.Message);
                return;
            }
            _smoothLastInstallTick = Environment.TickCount64;
            if (_mouseHookId == IntPtr.Zero)
                Console.WriteLine(LogPrefix + " ❌ 鼠标钩子安装失败（err=" + Marshal.GetLastWin32Error() +
                    "），套索实时平滑不会生效。常见原因：安全软件拦截全局鼠标钩子。");
            else
                Console.WriteLine(LogPrefix + " 鼠标钩子已安装（套索平滑布防中）");
        }

        private static void UninstallMouseHook()
        {
            _smoothDragging = false;
            if (_mouseHookId == IntPtr.Zero) return;
            try { Win32.UnhookWindowsHookEx(_mouseHookId); } catch { }
            _mouseHookId = IntPtr.Zero;
            Console.WriteLine(LogPrefix + " 鼠标钩子已卸载（套索平滑撤防）");
        }

        /// <summary>
        /// 布防 / 撤防。**只应由 WebSocket 线程调用**：只给鼠标钩子线程投递指令，自己不做 I/O 之外的事。
        ///
        /// ⛔ 这里**刻意不广播状态**：本方法返回时钩子还没装上（SetWindowsHookEx 由钩子线程
        ///    异步执行）⇒ 此刻广播出去的 hookInstalled 必然是 false，面板会先闪一下
        ///    「启动失败（被安全软件拦截）」。状态统一由 SmoothWatchdog 在检测到
        ///    armed/hookInstalled 跃变后补播（≤120ms），那一帧才是真实状态。
        /// </summary>
        private static void SetSmoothArm(bool on, TcpClient? client)
        {
            if (on)
            {
                lock (_smoothLock) { _smoothArmClient = client; }
                _smoothArm = true;
                if (_mouseThreadId != 0)
                    Win32.PostThreadMessage(_mouseThreadId, WM_MOUSE_HOOK_INSTALL, IntPtr.Zero, IntPtr.Zero);
            }
            else
            {
                _smoothArm = false;
                lock (_smoothLock) { _smoothArmClient = null; }
                if (_mouseThreadId != 0)
                    Win32.PostThreadMessage(_mouseThreadId, WM_MOUSE_HOOK_UNINSTALL, IntPtr.Zero, IntPtr.Zero);
            }
            Console.WriteLine(LogPrefix + " 套索平滑" + (on ? "已布防" : "已撤防"));
        }

        /// <summary>
        /// 子系统线程存活探针（键盘侧与鼠标侧各调用一次，互不共享任何状态）。
        ///
        /// ⛔ 为什么必须有：低层钩子挂在「安装它的那条线程」上。线程一旦因未捕获异常退出，
        ///    钩子会被系统连带摘除，而 _threadId 仍是一个有效数字 —— PostThreadMessage 不报错
        ///    但消息进的是死队列，于是所有「重挂」指令都永远到不了任何人手里，该子系统
        ///    永久失效且日志上只有一句「线程已退出」。这是本项目曾经的盲区。
        /// ⚠️ threadRef 为 null 表示尚未创建（启动早期）⇒ 什么都不做，绝不重复建线程。
        /// </summary>
        private static void EnsureHookThreadAlive(ref Thread? threadRef, ThreadStart body, string name)
        {
            if (threadRef == null) return;
            if (threadRef.IsAlive) return;
            Console.WriteLine(LogPrefix + " ⚠️ " + name + "线程已不存活，正在重建（另一子系统不受影响）…");
            var t = new Thread(body) { IsBackground = true, Name = name };
            threadRef = t;
            t.Start();
            // 线程体第一件事就是按当前意图自行装配（键盘 ⇒ 尊重 _hotkeyArmed；鼠标 ⇒ 尊重 _smoothArm），
            // 因此这里不需要、也不应该再补一条装卸指令（此刻线程队列可能还没建立）。
        }

        /// <summary>
        /// 热键（键盘钩子）健康看护 —— 与鼠标侧**完全独立**的一条看护线程。
        ///
        /// 职责三件，全部只作用于键盘子系统：
        ///   ① 线程存活探针：钩子线程死了就重建（否则热键永久失效）；
        ///   ② 熔断自愈：回调超预算后冷却期内只放行，冷却期满复位并重挂；
        ///   ③ 已布防但句柄为空 ⇒ 重挂。
        ///
        /// ⚠️ 刻意**不做**「定时无条件重挂」（鼠标侧有这一步）：键盘钩子的重挂会在
        ///    unhook/hook 之间留下一个窗口，用户此刻的按键会绕过我们的处理；
        ///    而「被系统静默摘钩」在键盘侧无法用无害探针检测（按键事件本身就是探针，
        ///    但我们无法区分「用户没按键」与「钩子被摘了」）。因此只处理**确定已坏**的情形。
        /// </summary>
        private static void HotkeyWatchdog()
        {
            // 跃变上报：连续两轮读数一致且与上次上报不同才广播（消除安装中间帧）。
            var reported = (armed: true, hook: false, safe: false);
            var candidate = reported;
            bool haveCandidate = false;
            long lastHealthCheck = 0;
            while (true)
            {
                Thread.Sleep(120);
                try
                {
                    long now = Environment.TickCount64;

                    // ① 线程存活（重建后由线程体自己按 _hotkeyArmed 装配）
                    EnsureHookThreadAlive(ref _recThreadRef, RecordingThreadProc, "键盘钩子");

                    // ①.5 代打钩子攒下的日志（钩子回调严禁 I/O ⇒ 一律由本线程取走打印）
                    if (_hotkeyPendingBreakLog)
                    {
                        _hotkeyPendingBreakLog = false;
                        Console.WriteLine(LogPrefix + " ⚠️ 键盘钩子**连续 " + SafeModeStrikes + " 次**回调超预算" +
                            "（最近一次 " + _hotkeyBreakElapsedMs + "ms / 预算 " + HookBudgetMs + "ms），" +
                            "已降级为纯放行：此后不再处理按键，避免拖累系统输入。" +
                            "（" + (SafeModeCooldownMs / 1000) + "s 后自动复位并重挂；鼠标/平滑不受影响）");
                    }

                    // ② 熔断自愈：只复位键盘侧的标志，绝不触碰 _mouseHookSafeMode
                    if (_hookSafeMode)
                    {
                        long since = Interlocked.Read(ref _hookSafeModeSince);
                        if (since != 0 && now - since >= SafeModeCooldownMs)
                        {
                            _hookSafeMode = false;
                            Interlocked.Exchange(ref _hookSafeModeSince, 0);
                            Console.WriteLine(LogPrefix + " 键盘钩子熔断冷却期满，已复位并重挂（平滑/鼠标全程未受影响）");
                            if (_hotkeyArmed && _recThreadId != 0)
                                Win32.PostThreadMessage(_recThreadId, WM_HOOK_INSTALL, IntPtr.Zero, IntPtr.Zero);
                        }
                    }

                    // ③ 跃变上报
                    var cur = (armed: _hotkeyArmed, hook: _hookId != IntPtr.Zero, safe: _hookSafeMode);
                    if (haveCandidate && cur == candidate && cur != reported)
                    {
                        reported = cur;
                        BroadcastHotkeyState();
                    }
                    candidate = cur;
                    haveCandidate = true;

                    // ④ 句柄看护：2s 一次
                    if (now - lastHealthCheck < 2000) continue;
                    lastHealthCheck = now;
                    if (!cur.armed || cur.hook) continue;
                    Console.WriteLine(LogPrefix + " ⚠️ 热键已布防但键盘钩子句柄为空，正在重挂…");
                    if (_recThreadId != 0)
                        Win32.PostThreadMessage(_recThreadId, WM_HOOK_INSTALL, IntPtr.Zero, IntPtr.Zero);
                }
                catch { /* 看护线程绝不因异常退出 */ }
            }
        }

        /// <summary>
        /// 平滑健康看护 —— 与热键侧**完全独立**的一条看护线程。
        ///
        /// ⛔ 为什么必须有它：Windows 对低层钩子有 LowLevelHooksTimeout —— 回调一旦超时，
        ///    系统会**静默摘除**钩子且不通知任何一方。此时句柄仍非 0、日志毫无异常，
        ///    表现只是「平滑忽然不生效了」，无从排查。这里做四件事：
        ///      ① 线程存活探针：钩子线程死了就重建（否则平滑永久失效）；
        ///      ② 熔断自愈：回调超预算后冷却期满复位并重挂；
        ///      ③ 已布防但句柄为空 ⇒ 立即重挂；
        ///      ④ 已布防且长期未重挂（20s）⇒ 在**非拖拽**时刻主动重挂一次。
        ///         代价是一次毫秒级的 unhook/hook，换来「被静默摘钩后最多 20s 自愈」。
        ///         （鼠标侧可以做定时重挂：拖拽中不重挂即可，用户无感知；键盘侧不行，见 HotkeyWatchdog。）
        ///
        /// ⚠️ 刻意不用「注入一个零位移事件再看有没有回调」的探针：零位移事件可能被系统
        ///    合并/丢弃，探针本身不可靠，反而会误判成「钩子死了」而反复重挂。
        /// </summary>
        private static void SmoothWatchdog()
        {
            // 状态上报：本线程负责，钩子线程与 WS 线程都不碰。
            //
            // ⛔ 为什么必须由本线程补播（两个都会在真机上直接暴露）：
            //   ① `SetSmoothArm` 返回时钩子**还没装上** —— 它只 PostThreadMessage 给钩子线程，
            //      真正的 SetWindowsHookEx 由钩子线程异步执行。若在那里广播，上报的
            //      hookInstalled 必然是 false，面板每次启用都会先闪一下红色的
            //      「启动失败（被安全软件拦截）」。
            //   ② 拖拽开始/结束发生在**钩子线程内**，而钩子线程严禁 I/O（见钩子铁律）
            //      ⇒ 这两次跃变只能由本线程补播。不补的话面板永远看不到「生效中」，
            //        用户也就无法区分「钩子装上了但一个事件都没收到」（数位板场景）
            //        与「正常工作」—— 这正是 A3 验收项唯一的 UI 判据。
            //
            // 上报规则 = 「连续两轮读数相同（已稳定）」且「与上次上报不同」。
            // 单轮就采到 hookInstalled=false 的中间帧不会外泄（钩子安装是毫秒级的）；
            // 而真的装不上时，约两个周期（240ms）后如实报出。
            var reported = (armed: false, dragging: false, hook: false, safe: false);
            var candidate = reported;
            bool haveCandidate = false;
            long lastHealthCheck = 0;
            while (true)
            {
                Thread.Sleep(120);
                try
                {
                    long now = Environment.TickCount64;

                    // ① 线程存活（重建后由线程体自己按 _smoothArm 装配）
                    EnsureHookThreadAlive(ref _mouseThreadRef, MouseHookThreadProc, "鼠标钩子");

                    // ①.5 代打钩子攒下的日志（钩子回调严禁 I/O ⇒ 一律由本线程取走打印）
                    if (_smoothPendingDragLog)
                    {
                        _smoothPendingDragLog = false;
                        Console.WriteLine(LogPrefix + " 套索平滑：本次拖拽原始 " + _smoothLastDragRaw +
                            " 点 / 发布 " + _smoothLastDragInjected + " 点 / 实注入 " + _smoothLastDragFlushed +
                            " 点（回调最差 " + _mouseCbMaxTotalMs + "ms，回注最差 " + _injectMaxMs +
                            "ms，累计回注超 100ms " + Interlocked.Read(ref _injectOver100Ms) + " 次）");
                    }
                    if (_smoothPendingBreakLog)
                    {
                        _smoothPendingBreakLog = false;
                        if (_smoothBreakReason == BreakReasonInjectStall)
                        {
                            Console.WriteLine(LogPrefix + " ⚠️ 回注线程已 " + _smoothBreakElapsedMs +
                                "ms 未从 SendInput 返回（疑似卡死），已**立即停止接管并放行原始鼠标事件**。" +
                                "套索平滑失效，但光标保持原生行为。此类熔断不会自动复位 —— 需重启平滑服务。");
                        }
                        else
                        {
                            Console.WriteLine(LogPrefix + " ⚠️ 鼠标钩子**连续 " + SafeModeStrikes + " 次**回调超预算" +
                                "（最近一次 " + _smoothBreakElapsedMs + "ms / 预算 " + MouseHookBudgetMs + "ms），" +
                                "已降级为纯放行：套索平滑暂时失效（键盘热键不受影响），避免拖累系统输入。" +
                                "（" + (SafeModeCooldownMs / 1000) + "s 后自动复位并重挂）");
                        }
                    }

                    // ② 熔断自愈：只复位鼠标侧的标志，绝不触碰 _hookSafeMode
                    if (_mouseHookSafeMode)
                    {
                        long since = Interlocked.Read(ref _mouseSafeModeSince);
                        // ⛔ 但「回注线程卡死」这一种熔断**绝不自动复位**：
                        //    SendInput 一旦卡住就不会自己回来（真机表现为进程都退不掉），
                        //    此时自动复位只会让钩子重新开始吞事件 ⇒ 光标再次被冻住。
                        //    这类熔断必须等到回注线程真正归还（重启服务）才能解除。
                        long busySince = Volatile.Read(ref _injectBusySince);
                        bool injectorWedged = busySince != 0 && now - busySince > InjectStallGuardMs;
                        if (injectorWedged)
                        {
                            if (since == 0) Interlocked.Exchange(ref _mouseSafeModeSince, now);
                        }
                        else if (since != 0 && now - since >= SafeModeCooldownMs)
                        {
                            _mouseHookSafeMode = false;
                            Interlocked.Exchange(ref _mouseSafeModeSince, 0);
                            Console.WriteLine(LogPrefix + " 鼠标钩子熔断冷却期满，已复位并重挂（键盘热键全程未受影响）");
                            if (_smoothArm && _mouseThreadId != 0)
                                Win32.PostThreadMessage(_mouseThreadId, WM_MOUSE_HOOK_INSTALL, IntPtr.Zero, IntPtr.Zero);
                        }
                    }

                    // ③ 跃变上报：采样（只读 4 个 bool / 1 个指针，代价可忽略）。
                    var cur = (
                        armed: _smoothArm,
                        dragging: _smoothDragging,
                        hook: _mouseHookId != IntPtr.Zero,
                        safe: _mouseHookSafeMode);
                    if (haveCandidate && cur == candidate && cur != reported)
                    {
                        reported = cur;
                        BroadcastSmoothState();
                    }
                    candidate = cur;
                    haveCandidate = true;

                    // ④ 钩子健康看护：2s 一次就够（重挂代价是毫秒级 unhook/hook）。
                    if (now - lastHealthCheck < 2000) continue;
                    lastHealthCheck = now;
                    if (!cur.armed) continue;
                    if (!cur.hook)
                    {
                        Console.WriteLine(LogPrefix + " ⚠️ 已布防但鼠标钩子句柄为空，正在重挂…");
                        Win32.PostThreadMessage(_mouseThreadId, WM_MOUSE_HOOK_INSTALL, IntPtr.Zero, IntPtr.Zero);
                        continue;
                    }
                    if (!cur.dragging && now - _smoothLastInstallTick > 20000)
                        Win32.PostThreadMessage(_mouseThreadId, WM_MOUSE_HOOK_INSTALL, IntPtr.Zero, IntPtr.Zero);
                }
                catch { /* 看护线程绝不因异常退出 */ }
            }
        }

        /// <summary>判断屏幕点是否落在 Photoshop 自己的窗口上（画布/面板/菜单同属一个进程）。</summary>
        private static bool IsPhotoshopWindowAt(Win32.POINT pt)
        {
            try
            {
                var hwnd = Win32.WindowFromPoint(pt);
                if (hwnd == IntPtr.Zero) return false;
                uint pid;
                Win32.GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0) return false;
                return _psPids.Contains((int)pid);   // volatile 引用整体替换，无锁读
            }
            catch { return false; }
        }

        /// <summary>
        /// 回注一次位移（**相对移动 + 按实际光标位置自校正**）。
        ///
        /// 为什么不用绝对坐标：绝对移动要把屏幕坐标归一化到 0–65535，多显示器 / 缩放 /
        /// 虚拟桌面的组合下有大量边界坑。相对移动 + 每帧先 GetCursorPos（廉价系统调用，
        /// 不涉及宿主 IPC）再取差值，天然消除取整误差的累积漂移。
        /// </summary>
        private static bool InjectMouseMoveTo(int tx, int ty)
        {
            if (!Win32.GetCursorPos(out var cur)) return false;
            var inputs = new Win32.INPUT[1];
            inputs[0].type = Win32.INPUT_MOUSE;
            inputs[0].mi.dx = tx - cur.x;
            inputs[0].mi.dy = ty - cur.y;
            inputs[0].mi.mouseData = 0;
            inputs[0].mi.dwFlags = Win32.MOUSEEVENTF_MOVE;
            inputs[0].mi.time = 0;
            inputs[0].mi.dwExtraInfo = SmoothInjectSignature;
            return Win32.SendInput(1, inputs, Marshal.SizeOf<Win32.INPUT>()) == 1;
        }

        /// <summary>
        /// 回注一次**绝对**位置。
        ///
        /// ⛔ 为什么必须补这一条：`MOUSEEVENTF_MOVE`（相对）**同样走系统的指针加速曲线**
        ///    （「提高指针精确度」，本机实测 SPI_GETMOUSE = [6,10,1]，即开启状态）。
        ///    我们阻塞掉原始移动、改注入「平滑后」的位移，而平滑后的位移更小、更均匀，
        ///    落在加速曲线的另一段 ⇒ 每帧实际位移 ≠ 请求位移，且是非线性的；
        ///    更糟的是注入是**闭环**的（每帧先 GetCursorPos 再取差值），
        ///    一次过冲会在下一帧变成反向修正 ⇒ 光标在目标附近来回抖动，
        ///    画布上看到的就是「位移被吃掉 + 抖动依旧」。两者同源。
        ///
        ///    `MOUSEEVENTF_ABSOLUTE` 不经加速，位置严格等于请求值 ⇒ 位移守恒。
        ///    代价是要把屏幕坐标归一化到 0–65535（多显示器/缩放需配合 VIRTUALDESK）。
        /// </summary>
        private static bool InjectMouseMoveAbsoluteTo(int tx, int ty)
        {
            int vx = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
            int vy = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
            int vw = Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
            int vh = Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN);
            if (vw < 2) vw = 2;
            if (vh < 2) vh = 2;

            long nx = (long)(tx - vx) * 65535 / (vw - 1);
            long ny = (long)(ty - vy) * 65535 / (vh - 1);
            if (nx < 0) nx = 0; else if (nx > 65535) nx = 65535;
            if (ny < 0) ny = 0; else if (ny > 65535) ny = 65535;

            var inputs = new Win32.INPUT[1];
            inputs[0].type = Win32.INPUT_MOUSE;
            inputs[0].mi.dx = (int)nx;
            inputs[0].mi.dy = (int)ny;
            inputs[0].mi.mouseData = 0;
            inputs[0].mi.dwFlags = Win32.MOUSEEVENTF_MOVE | Win32.MOUSEEVENTF_ABSOLUTE | Win32.MOUSEEVENTF_VIRTUALDESK;
            inputs[0].mi.time = 0;
            inputs[0].mi.dwExtraInfo = SmoothInjectSignature;
            return Win32.SendInput(1, inputs, Marshal.SizeOf<Win32.INPUT>()) == 1;
        }

        /// <summary>
        /// 钩子线程发布「最新目标位置」并唤醒回注线程。微秒级：只有 3 次 volatile 写 + 一次
        /// `SetEvent`，**绝不阻塞** —— 这是把 300ms 停顿从钩子里摘干净的关键。
        /// </summary>
        private static void PublishInjectTarget(int x, int y)
        {
            // 先写坐标、后置信号：回注线程只在看到信号后才读坐标，
            // volatile 写序保证它读到的至少是已发布过的一版，不会读到半更新状态。
            _injectTargetX = x;
            _injectTargetY = y;
            if (!_injectSignal.IsSet) _injectSignal.Set();
        }

        /// <summary>
        /// 回注线程体：等信号 → 取最新目标 → `SendInput`。
        ///
        /// ✅ 天然「合并」：连续多帧发布目标时，若上一帧还没注入完，新目标只是覆盖坐标，
        ///    回注线程下一次循环取到的就是最新位置 —— 等价于自适应抽稀，不会积压。
        ///
        /// ⚠️ 本线程是普通托管线程（不受钩子铁律约束），但**绝不能因异常退出**：
        ///    原始事件都被钩子吞了，一旦它消失光标就再也补不上位置（指针像被冻住）。
        /// </summary>
        private static void InjectThreadProc()
        {
            while (_injectRunning)
            {
                try
                {
                    _injectSignal.Wait(200);
                    if (!_injectRunning) break;

                    if (_injectSignal.IsSet)
                    {
                        _injectSignal.Reset();                 // 先清信号再读坐标（见 PublishInjectTarget 的写序）
                        int x = _injectTargetX, y = _injectTargetY;
                        long t0 = Stopwatch.GetTimestamp();
                        // 置「正在回注」标记：钩子据此判断回注线程是不是卡死了（见 _injectBusySince）
                        Volatile.Write(ref _injectBusySince, Environment.TickCount64);
                        bool ok = InjectMouseMoveAbsoluteTo(x, y);
                        Volatile.Write(ref _injectBusySince, 0);
                        int ms = (int)Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
                        _injectLastMs = ms;
                        if (ms > _injectMaxMs) _injectMaxMs = ms;
                        if (ms >= 100) Interlocked.Increment(ref _injectOver100Ms);
                        Interlocked.Increment(ref _injectTotalCalls);
                        if (ok)
                        {
                            Interlocked.Increment(ref _smoothInjected);
                            _injectDragDone++;
                        }
                        continue;
                    }

                    // ===== 队列已排空 =====
                    // 把「本笔汇总」的**快照**移交给看护线程打印（钩子内绝不 I/O，回注线程也不适合 I/O：
                    // 它一慢就直接体现为光标滞后）。等 30ms 再复核一次信号，避免刚排空又有新目标插进来。
                    if (_smoothDragLogArmed)
                    {
                        Thread.Sleep(30);
                        if (_injectSignal.IsSet) continue;
                        _smoothDragLogArmed = false;
                        _smoothLastDragRaw = _smoothDragRaw;
                        _smoothLastDragInjected = _smoothDragInjected;
                        _smoothLastDragFlushed = _injectDragDone;
                        _smoothPendingDragLog = true;
                    }
                }
                catch { /* 绝不让回注线程因异常退出 */ }
            }
        }

        /// <summary>
        /// 指针注入自检（`{"type":"pointerTest"}`）：在同一台机器上对拍
        /// 「相对注入 / 绝对注入 / SetCursorPos（不经输入栈，作为上界对照）」三种方式的位移守恒率。
        ///
        /// 存在意义：这决定了平滑到底该用哪种注入 —— 直接量出 `MOUSEEVENTF_MOVE` 被加速吃掉了多少。
        /// 本方法会短暂移动光标，结束前**必定**复位（含异常路径）。
        /// </summary>
        private static string RunPointerTest()
        {
            int a1 = 0, a2 = 0, a3 = 0;
            try
            {
                var arr = new int[3];
                if (Win32.SystemParametersInfo(Win32.SPI_GETMOUSE, 0u, arr, 0u)) { a1 = arr[0]; a2 = arr[1]; a3 = arr[2]; }
            }
            catch { }

            Win32.POINT saved;
            if (!Win32.GetCursorPos(out saved))
                return "{\"type\":\"pointerTest\",\"ok\":false,\"error\":\"GetCursorPos 失败\"}";

            // ⚠️ 排障用追踪：本命令不在钩子热路径上，允许 I/O。
            //    存在的意义：区分「SendInput 被系统卡住」与「自检代码自身卡住」——两种修法完全不同。
            Console.WriteLine(LogPrefix + " pointerTest 开始 accel=[" + a1 + "," + a2 + "," + a3 +
                "] 光标起点=" + saved.x + "," + saved.y);

            var sb = new StringBuilder(1024);
            sb.Append("{\"type\":\"pointerTest\",\"ok\":true,\"accel\":[")
              .Append(a1).Append(',').Append(a2).Append(',').Append(a3).Append(']')
              .Append(",\"cases\":[");
            bool first = true;

            // kind：0 = 相对（走平滑真正用的那条代码路径）；1 = 绝对；2 = SetCursorPos（对照上界）
            void Case(string name, int steps, int stepPx, int pauseMs, int kind)
            {
                int total = steps * stepPx;
                int screenRight = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN) + Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
                int sx = saved.x;
                if (sx + total + 40 > screenRight) sx = screenRight - total - 40;
                if (sx < 10) sx = 10;

                Console.WriteLine(LogPrefix + "   case " + name + " steps=" + steps + " step=" + stepPx + " kind=" + kind);
                Win32.SetCursorPos(sx, saved.y);
                Thread.Sleep(60);
                Win32.POINT before;
                Win32.GetCursorPos(out before);
                Console.WriteLine(LogPrefix + "     before=" + before.x + "," + before.y);

                long t0 = Stopwatch.GetTimestamp();
                for (int i = 0; i < steps; i++)
                {
                    if (kind == 0)
                    {
                        Win32.POINT cur;
                        Win32.GetCursorPos(out cur);
                        InjectMouseMoveTo(cur.x + stepPx, cur.y);          // 真实代码路径，不做任何改写
                    }
                    else if (kind == 1)
                    {
                        InjectMouseMoveAbsoluteTo(before.x + (i + 1) * stepPx, before.y);
                    }
                    else
                    {
                        Win32.SetCursorPos(before.x + (i + 1) * stepPx, before.y);
                    }
                    if (pauseMs > 0) Thread.Sleep(pauseMs);
                }
                int ms = (int)Stopwatch.GetElapsedTime(t0).TotalMilliseconds;

                Win32.POINT after;
                Win32.GetCursorPos(out after);
                int actual = after.x - before.x;
                double ratio = total == 0 ? 0.0 : (double)actual / total;
                Console.WriteLine(LogPrefix + "     after=" + after.x + "," + after.y +
                    " 请求=" + total + " 实际=" + actual + " 用时=" + ms + "ms");

                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":\"").Append(name).Append("\",\"steps\":").Append(steps)
                  .Append(",\"step\":").Append(stepPx)
                  .Append(",\"requested\":").Append(total)
                  .Append(",\"actual\":").Append(actual)
                  .Append(",\"ratio\":").Append(ratio.ToString("F3"))
                  .Append(",\"ms\":").Append(ms).Append('}');
            }

            try
            {
                Case("rel_fast", 20, 12, 0, 0);
                Case("rel_10ms", 20, 12, 10, 0);
                Case("abs_fast", 20, 12, 0, 1);
                Case("setpos_ctl", 20, 12, 0, 2);
                Case("rel_step1", 20, 1, 0, 0);
                Case("rel_step2", 20, 2, 0, 0);
                Case("rel_step4", 20, 4, 0, 0);
                Case("abs_step1", 20, 1, 0, 1);
            }
            finally
            {
                Win32.SetCursorPos(saved.x, saved.y);
            }

            sb.Append("]}");
            Console.WriteLine(LogPrefix + " pointerTest 结束（光标已复位）");
            return sb.ToString();
        }

        /// <summary>
        /// 低层鼠标钩子入口。铁律与键盘钩子完全一致：均摊 O(1)、无锁、无 I/O、不抛异常。
        /// 外层只负责计时与熔断；真正的逻辑在 SmoothMouseDispatch。
        /// </summary>
        private static IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            long t0 = Stopwatch.GetTimestamp();
            IntPtr result;
            try
            {
                result = SmoothMouseDispatch(nCode, wParam, lParam);
            }
            catch
            {
                // 绝不把异常抛回系统：会让输入链处于不稳定状态
                result = Win32.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);
            }
            Interlocked.Increment(ref _smoothHookCallbacks);
            Interlocked.Exchange(ref _smoothLastCallbackTick, Environment.TickCount64);

            // ===== 耗时拆解（零 I/O：只写内存字段，经 smoothState 上报）=====
            // ⚠️ 这里量的是**回调自身**的耗时：回注已搬到 _injectThread，
            //    所以它若再飙到几十上百毫秒，就纯粹是钩子线程里又混进了重活（I/O / 分配 / 系统调用）。
            // 记账放在计时之后、且不写日志 —— 保证「测量」本身不会成为新的开销来源。
            int totalMs = (int)Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
            _mouseCbLastTotalMs = totalMs;
            if (totalMs > _mouseCbMaxTotalMs)
            {
                _mouseCbMaxTotalMs = totalMs;
            }

            if (!_mouseHookSafeMode)
            {
                if (totalMs > MouseHookBudgetMs)
                {
                    _mouseCbStrikes++;
                    _mouseCbOverBudgetTotal++;
                    // 历史最差超预算帧（永不重置）—— 事后排查的唯一线索
                    if (totalMs > _mouseCbWorstOverTotalMs)
                    {
                        _mouseCbWorstOverTotalMs = totalMs;
                        // 同窗口内回注线程的最差单次耗时（诊断用；回注已不在回调内，故它是独立指标）
                        _mouseCbWorstOverInjectMs = _injectMaxMs;
                    }
                    if (_mouseCbStrikes >= SafeModeStrikes)
                    {
                        _mouseHookSafeMode = true;
                        Interlocked.Exchange(ref _mouseSafeModeSince, Environment.TickCount64);
                        _smoothDragging = false;
                        _smoothBreakElapsedMs = totalMs;
                        _smoothBreakReason = BreakReasonCallbackBudget;
                        _smoothPendingBreakLog = true;   // 日志由 SmoothWatchdog 代打
                    }
                }
                else
                {
                    _mouseCbStrikes = 0;   // 抖动一旦过去就清空连续计数
                }
            }
            return result;
        }

        /// <summary>
        /// 鼠标钩子的实际逻辑。四道闸门（布防 / PS 前台 / 左键拖拽 / 按下点落在 PS 窗口）缺一不可，
        /// 任一不满足即**直通**，保证对其它程序与系统操作零影响。
        /// </summary>
        private static IntPtr SmoothMouseDispatch(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0 || !_smoothArm || _mouseHookSafeMode)
                return Win32.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);

            int msg = wParam.ToInt32();
            if (msg != Win32.WM_MOUSEMOVE && msg != Win32.WM_LBUTTONDOWN && msg != Win32.WM_LBUTTONUP)
                return Win32.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);

            var st = Marshal.PtrToStructure<Win32.MSLLHOOKSTRUCT>(lParam);

            // ⛔ 防回环（本模块的第一号风险）：本进程注入的事件必须**直接放行**。
            //    双判据（LLMHF_INJECTED 标志 + dwExtraInfo 签名）—— 单用标志位会连
            //    「其它程序注入的事件」一起当成自己的，单用签名则漏掉签名丢失的情况。
            //    若这里识别失败，注入事件会被自己再吃一次并再次注入 ⇒ 瞬间的输入风暴。
            if ((st.flags & Win32.LLMHF_INJECTED) != 0 && st.dwExtraInfo == SmoothInjectSignature)
                return Win32.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);

            // 闸门②：只在 Photoshop 前台时接管（在别的程序里拖拽绝不受影响）
            if (!IsPhotoshopForeground())
            {
                _smoothDragging = false;
                return Win32.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);
            }

            long now = Environment.TickCount64;

            // ⛔⛔ 回注线程卡死安全网（必须放在最前面，先于一切「吞事件」的决定）。
            //    `SendInput` 在输入队列被占住时会无限期阻塞 —— 而我们在接管中会吞掉原始移动，
            //    一旦回注线程卡住，光标将彻底不动（用户只会以为鼠标/插件坏了）。
            //    因此：只要发现它超过 InjectStallGuardMs 没归还，立刻熔断 + 本轮起全部放行，
            //    把控制权交还系统。宁可平滑失效，也绝不让光标被我们冻住。
            long busySince = Volatile.Read(ref _injectBusySince);
            if (busySince != 0 && now - busySince > InjectStallGuardMs)
            {
                _mouseHookSafeMode = true;
                Interlocked.Exchange(ref _mouseSafeModeSince, now);
                _smoothDragging = false;
                _smoothBreakElapsedMs = (int)(now - busySince);
                _smoothBreakReason = BreakReasonInjectStall;
                _smoothPendingBreakLog = true;   // 日志由 SmoothWatchdog 代打
                return Win32.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);
            }

            if (msg == Win32.WM_LBUTTONDOWN)
            {
                // 闸门④：按下点必须落在 Photoshop 自己的窗口上（画布或它的子窗口）。
                // 挡掉「PS 处于前台、但用户实际在压着画布的其它浮动窗口上拖拽」的误接管。
                if (IsPhotoshopWindowAt(st.pt))
                {
                    _smoothDragging = true;
                    _smoothDragRaw = 0;
                    _smoothDragInjected = 0;
                    _injectDragDone = 0;
                    // 耗时拆解的统计窗口随每一笔重置 ⇒ 事后读到的「最差一帧」就是最近一笔的最坏值
                    _mouseCbMaxTotalMs = 0;
                    _injectMaxMs = 0;
                    _smoothDragLogArmed = false;
                    // 起笔锚定：输出点严格落在按下位置
                    _smoother.Reset(st.pt.x, st.pt.y, now);
                }
                return Win32.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);   // 按下事件一律不吞
            }

            if (msg == Win32.WM_LBUTTONUP)
            {
                if (_smoothDragging)
                {
                    _smoothDragging = false;
                    // 收笔追齐：把光标精确落到真实松手点。
                    // ⚠️ 闭合端点的「正确性」其实已由 PS 保证 —— 它按 mouse-up 消息自带的 pt 收尾；
                    //    这里补一次只是让视觉光标与最终端点一致，并给 PS 一个落在真实终点的移动点。
                    //
                    // ⛔⛔ 这里**只发布目标**，绝不同步 SendInput：抬起这一帧此前恰好是
                    //     「唯一既带一次同步回注、又带日志」的帧，真机实测 306ms 就出在这儿。
                    PublishInjectTarget(st.pt.x, st.pt.y);
                    // 汇总日志等回注排空后再由看护线程打印（这样计数才是最终值）
                    _smoothDragLogArmed = true;
                }
                return Win32.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);   // 抬起事件一律不吞
            }

            // ===== WM_MOUSEMOVE =====
            if (!_smoothDragging)
                return Win32.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);

            _smoothDragRaw++;

            var s = _smoothParams;   // volatile 一次读，整份快照，钩子里绝不加锁
            int tx, ty;
            if (_smoother.Step(st.pt.x, st.pt.y, now, s, out tx, out ty))
            {
                // ⛔ 只**发布**目标，不在这里回注 —— 见 PublishInjectTarget / InjectThreadProc。
                //    之前在这里同步 SendInput，导致每帧可能卡满 LowLevelHooksTimeout(300ms)。
                PublishInjectTarget(tx, ty);
                _smoothDragInjected++;
            }

            // 吞掉原始移动：光标改为「只走我们注入的位置」，PS 因此只看到平滑后的轨迹。
            return (IntPtr)1;
        }

        /// <summary>平滑状态与健康指标的 JSON（供 getState / smoothState 上报，排障时先看这里）。</summary>
        private static string SmoothStateJson()
        {
            var s = _smoothParams;
            long lastTick = Interlocked.Read(ref _smoothLastCallbackTick);
            return JsonSerializer.Serialize(new
            {
                type = "smoothState",
                protocol = ProtocolVersion,
                armed = _smoothArm,
                dragging = _smoothDragging,
                hookInstalled = _mouseHookId != IntPtr.Zero,
                safeMode = _mouseHookSafeMode,
                callbacks = Interlocked.Read(ref _smoothHookCallbacks),
                injected = Interlocked.Read(ref _smoothInjected),
                lastDragRaw = _smoothLastDragRaw,
                lastDragInjected = _smoothLastDragInjected,
                lastDragFlushed = _smoothLastDragFlushed,
                lastCallbackAgoMs = lastTick == 0 ? -1 : Environment.TickCount64 - lastTick,
                // ===== 回调耗时拆解（排障第一现场）=====
                // ⚠️ 回注搬走之后，回调侧应当长期稳定在亚毫秒~2ms。
                //    若 maxCbMs 又飙高 ⇒ 钩子线程里混进了重活（I/O / 分配 / 系统调用）。
                budgetMs = MouseHookBudgetMs,
                strikes = _mouseCbStrikes,
                overBudget = _mouseCbOverBudgetTotal,
                lastCbMs = _mouseCbLastTotalMs,
                maxCbMs = _mouseCbMaxTotalMs,
                worstOverCbMs = _mouseCbWorstOverTotalMs,
                // ===== 回注线程独立指标 =====
                injectCalls = Interlocked.Read(ref _injectTotalCalls),
                injectLastMs = _injectLastMs,
                injectMaxMs = _injectMaxMs,
                injectOver100Ms = Interlocked.Read(ref _injectOver100Ms),
                injectTargetX = _injectTargetX,
                injectTargetY = _injectTargetY,
                // 回注线程「正在 SendInput 已持续多久」：> InjectStallGuardMs 即代表它卡住了
                injectBusyMs = Volatile.Read(ref _injectBusySince) == 0
                    ? -1
                    : Environment.TickCount64 - Volatile.Read(ref _injectBusySince),
                settings = new
                {
                    mode = s.Mode,
                    strength = s.Strength,
                    radius = s.Radius,
                    tension = s.Tension,
                    catchUp = s.CatchUp,
                    cornerAngle = s.CornerAngle,
                    speedAdaptive = s.SpeedAdaptive,
                    minSampleDist = s.MinSampleDist
                }
            }, JsonOpts);
        }

        private static void BroadcastSmoothState()
        {
            try { Broadcast(SmoothStateJson()); } catch { /* 广播失败不影响布防本身 */ }
        }

        /// <summary>
        /// 热键（键盘钩子）状态与健康指标的 JSON。
        ///
        /// ⛔ 与 SmoothStateJson **完全分离**的两条消息：面板的「功能快捷键」与「平滑选项」
        ///    两个分区各自只消费自己那一条，任一子系统的故障不会污染另一边的状态显示。
        ///    历史上两者混在一个 getState 响应里，任何一侧缺字段都会让另一侧误判。
        /// </summary>
        private static string HotkeyStateJson()
        {
            return JsonSerializer.Serialize(new
            {
                type = "hotkeyState",
                protocol = ProtocolVersion,
                armed = _hotkeyArmed,
                hookInstalled = _hookId != IntPtr.Zero,
                safeMode = _hookSafeMode,
                active = _active,
                comboCount = _comboMap.Count,
                recording = _recording,
                timeoutMs = ReadLowLevelHooksTimeout(),
                budgetMs = HookBudgetMs,
                strikes = _hookSafeModeStrikes
            }, JsonOpts);
        }

        private static void BroadcastHotkeyState()
        {
            try { Broadcast(HotkeyStateJson()); } catch { /* 广播失败不影响布防本身 */ }
        }

        /// <summary>
        /// 从入站 JSON 里取一个布尔字段。**只接受真正的 JSON 布尔**（不接受 "true"/1 等宽松写法），
        /// 缺失或类型不符一律返回 defaultValue —— 布防类指令宁可保持现状，也不能被畸形消息翻转。
        /// </summary>
        private static bool ReadBool(JsonElement root, string name, bool defaultValue)
        {
            if (!root.TryGetProperty(name, out var el)) return defaultValue;
            if (el.ValueKind == JsonValueKind.True) return true;
            if (el.ValueKind == JsonValueKind.False) return false;
            return defaultValue;
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
            if (vk >= 0x60 && vk <= 0x69) return "Num" + (vk - 0x60); // 小键盘 0-9
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
                case 0x14: return "CapsLock";
                case 0x90: return "NumLock";
                case 0x91: return "ScrollLock";
                case 0x13: return "Pause";
                case 0x2C: return "PrintScreen";
                case 0x5D: return "Apps";
                // 标点符号键：用户要求把 ; ' 等符号纳入可录制范围，
                // 这些键此前返回 null，按下后「什么都没录到」。
                case 0xBA: return ";";
                case 0xBB: return "=";
                case 0xBC: return ",";
                case 0xBD: return "-";
                case 0xBE: return ".";
                case 0xBF: return "/";
                case 0xC0: return "`";
                case 0xDB: return "[";
                case 0xDC: return "\\";
                case 0xDD: return "]";
                case 0xDE: return "'";
                // 小键盘运算符（token 内不能含 '+'，用 numplus 等名字）
                case 0x6A: return "NumMul";
                case 0x6B: return "NumPlus";
                case 0x6D: return "NumMinus";
                case 0x6E: return "NumDot";
                case 0x6F: return "NumDiv";
                default: return null;
            }
        }

        private static async Task RunWebSocketServer()
        {
            var listener = new TcpListener(IPAddress.Loopback, PORT);
            listener.Start();
            Console.WriteLine(LogPrefix + " WebSocket 监听 ws://127.0.0.1:" + PORT);
            while (true)
            {
                try
                {
                    var client = await listener.AcceptTcpClientAsync();
                    _ = Task.Run(() => HandleClient(client));
                }
                catch (Exception ex)
                {
                    Console.WriteLine(LogPrefix + " 接受连接失败: " + ex.Message);
                }
            }
        }

        private static async Task HandleClient(TcpClient client)
        {
            try
            {
                var stream = client.GetStream();
                // 给发送/接收各设超时：即便某条 SendToClient 不幸阻塞，也只会等到超时抛异常
                // 而非永久卡住调用线程（钩子线程已通过 Task.Run 隔离，这里再兜底一层）。
                client.SendTimeout = 2000;
                client.ReceiveTimeout = 60000;
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
                            Console.WriteLine(LogPrefix + " 收到断开指令，正在退出…");
                            try { SendToClient(client, JsonSerializer.Serialize(new { type = "bye" }, JsonOpts)); } catch { }
                            _ = Task.Run(async () => { await Task.Delay(300); Environment.Exit(0); });
                        }
                        else if (type == "uninstall")
                        {
                            // 面板点「卸载」：移除开机自启 + 删除安装目录，全程无窗口。
                            Console.WriteLine(LogPrefix + " 收到卸载指令");
                            DoUninstall();
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
                        else if (type == "getState")
                        {
                            // 排障用：热键失灵时先看这里。active=false 表示 Photoshop 未被检测到
                            // （热键表未装载）；combos 为空则配置文件没有被正确解析。
                            //
                            // ⚠️ version / protocol / features 三项是**面板判断兼容性的唯一依据**：
                            //   旧版守护进程收到未知指令（如 smoothArm）会静默忽略，面板因此永远
                            //   收不到 smoothState —— 若不靠它，只能误报成「被安全软件拦截」。
                            //   features 列出本守护进程支持的子系统与能力位，面板按需校验。
                            SendToClient(client, JsonSerializer.Serialize(new
                            {
                                type = "state",
                                version = Version,
                                protocol = ProtocolVersion,
                                features = Features,
                                // 角色：面板据此确认「这个端口上跑的确实是它要找的那套服务」
                                // （拆分后热键=18923、平滑=18924，连错端口会立刻显形而不是静默失效）
                                role = RoleLabel,
                                // DPI 感知级别：绝对注入的坐标口径。本机是 100% 缩放，
                                // 这里报什么都看不出差别 —— 但它必须是 permonitor-v2（清单已声明）。
                                // 若报 unaware ⇒ 清单没生效，换到非 100% 缩放的机器光标就会画偏。
                                dpiAwareness = DpiAwarenessLabel(),
                                active = _active,
#if !ROLE_SMOOTH
                                hookInstalled = _hookId != IntPtr.Zero,
                                hookSafeMode = _hookSafeMode,
                                hookTimeoutMs = ReadLowLevelHooksTimeout(),
                                comboCount = _comboMap.Count,
                                combos = _comboMap.Keys.ToArray(),
                                items = _currentItems.Count,
                                // 热键（键盘钩子）子系统：armed=false ⇒ 已被面板独立禁用（钩子已卸载）
                                hotkeyArmed = _hotkeyArmed,
#else
                                // 套索实时平滑的布防与健康指标（排障时先看这几项：
                                // armed=true 但 hookInstalled=false ⇒ 钩子被拦截/安装失败；
                                // safeMode=true ⇒ 回调用时超预算已熔断；callbacks 不增长 ⇒ 钩子已被系统摘除）
                                smoothArmed = _smoothArm,
                                smoothHookInstalled = _mouseHookId != IntPtr.Zero,
                                smoothSafeMode = _mouseHookSafeMode,
                                smoothCallbacks = Interlocked.Read(ref _smoothHookCallbacks),
                                smoothInjected = Interlocked.Read(ref _smoothInjected)
#endif
                            }, JsonOpts));
                        }
                        else if (type == "hotkeyArm")
                        {
                            // 热键（键盘钩子）的**独立**布防/撤防：只装卸键盘钩子，
                            // 不读也不写任何平滑侧状态 —— 这是「两个钩子互不干扰」的核心指令。
                            bool on = ReadBool(doc.RootElement, "on", defaultValue: true);
                            SetHotkeyArm(on);
                        }
                        else if (type == "hotkeyStatus")
                        {
                            SendToClient(client, HotkeyStateJson());
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
                        else if (type == "armDelete")
                        {
                            // 布防「退格删除绑定」：记录布防方与归属（后布防覆盖先布防）。
                            // 钩子线程只在用户按退格时才短暂进 _armLock，无热路径锁竞争。
                            string? owner = null;
                            if (doc.RootElement.TryGetProperty("owner", out var oEl)) owner = oEl.GetString();
                            lock (_armLock) { _deleteArmClient = client; _deleteArmOwner = owner; }
                        }
                        else if (type == "disarmDelete")
                        {
                            // 撤防：仅当请求来自当前布防方才生效，避免误撤其它面板的布防
                            lock (_armLock)
                            {
                                if (_deleteArmClient == client) { _deleteArmClient = null; _deleteArmOwner = null; }
                            }
                        }
                        else if (type == "smoothArm")
                        {
                            // 套索实时平滑：布防/撤防。布防条件由 UXP 侧判定（当前工具 == 套索
                            // 且平滑选项已启用），此处只忠实执行 + 回报状态。
                            // ⚠️ 只作用于鼠标钩子，绝不触碰 _hotkeyArmed / _hookId。
                            SetSmoothArm(ReadBool(doc.RootElement, "on", defaultValue: false), client);
                        }
                        else if (type == "smoothParams")
                        {
                            // 参数快照：整体替换（钩子线程只做一次 volatile 读，不加锁）。
                            // 反序列化失败时保留旧参数，绝不把参数清成默认值 —— 否则用户
                            // 拖一次滑杆遇到一次解析异常就会「平滑忽然变弱」。
                            if (doc.RootElement.TryGetProperty("params", out var pEl))
                            {
                                try
                                {
                                    var parsed = JsonSerializer.Deserialize<LassoSmoothSettings>(pEl.GetRawText(), JsonOpts);
                                    if (parsed != null)
                                    {
                                        _smoothParams = parsed;
                                        BroadcastSmoothState();
                                    }
                                }
                                catch (Exception ex)
                                {
                                    Console.WriteLine(LogPrefix + " 平滑参数解析失败（保留原值）: " + ex.Message);
                                }
                            }
                        }
                        else if (type == "smoothStatus")
                        {
                            SendToClient(client, SmoothStateJson());
                        }
                        else if (type == "pointerTest")
                        {
                            // 指针注入自检：对拍相对/绝对/SetCursorPos 三种方式的位移守恒率。
                            // 会短暂移动光标，结束前必定复位 —— 仅用于排障，不参与正常运行路径。
                            SendToClient(client, RunPointerTest());
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine(LogPrefix + " 处理消息失败: " + ex.Message);
                    }
                }
            }
            catch { }
            finally
            {
                // ⛔ 三段清理**各自独立 try/catch**：它们是三个互不相干的子系统
                //    （录制 / 退格删除 / 套索平滑）。此前写在同一段裸代码里，任何一段抛异常
                //    都会让后面的清理被跳过（例如清理录制失败 ⇒ 平滑永不撤防 ⇒ 鼠标钩子一直挂着）。
                //    这里保证「一段失败绝不影响另外两段」。

                // ① 若断开的是正在录制的一方，取消录制（卸载钩子）
                TryQuiet(() =>
                {
                    if (_recordingClient == client)
                        Win32.PostThreadMessage(_recThreadId, WM_RECORD_STOP, IntPtr.Zero, IntPtr.Zero);
                }, "断开时取消录制");

                // ② 若断开的是已布防「退格删除」的一方，同步撤防（否则退格会被永久吞掉）
                TryQuiet(() =>
                {
                    lock (_armLock)
                    {
                        if (_deleteArmClient == client) { _deleteArmClient = null; _deleteArmOwner = null; }
                    }
                }, "断开时撤防退格删除");

                // ③ 若断开的是已布防「套索平滑」的一方，同步撤防（否则鼠标钩子会一直挂着）
                bool dropSmoothArm = false;
                TryQuiet(() =>
                {
                    lock (_smoothLock)
                    {
                        if (_smoothArmClient == client) { _smoothArmClient = null; dropSmoothArm = true; }
                    }
                }, "断开时清理平滑布防归属");
                if (dropSmoothArm) TryQuiet(() => SetSmoothArm(false, null), "断开时撤防套索平滑");

                TryQuiet(() => { lock (_clientsLock) _clients.Remove(client); }, "断开时移除客户端");
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
