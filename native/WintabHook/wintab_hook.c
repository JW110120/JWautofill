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

/* AXIS（WTInfo(WTI_DEVICES, DVC_X, &axis) 的返回体）：axMin/axMax/axUnits/axResolution */
typedef struct { int axMin; int axMax; u32 axUnits; u32 axResolution; } AXIS_T;

/* ================================================================= 共享内存配置
 * 守护进程 `MemoryMappedFile.CreateOrOpen("Local\\JWautofillWintabSmooth", ...)`
 * 与本 DLL 的 `OpenFileMappingW` 指向同一块。全部按 32 位有符号槽访问。 */
#define CFG_NAME      L"Local\\JWautofillWintabSmooth"
#define CFG_MAGIC     0x57414A57L      /* 'JWAW' */
#define CFG_NLONGS    32

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
    CFG_I_STATE,          /* 0=未挂 1=生效 2=标定失败 3=已卸载       */
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
    CFG_I_TENSION,        /* 0..100   拉绳松紧                     */
    CFG_I_CATCHUP,        /* 0..100   追笔速度                      */
    CFG_I_CORNER,         /* 0..90    拐角判定角度                  */
    CFG_I_RADIUSPX,       /* 1..40    最大滞后（屏幕等效像素）       */
    CFG_I_HUD,            /* bit0=leash 线 bit1=半径圆 bit2=原始点  */
    CFG_I_HUDCOLOR,       /* 0xRRGGBB，默认品红（与 PS 画笔绳线同色）*/
    CFG_I_PXPERAXIS,      /* ×1000：渲染线程用真实光标标定的轴→像素比 */
};

/* ⛔⛔ 这张槽位表是 C 与 C#（Program.cs 的 PenHook）**两处手写**的，错位不会报错、
   只会让参数静默失效（实测过的坑）。所以：① 用编译期断言守住「槽数不超映射」；
   ② 任何一侧增删槽，另一侧必须同步，且 C# 的 EnsureInit 里有运行时兜底校验。 */
typedef char cfg_slot_fit_check[(CFG_NLONGS >= CFG_I_PXPERAXIS + 1) ? 1 : -1];

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
    if (!g_cfgMap) return 0;
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

/* ================================================================== 标定状态 */
typedef struct {
    HCTX  hCtx;          /* 0 = 未标定 */
    int   stride;        /* 每包字节数 */
    int   offSerial;
    int   offX, offY;
    u32   axisMax;       /* 设备坐标上界（X 轴），用于位移门限与滞后上限 */
    int   valid;         /* 1 = 交叉验证通过，允许改写 */
    int   tried;         /* 1 = 已做过一次**证据充分**的裁决（n>=3），避免每包重算 */
    int   attempts;      /* 裁决次数上限用：连续失败若干次后才认命（state=2） */
} CALIB;

static CALIB g_calib;
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

/* 轴坐标 → 屏幕像素的比例。初值用标称值（32767 轴 ≈ 一屏宽），
   由 HUD 渲染线程拿**真实光标位移**持续标定后覆盖（见 hud 段）。 */
static double g_pxPerAxis = 1.0;
/** 是否已被光标标定过（标定后不再被标称初值覆盖）。 */
static volatile LONG g_pxCalibrated;
/** 主屏/虚拟屏宽度（px）：标称「轴→像素比」的分母来源，worker 启动时取一次。 */
static int g_screenW;

#define JUMP_RESET_FRAC   0.15   /* 输出点与原始点距离 > 15%·axMax ⇒ 判定为抬笔移位 */
#define TIME_GAP_RESET_MS 120    /* 两次取包间隔 > 120ms ⇒ 判定为新的一笔 */
#define SPEED_FULL        1.2    /* 屏幕等效像素/ms：达到即「甩笔」 */
#define CORNER_MIN_PX     3.0    /* 段长小于它的「拐角」一律当抖动，不削弱平滑 */
#define RANGE_NOMINAL     32767.0
/* τ(强度) 曲线的两个常数：τ = 8ms·(0.18^(−t/100) − 1)，
   即 ln(1/0.18) = 1.714798，与鼠标通路指数映射反解一致。 */
#define TAU_BASE_MS       8.0
#define TAU_LN            1.714798

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

