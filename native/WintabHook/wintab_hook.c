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

/* LOGCONTEXT 头部（只需到 lcPktData 为止；wintab.h 里 lcName[40] + 5 个 UINT）。 */
typedef struct {
    char lcName[40];
    u32  lcOptions;
    u32  lcStatus;
    u32  lcLocks;
    u32  lcMsgBase;
    u32  lcPktRate;
    u32  lcPktData;      /* ← 偏移 60 */
} LOGCONTEXT_HEAD;

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
    CFG_I_RADIUSPCT,      /* 万分之一·axMax          最大滞后     */
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
};

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
    int   tried;         /* 1 = 已尝试过（无论成败），避免每包重算 */
} CALIB;

static CALIB g_calib;
static volatile LONG g_state = 0;          /* CFG_I_STATE 的镜像（供 worker 上报） */
static volatile LONG g_calls, g_packets, g_smoothed;

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
/* 与守护进程 LassoMouseSmoother（Mode 0 标准一阶低通）同源；此处为 C 版：
   - k 用**线性**映射（C# 用 0.18^t 的指数映射）—— MVP 阶段不引入 libm；
   - 不做 MinSampleDist 抽稀：Wintab 的包必须**原样写回**（抽掉会打乱 PS 的时间轴）。 */
static double g_ox, g_oy;        /* 输出位置（保留小数，避免慢速时「粘住不动」） */
static double g_speed;           /* 低通后的输入速度（归一到「屏幕等效像素/ms」） */
static double g_dirX, g_dirY;
static int    g_hasDir;
static DWORD  g_lastMs;
static int    g_wasEnabled;

#define JUMP_RESET_FRAC   0.15   /* 输出点与原始点距离 > 15%·axMax ⇒ 判定为抬笔移位 */
#define TIME_GAP_RESET_MS 120    /* 两次取包间隔 > 120ms ⇒ 判定为新的一笔 */
#define CORNER_COS        0.7071 /* 45° 的 cos：夹角超过 45° ⇒ 判为拐角，减弱平滑 */
#define SPEED_FULL        1.2    /* 屏幕等效像素/ms：达到即「甩笔」 */
#define RANGE_NOMINAL     32767.0

static double dsqrt_(double v) { return __builtin_sqrt(v); }

/* ------------------------------------------------------------- 掩码 → 偏移 */
/* 按 wintab.h 的固定字段顺序累加尺寸。pkContext 在 x64 上是 8 字节指针，
   但某些实现把它当 4 字节 —— 两种都算，靠序号扫描的观测值来裁决。 */
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
        int sz = (bits[i] == PK_CONTEXT) ? ctxSize : 4;
        if (bits[i] == PK_SERIAL_NUMBER) s = off;
        if (bits[i] == PK_X) x = off;
        if (bits[i] == PK_Y) y = off;
        off += sz;
    }
    *stride = off; *offSerial = s; *offX = x; *offY = y;
}

/* -------------------------------------------- 盲扫：找「逐包恰好 +1」的字段 */
/* `pkSerialNumber` 的性质：同一上下文内**逐包 +1**。据此可在完全不知道布局的前提下
   反解出 (stride, offSerial) —— 与掩码推算构成两条独立证据，交叉验证。 */
static int scan_serial(const u8* buf, int n, int* outStride, int* outOff)
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
            if (ok) { *outStride = S; *outOff = o; return 1; }
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

