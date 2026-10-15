/* ============================================================================
 * wintab_hook.c —— 笔输入层实时平滑（P3）：在 Photoshop 进程内改写 Wintab 包坐标
 *
 * 与「鼠标低层钩子 + SetCursorPos/SendInput 回注」是**两条独立通路**：
 *   - 数位板路径：PS 静态导入并用 Wintab（`UseSystemStylus 0`），笔**不产生**
 *     `WM_MOUSEMOVE` ⇒ 鼠标钩子够不着（P1/P2 已实测闭环）。
 *   - 本文件走的是**输入层最上游**：PS 每次取包都经过 `Wintab32!WTPacketsGet` 这个
 *     唯一咽喉（P2 实测：复位后只有这一个函数被调用，笔划时返回值（包数）增长）。
 *
 * ── 为什么能安全地 inline hook（P2 侦察的结论，此处直接复用）─────────────────
 * `Wintab32.dll` 的每个导出入口本体**就是一条 5 字节 `E9 rel32`**，且磁盘 == 内存
 * （出厂代码，无人 hook 过）⇒ ①被覆盖的 5 字节本身是一条完整指令，**不需要长度
 * 解码器、不需要搬迁指令**；②`E9` 的目标就是真实现体，**直接 call impl 与原语义
 * 逐位等价，不需要跳板**。唯一约束是 `rel32` 只有 ±2GB 射程 ⇒ 就近分配转发桩。
 *
 * ── 为什么只钩 Wintab32 一层 ────────────────────────────────────────────────
 * `Wintab32` 是 `Wacom_Tablet` 的**上层包装**（P2 实测：两者 `pkts` 严格相等）。
 * 两层都钩 = 双计数 / 双平滑。实际处理只放外层，拿到的是 PS 最终看到的数据。
 *
 * ⛔⛔ 本文件的 detour 跑在 **PS 自己的取包线程**上（~52Hz）。因此与守护进程的
 *     `LowLevelMouseProc` 遵守同一条铁律：**均摊 O(1)、零 I/O、零分配、不加锁、不抛异常**。
 *     日志一律由后台 worker 线程写，detour 内**一个字都不写文件**。
 *
 * ── 标定：改写坐标前必须知道「第几个字节是 X/Y」────────────────────────────
 * Wintab 的 PACKET 是**变长**的：包含哪些字段由上下文的 `lcPktData` 掩码决定，
 * 字段顺序固定（Context→Status→Time→Changed→Serial→Cursor→Buttons→X→Y→…）。
 * 因此偏移**绝不能硬编码**。本文件用两条**互相独立**的证据交叉验证后才允许写：
 *   ① `WTGet(hCtx,&lc)` 读 `lcPktData` 掩码 → 按固定顺序累加字段尺寸，推出
 *      stride / offSerial / offX / offY；
 *   ② 在缓冲里**盲扫**「逐包恰好 +1」的 4 字节字段 —— `pkSerialNumber` 的自然性质，
 *      得到 (stride, offSerial) 两个**与掩码无关**的观测值。
 * 两者一致 ⇒ 才启用改写；不一致 ⇒ **只 dump 不写**（写错偏移会污染 buttons 等字段，
 * 可能造出幽灵按键）。这条闸门是「宁可不平滑，也绝不写坏数据」。
 *
 * ── 配置：命名共享内存（守护进程创建/写，本 DLL 只读命令 + 回写状态）──────────
 *   name  : Local\JWautofillWintabSmooth
 *   布局  : 若干 32 位有符号槽（见 CFG_* 宏）
 *   回写  : hookState / hookCalls / hookPackets / 标定结果 / cmdAck
 * 用共享内存而非文件/管道：读侧只是普通内存读，**不产生任何系统调用**。
 *
 * ── 卸载 ───────────────────────────────────────────────────────────────────
 * ⛔ 直接 `FreeLibrary` 必崩（入口里留着指向本模块的 `E9`）。必须**先还原字节**。
 *    两条路径：MSG_CMD=2（守护进程经共享内存下令，推荐）或导出 `jwwh_unhook()`。
 *
 * 构建（便携 zig，见 native/get-zig.sh）：
 *   "$USERPROFILE/zig-toolchain/zig.exe" cc -target x86_64-windows-gnu \
 *       -shared -O2 -o JWautofillWintabHook.dll wintab_hook.c
 * ==========================================================================*/

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wingdi.h>     /* WIN32_LEAN_AND_MEAN 会裁掉 GDI：HUD 自绘需要，显式补回 */
#include <tlhelp32.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>

typedef unsigned __int64 u64;
typedef unsigned int     u32;
typedef unsigned char    u8;
typedef void*            HCTX;

/* ---------------------------------------------------------------- Wintab 常量 */
/* 字段掩码（wintab.h 的 PK_*）：决定 PACKET 里有哪些字段、以及它们的先后。 */
#define PK_CONTEXT           0x0001
#define PK_STATUS            0x0002
#define PK_TIME              0x0004
#define PK_CHANGED           0x0008
#define PK_SERIAL_NUMBER     0x0010
#define PK_CURSOR            0x0020
#define PK_BUTTONS           0x0040
#define PK_X                 0x0080
#define PK_Y                 0x0100
#define PK_Z                 0x0200
#define PK_NORMAL_PRESSURE   0x0400
#define PK_TANGENT_PRESSURE  0x0800
#define PK_ORIENTATION       0x1000
#define PK_ROTATION          0x2000
#define PK_ALL               0x3FFF

/* WTInfo 的分类/索引 */
#define WTI_DEVICES   0
#define DVC_X         1
#define DVC_Y         2

#define RELAY_SIZE  16
#define PAGE_SPAN   0x10000

typedef u64 (*GEN6)(u64, u64, u64, u64, u64, u64);

/* 只对**我们真正要用返回值/参数**的函数给出精确原型；其余一律 GEN6 透传。 */
typedef int (*PFN_WTPacketsGet)(HCTX hCtx, int cMaxPkts, void* lpPkts);
typedef u32 (*PFN_WTInfoA)(u32 wCategory, u32 nIndex, void* lpOutput);
typedef int (*PFN_WTGetA)(HCTX hCtx, void* lpLogCtx);

/* WTGet 回写的是**整个 LOGCONTEXT**（wintab.h 里约 172 字节），远超 lcPktData 的偏移。
 * 真机根因（2026-10-12）：这里原先只声明到 lcPktData 且**漏了 lcDevice 字段**
 * （真实顺序 lcName[40]→lcOptions→lcStatus→lcLocks→lcMsgBase→lcDevice→lcPktRate→lcPktData），
 * 于是「偏移 60」实际读到 lcPktRate（200Hz 报告率 = 0xC8），掩码无 PK_X ⇒ 标定永败
 * ⇒ 平滑从未生效 + 拉绳 HUD 不显示。且让 WTGet 往 60 字节栈结构写 172 字节 = 栈溢出。
 * 修法：给 256 字节全尺寸零缓冲让 WTGet 写，按真实偏移 64 取掩码（附 4 字节余量防未来扩展）。 */
#define WT_LC_BUFSZ      256
#define WT_LC_PKTDATA_OFF 64

/* 输入量程（lcInExtX / lcInExtY）：LOGCONTEXT 里的真实偏移，实测确认
   （cat=3/4 的 WTInfo 回读：偏移 96 = 44800、偏移 100 = 29600，与 wintab.h 的
    lcInOrgX(84)/lcInOrgY(88)/lcInOrgZ(92)/lcInExtX(96)/lcInExtY(100) 完全吻合）。
   ⛔ 不再用 WTInfoA(WTI_DEVICES, DVC_X) 取上界：本文件原先写的 WTI_DEVICES=0 是错的
    （真值 6），而 DVC_X 的索引也无法在本机探测到 ⇒ 那个调用恒失败，32767 其实是
    「读不到就兜底」的常量，看起来像读到了、实则是假证据。 */
#define WT_LC_INEXTX_OFF 96
#define WT_LC_INEXTY_OFF 100
/* 输出量程 / 输出原点：紧接 lcInExtZ(104) 之后 —— lcOutOrgX(108)/lcOutOrgY(112)/
   lcOutOrgZ(116)/lcOutExtX(120)/lcOutExtY(124)。这是**驱动自己声明的
   轴→屏幕映射**（含 Y 符号：Wintab 惯例 lcOutExtY 常为负 = 屏幕上 Y 向下），
   比任何测量都权威。见 [calib] 的「驱动映射」行。 */
#define WT_LC_OUTORGX_OFF 108
#define WT_LC_OUTORGY_OFF 112
#define WT_LC_OUTEXTX_OFF 120
#define WT_LC_OUTEXTY_OFF 124

/* AXIS（WTInfo(WTI_DEVICES, DVC_X, &axis) 的返回体）：axMin/axMax/axUnits/axResolution */
typedef struct { int axMin; int axMax; u32 axUnits; u32 axResolution; } AXIS_T;

/* ================================================================= 共享内存配置
 * 守护进程 `MemoryMappedFile.CreateOrOpen("Local\\JWautofillWintabSmooth", ...)`
 * 与本 DLL 的 `OpenFileMappingW` 指向同一块。全部按 32 位有符号槽访问。 */
#define CFG_NAME      L"Local\\JWautofillWintabSmooth"
#define CFG_MAGIC     0x57414A57L      /* 'JWAW' */
#define CFG_NLONGS    48

enum {
    CFG_I_MAGIC = 0,
    CFG_I_ENABLED,        /* 0/1                    面板开关（守护进程写） */
    CFG_I_STRENGTH,       /* 0..100                 平滑强度     */
    CFG_I_FLAGS,          /* bit0=速度自适应          */
    CFG_I_SEQ,            /* 配置版本号（排查用）                   */
    CFG_I_CMDSEQ,         /* 命令序号（守护进程每下令 +1）           */
    CFG_I_CMD,            /* 0=无 1=挂 2=卸                        */
    CFG_I_CMDACK,         /* 已执行到的 CMDSEQ                     */
    /* ---- 以下为本 DLL 回写（守护进程只读） ---- */
    CFG_I_STATE,          /* 0=未挂 1=生效 2=标定失败 3=已卸载 4=入口被旧副本占用 */
    CFG_I_CALLS,
    CFG_I_PACKETS,
    CFG_I_SMOOTHED,
    CFG_I_STRIDE,
    CFG_I_OFFX,
    CFG_I_OFFY,
    CFG_I_OFFSER,
    CFG_I_AXISMAX,
    CFG_I_PID,
    CFG_I_FROZE,          /* 改写期挂起的线程数                     */
    CFG_I_HEARTBEAT,      /* 守护进程每秒写入 GetTickCount()        */
    /* ---- P3.1：整包参数（面板与鼠标通路共用同一份参数面）---- */
    CFG_I_MODE,           /* 0=标准 1=拉绳 2=追笔                   */
    CFG_I_TENSION,        /* ⛔ 已废弃（2026-10-13「张力」并入「半径」）——
                            槽位**保留占位不重编号**：它与 C# 侧逐项对应，
                            少一行就会让后面 11 个槽整体错位（错位不报错、只静默出怪事）。*/
    CFG_I_CATCHUP,        /* 0..100   追笔速度。⛔ 面板下发的是**原生**值：面板「追笔力度」
                            显示 1–100，经 LassoSmoothing.catchUpToNative() 反向映射成
                            1–50（显示越大 → 本值越小 → vmax 越小 → 越黏）。        */
    CFG_I_CORNER,         /* 0..90    拐角转折角阈值：转折角 > 本值即判为拐角。
                            ⛔ 阈值越小越易触发保护 ⇒ 面板「保护范围」= 90 − 本值。   */
    CFG_I_RADIUSPX,       /* 1..100   最大滞后（屏幕等效像素）       */
    CFG_I_HUD,            /* bit0=leash 线 bit1=半径圆 bit2=原始点  */
    CFG_I_HUDCOLOR,       /* 0xRRGGBB，默认 #E07F0D（2026-10-14 用户要求，与 PS 原生洋红区分）*/
    CFG_I_PXPERAXIS,      /* ×1000：渲染线程用真实光标标定的轴→像素比 */
    /* ---- P3.2：触发闸门（面板/守护进程写，DLL 读）---- */
    CFG_I_TOOLGATE,       /* 0=非套索 1=套索 2=未知(面板未开) —— 见下 */
    CFG_I_GATETS,         /* 闸门写入时刻（GetTickCount 口径）——超时即降级 */
    CFG_I_PENDOWN,        /* DLL 回写：当前是否「笔尖接触画布」（1/0）           */
    CFG_I_GATEOK,         /* DLL 回写：闸门是否成立（1=正在平滑）                 */
    CFG_I_CTUNKNOWN,      /* DLL 回写：落笔判据不可用（1=已退化为「按落笔」放行）  */
    /* ---- P3.3：Y 轴分量的「轴→像素」比（**带符号**）---- */
    CFG_I_PXPERAXISY,     /* ×1000：Y 轴。⛔ 符号**必须**保留：
                             Wintab 包的 Y 向上为正、屏幕 Y 向下为正 ⇒ 两者符号相反。
                             HUD 的圆心偏移必须按分量换算，用不带符号的标量会把圆心
                             渲染成光标的**镜像**（真机实测：向右上运笔时圆心跑到左上方）。*/
    /* ---- P3.4（2026-10-14）：快照新鲜度 —— 面板「平滑中断」检测的数据源 ---- */
    CFG_I_SNTS,           /* DLL 回写：最后一次快照发布的 GetTickCount()。
                             ⛔ 与 packets 的区别：标定丢失等「断流」故障里 packets 照涨
                             （PS 还在空取原始包），而快照**冻结** —— 面板靠
                             「packets 在涨 + SNTS 不动」把「真断流」与「正常停笔」分开。 */
    /* ---- P3.5（2026-10-14 第三轮）：把「此刻为什么没在改写」直接报出来 ----
       ⛔⛔ 为什么必须由**原生侧**报，而不是面板自己拼：
          面板能看到的只有 toolGate / penDown / gateOk 三个布尔，而原生侧在闸门
          **不成立时会主动把 penDown 写成 0**（见 smooth_packets 的阻断分支）——
          于是「闸门心跳过期」和「笔尖真的悬空」在面板上长得一模一样，诊断只会
          说「等笔尖落纸」，用户落着笔看这句话只能更迷惑（真机复现）。
          ⇒ 唯一可行的做法：DLL 在**裁决的同一处**写下原因码，面板只做展示。 */
    CFG_I_REASON,         /* 受阻原因码（RS_*，0=正在改写）——面板诊断条的唯一权威 */
    CFG_I_GATEOPEN,       /* 闸门由关→开累计次数（= 起笔次数，**累计值**） */
    CFG_I_GATECLOSE,      /* 开→关累计次数（**累计值**）。⛔⛔ 判抖动**必须用两次读数的增量**，
                             不能直接看两个总数的差额：画了一百笔之后两者都是 100 附近、
                             差额恒为 0，光看总数永远看不出抖动。正确判据 = 面板两次回报之间
                             Δopen 涨了好几次（见 app.tsx 的 lastGateDeltaOpen）。 */
    CFG_I_CTOFF,          /* 落笔判据**首选**信号偏移（字节，-1=无信号） */
    CFG_I_CTVAL,          /* 首选信号最近一包的原始值（诊断用） */
    CFG_I_PXNX,           /* X 轴标定样本数（< PX_TRUST_N 时未采信，仍用标称兜底） */
    CFG_I_PXNY,           /* Y 轴标定样本数 */
    /* ---- P3.6（2026-10-14 第五轮）：落笔判据由**单字段**改**多信号并联** ----
       ⛔⛔ 起因（用户报「平滑和 HUD 依旧会失灵」，诊断条停在「判据 +32=0」）：
          旧版只认**一个**候选字段（真机取到 32 = pkNormalPressure），而轻触运笔时
          NP 经常读到 0 ⇒ 闸门反复闭合 ⇒ 每次闭合都重新锚定 + HUD 隐藏。
          现在 buttons / pkNormalPressure / pkTangentPressure 三者**任一非零**即「落笔」。
          下面三个槽位就是让面板/日志能看出「到底哪几个信号在投票、此刻命中了谁」。*/
    CFG_I_CTMASK,         /* 本批「非零」信号的位掩码（bit i = 第 i 个信号；0 = 全零） */
    CFG_I_CTELIG,         /* 有投票权的信号位掩码（**只覆盖前 4 个信号**；同时见过 0 与非 0）*/
    CFG_I_CTOFFS,         /* 前 4 个信号的偏移打包（第 i 个占第 i×8 位；0xFF = 该位无信号）*/
};

/* 受阻原因码（CFG_I_REASON 的值域；面板诊断条按它逐条说人话）。 */
enum {
    RS_REWRITE = 0,       /* 正在改写坐标（正常） */
    RS_OFF,               /* 总开关未开 */
    RS_TOOL_NO,           /* 工具闸门：当前工具不是套索 */
    RS_TOOL_UNKNOWN,      /* 工具闸门：面板从未上报过（未知 ⇒ fail-closed 阻断） */
    RS_TOOL_STALE,        /* 工具闸门：心跳过期（面板 >GATE_STALE_MS 未上报） */
    RS_HOVER,             /* 笔尖未落纸（悬空移动） */
    RS_CT_UNKNOWN,        /* 落笔判据**尚未建立**（无信号，或还没有任何信号同时见过 0 与非 0）。
                             冷启动宽限内仍按「落笔」放行（效果好但不完整）；
                             宽限之后一律按「未落笔」阻断，避免悬空也在平滑。 */
    RS_NOCAL,             /* 标定未完成 / 失败 */
    RS_NOCTX,             /* 还没取到包 / 上下文未知 */
};

/* 原因码 → 短名（只给日志用；面板侧有自己的人话文案表，两者都按上面这行顺序写）。 */
static const char* rs_name(LONG r)
{
    switch (r) {
        case RS_REWRITE:     return "改写中";
        case RS_OFF:         return "开关未开";
        case RS_TOOL_NO:     return "非套索";
        case RS_TOOL_UNKNOWN:return "工具未知";
        case RS_TOOL_STALE:  return "心跳过期";
        case RS_HOVER:       return "悬空";
        case RS_CT_UNKNOWN:  return "判据未建立";
        case RS_NOCAL:       return "未标定";
        case RS_NOCTX:       return "无上下文";
        default:             return "?";
    }
}

/* ⛔⛔ 这张槽位表是 C 与 C#（Program.cs 的 PenHook）**两处手写**的，错位不会报错、
   只会让参数静默失效（实测过的坑）。所以：① 用编译期断言守住「槽数不超映射」；
   ② 任何一侧增删槽，另一侧必须同步，且 C# 的 EnsureInit 里有运行时兜底校验。 */
typedef char cfg_slot_fit_check[(CFG_NLONGS >= CFG_I_CTOFFS + 1) ? 1 : -1];

static volatile LONG* g_cfg    = NULL;
static HANDLE         g_cfgMap = NULL;

__declspec(dllexport) int jwwh_version(void);

/* hook 现场（detour 要用 g_impl，故必须在本文件靠前处声明）。 */
static u8* g_impl;

static int cfg_open(void)
{
    if (g_cfg) return 1;
    if (g_cfgMap) return 0;                     /* 上一次失败过，等 worker 重试 */
    g_cfgMap = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, CFG_NAME);
    if (!g_cfgMap) {
        /* M2（.8li 进程内形态，2026-10-14）：没有外置守护进程了 ⇒ 本模块自己就是
           配置节的创建者（plugin_main.c 的 WS 层也会打开同一节写参数）。
           ⛔ 尺寸以最先创建者为准（Program.cs EnsureInit「扩容升级陷阱」同款规则）：
             旧节被残留进程占着时这里会拿到旧尺寸 ⇒ MapViewOfFile 按 CFG_NLONGS
             请求失败 ⇒ g_cfg 保持 NULL ⇒ fail-closed，重启 PS 自愈。 */
        g_cfgMap = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0,
                                      (DWORD)(CFG_NLONGS * sizeof(LONG)), CFG_NAME);
        if (!g_cfgMap) return 0;
    }
    g_cfg = (volatile LONG*)MapViewOfFile(g_cfgMap, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0,
                                          CFG_NLONGS * sizeof(LONG));
    if (!g_cfg) { CloseHandle(g_cfgMap); g_cfgMap = NULL; return 0; }
    return 1;
}

static void cfg_close(void)
{
    if (g_cfg) { UnmapViewOfFile((LPCVOID)g_cfg); g_cfg = NULL; }
    if (g_cfgMap) { CloseHandle(g_cfgMap); g_cfgMap = NULL; }
}

/* ===================================================================== 日志 */
static HANDLE g_log = INVALID_HANDLE_VALUE;
static char   g_logPath[MAX_PATH];
static volatile LONG g_logLock = 0;

static void log_write(const char* s, int n)
{
    if (g_log == INVALID_HANDLE_VALUE || n <= 0) return;
    while (InterlockedExchange(&g_logLock, 1)) Sleep(0);
    SetFilePointer(g_log, 0, NULL, FILE_END);
    /* 2026-10-14（用户要求）：全行加毫秒级时间戳，用于把「失效瞬间」与截图对齐。
       仅落盘路径（worker/标定/事件），205Hz detour 路径依旧零 I/O。 */
    SYSTEMTIME ts; GetLocalTime(&ts);
    char pre[40];
    int pn = _snprintf(pre, sizeof(pre), "[%02u:%02u:%02u.%03u] ",
                       ts.wHour, ts.wMinute, ts.wSecond, ts.wMilliseconds);
    if (pn > 0) { DWORD pw = 0; WriteFile(g_log, pre, (DWORD)pn, &pw, NULL); }
    DWORD w = 0;
    WriteFile(g_log, s, (DWORD)n, &w, NULL);
    FlushFileBuffers(g_log);
    InterlockedExchange(&g_logLock, 0);
}

static void logf(const char* fmt, ...)
{
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, (int)sizeof(buf), fmt, ap);
    va_end(ap);
    if (n > 0) log_write(buf, n);
}

/* ====================================================== 就近分配（±2GB 射程内） */
static u8* alloc_near(u8* target, SIZE_T size)
{
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    const LONG_PTR gran = (LONG_PTR)(si.dwAllocationGranularity ? si.dwAllocationGranularity : 0x10000);
    const LONG_PTR limit = 0x70000000;
    const LONG_PTR base = (LONG_PTR)target & ~(gran - 1);

    for (int dir = 0; dir < 2; dir++) {
        for (LONG_PTR off = gran; off < limit; off += gran) {
            LONG_PTR cand = (dir == 0) ? base - off : base + off;
            if (cand <= (LONG_PTR)gran) break;
            MEMORY_BASIC_INFORMATION mbi;
            if (VirtualQuery((LPCVOID)cand, &mbi, sizeof(mbi)) != sizeof(mbi)) break;
            if (mbi.State == MEM_FREE && (LONG_PTR)mbi.RegionSize >= (LONG_PTR)size) {
                u8* p = (u8*)VirtualAlloc((LPVOID)cand, size, MEM_COMMIT | MEM_RESERVE,
                                          PAGE_EXECUTE_READWRITE);
                if (p) return p;
            }
        }
    }
    return NULL;
}

/* ======================================================== 线程冻结（改写期） */
/* 往入口写 5 字节不是原子操作；若有线程恰在取指这条 jmp，会读到「新 E9 + 旧 rel32」
   的撕裂组合 ⇒ 跳野地址。PS 有上百线程 ⇒ 挂起 → 改 → 恢复。
   ⛔ 窗口内只放不需要 loader lock 的调用（VirtualProtect/memcpy/FlushInstructionCache）。 */
typedef struct { HANDLE h; } TENT;
static TENT g_frz[2048];
static int  g_nfrz, g_frozen, g_frzLast;
static volatile LONG g_overTent;

static void freeze_threads(void)
{
    if (g_frozen) return;
    g_nfrz = 0;
    InterlockedExchange(&g_overTent, 0);
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap != INVALID_HANDLE_VALUE) {
        THREADENTRY32 te;
        te.dwSize = sizeof(te);
        DWORD me = GetCurrentThreadId(), pid = GetCurrentProcessId();
        if (Thread32First(snap, &te)) {
            do {
                if (te.th32OwnerProcessID != pid || te.th32ThreadID == me) continue;
                if (g_nfrz >= (int)(sizeof(g_frz) / sizeof(g_frz[0]))) {
                    InterlockedExchange(&g_overTent, 1);
                    break;
                }
                HANDLE h = OpenThread(THREAD_SUSPEND_RESUME, FALSE, te.th32ThreadID);
                if (!h) continue;
                g_frz[g_nfrz++].h = h;
            } while (Thread32Next(snap, &te));
        }
        CloseHandle(snap);
    }
    for (int i = 0; i < g_nfrz; i++) SuspendThread(g_frz[i].h);
    g_frzLast = g_nfrz;
    g_frozen = 1;
}

static void thaw_threads(void)
{
    if (!g_frozen) return;
    for (int i = 0; i < g_nfrz; i++) { ResumeThread(g_frz[i].h); CloseHandle(g_frz[i].h); }
    g_nfrz = 0;
    g_frozen = 0;
}

static int repatch(u8* entry, const u8* bytes)
{
    DWORD old = 0;
    if (!VirtualProtect((LPVOID)entry, 5, PAGE_EXECUTE_READWRITE, &old)) {
        /* 跨页时第一次会失败：按整页再试一次 */
        UINT_PTR ps = (UINT_PTR)entry & ~(UINT_PTR)0xFFF;
        if (!VirtualProtect((LPVOID)ps, PAGE_SPAN, PAGE_EXECUTE_READWRITE, &old)) return 0;
        memcpy(entry, bytes, 5);
        FlushInstructionCache(GetCurrentProcess(), entry, 5);
        VirtualProtect((LPVOID)ps, PAGE_SPAN, old, &old);
        return 1;
    }
    memcpy(entry, bytes, 5);
    FlushInstructionCache(GetCurrentProcess(), entry, 5);
    VirtualProtect((LPVOID)entry, 5, old, &old);
    return 1;
}

/* ============================================== 笔尖接触判据（落笔 / 悬空）
 * ⛔⛔ 为什么必须单独判「落笔」：用户明确要求「只平滑数位笔操作套索工具**绘制中**的
 *    轨迹」「用户落笔前不希望受到平滑迟滞感」。而悬空移动同样会持续产出 Wintab 包，
 *    且 X/Y 与落笔时同构 ⇒ 只看位移**无法**区分二者。
 *
 * ⛔ 为什么不能直接硬编码偏移：本机 (stride=52, offX=20, offY=24) 对应的合法字段掩码
 *    有 **30 种**（我逐一枚举过），其中 pkNormalPressure / pkTpStatus 存在与否**无法**
 *    由几何定解（12 种有、18 种无），只有 pkButtons 恒定落在 16。
 *    ⇒ 只能**按 wintab.h 的固定字段顺序**从 (offY, stride) 反推候选偏移，
 *    再在运行时用真实数据**逐个证伪**：不是接触场的那个会全程为 0 或全程非 0。
 *
 * 判定规则（保守、可解释）：
 *   候选 = 「紧跟 Y 之后、且落在剩余字节里的压力/笔尖字段」，按 NP 优先排序；
 *   采用第一个 → 若累计 3000 包仍**从未非零**，判定它不是接触场，退下一个候选。
 *   在找到之前（contact 未知）一律**按悬空处理**：宁可第一笔不生效，
 *   也不能让「没找到」退化成「全程平滑」—— 那正是用户抱怨的那件事。 */
#define CT_MAX_SIG    6
#define CT_GRACE_PKT  600       /* 冷启动宽限（包数，≈3s）：尚无信号取得投票权时先按旧行为放行 */
static int   g_ctOff[CT_MAX_SIG];            /* 信号字段偏移（绝对字节，-1=空位） */
static int   g_ctMsk[CT_MAX_SIG];            /* 取值掩码（0=整字；0x07=buttons 低三位） */
static int   g_ctN;                          /* 信号数 */
/* ⛔⛔ 每个信号必须**同时见过 0 与非 0**才有投票权（g_ctElig）：
 *    恒为 0 的字段（部分驱动的 pkButtons）与恒非 0 的字段（pkCursor / Orientation /
 *    离板高度 pkZ）都自动出局 —— 不再需要任何「猜哪个字段才是压力」的盲扫，
 *    也彻底消灭「悬空时字段也非零 ⇒ 全程都在平滑」的老缺陷。
 *    ⚠️ 这条资格是**单向**的：一旦取得就永久保留（真接触场在抬笔时必然回到 0）。 */
