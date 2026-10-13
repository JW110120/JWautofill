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
    /// 拖拽轨迹滤波器（鼠标通路）—— **已于 2026-10-12 随鼠标钩子平滑一并移除**。
    ///
    /// 背景：套索平滑原本有两条输入通路 —— ① 鼠标钩子（WH_MOUSE_LL + SendInput 回注，
    /// 改的是光标轨迹）；② 笔/Wintab（注入 PS 改包坐标）。用户明确不再需要①
    /// （鼠标轨迹平滑），只保留②。① 的全部机器（本类、LassoMouseSmoother、钩子线程、
    /// 回注线程、看护线程、smoothArm/smoothParams/smoothStatus/pointerTest 指令）
    /// 已整体删除；笔通路不受影响（见下方 #if ROLE_SMOOTH 的 PenHook）。
    /// </summary>

#if ROLE_SMOOTH
    /// <summary>
    /// 笔输入层实时平滑（P3）：守护进程侧。
    ///
    /// 为什么要有第二条通路：数位板在 PS 上走 **Wintab**（`PSUserConfig.txt` 里
    /// `UseSystemStylus 0`），笔**根本不产生** `WM_MOUSEMOVE` ⇒ `WH_MOUSE_LL` 全程不被
    /// 征询（P1/P2 已实测闭环）。那条路改的是**光标**；这条路改的是 **PS 进程内的包坐标**。
    ///
    /// 分工（为什么这么切）：
    ///   - **开关与参数**留在守护进程（面板 → WS → 本类 → 命名共享内存）；
    ///   - **滤波与改写**必须在 PS 进程内做 —— 50Hz 的取包节奏下，任何跨进程往返都是灾难。
    ///   - 共享内存是唯一双向通道：读侧只是普通内存读，**不产生任何系统调用**。
    ///
    /// ⛔ 心跳防呆：守护进程被强杀时共享内存**不会**消失（hook DLL 还持有句柄），
    ///    `enabled` 会一直留在 1。所以这里每秒写一次心跳，DLL 侧超过 3 秒没看到就自动停手。
    /// ⛔ 注入只在**功能开启时**发生：关闭态绝不碰 PS 的代码段（改过就还原）。
    /// </summary>
    internal static class PenHook
    {
        private const string LogPrefix = "[PenHook] ";
        private const string MapName = "Local\\JWautofillWintabSmooth";
        // ⛔ 必须与 native/WintabHook/wintab_hook.c 的 CFG_NLONGS **严格相等**：
        //    映射文件大小由它决定，两侧不一致会让后半段槽位互相踩（错位不报错）。
        private const int NLONGS = 40;
        private const int Stride = 4;
        private const int Magic = 0x57414A57;

        // ⛔ 槽位索引必须与 native/WintabHook/wintab_hook.c 的 enum CFG_I_* 逐项对应。
        private const int I_MAGIC = 0, I_ENABLED = 1, I_STRENGTH = 2, I_FLAGS = 3,
                          I_SEQ = 4, I_CMDSEQ = 5, I_CMD = 6, I_CMDACK = 7,
                          I_STATE = 8, I_CALLS = 9, I_PACKETS = 10, I_SMOOTHED = 11,
                          I_STRIDE = 12, I_OFFX = 13, I_OFFY = 14, I_OFFSER = 15,
                          I_AXISMAX = 16, I_PID = 17, I_FROZE = 18, I_HEARTBEAT = 19,
                          I_MODE = 20,
                          // ⛔ 槽位 21 = 已废弃的「张力」（2026-10-13 并入「半径」）。
                          //    刻意**保留这个空洞**而不是重编号：它与 wintab_hook.c 的
                          //    enum 逐项对应，少一项就让后面 11 个槽整体错位，而错位不报错。
                          I_CATCHUP = 22, I_CORNER = 23,
                          I_RADIUSPX = 24, I_HUD = 25, I_HUDCOLOR = 26, I_PXPERAXIS = 27,
                          // P3.2 触发闸门（详见 wintab_hook.c 同名槽位的注释）
                          I_TOOLGATE = 28, I_GATETS = 29, I_PENDOWN = 30, I_GATEOK = 31,
                          I_CTUNKNOWN = 32,
                          // P3.3：Y 轴分量的「轴→像素」比（**带符号**）。C 侧新增槽位只能
                          // 往后追加 —— 中间插一个就会让后面所有槽整体错位（错位不报错）。
                          I_PXPERAXISY = 33,
                          // P3.4（2026-10-14）：DLL 回写的「最后一次快照发布时刻」。
                          // packets 在涨而它不动 = 断流（标定丢失等），面板据此提示「平滑中断」。
                          I_SNTS = 34;

        /// <summary>
        /// 笔（套索平滑）通路的参数面 —— 与面板「平滑选项」的参数同源同语义。
        /// ⚠️ 早期版本只透传强度，半径/模式/张力/追笔/拐角**全部没接上**（面板调了没反应），
        ///    P3.1 起整包下发。新增字段必须同步写进共享内存槽（见 Wr 那一段）。
        /// </summary>
        internal sealed class PenParams
        {
            public int Mode = 0;          // 0=标准 1=拉绳 2=追笔
            public int Strength = 40;
            // 屏幕像素（与面板「最大滞后」同单位）。上限 100：与 PS 自家平滑一致，
            // 旧的 40 会把 τ 追平后的滞后硬截断 ⇒ 用户「强度拉满也没感觉」。
            public int RadiusPx = 12;
            public int CatchUp = 50;
            public int CornerAngle = 45;
            public int Flags = 1;         // bit0 = 速度自适应
            public int Hud = 3;           // bit0=leash 线 bit1=绳长圆 bit2=笔尖点
            public int HudColor = 0xE07F0D;   // 橙（#E07F0D），2026-10-14 用户要求与 PS 原生洋红区分

            /// <summary>
            /// 工具闸门：0 = 当前不是套索（禁止平滑），1 = 是套索（唯一放行值），
            /// 2 = 未知/读数失败（2026-10-14 起阻断，等待首次成功读数；面板另有纯 WS 心跳续期）。
            /// ⚠️ 由面板巡检写入。「读不到工具」绝不能当成「不是套索」由面板改写成 0 ——
            ///    那会把平滑整个关掉；面板读失败时沿用上次判定。
            /// </summary>
            public int ToolGate = 2;
        }

        /// <summary>面板 <c>penSmooth</c> 消息的线格式（字段全部可空：缺 = 保持原值）。
        /// ⚠️ 命名与面板 <c>toWire</c> 一致（radius 而不是 radiusPx）。</summary>
        internal sealed class PenWire
        {
            public int? Mode { get; set; }
            public int? Strength { get; set; }
            public int? Radius { get; set; }
            public int? CatchUp { get; set; }
            public int? CornerAngle { get; set; }
            public bool? SpeedAdaptive { get; set; }
            public int? Hud { get; set; }
            public int? HudColor { get; set; }
            /// <summary>工具闸门（面板 300ms 巡检）。缺字段 = 保持原值。</summary>
            public int? ToolGate { get; set; }
        }

        private static System.IO.MemoryMappedFiles.MemoryMappedFile? _mmf;
        private static System.IO.MemoryMappedFiles.MemoryMappedViewAccessor? _va;
        private static readonly object _lk = new();
        private static readonly HashSet<int> _injected = new();
        private static int _started;

        private static volatile bool _enabled;
        private static readonly PenParams _pen = new();
        private static int _cmdSeq;
        private static int _lastErr;
        private static string _dllPath = "";

        public static bool Enabled => _enabled;
        public static int Strength => _pen.Strength;
        public static PenParams Params => _pen;

        /// <summary>参数面的副本（避免调用方拿着活对象被并发改）。</summary>
        public static PenParams SnapshotParams()
        {
            lock (_lk)
            {
                return new PenParams
                {
                    Mode = _pen.Mode, Strength = _pen.Strength, RadiusPx = _pen.RadiusPx,
                    CatchUp = _pen.CatchUp, CornerAngle = _pen.CornerAngle,
                    Flags = _pen.Flags, Hud = _pen.Hud, HudColor = _pen.HudColor,
                    ToolGate = _pen.ToolGate,
                };
            }
        }

        /// <summary>hook DLL 的绝对路径（定位不到则为空串）。自安装时据此把 DLL 同步到安装目录。</summary>
        public static string DllPath { get { EnsureDllPath(); return _dllPath; } }

        /// <summary>
        /// 显式指定要注入的 DLL（自安装写入带版本戳的副本后调用）。
        /// ⛔ 一旦指定就不再走 <see cref="EnsureDllPath"/> 的目录扫描 —— 否则会重新捡回
        ///    安装目录里那份被 PS 锁住的旧 DLL。
        /// </summary>
        public static void SetDllPath(string path)
        {
            if (!string.IsNullOrEmpty(path)) _dllPath = path;
        }

        // ------------------------------------------------------------ 共享内存
        private static int Rd(int slot)
        {
            try { return _va?.ReadInt32(slot * Stride) ?? 0; } catch { return 0; }
        }

        private static void Wr(int slot, int v)
        {
            try { _va?.Write(slot * Stride, v); } catch { /* 访问器已释放：忽略 */ }
        }

        private static void EnsureInit()
        {
            if (_va != null) return;
            lock (_lk)
            {
                if (_va != null) return;
                try
                {
                    // ⛔ 槽位表与 native/WintabHook/wintab_hook.c 的 enum CFG_I_* 逐项对应。
                    //    两处手写 ⇒ 错位不报错、只静默失效，所以这里加运行时兜底校验。
                    if (I_PXPERAXISY >= NLONGS)
                        throw new InvalidOperationException(
                            "笔平滑槽位表越界：I_PXPERAXISY=" + I_PXPERAXISY + " >= NLONGS=" + NLONGS
                            + "（C 与 C# 两侧槽位不同步）");
                    _cmdSeq = (int)(DateTime.UtcNow.Ticks & 0x00FFFFFF);
                    var mmf = System.IO.MemoryMappedFiles.MemoryMappedFile.CreateOrOpen(
                        MapName, NLONGS * Stride);
                    _mmf = mmf;
                    _va = mmf.CreateViewAccessor(0, NLONGS * Stride);
                    WriteParams();
                    Wr(I_MAGIC, Magic);
                    Wr(I_ENABLED, 0);
                    Wr(I_HEARTBEAT, unchecked((int)Environment.TickCount64));
                    Console.WriteLine(LogPrefix + "共享内存已就绪: " + MapName);
                }
                catch (Exception ex)
                {
                    Console.WriteLine(LogPrefix + "共享内存建立失败（笔平滑将不可用）: " + ex.Message);
                }
            }
        }

        /// <summary>把当前参数面整包写进共享内存。
        /// ⛔ 新增参数必须在这里补一行 —— 漏写就是「面板调了没反应」的静默故障。</summary>
        private static void WriteParams()
        {
            Wr(I_STRENGTH, _pen.Strength);
            Wr(I_FLAGS,    _pen.Flags);
            Wr(I_MODE,     _pen.Mode);
            Wr(I_CATCHUP,  _pen.CatchUp);
            Wr(I_CORNER,   _pen.CornerAngle);
            Wr(I_RADIUSPX, _pen.RadiusPx);
            Wr(I_HUD,      _pen.Hud);
            Wr(I_HUDCOLOR, _pen.HudColor);
            Wr(I_TOOLGATE, _pen.ToolGate);
            // ⚠️ 闸门时间戳与闸门值**必须同时写**：DLL 用它判「面板是否还在巡检」。
            //    面板崩溃/关闭时守护进程会停止刷新 ⇒ 超过 3 秒即视为未知并放行，
            //    否则一次失败的巡检就把平滑永久关死，且面板上再也开不回来。
            Wr(I_GATETS,   unchecked((int)Environment.TickCount64));
        }

        private static int Clamp(int v, int lo, int hi) => v < lo ? lo : (v > hi ? hi : v);

        /// <summary>
        /// 上一次经 <c>cmd</c> 下发给 DLL 的开关状态（0=未知）。
        ///
        /// ⛔⛔ 为什么必须有它：DLL 收到 <c>cmd=1</c> 会**重置标定结果**（重新给标定机会），
        ///    这是「重新挂载」语义。而面板现在会为了工具闸门**每 300ms 推一次参数**
        ///    （见 penSmooth 的 ToolGate 字段）。若不加这道去重，每 3 秒就把标定清空一次
        ///    ⇒ DLL 反复回到「未标定」，平滑与 HUD 时断时续，而且极难归因。
        /// ⇒ 只在开关**真的发生跃变**时才发挂载/卸载命令；纯参数更新只写共享内存。
        /// </summary>
        private static volatile bool _cmdStateKnown;
        private static volatile bool _cmdStateOn;

        /// <summary>由 Main 调用一次：建共享内存 + 起心跳 + 兜底卸载。</summary>
        public static void Init()
        {
            if (Interlocked.Exchange(ref _started, 1) != 0) return;
            EnsureInit();
            var hb = new Thread(Heartbeat) { IsBackground = true, Name = "笔平滑心跳" };
            hb.Start();
            // 进程退出的兜底：哪怕走的是 Environment.Exit 之外的路径，也先把代码段还原。
            AppDomain.CurrentDomain.ProcessExit += (_, _) => { try { RequestUnhook(800); } catch { } };
        }

        private static void Heartbeat()
        {
            while (true)
            {
                Thread.Sleep(1000);
                // ⛔ 必须用「自开机起的毫秒」：smooth 侧 wintab_hook.c 读的是 GetTickCount()，
                //    两者同源才能直接相减；用 DateTime 之类的口径会立刻被判成心跳超时。
                Wr(I_HEARTBEAT, unchecked((int)Environment.TickCount64));
            }
        }

        // -------------------------------------------------------------- 命令
        private static void SendCommand(int cmd)
        {
            if (_va == null) return;
            // ⛔ 顺序：先写命令体、再抬序号。反过来会出现「序号已新、命令体还是旧」的窗口，
            //    hook 侧可能把陈旧命令当成新命令执行（例如刚点开启就被卸钩）。
            Wr(I_CMD, cmd);
            _cmdSeq++;
            Wr(I_CMDSEQ, _cmdSeq);
        }

        // ------------------------------------------------------------ 对外接口
        /// <summary>面板下发的开关 + 整包参数。<paramref name="p"/> 为 null 表示不改参数。</summary>
        public static void Set(bool on, PenParams? p)
        {
            EnsureInit();
            lock (_lk)
            {
                if (p != null)
                {
                    _pen.Mode        = Clamp(p.Mode, 0, 2);
                    _pen.Strength    = Clamp(p.Strength, 0, 100);
                    // 上限 100（与 wintab_hook.c 的 RADIUS_PX_MAX 一致，两侧都要改）
                    _pen.RadiusPx    = Clamp(p.RadiusPx, 1, 100);
                    _pen.CatchUp     = Clamp(p.CatchUp, 0, 100);
                    _pen.CornerAngle = Clamp(p.CornerAngle, 0, 90);
                    _pen.Flags       = p.Flags & 1;
                    _pen.Hud         = p.Hud & 7;
                    _pen.HudColor    = p.HudColor & 0xFFFFFF;
                    _pen.ToolGate    = Clamp(p.ToolGate, 0, 2);
                }
                _enabled = on;
                Wr(I_ENABLED, on ? 1 : 0);
                WriteParams();
                Wr(I_SEQ, Rd(I_SEQ) + 1);
            }
            // ⛔ 只在开关**真的跃变**时下发挂载/卸载命令（见 _cmdStateKnown 的注释）：
            //    纯参数更新（含 300ms 一次的工具闸门）只写共享内存，不碰标定。
            bool stateChanged = !_cmdStateKnown || _cmdStateOn != on;
            _cmdStateKnown = true;
            _cmdStateOn = on;
            if (on)
            {
                if (stateChanged)
                {
                    SyncInjection();     // 先把 DLL 送进 PS（新进程）
                    SendCommand(1);      // 再把「挂载」命令递给它（已在 PS 里的旧实例也吃得到）
                }
            }
            else if (stateChanged)
            {
                SendCommand(2);          // 关闭 ⇒ 立即还原字节；DLL 留在 PS 里（下次开启秒开）
            }
            Console.WriteLine(LogPrefix + (on ? "已开启" : "已关闭")
                              + "（模式 " + _pen.Mode + " 强度 " + _pen.Strength
                              + " 半径 " + _pen.RadiusPx + "px）");
        }

        /// <summary>周期性巡检：把 DLL 注入到每一个（新出现的）PS 进程。由 WatchPhotoshop 调。</summary>
        public static void SyncInjection()
        {
            if (!_enabled) return;              // ⛔ 关闭态一律不碰 PS
            EnsureInit();
            EnsureDllPath();
            if (string.IsNullOrEmpty(_dllPath)) return;

            var pids = new List<int>();
            try
            {
                foreach (var p in Process.GetProcessesByName("photoshop"))
                {
                    try { pids.Add(p.Id); } catch { }
                    try { p.Dispose(); } catch { }
                }
            }
            catch { return; }

            lock (_lk)
            {
                _injected.RemoveWhere(id => !pids.Contains(id));   // PS 换进程 ⇒ 记录作废
                foreach (int id in pids)
                {
                    if (_injected.Contains(id)) continue;
                    if (Inject(id))
                    {
                        _injected.Add(id);
                        Console.WriteLine(LogPrefix + "已注入 PS pid=" + id + "  dll=" + _dllPath);
                    }
                    else
                    {
                        Console.WriteLine(LogPrefix + "注入 PS pid=" + id + " 失败（Win32 错误 "
                                          + _lastErr + "）—— 可能被安全软件拦截");
                    }
                }
            }
            HealIfUnhooked();
        }

        /// <summary>
        /// hook 自愈：功能是开的、也已注入，但 DLL 停在「没在工作」的状态 ⇒ 重新下发挂载命令。
        /// </summary>
        /// <remarks>
        /// ⛔ 为什么必须有它（2026-10-13 用户报「平滑时有时无，切换模式后要反复开关才恢复」）：
        ///    `cmd=2`（卸载）除了「用户关开关」之外，还有两条通路会发：
        ///      · 本进程退出时的 <see cref="RequestUnhook"/>（服务重启 / 自更新重拉）；
        ///      · 面板侧偶发的 off（重连重放、两个面板上下文之一先发了 off）。
        ///    一旦 DLL 因此卸了钩，**只有再来一条 cmd=1 才会重挂** —— 而守护进程自己
        ///    以为一切正常（_enabled 仍为 true），于是表现成「开关是开的、界面也不报错、
        ///    可就是没有平滑」。用户只能靠反复开关去撞那条 cmd=1。
        ///    这里让守护进程每轮巡检（<see cref="WatchPhotoshop"/> 每 3 秒）自己发现并修复。
        ///
        /// ⛔⛔ 2026-10-14 扩面（用户报「刚加载插件时平滑/HUD 不生效」）：除 state=3 外，
        ///    「state=0 且从未取到包」同样是「没在工作」—— 注入时 Wintab32.dll 尚未就绪、
        ///    install 失败、或面板重载后从未重放过开关，都会停在这个状态且**没有第二条
        ///    通路能救它**（worker 启动时只 do_install 一次，失败不重试；面板重载后
        ///    penOn=false 也不会重发 penSmooth）。cmd=1 会重试 do_install 并重新给标定机会。
        ///
        /// ⚠️ 只在 _enabled 为真时才自愈：正常关闭时 Set(on:false) 会先把 _enabled 置假，
        ///    因此绝不会把用户主动关掉的平滑又拉起来。
        /// ⚠️ state=0 的自愈**只在 calls==0 时补**：取到过包而后停笔是正常现象，
        ///    此时发 cmd=1 会重置正在进行的标定（用户连续运笔时甚至可能永远标不完）。
        /// ⚠️ state=0 的自愈**有限次**（ZERO_HEAL_MAX）：用户 simply 没运笔时
        ///    不该被无限重试刷屏；取到过包或状态转正即自动恢复预算。
        /// ⚠️ state==4（入口被旧 DLL 的转发桩占着）**不自愈**：那需要重启 Photoshop，
        ///    反复发 cmd=1 只会刷日志。它由面板状态条如实提示。
        /// ⚠️ state==2（标定失败）也不自愈：面板已明示「标定失败」，重复 cmd=1 只是
        ///    掩盖真实故障；用户切换一次开关即可重新标定。
        /// </remarks>
        public static void HealIfUnhooked()
        {
            if (!_enabled || _va == null) return;
            long now = Environment.TickCount64;
            // 冷却 2 秒：penSmooth 会被面板以 ~12 次/秒的节流推来，
            // 若重挂失败（例如 PS 正要退出）不加冷却会把日志与命令通道刷爆。
            if (now - _lastHealAt < 2000) return;
            int st = Rd(I_STATE);
            if (st == 3)
            {
                _lastHealAt = now;
                _zeroHealTries = 0;
                Console.WriteLine(LogPrefix + "检测到钩子已卸载但功能仍为开启 —— 自动重新挂载");
                SendCommand(1);
                return;
            }
            if (st == 0 && Rd(I_CALLS) == 0)
            {
                if (_zeroHealTries >= ZERO_HEAL_MAX) return;
                _zeroHealTries++;
                _lastHealAt = now;
                Console.WriteLine(LogPrefix + "平滑已开启但尚未取到任何笔尖包（state=0）—— 重新挂载（第 "
                                  + _zeroHealTries + "/" + ZERO_HEAL_MAX + " 次）");
                SendCommand(1);
                return;
            }
            // 1（生效）/ 2（标定失败）/ 4（入口被占）都不自愈；健康 ⇒ 清零上面的重试预算
            if (st != 0 || Rd(I_CALLS) > 0) _zeroHealTries = 0;
        }
        private static long _lastHealAt;
        /// <summary>state=0 且从未取包时的最大重挂次数（防止「用户没运笔」被无限重试）。</summary>
        private const int ZERO_HEAL_MAX = 5;
        private static int _zeroHealTries;

        /// <summary>请求 PS 侧的 hook 还原代码段（幂等）。关闭服务/卸载/退出前调用。</summary>
        public static void RequestUnhook(int timeoutMs = 1500)
        {
            if (_va == null) return;
            int seq;
            lock (_lk) { _cmdSeq++; seq = _cmdSeq; Wr(I_CMD, 2); Wr(I_CMDSEQ, _cmdSeq); }
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                if (Rd(I_CMDACK) == seq) return;
                Thread.Sleep(40);
            }
        }

        /// <summary>注入器状态快照（并进 smoothState / getState，排障先看这里）。</summary>
        public static object Snapshot()
        {
            int[] pids;
            lock (_lk) { pids = new List<int>(_injected).ToArray(); }
            return new
            {
                enabled = _enabled,
                strength = _pen.Strength,
                mode = _pen.Mode,
                radiusPx = _pen.RadiusPx,
                catchUp = _pen.CatchUp,
                cornerAngle = _pen.CornerAngle,
                speedAdaptive = (_pen.Flags & 1) != 0,
                hud = _pen.Hud,
                // 工具闸门：0=不是套索 1=是套索 2=未知。面板据此说明
                // 「为什么开着却不平滑」—— 换工具了 / 笔没落纸面。
                toolGate = _pen.ToolGate,
                // DLL 回写的两个闸门状态（1/0）。两者的组合就是「此刻到底在不在平滑」：
                //   toolGate=0 → 工具不对；penDown=0 → 笔悬空；gateOk=1 → 真的在改写。
                // ⛔ toolOk 由**本进程自己写**的 I_TOOLGATE 推出（不是读 DLL 的回写 ——
                //    DLL 不写这个槽，读它只会拿到自己刚写的值，判据等于没有）。
                toolOk = (Rd(I_TOOLGATE) != 0) ? 1 : 0,
                penDown = Rd(I_PENDOWN),
                gateOk = Rd(I_GATEOK),
                // 落笔判据是否可用。1 ⇒ 原生侧推不出「笔尖是否接触画布」，
                // 已退化为「按落笔处理」（此时悬空移动也会被平滑，与旧版一致）。
                contactUnknown = Rd(I_CTUNKNOWN),
                // ×1000 的「轴→像素比」，**逐轴带符号**：渲染线程用真实光标标定出来的。
                // 1.0 ⇒ 包坐标本身就是屏幕像素；0.0586 ⇒ 数位板逻辑单位(1920/32767)。
                // ⛔ Y 那一份是**负**的（Wintab 包的 Y 向上为正、屏幕 Y 向下为正）——
                //    leash 长度/位置不对、或洋红圆心被镜像时，第一个该看的就是这两个值。
                pxPerAxis = Rd(I_PXPERAXIS),
                pxPerAxisY = Rd(I_PXPERAXISY),
                dll = _dllPath,
                injectedPids = pids,
                // 0=未挂 1=生效 2=标定失败 3=已卸载 4=入口被旧副本占用
                state = Rd(I_STATE),
                calls = Rd(I_CALLS),
                packets = Rd(I_PACKETS),
                smoothed = Rd(I_SMOOTHED),
                // 「快照年龄」(ms)：now − DLL 最后一次发布快照的时刻。
                // ⛔ 判读：正常 ≤几十 ms；停笔时与 packets 年龄同步增长（正常）；
                //    **packets 在涨而它 >2s** = 断流（标定丢失/改写被跳过）⇒ 面板提示「平滑中断」。
                //    -1 = DLL 从未发布过（旧版 DLL / 尚未取到包）。
                snAge = Rd(I_SNTS) == 0
                    ? -1
                    : Math.Max(0, unchecked((int)Environment.TickCount) - Rd(I_SNTS)),
                stride = Rd(I_STRIDE),
                offX = Rd(I_OFFX),
                offY = Rd(I_OFFY),
                offSerial = Rd(I_OFFSER),
                axisMax = Rd(I_AXISMAX),
                hookPid = Rd(I_PID),
                frozeThreads = Rd(I_FROZE),
                lastError = _lastErr,
            };
        }

        // -------------------------------------------------------- DLL 定位
        /// <summary>
        /// hook DLL 的**落盘暂存目录**。
        /// ⛔⛔ 为什么必须放在**安装目录之外**（2026-10-13 真机定案）：
        ///     PS 一旦加载了这个 DLL，它所在的**目录**就被进程锁住 ⇒
        ///     「卸载平滑服务」删除安装目录必然失败（真机：日志里连试 12 次全挂，
        ///     报「无法删除安装目录（文件仍被占用？）」，而当时**守护进程并没有在跑**）。
        ///     根因不是「删不掉」，而是**把会被注入的 DLL 放进了要删的目录里**。
        ///     挪到 %TEMP%\JWautofill\hooks\ 之后：安装目录只剩 exe 与日志
        ///     （守护进程一被杀就释放）⇒ 卸载必然成功；暂存目录交给系统 Temp 机制。
        /// </summary>
        internal static string HookStageDir =>
            Path.Combine(Path.GetTempPath(), "JWautofill", "hooks");
        /// <summary>插件目录布局里的**最新构建**（自安装同步的源）。</summary>
        internal static string? LocalSourceDll()
        {
            try
            {
                string bd = AppContext.BaseDirectory;
                string[] cands =
                {
                    Path.Combine(bd, "JWautofillWintabHook.dll"),
                    Path.Combine(bd, "..", "..", "WintabHook", "publish", "JWautofillWintabHook.dll"),
                };
                foreach (var c in cands)
                {
                    string f = Path.GetFullPath(c);
                    if (File.Exists(f)) return f;
                }
            }
            catch { }
            return null;
        }

        /// <summary>在目录里挑**最新**的带内容戳副本（没有则返回 false）。</summary>
        private static bool TryPickStamped(string dir)
        {
            try
            {
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return false;
                var stamped = Directory.GetFiles(dir, "JWautofillWintabHook.*.dll");
                if (stamped.Length == 0) return false;
                Array.Sort(stamped, (a, b) => File.GetLastWriteTimeUtc(b).CompareTo(File.GetLastWriteTimeUtc(a)));
                _dllPath = stamped[0];
                return true;
            }
            catch { return false; }
        }

        private static void EnsureDllPath()
        {
            if (!string.IsNullOrEmpty(_dllPath)) return;
            try
            {
                string bd = AppContext.BaseDirectory;
                // ① 暂存目录里带戳的副本优先：注入源**必须**是安装目录之外的地方
                //    （否则又把安装目录锁住 —— 见 HookStageDir 的注释）。
                if (TryPickStamped(HookStageDir)) return;
                // ② 兼容旧布局：安装目录里带戳的副本（就是它曾经把安装目录锁住的）
                if (TryPickStamped(bd)) return;
                string[] cands =
                {
                    Path.Combine(HookStageDir, "JWautofillWintabHook.dll"),             // 暂存目录（无戳）
                    Path.Combine(bd, "JWautofillWintabHook.dll"),                       // 安装目录（与 exe 同级，旧布局）
                    Path.Combine(bd, "..", "..", "WintabHook", "publish", "JWautofillWintabHook.dll"), // 插件目录布局
                };
                foreach (var c in cands)
                {
                    string f = Path.GetFullPath(c);
                    if (File.Exists(f)) { _dllPath = f; return; }
                }
            }
            catch { }
        }

        // ------------------------------------------------------------ 注入
        private const uint PROCESS_NEEDED = 0x0002 /*CREATE_THREAD*/ | 0x0008 /*VM_OPERATION*/
                                          | 0x0010 /*VM_READ*/ | 0x0020 /*VM_WRITE*/
                                          | 0x0400 /*QUERY_INFORMATION*/;
        private const uint MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_RELEASE = 0x8000;
        private const uint PAGE_READWRITE = 0x04;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, IntPtr dwSize,
                                                    uint flAllocationType, uint flProtect);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, IntPtr dwSize, uint dwFreeType);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr GetModuleHandleW(string lpModuleName);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
        private static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer,
                                                      IntPtr nSize, out IntPtr lpNumberOfBytesWritten);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateRemoteThread(IntPtr hProcess, IntPtr lpThreadAttributes,
                                                        IntPtr dwStackSize, IntPtr lpStartAddress,
                                                        IntPtr lpParameter, uint dwCreationFlags,
                                                        out uint lpThreadId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        /// <summary>
        /// 教科书四步：OpenProcess → VirtualAllocEx → WriteProcessMemory(路径) → CreateRemoteThread(LoadLibraryW)。
        ///
        /// 为什么取 LoadLibraryW 的地址不必远程解析：kernel32.dll 在同一会话内映射到**相同基址**
        /// （KnownDLL 共享映像）⇒ 本进程 GetProcAddress 得到的地址在目标进程同样有效。
        /// ⛔ 本进程必须是 x64（csproj 已固定 win-x64），否则地址在 64 位 PS 里无意义。
        /// </summary>
        private static bool Inject(int pid)
        {
            IntPtr h = IntPtr.Zero, mem = IntPtr.Zero;
            try
            {
                h = OpenProcess(PROCESS_NEEDED, false, pid);
                if (h == IntPtr.Zero) { _lastErr = Marshal.GetLastWin32Error(); return false; }

                byte[] bytes = System.Text.Encoding.Unicode.GetBytes(_dllPath + "\0");
                mem = VirtualAllocEx(h, IntPtr.Zero, (IntPtr)bytes.Length, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
                if (mem == IntPtr.Zero) { _lastErr = Marshal.GetLastWin32Error(); return false; }
                if (!WriteProcessMemory(h, mem, bytes, (IntPtr)bytes.Length, out _))
                { _lastErr = Marshal.GetLastWin32Error(); return false; }

                IntPtr loadLib = GetProcAddress(GetModuleHandleW("kernel32.dll"), "LoadLibraryW");
                if (loadLib == IntPtr.Zero) { _lastErr = Marshal.GetLastWin32Error(); return false; }

                IntPtr th = CreateRemoteThread(h, IntPtr.Zero, IntPtr.Zero, loadLib, mem, 0, out _);
                if (th == IntPtr.Zero) { _lastErr = Marshal.GetLastWin32Error(); return false; }
                WaitForSingleObject(th, 5000);
                CloseHandle(th);
                return true;
            }
            catch (Exception ex)
            {
                Console.WriteLine(LogPrefix + "注入异常: " + ex.Message);
                return false;
            }
            finally
            {
                if (mem != IntPtr.Zero && h != IntPtr.Zero) VirtualFreeEx(h, mem, IntPtr.Zero, MEM_RELEASE);
                if (h != IntPtr.Zero) CloseHandle(h);
            }
        }
    }
#endif

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

        // ===== DPI 感知（历史：鼠标回注的坐标口径；现仅作状态上报）=====
        // ⛔ 曾经守护进程必须 DPI 感知，是因为平滑回注走 MOUSEEVENTF_ABSOLUTE | VIRTUALDESK，
        //    其分母来自 GetSystemMetrics(SM_*VIRTUALSCREEN)，与 SendInput 的物理像素口径必须一致。
        //    鼠标钩子平滑已于 2026-10-12 整体移除（只保留笔/Wintab 通路，见 PenHook），
        //    此处 DPI 设置与 getState 的 dpiAwareness 字段保留作兼容与排障参考。
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
        internal const string Version = "2026-10-12.7";

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
            "penSmooth",        // 笔输入层平滑（注入 PS 改 Wintab 包坐标）
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
        private static volatile bool _hookSafeMode = false;
        // 熔断时刻（TickCount64；0 = 未熔断）。冷却期满由**本子系统自己的**看护线程复位并重挂。
        // ⛔ 熔断必须是可自愈的：低层钩子回调一次卡顿（GC/页面交换/驱动抖动）就会触发熔断，
        //    若做成单向闩锁，一次抖动就永久废掉快捷键，只能重启进程才能恢复。
        private static long _hookSafeModeSince = 0;
        // 单次钩子回调的耗时预算（毫秒）。Windows 对低层钩子有超时限制，超时会被系统摘除；
        // 这里设得更保守，超预算即自我熔断，确保不会成为系统输入链的瓶颈。
        private const long HookBudgetMs = 100;
        /** 熔断冷却时长：期满自动复位该子系统的熔断标志并重挂钩子。 */
        private const long SafeModeCooldownMs = 30000;
        /**
         * **连续**超预算多少次才真正熔断。
         * ⛔ 单次超预算不能熔断：托管环境的 GC 停顿、调度抖动都可能让某一帧偶发变慢，
         *    若「一次即断」，一次转瞬即逝的卡顿就毁掉接下来 30s 的热键。
         *    ≥3 次连续才说明这条回路真的不健康；恢复正常即清零计数器。
         */
        private const int SafeModeStrikes = 3;
        // 录制线程：持有独立消息循环，全局键盘钩子必须装在带消息循环的线程上
        private static int _recThreadId = 0;
        private static readonly ManualResetEventSlim _recThreadReady = new(false);
        /** 承载键盘钩子的线程对象：看护线程据此做存活探针（线程意外死亡 ⇒ 重建）。 */
        private static Thread? _recThreadRef;

        // ===== 键盘钩子的运行期启停（与鼠标钩子解耦的关键一环）=====
        // 此前键盘钩子只在进程启动时装一次、只有「全局卸载」才卸，因此「禁用热键」只能靠清空
        // 热键表让钩子空转 —— 钩子本身仍挂在系统输入链上，且没有任何运行期卸载通路。
        // 现在它有自己的装卸指令（WM_HOOK_INSTALL / WM_HOOK_UNINSTALL），装卸只作用于 _hookId。
        // （鼠标钩子平滑通路已于 2026-10-12 移除，此处不再有第二个钩子系统。）
        private static volatile bool _hotkeyArmed = true;
        private const int WM_HOOK_UNINSTALL = 0x8008; // 录制线程：卸载常驻低层键盘钩子

        private static volatile bool _hotkeyPendingBreakLog = false;
        private static int _hotkeyBreakElapsedMs = 0;
        private static int _hookSafeModeStrikes = 0;   // 键盘侧的连续超预算计数（仅钩子线程读写）

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
#if ROLE_SMOOTH
                        // ⛔⛔ 笔平滑 hook DLL 的同步**不能**放进下面的 `if (needCopy)`：
                        //     exe 没变（needCopy=false）而 DLL 变过是常态，那时 DLL 就再也不会
                        //     被同步 —— 真机正是因此一直用着旧 DLL。
                        // ⛔⛔ 而且必须**带内容戳的文件名**：PS 一旦被注入过，旧 DLL 就被进程
                        //     锁住，File.Copy 覆盖必抛「文件正由另一进程使用」（daemon.log 实证）
                        //     ⇒ 安装目录里永远是第一次那份 ⇒ 改了 C 代码也不生效。
                        //     带戳的新文件名每次构建都不同，旧副本被占也挡不住新副本落地。
                        // ⛔⛔ 落点必须是**暂存目录**（%TEMP%\JWautofill\hooks\），不能是安装目录：
                        //     否则 PS 会把安装目录锁住 ⇒ 卸载时删不掉（详见 HookStageDir）。
                        try
                        {
                            var hookDll = PenHook.LocalSourceDll() ?? PenHook.DllPath;
                            if (!string.IsNullOrEmpty(hookDll))
                            {
                                Directory.CreateDirectory(PenHook.HookStageDir);
                                string stamp = "";
                                try { stamp = (GetFileHash(hookDll) ?? "").Substring(0, 8); } catch { }
                                if (stamp.Length == 0) stamp = DateTime.Now.ToString("yyyyMMddHHmmss");
                                string dst = Path.Combine(PenHook.HookStageDir, "JWautofillWintabHook." + stamp + ".dll");
                                if (!File.Exists(dst))
                                {
                                    File.Copy(hookDll, dst, false);
                                    Console.WriteLine(LogPrefix + " 已同步笔平滑 hook DLL: " + dst);
                                }
                                PenHook.SetDllPath(dst);
                                // 清理更早的戳名副本：仍被 PS 加载的删不掉，忽略即可。
                                try
                                {
                                    foreach (var f in Directory.GetFiles(PenHook.HookStageDir, "JWautofillWintabHook.*.dll"))
                                    {
                                        if (string.Equals(f, dst, StringComparison.OrdinalIgnoreCase)) continue;
                                        try { File.Delete(f); } catch { }
                                    }
                                }
                                catch { }
                            }
                        }
                        catch (Exception ex) { Console.WriteLine(LogPrefix + " 笔平滑 DLL 同步失败: " + ex.Message); }
#endif
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
#if ROLE_SMOOTH
                // 卸载前**先**把 PS 里的 hook 还原：否则卸载完 PS 还留着一截被改过的代码段
                // （DLL 已被删除，钩子却还在，且共享内存也没了参考）。幂等，关着也安全。
                try { PenHook.Set(false, null); PenHook.RequestUnhook(1200); } catch { }
#endif
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
                // 显式卸载全局键盘钩子：即便 Environment.Exit 略有延迟，也先释放钩子，
                // 避免进程退出前钩子仍挂在系统输入链上造成键盘短暂失灵。
                // （鼠标钩子平滑通路已于 2026-10-12 移除；笔通路由 PenHook 的共享内存指令还原。）
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
#endif

            // 只启动**本角色**的看护线程。拆分后每个进程只有一个子系统，
            // 「一侧卡住拖住另一侧」在进程边界上已经不可能发生。
#if !ROLE_SMOOTH
            var hotkeyWatchdog = new Thread(HotkeyWatchdog) { IsBackground = true, Name = "热键看护" };
            hotkeyWatchdog.Start();
#else
#endif

            _ = Task.Run(() => RunWebSocketServer());
            _ = Task.Run(WatchPhotoshop);

#if ROLE_SMOOTH
            // 笔输入层平滑（Wintab 通路）：建共享内存 + 起心跳线程。
            // 注入不在这里做 —— 由 WatchPhotoshop 的巡检触发（且只在功能开启时）。
            PenHook.Init();
            // 状态推送：hook 的「挂载 / 标定」是异步完成的，面板点开关那一刻状态必然还是 0，
            // 必须靠这一路周期性推送把真实状态送上去（详见 SmoothStatePump 的注释）。
            var smoothPump = new Thread(SmoothStatePump) { IsBackground = true, Name = "平滑状态推送" };
            smoothPump.Start();
#endif

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
            Console.WriteLine(LogPrefix + " 已就绪，等待面板下发套索平滑指令...");
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
                // ⛔ 覆盖前先留一份备份（<配置>.bak）。
                //    热键是用户一条条录出来的，一旦被默认值冲掉**无法重建** ——
                //    2026-10-13 就发生过一次（面板拿到空配置后回写默认条目）。
                //    面板侧的自愈判据已修（见 HotkeyBridge.canPersistConfig），
                //    这里再兜一层：出事后至少有一份可手工还原的副本。
                try
                {
                    if (File.Exists(_configPath)) File.Copy(_configPath, _configPath + ".bak", true);
                }
                catch { /* 备份失败不影响主流程 */ }
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
                // ⛔ 整轮包在 try/catch 里：本循环产物 _psPids 是键盘钩子侧的前置条件
                //    （RefreshPsPids 抛异常会让整条探测线程消失 ⇒ 热键「莫名失效」且无日志）。
                //    （鼠标钩子平滑通路已于 2026-10-12 移除，它曾是 _psPids 的另一个消费者。）
                try
                {
                    bool psRunning = false;
                    try { psRunning = Process.GetProcessesByName("photoshop").Length > 0; } catch { }
                    RefreshPsPids(psRunning);
                    if (psRunning) sawPs = true;
#if ROLE_SMOOTH
                    // 笔平滑：只在功能开启时注入（PS 换了进程会自动补注入）
                    if (psRunning) PenHook.SyncInjection();
#endif
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
        // （鼠标钩子平滑通路已于 2026-10-12 移除，本进程现在只有键盘这一个钩子子系统。）
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
            Console.WriteLine(LogPrefix + " 常驻键盘钩子已卸载（热键禁用）");
        }

        /// <summary>
        /// 热键钩子的布防 / 撤防（运行期独立装卸）。
        ///
        /// ⛔ **不在此处广播**：指令是异步投递给钩子线程执行的，
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
        //    高频热路径（每一次熔断判定）一律**不得**在此打日志 ——
        //    真机证据：唯一带日志的那一帧，恰好就是耗时 306ms 的那一帧。
        //    热路径的可观测性改走「零 I/O 内存埋点 + 看护线程代打」：
        //    埋点见 _hookSafeModeStrikes / _hotkeyBreakElapsedMs，代打见 _hotkeyPendingBreakLog。
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
            // 线程体第一件事就是按当前意图自行装配（键盘 ⇒ 尊重 _hotkeyArmed），
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
        /// ⚠️ 刻意**不做**「定时无条件重挂」：键盘钩子的重挂在
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
                            "（" + (SafeModeCooldownMs / 1000) + "s 后自动复位并重挂）");
                    }

                    // ② 熔断自愈：冷却期满复位并重挂
                    if (_hookSafeMode)
                    {
                        long since = Interlocked.Read(ref _hookSafeModeSince);
                        if (since != 0 && now - since >= SafeModeCooldownMs)
                        {
                            _hookSafeMode = false;
                            Interlocked.Exchange(ref _hookSafeModeSince, 0);
                            Console.WriteLine(LogPrefix + " 键盘钩子熔断冷却期满，已复位并重挂");
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

        /// <summary>套索（笔输入层）平滑状态 JSON。</summary>
        /// 鼠标通路（2026-10-12 移除）曾在此携带 armed/dragging/hookInstalled/safeMode 与回注指标，
        /// 现已全部删除；只剩 pen（Wintab 通路）快照。
        private static string SmoothStateJson()
        {
            return JsonSerializer.Serialize(new
            {
                type = "smoothState",
                protocol = ProtocolVersion,
#if ROLE_SMOOTH
                // 笔输入层平滑（Wintab 通路）的完整状态：开关 / 注入到哪些 PS / 标定结果 / 计数
                pen = PenHook.Snapshot(),
#endif
            }, JsonOpts);
        }


        /// <summary>上一次广播出去的平滑状态原文（供 SmoothStatePump 做去重）。</summary>
        private static string _lastSmoothJson = "";

        private static void BroadcastSmoothState()
        {
            try
            {
                string json = SmoothStateJson();
                _lastSmoothJson = json;
                Broadcast(json);
            }
            catch { /* 广播失败不影响平滑开关本身 */ }
        }

        /// <summary>
        /// 平滑状态的**周期性推送**（ROLE_SMOOTH 专属）。
        ///
        /// ⛔ 为什么必须有它（真机事故「状态条永远停在『注入中…』，切一下模式才变『生效中』」）：
        ///    面板那四档文案全部读共享内存里的 <c>CFG_I_STATE</c>，而 hook DLL 是**异步**完成
        ///    「注入 → 挂载 → 标定」的 —— 面板点下开关那一刻它必然还是 0（未标定）。
        ///    此前只在**收到 penSmooth 指令时**广播一次，于是状态被永久冻结在那个瞬时值；
        ///    下一次广播只可能由用户再发一条指令触发（切模式恰好就是），这正好解释了
        ///    「切模式才变生效中」。
        ///    ⇒ 状态必须由守护进程**主动推**，不能靠面板轮询触发。
        ///
        /// 采样 500ms、**payload 变化才发**：笔不动时 packets/state 都不变，不产生任何流量。
        /// </summary>
        private static void SmoothStatePump()
        {
            while (true)
            {
                Thread.Sleep(500);
                try
                {
                    string json = SmoothStateJson();
                    if (string.Equals(json, _lastSmoothJson, StringComparison.Ordinal)) continue;
                    _lastSmoothJson = json;
                    Broadcast(json);
                }
                catch { /* 推送失败不影响平滑本身 */ }
            }
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

                // ⛔ 这里**绝不**主动推送配置（2026-10-14 修复，用户报「配置路径不一致」告警）：
                //    面板 onopen 里的序列是「await resolveConfigPath() → setConfigPath → getConfig」，
                //    首条 setConfigPath 是**异步**到达的（getDataFolder() 有延迟）。握手后立刻推送，
                //    首帧携带的是默认路径（%LOCALAPPDATA%\JWautofill\hotkeys.json）而非面板指定的
                //    PluginData 路径 ⇒ 面板判出不一致、告警并重发 setConfigPath；更糟的是该帧 payload
                //    通常是空/旧配置 ⇒ ensureMainToggleEntry 按「首次使用」补 Ctrl+Q ⇒ pushConfig 被
                //    canPersistConfig 护栏拦截 ⇒ 第二条「已跳过本次落盘」告警，用户在窗口期内的改动
                //    还会被随后到达的修正帧静默覆盖。
                //    面板本就会显式发 getConfig 请求配置，删除此推送不丢任何信息；
                //    setConfigPath 命中路径变化时 SetConfigPath→ReloadConfig→BroadcastConfig 会广播，
                //    对齐后的配置帧必然到达。
#if ROLE_SMOOTH
                // ⛔ 客户端连上 ⇒ 立刻补一次注入巡检（2026-10-14，用户报「刚加载插件时
                //    平滑不生效、HUD 不显示，要反复操作才有机会恢复」）。
                //    成因：面板重载后 penOn 初值 false ⇒ resendLassoSmoothing 不重放
                //    penSmooth；而 WatchPhotoshop 的**第一轮**要先睡满 3 秒才巡检 ⇒ 这 3 秒
                //    里即便守护进程是开着的也不注入/挂载 —— 正是「加载初期不稳定」的窗口。
                //    SyncInjection 内部对 !_enabled 早退（关闭态零成本），末尾自带 HealIfUnhooked。
                //    ⚠️ 必须 Task.Run：注入要做进程枚举 + 远线程注入，直接内联会堵住本客户的读循环。
                _ = Task.Run(() => { try { PenHook.SyncInjection(); } catch { /* 巡检失败由下 3s 后的轮次兜底 */ } });
#endif

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
                                // DPI 感知级别（历史字段：曾是绝对回注的坐标口径，现作排障参考）。
                                // 本机是 100% 缩放，这里报什么都看不出差别。
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
                                // 套索（笔输入层）平滑状态：注入到哪些 PS / 标定结果 / 计数
                                pen = PenHook.Snapshot()
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
#if ROLE_SMOOTH
                        else if (type == "smoothStatus")
                        {
                            // 套索平滑状态查询（也是面板的**能力探针**）：
                            // 建连后面板会发一条，支持则必回一帧 smoothState；旧版守护进程
                            // 把未知 type 静默丢弃 ⇒ 什么都不回，面板据此标记「版本过旧」。
                            SendToClient(client, SmoothStateJson());
                        }
                        else if (type == "penSmooth")
                        {
                            // 套索平滑（Wintab 笔输入通路）：开关 + **整包参数**。
                            // 面板上现在只有这一个平滑开关（鼠标钩子通路已于 2026-10-12 移除）。
                            // ⚠️ 早期只读 on/strength，半径/模式/张力/追笔/拐角**全部没接上**，
                            //    面板调了毫无反应（真机已验证）。现在用可空字段逐项合并：
                            //    缺字段 = 保持原值，不会被默认值冲掉。
                            bool on = ReadBool(doc.RootElement, "on", defaultValue: false);
                            var wire = JsonSerializer.Deserialize<PenHook.PenWire>(doc.RootElement.GetRawText(), JsonOpts);
                            var p = PenHook.SnapshotParams();
                            if (wire != null)
                            {
                                if (wire.Mode.HasValue)        p.Mode        = wire.Mode.Value;
                                if (wire.Strength.HasValue)    p.Strength    = wire.Strength.Value;
                                if (wire.Radius.HasValue)      p.RadiusPx    = wire.Radius.Value;
                                if (wire.CatchUp.HasValue)     p.CatchUp     = wire.CatchUp.Value;
                                if (wire.CornerAngle.HasValue) p.CornerAngle = wire.CornerAngle.Value;
                                if (wire.Hud.HasValue)         p.Hud         = wire.Hud.Value;
                                if (wire.HudColor.HasValue)    p.HudColor    = wire.HudColor.Value;
                                if (wire.SpeedAdaptive.HasValue)
                                    p.Flags = (p.Flags & ~1) | (wire.SpeedAdaptive.Value ? 1 : 0);
                                // 工具闸门（面板 300ms 巡检「当前工具是不是套索」）。
                                // ⚠️ 单独一条指令也行，但搭车走 penSmooth 更省一条消息 ——
                                //    闸门与参数同源、同节流，避免两者错位出「界面上是套索、
                                //    DLL 那边按画笔处理」的窗口。
                                if (wire.ToolGate.HasValue)   p.ToolGate    = wire.ToolGate.Value;
                            }
                            PenHook.Set(on, p);
                            // 参数/闸门更新不会触发挂载命令（见 Set 里的去重），
                            // 因此这里补一次「已卸载就重挂」——面板重连时的重放、
                            // 工具闸门心跳都会经过这条路径，越快自愈越好。
                            PenHook.HealIfUnhooked();
                            BroadcastSmoothState();
                        }
#endif
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
                // ⛔ 两段清理**各自独立 try/catch**：录制与退格删除是两个互不相干的子系统。
                //    （原第三段「套索平滑布防清理」随鼠标钩子平滑一并移除，2026-10-12）

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


                TryQuiet(() => { lock (_clientsLock) _clients.Remove(client); }, "断开时移除客户端");
                try { client.Close(); } catch { }
            }
        }

        private static void SendConfigToClient(TcpClient client)
        {
            SendToClient(client, BuildConfigMessage());
        }

        private static void BroadcastConfig()
        {
            var msg = BuildConfigMessage();
            lock (_clientsLock)
            {
                foreach (var c in _clients.ToArray())
                {
                    try { SendToClient(c, msg); }
                    catch { try { c.Close(); } catch { } }
                }
            }
        }

        /// <summary>
        /// 配置帧：条目 + **本条配置实际来自哪个文件**。
        /// </summary>
        /// <remarks>
        /// ⛔ 为什么必须带上 path（2026-10-13 用户报「关掉 PS 重载后热键全没了」）：
        ///    守护进程在某个瞬间可能还没拿到面板下发的配置路径（`_configPath` 仍指向
        ///    默认位置，而那里没有文件）⇒ 读到空列表 ⇒ 面板收到「空配置」后按
        ///    「首次使用」补默认条目（主开关 / 套索键）并**回写落盘**，把用户的
        ///    笔刷热键整份冲掉。面板侧现在用这个字段做判据：**路径不可用就绝不回写**。
        /// </remarks>
        private static string BuildConfigMessage()
        {
            var items = ReadConfigFile();
            return JsonSerializer.Serialize(new
            {
                type = "config",
                payload = items,
                path = _configPath ?? "",
            }, JsonOpts);
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