/* --------------------------------------------------------------- 尝试标定 */
/* ⛔ 只在**第一次**拿到 n>=2 的调用上做一次（有 WTGet + 扫描，不允许每包跑）。 */
static void try_calibrate(HCTX hCtx, void* buf, int n)
{
    g_calib.tried = 1;
    InterlockedIncrement(&g_calibTriedTotal);

    /* ① 掩码推算 */
    HMODULE hm = GetModuleHandleA("Wintab32.dll");
    PFN_WTGetA pGet = NULL;
    if (hm) {
        pGet = (PFN_WTGetA)(void*)GetProcAddress(hm, "WTGetA");
        if (!pGet) pGet = (PFN_WTGetA)(void*)GetProcAddress(hm, "WTGet");
    }
    u32 mask = 0;
    int haveMask = 0;
    if (pGet) {
        LOGCONTEXT_HEAD lc;
        memset(&lc, 0, sizeof(lc));
        if (pGet(hCtx, &lc) && lc.lcPktData && (lc.lcPktData & ~(u32)PK_ALL) == 0) {
            mask = lc.lcPktData;
            haveMask = 1;
        }
    }

    /* ② 序号盲扫 */
    int sStride = 0, sOff = -1;
    int haveScan = scan_serial((const u8*)buf, n, &sStride, &sOff);

    int stride = 0, offS = -1, offX = -1, offY = -1, variant = 0;
    int ok = 0;
    if (haveMask) {
        /* pkContext 尺寸两种假设都试（x64 指针 8 优先）：谁能让**真实数据**呈现
           「序号逐包 +1」，谁就是对的 —— 用数据裁决，而不是靠猜。 */
        int cand[2] = { 8, 4 };
        for (int v = 0; v < 2 && !ok; v++) {
            int st, os_, ox_, oy_;
            layout_of(mask, cand[v], &st, &os_, &ox_, &oy_);
            if (ox_ < 0 || oy_ < 0) continue;
            if (!verify_layout((const u8*)buf, n, st, os_)) continue;
            stride = st; offS = os_; offX = ox_; offY = oy_; variant = cand[v];
            ok = 1;
        }
    }
    /* 若有第三条独立证据（盲扫，n>=3 时才有），必须一致，否则判定失败 */
    if (ok && haveScan && !(stride == sStride && offS == sOff)) {
        calib_logf("# [calib] ⚠ 掩码推算 (stride=%d,off=%d) 与盲扫 (stride=%d,off=%d) 不一致 ⇒ 放弃\n",
                   stride, offS, sStride, sOff);
        ok = 0;
    }

    calib_logf("# [calib] hCtx=0x%llX  n=%d\n", (unsigned long long)(UINT_PTR)hCtx, n);
    calib_logf("# [calib] 掩码=%s mask=0x%04X  推算 stride=%d offSerial=%d offX=%d offY=%d (ctx=%d)\n",
               haveMask ? "有" : "无", mask, stride, offS, offX, offY, variant);
    calib_logf("# [calib] 盲扫=%s stride=%d offSerial=%d\n",
               haveScan ? "有" : "无", sStride, sOff);
    calib_logf("# [calib] 结论: %s\n",
               ok ? "★两条证据一致 ⇒ 启用改写" : "!! 不一致 ⇒ 只 dump、不改写（安全）");

    /* 坐标上界：用于位移门限 / 滞后上限 */
    u32 axMax = 0;
    if (hm) {
        PFN_WTInfoA pInfo = (PFN_WTInfoA)(void*)GetProcAddress(hm, "WTInfoA");
        if (pInfo) {
            AXIS_T ax;
            memset(&ax, 0, sizeof(ax));
            if (pInfo(WTI_DEVICES, DVC_X, &ax) && ax.axMax > 0) axMax = (u32)ax.axMax;
        }
    }
    if (!axMax) axMax = 32767;
    calib_logf("# [calib] X 轴上界 = %u\n", axMax);

    g_calib.hCtx = hCtx;
    g_calib.stride = ok ? stride : (haveScan ? sStride : 0);
    g_calib.offSerial = ok ? offS : sOff;
    g_calib.offX = ok ? offX : -1;
    g_calib.offY = ok ? offY : -1;
    g_calib.axisMax = axMax;
    g_calib.valid = ok;

    if (!ok) {
        /* 把原始字节留给 worker 落盘：手工一看就能定位 X/Y（下一版即可硬编码/修正） */
        int len = n * (haveScan ? sStride : 32);
        if (len > (int)sizeof(g_dump)) len = (int)sizeof(g_dump);
        if (len > 0) memcpy(g_dump, buf, len);
        g_dumpLen = len;
        InterlockedExchange(&g_dumpWanted, 1);
        InterlockedExchange(&g_state, 2);
    }
    /* ⛔ detour 内最后一步：把拼好的标定文本交给 worker 落盘（本函数全程零 I/O）。 */
    calib_publish();
}