static volatile LONG g_ctZeroSeen[CT_MAX_SIG];   /* 该信号「为零」的证据 */
static volatile LONG g_ctNzSeen[CT_MAX_SIG];     /* 该信号「非零」的证据 */
static volatile LONG g_ctElig[CT_MAX_SIG];       /* 1 = 取得投票权 */
static volatile LONG g_ctSeen;       /* 建表以来已观测包数（冷启动宽限计数） */
static volatile LONG g_contact;      /* 最终判定：1=笔尖接触画布 */
static volatile LONG g_ctUnknown;    /* 1 = 判据未建立（无信号 / 尚无信号取得投票权）*/
static volatile LONG g_ctVal;        /* 首选信号最近一包的原始值（诊断用）
                                        由 publish_status 回写 CFG_I_CTVAL */
static volatile LONG g_ctMask;       /* 本批非零信号的位掩码（诊断用；回写 CFG_I_CTMASK）*/
/**
 * 「连续全零」包数（诊断用）：自上一次「任一投票信号非零」以来，累计经过了多少个包。
 * ⛔⛔ 这是本轮**唯一的硬证据来源**：真机诊断条停在与「判据 +32=0」，
 *    但无法区分「那一刻笔真的抬着」与「落着笔但 NP 成段读到 0」。
 *    连续全零包数 × 包间隔(≈5ms@205Hz) 就是「闸门被压住多久」：
 *      < 5 包  ⇒ 判据正常（只是采样抖动）
 *      > 20 包 ⇒ 判据在真实运笔中成段失效（≈100ms 以上的连续零）
 *    面板/日志只需看这一个数就能定性。 */
static volatile LONG g_ctZeroRun;
/**
 * 接触「保持」（hysteresis）：最近一次**任一投票信号非零**的时刻（GetTickCount 口径）。
 *
 * ⛔⛔ 2026-10-14 第三轮（用户报「选区一段段停住、画了很久才开始出现」）：
 *    判据原本是**逐包**取 `v != 0` 直接定 contact —— 而笔压字段在真实运笔中
 *    会出现**瞬时 0**（驱动丢样本、快速运笔时压力重采样、笔尖微抬）。每次瞬时 0 都会：
 *      ① 让本批走「未落笔」分支 ⇒ 坐标原样放过（PS 立刻跟手，观感是选区突然前进）；
 *      ② 置 g_wasEnabled=0 ⇒ 下一批**重新锚定**（输出点被拽到笔尖）；
 *      ③ 于是拉绳的 100px 死区被**重新灌满** ⇒ 选区又停住一段。
 *    一笔之中反复发生，就是「画了很久不出选区、然后突然出现一大段」。
 *    ⇒ 抬笔是**物理动作**（手离开板面），不可能只中断几十毫秒；给保持窗口，
 *      瞬时抖动不再打断笔画，真正的抬笔仍然会被识别（延迟无感）。
 *    ⛔⛔ 2026-10-14 第五轮：窗口由 120ms 抬到 **250ms**。依据是本轮真机日志
 *       `gate/open=48 close=47`（一笔之中闸门反复开合）+ 诊断条「判据 +32=0」：
 *       轻触运笔时 pkNormalPressure 会**成段**读到 0（不是单包抖动），120ms 挡不住。
 *       多信号并联（below）解决主因，窗口加长只是最后一道缓冲。
 *    ⛔ 只影响「何时算抬笔」，不改判据本身。 */
static volatile LONG g_contactMs;
#define CONTACT_HOLD_MS 250

/* ---------------------------------------------------- 信号表（多信号并联）---
 * ⛔⛔ 2026-10-14 第五轮定案（用户报「平滑和 HUD 依旧会失灵」，诊断条原文：
 *    「笔尖未落纸（悬空移动不改写坐标）—— 判据 +32=0」，日志原文：
 *    `reason=5(悬空) gate/open=48 close=47 penDown=0 ctOff=32 ctVal=0`）：
 *    旧版只认**一个**字段（本机盲扫取到 32 = pkNormalPressure）。而套索是**轻触**
 *    运笔 —— 笔压落在第一级以下时驱动如实报 0，成段为 0 而不是单包抖动。后果是
 *      ① 闸门反复闭合（open/close 累计值几乎 1:1 交替）；
 *      ② 每次闭合都置 g_wasEnabled=0 ⇒ 下一包重新锚定（输出点被拽到笔尖）；
 *      ③ 同一判据驱动 HUD 显隐 ⇒ 圈与平滑**同时**消失。
 *    ⇒ 判据改**并联**：buttons / pkNormalPressure / pkTangentPressure **任一非零**
 *      即「落笔」。三者全零且持续 CONTACT_HOLD_MS 才算抬笔。
 *    ⛔ 为什么不取 Z（离板高度）/ Orientation：悬空时它们也非零 —— 取进来就是
 *       「全程都算落笔」（老缺陷）。但注意：Z 的**反向**语义（==0 即落纸）本版
 *       也**不**采用 —— 没有实测证据表明本机驱动把 Z 归零，猜错就等于判据恒真。
 *       拿到 [ct] 日志的真实数据后再说。
 *
 * 坐标/语义来源：`layout_of()` 的 mask 推导（src=1，掩码+数据双证据）与盲扫
 * (offY, stride) 反推**同出一源**（wintab.h 的固定字段顺序），不再靠「猜剩几个字段」。
 */
static void ct_push(int off, int msk)
{
    if (off < 0 || g_ctN >= CT_MAX_SIG) return;
    for (int i = 0; i < g_ctN; i++) if (g_ctOff[i] == off) return;   /* 多掩码会给出同一偏移 */
    g_ctOff[g_ctN] = off; g_ctMsk[g_ctN] = msk; g_ctN++;
}

/* 建（或重建）信号表。offBtn/offNP/offTP < 0 ⇒ 该字段本布局推不出。
 * ⛔ 只在标定成功 / 布局变更时调用一次；调用即**复位全部证据**（换了布局，旧证据作废）。 */
static void contact_signals_build(int offX, int offY, int stride,
                                  int offBtn, int offNP, int offTP)
{
    for (int i = 0; i < CT_MAX_SIG; i++) {
        g_ctOff[i] = -1; g_ctMsk[i] = 0;
        InterlockedExchange(&g_ctZeroSeen[i], 0);
        InterlockedExchange(&g_ctNzSeen[i], 0);
        InterlockedExchange(&g_ctElig[i], 0);
    }
    g_ctN = 0;
    InterlockedExchange(&g_ctSeen, 0);
    InterlockedExchange(&g_ctMask, 0);
    InterlockedExchange(&g_ctVal, 0);
    InterlockedExchange(&g_ctZeroRun, 0);

    if (stride > 0) {
        /* ① 语义已知（掩码 + 数据双证据 ⇒ src=1）：三个字段直接取用。
              buttons 只取**低三位**（真按钮/笔尖状态）；高位是 cursor number，
              某些驱动会填成非 0 常量。 */
        if (offBtn >= 0 && offBtn + 4 <= stride) ct_push(offBtn, 0x07);
        if (offNP  >= 0 && offNP  + 4 <= stride) ct_push(offNP, 0);
        if (offTP  >= 0 && offTP  + 4 <= stride) ct_push(offTP, 0);
        /* ② 语义未知（盲扫定解）：补两个**顺序可推**的候选。
              · Buttons 在 wintab.h 的固定顺序里**恒在 X 之前 4 字节**；
              · Y 之后剩余的字节按固定顺序只能是 Z/NP/TP/ORI/ROT（Z/ORI/ROT 各 4/12/12）。
              ⛔ 取错也不会长期作恶：每个候选都要先通过「见过 0 又见过非 0」的资格审查，
                 pkCursor（恒 1）、Orientation/ROTATION（恒非 0）、pkZ（悬空非 0）
                 都会自动出局。 */
        if (offBtn < 0 && offX >= 4) ct_push(offX - 4, 0x07);
        if (offNP < 0 && offY >= 0) {
            int rest = stride - (offY + 4);        /* Y 之后还剩多少字节 */
            for (int m = 0; m < 32; m++) {
                int sz = 0, off = offY + 4, np = -1, tp = -1;
                if (m & 1)  { sz += 4;  off += 4; }             /* Z              */
                if (m & 2)  { np = off; sz += 4;  off += 4; }   /* NormalPressure */
                if (m & 4)  { tp = off; sz += 4;  off += 4; }   /* TiltPressure   */
                if (m & 8)  { sz += 12; off += 12; }            /* Orientation    */
                if (m & 16) { sz += 12; off += 12; }            /* Rotation       */
                if (sz != rest) continue;
                if (np >= 0) ct_push(np, 0);
                if (tp >= 0) ct_push(tp, 0);
            }
        }
    }
    InterlockedExchange(&g_contactMs, (LONG)GetTickCount());
    /* ⛔ 无信号 ⇒ 判据不可用。此时**放行**（与旧版一致）并把 g_ctUnknown 报给面板 ——
       不能默默把平滑关死：那会让功能「看起来坏了」且没有任何线索。 */
    InterlockedExchange(&g_ctUnknown, g_ctN > 0 ? 0 : 1);
    InterlockedExchange(&g_contact, g_ctN > 0 ? 0 : 1);
}

/* 逐包推进接触判据（detour 内调用，只做整数读与计数，零系统调用）。
 *
 * 每包：① 对每个信号刷新「见过 0 / 见过非 0」证据，两个状态都见过即取得投票权；
 *       ② 本包「落笔」= **有投票权的信号里有任意一个非零**。
 * 每批：任一包落笔 ⇒ 刷新保持计时（contact 立刻为 1）。 */
/* 信号表的「布局指纹」：stride/X/Y + 三个落笔字段偏移。
 * ⛔ 必须有：hCtx 缓存命中与重新标定走的是两条路径，唯一能让它们**行为一致**的办法
 *    是把「要不要重建信号表」交给同一份指纹判据（换设备必须重建，换句柄必须不重建）。*/
static int s_ctSigOK, s_ctSigStride, s_ctSigX, s_ctSigY, s_ctSigB, s_ctSigNP, s_ctSigTP;

static int ct_sig_needs_rebuild(int offX, int offY, int stride, int b, int np, int tp)
{
    if (!s_ctSigOK || g_ctN <= 0) return 1;
    return s_ctSigStride != stride || s_ctSigX != offX || s_ctSigY != offY
        || s_ctSigB != b || s_ctSigNP != np || s_ctSigTP != tp;
}

static void ct_sig_remember(int offX, int offY, int stride, int b, int np, int tp)
{
    s_ctSigOK = 1; s_ctSigStride = stride; s_ctSigX = offX; s_ctSigY = offY;
    s_ctSigB = b; s_ctSigNP = np; s_ctSigTP = tp;
}

static void contact_update(const u8* buf, int stride, int n)
{
    if (g_ctN <= 0) {
        InterlockedExchange(&g_ctUnknown, 1);
        InterlockedExchange(&g_contact, 1);            /* 判据不可用 ⇒ 放行 */
        return;
    }

    DWORD now = GetTickCount();
    int anyHit = 0;          /* 本批「有投票权的信号」里出现过非零 */
    int maskOut = 0;         /* 本批最后命中的信号位掩码 */
    LONG prim = 0;           /* 首选信号最后读到的值 */
    int k;

    for (k = 0; k < n; k++) {
        const u8* p = buf + (SIZE_T)k * stride;
        int pktHit = 0;      /* 本包是否命中（⛔ 必须逐包，不能用批级的 anyHit：一批里
                                前几个包命中会让后几个包的「连续全零」计数被错误清零） */
        for (int i = 0; i < g_ctN; i++) {
            u32 v; memcpy(&v, p + g_ctOff[i], 4);
            if (g_ctMsk[i]) v &= (u32)g_ctMsk[i];
            if (i == 0) prim = (LONG)v;
            if (v) {
                g_ctNzSeen[i] = 1;
                if (g_ctElig[i] == 1 || g_ctZeroSeen[i] == 1) g_ctElig[i] = 1;
            } else {
                g_ctZeroSeen[i] = 1;
                if (g_ctNzSeen[i] == 1) g_ctElig[i] = 1;
            }
            /* ⛔ 只有**取得投票权**的信号才允许把「落笔」投成 1。
               把资格的判定放在命中判定**之前**，是为了让「起笔的那一包」立刻生效：
               此时该信号刚拿到与 0 相对的那一半证据（悬空阶段已给过另一半），
               否则用户的每一笔都会丢掉第一个包（表现为「第一笔总是迟一帧」）。*/
            if (g_ctElig[i] == 1 && v) { pktHit = 1; maskOut |= (1 << i); }
        }
        if (pktHit) { anyHit = 1; g_ctZeroRun = 0; }
        else        InterlockedIncrement(&g_ctZeroRun);
    }
    InterlockedExchangeAdd(&g_ctSeen, (LONG)n);
    InterlockedExchange(&g_ctVal, prim);
    InterlockedExchange(&g_ctMask, (LONG)maskOut);

    int haveElig = 0;
    for (int i = 0; i < g_ctN; i++) if (g_ctElig[i] == 1) { haveElig = 1; break; }

    if (!haveElig) {
        /* 还没有任何信号取得投票权（开机/换布局后的最初几秒）。
           ⛔ 冷启动宽限内按**旧行为放行**，避免「一开就是死的」；宽限之后按**悬空**处理。
              两者都必须让 g_ctUnknown=1，面板据此说明「落笔判据尚未建立」。 */
        InterlockedExchange(&g_ctUnknown, 1);
        LONG seen = g_ctSeen;
        InterlockedExchange(&g_contact, (seen < CT_GRACE_PKT) ? 1 : 0);
        return;
    }
    InterlockedExchange(&g_ctUnknown, 0);
    if (anyHit) {
        InterlockedExchange(&g_contactMs, (LONG)now);
        InterlockedExchange(&g_contact, 1);
    } else if ((DWORD)(now - (DWORD)g_contactMs) > CONTACT_HOLD_MS) {
        InterlockedExchange(&g_contact, 0);
    }
}

/* ============================================== 工具闸门（面板 → 守护进程 → 本 DLL） */
/* 闸门值的**有效期**（ms）。面板侧有独立心跳持续刷新（见 LassoSmoothing），
 * 超过它还没刷新 ⇒ 面板已经不在正常工作（关掉/挂起/崩了）。
 * ⛔⛔ 2026-10-14 定案：过期一律**阻断**（fail-closed），0 与 1 同等对待。
 *    旧版「陈旧按未知放行」是本轮用户报的「任何工具落笔都出 HUD」的直接根因之一：
 *    心跳被 batchPlay 读挂起/忙碌闸门阻断超过 3s，陈旧的 1 就把所有工具全放行。
 *    面板关闭本就会撤钩（onclose ⇒ RequestUnhook），不存在「面板关了还要靠放行保命」
 *    的场景；真正的可用性由面板侧**与读数解耦的纯 WS 心跳**保证（读挂起不再拖垮心跳）。 */
#define GATE_STALE_MS 3000
/* 0 = 当前不是套索（禁止平滑）；1 = 是套索（**唯一放行值**）；
 * 2 = 未知（面板还没读到过）⇒ **阻断**，等首次成功读数（巡检 1s 一轮，最多盲 1 秒）。
 * ⛔ 2026-10-14：2 从「放行」改为「阻断」。旧语义下「读数长期失败 + 冻结的旧值」
 *    会把错误工具一直放行（用户报的问题 1）；而 ts==0（守护进程从未写过）时
 *    CFG_I_ENABLED 必为 0，钩子并未工作，放行与否无实际效果，保留放行仅为语义清晰。 */
static int tool_gate_ok(void)
{
    if (!g_cfg) return 1;
    DWORD ts = (DWORD)g_cfg[CFG_I_GATETS];
    if (ts == 0) return 1;   /* 守护进程从未写过（此刻 CFG_I_ENABLED 必为 0，钩子并未工作） */
    if ((DWORD)(GetTickCount() - ts) > GATE_STALE_MS) return 0;   /* ⛔ 过期 ⇒ 阻断 */
    return g_cfg[CFG_I_TOOLGATE] == 1 ? 1 : 0;
}

/** 闸门不成立时，把「为什么」拆成三种可读原因（P3.5）。
 *
 *  ⛔ 与 tool_gate_ok() 同源同判据，只是把布尔拆成原因——两处判据必须**逐条对应**，
 *     否则面板会显示与真实裁决相矛盾的原因（那比没有诊断更坏）。
 *  返回 RS_REWRITE(0) 表示「工具闸门本身没问题」（此刻被挡一定是别的闸门）。 */
static int tool_gate_reason(void)
{
    if (!g_cfg) return RS_REWRITE;
    DWORD ts = (DWORD)g_cfg[CFG_I_GATETS];
    if (ts == 0)                                          return RS_TOOL_UNKNOWN;
    if ((DWORD)(GetTickCount() - ts) > GATE_STALE_MS)      return RS_TOOL_STALE;
    int g = g_cfg[CFG_I_TOOLGATE];
    if (g == 1) return RS_REWRITE;
    return g == 0 ? RS_TOOL_NO : RS_TOOL_UNKNOWN;
}

/* 起笔闩锁：落笔瞬间的工具闸门裁决，**整笔持有**，笔起（接触消失）才释放。
 * ⛔⛔ 为什么必须有：闸门的心跳在面板侧，批次间可能短暂过期或翻转 —— 若每批都现判，
 *    一笔之中就会出现「这批判定放行、下一批阻断」的交替 ⇒ PS 收到一半原始坐标、
 *    一半平滑坐标（选区末端忽而跟光标、忽而钉在圆心），正是用户报的
 *    「平滑和 HUD 同时紊乱、圆心成了无根的点」的形态之一。
 *    值域：-1=未闩（悬空/被阻断），0/1=起笔时的裁决。 */
static volatile LONG g_strokeGate = -1;

/* ================================================================== 标定状态 */
typedef struct {
    HCTX  hCtx;          /* 0 = 未标定 */
    int   stride;        /* 每包字节数 */
    int   offSerial;
    int   offX, offY;
    /* 落笔判据用到的字段偏移（**只有 src=1「掩码+数据」双证据才认**；-1 = 不可用）——
       它们直接进入接触信号表（见 contact_signals_build / contact_update 的多信号并联）。 */
    int   offBtn, offZ, offNP, offTP;
    u32   axisMax;       /* 设备坐标上界（X 轴），用于位移门限与滞后上限 */
    u32   axisMaxY;      /* 设备坐标上界（Y 轴，lcInExtY）：Y 的标称轴→像素比分母 */
    int   valid;         /* 1 = 交叉验证通过，允许改写 */
    int   tried;         /* 1 = 已做过一次**证据充分**的裁决（n>=3），避免每包重算 */
    int   attempts;      /* 裁决次数上限用：连续失败若干次后才认命（state=2） */
} CALIB;

static CALIB g_calib;
/* —— per-hCtx 标定布局缓存（⛔⛔ 2026-10-14 新增，问题 3 的根因修复）——
 * 真机日志（jwwh-3376）实证：一场会话里 [calib] 块反复出现 ⇒ hCtx 频繁变更，
 * 旧版每次变更都 tried=0/valid=0 + g_wasEnabled=0 ⇒
 *   ① 重标定窗口里整批判定跳过 ⇒ PS 原样收到原始包（选区末端跟光标跑）；
 *   ② 之后 g_wasEnabled=0 ⇒ 锚定复位（圆心瞬移、折线直连）；
 *   ③ g_gateOk 残留 1 ⇒ HUD 还显示着旧几何 ⇒ 「平滑和 HUD 同时紊乱」。
 * 同一设备的布局（stride/偏移/量程）不会因 hCtx 不同而不同 ⇒ 按句柄缓存布局，
 * 命中即**零窗口**切换：不重标定、不清轨迹、不清接触判据。 */
#define CTX_CACHE_MAX 4
static struct {
    HCTX h;
    int  stride, offSerial, offX, offY;
    int  offBtn, offZ, offNP, offTP;
    u32  axisMax, axisMaxY;
} g_ctxCache[CTX_CACHE_MAX];
static int g_ctxCacheN;
static int g_ctxCacheRound;
/* 最近一次 hCtx 变更的 old→new（worker 在 [status] 行代打；detour 内禁止 I/O）。
   ⛔ HCTX 是指针宽度 ⇒ 用 LONG_PTR 存，别截成 32 位。 */
static volatile LONG_PTR g_ctxLastFrom, g_ctxLastTo;

static int ctx_cache_find(HCTX h, CALIB* out)
{
    for (int i = 0; i < g_ctxCacheN; i++) {
        if (g_ctxCache[i].h != h) continue;
        memset(out, 0, sizeof(*out));
        out->hCtx = g_ctxCache[i].h;
        out->stride = g_ctxCache[i].stride; out->offSerial = g_ctxCache[i].offSerial;
        out->offX = g_ctxCache[i].offX;     out->offY = g_ctxCache[i].offY;
        out->offBtn = g_ctxCache[i].offBtn; out->offZ = g_ctxCache[i].offZ;
        out->offNP = g_ctxCache[i].offNP;   out->offTP = g_ctxCache[i].offTP;
        out->axisMax = g_ctxCache[i].axisMax; out->axisMaxY = g_ctxCache[i].axisMaxY;
        out->valid = 1;                      /* 能进缓存的只有验证过的布局 */
        out->tried = 1;
        return 1;
    }
    return 0;
}

static void ctx_cache_put(HCTX h, const CALIB* c)
{
    for (int i = 0; i < g_ctxCacheN; i++)
        if (g_ctxCache[i].h == h) return;              /* 已在缓存 */
    int slot;
    if (g_ctxCacheN < CTX_CACHE_MAX) slot = g_ctxCacheN++;
    else slot = g_ctxCacheRound++ % CTX_CACHE_MAX;     /* 环形覆盖最旧 */
    g_ctxCache[slot].h = h;
    g_ctxCache[slot].stride = c->stride; g_ctxCache[slot].offSerial = c->offSerial;
    g_ctxCache[slot].offX = c->offX;     g_ctxCache[slot].offY = c->offY;
    g_ctxCache[slot].offBtn = c->offBtn; g_ctxCache[slot].offZ = c->offZ;
    g_ctxCache[slot].offNP = c->offNP;   g_ctxCache[slot].offTP = c->offTP;
    g_ctxCache[slot].axisMax = c->axisMax; g_ctxCache[slot].axisMaxY = c->axisMaxY;
}
static volatile LONG g_state = 0;          /* CFG_I_STATE 的镜像（供 worker 上报） */
static volatile LONG g_calls, g_packets, g_smoothed;
/* 本 DLL 自身的模块句柄（DllMain 传入）。⛔ HUD 注册窗口类必须用它 ——
   GetModuleHandleW(NULL) 拿到的是宿主 exe（PS.exe）的句柄，类会注册到错误的
   模块作用域，二次注入/跨实例时行为不确定。 */
static HINSTANCE g_hInst;

/* dump 区：标定失败时把原始字节留给 worker 落盘（detour 内绝不写文件）。 */
static u8  g_dump[512];
static int g_dumpLen;
static volatile LONG g_dumpWanted;
static volatile LONG g_calibTriedTotal;
static volatile LONG g_hCtxChanges;

/* 标定日志缓冲：`try_calibrate` 是在 **detour 内**跑的（PS 取包线程），
   ⛔ 那里一个字都不能落盘 —— `logf` 会 WriteFile + FlushFileBuffers（全盘刷），
   还会自旋抢日志锁。所以标定期间只往这里**拼字符串**（纯内存），由 worker 线程补写。 */
static char             g_calibText[2048];
static int              g_calibTextLen;
static volatile LONG    g_calibTextReady;

static void calib_logf(const char* fmt, ...)
{
    if (g_calibTextLen >= (int)sizeof(g_calibText)) return;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(g_calibText + g_calibTextLen,
                      (int)sizeof(g_calibText) - g_calibTextLen, fmt, ap);
    va_end(ap);
    if (n > 0) g_calibTextLen += n;
    /* ⚠️ 此处**不**置 ready：`try_calibrate` 是多条 calib_logf 拼起来的，
       ready 若在中途就抬起来，worker 可能只捞到半截、且后半截再触发一次重复落盘。
       统一由 try_calibrate 结尾抬一次（见 calib_publish）。 */
}

static void calib_publish(void)
{
    InterlockedExchange(&g_calibTextReady, 1);
}

/* ======================================================== 平滑状态（单条轨迹） */
/* 与守护进程 LassoMouseSmoother 同源同参；此处为 C 版，三种模式全部实现。
   - 不做 MinSampleDist 抽稀：Wintab 的包必须**原样写回**（抽掉会打乱 PS 的时间轴）。
   - ⚠️ P3.1 起 k 改按**时间常数**定义（k = dt/(dt+τ)），而不是「每帧跟随系数」。
     旧实现用 1−0.85·t/100 的线性映射，在 205Hz 的笔通路上等效滞后只有 ~0.9px
     （亚像素，实测「感知不明显」的根因之一）；τ 的曲线则与鼠标通路
     k=0.18^(t/100)@125Hz 的滞后严格等价，同一条滑杆在两条通路上手感一致。 */
static double g_ox, g_oy;        /* 输出位置（保留小数，避免慢速时「粘住不动」） */
static double g_speed;           /* 低通后的输入速度（屏幕等效像素/ms） */
static double g_dirX, g_dirY;
static int    g_hasDir;
static DWORD  g_lastMs;
static int    g_wasEnabled;

/* 轴坐标 → 屏幕像素的比例。**逐轴**且**带符号**：
   ⛔⛔ 2026-10-13 真机定案 —— 数位板到屏幕的映射是**逐轴**的，而且 Y 轴的符号与屏幕
   相反（Wintab 包 Y 向上为正、屏幕 Y 向下为正），两个轴的**比例也不同**
   （本机实测 3440/44800 = 0.0768 对 1440/29600 = 0.0486，相差 1.58 倍）。
   旧版用一个标量同时当两个轴用 ⇒ HUD 的圆心偏移在 Y 上**既镜像、又比例错**，
   真机表现正是「向右上运笔、圆心却往左上方跑，圆心也不在轨迹末端」。
   ⛔ 初值必须是 0（=「未标定」）：detour 见 0 会按「屏宽(高)/轴上界」的标称值兜底。
   旧初值 1.0（「包坐标就是像素」）比真值大 13 倍，在标定跑起来之前那几批包里，
   绳长/半径全部按错的单位换算。
   由 HUD 渲染线程拿**真实光标位移**逐轴持续标定后覆盖（见 hud 段）。 */
static double g_pxAxisX = 0.0;
static double g_pxAxisY = 0.0;
/** 轴→像素比的来源：0=屏幕标称 · 1=驱动 lcOutExt（权威，不再被光标测量覆盖）
    · 2=光标测量（仅在 0/1 都不可用时才启用）。排障打日志用，也是决策依据。 */
static volatile LONG g_pxSrc;
/** 是否已被光标标定过（标定后不再被标称初值覆盖）。 */
static volatile LONG g_pxCalibrated;
/** 主屏/虚拟屏宽度、高度（px）：标称「轴→像素比」的分母来源，worker 启动时取一次。
    ⛔ 进程是 PER_MONITOR_AWARE（真机实测 GetProcessDpiAwareness=2）⇒ 这是**物理**像素。 */
static int g_screenW;
static int g_screenH;