/* 强度 → 时间常数（ms）。与鼠标通路在 125Hz 下的滞后严格等价：
   鼠标 k=0.18^(t/100)、dt=8ms ⇒ τ = 8·(0.18^(−t/100) − 1)。 */
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
static void layout_of(u32 mask, int ctxSize, int* stride, int* offSerial,
                      int* offX, int* offY)
{
    static const u32 bits[]  = { PK_CONTEXT, PK_STATUS, PK_TIME, PK_CHANGED,
                                 PK_SERIAL_NUMBER, PK_CURSOR, PK_BUTTONS,
                                 PK_X, PK_Y, PK_Z, PK_NORMAL_PRESSURE,
                                 PK_TANGENT_PRESSURE, PK_ORIENTATION, PK_ROTATION };
    int off = 0, s = -1, x = -1, y = -1;
    for (int i = 0; i < (int)(sizeof(bits) / sizeof(bits[0])); i++) {
        if (!(mask & bits[i])) continue;
        int sz = 4;
        if (bits[i] == PK_CONTEXT) sz = ctxSize;
        else if (bits[i] == PK_ORIENTATION || bits[i] == PK_ROTATION) sz = 12;
        if (bits[i] == PK_SERIAL_NUMBER) s = off;
        if (bits[i] == PK_X) x = off;
        if (bits[i] == PK_Y) y = off;
        off += sz;
    }
    *stride = off; *offSerial = s; *offX = x; *offY = y;
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
            int st, os_, ox_, oy_;
            layout_of(m, ctxSize, &st, &os_, &ox_, &oy_);
            if (ox_ < 0 || oy_ < 0) continue;
            if (st <= 0 || st >= LAY_MAX || os_ < 0 || os_ >= LAY_MAX) continue;
            int v = (ox_ << 8) | oy_;
            int cur = g_layXY[st][os_];
            if (cur == -2) g_layXY[st][os_] = v;
            else if (cur != v) g_layXY[st][os_] = -1;      /* 歧义 ⇒ 拒绝 */
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
            int st, os_, ox_, oy_;
            layout_of(m, ctxSize, &st, &os_, &ox_, &oy_);
            if (st != stride || os_ != offSerial || ox_ < 0 || oy_ < 0) continue;
            int dup = 0;
            for (int i = 0; i < np; i++) if (pairs[i][0] == ox_ && pairs[i][1] == oy_) { dup = 1; break; }
            if (!dup) { pairs[np][0] = ox_; pairs[np][1] = oy_; np++; }
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
        }
    }

    /* ② 序号盲扫（与掩码**完全独立**的证据：只看真实字节） */
    int sStride = 0, sOff = -1, sX = -1, sY = -1;
    int haveScan = scan_serial((const u8*)buf, n, &sStride, &sOff, &sX, &sY);

    /* ③ 掩码推算 + 真实数据校验（pkContext 尺寸两种假设，谁能让序号逐包 +1 谁对） */
    int mStride = 0, mOffS = -1, mOffX = -1, mOffY = -1, mVariant = 0;
    int okMask = 0;
    if (haveMask) {
        int cand[2] = { 8, 4 };
        for (int v = 0; v < 2 && !okMask; v++) {
            int st, os_, ox_, oy_;
            layout_of(mask, cand[v], &st, &os_, &ox_, &oy_);
            if (ox_ < 0 || oy_ < 0) continue;
            if (!verify_layout((const u8*)buf, n, st, os_)) continue;
            mStride = st; mOffS = os_; mOffX = ox_; mOffY = oy_; mVariant = cand[v];
            okMask = 1;
        }
    }

    /* ④ 裁决：掩码与盲扫**一致**才算双证据；不一致时以盲扫为准 ——
       ⛔ 不能反过来判失败。真机上驱动报的 lcPktData 是 0x00C8（连 PK_Y 都没有），
       而包是 52 字节；掩码是「请求」，盲扫是「事实」，事实优先。 */
    int stride = 0, offS = -1, offX = -1, offY = -1, src = 0, ok = 0;
    if (okMask && (!haveScan || (mStride == sStride && mOffS == sOff))) {
        stride = mStride; offS = mOffS; offX = mOffX; offY = mOffY; src = 1; ok = 1;
    } else if (haveScan) {
        int px, py;
        if (layout_infer_xy(sStride, sOff, &px, &py)) {
            stride = sStride; offS = sOff; offX = px; offY = py; src = 2; ok = 1;
        } else if (layout_pick_xy(sStride, sOff, (const u8*)buf, n, &px, &py)) {
            stride = sStride; offS = sOff; offX = px; offY = py; src = 3; ok = 1;
        } else if (okMask) {
            calib_logf("# [calib] ⚠ 掩码 (stride=%d,off=%d) 与盲扫 (stride=%d,off=%d) 不一致，"
                       "且盲扫无法定出 X/Y ⇒ 等下一批\n", mStride, mOffS, sStride, sOff);
        }
    }

    calib_logf("# [calib] hCtx=0x%llX  n=%d\n", (unsigned long long)(UINT_PTR)hCtx, n);
    calib_logf("# [calib] 掩码=%s mask=0x%04X  推算 stride=%d offSerial=%d offX=%d offY=%d (ctx=%d)\n",
               haveMask ? "有" : "无", mask, mStride, mOffS, mOffX, mOffY, mVariant);
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

    /* 轴→像素比的**标称初值**：等渲染线程用真实光标标定出来之前先用它兜底。
       ⛔ 旧版用 32767/axisMax，在 axisMax 恰好也是 32767 时算出 **1.0**（即「包坐标
       就是像素」），而真实值约 1920/44800 ≈ 0.043 ⇒ 半径 8px 被算成 8 个轴单位
       ≈ 0.34 屏幕像素 ⇒ 滞后上限把平滑压成 0，「调参无感」的第二层根因。
       现在按「输入量程覆盖整屏」估算，量级至少是对的。
       ⚠️ 已被光标标定过就绝不覆盖（g_pxCalibrated 由渲染线程置位）。 */
    if (!g_pxCalibrated) {
        double ext = (double)(inExtX > 0 ? inExtX : (LONG)axMax);
        double scrW = (double)(g_screenW > 0 ? g_screenW : 1920);
        double nominal = scrW / (ext > 1.0 ? ext : 1.0);
        if (nominal > 0.0001 && nominal < 1000.0) g_pxPerAxis = nominal;
        calib_logf("# [calib] 标称 轴→像素 = %.6f（%d px / %ld 轴）\n",
                   g_pxPerAxis, g_screenW, (long)inExtX);
    }

    g_calib.hCtx = hCtx;
    g_calib.stride = ok ? stride : (haveScan ? sStride : 0);
    g_calib.offSerial = ok ? offS : sOff;
    g_calib.offX = ok ? offX : -1;
    g_calib.offY = ok ? offY : -1;
    g_calib.axisMax = axMax;
    g_calib.valid = ok;
    /* ⛔ 失败不立刻认命：盲扫要 n>=3，而真机前几批常常只有 2 个包。
       给 8 次机会，期间 state 保持 0（未标定），面板如实显示「等待标定」。 */
    if (ok) g_calib.tried = 1;
    else if (g_calib.attempts >= 8) {
        g_calib.tried = 1;
        InterlockedExchange(&g_state, 2);
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
 * 返回**本批里坐标真正被改写的包数**（复位帧原值写回、无差异帧都不算）。
 * ⛔ 早期版本把「处理过的包数」直接加进 g_smoothed ⇒ 面板显示「已平滑 17086 包」
 *    而实际一包都没改过（标定失败早退）—— 计数器必须只说改写，不能说处理。 */
static int smooth_packets(HCTX hCtx, void* buf, int n)
{
    /* ——— 标定（每个上下文一次；n>=2 即可做「序号逐包 +1」验证）——— */
    if (g_calib.hCtx != hCtx) {
        if (g_calib.hCtx != 0) InterlockedIncrement(&g_hCtxChanges);
        g_calib.hCtx = hCtx;
        g_calib.tried = 0;
        g_calib.attempts = 0;
        g_calib.valid = 0;
        g_calib.stride = 0;
        g_calib.offSerial = g_calib.offX = g_calib.offY = -1;
        g_wasEnabled = 0;                       /* 换上下文 ⇒ 轨迹状态作废 */
    }
    if (!g_calib.tried) {
        /* 盲扫「序号逐包 +1」要 n>=3 才不是巧合 ⇒ 证据不足就整批放过，等下一批。
           ⛔ 旧版 n>=2 就判一次且立刻置 tried=1：真机第一批往往正好 2 个包，
              盲扫被跳过、掩码又不可信 ⇒ 一次判死，此后永不重试（日志里整场只有
              一段 [calib] 就是这个原因）。 */
        if (n >= 3) try_calibrate(hCtx, buf, n);
        else return 0;
    }
    if (!g_calib.valid || g_calib.offX < 0 || g_calib.offY < 0) return 0;

    const int S = g_calib.stride;
    const int ox_ = g_calib.offX, oy_ = g_calib.offY;
    if (S <= 0 || ox_ + 4 > S || oy_ + 4 > S) return 0;

    /* ——— 参数（全部从共享内存现读，调用方保证 g_cfg 非空）——— */
    const int    mode   = g_cfg[CFG_I_MODE];
    const int    flags  = g_cfg[CFG_I_FLAGS];
    const double pxAxis = g_pxPerAxis > 0.0001 ? g_pxPerAxis
                                             : (RANGE_NOMINAL / (double)g_calib.axisMax);
    double t = (double)g_cfg[CFG_I_STRENGTH]; if (t < 0) t = 0; if (t > 100) t = 100;
    int radiusPx = g_cfg[CFG_I_RADIUSPX]; if (radiusPx < 1) radiusPx = 1;
    int tension  = g_cfg[CFG_I_TENSION];  if (tension  < 0) tension  = 0; if (tension  > 100) tension  = 100;
    int catchUp  = g_cfg[CFG_I_CATCHUP];  if (catchUp  < 0) catchUp  = 0; if (catchUp  > 100) catchUp  = 100;
    int cornerDeg = g_cfg[CFG_I_CORNER];  if (cornerDeg < 0) cornerDeg = 0; if (cornerDeg > 90) cornerDeg = 90;

    /* 像素 → 轴：面板上的「半径 / 绳长 / 追笔速度」都是屏幕像素，必须换算进来。
       pxAxis 由 HUD 线程用真实光标标定；标定前用标称值兜底。 */
    const double toAxis = 1.0 / pxAxis;
    const double radius = (double)radiusPx * toAxis;
    const double jumpLimit = (double)g_calib.axisMax * JUMP_RESET_FRAC;
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

        /* ——— 复位守卫（起笔锚定 / 抬笔重定位 / 开关刚打开）——— */
        double dx = x - g_ox, dy = y - g_oy;
        double dist = dsqrt_(dx * dx + dy * dy);
        int reset = 0;
        if (!g_wasEnabled) reset = 1;
        else if (now - g_lastMs > TIME_GAP_RESET_MS) reset = 1;
        else if (dist > jumpLimit) reset = 1;

        if (reset) {
            g_ox = x; g_oy = y;
            g_speed = 0; g_dirX = g_dirY = 0; g_hasDir = 0;
            g_lastMs = now;
            g_wasEnabled = 1;
            /* 复位帧也要把「原样」写回（值相同，统一路径便于核对） */
            u32 nx = (u32)g_ox, ny = (u32)g_oy;
            memcpy(p + ox_, &nx, 4); memcpy(p + oy_, &ny, 4);
            g_snRawX = (LONG)rawX; g_snRawY = (LONG)rawY;
            g_snOutX = (LONG)nx;   g_snOutY = (LONG)ny;
            g_snMs = (LONG)now;
            continue;
        }

        double dt = (double)(now - g_lastMs); if (dt < 1.0) dt = 1.0; else if (dt > 100.0) dt = 100.0;
        g_lastMs = now;

        /* 速度低通（归一到「屏幕等效像素/ms」） */
        g_speed = g_speed * 0.72 + (dist * pxAxis / dt) * 0.28;

        /* 拐角守卫：与上一段输入方向的夹角超过阈值 ⇒ 本帧减弱平滑，保住尖角。
           ⚠️ 只对「标准」模式生效 —— 拉绳/追笔的跟随机制本身不磨圆（拉绳甚至会主动
           把输出点按在绳长处，尖角由绳长决定），加拐角削弱反而破坏它们的手感。
           ⛔ 必须带**位移门限**：抖动的段长通常只有亚像素~2px，而 205Hz 下相邻两帧
           的夹角极易超过 45° ⇒ 不开门限的话「拐角」几乎每帧都成立 ⇒ k 被抬到 0.75
           ⇒ 平滑被关掉，只剩下滞后，观感正是「有延迟却不平滑」。 */
        int corner = 0;
        if (mode == 0 && dist > 0.01) {
            double ux = dx / dist, uy = dy / dist;
            if (g_hasDir && (dist * pxAxis) > CORNER_MIN_PX) {
                double dot = ux * g_dirX + uy * g_dirY;
                if (dot > 1.0) dot = 1.0; else if (dot < -1.0) dot = -1.0;
                if (dot < cornerCos) corner = 1;
            }
            g_dirX = ux; g_dirY = uy; g_hasDir = 1;
        } else if (dist > 0.01) {
            g_dirX = dx / dist; g_dirY = dy / dist; g_hasDir = 1;   /* 只更新方向，不判定 */
        }

        if (mode == 1) {
            /* ===== 拉绳：光标与输出点之间系一根绳，超过绳长就把输出点拖到绳长处 =====
               绳长 = 1 + (radiusPx−1)·(0.15 + 0.85·张力)，与鼠标通路同式。 */
            double ropePx = 1.0 + (double)(radiusPx - 1) * (0.15 + 0.85 * ((double)tension / 100.0));
            double rope = ropePx * toAxis;
            if (dist > rope && dist > 0.0001) {
                double f = rope / dist;
                g_ox += dx * f; g_oy += dy * f;
            } else {
                /* 绳未绷紧时仍做轻微跟随（纯拉绳在慢速下会完全停住，观感像卡死） */
                g_ox += dx * 0.25; g_oy += dy * 0.25;
            }
        } else if (mode == 2) {
            /* ===== 追笔：输出端以受限速度追赶光标，追上即贴合 =====
               ⛔ 量程必须落在**人的运笔速度区间**内：手绘约 0.05~1.5 px/ms
               （50~1500 px/s）。旧版 0.2~12.2 px/ms（最快 12200 px/s 比任何手都快）
               ⇒ 除最左端外 step 永远大于 dist ⇒ 恒走「贴合」分支 ⇒ 追笔滑杆整条无效。 */
            double vmax = 0.02 + ((double)catchUp / 100.0) * 1.5;   /* px/ms */
            double step = vmax * dt * toAxis;
            if (dist > step && dist > 0.0001) {
                double f = step / dist;
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
                /* 甩笔时自动减弱平滑：速度越高越贴手 */
                double boost = g_speed / SPEED_FULL;
                if (boost > 1.0) boost = 1.0;
                kk += (1.0 - kk) * boost * 0.5;
            }
            if (corner) { double kc = 0.75; if (kk < kc) kk = kc; }
            g_ox += dx * kk; g_oy += dy * kk;
        }

        /* 全局最大滞后上限：无论算法怎么算，输出与笔尖的距离不超过 radius */
        double lx = x - g_ox, ly = y - g_oy;
        double lag = dsqrt_(lx * lx + ly * ly);
        if (lag > radius && lag > 0.0001) {
            double f = (lag - radius) / lag;
            g_ox += lx * f; g_oy += ly * f;
        }

        u32 wx = (u32)(g_ox + 0.5), wy = (u32)(g_oy + 0.5);
        memcpy(p + ox_, &wx, 4);
        memcpy(p + oy_, &wy, 4);
        if (wx != rawX || wy != rawY) changed++;

        /* HUD 快照（普通内存写，detour 内零系统调用） */
        g_snRawX = (LONG)rawX; g_snRawY = (LONG)rawY;
        g_snOutX = (LONG)wx;   g_snOutY = (LONG)wy;
        g_snMs = (LONG)now;
    }
    return changed;
}