/* ================================================================== 单包滤波 */
static void smooth_packets(HCTX hCtx, void* buf, int n, LONG strength, LONG flags, LONG radiusPct)
{
    /* ——— 标定（每个上下文一次；n>=2 即可做「序号逐包 +1」验证）——— */
    if (g_calib.hCtx != hCtx) {
        if (g_calib.hCtx != 0) InterlockedIncrement(&g_hCtxChanges);
        g_calib.hCtx = hCtx;
        g_calib.tried = 0;
        g_calib.valid = 0;
        g_calib.stride = 0;
        g_calib.offSerial = g_calib.offX = g_calib.offY = -1;
        g_wasEnabled = 0;                       /* 换上下文 ⇒ 轨迹状态作废 */
    }
    if (!g_calib.tried) {
        if (n >= 2) try_calibrate(hCtx, buf, n);
        else return;                            /* 等一个包数足够的调用再标定 */
    }
    if (!g_calib.valid || g_calib.offX < 0 || g_calib.offY < 0) return;

    const int S = g_calib.stride;
    const int ox_ = g_calib.offX, oy_ = g_calib.offY;
    if (S <= 0 || ox_ + 4 > S || oy_ + 4 > S) return;

    /* ——— 参数 ——— */
    double t = (double)strength; if (t < 0) t = 0; if (t > 100) t = 100;
    double k = 1.0 - 0.85 * (t / 100.0);        /* 0 ⇒ k=1（不平滑）；100 ⇒ k=0.15 */
    if (radiusPct < 1) radiusPct = 1;
    const double radius = (double)g_calib.axisMax * 0.0001 * (double)radiusPct;
    const double jumpLimit = (double)g_calib.axisMax * JUMP_RESET_FRAC;
    const double toScreen = RANGE_NOMINAL / (double)g_calib.axisMax;

    DWORD now = GetTickCount();
    const int speedAdaptive = (flags & 1) ? 1 : 0;

    for (int i = 0; i < n; i++) {
        u8* p = (u8*)buf + (SIZE_T)i * S;
        u32 rawX, rawY;
        memcpy(&rawX, p + ox_, 4);
        memcpy(&rawY, p + oy_, 4);
        double x = (double)rawX, y = (double)rawY;

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
            continue;
        }

        double dt = (double)(now - g_lastMs); if (dt < 1.0) dt = 1.0; else if (dt > 100.0) dt = 100.0;
        g_lastMs = now;

        /* 速度低通（归一到「屏幕等效像素/ms」） */
        g_speed = g_speed * 0.72 + (dist * toScreen / dt) * 0.28;

        /* 拐角守卫：与上一段输入方向的夹角超过 45° ⇒ 本帧减弱平滑，保住尖角 */
        double kk = k;
        if (dist > 0.01) {
            double ux = dx / dist, uy = dy / dist;
            if (g_hasDir) {
                double dot = ux * g_dirX + uy * g_dirY;
                if (dot > 1.0) dot = 1.0; else if (dot < -1.0) dot = -1.0;
                if (dot < CORNER_COS) kk = kk > 0.75 ? kk : 0.75;
            }
            g_dirX = ux; g_dirY = uy; g_hasDir = 1;
        }
        if (speedAdaptive) {
            double boost = g_speed / SPEED_FULL;
            if (boost > 1.0) boost = 1.0;
            kk += (1.0 - kk) * boost * 0.5;
        }

        /* 一阶低通 */
        g_ox += dx * kk; g_oy += dy * kk;

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
    }
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
            if (cfg_open() && g_cfg) InterlockedExchange(&g_state, 1);
        }
        if (g_cfg) {
            LONG en = g_cfg[CFG_I_ENABLED];
            /* ⛔ 心跳防呆：守护进程若被强杀，共享内存仍被本 DLL 持有 ⇒ enabled 会一直
               留在 1。没有这一条，PS 里就会被一段「没人管」的平滑一直改着坐标。
               心跳按 GetTickCount（自开机起的毫秒，跨进程同源）判定，3 秒无更新即停手。 */
            if (en && (DWORD)(GetTickCount() - (DWORD)g_cfg[CFG_I_HEARTBEAT]) > 3000) en = 0;
            if (en) {
                if (g_state == 0) InterlockedExchange(&g_state, 1);
                smooth_packets((HCTX)a, (void*)c, r, g_cfg[CFG_I_STRENGTH],
                               g_cfg[CFG_I_FLAGS], g_cfg[CFG_I_RADIUSPCT]);
                InterlockedExchangeAdd(&g_smoothed, (LONG)r);
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
        sprintf(g_skip, "jmp 目标 0x%llX 不在本映像内", (unsigned long long)(UINT_PTR)g_impl);
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
    if (!prepare_hook()) { logf("# 挂载失败: %s\n", g_skip); return; }
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

    cfg_open();
    publish_status();
    do_install();

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
                    InterlockedExchange(&g_state, 1);
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
    if (g_log != INVALID_HANDLE_VALUE) { CloseHandle(g_log); g_log = INVALID_HANDLE_VALUE; }
    return 0;
}

/* ================================================================== 导出 */
__declspec(dllexport) int jwwh_version(void) { return 0x0100; }

/* 兜底还原入口：守护进程的正常路径是经共享内存下令（worker 执行），
   此导出供外部工具（脚本/排障）在不需要共享内存时直接远程调用。 */
__declspec(dllexport) int jwwh_unhook(void)
{
    InterlockedExchange(&g_stop, 1);
    if (g_thread) { WaitForSingleObject(g_thread, 5000); CloseHandle(g_thread); g_thread = NULL; }
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
        /* ⛔ 重活绝不放在 DllMain（loader lock）⇒ 只起线程立刻返回。 */
        start_worker(hinstDLL);
    } else if (reason == DLL_PROCESS_DETACH) {
        /* 兜底（幂等）：不冻结线程（进程正在退出，挂起别人可能卡死退出流程）。 */
        if (g_patched && g_entry) repatch(g_entry, g_orig);
    }
    return TRUE;
}