/* ================================================ DPI 缩放（分辨率适配的唯一权威）
 * ⛔⛔ 2026-10-15 定案（用户「多台不同分辨率的测试电脑，套索平滑需要适配不同分辨率」）：
 *   PS 是 PER_MONITOR_AWARE ⇒ 进程内的一切（SM_CXVIRTUALSCREEN、GetCursorPos、
 *   驱动 lcOutExt）都是**物理像素**。而面板滑杆 / 用户的心智单位是**逻辑像素**。
 *   真机：主屏 3840×2160 @150% ⇒ 虚拟屏 6000×3840 物理、驱动 lcOutExt 同样 6000×3840
 *   —— 坐标口径**没有错**，错的是**尺度**：半径 100 物理 px 在 150% 下只有 66.7 逻辑 px，
 *   200% 下只剩 50 ⇒ 同一滑杆在不同机器上观感完全不同，平滑强度、追笔速度、
 *   甩笔阈值、HUD 尺寸、断流看门狗的位移门限全部跟着变。
 * ⇒ 统一引入「DPI 缩放」= 物理像素 / 逻辑像素，所有**面向用户**的像素量乘以它，
 *   所有**面向屏幕**的量（HUD 窗口、轴→像素换算）保持物理域。
 *
 * ⛔ 用**整数毫倍**（1500 = 1.5×）做唯一真值：detour 是 205Hz 热路径，
 *   读 LONG 是原子的，读 double 不是。换算只在非热路径做一次。 */
static volatile LONG g_dpiScaleMilli = 1000;   /* 1000 = 1.0×（96 DPI） */
static double dpi_scale(void)
{
    LONG m = g_dpiScaleMilli;
    if (m < 250) m = 250; else if (m > 8000) m = 8000;
    return (double)m / 1000.0;
}

/* ⛔ shcore.dll 只**动态**取（不进导入表）：本模块刻意保持最小依赖集，
   Win7/未带 shcore 的环境取不到就退回 1.0×（= 旧行为，不会更差）。 */
typedef LONG (*PFN_GetDpiForMonitor)(HMONITOR, int, UINT*, UINT*);
static LONG g_dpiProbeTried;
static PFN_GetDpiForMonitor g_pGetDpiForMonitor;

/** 以**光标所在显示器**为准更新缩放（笔就在那儿；多屏不同缩放时这才是正确的那个）。
    ⛔ 只能在 worker / HUD 线程调用（有系统调用）。 */
static void dpi_update_scale(void)
{
    if (!g_dpiProbeTried) {
        g_dpiProbeTried = 1;
        HMODULE hs = LoadLibraryA("shcore.dll");
        if (hs) g_pGetDpiForMonitor =
            (PFN_GetDpiForMonitor)(void*)GetProcAddress(hs, "GetDpiForMonitor");
    }
    if (!g_pGetDpiForMonitor) return;
    POINT pt;
    if (!GetCursorPos(&pt)) return;
    HMONITOR hm = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
    if (!hm) return;
    UINT dx = 96, dy = 96;
    if (g_pGetDpiForMonitor(hm, 0 /*MDT_EFFECTIVE_DPI*/, &dx, &dy) != 0) return;
    if (dx < 96) dx = 96; else if (dx > 768) dx = 768;
    LONG milli = (LONG)((double)dx * 1000.0 / 96.0 + 0.5);
    if (milli != g_dpiScaleMilli) InterlockedExchange(&g_dpiScaleMilli, milli);
}

/* 驱动**输出量程**指纹（lcOutExtX/Y）：用户在驱动面板里改「映射到单个屏幕 / 强制比例」
   时屏幕尺寸不变、只有它变 ⇒ 必须一并进重标定判据（2026-10-15）。 */
static volatile LONG g_drvOutX, g_drvOutY;
/* 上一次的「环境指纹」（屏幕尺寸 / DPI 缩放 / 驱动映射），worker 每 250ms 比对一次。 */
static LONG g_fprScale;
static LONG g_fprOutX, g_fprOutY;

/** 逐轴标定器：符号要「连续多次一致」才敢采用，量值用 EMA 收敛。
    ⛔ 为什么不能只用 EMA：符号一旦被一个坏样本锁反，EMA 要穿越 0 才能纠正回来，
       期间 HUD 的圆心一直镜像 —— 用户看到的就是「时好时坏的镜像」。 */
typedef struct {
    double px;          /* 当前采用值（含符号；0 = 未标定） */
    double num;         /* Σ|Δ光标|（指数衰减窗口）—— 「比值」估计的分子 */
    double den;         /* Σ|Δ原始轴|（同一窗口）—— 分母 */
    long   n;           /* 已累积样本数（< PX_TRUST_N 时 done=0，仍用标称兜底） */
    int    done;        /* 是否已被**真实光标**标定过（1）；0 = 仍用标称兜底 */
    int    voteSign;    /* 最近一次投票的符号 */
    int    voteStreak;  /* 连续同号的次数 */
    int    signLocked;  /* ⛔ 符号已锁定（2026-10-14 第八轮真机）：轴方向（屏 Y 向下 vs
                           板 Y 向上）是**设备+驱动的物理常量**，会话内不可能合法翻转。
                           真机实锤：18:00:04 符号投票被 4 个连续坏样本翻转（pxY 瞬间
                           +0.0486）⇒ HUD 垂直镜像 ⇒ 用户报「HUD 显示错误、距离很远」。
                           坏样本来源 = 断流期/鼠标并行移动时光标 Δ 与笔 Δ 失去关联。
                           锁定后错票一律当噪声；仅屏幕尺寸变化重标定时才解锁
                           （旋转屏才可能改变方向约定，届时随重标定重投）。 */
    int    lockSign;    /* 锁定的符号（+1/-1） */
} AXCAL;
static AXCAL g_axCalX, g_axCalY;

/* 复位（起笔锚定）原因计数：排障用。
   真机现象「圆圈会突然闪现回光标位置、断开的折线瞬间连到光标」= 一次复位，
   而复位有 3 种来源，必须能分辨（否则只能靠猜）。 */
#define RST_ANCHOR 1     /* 首包 / 闸门重开（正常的起笔锚定） */
#define RST_GAP    2     /* 取包间隔超时（**停笔期间的假复位**，见 TIME_GAP_RESET_MS） */
#define RST_JUMP   3     /* 位置跳变（抬笔移位 / 换屏） */
static volatile LONG g_rstAnchor, g_rstGap, g_rstJump;
static volatile LONG g_lastGapMs;    /* 最近一次复位时的取包间隔（ms，排障用） */

#define JUMP_RESET_FRAC   0.15   /* 输出点与原始点距离 > 15%·axMax ⇒ 判定为抬笔移位 */
/* ⛔⛔ 2026-10-13：120ms → **5000ms**（≈关闭）。
   真机定案：数位板在**笔不动时不再出包**（jwwh 日志实证：停笔后 packets 长时间冻结、
   而 PS 仍在空轮询 WTPacketsGet ~660 次/秒）。于是「用户停下来看一眼屏幕再继续」
   这种正常停顿，取包间隔必然超过 120ms ⇒ 一恢复就被判成「新的一笔」⇒ 输出点被拽回
   笔尖 ⇒ 后果与用户报的现象**逐条吻合**：
     · 圆圈的圆心（= PS 真正落笔的位置）瞬间跳到光标上；
     · **断开的选区折线瞬间连到光标**（PS 的套索是一条折线，从冻结点 P 直连到笔尖）。
   ⛔ 「抬笔」本来就有**独立且可靠**的判据（闸门 ②：笔尖接触画布 = 压力/按键字段），
      不需要靠时间间隔；位置突变也有 jumpPx 兜底。这里只留一个「状态明显失效」的
      兜底值（DLL 被挂起数分钟之类的极端情况）。
   ⛔ 绝不要再改小：用户的「停笔观察」是正常操作，改小就等于「一停笔就复位」。 */
#define TIME_GAP_RESET_MS 5000
#define SPEED_FULL        3.0    /* 屏幕等效像素/ms：达到即「甩笔」（人手常规 ≤1.5，见下） */
#define CORNER_MIN_PX     3.0    /* 段长小于它的「拐角」一律当抖动，不削弱平滑 */
/* τ(强度) 曲线的两个常数：τ = 8ms·(e^(TAU_LN·t/100) − 1)。
   ⛔ 2026-10-13 第二轮上调：τ(100) 由 100ms 提到 **250ms**（TAU_LN = ln(32.25)）。
      用户反馈「标准模式强度拉满依然感觉太弱」—— 一阶低通的稳态滞后 = v·τ，
      100ms 在 500px/s 下只有 50px，而半径默认仅 12px 时还会被整体夹掉。
      现在 250ms ⇒ 同速度下 ≈125px 的势能（上限仍由半径决定），
      强度滑杆两端的差别一眼可辨。 */
#define TAU_BASE_MS       8.0
#define TAU_LN            3.473500    /* ln(32.25) ⇒ τ(100) = 8·(32.25−1) = 250ms */
/* 半径 / 绳长上限（屏幕像素）。
   ⚠️ 40 → 100 是用户 2026-10-13 明确要求：他把 PS 自己的平滑只开到 36，
      圆环半径就已接近本 HUD 原上限的两倍，且「体感的平滑效果非常弱」。
      旧上限 40px 在 205Hz 下把 τ 追平后的滞后硬生生截断 ⇒ 强度滑杆怎么拉都不明显。 */
#define RADIUS_PX_MAX     100

/* ==================================================== 绳长（拉绳 HUD 与滤波同源）
 * ⛔ 圆周半径**必须等于真实绳长**，否则 HUD 画的圈与实际的约束不是一回事：
 *    用户会看到「光标明明还在圈里却被拽住」或「早出圈了却还自由」，拉绳感直接失真。
 *
 * ⛔ 2026-10-13：「张力」参数**已删除**。用户实测它和「半径」是同一件事的两套旋钮
 *    （张力只在 15%~100% 之间缩放半径）⇒ 两个滑杆都在改圆周，机制重复且互相打架。
 *    现在绳长恒等于半径：半径 = 最大滞后 = 圆周半径，一个参数一个语义。 */
static double leash_px(int radiusPx)
{
    if (radiusPx < 1) radiusPx = 1;
    return (double)radiusPx;
}

/* ================================================== 逐轴「轴→像素」（含符号）
 * 量值（比例）：硬事实 —— 两轴量程不同，必须逐轴。
 *   真机 [calib] 日志：`lcInExtX=44800 lcInExtY=29600`（1.58 倍），
 *   屏幕 SM_CXVIRTUALSCREEN=3440 ⇒ X 标称 3440/44800 = 0.0768，Y 标称 1440/29600 = 0.0486。
 *   ⛔ 旧版用一个不带符号的合成标量，把两轴的**比例**混在一起 ⇒ 偏移的模长与方向都偏。
 *
 * 符号：**兜底不做任何假设**，只给「同向」（与 X 同号）这个中性默认；真实符号由
 *   calib_axis() 用**真实光标位移**逐轴测出（s = Δ光标/Δ原始轴，天然带符号）。
 *   ⛔ 绝不在兜底里硬编码「Y 取负 / Y 取正」：
 *     · Wintab 的 Y 方向依驱动与 LOGCONTEXT 的 lcOut* 映射而定，规范并未规定死；
 *     · 我上一轮写死的「Y 取负」源自一张**示意图**（用户后来澄清前两张图只是示意、
 *       非真实截图），该依据不成立 ⇒ 已撤回。
 *   ⇒ 兜底只保证「量级合理、符号中性」，方向一律以标定结果为准。
 *   ⛔ 未标定期极短（AX_SAMPLE_MIN≈3px 位移 + CUR_SAMPLE_MIN=3px + SIGN_VOTE=4 个样本），
 *      用户一开始运笔就会覆盖；日志 `calX=/calY=` 可一眼区分「是测出来的还是兜底的」。 */
/* —— 标定/采信参数（⛔ 必须定义在 px_x/px_y 之前：px_x 的符号投票判据引用 SIGN_VOTE） */
#define AX_SAMPLE_MIN  120.0   /* 本轴原始位移下限（≈7 屏幕像素） */
#define CUR_SAMPLE_MIN 5.0     /* 光标位移下限（像素）。⛔ 别抬到 10px：位移门限越高，
                                  样本越稀疏、收敛越慢，而噪声已由加和估计吸收 */
#define SIGN_VOTE      4       /* 符号连续一致多少次才采信 */
#define PX_WIN         256.0   /* 比值估计的等效样本窗口（指数衰减） */
#define PX_TRUST_N     24      /* 样本数达到它才算「标定完成」，之前一律用标称兜底 */

/* ⛔⛔ 标定器量值采信门（2026-10-14 第六轮真机定案）：光标测量**系统性偏低** ——
   本次会话 [status] 实测 pxX=0.0521，而驱动(÷16)/标称一致给出 0.0768，低 32%；
   历史真机区间 0.0466~0.0676 同证。它只在 ±12% 带内才许接管量值；
   带外时**保留它的符号**（符号投票仍是唯一实测过的方向权威）、量值退回兜底。
   纯浮点比较，detour 内可用（零系统调用铁律不破）。 */
static double cal_gate(const AXCAL* a, double fb)
{
    if (!a->done) return fb;
    double ac = a->px < 0 ? -a->px : a->px;
    double af = fb < 0 ? -fb : fb;
    if (!(af > 1e-9)) return a->px;
    if (ac > af * 0.88 && ac < af * 1.12) return a->px;
    return (a->px < 0 ? -af : af);
}

static double px_x(void)
{
    if (g_pxSrc == 1) {
        double v = g_pxAxisX;
        /* ⛔ 量值信驱动、**符号信实测投票**（2026-10-14 第六轮真机定案）：
           本机驱动 lcOutExtY 报正值，而屏幕 Y 向下（Wintab 包 Y 向上为正）
           ⇒ 驱动的 Y 符号不可信；光标标定的符号投票（Δ光标/Δraw 同号性）
           是唯一实测过的方向权威。X 同理走同一规则保持对称。 */
        if (g_axCalX.voteStreak >= SIGN_VOTE && g_axCalX.voteSign != 0)
            v = (g_axCalX.voteSign > 0 ? 1 : -1) * (v < 0 ? -v : v);
        return v;
    }
    double fb = (g_pxAxisX > 0.0001 || g_pxAxisX < -0.0001)
              ? g_pxAxisX
              : (double)(g_screenW > 0 ? g_screenW : 1920)
                / (double)(g_calib.axisMax > 0 ? g_calib.axisMax : 32767);
    return cal_gate(&g_axCalX, fb);
}

static double px_y(void)
{
    if (g_pxSrc == 1) {
        double v = g_pxAxisY;
        if (g_axCalY.voteStreak >= SIGN_VOTE && g_axCalY.voteSign != 0)
            v = (g_axCalY.voteSign > 0 ? 1 : -1) * (v < 0 ? -v : v);
        return v;
    }
    double fb = (g_pxAxisY > 0.0001 || g_pxAxisY < -0.0001)
              ? g_pxAxisY
              : (double)(g_screenH > 0 ? g_screenH : 1080)
                / (double)(g_calib.axisMaxY > 0 ? g_calib.axisMaxY : 32767);
    return cal_gate(&g_axCalY, fb);
}

/* 单轴带符号标定：s = Δ光标 / Δ原始轴（只在本轴位移够大时取样）。
   ⛔ 必须**逐轴**取 —— 旧版用合成矢量的 |Δ| 比，把两个轴的符号与比例混在一起：
      既拿不到 Y 自己的符号（方向对不对全凭猜），也算不出两轴不同的比例
      （真机 lcInExtX=44800 / lcInExtY=29600，差 1.58 倍）。
   ⛔ 符号的唯一权威来源就是这里（Δ光标/Δraw 自然带号），兜底一律中性（见 px_x/px_y）。
   ⛔ 符号要连续 SIGN_VOTE 次一致才采用：一次坏样本（复位跳变/批次时间戳抖动）就把
      符号锁反的话，EMA 得穿越 0 才纠正得回来，期间 HUD 一直镜像。 */
/* ⛔⛔ 2026-10-14 第三轮定案（用户报「拉绳模式的受力点（选区末端）与圆心分离，必须避免」）：
   [status] 实测标定值在两个轴上都**剧烈抖动**（本次真机 79 分钟会话里 pxX 在
   0.0536~0.0689、pxY 在 −0.0310~−0.0739 之间跳；同一台机器同一套显示器，真值只可能是
   一个常数）。而 HUD 的圆心偏移 = 滞后×px ⇒ px 偏 25% 圆心就离选区末端 25% 的绳长
   （100px 绳 ≈ 25px，肉眼一眼可见 = 用户截图里那条「分离」）。
   旧实现的三道闸（CUR_SAMPLE_MIN=10px / EMA 权重 0.05~0.30 / 离群 ±20% 丢弃）
   治的是「单样本噪声」，但**病根是估计器的形状**：把「比值的 EMA」当估计量，
   等效窗口只有 3~20 个样本，比值本身的逐样本方差不被平均掉。
   ⇒ 改为**位移加和**估计（Σ|Δ光标| / Σ|Δ原始轴|，指数衰减窗口 ≈ PX_WIN 个样本）：
     · 噪声按 √N 收敛（256 样本 ⇒ 量级 ±1%），且**天然按位移加权** ——
       慢速/抖动样本位移小、贡献小，不会被「比值的均值」拉偏；
     · 即便驱动把系统光标跟着**输出**走（旧分母争议），绳被拉住的样本 Δ输出≈0
       ⇒ 对分子贡献≈0，估计值仍收敛到真实映射（旧实现会被拽向 0）；
     · 不再需要「离群丢弃 + 整值作废」这套会把值清零重建的机制（那本身就是抖动源）。
   符号仍走投票：Δ光标/Δ原始轴 天然带号，是方向的**唯一权威来源**。 */
static void calib_axis(AXCAL* a, double dAx, double dCur)
{
    double aax  = dAx  < 0 ? -dAx  : dAx;
    double acur = dCur < 0 ? -dCur : dCur;
    /* ⛔ 门限是**逻辑像素**：150% 屏上 1 逻辑 px = 1.5 物理 px，不归一的话
       高分屏会在更小的真实位移上取样 ⇒ 量化噪声占比反而变高（2026-10-15）。 */
    if (acur < CUR_SAMPLE_MIN * dpi_scale()) return;   /* 光标位移太小 ⇒ 整数像素量化主导 */
    if (aax  < AX_SAMPLE_MIN)  return;      /* 本轴原始位移太小 ⇒ 比值不可信 */
    int s = ((dCur > 0) == (dAx > 0)) ? 1 : -1;
    /* ⛔ 符号锁定（见 AXCAL.signLocked 注释）：锁定后本函数的「投票」只剩记录作用，
       错票既不清空累积器也不翻转 px —— 量值继续由驱动权威（px_x/px_y 的 g_pxSrc=1）
       供给时，这里的 px 只在兜底路径被消费。 */
    if (a->signLocked) {
        s = a->lockSign;
        a->voteSign = s;
        a->voteStreak = SIGN_VOTE;
    } else {
        if (a->voteSign == s) { if (a->voteStreak < 1000000) a->voteStreak++; }
        else { a->voteSign = s; a->voteStreak = 1; }
        if (a->voteStreak < SIGN_VOTE) return;  /* 符号还没稳定 ⇒ 不采信（避免锁反后镜像） */
        a->signLocked = 1;                      /* 首次达成 ⇒ 锁定（物理常量，见结构体注释） */
        a->lockSign = s;
    }
    if (a->px == 0.0 || ((a->px > 0) ? 1 : -1) != s || a->den <= 0.0) {
        /* 首次 / 符号翻转 ⇒ 累积器清空重来（旧实现的 EMA 穿越 0 会让 HUD 镜像一段时间） */
        a->num = acur; a->den = aax; a->n = 1;
        a->px  = (double)s * (acur / aax);
        a->done = 0;
        return;
    }
    double keep = 1.0 - 1.0 / PX_WIN;
    a->num = a->num * keep + acur;
    a->den = a->den * keep + aax;
    if (a->den > 1e-9) a->px = (double)s * (a->num / a->den);
    if (a->n < 1000000) a->n++;
    if (a->n >= PX_TRUST_N) {
        a->done = 1;
        InterlockedExchange(&g_pxCalibrated, 1);
    }
    /* 诊断：样本数上传（本函数只在 HUD 渲染线程里跑，不受 detour 的零系统调用约束） */
    if (g_cfg) g_cfg[(a == &g_axCalY) ? CFG_I_PXNY : CFG_I_PXNX] = (LONG)a->n;
}

static double dsqrt_(double v) { return __builtin_sqrt(v); }

/* e^x（x∈[0,2]）Maclaurin 12 项：相对误差 < 3e-8。
   ⛔ 刻意不引 libm 的 exp/pow —— 那会多拉一个 api-ms-win-crt-math 依赖。 */
static double exp_series(double x)
{
    double term = 1.0, sum = 1.0;
    for (int i = 1; i <= 12; i++) { term *= x / (double)i; sum += term; }
    return sum;
}

/* cos(deg)（deg∈[0,90]）Maclaurin 到 x^8：45° 处误差 5e-6，90° 处 2.6e-4
   （折成角度 < 0.02°，对「夹角是否超过阈值」毫无影响）。同样不引 libm。 */
static double cos_deg_series(int deg)
{
    double x = (double)deg * 0.017453292519943295;   /* π/180 */
    double x2 = x * x;
    return 1.0 + x2 * (-0.5 + x2 * (0.041666666666666664
                   + x2 * (-0.001388888888888889 + x2 * 0.000024801587301587)));
}

/* 强度 → 时间常数（ms）：τ = TAU_BASE·(e^(TAU_LN·t/100) − 1)。
   ⛔ 2026-10-13：上限由 36ms 抬到 100ms，同日再抬到 **250ms**。
      真机反馈「强度 100 的体感依然几乎为零」—— 一阶低通的稳态滞后就是 v·τ：
      36ms 在 500px/s 下只有 18px，100ms 也只有 50px，再被半径上限一夹就看不出来了。
      现在 250ms ⇒ 同速度下 ≈125px 的势能，强度滑杆两端的差别一眼可辨。 */
static double tau_from_strength(double t)
{
    if (t <= 0.0) return 0.0;
    if (t > 100.0) t = 100.0;
    return TAU_BASE_MS * (exp_series(TAU_LN * (t / 100.0)) - 1.0);
}

/* ---------------- HUD 快照（detour 只写这几个普通内存字段）----------------
 * ⛔ detour 铁律依旧：这里全部是普通内存写，**没有任何系统调用**。
 *    渲染线程另起（见文件末 hud 段），205Hz 的取包路径不被拖累。 */
static volatile LONG g_snRawX, g_snRawY;   /* 改写前的原始轴坐标 */
static volatile LONG g_snOutX, g_snOutY;   /* 改写后的平滑轴坐标 */
static volatile LONG g_snMs;               /* 最后一次取包的 GetTickCount() */
/* 「前一个包」的坐标与时刻：渲染线程用它估速度，把 raw **与 out** 都外推到当前帧
 * 时刻 —— 消除「包时刻 vs GetCursorPos 时刻」的相位差（受力点漂移的根因之一）。
 * ⛔⛔ 2026-10-14 第五轮：out 也必须外推。旧版只外推 raw：
 *    圆心 = 光标 − (raw_now_extrapolated − out_packet_time)·px ⇒ 圆心落在
 *    **out 的包时刻位置**，而真实绘制点已经又走了一个 v·Δt ——
 *    真机实测差了 15px（100px 绳）。两端同刻才是几何恒等的前提。 */
static volatile LONG g_snPrevRawX, g_snPrevRawY;
static volatile LONG g_snPrevOutX, g_snPrevOutY;
static volatile LONG g_snPrevMs;

/** 统一发布快照（三处写点共用；先把旧值滚到 prev，再写新值）。 */
static void sn_publish(LONG rX, LONG rY, LONG oX, LONG oY, LONG ms)
{
    g_snPrevRawX = g_snRawX; g_snPrevRawY = g_snRawY;
    g_snPrevOutX = g_snOutX; g_snPrevOutY = g_snOutY;
    g_snPrevMs = g_snMs;
    g_snRawX = rX; g_snRawY = rY;
    g_snOutX = oX; g_snOutY = oY;
    g_snMs   = ms;
    if (g_cfg) g_cfg[CFG_I_SNTS] = ms;   /* 面板「平滑中断」检测的数据源（见槽位注释） */
}

/* ---- P3.2 触发闸门：只在「工具是套索」且「笔尖接触画布」时才平滑 ----
 * ⛔ 用户的原话：「无论我选择什么工具，无论我是否按下处于绘制状态，只要我用数位笔
 *    移动光标，已平滑的数字就在涨，拉绳工具的洋红圈也都会显示」——
 *    那等于把**悬空移动**也当成绘制轨迹，于是每一次移位都有迟滞、每一个工具都有 HUD。
 *    因此闸门必须同时满足两个条件，缺一不可：
 *      ① 工具闸门（面板 300ms 巡检当前工具 ⇒ 共享内存 CFG_I_TOOLGATE）；
 *      ② 笔尖接触（由**包内字段的运行时观测**判定，见下方 contact 段）。
 * ⚠️ 悬空时我们**一个字节都不改**（提前 return 0），PS 拿到的就是原始坐标，
 *    所以「落笔前没有迟滞」是结构性的，不是靠调参数绕出来的。 */
static volatile LONG g_toolOk;      /* 工具闸门是否成立（0/1） */
static volatile LONG g_penDown;     /* 笔尖是否接触画布（0/1） */
static volatile LONG g_gateOk;      /* 两者都成立 ⇒ 本批真的在平滑 */

/* ---- P3.5 诊断三件套（槽位见 CFG_I_REASON/GATEOPEN/GATECLOSE 段）----------
 * ⛔ 它们**由裁决的同一处写入**，绝不留给面板猜。原因见上面的槽位注释：
 *    面板只看到 toolGate/penDown/gateOk 三个布尔，而本文件在闸门不成立时
 *    **会主动把 penDown 写成 0** ⇒ 「心跳过期」与「笔尖真的悬空」在面板上
 *    长得一模一样，于是诊断永远吐「等笔尖落纸」，用户落着笔看这句只会更迷惑
 *    （真机复现：用户明确反馈「我早就已经落了」）。 */
static volatile LONG g_reason;      /* RS_* 原因码（0 = 正在改写） */
static volatile LONG g_gateOpen;    /* 闸门 0→1 累计次数（= 起笔次数，**累计值**） */
static volatile LONG g_gateClose;   /* 闸门 1→0 累计次数（**累计值**）。
                                       ⛔ 面板判「抖动」用的是**两次回报之间的增量**，
                                          不是这两个总数的差额（累计值画一百笔后就都相等了）。
                                          增量在一秒内涨了好几次 = 闸门一笔之中反复开合
                                          （选区一段段停住的根因）。 */

/** 闸门状态迁移（**唯一入口**）。
 *
 *  ⛔ 必须走迁移判定，不能各处直接 InterlockedExchange(g_gateOk)：
 *     开合次数只有「真的发生过跳变」才有意义，直接赋值会把
 *     「一批里连写 3 次 0」记成 3 次收笔 ⇒ 面板判抖动全是假警报。 */
static void gate_set(int on)
{
    LONG prev = InterlockedExchange(&g_gateOk, on ? 1 : 0);
    if (on && prev != 1)        InterlockedIncrement(&g_gateOpen);
    else if (!on && prev == 1)  InterlockedIncrement(&g_gateClose);
}

/* HUD 渲染线程（定义在文件末，worker 与 jwwh_unhook 都要调） */
static void hud_start(void);
static void hud_stop(void);

/* ------------------------------------------------------------- 掩码 → 偏移 */
/* 按 wintab.h 的固定字段顺序累加尺寸。pkContext 在 x64 上是 8 字节指针，
   但某些实现把它当 4 字节 —— 两种都算，靠序号扫描的观测值来裁决。
   ⛔⛔ PK_ORIENTATION / PK_ROTATION 是 **12 字节**（各 3 个 int：方位/仰角/扭转、
   俯仰/翻滚/偏航），不是 4 字节。此前一律按 4 算 ⇒ 掩码里带它们的上下文算出的
   stride 一定偏小 ⇒ 与盲扫结果必然不一致 ⇒ 标定 100% 失败（真机 jwwh-*.log 实证：
   stride 真实值 52，按 4 算只有 40）。 */