/* ================================================================== detour */
/* ⛔ 铁律：均摊 O(1)、零 I/O、零分配、不加锁、不抛异常。 */
static u64 det_WTPacketsGet(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    /* d/e/f 只为凑齐 ABI 参数位（转发桩是 `jmp`，不搬栈）：
       WTPacketsGet 只用到前三个，多出的声明不会被读取。 */
    (void)d; (void)e; (void)f;
    static int s_cfgTick;
    PFN_WTPacketsGet impl = (PFN_WTPacketsGet)g_impl;
    int r = impl((HCTX)a, (int)b, (void*)c);            /* 先取包，再加工 */
    InterlockedIncrement(&g_calls);

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
    else ok = commit_hook();
    thaw_threads();
    logf("# 挂载: %s  entry=0x%llX impl=0x%llX relay=0x%llX（改写期挂起线程 %d 个）\n",
         ok ? "OK" : g_skip, (unsigned long long)(UINT_PTR)g_entry,
         (unsigned long long)(UINT_PTR)g_impl, (unsigned long long)(UINT_PTR)g_relay, g_frzLast);
    if (g_cfg) g_cfg[CFG_I_FROZE] = g_frzLast;
}

static void do_unhook(void)
{
    if (!g_patched || !g_entry) return;
    freeze_threads();
    int ok = repatch(g_entry, g_orig);
    thaw_threads();
    if (ok) InterlockedExchange(&g_patched, 0);
    logf("# 卸载: %s（原字节 %02X %02X %02X %02X %02X 已写回）\n",
         ok ? "OK" : "失败", g_orig[0], g_orig[1], g_orig[2], g_orig[3], g_orig[4]);
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
    /* 轴→像素比（×1000）：1.0 表示包坐标本身就是屏幕像素；
       若远小于 1（如 0.0586 = 1920/32767）说明包坐标是数位板逻辑单位。 */
    double ppa = g_pxPerAxis;
    if (ppa < 0.0001) ppa = 0.0001;
    if (ppa > 1000.0) ppa = 1000.0;
    g_cfg[CFG_I_PXPERAXIS] = (LONG)(ppa * 1000.0);
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
       ⛔ 必须是**虚拟屏宽**：多屏时笔可以跨屏移动，SM_CXSCREEN 只有主屏。 */
    g_screenW = GetSystemMetrics(SM_CXVIRTUALSCREEN);
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
            logf("# [status] state=%ld calls=%ld packets=%ld smoothed=%ld calib=%s "
                 "stride=%d offX=%d offY=%d axMax=%u\n",
                 (long)g_state, (long)g_calls, (long)g_packets, (long)g_smoothed,
                 g_calib.valid ? "OK" : "否", g_calib.stride, g_calib.offX, g_calib.offY,
                 g_calib.axisMax);
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
 *    - 窗口只有 192×192 且**跟随光标**，不是全屏顶层窗；
 *    - 空闲 250ms（抬笔）即隐藏，不长期驻留；
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
 * ========================================================================*/
#define HUD_SIZE     192
#define HUD_IDLE_MS  250     /* 这么久没有新包 ⇒ 判定抬笔，隐藏 */
#define HUD_FRAME_MS 16      /* ~60Hz */
#define HUD_CLASS    L"JWautofillWintabHUD"

static HANDLE        g_hudThread;
static DWORD        g_hudTid;
static volatile LONG g_hudStop;
static volatile LONG g_hudRunning;

static LRESULT CALLBACK hud_wndproc(HWND h, UINT m, WPARAM w, LPARAM l)
{
    if (m == WM_NCHITTEST) return HTTRANSPARENT;    /* 穿透：绝不抢任何输入 */
    return DefWindowProcW(h, m, w, l);
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

        POINT cur;
        GetCursorPos(&cur);
        double axX = (double)g_snOutX, axY = (double)g_snOutY;

        /* —— 标定：|Δ光标| / |Δ输出轴| ——
           ⛔ 必须独立于 HUD 显隐：旧版这段在 `!wantVisible` 的 continue 之后，
              于是关掉「拉绳提示」就再也不标定 ⇒ pxPerAxis 停在标称值 ⇒ 半径 / 绳长 /
              追笔速度全部按错的单位换算 ⇒ 参数怎么调都无感（真机可直接复现）。 */
        if (active) {
            if (haveLast) {
                double dAx  = dsqrt_((axX - lastAxX) * (axX - lastAxX) + (axY - lastAxY) * (axY - lastAxY));
                double dCur = dsqrt_((double)(cur.x - lastCurX) * (cur.x - lastCurX)
                                   + (double)(cur.y - lastCurY) * (cur.y - lastCurY));
                if (dAx > 40.0 && dCur > 3.0) {
                    double s = dCur / dAx;
                    if (s > 0.01 && s < 100.0) {
                        g_pxPerAxis = g_pxPerAxis * 0.85 + s * 0.15;
                        InterlockedExchange(&g_pxCalibrated, 1);
                    }
                }
            }
            lastCurX = cur.x; lastCurY = cur.y; lastAxX = axX; lastAxY = axY; haveLast = 1;
        } else {
            haveLast = 0;
        }

        /* 显隐：窗口存在 + 开了绳位（bit0）+ 有包流 + 标定已通过 */
        LONG hf = g_cfg ? g_cfg[CFG_I_HUD] : 0;
        int wantVisible = (wnd && mem && active && (hf & 1)) ? 1 : 0;
        if (!wantVisible) {
            if (wnd && IsWindowVisible(wnd)) ShowWindow(wnd, SW_HIDE);
            Sleep(HUD_FRAME_MS);
            continue;
        }

        /* —— 绘制（窗口中心 = 光标 = 平滑输出点）—— */
        double pxAxis = g_pxPerAxis;
        int rx = (int)(((double)g_snRawX - axX) * pxAxis);
        int ry = (int)(((double)g_snRawY - axY) * pxAxis);
        LONG c  = g_cfg[CFG_I_HUDCOLOR];
        COLORREF col = RGB((c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF);

        int half = HUD_SIZE / 2;
        RECT rc = { 0, 0, HUD_SIZE, HUD_SIZE };
        FillRect(mem, &rc, (HBRUSH)GetStockObject(BLACK_BRUSH));

        HPEN pen = CreatePen(PS_SOLID, 1, col);
        HPEN old = (HPEN)SelectObject(mem, pen);
        if (hf & 2) {                     /* 半径圆：直观显示「最大滞后」有多大 */
            int rpx = g_cfg[CFG_I_RADIUSPX]; if (rpx < 1) rpx = 1;
            HBRUSH nb = (HBRUSH)GetStockObject(NULL_BRUSH);
            HBRUSH ob = (HBRUSH)SelectObject(mem, nb);
            Ellipse(mem, half - rpx, half - rpx, half + rpx, half + rpx);
            SelectObject(mem, ob);
        }
        if (hf & 1) {                     /* 绳：光标 ↔ 原始笔尖 */
            MoveToEx(mem, half, half, NULL);
            LineTo(mem, half + rx, half + ry);
        }
        if (hf & 4) {                     /* 原始笔尖点 */
            int r = 3;
            HBRUSH fb = CreateSolidBrush(col);
            HBRUSH ob = (HBRUSH)SelectObject(mem, fb);
            Ellipse(mem, half + rx - r, half + ry - r, half + rx + r, half + ry + r);
            SelectObject(mem, ob);
            DeleteObject(fb);
        }
        SelectObject(mem, old);
        DeleteObject(pen);

        SetWindowPos(wnd, HWND_TOPMOST, cur.x - half, cur.y - half, 0, 0,
                     SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        HDC dc = GetDC(wnd);
        if (dc) { BitBlt(dc, 0, 0, HUD_SIZE, HUD_SIZE, mem, 0, 0, SRCCOPY); ReleaseDC(wnd, dc); }

        Sleep(HUD_FRAME_MS);
    }

    if (wnd) { DestroyWindow(wnd); wnd = NULL; }
    if (mem) { DeleteDC(mem); mem = NULL; }
    if (dib) { DeleteObject(dib); dib = NULL; }
    UnregisterClassW(HUD_CLASS, inst);
    InterlockedExchange(&g_hudRunning, 0);
    return 0;
}

/** 启动渲染线程（幂等）。只由 worker 调 —— ⛔ 不能从 DllMain 建窗（loader lock）。 */
static void hud_start(void)
{
    if (g_hudThread) return;
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
__declspec(dllexport) int jwwh_version(void) { return 0x0100; }

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

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD reason, LPVOID reserved)
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