/* 掩码 → 各字段偏移（一次算全，不再只挑 X/Y）。
   ⛔⛔ 落笔判据（pkButtons / pkNormalPressure / pkTangentPressure）也要靠这里的偏移：
      它们与 X/Y 出自**同一个确定性推导**（字段顺序由规范定死），所以**不需要**像旧版
      那样靠「猜 X 之后还剩几个字段」去枚举。参见 CFG_I_CTOFF 的诊断语义。 */
typedef struct {
    int stride;
    int offSerial;
    int offX, offY;
    int offBtn;          /* pkButtons         -1 = 掩码里没有 */
    int offZ;            /* pkZ（离板高度）    -1 = 掩码里没有 */
    int offNP;           /* pkNormalPressure  -1 */
    int offTP;           /* pkTangentPressure -1 */
} LAYOUT;

static void layout_of(u32 mask, int ctxSize, LAYOUT* L)
{
    static const u32 bits[]  = { PK_CONTEXT, PK_STATUS, PK_TIME, PK_CHANGED,
                                 PK_SERIAL_NUMBER, PK_CURSOR, PK_BUTTONS,
                                 PK_X, PK_Y, PK_Z, PK_NORMAL_PRESSURE,
                                 PK_TANGENT_PRESSURE, PK_ORIENTATION, PK_ROTATION };
    int off = 0;
    memset(L, 0, sizeof(*L));
    L->offSerial = L->offX = L->offY = -1;
    L->offBtn = L->offZ = L->offNP = L->offTP = -1;
    for (int i = 0; i < (int)(sizeof(bits) / sizeof(bits[0])); i++) {
        if (!(mask & bits[i])) continue;
        int sz = 4;
        if (bits[i] == PK_CONTEXT) sz = ctxSize;
        else if (bits[i] == PK_ORIENTATION || bits[i] == PK_ROTATION) sz = 12;
        if (bits[i] == PK_SERIAL_NUMBER) L->offSerial = off;
        if (bits[i] == PK_BUTTONS)       L->offBtn = off;
        if (bits[i] == PK_X)             L->offX = off;
        if (bits[i] == PK_Y)             L->offY = off;
        if (bits[i] == PK_Z)             L->offZ = off;
        if (bits[i] == PK_NORMAL_PRESSURE)  L->offNP = off;
        if (bits[i] == PK_TANGENT_PRESSURE) L->offTP = off;
        off += sz;
    }
    L->stride = off;
}

/* ------------------------------------------- 由 (stride, offSerial) 反推 X/Y
 * ⛔ 为什么需要它：真机上 `WTGetA` 报的 `lcPktData` 是 **0x00C8**（CHANGED|BUTTONS|X，
 *    连 PK_Y 都没有），而真实包是 52 字节 —— 也就是说驱动上报的「请求掩码」与它实际
 *    吐出的包布局**不是一回事**（jwwh-1988.log 实证）。于是「掩码推算」这条路在本机
 *    永远不可能给出 offY ⇒ 标定永远失败 ⇒ 一包都没改写（日志里 calib=否 而
 *    smoothed == packets，正是旧版「把处理过的包当成改写过的包」的计数在说谎）。
 *
 * 修法：不猜驱动语义，**用观测值反推**。字段顺序与尺寸是 wintab.h 定死的，
 * 因此 (stride, offSerial) 这一对观测值能反解出的 (offX, offY) 是**唯一**的：
 * 枚举全部 2^14 个掩码 × 2 种 pkContext 尺寸，凡是能同时满足 stride 与 offSerial
 * 的布局，其 offX/offY 必然一致（不一致 ⇒ 存在歧义，宁可不改写）。
 * 本机实测：(52, 8) ⇒ offX=20, offY=24，与人工读原始字节的结论一致。 */
#define LAY_MAX 128
static int g_layXY[LAY_MAX][LAY_MAX];    /* [stride][offSerial] → (offX<<8)|offY */
static int g_layBuilt;                   /* -2=无此布局  -1=歧义 */

static void layout_table_build(void)
{
    if (g_layBuilt) return;
    for (int i = 0; i < LAY_MAX; i++)
        for (int j = 0; j < LAY_MAX; j++) g_layXY[i][j] = -2;
    for (int c = 0; c < 2; c++) {
        int ctxSize = c ? 8 : 4;
        for (u32 m = 0; m <= (u32)PK_ALL; m++) {
            LAYOUT L;
            layout_of(m, ctxSize, &L);
            if (L.offX < 0 || L.offY < 0) continue;
            if (L.stride <= 0 || L.stride >= LAY_MAX || L.offSerial < 0 || L.offSerial >= LAY_MAX) continue;
            int v = (L.offX << 8) | L.offY;
            int cur = g_layXY[L.stride][L.offSerial];
            if (cur == -2) g_layXY[L.stride][L.offSerial] = v;
            else if (cur != v) g_layXY[L.stride][L.offSerial] = -1;      /* 歧义 ⇒ 拒绝 */
        }
    }
    g_layBuilt = 1;
}

/* 弱判据（O(1)）：这对 (stride, offSerial) **存不存在**合法布局？
   ⚠️ 只用来给盲扫过滤掉明显荒谬的候选，**不能**用来定解 ——
      本机 (52,8) 就有三组掩码都能生成，定解必须走 layout_pick_xy。 */
static int layout_has_geom(int stride, int offSerial)
{
    layout_table_build();
    if (stride <= 0 || stride >= LAY_MAX) return 0;
    if (offSerial < 0 || offSerial >= LAY_MAX) return 0;
    return g_layXY[stride][offSerial] != -2;
}

static int layout_infer_xy(int stride, int offSerial, int* offX, int* offY)
{
    layout_table_build();
    if (stride <= 0 || stride >= LAY_MAX) return 0;
    if (offSerial < 0 || offSerial >= LAY_MAX) return 0;
    int v = g_layXY[stride][offSerial];
    if (v < 0) return 0;                 /* -2 无解 / -1 歧义 */
    *offX = (v >> 8) & 0xFF;
    *offY = v & 0xFF;
    return 1;
}

/* ------------------------------------- 歧义时用**位移**判据定解
 * ⛔ 光靠 (stride, offSerial) 不够：本机就有三组掩码都能生成 (52, 8)，分别把 X 放在
 *    12 / 16 / 20 —— 差的就是「序号之后到底有没有 pkCursor、pkButtons」。
 *    写错偏移的代价是污染 buttons（幽灵按键），所以这里再加一条**只依赖真实数据**的判据：
 *       **X 与 Y 必须在本批内都发生位移。**
 *    对照真实布局（12=CURSOR 常量、16=BUTTONS 恒 0、20=X、24=Y）：
 *       (12,16) 两个都不动、(16,20) 只有「Y」动、(20,24) X 与 Y 同时动 ⇒ 唯一解。
 *    这一批分不出来（例如笔正好沿水平/垂直方向走）就交给下一批 —— 宁可多等，绝不猜。 */
#define LAY_PICK_MAX 32
static int layout_pick_xy(int stride, int offSerial, const u8* buf, int n,
                          int* offX, int* offY)
{
    layout_table_build();
    int pairs[LAY_PICK_MAX][2];
    int np = 0;
    for (int c = 0; c < 2 && np < LAY_PICK_MAX; c++) {
        int ctxSize = c ? 8 : 4;
        for (u32 m = 0; m <= (u32)PK_ALL && np < LAY_PICK_MAX; m++) {
            LAYOUT L;
            layout_of(m, ctxSize, &L);
            if (L.stride != stride || L.offSerial != offSerial) continue;
            if (L.offX < 0 || L.offY < 0) continue;
            int dup = 0;
            for (int i = 0; i < np; i++) if (pairs[i][0] == L.offX && pairs[i][1] == L.offY) { dup = 1; break; }
            if (!dup) { pairs[np][0] = L.offX; pairs[np][1] = L.offY; np++; }
        }
    }
    int found = 0, fx = -1, fy = -1;
    for (int i = 0; i < np; i++) {
        int ox_ = pairs[i][0], oy_ = pairs[i][1];
        if (ox_ + 4 > stride || oy_ + 4 > stride) continue;
        u32 bx, by;
        memcpy(&bx, buf + ox_, 4);
        memcpy(&by, buf + oy_, 4);
        int mx = 0, my = 0;
        for (int k = 1; k < n && k < 8; k++) {
            u32 vx, vy;
            memcpy(&vx, buf + (SIZE_T)k * stride + ox_, 4);
            memcpy(&vy, buf + (SIZE_T)k * stride + oy_, 4);
            if (vx != bx) mx = 1;
            if (vy != by) my = 1;
        }
        if (mx && my) {
            if (found) return 0;         /* 仍然歧义 ⇒ 拒猜 */
            found = 1; fx = ox_; fy = oy_;
        }
    }
    if (!found) return 0;
    *offX = fx; *offY = fy;
    return 1;
}

/* -------------------------------------------- 盲扫：找「逐包恰好 +1」的字段 */
/* `pkSerialNumber` 的性质：同一上下文内**逐包 +1**。据此可在完全不知道布局的前提下
   反解出 (stride, offSerial) —— 与掩码推算构成两条独立证据，交叉验证。 */
/* ⚠ 附加一道**弱**过滤：候选 (S,o) 至少要能由某个合法的 wintab 字段组合生成。
   否则 n 很小时（例如恰好两个包里某对 0/1）会撞出假证据，写错偏移的后果是污染
   buttons 等字段（幽灵按键），宁可多等一批包也不要冒险。
   ⛔ 只用弱判据：本机 (52,8) 存在三组掩码都能生成，若在这里要求「唯一解」会把正解
      一起滤掉（实测过）—— 定解统一交给 layout_pick_xy，那里有真实位移做依据。 */
static int scan_serial(const u8* buf, int n, int* outStride, int* outOff,
                       int* outX, int* outY)
{
    if (n < 3) return 0;
    for (int S = 8; S <= 256; S += 4) {
        for (int o = 0; o + 4 <= S; o += 4) {
            u32 base;
            memcpy(&base, buf + o, 4);
            if (base == 0 || base == 0xFFFFFFFFu) continue;
            int ok = 1;
            for (int k = 1; k < n && k < 6; k++) {
                u32 v;
                memcpy(&v, buf + (SIZE_T)k * S + o, 4);
                if (v != base + (u32)k) { ok = 0; break; }
            }
            int ix, iy;
            if (ok && layout_has_geom(S, o)) {
                /* 先试几何唯一解；歧义时退回 -1，由调用方用位移判据定解 */
                if (!layout_infer_xy(S, o, &ix, &iy)) { ix = -1; iy = -1; }
                *outStride = S; *outOff = o; *outX = ix; *outY = iy;
                return 1;
            }
        }
    }
    return 0;
}

/* 掩码推算出的布局**直接拿真实数据验一遍**：序号必须逐包 +1。
   只要有 n>=2 个包就能验（比盲扫的门槛低），因此包数少时也能给出结论。 */
static int verify_layout(const u8* buf, int n, int stride, int offSerial)
{
    if (n < 2 || stride <= 0 || offSerial < 0 || offSerial + 4 > stride) return 0;
    u32 base;
    memcpy(&base, buf + offSerial, 4);
    if (base == 0 || base == 0xFFFFFFFFu) return 0;
    for (int k = 1; k < n; k++) {
        u32 v;
        memcpy(&v, buf + (SIZE_T)k * stride + offSerial, 4);
        if (v != base + (u32)k) return 0;
    }
    return 1;
}

/* --------------------------------------------------------------- 尝试标定
 * ⛔ 调用方保证 **n>=3**：盲扫「序号逐包 +1」需要至少 3 个包才不是巧合。
 *    旧版 n>=2 就开跑，而真机第一批往往正好 2 个包 ⇒ 盲扫直接放弃 ⇒ 只剩掩码推算
 *    ⇒ 掩码又不带 PK_Y ⇒ 判失败，且 tried 被永久置 1（再也等不到第二次机会）
 *    ⇒ 平滑全程零改写（jwwh-*.log：`calib=否` 且 `smoothed == packets`）。
 *    现在：证据不足就**什么都不做**，等下一批包（见 smooth_packets）。 */
static void try_calibrate(HCTX hCtx, void* buf, int n)
{
    g_calib.attempts++;
    InterlockedIncrement(&g_calibTriedTotal);

    /* ① 掩码推算（驱动上报的「请求掩码」，可能与真实包布局不一致 —— 见下） */
    HMODULE hm = GetModuleHandleA("Wintab32.dll");
    PFN_WTGetA pGet = NULL;
    if (hm) {
        pGet = (PFN_WTGetA)(void*)GetProcAddress(hm, "WTGetA");
        if (!pGet) pGet = (PFN_WTGetA)(void*)GetProcAddress(hm, "WTGet");
    }
    u32 mask = 0;
    int haveMask = 0;
    LONG inExtX = 0, inExtY = 0;
    LONG outExtX = 0, outExtY = 0, outOrgX = 0, outOrgY = 0;
    /* 全尺寸零缓冲（见 WT_LC_BUFSZ 处的根因注释）：WTGet 会回写整个
       LOGCONTEXT（~172 字节），按偏移 64 取 lcPktData —— 这才是真实布局。
       放在外层：标定失败时要把它整个 hex dump 出来排障。 */
    u8 lcBuf[WT_LC_BUFSZ];
    memset(lcBuf, 0, sizeof(lcBuf));
    if (pGet) {
        if (pGet(hCtx, lcBuf)) {
            u32 m;
            memcpy(&m, lcBuf + WT_LC_PKTDATA_OFF, sizeof(m));
            if (m && (m & ~(u32)PK_ALL) == 0) {
                mask = m;
                haveMask = 1;
            } else {
                calib_logf("# [calib] WTGet 掩码异常 m=0x%04X ⇒ 按无掩码处理\n", m);
            }
            /* 输入量程：位移门限 / 标称轴→像素比都靠它（比 WTInfo 的设备查询可靠） */
            memcpy(&inExtX, lcBuf + WT_LC_INEXTX_OFF, sizeof(inExtX));
            memcpy(&inExtY, lcBuf + WT_LC_INEXTY_OFF, sizeof(inExtY));
            /* ⛔⛔ 输出量程 = 驱动的**权威映射**（2026-10-14 第四轮，问题 3「受力点与
               圆心分离」）：轴→像素比的唯一正确来源是 lcOutExt/lcInExt ——
               它由驱动按用户的实际映射（整屏 / 强制比例 / 局部区域 / Y 轴翻转）
               填好，**含符号**，不需要任何测量。旧版只用「屏幕尺寸 / 输入量程」估算
               （假定整屏拉伸），真机 [calib] 记下的是屏幕标称 X=3440/44800=0.076786、
               Y=1440/29600=0.048649；而 HUD 实际用的是**光标测量值** [status] pxX 0.0466~0.0676
               （漂 + 偏低，最差比标称低 40%）—— 测量把「外推放大 Δraw」与「光标量化」
               两个误差叠在一起。圆心偏移 = 滞后 × px，px 偏低多少圆心就离真实绘制点差多少：
               实测深色折线端点（真实绘制点）与圆心恒差 **15px**（100px 绳）。 */
            memcpy(&outOrgX, lcBuf + WT_LC_OUTORGX_OFF, sizeof(outOrgX));
            memcpy(&outOrgY, lcBuf + WT_LC_OUTORGY_OFF, sizeof(outOrgY));
            memcpy(&outExtX, lcBuf + WT_LC_OUTEXTX_OFF, sizeof(outExtX));
            memcpy(&outExtY, lcBuf + WT_LC_OUTEXTY_OFF, sizeof(outExtY));
            /* ⛔ 驱动映射指纹（2026-10-15）：改「映射到单屏 / 强制比例」时屏幕尺寸不变，
               只有 lcOutExt 变 ⇒ 靠它才能触发重标定。取**原始值**（未除定标系数）。 */
            if (outExtX != 0 || outExtY != 0) { g_drvOutX = outExtX; g_drvOutY = outExtY; }
        }
    }

    /* ② 序号盲扫（与掩码**完全独立**的证据：只看真实字节） */
    int sStride = 0, sOff = -1, sX = -1, sY = -1;
    int haveScan = scan_serial((const u8*)buf, n, &sStride, &sOff, &sX, &sY);

    /* ③ 掩码推算 + 真实数据校验（pkContext 尺寸两种假设，谁能让序号逐包 +1 谁对） */
    LAYOUT mL;
    memset(&mL, 0, sizeof(mL));
    mL.offX = mL.offY = mL.offSerial = -1;
    mL.offBtn = mL.offZ = mL.offNP = mL.offTP = -1;
    int mVariant = 0, okMask = 0;
    if (haveMask) {
        int cand[2] = { 8, 4 };
        for (int v = 0; v < 2 && !okMask; v++) {
            LAYOUT L;
            layout_of(mask, cand[v], &L);
            if (L.offX < 0 || L.offY < 0) continue;
            if (!verify_layout((const u8*)buf, n, L.stride, L.offSerial)) continue;
            mL = L; mVariant = cand[v]; okMask = 1;
        }
    }

    /* ④ 裁决：掩码与盲扫**一致**才算双证据；不一致时以盲扫为准 ——
       ⛔ 不能反过来判失败。真机上驱动报的 lcPktData 是 0x00C8（连 PK_Y 都没有），
       而包是 52 字节；掩码是「请求」，盲扫是「事实」，事实优先。 */
    int stride = 0, offS = -1, offX = -1, offY = -1, src = 0, ok = 0;
    int cBtn = -1, cZ = -1, cNP = -1, cTP = -1;   /* 落笔判据采纳的字段偏移（下面日志段裁决） */
    if (okMask && (!haveScan || (mL.stride == sStride && mL.offSerial == sOff))) {
        stride = mL.stride; offS = mL.offSerial; offX = mL.offX; offY = mL.offY; src = 1; ok = 1;
    } else if (haveScan) {
        int px, py;
        if (layout_infer_xy(sStride, sOff, &px, &py)) {
            stride = sStride; offS = sOff; offX = px; offY = py; src = 2; ok = 1;
        } else if (layout_pick_xy(sStride, sOff, (const u8*)buf, n, &px, &py)) {
            stride = sStride; offS = sOff; offX = px; offY = py; src = 3; ok = 1;
        } else if (okMask) {
            calib_logf("# [calib] ⚠ 掩码 (stride=%d,off=%d) 与盲扫 (stride=%d,off=%d) 不一致，"
                       "且盲扫无法定出 X/Y ⇒ 等下一批\n", mL.stride, mL.offSerial, sStride, sOff);
        }
    }

    calib_logf("# [calib] hCtx=0x%llX  n=%d\n", (unsigned long long)(UINT_PTR)hCtx, n);
    calib_logf("# [calib] 掩码=%s mask=0x%04X  推算 stride=%d offSerial=%d offX=%d offY=%d (ctx=%d)\n",
               haveMask ? "有" : "无", mask, mL.stride, mL.offSerial, mL.offX, mL.offY, mVariant);
    /* ⛔ 落笔判据用到的三个字段偏移**只有 src=1（掩码+数据双证据）时才采信** ——
       掩码错的时候它们会指到别的字段上（包内恒为非 0 的 cursor / orientation），
       「幽灵落笔」会让闸门永远放行。src≠1 时置 -1，改由「顺序可推」的盲扫候选
       + 双状态资格审查（见 contact_signals_build）。 */
    cBtn = (ok && src == 1) ? mL.offBtn : -1;
    cZ   = (ok && src == 1) ? mL.offZ   : -1;
    cNP  = (ok && src == 1) ? mL.offNP  : -1;
    cTP  = (ok && src == 1) ? mL.offTP  : -1;
    calib_logf("# [calib] 接触字段偏移 采用 btn=%d z=%d np=%d tp=%d（src=%d；"
               "掩码推算本应是 btn=%d z=%d np=%d tp=%d）\n",
               cBtn, cZ, cNP, cTP, src, mL.offBtn, mL.offZ, mL.offNP, mL.offTP);
    calib_logf("# [calib] 盲扫=%s stride=%d offSerial=%d offX=%d offY=%d\n",
               haveScan ? "有" : "无", sStride, sOff, sX, sY);
    calib_logf("# [calib] 结论: %s（依据=%s）\n",
               ok ? "★启用改写" : "!! 本批未定出布局（安全，等下一批）",
               src == 1 ? "掩码+数据" : (src == 2 ? "盲扫+字段几何" : (src == 3 ? "盲扫+位移判据" : "无")));
    if (!ok) {
        /* 把 WTGet 回写的结构原样落盘：驱动上报的 lcPktData 与真实包布局不一致时，
           这是唯一能一眼看出「到底哪个偏移是 lcPktData」的证据（排障用，不在热路径）。 */
        calib_logf("# [calib] LOGCONTEXT 前 128 字节:\n");
        for (int i = 0; i < WT_LC_BUFSZ && i < 128; i += 16) {
            calib_logf("#   +%04X", i);
            for (int j = 0; j < 16 && i + j < WT_LC_BUFSZ; j++) calib_logf(" %02X", lcBuf[i + j]);
            calib_logf("\n");
        }
    }

    /* 坐标上界：优先用上下文自己的输入量程 */
    u32 axMax = 0;
    if (inExtX > 0 || inExtY > 0) axMax = (u32)(inExtX > inExtY ? inExtX : inExtY);
    if (!axMax && hm) {
        PFN_WTInfoA pInfo = (PFN_WTInfoA)(void*)GetProcAddress(hm, "WTInfoA");
        if (pInfo) {
            AXIS_T ax;
            memset(&ax, 0, sizeof(ax));
            if (pInfo(WTI_DEVICES, DVC_X, &ax) && ax.axMax > 0) axMax = (u32)ax.axMax;
        }
    }
    if (!axMax) axMax = 32767;
    calib_logf("# [calib] 轴上界 = %u（lcInExtX=%ld lcInExtY=%ld）\n", axMax,
               (long)inExtX, (long)inExtY);

    /* 轴→像素比：**唯一权威 = 屏幕 / lcOutExt**（2026-10-15 回归定案，推翻第五轮）。
       ⛔⛔ 依据（[gap] v2 绝对坐标 122 样本线性回归，rms 3.8/4.2px）：
          screen_x = 4.9 + 0.06223·raw_x，screen_y = 1438.0 − 0.06232·raw_y
          —— 两轴真实尺度都是 ~0.0622–0.0625 = 屏幕/lcOutExt（3440/55040），
          且**严格线性**。旧公式 屏幕/lcInExt（0.0768/0.0486）把 X 高估 22.9%、
          Y 低估 22.0% —— 「横领先 / 竖落后」逐轴残差的根因；而「lcOutExt/lcInExt
          再搜 2 的幂定标」用 /16 恰好把 1.2286/0.7784 拉回标称，把真信息抹掉了
          （1.2286/0.7784 本身就是误差系数！）。
       ⛔ Wintab 语义：lcOutExt 是上下文**输出量程**，与包坐标**同单位**；
          标准驱动（lcOutExt=屏幕 px、包=屏幕 px）下本公式自动得 1.0，同样成立 ⇒
          一条公式覆盖 1/16 单位驱动与标准驱动。N1「光标实测 Δ 偏低 40% 且漂」
          同案昭雪：那就是真实尺度在抗议，被当噪声废弃了。
       ⛔ 符号**不在这里猜**：仍由光标标定的符号投票裁决（Y 轴本机实测反向）。 */
    if (g_pxSrc != 1) {
        double scrW = (double)(g_screenW > 0 ? g_screenW : 1920);
        double scrH = (double)(g_screenH > 0 ? g_screenH : 1080);
        long oex = outExtX < 0 ? -outExtX : outExtX;   /* Wintab 惯例 lcOutExtY 可为负 */
        long oey = outExtY < 0 ? -outExtY : outExtY;
        int haveOut = (oex > 1 && oey > 1);
        if (haveOut) {
            g_pxAxisX = scrW / (double)oex;
            g_pxAxisY = scrH / (double)oey;
            g_pxSrc = 1;
        } else if (!g_pxCalibrated) {
            /* lcOutExt 无效才退标称（lcInExt 分母 —— 旧权威，仅在拿不到 lcOutExt 时兜底）。 */
            double extX = (double)(inExtX > 0 ? inExtX : (LONG)axMax);
            double extY = (double)(inExtY > 0 ? inExtY : 32767);
            double nomX = scrW / (extX > 1.0 ? extX : 1.0);
            double nomY = scrH / (extY > 1.0 ? extY : 1.0);
            if (nomX > 0.0001 && nomX < 1000.0) g_pxAxisX = nomX;
            if (nomY > 0.0001 && nomY < 1000.0) g_pxAxisY = nomY;
            g_pxSrc = 0;
        }
        /* ⛔ 包坐标真实上界 = lcOutExt（不是 lcInExt）：jumpPx 等位移门限的分母口径
           必须与 px 同源 —— axisMax×px 才等于屏幕跨度（55040×0.0625=3440 ✓）。 */
        if (haveOut) {
            axMax = (u32)oex;
            inExtY = oey;
        }
        g_calib.axisMaxY = (u32)(inExtY > 0 ? inExtY : 32767);
        calib_logf("# [calib] lcOut*: org=(%ld,%ld) ext=(%ld,%ld)  ⇒ px=屏幕/lcOutExt X=%.6f Y=%.6f%s\n",
                   (long)outOrgX, (long)outOrgY, (long)outExtX, (long)outExtY,
                   g_pxAxisX, g_pxAxisY, haveOut ? "" : "（lcOutExt 无效，退屏幕标称）");
        calib_logf("# [calib] 标称(旧/lcInExt 分母，仅作对照不再采用) X=%.6f Y=%.6f\n",
                   (double)g_screenW / (double)(inExtX > 0 ? inExtX : 1),
                   (double)g_screenH / (double)(oey > 0 ? oey : 1));
        calib_logf("# [calib] 采用 %s： X=%.6f Y=%.6f（符号另由标定投票定）\n",
                   haveOut ? "屏幕/lcOutExt" : "屏幕标称", g_pxAxisX, g_pxAxisY);
    }

    g_calib.hCtx = hCtx;
    g_calib.stride = ok ? stride : (haveScan ? sStride : 0);
    g_calib.offSerial = ok ? offS : sOff;
    g_calib.offX = ok ? offX : -1;
    g_calib.offY = ok ? offY : -1;
    /* ⛔⛔ 落笔判据的字段偏移在上面的日志段就已经裁决好了（cBtn/cZ/cNP/cTP，见那里的注释）。 */
    g_calib.offBtn = cBtn; g_calib.offZ = cZ; g_calib.offNP = cNP; g_calib.offTP = cTP;
    g_calib.axisMax = axMax;
    g_calib.valid = ok;
    /* ⛔ 失败不立刻认命：盲扫要 n>=3，而真机前几批常常只有 2 个包。
       给 8 次机会，期间 state 保持 0（未标定），面板如实显示「等待标定」。 */
    if (ok) g_calib.tried = 1;
    else if (g_calib.attempts >= 8) {
        g_calib.tried = 1;
        InterlockedExchange(&g_state, 2);
    }

    if (ok) {
        /* ⛔ 布局真的变了（含落笔字段偏移）⇒ 轨迹状态作废。
           ⛔ 接触判据的**信号表**不在这里重建，改由 detour 按「布局指纹」统一裁决
              （见 ct_sig_needs_rebuild）—— 这样「新标定」与「ctx 缓存命中」两条路
              走同一段代码，不会出现一条重建、另一条不重建的分叉。 */
        static int s_layoutKnown;
        static int s_lStride, s_lOffY, s_lOffX, s_lBtn, s_lNP, s_lTP;
        if (s_layoutKnown && (s_lStride != g_calib.stride || s_lOffY != g_calib.offY
                           || s_lOffX != g_calib.offX
                           || s_lBtn != cBtn || s_lNP != cNP || s_lTP != cTP)) {
            g_wasEnabled = 0;                    /* 换布局 ⇒ 轨迹状态作废 */
        }
        s_layoutKnown = 1;
        s_lStride = g_calib.stride; s_lOffY = g_calib.offY; s_lOffX = g_calib.offX;
        s_lBtn = cBtn; s_lNP = cNP; s_lTP = cTP;
        ctx_cache_put(hCtx, &g_calib);
    }

    if (!ok) {
        /* 把原始字节留给 worker 落盘：手工一看就能定位 X/Y（下一版即可硬编码/修正） */
        int len = n * (haveScan ? sStride : 32);
        if (len > (int)sizeof(g_dump)) len = (int)sizeof(g_dump);
        if (len > 0) memcpy(g_dump, buf, len);
        g_dumpLen = len;
        InterlockedExchange(&g_dumpWanted, 1);
    }
    /* ⛔ detour 内最后一步：把拼好的标定文本交给 worker 落盘（本函数全程零 I/O）。 */
    calib_publish();
}

/* ================================================================== 单包滤波
 * 只刷新 HUD 快照、**不改写缓冲区**。闸门不成立时走这条路：
 *   既让渲染线程的「轴→像素比」标定持续更新（否则关掉闸门就再也标定不了），
 *   又保证 PS 拿到的坐标一个字节都没变 ⇒ 悬空移动时完全没有迟滞。 */
static void snapshot_only(const u8* buf, int stride, int n, int ox_, int oy_)
{
    if (n <= 0 || ox_ + 4 > stride || oy_ + 4 > stride) return;
    const u8* p = buf + (SIZE_T)(n - 1) * stride;
    u32 vx, vy;
    memcpy(&vx, p + ox_, 4);
    memcpy(&vy, p + oy_, 4);
    sn_publish((LONG)vx, (LONG)vy, (LONG)vx, (LONG)vy, (LONG)GetTickCount());
}

/* 返回**本批里坐标真正被改写的包数**（复位帧原值写回、无差异帧都不算）。
 * ⛔ 早期版本把「处理过的包数」直接加进 g_smoothed ⇒ 面板显示「已平滑 17086 包」
 *    而实际一包都没改过（标定失败早退）—— 计数器必须只说改写，不能说处理。 */
static int smooth_packets(HCTX hCtx, void* buf, int n)
{
    /* ——— 标定（每个上下文一次；n>=2 即可做「序号逐包 +1」验证）——— */
    if (g_calib.hCtx != hCtx) {
        CALIB cached;
        if (g_calib.hCtx != 0) {
            InterlockedIncrement(&g_hCtxChanges);
            /* 64 位对齐宽度写在 x64 上本就原子，且只是诊断镜像（[status] 代打），
               ⛔ 不用 InterlockedExchange：其 32 位重载会截断句柄（编译告警）。 */
            g_ctxLastFrom = (LONG_PTR)g_calib.hCtx;
            g_ctxLastTo = (LONG_PTR)hCtx;
        }
        if (ctx_cache_find(hCtx, &cached)) {
            /* ⛔ 命中缓存：零窗口切换 —— 不重标定（没有原始包漏过去的窗口）、
               不清轨迹（g_wasEnabled 保留 ⇒ 不触发锚定复位）、不清接触判据。 */
            g_calib = cached;
            g_calib.hCtx = hCtx;
        } else {
            g_calib.hCtx = hCtx;
            g_calib.tried = 0;
            g_calib.attempts = 0;
            g_calib.valid = 0;
            g_calib.stride = 0;
            g_calib.offSerial = g_calib.offX = g_calib.offY = -1;
            /* ⛔ 旧版在这里清 g_wasEnabled 与接触判据 ⇒ 每次 ctx 切换都锚定复位。
               现在保留轨迹：布局若真变了，try_calibrate 成功后按「布局差异」清理
               （见 CALIB_LAYOUT_CHANGED），同布局则完全无缝。 */
        }
    }
    if (!g_calib.tried) {
        /* 盲扫「序号逐包 +1」要 n>=3 才不是巧合 ⇒ 证据不足就整批放过，等下一批。
           ⛔ 旧版 n>=2 就判一次且立刻置 tried=1：真机第一批往往正好 2 个包，
              盲扫被跳过、掩码又不可信 ⇒ 一次判死，此后永不重试（日志里整场只有
              一段 [calib] 就是这个原因）。 */
        if (n >= 3) try_calibrate(hCtx, buf, n);
        else { InterlockedExchange(&g_reason, RS_NOCTX); return 0; }
    }
    if (!g_calib.valid || g_calib.offX < 0 || g_calib.offY < 0) {
        InterlockedExchange(&g_reason, RS_NOCAL);
        return 0;
    }

    const int S = g_calib.stride;
    const int ox_ = g_calib.offX, oy_ = g_calib.offY;
    if (S <= 0 || ox_ + 4 > S || oy_ + 4 > S) {
        InterlockedExchange(&g_reason, RS_NOCAL);
        return 0;
    }

    /* 接触判据的**信号表**：按「布局指纹」统一裁决是否重建。
       ⛔ 指纹包含落笔字段偏移（btn/np/tp），所以「同设备换 hCtx（缓存命中）」不会重建、
          「换设备/换布局」一定会重建。重建会把已积累的「见过 0 / 非 0」证据清零，
          因此只在**真的变了**时做（否则头几百个包判据不可用）。 */
    if (ct_sig_needs_rebuild(ox_, oy_, S, g_calib.offBtn, g_calib.offNP, g_calib.offTP)) {
        contact_signals_build(ox_, oy_, S, g_calib.offBtn, g_calib.offNP, g_calib.offTP);
        ct_sig_remember(ox_, oy_, S, g_calib.offBtn, g_calib.offNP, g_calib.offTP);
    }

    /* ——— 闸门 ①：工具必须是套索（**起笔闩锁**版，2026-10-14）———
     * ⚠️ 顺序要紧：**先判工具、后读接触场**。工具不是套索时整批直接放过，
     *    连压力字段都不去碰 —— 悬空移动时那些字段本来就没数据，
     *    让它们参与「候选证伪」只会把判据推向错误的字段。
     * ⛔ 裁决时机：**悬空（上一批未接触）时现判并闩住；笔画进行中沿用闩锁**。
     *    一笔之中闸门心跳的短暂过期/翻转不再把坐标流劈成「一半原始、一半平滑」。
     *    笔起（接触消失）即解闩，下一笔重新裁决；面板总开关（CFG_I_ENABLED）
     *    保持**实时**，不受闩锁影响 —— 用户关开关必须立即停。
     * ⚠️ 闸门不成立时**仍然刷新快照**：HUD 线程的「轴→像素比」标定靠
     *    g_snOutX/g_snMs，闸门一关就不再更新的话，标定会永远停在初值
     *    （这正是「关掉提示就再也不标定」那个旧 bug 的同构版本）。
     *    快照刷新是普通内存写，且**不改写缓冲区一个字节** ⇒ 迟滞感为零。 */
    LONG contactPrev = g_contact;
    LONG latched = g_strokeGate;
    int useGate;
    if (contactPrev && latched == 1) {
        useGate = g_cfg[CFG_I_ENABLED] ? 1 : 0;            /* 整笔持有工具裁决 */
    } else {
        /* 悬空 / 闩锁缺失（上一批被总开关或复位打断）⇒ 现判一次 */
        useGate = (tool_gate_ok() && g_cfg[CFG_I_ENABLED]) ? 1 : 0;
    }
    if (!useGate) {
        g_wasEnabled = 0;
        InterlockedExchange(&g_strokeGate, -1);
        int tg = tool_gate_ok();
        InterlockedExchange(&g_toolOk, tg ? 1 : 0);
        gate_set(0);
        InterlockedExchange(&g_penDown, 0);
        /* P3.5：把「为什么被挡」定死（面板只做展示）。⛔ 顺序 = 用户能理解的原因链：
           先看总开关，再看工具闸门。tool_gate_reason() 与 tool_gate_ok() 同源，
           所以这里报出的原因与上面的裁决**必然一致**。 */
        if (!g_cfg[CFG_I_ENABLED]) InterlockedExchange(&g_reason, RS_OFF);
        else if (!tg)              InterlockedExchange(&g_reason, (LONG)tool_gate_reason());
        else                       InterlockedExchange(&g_reason, RS_OFF);   /* 防御：理论到不了 */
        snapshot_only((u8*)buf, S, n, ox_, oy_);
        return 0;
    }
    InterlockedExchange(&g_toolOk, 1);

    /* ——— 闸门 ②：笔尖必须接触画布（落笔）———
     * ⛔ 判据 = buttons / pkNormalPressure / pkTangentPressure **任一非零**（见 contact_update）。
     *    判据尚未建立（无信号 / 冷启动宽限之后仍无信号取得投票权）时一律按「未落笔」处理：
     *    宁可在用户第一次落笔时少平滑一帧，也不要退化成「悬空也在平滑」—— 那正是要修的缺陷。 */
    contact_update((const u8*)buf, S, n);
    LONG down = g_contact;
    InterlockedExchange(&g_penDown, down);
    if (!down) {
        g_wasEnabled = 0;            /* 抬笔 ⇒ 下一笔重新起笔锚定 */
        InterlockedExchange(&g_strokeGate, -1);   /* 笔起 ⇒ 解闩，下一笔重新裁决 */
        gate_set(0);
        /* ⛔ 原因必须区分「判据未建立」与「真的悬空」：
           判据未建立时（g_ctUnknown=1）报 RS_CT_UNKNOWN，面板据此说明
           「落笔判据正在建立 / 未建立」，而不是误导成「笔尖未落纸」——
           用户明明落着笔却被告知悬空，是上一轮诊断最严重的问题。 */
        InterlockedExchange(&g_reason, g_ctUnknown ? RS_CT_UNKNOWN : RS_HOVER);
        snapshot_only((const u8*)buf, S, n, ox_, oy_);   /* 同上：只刷快照，不改坐标 */
        return 0;
    }
    InterlockedExchange(&g_strokeGate, 1);    /* 起笔 ⇒ 闩住整笔 */
    gate_set(1);
    /* 走到这里就是「正在改写」。判据未建立但**仍在冷启动宽限内**（多信号还没攒够证据）
       也会走到这里 —— 用 RS_CT_UNKNOWN 标注「判据尚未建立，效果可能不完整」。 */
    InterlockedExchange(&g_reason, g_ctUnknown ? RS_CT_UNKNOWN : RS_REWRITE);

    /* ——— 参数（全部从共享内存现读，调用方保证 g_cfg 非空）——— */
    const int    mode   = g_cfg[CFG_I_MODE];
    const int    flags  = g_cfg[CFG_I_FLAGS];
    /* ⛔⛔ 逐轴换算（含符号），不再用单个标量：
       面板上的「半径 / 绳长 / 追笔速度」都是**屏幕像素**，换算回轴空间时每个轴
       的比例不同（本机 X 0.0768 / Y 0.0486），用同一个标量会让「圆」在 Y 方向上
       比真实约束大/小 1.58 倍 ⇒ 绳长与画的圈对不上（用户的原话：
       「光标触碰到圆圈时圈就闪」其实是「画的圈」与「真实约束」不是同一条曲线）。
       ⛔ 只做普通内存读，不违反 detour 零系统调用铁律。 */
    const double cX = px_x(), cY = px_y();
    /* ⛔⛔ DPI 缩放（2026-10-15）：面板上的「半径 / 追笔速度 / 甩笔阈值 / 拐角门限」
       都是**逻辑像素**，而 cX/cY（轴→像素）是**物理**像素 ⇒ 一律乘 dpiS 才进同一域。
       150% 屏上半径 100 ⇒ 150 物理 px，观感与 100% 屏上的 100px 一致。 */
    const double dpiS = dpi_scale();
    double t = (double)g_cfg[CFG_I_STRENGTH]; if (t < 0) t = 0; if (t > 100) t = 100;
    int radiusPx = g_cfg[CFG_I_RADIUSPX]; if (radiusPx < 1) radiusPx = 1;
    if (radiusPx > RADIUS_PX_MAX) radiusPx = RADIUS_PX_MAX;
    int catchUp  = g_cfg[CFG_I_CATCHUP];  if (catchUp  < 0) catchUp  = 0; if (catchUp  > 100) catchUp  = 100;
    int cornerDeg = g_cfg[CFG_I_CORNER];  if (cornerDeg < 0) cornerDeg = 0; if (cornerDeg > 90) cornerDeg = 90;

    /* 半径 / 绳长 / 追笔距离一律在**屏幕像素**域里比：位移逐轴换算成像素后再取模长，
       于是「画的圈」= 「真实约束」= 同一条曲线（逐轴对称时轴空间的距离会变成椭圆）。 */
    const double radiusPxF = (double)radiusPx * dpiS;          /* 逻辑 px → 物理 px */
    const double jumpPx = JUMP_RESET_FRAC * (double)g_calib.axisMax * (cX < 0 ? -cX : cX) * dpiS;
    const double cornerCos = cos_deg_series(cornerDeg);

    const int speedAdaptive = (flags & 1) ? 1 : 0;
    int changed = 0;

    for (int i = 0; i < n; i++) {
        u8* p = (u8*)buf + (SIZE_T)i * S;
        u32 rawX, rawY;
        memcpy(&rawX, p + ox_, 4);
        memcpy(&rawY, p + oy_, 4);
        double x = (double)rawX, y = (double)rawY;

        /* ⛔⛔ `now` 必须**每包**取样，不能整批取一次。
           旧版写在循环外，而 g_lastMs 在循环内被更新 ⇒ 一批里第 2 个包起
           dt = now − now = 0，被钳到 1ms ⇒ k = dt/(dt+τ) 退化成 1/(1+τ)
           （强度 40 时 0.11 而非 0.38）、追笔的 step 也被缩小一个量级
           ⇒ 参数与真实采样率脱钩，「拖滑杆没反应」的第三层根因。
           GetTickCount 只是读 KUSER_SHARED_DATA 的一个常量，不是系统调用，
           detour 里每包调一次完全安全。 */
        DWORD now = GetTickCount();

        /* ——— 复位守卫（起笔锚定 / 抬笔重定位 / 开关刚打开）———
           ⛔ 三种原因分开计数（g_rstAnchor/Gap/Jump）：用户看到的「圆闪现回光标、
           折线瞬间连到光标」就是一次复位，不分开计数就只能靠猜是哪一种。 */
        double dx = x - g_ox, dy = y - g_oy;
        double dpx = dx * cX, dpy = dy * cY;                  /* 逐轴换算后的像素位移 */
        double distPx = dsqrt_(dpx * dpx + dpy * dpy);
        int reset = 0;
        if (!g_wasEnabled)                              reset = RST_ANCHOR;
        else if (now - g_lastMs > TIME_GAP_RESET_MS)     reset = RST_GAP;
        else if (distPx > jumpPx)                        reset = RST_JUMP;

        if (reset) {
            g_lastGapMs = (LONG)(now - g_lastMs);
            if (reset == RST_GAP)    InterlockedIncrement(&g_rstGap);
            else if (reset == RST_JUMP) InterlockedIncrement(&g_rstJump);
            else                     InterlockedIncrement(&g_rstAnchor);
            g_ox = x; g_oy = y;
            g_speed = 0; g_dirX = g_dirY = 0; g_hasDir = 0;
            g_lastMs = now;
            g_wasEnabled = 1;
            /* 复位帧也要把「原样」写回（值相同，统一路径便于核对） */
            u32 nx = (u32)g_ox, ny = (u32)g_oy;
            memcpy(p + ox_, &nx, 4); memcpy(p + oy_, &ny, 4);
            sn_publish((LONG)rawX, (LONG)rawY, (LONG)nx, (LONG)ny, (LONG)now);
            continue;
        }

        double dt = (double)(now - g_lastMs); if (dt < 1.0) dt = 1.0; else if (dt > 100.0) dt = 100.0;
        g_lastMs = now;

        /* 速度低通（屏幕像素/ms）：直接用**逐轴换算后**的位移，与面板的 px/ms 同单位 */
        g_speed = g_speed * 0.72 + (distPx / dt) * 0.28;

        /* 拐角守卫：与上一段输入方向的夹角超过阈值 ⇒ 本帧减弱平滑，保住尖角。
           ⚠️ 只对「标准」模式生效 —— 拉绳/追笔的跟随机制本身不磨圆（拉绳甚至会主动
           把输出点按在绳长处，尖角由绳长决定），加拐角削弱反而破坏它们的手感。
           ⛔ 必须带**位移门限**：抖动的段长通常只有亚像素~2px，而 205Hz 下相邻两帧
           的夹角极易超过 45° ⇒ 不开门限的话「拐角」几乎每帧都成立 ⇒ k 被抬到 0.75
           ⇒ 平滑被关掉，只剩下滞后，观感正是「有延迟却不平滑」。
           ⚠️ 夹角在**屏幕像素域**判定（逐轴对称后两轴比例仍不同，轴空间里的夹角
              与用户看到的夹角不是一回事）。 */
        int corner = 0;
        if (distPx > 0.01) {
            double ux = dpx / distPx, uy = dpy / distPx;
            if (mode == 0 && g_hasDir && distPx > CORNER_MIN_PX * dpiS) {
                double dot = ux * g_dirX + uy * g_dirY;
                if (dot > 1.0) dot = 1.0; else if (dot < -1.0) dot = -1.0;
                if (dot < cornerCos) corner = 1;   /* ⟺ 转折角 > cornerDeg。
                       ⛔ 阈值越小越容易触发保护；面板的「保护范围」已反向映射（90 − 显示） */
            }
            g_dirX = ux; g_dirY = uy; g_hasDir = 1;
        }

        if (mode == 1) {
            /* ===== 拉绳：输出点被一根**定长**的绳拉住 =====
               绳长 = leash_px()（与 HUD 画的圆周半径**同一个函数**）。语义与 PS 原生一致，
               也正是用户描述的那三条：
                 · 绳未绷紧（|原始 − 输出| ≤ 绳长）⇒ 输出点**原地不动** —— 光标在圈内
                   自由移动，绘制点钉在圆心，两者之间只有那根弹力带在动；
                 · 绳绷紧 ⇒ 输出点被拖到恰好「绳长」处 ⇒ 连续绘制时它随光标连续前进
                   （滞后恒为绳长），用户试图出圈时「圈被光标拖着走」；
                 · 因此**光标的偏移永远不会超过圆周** —— 圆周就是那个硬上限本身。
               ⛔ 距离与绳长都在**屏幕像素域**（distPx / radiusPxF）：逐轴对称映射下，
                  轴空间的等距圆在屏幕上其实是椭圆，用它当绳长会让「画的圈」与
                  「真实约束」不是同一条曲线。

               ⛔⛔ 旧版这里是 `g_ox += dx * 0.25`（每个包把剩余距离的 25% 吃掉）。
                  205Hz 下包间隔只有 ~5ms ⇒ 一阶系统的时间常数 τ = dt·(1−α)/α ≈ 15ms
                  ⇒ 稳态滞后只有 v·τ（500px/s 时约 7px），再被半径上限一夹就基本归零。
                  这正是用户报的「洋红点与光标始终重合、完全没有拉绳感」的根因：
                  **把「绳」实现成了指数跟随**。不是参数没生效，是机制被换掉了。 */
            if (distPx > radiusPxF && distPx > 0.0001) {
                /* ⛔⛔ 跟随量必须是「**恰好把绳收回到绳长**」的那一段，即
                     (distPx − radiusPxF)，而不是半径本身。
                   旧式 `f = radiusPxF / distPx` ⇒ 每包沿 dx 走 distPx·f = **radiusPxF**，
                   于是新距离 = distPx − radiusPxF —— 光标刚越过圆周（distPx ≈ radiusPxF）
                   时新距离 ≈ 0 ⇒ **输出点被直接搬到光标上**，正是用户报的
                   「光标来到圆周、圆心立刻跃迁到光标位置，选区画成一段段直线」。
                   正确式 `f = 1 − radiusPxF/distPx` ⇒ 移动量 = distPx − radiusPxF
                   ⇒ 新距离**恒等于 radiusPxF** ⇒ 光标始终停在圆周上、与圆周
                   **保持相对静止**，而圆心沿光标方向连续前进（用户要的正是这个）。
                   ⛔ 两侧都连续：distPx→radiusPxF⁺ 时移动量→0（不跳变）；
                      distPx 之后每增加 Δ，输出点同步走 Δ（绳不再被拉伸）。 */
                double f = 1.0 - radiusPxF / distPx;
                g_ox += dx * f; g_oy += dy * f;
            }
            /* else：绳没绷紧 ⇒ 输出点一字节都不动（见上，这是「拉绳感」的本体） */
        } else if (mode == 2) {
            /* ===== 追笔：输出端以受限速度追赶光标，追上即贴合 =====
               ⛔ 量程必须落在**人的运笔速度区间**内：手绘约 0.05~1.5 px/ms
               （50~1500 px/s）。旧版 0.2~12.2 px/ms（最快 12200 px/s 比任何手都快）
               ⇒ 除最左端外 step 永远大于 dist ⇒ 恒走「贴合」分支 ⇒ 追笔滑杆整条无效。
               ⛔ 2026-10-13 第二轮上调：上限 1.5 → **3.0 px/ms**（3000px/s）。
                  用户反馈「追笔拉满还是觉得不够跟手」。1.5 恰好等于人手速度上限，
                  拉满时 step 与人类的 dist 同量级 ⇒ 仍会频频落到「追赶」分支、留有可见滞后。
                  现在 3.0 是人手极限的两倍 ⇒ 拉满即近似 1:1 跟手（等价于不做平滑），
                  与「数值越大越接近手绘」的文案一致，两端差别也才够明显。 */
            /* ⛔ catchUp 由面板反向映射后落在 1–50（显示「追笔力度」越大 → 本值越小 →
               vmax 越小 → 追赶越慢 → 越黏）。此处按 0..100 通用公式计算即可，无需改。 */
            double vmax = (0.02 + ((double)catchUp / 100.0) * 3.0) * dpiS;   /* 物理 px/ms */
            double step = vmax * dt;                                /* 像素（与 distPx 同域） */
            if (distPx > step && distPx > 0.0001) {
                double f = step / distPx;
                g_ox += dx * f; g_oy += dy * f;
            } else {
                g_ox = x; g_oy = y;
            }
        } else {
            /* ===== 标准：一阶低通，k 按**时间常数**推导 =====
               k = dt/(dt+τ)：同样的强度数字，无论 125Hz 还是 205Hz 采样，
               稳态滞后都等于 v·τ（与采样率解耦）。 */
            double tau = tau_from_strength(t);
            double kk = (dt + tau) > 0.0 ? dt / (dt + tau) : 1.0;
            if (speedAdaptive) {
                /* 甩笔时自动减弱平滑：速度越高越贴手。
                   ⛔⛔ 2026-10-13 量程修正：SPEED_FULL 原为 1.2px/ms（1200px/s），
                      而**人的常规运笔速度区间是 0.05~1.5px/ms**（见 mode==2 的追笔注释）
                      ⇒ 这个阈值落在区间内部，等于「正常画线也在被当成甩笔」：500px/s 时
                      boost=0.42，k 被抬到 τ_eff≈15ms，稳态滞后只剩 8px ——
                      与「平滑感知几乎为零」的实测完全吻合（强度拉满也只有 ~8px 滞后）。
                      现在阈值抬到 3.0px/ms（3000px/s，真·甩笔），并把混合系数从 0.5
                      降到 0.4：常规速度下 τ_eff≈48ms（滞后 ~24px），甩笔时才明显减弱。 */
                double boost = g_speed / (SPEED_FULL * dpiS);   /* g_speed 是物理 px/ms */
                if (boost > 1.0) boost = 1.0;
                kk += (1.0 - kk) * boost * 0.4;
            }
            if (corner) { double kc = 0.75; if (kk < kc) kk = kc; }
            g_ox += dx * kk; g_oy += dy * kk;
        }

        /* 全局最大滞后上限：无论算法怎么算，输出与笔尖的距离不超过 radius（屏幕像素域） */
        double lx = x - g_ox, ly = y - g_oy;
        double lpx = lx * cX, lpy = ly * cY;
        double lagPx = dsqrt_(lpx * lpx + lpy * lpy);
        if (lagPx > radiusPxF && lagPx > 0.0001) {
            double f = (lagPx - radiusPxF) / lagPx;
            g_ox += lx * f; g_oy += ly * f;
        }

        u32 wx = (u32)(g_ox + 0.5), wy = (u32)(g_oy + 0.5);
        memcpy(p + ox_, &wx, 4);
        memcpy(p + oy_, &wy, 4);
        if (wx != rawX || wy != rawY) changed++;

        /* HUD 快照（普通内存写，detour 内零系统调用） */
        sn_publish((LONG)rawX, (LONG)rawY, (LONG)wx, (LONG)wy, (LONG)now);
    }
    return changed;
}

/* ================================================================== detour */
/* ⛔ 铁律：均摊 O(1)、零 I/O、零分配、不加锁、不抛异常。 */

/* —— 断流诊断（2026-10-14 第七轮）：本轮真机钉死的新失效形态 ——
   PS 仍在空轮询 WTPacketsGet（calls 持续增长）但返回 0 包长达数分钟，
   而 penDown 卡在 1、用户笔还在画（截图里有新笔迹）⇒ PS 已走非 Wintab
   的回退输入（Windows Ink / pointer），平滑实质中断。
   三个只读钩子用于锁定「谁断的」：
   · WTPacket（单包通路）  ：若断流期它还在进包 ⇒ PS 切到了消息驱动，我们只挂了批量通路；
   · WTOpenA / WTClose    ：上下文生命周期 —— 断流瞬间有没有关/开上下文。
   ⛔ 只在 WTPacketsGet 主钩上做改写；以下三个只计数/落日志，绝不加工包。 */
static volatile LONG g_wtPkt1;    /* WTPacket 单包成功计数 */
static volatile LONG g_wtOpenN;   /* WTOpenA 次数 */
static volatile LONG g_wtCloseN;  /* WTClose 次数 */
static volatile LONG g_streamDead;/* 1 = 断流判定成立（worker 看门狗写） */
static HCTX g_ctxNow;             /* 最近一次被轮询的上下文（detour 普通写即可） */

/* 只读诊断钩的槽位（与主钩同款 E9-thunk 前提；独立于主钩状态，互不影响） */
typedef struct {
    const char* name;
    u8* entry; u8* impl; u8* relay; u8 orig[5];
    int patched;
    void* detour;
    char skip[128];
} LHOOK;
static LHOOK g_lhPkt1  = { "WTPacket", 0, 0, 0, {0}, 0, 0, {0} };
static LHOOK g_lhOpen  = { "WTOpenA", 0, 0, 0, {0}, 0, 0, {0} };
static LHOOK g_lhClose = { "WTClose", 0, 0, 0, {0}, 0, 0, {0} };
static int lhook_prepare(LHOOK* L);
static int lhook_commit(LHOOK* L);
static void lhook_restore(LHOOK* L);

static u64 det_WTPacket(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)d; (void)e; (void)f;
    typedef UINT (*PFN_WTPacket)(HCTX, UINT, void*);
    PFN_WTPacket impl = (PFN_WTPacket)g_lhPkt1.impl;
    UINT r = impl((HCTX)a, (UINT)b, (void*)c);
    if (r) InterlockedIncrement(&g_wtPkt1);
    return r;
}

static u64 det_WTOpenA(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)d; (void)e; (void)f;
    typedef HCTX (*PFN_WTOpenA)(HWND, void*, BOOL);
    PFN_WTOpenA impl = (PFN_WTOpenA)g_lhOpen.impl;
    /* 低频调用（开上下文）⇒ 允许落盘；205Hz 包路径的铁律不适用于这里。 */
    HCTX h = impl((HWND)a, (void*)b, (BOOL)c);
    const unsigned char* p = (const unsigned char*)b;
    if (p) {
        /* LOGCONTEXTA：lcName[40] 后全是 4 字节整型（无对齐缝）。
           命名字段 + 尾部 hex，防结构体布局猜错。 */
        logf("# [ctx] WTOpenA hCtx=0x%llX name=\"%s\" opt=%X rate=%ld pktData=%X "
             "pktMode=%X move=%X inExt=(%ld,%ld) outExt=(%ld,%ld) tail=%08X %08X %08X\n",
             (unsigned long long)(UINT_PTR)h, (const char*)p,
             *(const unsigned int*)(p + 40), *(const long*)(p + 60),
             *(const unsigned int*)(p + 64), *(const unsigned int*)(p + 68),
             *(const unsigned int*)(p + 72),
             (long)*(const int*)(p + 92), (long)*(const int*)(p + 96),
             (long)*(const int*)(p + 108), (long)*(const int*)(p + 112),
             *(const unsigned int*)(p + 116), *(const unsigned int*)(p + 120),
             *(const unsigned int*)(p + 124));
    } else {
        logf("# [ctx] WTOpenA hCtx=0x%llX (logctx=NULL)\n",
             (unsigned long long)(UINT_PTR)h);
    }
    InterlockedIncrement(&g_wtOpenN);
    return (u64)(UINT_PTR)h;
}

static u64 det_WTClose(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)b; (void)c; (void)d; (void)e; (void)f;
    typedef BOOL (*PFN_WTClose)(HCTX);
    PFN_WTClose impl = (PFN_WTClose)g_lhClose.impl;
    BOOL r = impl((HCTX)a);
    logf("# [ctx] WTClose hCtx=0x%llX ret=%d（此刻 packets=%ld）\n",
         (unsigned long long)(UINT_PTR)a, r, (long)g_packets);
    InterlockedIncrement(&g_wtCloseN);
    return (u64)(u32)r;
}

static u64 det_WTPacketsGet(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    /* d/e/f 只为凑齐 ABI 参数位（转发桩是 `jmp`，不搬栈）：
       WTPacketsGet 只用到前三个，多出的声明不会被读取。 */
    (void)d; (void)e; (void)f;
    static int s_cfgTick;
    PFN_WTPacketsGet impl = (PFN_WTPacketsGet)g_impl;
    int r = impl((HCTX)a, (int)b, (void*)c);            /* 先取包，再加工 */
    InterlockedIncrement(&g_calls);
    g_ctxNow = (HCTX)a;                                 /* 断流诊断：看门狗要比对上下文 */

    if (r > 0) {
        InterlockedExchangeAdd(&g_packets, (LONG)r);
        if (!g_cfg && ((++s_cfgTick & 0xFF) == 0)) {    /* 共享内存没开时低频重试 */
            cfg_open();                                 /* ⛔ 不再顺手续状态=1：见下方状态机 */
        }
        if (g_cfg) {
            LONG en = g_cfg[CFG_I_ENABLED];
            /* ⛔ 心跳防呆：守护进程若被强杀，共享内存仍被本 DLL 持有 ⇒ enabled 会一直
               留在 1。没有这一条，PS 里就会被一段「没人管」的平滑一直改着坐标。
               心跳按 GetTickCount（自开机起的毫秒，跨进程同源）判定，3 秒无更新即停手。 */
            if (en && (DWORD)(GetTickCount() - (DWORD)g_cfg[CFG_I_HEARTBEAT]) > 3000) en = 0;
            if (en) {
                /* 状态机（CFG_I_STATE，面板四档文案的唯一依据）：
                   0=未挂/未标定  1=生效（标定 OK 且真的在改写）  2=标定失败  3=已卸载。
                   ⛔ 旧版在这里无条件置 1 ⇒ 标定失败也显示「生效中」，再叠加 cmd=1
                      （每次开开关都发）无条件置 1 ⇒ 「标定失败」被永久洗掉。现在只认标定结果。 */
                int changed = smooth_packets((HCTX)a, (void*)c, r);
                if (changed > 0) InterlockedExchangeAdd(&g_smoothed, (LONG)changed);
                if (g_calib.valid) {
                    if (g_state != 1) InterlockedExchange(&g_state, 1);
                } else if (g_calib.tried) {
                    if (g_state != 2) InterlockedExchange(&g_state, 2);
                }
            } else {
                g_wasEnabled = 0;                        /* 关掉 ⇒ 下一帧起笔锚定 */
            }
        }
    }
    return (u64)(u32)r;
}

/* hook 目标描述（g_impl 已在文件前部声明） */
static u8* g_entry;
static u8* g_relay;
static u8  g_orig[5];
static volatile LONG g_patched;
/** 1 = 入口已被（多半是上一版本 DLL 的）转发桩占用 ⇒ 本实例拒绝叠加钩子。 */
static int g_entryPrehooked;
static char g_skip[160];

static void* const g_detour = (void*)det_WTPacketsGet;

static int prepare_hook(void)
{
    if (g_patched) return 1;
    g_skip[0] = 0;
    HMODULE hm = GetModuleHandleA("Wintab32.dll");
    if (!hm) hm = LoadLibraryA("Wintab32.dll");
    if (!hm) { sprintf(g_skip, "Wintab32.dll 未加载且加载失败"); return 0; }

    g_entry = (u8*)GetProcAddress(hm, "WTPacketsGet");
    if (!g_entry) { sprintf(g_skip, "导出 WTPacketsGet 不存在"); return 0; }
    if (g_entry[0] != 0xE9) {
        sprintf(g_skip, "入口首字节 = %02X（不是 E9 jmp）⇒ 拒绝改写", g_entry[0]);
        return 0;
    }
    int rel = 0;
    memcpy(&rel, g_entry + 1, 4);
    g_impl = g_entry + 5 + rel;

    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery((LPCVOID)g_entry, &mbi, sizeof(mbi)) != sizeof(mbi)) {
        sprintf(g_skip, "VirtualQuery 失败"); return 0;
    }
    u8* imgBase = (u8*)mbi.AllocationBase;
    if (g_impl < imgBase || g_impl >= imgBase + mbi.RegionSize) {
        /* ⛔ 这条分支在真机上的真实含义是：**入口已经被别的代码改过**（绝大多数情况
           是我们自己上一版的 DLL —— 它被 PS 锁住没法覆盖，于是新版换了文件名注入进来，
           成了同一进程里的第二个副本）。此时绝不能再叠一层 hook（会双重平滑），
           如实上报 state=4，让面板提示重启 Photoshop。 */
        g_entryPrehooked = 1;
        sprintf(g_skip, "入口已被占用（jmp 目标 0x%llX 不在本映像内）⇒ 需重启 Photoshop",
                (unsigned long long)(UINT_PTR)g_impl);
        return 0;
    }
    memcpy(g_orig, g_entry, 5);

    g_relay = alloc_near(g_entry, PAGE_SPAN);
    if (!g_relay) { sprintf(g_skip, "±2GB 内找不到可分配页"); return 0; }
    g_relay[0] = 0x48; g_relay[1] = 0xB8;
    void* dt = g_detour;
    memcpy(g_relay + 2, &dt, 8);
    g_relay[10] = 0xFF; g_relay[11] = 0xE0;
    FlushInstructionCache(GetCurrentProcess(), g_relay, 12);

    LONG_PTR d = (LONG_PTR)(g_relay - (g_entry + 5));
    if (d > 0x7FFFFFF0LL || d < -0x7FFFFFF0LL) {
        sprintf(g_skip, "转发桩距离 %lld 超 rel32 射程", (long long)d); return 0;
    }
    return 1;
}

static int commit_hook(void)
{
    u8 patch[5];
    patch[0] = 0xE9;
    LONG_PTR d = (LONG_PTR)(g_relay - (g_entry + 5));
    int r32 = (int)d;
    memcpy(patch + 1, &r32, 4);
    if (!repatch(g_entry, patch)) { sprintf(g_skip, "VirtualProtect/写入失败"); return 0; }
    u8 back[5];
    memcpy(back, g_entry, 5);
    if (back[0] != 0xE9 || memcmp(back + 1, patch + 1, 4) != 0) {
        sprintf(g_skip, "回读不一致 ⇒ 已还原");
        repatch(g_entry, g_orig);
        return 0;
    }
    InterlockedExchange(&g_patched, 1);
    return 1;
}

static void do_install(void)
{
    if (!prepare_hook()) {
        logf("# 挂载失败: %s\n", g_skip);
        /* state=4：被旧副本占着，本实例不生效。面板据此提示「重启 Photoshop」，
           否则用户只会看到状态条一直停在「注入中…」，无从下手。 */
        if (g_entryPrehooked) InterlockedExchange(&g_state, 4);
        return;
    }
    freeze_threads();
    /* ⛔ 冻结表溢出 ⇒ **放弃改写**。只冻住一部分线程等于没冻：没被冻住的那个线程
       若正好在取指这条 jmp，就会读到「新 E9 + 旧 rel32」的撕裂组合。宁可不平滑。 */
    int ok = 0;
    if (g_overTent) sprintf(g_skip, "线程数超过冻结表容量（2048）⇒ 放弃改写");
    else {
        ok = commit_hook();
        /* 只读诊断钩与主钩同一冻结窗口（lhook_* 不自 freeze，防嵌套 thaw）。
           任何一个失败都只记日志，不影响主钩。 */
        if (ok) {
            g_lhPkt1.detour  = (void*)det_WTPacket;
            g_lhOpen.detour  = (void*)det_WTOpenA;
            g_lhClose.detour = (void*)det_WTClose;
            LHOOK* lhs[3] = { &g_lhPkt1, &g_lhOpen, &g_lhClose };
            for (int i = 0; i < 3; i++) {
                if (!lhook_prepare(lhs[i])) continue;
                lhook_commit(lhs[i]);
            }
        }
    }
    thaw_threads();
    logf("# 挂载: %s  entry=0x%llX impl=0x%llX relay=0x%llX（改写期挂起线程 %d 个）\n",
         ok ? "OK" : g_skip, (unsigned long long)(UINT_PTR)g_entry,
         (unsigned long long)(UINT_PTR)g_impl, (unsigned long long)(UINT_PTR)g_relay, g_frzLast);
    if (g_cfg) g_cfg[CFG_I_FROZE] = g_frzLast;
    logf("# 诊断钩: WTPacket=%s WTOpenA=%s WTClose=%s\n",
         g_lhPkt1.patched ? "挂" : (g_lhPkt1.skip[0] ? g_lhPkt1.skip : "未挂"),
         g_lhOpen.patched ? "挂" : (g_lhOpen.skip[0] ? g_lhOpen.skip : "未挂"),
         g_lhClose.patched ? "挂" : (g_lhClose.skip[0] ? g_lhClose.skip : "未挂"));
}

static void do_unhook(void)
{
    if (!g_patched || !g_entry) return;
    lhook_restore(&g_lhPkt1);
    lhook_restore(&g_lhOpen);
    lhook_restore(&g_lhClose);
    freeze_threads();
    int ok = repatch(g_entry, g_orig);
    thaw_threads();
    if (ok) InterlockedExchange(&g_patched, 0);
    /* 撤钩后闸门语义不再成立 ⇒ 清掉，否则 HUD 会以为「还在平滑」而永久驻留。
       ⛔ 这里用裸 InterlockedExchange 而不是 gate_set()：撤钩不是一次「收笔」，
          记进 g_gateClose 会让面板的「一笔内开合差」统计凭空多一次。 */
    InterlockedExchange(&g_gateOk, 0);
    logf("# 卸载: %s（原字节 %02X %02X %02X %02X %02X 已写回）\n",
         ok ? "OK" : "失败", g_orig[0], g_orig[1], g_orig[2], g_orig[3], g_orig[4]);
}

/* =============== 只读诊断钩（WTPacket / WTOpenA / WTClose） ===============
   与主钩同款 E9-thunk 前提：导出表项本身是 jmp 桩才挂（打在桩上不动真实实现，
   DLL 内部调用方不受影响）。计数/日志用途，失败（非桩/无导出）只记 skip 不妨害主钩。
   ⛔ 调用方必须已处于 freeze_threads() 窗口内（本函数不自freeze，避免嵌套 thaw）。 */
static int lhook_prepare(LHOOK* L)
{
    L->skip[0] = 0;
    HMODULE hm = GetModuleHandleA("Wintab32.dll");
    if (!hm) { sprintf(L->skip, "Wintab32.dll 未加载"); return 0; }
    L->entry = (u8*)GetProcAddress(hm, L->name);
    if (!L->entry) { sprintf(L->skip, "导出 %s 不存在", L->name); return 0; }
    if (L->entry[0] != 0xE9) {
        sprintf(L->skip, "%s 入口首字节=%02X（非 E9 桩）⇒ 不挂", L->name, L->entry[0]);
        return 0;
    }
    int rel = 0;
    memcpy(&rel, L->entry + 1, 4);
    L->impl = L->entry + 5 + rel;
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery((LPCVOID)L->entry, &mbi, sizeof(mbi)) != sizeof(mbi)
        || L->impl < (u8*)mbi.AllocationBase
        || L->impl >= (u8*)mbi.AllocationBase + mbi.RegionSize) {
        sprintf(L->skip, "%s 入口已被占用 ⇒ 不挂", L->name);
        return 0;
    }
    memcpy(L->orig, L->entry, 5);
    L->relay = alloc_near(L->entry, PAGE_SPAN);
    if (!L->relay) { sprintf(L->skip, "%s ±2GB 无可分配页", L->name); return 0; }
    L->relay[0] = 0x48; L->relay[1] = 0xB8;
    void* dt = L->detour;
    memcpy(L->relay + 2, &dt, 8);
    L->relay[10] = 0xFF; L->relay[11] = 0xE0;
    FlushInstructionCache(GetCurrentProcess(), L->relay, 12);
    LONG_PTR d = (LONG_PTR)(L->relay - (L->entry + 5));
    if (d > 0x7FFFFFF0LL || d < -0x7FFFFFF0LL) {
        sprintf(L->skip, "%s 转发桩距离超射程", L->name);
        return 0;
    }
    return 1;
}

static int lhook_commit(LHOOK* L)
{
    u8 patch[5];
    patch[0] = 0xE9;
    int r32 = (int)(LONG_PTR)(L->relay - (L->entry + 5));
    memcpy(patch + 1, &r32, 4);
    if (!repatch(L->entry, patch)) { sprintf(L->skip, "%s VirtualProtect 失败", L->name); return 0; }
    L->patched = 1;
    return 1;
}

static void lhook_restore(LHOOK* L)
{
    if (!L->patched || !L->entry) return;
    freeze_threads();
    int ok = repatch(L->entry, L->orig);
    thaw_threads();
    if (ok) L->patched = 0;
    logf("# [ctx] 诊断钩 %s 还原: %s\n", L->name, ok ? "OK" : "失败");
}

/* ================================================================== worker */
static volatile LONG g_stop;
static HANDLE g_thread;

static void publish_status(void)
{
    if (!g_cfg) return;
    g_cfg[CFG_I_STATE]   = g_state;
    g_cfg[CFG_I_CALLS]   = g_calls;
    g_cfg[CFG_I_PACKETS] = g_packets;
    g_cfg[CFG_I_SMOOTHED]= g_smoothed;
    g_cfg[CFG_I_STRIDE]  = g_calib.stride;
    g_cfg[CFG_I_OFFX]    = g_calib.offX;
    g_cfg[CFG_I_OFFY]    = g_calib.offY;
    g_cfg[CFG_I_OFFSER]  = g_calib.offSerial;
    g_cfg[CFG_I_AXISMAX] = (LONG)g_calib.axisMax;
    g_cfg[CFG_I_PID]     = (LONG)GetCurrentProcessId();
    g_cfg[CFG_I_MAGIC]   = CFG_MAGIC;
    /* P3.2 闸门状态回写：面板用它区分「开着但没在平滑（工具不对/没落笔）」与
       「开着且正在平滑」。没有它，用户看到计数不涨只能猜是哪一条闸门卡住了。 */
    g_cfg[CFG_I_PENDOWN] = g_penDown;
    g_cfg[CFG_I_GATEOK]  = g_gateOk;
    g_cfg[CFG_I_CTUNKNOWN] = g_ctUnknown;
    /* ---- P3.5 诊断回写（面板诊断条的**唯一数据源**）----
       ⛔⛔ 这七项必须在这里一次性回写，不能各自散落：面板只按 250ms 一轮的节奏读
          共享内存，散落写入会让同一帧里「reason 还在说悬空、gateOpen 却已经涨了」，
          诊断文字与它引用的计数自相矛盾（那正是用户抱怨「绿条一闪就没意义」的成因）。
       ⛔ reason 是**上次裁决的结论**，空闲时会停在最后一个值（例如 RS_HOVER）——
          面板必须结合 snAge / STATE 判断「这条结论还新不新」，不要只看它。 */
    g_cfg[CFG_I_REASON]    = g_reason;
    g_cfg[CFG_I_GATEOPEN]  = g_gateOpen;
    g_cfg[CFG_I_GATECLOSE] = g_gateClose;
    /* ---- P3.6 落笔判据（多信号并联）的回写 ----
       ⛔ 面板/日志靠这四项看出「哪几个信号在投票、此刻命中了谁」——
          旧版只有 `ctOff + ctVal`（单字段），真机上 NP 恒 0 时完全无从判断
          「是笔真的悬空」还是「判据字段选错了」。 */
    g_cfg[CFG_I_CTOFF]     = (g_ctN > 0) ? (LONG)g_ctOff[0] : -1;
    g_cfg[CFG_I_CTVAL]     = g_ctVal;
    g_cfg[CFG_I_CTMASK]    = g_ctMask;
    {
        /* ⛔ 只打包**前 4 个**信号：一个 LONG 放得下 4 个字节偏移，而权威路径
           （掩码 + 数据双证据）恰好只有 3 个（buttons/NP/TP）。
           空位一律填 0xFF（合法偏移最大 51）⇒ 面板/日志据此数出信号个数，
           不需要额外的「计数」槽位。完整信号表仍在 [ct] 日志行里。 */
        LONG elig = 0, offs = 0;
        for (int i = 0; i < 4; i++) {
            int o = (i < g_ctN) ? (g_ctOff[i] & 0xFF) : 0xFF;
            if (i < g_ctN && g_ctElig[i] == 1) elig |= (1L << i);
            offs |= ((LONG)o) << (i * 8);
        }
        g_cfg[CFG_I_CTELIG] = elig;
        g_cfg[CFG_I_CTOFFS] = offs;
    }
    g_cfg[CFG_I_PXNX]      = g_axCalX.n;
    g_cfg[CFG_I_PXNY]      = g_axCalY.n;
    /* 轴→像素比（×1000，**逐轴带符号**）：1.0 表示包坐标本身就是屏幕像素；
       若远小于 1（如 0.0586 = 1920/32767）说明包坐标是数位板逻辑单位。
       ⛔ Y 那一份必须带符号（Wintab 的 Y 向上为正、屏幕向下为正）—— 面板/排障
          脚本读到的量级/符号不对，第一个该怀疑的就是这两个槽位。 */
    double ppa = px_x(), ppb = px_y();
    if (ppa > -0.0001 && ppa < 0.0001) ppa = 0.0001;
    if (ppa > 1000.0) ppa = 1000.0; else if (ppa < -1000.0) ppa = -1000.0;
    if (ppb > -0.0001 && ppb < 0.0001) ppb = 0.0001;
    if (ppb > 1000.0) ppb = 1000.0; else if (ppb < -1000.0) ppb = -1000.0;
    g_cfg[CFG_I_PXPERAXIS]  = (LONG)(ppa * 1000.0);
    g_cfg[CFG_I_PXPERAXISY] = (LONG)(ppb * 1000.0);
}

static DWORD WINAPI worker(LPVOID param)
{
    (void)param;
    char tmp[MAX_PATH];
    tmp[0] = 0;
    GetTempPathA(sizeof(tmp), tmp);
    sprintf(g_logPath, "%sjwwh-%lu.log", tmp, (unsigned long)GetCurrentProcessId());
    g_log = CreateFileA(g_logPath, GENERIC_WRITE, FILE_SHARE_READ, NULL,
                        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);

    SYSTEMTIME st; GetLocalTime(&st);
    logf("# JWautofill 笔平滑 hook  pid=%lu  %04d-%02d-%02d %02d:%02d:%02d  ver=0x%04X\n",
         (unsigned long)GetCurrentProcessId(), st.wYear, st.wMonth, st.wDay,
         st.wHour, st.wMinute, st.wSecond, jwwh_version());

    /* 标称「轴→像素比」的分母（见 try_calibrate）。只在这里取一次，detour 内不碰。
       ⛔ 必须是**虚拟屏**：多屏时笔可以跨屏移动，SM_CXSCREEN 只有主屏。
       ⛔ 宽与高都要（逐轴标称）：X 用屏宽、Y 用屏高。 */
    g_screenW = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    g_screenH = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    /* DPI 缩放在**这里**取第一次（后续每 250ms 复检，见下方重标定段）。 */
    dpi_update_scale();
    g_fprScale = g_dpiScaleMilli;
    /* 字段几何查表（32768 种掩码组合）在这里预建，避免第一次标定落在取包线程上。 */
    layout_table_build();

    cfg_open();
    publish_status();
    do_install();
    hud_start();          /* 建窗/绘制全在渲染线程；窗口默认隐藏，用到才出现 */

    LONG lastSeq = -1;
    DWORD lastPublish = 0;
    int loggedDump = 0;
    if (g_cfg) g_cfg[CFG_I_CMDACK] = g_cfg[CFG_I_CMDSEQ];  /* 把「当前序号」当基线，避免立刻执行陈旧命令 */

    while (!g_stop) {
        Sleep(250);
        if (!g_cfg) cfg_open();
        publish_status();

        /* 标定文本由 detour 拼好（那里不能落盘）⇒ 这里补写一次。 */
        if (g_calibTextReady && g_calibTextLen > 0) {
            InterlockedExchange(&g_calibTextReady, 0);
            log_write(g_calibText, g_calibTextLen);
        }

        /* —— 换显示器 / 换缩放 / 换映射重标定（2026-10-14 起，2026-10-15 扩展）——
           屏幕尺寸变了 ⇒ 驱动映射的标称/合理性带全部失效。清掉 px 权威与标定结果，
           下一批包到达时 detour 自动重跑 try_calibrate（驱动 lcOut* 会反映新映射）。
           ⛔ 符号锁定**保留**：显示方向约定（Y 上下）不随尺寸变化，只有旋转屏才会
              改变它 —— 那是另一个明确的手动场景。
           ⛔⛔ 2026-10-15 补两条判据（只比屏幕尺寸会漏）：
             ① **DPI 缩放**：同一台机器改「缩放与布局」150%→200%，物理虚拟屏尺寸
                （SM_CXVIRTUALSCREEN）**不变**，但用户的逻辑像素全变了 ⇒ 必须重推。
             ② **驱动 lcOut* 指纹**：在驱动面板里改「映射到单个屏幕 / 强制比例」时
                屏幕尺寸不变、只有 lcOutExt 变 ⇒ 也漏了。 */
        {
            int sw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            int sh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            dpi_update_scale();
            LONG sc = g_dpiScaleMilli;
            LONG ox = g_drvOutX, oy = g_drvOutY;
            int changed = 0;
            const char* why = "";
            if (sw > 0 && sh > 0 && (sw != g_screenW || sh != g_screenH)) {
                changed = 1; why = "屏幕尺寸";
            } else if (sc != g_fprScale) {
                changed = 1; why = "DPI 缩放";
            } else if (ox != 0 && g_fprOutX != 0 && (ox != g_fprOutX || oy != g_fprOutY)) {
                changed = 1; why = "驱动映射";
            }
            if (changed) {
                logf("# [calib] ★%s变化（%dx%d→%dx%d, dpi %ld‰→%ld‰, lcOut %ldx%ld→%ldx%ld）"
                     " ⇒ px 权威/标定全部重推（符号锁定保留）\n",
                     why, g_screenW, g_screenH, sw, sh,
                     (long)g_fprScale, (long)sc,
                     (long)g_fprOutX, (long)g_fprOutY, (long)ox, (long)oy);
                if (sw > 0 && sh > 0) { g_screenW = sw; g_screenH = sh; }
                g_pxSrc = 0;
                InterlockedExchange(&g_pxCalibrated, 0);
                g_calib.valid = 0; g_calib.tried = 0; g_calib.attempts = 0;
                g_axCalX.done = 0; g_axCalX.num = 0; g_axCalX.den = 0; g_axCalX.n = 0; g_axCalX.px = 0;
                g_axCalY.done = 0; g_axCalY.num = 0; g_axCalY.den = 0; g_axCalY.n = 0; g_axCalY.px = 0;
            }
            /* ⛔ 指纹**每拍都刷新**（不在 changed 里）：否则第一次标定出的 lcOut*
               要等下一次别的环境变化才被记住，中途的映射变更就漏判了。 */
            g_fprScale = sc;
            if (ox != 0) { g_fprOutX = ox; g_fprOutY = oy; }
        }

        /* —— 闸门 / 复位事件日志（2026-10-14：状态转储 10s 一条太稀，事件即时落盘）—— */
        {
            static LONG s_prevPen = -1, s_prevGap = -1, s_prevJump = -1;
            LONG pd = g_penDown;
            if (s_prevPen != -1 && pd != s_prevPen)
                logf("# [gate] penDown %ld→%ld packets=%ld smoothed=%ld calls=%ld\n",
                     (long)s_prevPen, (long)pd, (long)g_packets, (long)g_smoothed, (long)g_calls);
            s_prevPen = pd;
            if (s_prevGap != -1 && g_rstGap != s_prevGap)
                logf("# [rst] +gap（取包间隔超时）lastGap=%ldms packets=%ld\n",
                     (long)g_lastGapMs, (long)g_packets);
            s_prevGap = g_rstGap;
            if (s_prevJump != -1 && g_rstJump != s_prevJump)
                logf("# [rst] +jump（位置跳变）lastGap=%ldms packets=%ld\n",
                     (long)g_lastGapMs, (long)g_packets);
            s_prevJump = g_rstJump;
        }

        /* —— 断流看门狗（2026-10-14 第七轮）——
           本轮真机形态：penDown 卡 1、packets 冻结数分钟、calls 一直涨、
           用户笔还在画（截图有新笔迹）⇒ PS 已切到非 Wintab 回退输入。
           ⛔ 与「停笔正常冻结」的判别：停笔=笔静止 ⇒ 光标（跟原始笔）也静止；
             penDown=1 + 包冻结 + **光标还在动** ⇒ 包流真断了。
           判定后置 g_streamDead（HUD 立即隐藏，避免拿旧位置误导）；包恢复自动清零并记
           中断时长。单包通路计数一并打出 —— 若断流期 WTPacket 还在进包，就证明
           PS 切到了消息驱动（我们只挂了批量通路），下一轮才有依据补挂。 */
        {
            static DWORD s_pkts, s_calls, s_dead0, s_deadLog, s_healAt;
            static POINT s_cur0;
            static int   s_have, s_heals;
            static LONG  s_movedTot;   /* 冻结期累计位移（自冻结起点，不做基线跟随） */
            DWORD nowW = GetTickCount();
            POINT c; GetCursorPos(&c);
            LONG pk = g_packets, cl = g_calls;
            if (!s_have) { s_pkts = pk; s_calls = cl; s_cur0 = c; s_have = 1; }
            if ((DWORD)pk != s_pkts) {                /* 有包：正常或从断流恢复 */
                if (g_streamDead) {
                    logf("# [dead] 恢复：包流恢复（断流约 %lu ms；期间单包通路 WTPacket 收包 %ld，"
                         "若 >0 ⇒ PS 断流期改走了消息驱动）\n",
                         (unsigned long)(nowW - s_dead0), (long)g_wtPkt1);
                    InterlockedExchange(&g_streamDead, 0);
                }
                s_pkts = pk; s_calls = cl; s_cur0 = c; s_dead0 = 0; s_heals = 0;
                s_movedTot = 0;
            } else if ((DWORD)cl != s_calls) {        /* 无包但 PS 在轮询 ⇒ 冻结期 */
                s_calls = cl;
                int moved = (c.x > s_cur0.x ? c.x - s_cur0.x : s_cur0.x - c.x)
                          + (c.y > s_cur0.y ? c.y - s_cur0.y : s_cur0.y - c.y);
                /* ⛔⛔ 门限是**物理像素**（GetCursorPos 在 PM-aware 进程里给物理值）
                   ⇒ 150% 屏上 6 物理 px 只等于 4 逻辑 px、200% 上只有 3 ⇒ 高分屏会
                   把「手抖 / 极缓慢的停顿」误判成断流（2026-10-15：4K 机 HUD 恒不显示
                   的加重项）。按 DPI 归一，回到「逻辑像素」的门限语义。 */
                double dS = dpi_scale();
                int mvDead = (int)(8.0 * dS + 0.5);
                /* ⛔⛔ 2026-10-15（3440 机 jwwh-20812）：旧的「基线跟随」让**缓慢运笔**
                   的断流永远判不出来 —— 每个窗口位移一旦 ≥ 跟随门限就把基线挪走，
                   逐窗位移永远到不了 mvDead。真机：慢速画一整笔（累计几百 px）期间
                   一条 [dead] 都不打，HUD 拿着冻结偏移跟光标跑 —— 这就是「圆心与
                   受力点分离 28px」的直接来源（截图时间 15:42:13 正落在断流集内）。
                   ⇒ 冻结期改为**自冻结起点累计位移**，不做基线跟随；只有「光标真
                     静止」（单窗 <2px，= 停笔）才清零。停笔（不出包 + 光标不动）
                     永远不会误判；冻结期光标动 = PS 正在原始输入 = 平滑已经死了。 */
                s_movedTot += moved;
                if (!s_dead0) { s_dead0 = nowW; s_movedTot = 0; }
                else if (moved < 2) s_movedTot = 0;
                if (!g_streamDead) {
                    if (g_patched && g_penDown == 1 && s_movedTot >= mvDead
                        && nowW - s_dead0 > 600) {
                        InterlockedExchange(&g_streamDead, 1);
                        s_deadLog = nowW;
                        logf("# [dead] ★包流断供: penDown=1 包冻结 %lums 而光标仍移动(Δ累计%ldpx) "
                             "hCtx=0x%llX calls=%ld 单包=%ld open=%ld close=%ld "
                             "⇒ PS 已走非 Wintab 输入，平滑实质中断\n",
                             (unsigned long)(nowW - s_dead0), (long)s_movedTot,
                             (unsigned long long)(UINT_PTR)g_ctxNow, (long)cl,
                             (long)g_wtPkt1, (long)g_wtOpenN, (long)g_wtCloseN);
                    }
                } else if (nowW - s_deadLog >= 2000) {
                    s_deadLog = nowW;
                    /* ⛔ 诊断探针（2026-10-15）：非消费地探一下驱动队列。
                       peek=0 ⇒ 驱动根本没往该上下文排队（断流在驱动侧，插件无杠杆）；
                       peek>0 ⇒ 队列有货而 WTPacketsGet 恒返 0（另一类故障，
                       需查调用路径/上下文状态）。WTPacketsPeek 按规范不动队列，
                       且我们只 inline-hook 了 WTPacketsGet，此调用直达驱动。 */
                    UINT peekN = 0;
                    {
                        typedef UINT (*PFN_WTPeek)(HCTX, int, LPVOID);
                        static PFN_WTPeek s_pPk; static int s_pkTried;
                        if (!s_pkTried) {
                            s_pkTried = 1;
                            HMODULE hm2 = GetModuleHandleA("Wintab32.dll");
                            if (hm2) s_pPk = (PFN_WTPeek)(void*)GetProcAddress(hm2, "WTPacketsPeek");
                        }
                        if (s_pPk && g_ctxNow) {
                            BYTE peekBuf[64];
                            peekN = s_pPk(g_ctxNow, 1, peekBuf);
                        }
                    }
                    logf("# [dead] 持续中: 已冻结 %lums calls=%ld 单包=%ld peek=%u\n",
                         (unsigned long)(nowW - s_dead0), (long)cl, (long)g_wtPkt1, peekN);
                    /* —— 断流自愈（2026-10-14 第八轮）：真机实锤断流可达数分钟不恢复
                       （jwwh-11576 冻结 247s、jwwh-14480 冻结 4 分钟+直到关机）。
                       唯一进程内可用的杠杆 = WTEnable 翻转（禁用→重启该上下文的包投递），
                       期望驱动侧借此复位队列。冻结 >4s 起试，每 5s 一次，最多 12 次；
                       包恢复由上方 pk != s_pkts 分支自动检测并记中断时长。
                       ⛔ PS 正在用的上下文被禁用 ~40ms：断流期本来就没有包，无损失。 */
                    {
                        if (s_heals == 0) s_healAt = 0;
                        if (nowW - s_dead0 > 4000 && nowW >= s_healAt && s_heals < 12) {
                            s_healAt = nowW + 5000;
                            s_heals++;
                            HMODULE hm = GetModuleHandleA("Wintab32.dll");
                            typedef BOOL (*PFN_WTEnable)(HCTX, BOOL);
                            PFN_WTEnable pEn = hm ? (PFN_WTEnable)(void*)GetProcAddress(hm, "WTEnable") : NULL;
                            if (pEn && g_ctxNow) {
                                BOOL r1 = pEn(g_ctxNow, FALSE);
                                Sleep(40);
                                BOOL r2 = pEn(g_ctxNow, TRUE);
                                logf("# [dead] 自愈 #%d: WTEnable(hCtx=0x%llX, 0/1)=%d/%d（包恢复即生效）\n",
                                     s_heals, (unsigned long long)(UINT_PTR)g_ctxNow, r1, r2);
                            } else if (s_heals == 1) {
                                logf("# [dead] 自愈不可用: WTEnable %s\n",
                                     pEn ? "缺 hCtx" : "导出不存在");
                            }
                        }
                    }
                }
            } else {                                  /* 连轮询都停了：不能算断流 */
                s_calls = cl;
            }
        }

        /* —— 落笔锁存超时解除（2026-10-15）——
           ⛔ 真机形态（4K 机 jwwh-14316）：`g_penDown` 只在**来包时**更新
              （smooth_packets 里写；CONTACT_HOLD_MS 的抬笔衰减也要来包才判一次），
              包流一断它就永久卡在 1（实测卡 4 分 17 秒，旧会话 1000 秒）⇒
              ① 断流看门狗的 `penDown==1` 条件永远成立 ⇒ 判定再也不退出；
              ② 面板一直显示「改写中」，而实际上一个包都没改过。
           ⇒ 超时窗口取 TIME_GAP_RESET_MS（5000ms）：与「停笔不出包」的容忍窗口
              **同一个常量** —— 超过它本来就会在下一个包上触发 RST_GAP 起笔锚定，
              所以在这里解除锁存**不会**引入「圆忽然闪现」的回归。
           ⛔ 只清锁存与原因码，**不动 g_wasEnabled**：轨迹是否作废仍由 RST_GAP 裁决。 */
        {
            static int s_cleared;
            if (g_penDown && g_snMs) {
                DWORD ageP = (DWORD)(GetTickCount() - (DWORD)g_snMs);
                if (ageP > TIME_GAP_RESET_MS) {
                    InterlockedExchange(&g_penDown, 0);
                    InterlockedExchange(&g_contact, 0);
                    InterlockedExchange(&g_strokeGate, -1);
                    InterlockedExchange(&g_reason, RS_HOVER);
                    if (!s_cleared) {
                        s_cleared = 1;
                        logf("# [pen] ★落笔锁存超时解除：%lums 无任何包 ⇒ penDown 1→0"
                             "（断流期间不再伪装成「改写中」）\n", (unsigned long)ageP);
                    }
                }
            } else if (!g_penDown) {
                s_cleared = 0;
            }
        }

        if (!loggedDump && g_dumpWanted) {
            loggedDump = 1;
            logf("# ---- 标定失败：原始包字节（n×stride，共 %d 字节）----\n", g_dumpLen);
            for (int i = 0; i < g_dumpLen; i += 16) {
                char line[128];
                int n = sprintf(line, "#  +%04X  ", i);
                for (int j = 0; j < 16 && i + j < g_dumpLen; j++)
                    n += sprintf(line + n, "%02X ", g_dump[i + j]);
                n += sprintf(line + n, "\n");
                log_write(line, n);
            }
            logf("# ---- 结束（人工读出 offX/offY 后即可修正布局表）----\n");
        }

        if (g_cfg) {
            LONG seq = g_cfg[CFG_I_CMDSEQ];
            if (seq != lastSeq) {
                lastSeq = seq;
                LONG cmd = g_cfg[CFG_I_CMD];
                if (cmd == 2) { do_unhook(); InterlockedExchange(&g_state, 3); }
                else if (cmd == 1) {
                    if (!g_patched) do_install();
                    /* 重挂 = 顺带确保 HUD 渲染线程活着（幂等 + 探活，见 hud_start）。
                       ⛔ 2026-10-14：旧版只在 worker 启动时 hud_start 一次，线程若在
                       「已卸载」期间死掉，此后再重挂也不会重建它 —— 用户看到的就是
                       「平滑恢复了，HUD 就是不显示」。 */
                    hud_start();
                    /* 重挂 = 重新给一次标定机会（标定结果只认当期数据）。
                       ⛔ 旧版写 `valid ? 1 : 2`：从未标定过（valid=0）也被判成
                       **标定失败**（红色），而其实只是「还没拿到足够证据」。
                       ⛔ 旧版还无条件置 1 ⇒ 标定失败被洗成「生效中」。
                       现在如实回到 0（未标定），由 detour 拿到包后自己裁决成 1 或 2。 */
                    LONG st = g_calib.valid ? 1 : (g_entryPrehooked ? 4 : 0);
                    g_calib.tried = 0;
                    g_calib.attempts = 0;
                    g_calib.valid = 0;
                    InterlockedExchange(&g_state, st);
                }
                g_cfg[CFG_I_CMDACK] = seq;
            }
        }

        if (GetTickCount() - lastPublish >= 10000) {
            lastPublish = GetTickCount();
            /* rst=a/g/j = 起笔锚定 / 取包超时(假复位) / 位置跳变 的次数。
               ⛔ 「圆忽然闪现回光标、折线瞬间连到光标」= 一次复位，只有把三种原因
                  分开计数才能一眼看出是哪一种（gap 居多 ⇒ 停笔被误判成新的一笔）。
               calX/calY = 该轴是否已由**真实光标**标定（1）还是仍在用中性兜底（0）。
                  ⛔ 判符号只能看 calX/calY=1 时的 pxX/pxY：那才是测出来的真符号；
                     =0 时是兜底（不含方向信息），别当成结论。 */
            logf("# [status] state=%ld calls=%ld packets=%ld smoothed=%ld calib=%s dpi=%ld‰ "
                 "stride=%d offX=%d offY=%d axMax=%u pxX=%.4f pxY=%.4f calX=%ld calY=%ld "
                 "rst=%ld/%ld/%ld lastGap=%ldms ctxN=%ld last=0x%lX->0x%lX "
                 "dead=%ld pkt1=%ld open=%ld close=%ld\n",
                 (long)g_state, (long)g_calls, (long)g_packets, (long)g_smoothed,
                 g_calib.valid ? "OK" : "否", (long)g_dpiScaleMilli,
                 g_calib.stride, g_calib.offX, g_calib.offY,
                 g_calib.axisMax, px_x(), px_y(),
                 (long)g_axCalX.done, (long)g_axCalY.done,
                 (long)g_rstAnchor, (long)g_rstGap, (long)g_rstJump, (long)g_lastGapMs,
                 (long)g_hCtxChanges,
                 (unsigned long)(LONG_PTR)g_ctxLastFrom, (unsigned long)(LONG_PTR)g_ctxLastTo,
                 (long)g_streamDead, (long)g_wtPkt1, (long)g_wtOpenN, (long)g_wtCloseN);
            /* P3.5：与面板诊断条**同一份数据**的日志版 —— 面板来不及看时看这里。
               ⛔ reason 名字必须与 C#/TS 的原因码表逐项一致（见 RS_* 枚举）。 */
            logf("# [why] reason=%d(%s) gate/open=%ld close=%ld penDown=%ld toolOk=%ld "
                 "ctUnknown=%ld ctN=%d ctVal=%ld pxN=%ld/%ld（闸门为累计值；判抖动看两次读数的增量）\n",
                 (long)g_reason, rs_name(g_reason),
                 (long)g_gateOpen, (long)g_gateClose, (long)g_penDown, (long)g_toolOk,
                 (long)g_ctUnknown, g_ctN, (long)g_ctVal,
                 (long)g_axCalX.n, (long)g_axCalY.n);
            /* P3.6 落笔判据的**信号表**（多信号并联）—— 本轮排障的第一现场。
               ⛔ 判读（缺一不可）：
                 · 每个 `+off` 后面的 `*` = 该信号已取得投票权（同时见过 0 与非 0）。
                   一个 `*` 都没有 ⇒ 判据压根没建立，宽限之后会**阻断一切平滑**。
                 · 生效掩码：bit i = 第 i 个信号有投票权（十进制）。
                 · 本批命中：bit i = 第 i 个信号把闸门顶上去了（十进制；0 = 本批全零）。
                 · 连续全零 N 包：≈N×5ms。**这就是「闸门被压住多久」**——
                   运笔中 N 一大（>20）说明判据在真实绘制中成段失效（本轮要修的就是它）；
                   只有停笔/换工具时 N 才该变大。 */
            {
                char sbuf[192];
                int sn_ = sprintf(sbuf, "# [ct] 信号=");
                if (g_ctN <= 0) sn_ += sprintf(sbuf + sn_, "（无）");
                for (int i = 0; i < g_ctN && sn_ < 130; i++)
                    sn_ += sprintf(sbuf + sn_, "%s+%d%s", i ? " " : "",
                                   g_ctOff[i], (g_ctElig[i] == 1) ? "*" : "");
                long eligMask = 0;
                for (int i = 0; i < g_ctN; i++) if (g_ctElig[i] == 1) eligMask |= (1L << i);
                sn_ += sprintf(sbuf + sn_, "  生效=%ld 本批命中=%ld 连续全零=%ld 包\n",
                               eligMask, (long)g_ctMask, (long)g_ctZeroRun);
                log_write(sbuf, sn_);
            }
        }
    }

    do_unhook();
    hud_stop();
    if (g_log != INVALID_HANDLE_VALUE) { CloseHandle(g_log); g_log = INVALID_HANDLE_VALUE; }
    return 0;
}

/* ==========================================================================
 * HUD overlay —— 把「笔尖 ↔ 平滑输出点」这根绳画在屏幕上
 *
 * ⚠️ 形态说明（2026-10-12 用户明确决定走 overlay）：
 *    UXB/UXP 没有在 PS 画布上绘制的 API（这正是当初必须注入的原因 —— 连指针都拿不到），
 *    PS 原生的「画笔绳线」由它**自己**的画笔平滑绘制，而我们在 Wintab 层改写坐标、
 *    PS 的平滑状态是关的 ⇒ 它不会替我们画。所以只能自己画。
 *
 * ⛔ 但 detour 铁律**没有被违背**，这是本实现的关键约束：
 *    - detour 只多写 5 个普通内存字段（g_snRawX/… 见上），零系统调用，205Hz 路径不变；
 *    - 建窗 / 标定 / 绘制 / 消息循环全部在**独立的渲染线程**上，与取包线程无交集。
 *    真正被放松的只有「DLL 不碰 UI」这一条。
 *
 * 风险最小化（overlay 形态是安全软件的典型启发式特征，能收的都收）：
 *    - 窗口只有 256×256 且**跟随光标**，不是全屏顶层窗；
 *    - 空闲 250ms（抬笔）或闸门不成立即隐藏，不长期驻留；
 *    - WS_EX_NOACTIVATE + WS_EX_TRANSPARENT + WM_NCHITTEST→HTTRANSPARENT：
 *      不抢焦点、不吃鼠标事件、不进任务栏（WS_EX_TOOLWINDOW）；
 *    - 颜色/内容全部可关（CFG_I_HUD = 0 时窗口根本不出现）。
 *
 * ⛔ 卸载顺序：窗口过程在本模块内 ⇒ 必须先 join 渲染线程再 FreeLibrary，
 *    否则下一条消息就会跳进已卸载的代码。hud_stop() 由 worker 退出路径与
 *    jwwh_unhook 双重保障（幂等）。
 *
 * 坐标：不猜 Wintab 的输入/输出空间语义，改用**真实光标**标定 ——
 * 屏幕上看到的光标就是「平滑后的输出点」，于是
 *      轴→像素比 = |Δ光标| / |Δ输出轴|
 * 一次除法 + 低通即可，且天然跟随缩放 / 多屏 / 映射变化。
 *
 * ── 形态对齐 PS 原生「拉绳」（用户 2026-10-13 截图对比后的要求）────────────
 * 旧版把窗口钉在**光标**上、圆心也画在光标处 ⇒ 光标永远在圆心，看着「没有拉绳感觉」。
 * PS 原生是反过来的：
 *   ① 圆心 = **绘制点**（平滑输出点，即 PS 真正落笔的位置）；
 *   ② 光标 = **真实笔尖**，可以在圆内任意位置；
 *   ③ 两者之间有一根「似有弹力的画笔带」（有粗细、向笔尖收窄）；
 *   ④ 笔尖永远被约束在圆周内 —— 越界时圆心（绘制点）被拖着走。
 * ⇒ 现在窗口定位用「圆心」而非光标，圆心取**光标 + 绳偏移**（见 hud 段）。
 * ========================================================================*/
/* 窗口**初始**边长：必须容得下「圆心 ↔ 光标」的偏移 + 圆周半径。
   ⛔⛔ 2026-10-15：半径是**逻辑像素**，而窗口是**物理像素** ⇒ 边长必须随 DPI 放大，
      否则 150%/200% 屏上圆会被窗口裁掉（150% 时圆半径 150 物理 px > 旧 half 128）。
      运行时按 2×(RADIUS_PX_MAX·dpiScale + 24) 按需重建（见 hud_resize）。 */
#define HUD_SIZE     256
#define HUD_SIZE_MAX 1024      /* 兜底上限：200% 屏 + 半径 100 ⇒ 只需 448 */
#define HUD_IDLE_MS  250     /* 这么久没有新包 ⇒ 判定抬笔，隐藏 */
/* ⛔ 笔尖落纸面期间的**保活窗口**：数位板停笔时不再出包（实测 packets 会冻结很久），
   若只看 HUD_IDLE_MS，用户一停笔圆就消失、一动又在复位后的位置冒出来。
   只要闸门（工具对 + 笔尖接触）还成立，就再撑这么久。 */
#define HUD_HOLD_MS  3000
/* ⛔⛔ 2026-10-14：16 → 8ms（~60Hz → ~120Hz）。
   用户报「拖动稍快，圆心与受力点就分离」。间距的主要来源是**帧间隔**
   （HUD 是轮询渲染，笔画以包率前进，圆心最多滞后一帧）⇒ 帧间隔减半、
   滞后距离减半。⚠️ 降帧必须同时改等待方式才有意义：Sleep(N) 的粒度是
   系统时钟 tick（默认 15.6ms），Sleep(8) 实际仍睡 ~15.6ms ⇒ 必须用
   waitable timer（100ns due time，见 hud_frame_wait）。 */
#define HUD_FRAME_MS 8
#define HUD_CLASS    L"JWautofillWintabHUD"

static HANDLE        g_hudThread;
static DWORD        g_hudTid;
/* 绳身「已绷直」的渲染侧状态（滞回死区用；仅渲染线程读写）。
   g_ropeLowMs = 最近一次跌破「解除绷直阈值」的帧时刻（0 = 未在低位）。 */
static int          g_ropeTaut;
static DWORD        g_ropeLowMs;
static volatile LONG g_hudStop;
static volatile LONG g_hudRunning;

/**
 * 帧等待：可等待定时器（kernel32，**不需要**为 timeBeginPeriod 链 winmm）。
 *
 * ⛔ 为什么不能直接用 Sleep(HUD_FRAME_MS)：Sleep 的粒度是系统时钟 tick
 *    （默认 15.6ms）⇒ Sleep(8) 实际睡 ~15.6ms，把 HUD_FRAME_MS 从 16 调到 8
 *    完全无效。waitable timer 的 due time 是 100ns 单位，等待精度 ~1ms，
 *    120Hz 帧率才真正成立（见 HUD_FRAME_MS 注释）。
 *    定时器创建失败时退回 Sleep，功能不中断。
 */
static void hud_frame_wait(HANDLE timer)
{
    if (!timer) { Sleep(HUD_FRAME_MS); return; }
    LARGE_INTEGER due;
    due.QuadPart = -(LONGLONG)HUD_FRAME_MS * 10000;   /* 相对时间，100ns 单位 */
    if (SetWaitableTimer(timer, &due, 0, NULL, NULL, FALSE)) {
        WaitForSingleObject(timer, INFINITE);
    } else {
        Sleep(HUD_FRAME_MS);
    }
}

static LRESULT CALLBACK hud_wndproc(HWND h, UINT m, WPARAM w, LPARAM l)
{
    if (m == WM_NCHITTEST) return HTTRANSPARENT;    /* 穿透：绝不抢任何输入 */
    return DefWindowProcW(h, m, w, l);
}

/**
 * 按需重建 DIB 并改窗口边长（DPI 缩放变化 / 半径拉大时）。只**增大**，不缩回
 * （缩回会在跨屏移动时来回抖）。返回新的边长；失败沿用旧值（功能不中断）。
 */
static int hud_resize(HWND wnd, int need, HBITMAP* dib, HDC mem, int cur)
{
    if (!wnd || !mem || need <= cur) return cur;
    if (need > HUD_SIZE_MAX) need = HUD_SIZE_MAX;
    BITMAPINFO bi;
    memset(&bi, 0, sizeof(bi));
    bi.bmiHeader.biSize        = sizeof(bi.bmiHeader);
    bi.bmiHeader.biWidth       = need;
    bi.bmiHeader.biHeight      = -need;         /* 自上而下 */
    bi.bmiHeader.biPlanes      = 1;
    bi.bmiHeader.biBitCount    = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    HDC scr = GetDC(NULL);
    void* bits = NULL;
    HBITMAP nd = CreateDIBSection(scr, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
    ReleaseDC(NULL, scr);
    if (!nd) return cur;
    SelectObject(mem, nd);                      /* 先换入新的 */
    if (*dib) DeleteObject(*dib);               /* 再销毁旧的（此时已不在 DC 里） */
    *dib = nd;
    SetWindowPos(wnd, NULL, 0, 0, need, need,
                 SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    return need;
}

static DWORD WINAPI hud_thread(LPVOID param)
{
    (void)param;
    /* ⛔ 用 DLL 自身 HINSTANCE（DllMain 传进来的 g_hInst），不是宿主 exe 的。 */
    HINSTANCE inst = g_hInst ? g_hInst : GetModuleHandleW(NULL);
    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof(wc));
    wc.cbSize        = sizeof(wc);
    wc.lpfnWndProc   = hud_wndproc;
    wc.hInstance     = inst;
    wc.lpszClassName = HUD_CLASS;
    ATOM atom = RegisterClassExW(&wc);
    /* ⛔ ERROR_CLASS_ALREADY_EXISTS 必须放行：同一个 PS 进程里被注入两份本 DLL
       （守护进程重注入 / 两个实例）时，后到的这份注册必然失败，但类已经在那儿、
       窗口照样能建。旧版在这里当失败处理 ⇒ 二次注入后 HUD 永久消失。 */
    if (!atom && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        logf("# [hud] RegisterClassExW 失败 err=%lu ⇒ 本实例不建 HUD 窗口\n",
             (unsigned long)GetLastError());
    }

    HWND     wnd = NULL;
    HDC      mem = NULL;
    HBITMAP  dib = NULL;
    int      hudSize = HUD_SIZE;   /* 当前窗口/DIB 边长（随 DPI 按需放大，见 hud_resize） */

    if (atom || GetLastError() == ERROR_CLASS_ALREADY_EXISTS) {
        wnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT
                              | WS_EX_NOACTIVATE,
                              HUD_CLASS, L"", WS_POPUP,
                              0, 0, HUD_SIZE, HUD_SIZE, NULL, NULL, inst, NULL);
        if (!wnd) {
            logf("# [hud] CreateWindowExW 失败 err=%lu\n", (unsigned long)GetLastError());
        }
    }
    if (wnd) {
        SetLayeredWindowAttributes(wnd, RGB(0, 0, 0), 255, LWA_COLORKEY);
        BITMAPINFO bi;
        memset(&bi, 0, sizeof(bi));
        bi.bmiHeader.biSize        = sizeof(bi.bmiHeader);
        bi.bmiHeader.biWidth       = HUD_SIZE;
        bi.bmiHeader.biHeight      = -HUD_SIZE;      /* 自上而下 */
        bi.bmiHeader.biPlanes      = 1;
        bi.bmiHeader.biBitCount    = 32;
        bi.bmiHeader.biCompression = BI_RGB;
        HDC scr = GetDC(NULL);
        void* bits = NULL;
        dib = CreateDIBSection(scr, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
        mem = CreateCompatibleDC(scr);
        if (dib) SelectObject(mem, dib);
        ReleaseDC(NULL, scr);
    }

    /* 光标标定的上一次采样 */
    double lastCurX = 0, lastCurY = 0, lastAxX = 0, lastAxY = 0;
    int haveLast = 0;
    /* 「HUD 为什么没显示」的节流时间戳（见下方诊断日志）。 */
    DWORD lastHudWhy = 0;
    /* 帧定时器（一次性、自动复位）：见 hud_frame_wait。 */
    HANDLE frameTimer = CreateWaitableTimerW(NULL, FALSE, NULL);

    while (!g_hudStop) {
        MSG msg;
        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) break;
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (g_hudStop) break;

        /* 「有包流」判据：只要还在出包就算活跃（与 HUD 显隐无关）。
           ⛔ `(LONG)now − g_snMs` 的旧写法在 GetTickCount 超过 2^31（开机 ~24.8 天）
           时会变成负数 ⇒ (DWORD) 后是个巨大值 ⇒ HUD 永久不显示。一律用 DWORD 相减。 */
        DWORD now = GetTickCount();
        int active = 0;
        if (g_cfg && g_patched && g_calib.valid && g_cfg[CFG_I_ENABLED]) {
            if ((DWORD)(now - (DWORD)g_snMs) < HUD_IDLE_MS) active = 1;
        }

        /* ⛔⛔ 闸门闸门闸门：HUD 只在「工具是套索」且「笔尖确实接触画布」时出现。
           用户的原话是「使用别的工具，或者用户落笔前，我不希望……错误的 HUD 的干扰」。
           这两个判据由 detour 写入 g_toolOk / g_penDown —— 渲染线程只读它们，
           不重复判一次（判据写两遍，漂移一次就再也对不上）。 */
        int gateOk = (g_toolOk && g_penDown) ? 1 : 0;

        /* —— 一致快照 + 同刻光标（2026-10-14，用户报「拖动稍快，圆心与受力点分离」）——
           ⛔⛔ 快照的 4 个坐标字段由 detour 在**包线程**逐个写（热路径不加锁），
              本线程直接读可能拿到「新 rawX + 旧 outX」的撕裂组合；更隐蔽的是
              GetCursorPos 与快照读取之间隔着整个可见性判断 ⇒ 光标（新）与旧快照
              配对。两种混搭都会让 rx/ry 偏离真实偏移，圆心（= 光标 − 偏移）
              于是不再等于这一刻的受力点。
           ⇒ 策略：① 前后两遍读快照、按值全等才算一致视图（两个包数据完全相同时
              一致性天然成立）；② GetCursorPos 紧贴一致快照之后读，保证
              「偏移 ↔ 光标」同刻；③ 重试设上界，绝不自旋。 */
        LONG snRawX = g_snRawX, snRawY = g_snRawY, snOutX = g_snOutX, snOutY = g_snOutY;
        LONG snMs = g_snMs, snPrevMs = g_snPrevMs;
        LONG snPrevRawX = g_snPrevRawX, snPrevRawY = g_snPrevRawY;
        LONG snPrevOutX = g_snPrevOutX, snPrevOutY = g_snPrevOutY;
        for (int snapTry = 0; snapTry < 8; snapTry++) {
            LONG a0 = g_snRawX, a1 = g_snRawY, a2 = g_snOutX, a3 = g_snOutY;
            LONG a4 = g_snMs, a5 = g_snPrevMs, a6 = g_snPrevRawX, a7 = g_snPrevRawY;
            LONG a8 = g_snPrevOutX, a9 = g_snPrevOutY;
            LONG b0 = g_snRawX, b1 = g_snRawY, b2 = g_snOutX, b3 = g_snOutY;
            LONG b4 = g_snMs, b5 = g_snPrevMs, b6 = g_snPrevRawX, b7 = g_snPrevRawY;
            LONG b8 = g_snPrevOutX, b9 = g_snPrevOutY;
            if (a0 == b0 && a1 == b1 && a2 == b2 && a3 == b3
             && a4 == b4 && a5 == b5 && a6 == b6 && a7 == b7
             && a8 == b8 && a9 == b9) {
                snRawX = a0; snRawY = a1; snOutX = a2; snOutY = a3;
                snMs = a4; snPrevMs = a5; snPrevRawX = a6; snPrevRawY = a7;
                snPrevOutX = a8; snPrevOutY = a9;
                break;
            }
        }
        POINT cur;
        GetCursorPos(&cur);
        /* ⛔⛔ 标定分母必须用**原始轴**（不是输出轴）：
           系统光标由 Wintab 系统上下文（驱动侧）移动，跟随的是**原始笔**——
           我们改写的只是交给 PS 的那份副本，管不到系统光标。
           ⇒ Δ光标 = Δraw × pxPerAxis，分母取 Δraw 才能约出真值。
           ⛔ 旧版取 Δ输出轴：拉绳/低通的输出每包只走 k·Δraw（k 可低到 0.1），
              s = Δ光标/Δ输出 被**放大 1/k 倍**（≈10 倍）⇒ pxPerAxis 虚胖
              ⇒ 绳长/半径按错的单位换算，真实绳长只剩 drawn/10 ——
              正是「圆画得很大、实际拉绳没感觉」的根因之一。
           （旧版拉绳是「绷紧才动」，绷紧期 Δ输出≈Δ原始，标定侥幸正确；
             一旦输出滤波变强（追笔/低通），旧分母立刻失真。）
           ⚠️ 已撤回的**无效依据**：上一轮曾用一张 251×308 截图里「折线末端落后光标
              27px vs HUD 偏移 34px、其比≈Y 逐轴比」来反推 —— 用户已澄清那些截图
              只是**现象示意**、并非真实截图 ⇒ 该量化证据作废，不得再引用。
             本段结论的**真正**依据是：[calib] 日志给出 lcInExtX=44800 / lcInExtY=29600，
              两轴量程确实不同；且 CXO_SYSTEM 由驱动侧移动光标是 Wintab 的既定行为。 */
        /* ⛔⛔ 光标外推（2026-10-14，问题 2「受力点与选区末端有几像素漂移」）：
           快照里的 raw 是「最后一个包」的时刻，GetCursorPos 是**这一帧**的时刻；
           高速运笔时两者差出一个包-帧相位差 ⇒ 偏移差 v·Δt（500px/s、半帧 4ms
           就是 2px）。用前两个包估速度，把 raw **与 out 都**外推到当前帧时刻，
           「偏移 ↔ 光标」两端才真正同刻。限幅 40ms（超过视为停笔，不外推）。
           ⛔⛔ 2026-10-14 第五轮（问题 3「受力点和圆心依然会分离」）：**out 也必须外推**。
              几何恒等式是：光标(此刻) − offset(此刻) = 绘制点(此刻)。
              只外推 raw 的话，offset 里的 out 仍停在**包时刻**，圆心于是落在
              「out 的包时刻位置」上 —— 落后真实绘制点 v_out·Δt。
              真机实测：深色折线端点（真实绘制点）与圆心恒差 **15px**（100px 绳），
              而 15px 恰好 ≈ 0.0676(pxX) × 220(轴/帧差) —— 正是这个不对称。
              两端同刻之后圆心与受力点才严格重合。 */
        double axX = (double)snRawX, axY = (double)snRawY;
        double aoX = (double)snOutX, aoY = (double)snOutY;
        {
            LONG pktDt = snMs - snPrevMs;
            DWORD age = (DWORD)(now - (DWORD)snMs);
            if (pktDt >= 1 && age >= 1 && age <= 40) {
                double vX = ((double)snRawX - (double)snPrevRawX) / (double)pktDt;
                double vY = ((double)snRawY - (double)snPrevRawY) / (double)pktDt;
                axX += vX * (double)age;
                axY += vY * (double)age;
                /* out 的速度同样用前两个包估（包 pktDt 相同）⇒ 两端推进量一致。 */
                double uX = ((double)snOutX - (double)snPrevOutX) / (double)pktDt;
                double uY = ((double)snOutY - (double)snPrevOutY) / (double)pktDt;
                aoX += uX * (double)age;
                aoY += uY * (double)age;
            }
        }

        /* —— 诊断 v2：光标 ↔ 原始包坐标 **绝对值**成对记录（2026-10-15）——
           v1 只打差值 G：实测 G 随位置大幅游走（X ±400px / Y ±330px，hover 期 age=0
           也在走）⇒「固定倾斜缺口」理论被否，映射本身疑似**非对齐/非线性**（宽高比
           letterbox？原点偏移？）。⇒ 直接记录 (cur, raw) 绝对对，离线做逐轴线性回归
           screen = α + β·raw：β 偏离 lcOutExt 标称值多少、α 是多少、残差是否线性，
           一次把标定权威（lcOutExt vs 光标实测 −40% 旧悬案）裁决掉。
           ⛔ 采样条件：包新鲜(<2s) + 非断流（断流期光标走 raw 冻结会污染拟合）。 */
        {
            static DWORD s_lastGapLog;
            DWORD snAgeG = (DWORD)(now - (DWORD)g_snMs);
            if ((active || g_penDown) && !g_streamDead && snAgeG < 2000
                && now - s_lastGapLog >= 600) {
                s_lastGapLog = now;
                logf("# [gap] cur=(%ld,%ld) raw=(%.0f,%.0f) age=%lums pen=%ld\n",
                     cur.x, cur.y, axX, axY, (unsigned long)snAgeG, (long)g_penDown);
            }
        }

        /* —— 标定：**逐轴带符号**的 Δ光标 / Δ原始轴 ——
           ⛔ 必须独立于 HUD 显隐：旧版这段在 `!wantVisible` 的 continue 之后，
              于是关掉「拉绳提示」就再也不标定 ⇒ pxPerAxis 停在标称值 ⇒ 半径 / 绳长 /
              追笔速度全部按错的单位换算 ⇒ 参数怎么调都无感（真机可直接复现）。
           ⛔⛔ 必须逐轴（旧版用合成矢量的 |Δ| 比）：合成比把两个轴的符号与比例
              混成一个数 ⇒ ① **拿不到 Y 自己的符号**（符号只能靠猜，猜错就是圆心镜像）；
              ② 算不出两轴不同的比例（真机 X 0.0768 / Y 0.0486，差 1.58 倍）
              ⇒ 圆心位置与"绳长圆"在 Y 方向上都偏 1.58 倍。
           ✅ 这里的 s = Δ光标/Δraw **天然带符号** —— 这是符号的**唯一权威来源**，
              兜底（px_x/px_y）一律中性、不假设方向。 */
        if (active) {
            if (haveLast) {
                calib_axis(&g_axCalX, axX - lastAxX, (double)cur.x - lastCurX);
                calib_axis(&g_axCalY, axY - lastAxY, (double)cur.y - lastCurY);
            }
            lastCurX = cur.x; lastCurY = cur.y; lastAxX = axX; lastAxY = axY; haveLast = 1;
        } else {
            haveLast = 0;
        }

        /* 显隐：窗口存在 + 开了绳位（bit0）+ 有包流 + 标定已通过 + **闸门成立**
           + **当前是拉绳模式**。
           ⛔ 模式判据必须在这里也有一份（不能只靠面板隐藏那一行）：面板开关是
              「拉绳提示」的持久值，用户先在拉绳模式打开、再切到标准模式时它仍是 true。
              若原生侧不再判模式，标准模式下会冒出一个毫无意义的洋红圈 ——
              正是用户报「错误的 HUD 干扰」的形态之一。
           ⛔⛔ 笔尖落纸面期间**必须保持可见**：数位板在笔不动时**不再出包**
              （jwwh 日志实证：停笔后 packets 长时间冻结，而 PS 仍在空轮询），
              只用「最近的包」判活跃的话，用户一停笔圆就消失、再动一下又在**复位后的
              位置**冒出来 —— 观感就是「圆忽然闪现到光标上」。
              「笔还在画」的真正判据是**闸门**（工具对 + 笔尖接触画布）；包的时效
              只用来兜底「已经很久很久没有任何笔数据」（HUD_HOLD_MS）。
           ⚠️ 绳长/半径一律取 leash_px()，与滤波分支同一个函数（见其定义处）。 */
        LONG hf = g_cfg ? g_cfg[CFG_I_HUD] : 0;
        int ropeMode = (g_cfg && g_cfg[CFG_I_MODE] == 1) ? 1 : 0;
        DWORD pktAge = (DWORD)(now - (DWORD)g_snMs);
        /* ⛔ enabled 也必须判（第八轮补）：平滑关着时 out 快照冻结在旧值，
           HUD 会拿冻结快照画圈 —— 真机实锤「前十笔 HUD 显示但显示错误」。
           ⛔⛔ 断流态（2026-10-15，用户报「平滑失效时 HUD 显示的位置是错的」）：
              一律强制隐藏会走向另一个极端 —— 用户要 HUD 常显来观察状态。
              现改为**降级呈现**：dead && penDown==1 期间 HUD 保持可见，但圆心钉
              光标、不画绳、颜色改红（见下方绘制段）—— 断流期 PS 走原始输入，
              真实「绘制点」就是光标本身，这才是诚实几何。落笔锁存 5s 超时清
              penDown 后 HUD 收起，不会整段冻结期都挂着。 */
        int deadShow = (g_streamDead && g_penDown == 1) ? 1 : 0;
        int activeNow = deadShow
                     || (pktAge < HUD_IDLE_MS || (gateOk && pktAge < HUD_HOLD_MS));
        int wantVisible = (wnd && mem && activeNow && (deadShow || gateOk) && ropeMode
                           && (hf & 1) && g_cfg && g_cfg[CFG_I_ENABLED]) ? 1 : 0;
        if (!wantVisible) {
            if (wnd && IsWindowVisible(wnd)) ShowWindow(wnd, SW_HIDE);
            /* ⛔ 「HUD 没能显示」必须能一眼定位：把六个条件逐个打出来（节流 2 秒，
               并且只在功能开着时打，避免关着的时候刷屏）。
               判读：
                 wnd/mem=0      ⇒ 建窗或 DIB 失败（本实例根本没窗口）
                 active=0       ⇒ 钩子没挂（g_patched=0 ⇒ t 会一直涨）或久无包
                 gate=0         ⇒ toolOk/penDown 有 0：工具不对，或笔没落纸面，
                                  或落笔判据不可用（另见 contactUnknown）
                 rope=0         ⇒ 当前不是「拉绳」模式（HUD 只在拉绳模式出现）
                 hudBits 无 bit0 ⇒ 面板的「拉绳提示」是关的 */
            if (g_cfg && g_cfg[CFG_I_ENABLED] && (DWORD)(now - lastHudWhy) >= 2000) {
                lastHudWhy = now;
                logf("# [hud] 未显示: wnd=%d mem=%d active=%d(t=%lums) gate=%d"
                     "(toolOk=%ld penDown=%ld) rope=%d hudBits=%ld dead=%ld\n",
                     wnd ? 1 : 0, mem ? 1 : 0, activeNow, (unsigned long)pktAge, gateOk,
                     (long)g_toolOk, (long)g_penDown, ropeMode, (long)hf,
                     (long)g_streamDead);
            }
            hud_frame_wait(frameTimer);
            continue;
        }

        /* —— 绘制（对齐 PS 原生拉绳：圆心 = 绘制点，光标在圈内自由）——
           ⛔⛔ 关键几何（2026-10-13 定案）：**圆心必须钉在绘制点（输出点）上**，
              而不是钉在系统光标上。
             · 依据 1（硬事实）：Wintab 系统上下文（CXO_SYSTEM）由驱动侧移动光标，
               detour 只改写交给 PS 的那份副本 ⇒ GetCursorPos() 是**原始笔尖**，
               ≠ 我们输出的绘制点。若把 HUD 钉在光标上，圆心就不再是轨迹末端。
             · 依据 2（用户明确的真实需求）：「圆心应该渲染在目前生成的轨迹的末端」。
             · 绘制点的屏幕位置 = 光标 − Σ每轴[(raw−out)·px]；
               绳带从圆心指向 +offset —— 恰好落在系统光标（= 原始笔尖）上。
           ⚠️ 已撤回的**无效依据**：上一轮我曾用一张 251×308 截图里
              「折线末端落后光标 27px vs HUD 偏移 34px」反推逐轴比 —— 但用户澄清
              那些截图只是**现象示意**、并非真实截图 ⇒ 该量化结论作废，不得再引用。
             逐轴换算的**真正**依据是 [calib] 日志的 lcInExtX/lcInExtY（见 px_x/px_y 注释）。
           ⛔ 偏移逐轴换算；**符号不在此处假设**，由 calib_axis() 实测（见 px_y 注释）。 */
        /* ⛔ 偏移用**两端都外推**后的坐标（axX/axY 与 aoX/aoY，见上）：
           选区末端（输出点）与光标必须**同刻**比较，否则高速运笔时受力点看着差几像素。
           ⛔⛔ 只外推 raw 是上一轮的真 bug：圆心会落在 out 的**包时刻**位置，
              真机实测与真实绘制点恒差 15px（100px 绳）。
           偏移逐轴换算；**符号不在此处假设**，由驱动 lcOutExt（或 calib_axis 实测）给出。 */
        int rx = (int)((axX - aoX) * px_x());
        int ry = (int)((axY - aoY) * px_y());
        LONG c  = g_cfg[CFG_I_HUDCOLOR];
        COLORREF col = RGB((c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF);
        /* ⛔⛔ 断流态（2026-10-15）：偏移快照已冻结且与光标脱钩（引擎没在改写，
           PS 画的就是光标）⇒ 此刻真实「绘制点」= 光标本身：圆心钉光标（rx=ry=0）、
           绳不画、颜色改红。这不是权宜 —— 是断流期唯一诚实的几何；
           旧观感「圆心与受力点分离 28px 且跟着光标跑」正是拿冻结偏移画假圆。 */
        if (deadShow) { rx = 0; ry = 0; col = RGB(0xD8, 0x30, 0x30); }

        int rpx = g_cfg[CFG_I_RADIUSPX]; if (rpx < 1) rpx = 1;
        if (rpx > RADIUS_PX_MAX) rpx = RADIUS_PX_MAX;
        /* ⛔⛔ DPI 归一（2026-10-15）：面板的「半径」是**逻辑像素**，而窗口边长与
           圆周半径都是**物理像素** ⇒ 两边都要乘 dpiS，否则高分屏上圆被窗口裁掉、
           且「画的圈」比真实约束小（150% 下小 33%）。 */
        double dpiS = dpi_scale();
        hudSize = hud_resize(wnd, 2 * ((int)((double)RADIUS_PX_MAX * dpiS) + 24),
                             &dib, mem, hudSize);
        /* 圆周半径 = 真实绳长（= 半径，张力已删除）⇒ 圈与约束永远一致。
           与滤波分支同源：那边 radiusPxF 同样乘了 dpiS。
           ⚠️ 模式判据在上面 wantVisible 处已经用过一次（ropeMode）；这里不再取一次，
              取了也只是个未使用变量。 */
        int leashPx = (int)(leash_px(rpx) * dpiS + 0.5);
        if (leashPx < 2) leashPx = 2;

        int half = hudSize / 2;
        RECT rc = { 0, 0, hudSize, hudSize };
        FillRect(mem, &rc, (HBRUSH)GetStockObject(BLACK_BRUSH));

        HPEN pen = CreatePen(PS_SOLID, 1, col);
        HPEN old = (HPEN)SelectObject(mem, pen);
        if ((hf & 2) && !deadShow) {      /* 绳长圆：光标（原始笔）的活动范围 */
            HBRUSH nb = (HBRUSH)GetStockObject(NULL_BRUSH);
            HBRUSH ob = (HBRUSH)SelectObject(mem, nb);
            Ellipse(mem, half - leashPx, half - leashPx, half + leashPx, half + leashPx);
            SelectObject(mem, ob);
        }
        if ((hf & 1) && !deadShow) {
            /* 「绳」：从圆心（绘制点）连到光标（原始笔尖）。
               ⛔ 断流态不画绳（2026-10-15）：绳的两端语义是「绘制点↔原始笔」，
                  断流期绘制点 = 光标 ⇒ 绳长恒 0，画出来只会是一团噪点。
               ⛔ 旧版画成 4→1px 的**锥形直线**，用户明确否掉：「一头粗一头细，始终是
                  直线，没有一种绳子的感觉」。PS 的参照行为是：
                    · 光标在圈内 ⇒ 绳是**松弛的曲线**；
                    · 光标到圈上 ⇒ 绳**被拉直** —— 这个「由松到直」的过程正是
                      「描边末端被绳子牵着前进」的手感来源。
               ⇒ 统一细线 + 二次贝塞尔。垂度取**小垂度悬链线**：
                   sag = sqrt(3·(L−d)·d / 8)，L = 绳长(= 圆周半径)、d = 两端距离。
                   d → L 时 sag → 0 ⇒ 自然拉直，不需要写特判分支。
                   d 很小时 sag 也 → 0（绳没有长度可言），同样无需特判。
               ⛔ 2026-10-14：2px → **1px**（用户原话「悬链线不稳定，拖动时会产生
                  鬼畜的抽动，请把悬链线改成1px」）。除线宽减半外，帧间一致性
                  改造（一致快照 + 120Hz 帧）同时压掉了 d 的帧间抖动 ——
                   sag 对 d 的敏感度在绷紧附近极高，d 抖一下绳身就抽一下。 */
            const int NSEG = 24;
            double vx = (double)rx, vy = (double)ry;
            double vlen = dsqrt_(vx * vx + vy * vy);
            /* ⛔⛔ 绷直判据必须带**滞回死区**（2026-10-14，用户报的「绳在绷直与
               轻微弯曲之间跳变」；本轮复现为「绷直态偶尔闪弯」）。两道防线：
               ① 阈值改**相对值**：用户半径已拉到 100px，旧的固定 6px 只有 6%，
                  比例噪声 ±2% 就能穿越；改为「掉到 85% 绳长以下才解除绷直」。
               ② 时间滞回：解除绷直需持续低于阈值 90ms —— 单帧的方向反转
                  （拐角处 raw 朝圆心回摆是物理事实）不再点亮悬链。
               ⛔ 只改**渲染**，不改平滑语义（平滑侧的定长约束不动）。 */
            if (vlen >= (double)leashPx - 2.0) { g_ropeTaut = 1; g_ropeLowMs = 0; }
            else if (vlen < (double)leashPx * 0.85) {
                if (g_ropeLowMs == 0) g_ropeLowMs = now;
                else if (now - g_ropeLowMs >= 90) g_ropeTaut = 0;
            } else {
                g_ropeLowMs = 0;
            }
            double sag = 0.0;
            if (!g_ropeTaut && vlen > 0.5 && vlen < (double)leashPx) {
                double slackLen = (double)leashPx - vlen;
                sag = dsqrt_(3.0 * slackLen * vlen / 8.0);
            }
            /* 控制点 = 中点 + 2·sag·n（二次贝塞尔在 t=0.5 处的偏移是控制点偏移的一半）。 */
            double mx = (double)half + vx * 0.5, my = (double)half + vy * 0.5;
            double cqx = mx, cqy = my;
            if (sag > 0.5) {
                double nx = -vy, ny = vx;                       /* 垂直于「圆心→光标」 */
                double nl = dsqrt_(nx * nx + ny * ny);
                if (nl > 0.001) {
                    nx /= nl; ny /= nl;
                    /* 一律朝屏幕下方弓（模拟绳的自重）；绳恰好水平时取右侧。
                       ⚠️ 不按运动方向定弯曲侧：停笔时方向未定义，会导致绳突然翻面。 */
                    if (ny < 0.0) { nx = -nx; ny = -ny; }
                    else if (ny < 1e-9 && nx < 0.0) { nx = -nx; ny = -ny; }
                    cqx = mx + nx * (2.0 * sag);
                    cqy = my + ny * (2.0 * sag);
                }
            }
            HPEN sp = CreatePen(PS_SOLID, 1, col);
            HPEN so = (HPEN)SelectObject(mem, sp);
            int pvx = half, pvy = half;
            for (int i = 1; i <= NSEG; i++) {
                double t = (double)i / (double)NSEG, u = 1.0 - t;
                double bx = u * u * (double)half + 2.0 * u * t * cqx + t * t * ((double)half + vx);
                double by = u * u * (double)half + 2.0 * u * t * cqy + t * t * ((double)half + vy);
                int xi = (int)(bx + 0.5), yi = (int)(by + 0.5);
                MoveToEx(mem, pvx, pvy, NULL);
                LineTo(mem, xi, yi);
                pvx = xi; pvy = yi;
            }
            SelectObject(mem, so);
            DeleteObject(sp);
        }
        if (hf & 4) {                     /* 笔尖点：落在**受力点**（= 窗口中心 = 圆心）上 */
            /* ⛔⛔ 2026-10-14 移位（用户约定术语）：【施力点】= 套索光标所在端点，
               【受力点】= 选区末端点，且「受力点与圆心必须始终重合」。
               旧版把洋红点画在 half+rx/ry（= 光标 = 施力点），与上述约定相反；
               窗口本身钉在「绘制点」上（见下方 SetWindowPos），窗口中心 half
               正是受力点 ⇒ 点画在 half 即同时满足「在受力点」「与圆心重合」。 */
            int r = 3;
            HBRUSH fb = CreateSolidBrush(col);
            HBRUSH ob = (HBRUSH)SelectObject(mem, fb);
            Ellipse(mem, half - r, half - r, half + r, half + r);
            SelectObject(mem, ob);
            DeleteObject(fb);
        }
        SelectObject(mem, old);
        DeleteObject(pen);

        /* 窗口钉在**绘制点**（= 光标 − 绳偏移），不是钉在光标上：
           圆心 = 绘制点（描边画在这里），绳带末端 +offset 恰好压在系统光标上。
           ⛔ 旧版钉在 GetCursorPos()（= 原始笔尖）等于把两者的角色搞反 ——
              真机表现「光标钉在圆心、洋红点向外延伸到圆周又弹回圆心」即由此来。 */
        SetWindowPos(wnd, HWND_TOPMOST, cur.x - rx - half, cur.y - ry - half, 0, 0,
                     SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        HDC dc = GetDC(wnd);
        if (dc) { BitBlt(dc, 0, 0, hudSize, hudSize, mem, 0, 0, SRCCOPY); ReleaseDC(wnd, dc); }

        hud_frame_wait(frameTimer);
    }

    if (frameTimer) { CloseHandle(frameTimer); frameTimer = NULL; }
    if (wnd) { DestroyWindow(wnd); wnd = NULL; }
    if (mem) { DeleteDC(mem); mem = NULL; }
    if (dib) { DeleteObject(dib); dib = NULL; }
    UnregisterClassW(HUD_CLASS, inst);
    InterlockedExchange(&g_hudRunning, 0);
    return 0;
}

/**
 * 启动渲染线程（幂等 + **活性检查**）。只由 worker 调 —— ⛔ 不能从 DllMain 建窗（loader lock）。
 *
 * ⛔⛔ 2026-10-14（用户报「有时只能恢复平滑功能，HUD 不能恢复显示」）：
 *    旧版只判 `g_hudThread` 非空即返回。可线程若已死（建窗异常退出、被外部终止），
 *    句柄仍然非空 ⇒ hud_start 永远不再重建 ⇒ 平滑恢复了而 HUD 永久消失。
 *    现在用 GetExitCodeThread 探活：已死的句柄先 CloseHandle 回收再重建。
 *    ⚠️ STILL_ACTIVE = 259：退出码恰好等于 259 的「正常退出」会被误判成存活 —— 可接受，
 *       渲染线程只可能返回 0，且误判的后果仅是一次不重建（与旧版相同）。
 */
static void hud_start(void)
{
    if (g_hudThread) {
        DWORD code = 0;
        if (GetExitCodeThread(g_hudThread, &code) && code == STILL_ACTIVE) return;
        CloseHandle(g_hudThread);          /* 已死：回收句柄后再建 */
        g_hudThread = NULL;
        g_hudTid = 0;
    }
    InterlockedExchange(&g_hudStop, 0);
    InterlockedExchange(&g_hudRunning, 1);
    g_hudThread = CreateThread(NULL, 0, hud_thread, NULL, 0, &g_hudTid);
}

/** 停止并 join 渲染线程（幂等）。⛔ 必须在 FreeLibrary 之前完成。 */
static void hud_stop(void)
{
    if (!g_hudThread) return;
    InterlockedExchange(&g_hudStop, 1);
    if (g_hudTid) PostThreadMessageW(g_hudTid, WM_QUIT, 0, 0);   /* 尽力唤醒，失败就等 16ms 轮询 */
    WaitForSingleObject(g_hudThread, 3000);
    CloseHandle(g_hudThread);
    g_hudThread = NULL;
    g_hudTid = 0;
    InterlockedExchange(&g_hudStop, 0);
}

/* ================================================================== 导出 */
__declspec(dllexport) int jwwh_version(void) { return 0x0105; }

/* 兜底还原入口：守护进程的正常路径是经共享内存下令（worker 执行），
   此导出供外部工具（脚本/排障）在不需要共享内存时直接远程调用。 */
__declspec(dllexport) int jwwh_unhook(void)
{
    InterlockedExchange(&g_stop, 1);
    if (g_thread) { WaitForSingleObject(g_thread, 5000); CloseHandle(g_thread); g_thread = NULL; }
    /* worker 退出路径里已经 hud_stop() 过；这里再兜一次（worker 没起来过的场景）。
       ⛔ 必须在 do_unhook / 本函数返回之前完成 —— 渲染线程持有窗口过程，
          它活着的时候绝不能让本模块被卸载。 */
    hud_stop();
    do_unhook();
    cfg_close();
    if (g_log != INVALID_HANDLE_VALUE) { CloseHandle(g_log); g_log = INVALID_HANDLE_VALUE; }
    return (int)g_patched;
}

static void start_worker(HINSTANCE h)
{
    if (g_thread) return;
    g_thread = CreateThread(NULL, 0, worker, (LPVOID)h, 0, NULL);
}

/* M2（.8li 进程内形态）：本文件被直接编进 JWautofillSmooth.8li，与 plugin_main.c
   同镜。DllMain 归 plugin_main.c 所有 ⇒ 这里改名为 engine_dllmain，由它在
   DLL_PROCESS_ATTACH / DETACH 时原样转发（attach = start_worker，detach = 兜底
   repatch —— 语义与旧注入版逐字节一致）。 */
BOOL WINAPI engine_dllmain(HINSTANCE hinstDLL, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        g_hInst = hinstDLL;      /* HUD 注册窗口类用（见 g_hInst 声明处） */
        /* ⛔ 重活绝不放在 DllMain（loader lock）⇒ 只起线程立刻返回。 */
        start_worker(hinstDLL);
    } else if (reason == DLL_PROCESS_DETACH) {
        /* 兜底（幂等）：不冻结线程（进程正在退出，挂起别人可能卡死退出流程）。 */
        if (g_patched && g_entry) repatch(g_entry, g_orig);
    }
    return TRUE;
}
