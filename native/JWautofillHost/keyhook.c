/* JWautofill Host .8li — 键盘钩子/热键子系统（M3：HotkeyDaemon 进程内化）
 *
 * 背景（为什么把独立守护进程搬进 .8li）：
 *   旧形态 = native/HotkeyDaemon（约 65M 自包含 exe）+ FixKeyboard（约 76M），
 *   dist/native 合计 138M。WH_KEYBOARD_LL **不要求 DLL 注入**（hMod 被系统忽略），
 *   可以挂在任意带消息循环的线程上 ⇒ .8li（PS 启动即加载、已有 WS 服务器与
 *   看护线程）是同构宿主。迁移后 dist 体积降到 10M 内。
 *
 * 本文件逐字移植 Program.cs（ROLE=热键）的语义，面板契约不变：
 *   入站：setConfigPath / shutdown / uninstall / config / getConfig / getState /
 *         hotkeyArm / hotkeyStatus / recordStart / recordCancel / armDelete /
 *         disarmDelete
 *   出站：config（payload+path）/ state / hotkeyState / hotkey / recordCaptured /
 *         recordResult / recordCancel / backspaceDelete / bye
 *
 * ⛔⛔ 钩子回调铁律（LowLevelHooksTimeout 被放大时一次阻塞 = 全系统键盘冻结）：
 *   kh_proc 路径内每一步必须 O(1)、无锁（除「引用快照」级临界区）、无文件 I/O、
 *   不抛异常。所有网络写一律入出站队列，由调度线程代发；所有日志一律入内存环，
 *   由调度线程代打。超预算（100ms）连续 3 次即熔断纯放行，30s 冷却自愈。
 *
 * ⛔ 单持有者纪律（多 PS 实例）：只有 bind 18923 成功的实例才装键盘钩子
 *   （前台 PID ∈ photoshop 进程集合 的焦点闸门复刻 daemon 语义）。
 *   bind 失败 ⇒ 每 3s 重试；若探测到占用者是**旧版 daemon**（version
 *   2026-10-12.x），以 WS 客户端发 uninstall 令其自清自启+安装目录后退出，
 *   下一轮重试即可接管（升级部署的关键路径）。
 *
 * ⛔⛔ 0x0205 插件本体在位闸：.8li 随 PS 启动即装载，但 UXP 插件本体可能
 *   根本没加载（开发期没装/没启用是常态）⇒ 旧行为「启动即默认布防」会在
 *   无人消费广播的情况下吞掉用户按键（L、NUM1…全失灵）。现在三条键路
 *   （LL 钩子安装意图 / 键态轮询兜底 / RegisterHotKey 同步）统一要求
 *   g_khPlug：18923 上有客户端（面板进程活着）才装钩；最后一个客户端
 *   断开 ⇒ 卸钩 + 撤注册，按键全部放行（PS 原生快捷键恢复）。
 *   ⚠️ 不采用「连过一次就粘住」：面板卸载/崩溃后钩子必须熄火（0x013E 同族纪律）。
 *   ⚠️ 迁移探测连接（path=/jw-migrate）标记 notPlugin、不计入在位 —— 多开 PS 时
 *     非持有实例每 10s 探一次，误计入就会给持有端周期性地伪造在位。
 */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <tlhelp32.h>     /* toolhelp 进程枚举：前台 PS PID 集合 */
#include <shellapi.h>     /* ShellExecuteExW：键盘修复的设备层脚本提权唤起 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

#include "jw_shared.h"
#include "ws_core.h"

/* ================================================================ 常量 */

#define KH_PORT          18923
#define KH_VERSION       "2026-10-23.2"   /* 0x0206：空闲超时不再断连 + 客户端表槽位归还（getState 的 version 字段） */
#define KH_BUDGET_MS     100      /* 单次钩子回调耗时预算（Program.cs HookBudgetMs） */
#define KH_STRIKES       3        /* 连续超预算多少次才熔断 */
#define KH_COOLDOWN_MS   30000    /* 熔断冷却（期满复位重挂） */
#define KH_MAX_CLI       8
#define KH_MAX_ITEMS     256
#define KH_COMBO_MAX     64
#define KH_HITQ          64
#define KH_OUTQ          64
#define KH_OUTMSG        384
#define KH_HLOG_N        32
#define KH_HLOG_L        192
#define KH_PSPID_MAX     256

/* 线程消息（与 daemon 同号；安装/卸载另有 100ms 轮询兜底，消息只降延迟） */
#define WM_KH_RECSTART   0x8002
#define WM_KH_RECSTOP    0x8003
#define WM_KH_INSTALL    0x8005
#define WM_KH_UNINSTALL  0x8008

/* ================================================================ 数据结构 */

typedef struct {
    char id[48];
    char combo[KH_COMBO_MAX];
    char action[48];
    char brush[192];
} KhItem;

typedef struct {
    SOCKET s;
    volatile LONG closing;        /* 1 = 已通知关闭（持有线程负责 closesocket） */
    volatile LONG notPlugin;      /* 0x0205：1 = 迁移探测等非面板连接（不计入插件在位） */
} KhCli;

typedef struct {
    SOCKET s;
    char   msg[KH_OUTMSG];
} KhOut;

/* ================================================================ 全局状态 */

/* --- 客户端 / 锁 --- */
static KhCli g_khCli[KH_MAX_CLI];
static CRITICAL_SECTION g_khCliLk;
static CRITICAL_SECTION g_khSendLk;      /* 所有对客户端 socket 的发送同锁（防半帧交叠） */

/* --- 键盘钩子 --- */
static HHOOK volatile g_khHook;          /* x64 对齐指针读写即原子；写入用 InterlockedExchangePointer */
static volatile LONG g_khArmed = 1;      /* 默认布防（daemon _hotkeyArmed 初值 true） */
static volatile LONG g_khPlug = 0;       /* 0x0205：插件本体在位 = 18923 有已握手客户端。
                                            ⛔ 与 g_khArmed 正交：布防是用户的开关偏好，
                                            在位是插件本体的生死；两者同时为真才装钩。 */
static volatile LONG g_khActive = 1;     /* 组合键表是否参与匹配（我们就在 PS 里 ⇒ 恒 1） */
static volatile LONG g_khSafeMode;       /* 熔断：只放行不处理 */
static volatile LONG g_khStrikes;        /* 连续超预算计数（仅钩子线程写） */
static volatile LONG g_khSafeSince;      /* 熔断时刻（0=未熔断） */
static volatile LONG g_khBreakMs;        /* 触发熔断那一帧的耗时（代打日志用） */
static volatile LONG g_khPendingBreakLog;
static volatile LONG g_khReinstall;      /* 看护请求重挂（卸→下轮再装） */

/* --- 钩子线程 --- */
static DWORD  g_khRecThreadId;
static HANDLE g_khHookThread;
static HANDLE g_khThreadReady;

/* --- 其它线程 --- */
static HANDLE g_khDispatchThread, g_khWatchdogThread, g_khServerThread;
static HANDLE g_khWake;                   /* 调度线程唤醒（自动复位事件） */
static SOCKET g_khListen;
static volatile LONG g_khBound;           /* 是否持有 18923（单持有者纪律的判据） */
static volatile LONG g_khStop, g_khSrvStop, g_khStarted;

/* --- 录制 --- */
static CRITICAL_SECTION g_khRecLk;
static SOCKET g_khRecClient;
static char   g_khRecBrush[192];
static volatile LONG g_khRecording;
static volatile LONG g_khRecReq;          /* 0 无 / 1 开始 / 2 取消（轮询+post 双路） */
static char   g_khRecPending[KH_COMBO_MAX];  /* 仅钩子线程读写（两段式录制的待确认键） */

/* --- 退格删绑布防 --- */
static CRITICAL_SECTION g_khArmLk;
static SOCKET g_khArmClient;
static char   g_khArmOwner[96];
static volatile LONG g_khArmOn;           /* 对应 daemon 的 _deleteArmOwner != null */

/* --- 热键表（seqlock 双缓冲：钩子线程无锁读） --- */
static KhItem g_khMapBuf[2][KH_MAX_ITEMS];
static KhItem* volatile g_khMap;
static volatile LONG g_khMapCount;
static volatile LONG g_khMapSeq;          /* 偶数=稳定，奇数=写中 */
static CRITICAL_SECTION g_khMapLk;
static volatile LONG g_khItemCount;       /* 配置总条数（含空 combo，getState 的 items） */

/* --- SPSC 环（单生产者=钩子线程 / 单消费者=调度线程） --- */
static char g_khHitQ[KH_HITQ][KH_COMBO_MAX];
static volatile LONG g_khHitHead, g_khHitTail, g_khHitDrops;
static KhOut g_khOutQ[KH_OUTQ];
static volatile LONG g_khOutHead, g_khOutTail;
static char g_khHlog[KH_HLOG_N][KH_HLOG_L];
static volatile LONG g_khHlogHead, g_khHlogTail;

/* --- 前台 PS PID 集合（双缓冲发布；钩子线程每次按键读） --- */
static DWORD g_khPidBuf[2][KH_PSPID_MAX];
static volatile LONG g_khPidIdx, g_khPidCount;

/* --- 配置文件（UTF-8 内存态 + 宽字符落盘态） --- */
static CRITICAL_SECTION g_khCfgLk;
static char    g_khCfgPath[512];          /* UTF-8（回帧 path 字段用） */
static wchar_t g_khCfgPathW[512];
static FILETIME g_khCfgWt;
static int     g_khCfgWtOk;
static DWORD   g_khLastMigrate;

/* 前向声明：以下定义晚于使用点（看护线程 → 刷 PID；服务器线程 → 建客户端线程；
   钩子线程指令轮询 → 装/卸钩子） */
static void kh_refresh_ps_pids(void);
static DWORD WINAPI kh_client_thread(LPVOID param);
static void kh_install_hook(void);
static void kh_uninstall_hook(void);
static void kh_poll_rebuild_watch(void);
static void kh_hk_reset_for_record(void);

/* --- 0x013C 双路按键：LL 钩子（主，可吞键）+ 键态轮询（兜底，不可吞键） ---
 * 轮询计数只用于日志取证：一次测试就能看出「钩子到底有没有被系统调用」。 */
static volatile LONG g_khHookKeys, g_khPollKeys;
/* 关注位表需要重建（由配置线程置位，钩子线程消费 ⇒ 所有 kh_key_to_token
 * 调用都留在钩子线程内，避免其 static 返回缓冲被跨线程写花）。 */
static volatile LONG g_khWatchDirty = 1;

/* ================================================================ 小工具 */

static void kh_log(const char* fmt, ...)
{
    char body[768];
    va_list ap;
    va_start(ap, fmt);
    _vsnprintf(body, sizeof(body) - 1, fmt, ap);
    va_end(ap);
    body[sizeof(body) - 1] = 0;
    log_line("kh", "%s", body);
}

/* 钩子回调路径专用日志：只入内存环，绝不做文件 I/O（调度线程代打）。 */
static void kh_hlog(const char* fmt, ...)
{
    LONG t = g_khHlogTail;
    if (t - g_khHlogHead >= KH_HLOG_N) return;          /* 环满即丢（保回调 O(1)） */
    va_list ap;
    va_start(ap, fmt);
    _vsnprintf(g_khHlog[t % KH_HLOG_N], KH_HLOG_L, fmt, ap);
    va_end(ap);
    g_khHlog[t % KH_HLOG_N][KH_HLOG_L - 1] = 0;
    InterlockedExchange(&g_khHlogTail, t + 1);          /* 发布 + 全屏障 */
    SetEvent(g_khWake);
}

/* 0x013C：钩子已消费的键留痕（轮询兜底据此去重，避免同一击触发两次）。
 * 钩子在系统层面先于轮询看到按键，所以「先写后读」的顺序天然成立。 */
static char g_khLastCombo[KH_COMBO_MAX];
static volatile LONG g_khLastTick;
static void kh_dual_mark(const char* combo)
{
    if (!combo || !combo[0]) return;
    _snprintf(g_khLastCombo, KH_COMBO_MAX, "%s", combo);
    InterlockedExchange(&g_khLastTick, (LONG)GetTickCount());
}

static void kh_w2u8(const wchar_t* w, char* u8, int cap)
{
    WideCharToMultiByte(CP_UTF8, 0, w, -1, u8, cap, NULL, NULL);
    u8[cap - 1] = 0;
}

static void kh_u8_to_w(const char* u8, wchar_t* w, int capw)
{
    MultiByteToWideChar(CP_UTF8, 0, u8, -1, w, capw);
    w[capw - 1] = 0;
}

/* JSON 字符串转义（出站） */
static void kh_esc(const char* in, char* out, int cap)
{
    int o = 0;
    const unsigned char* p = (const unsigned char*)in;
    out[0] = 0;
    while (*p) {
        unsigned char c = *p;
        if (c == '"' || c == '\\') {
            if (o + 2 >= cap) break;
            out[o++] = '\\'; out[o++] = (char)c;
        } else if (c == '\n') { if (o + 2 >= cap) break; out[o++] = '\\'; out[o++] = 'n'; }
        else if (c == '\r') { if (o + 2 >= cap) break; out[o++] = '\\'; out[o++] = 'r'; }
        else if (c == '\t') { if (o + 2 >= cap) break; out[o++] = '\\'; out[o++] = 't'; }
        else if (c == '\b') { if (o + 2 >= cap) break; out[o++] = '\\'; out[o++] = 'b'; }
        else if (c == '\f') { if (o + 2 >= cap) break; out[o++] = '\\'; out[o++] = 'f'; }
        else if (c < 0x20) {
            if (o + 6 >= cap) break;
            o += _snprintf(out + o, (size_t)(cap - o), "\\u%04x", (unsigned)c);
        } else {
            if (o + 1 >= cap) break;
            out[o++] = (char)c;
        }
        p++;
    }
    out[o] = 0;
}

/* JSON 字符串反转义（入站：路径/brush 可能含反斜杠与引号） */
static void kh_unesc(char* s)
{
    char* d = s;
    char* p = s;
    while (*p) {
        if (*p == '\\' && p[1]) {
            p++;
            switch (*p) {
            case 'n': *d++ = '\n'; break;
            case 'r': *d++ = '\r'; break;
            case 't': *d++ = '\t'; break;
            case 'b': *d++ = '\b'; break;
            case 'f': *d++ = '\f'; break;
            case 'u': {
                unsigned v = 0; int ok = 1;
                for (int i = 1; i <= 4; i++) {
                    char h = p[i];
                    v <<= 4;
                    if (h >= '0' && h <= '9') v |= (unsigned)(h - '0');
                    else if (h >= 'a' && h <= 'f') v |= (unsigned)(h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F') v |= (unsigned)(h - 'A' + 10);
                    else { ok = 0; break; }
                }
                if (ok) {
                    p += 4;
                    if (v < 0x80) *d++ = (char)v;
                    else if (v < 0x800) {
                        *d++ = (char)(0xC0 | (v >> 6));
                        *d++ = (char)(0x80 | (v & 0x3F));
                    } else {
                        *d++ = (char)(0xE0 | (v >> 12));
                        *d++ = (char)(0x80 | ((v >> 6) & 0x3F));
                        *d++ = (char)(0x80 | (v & 0x3F));
                    }
                } else *d++ = 'u';
                break;
            }
            default: *d++ = *p; break;    /* \" \\ \/ 及其它原样 */
            }
            p++;
        } else {
            *d++ = *p++;
        }
    }
    *d = 0;
}

/* ================================================================ 客户端表 */

static int kh_cli_add(SOCKET s)
{
    int ok = 0;
    EnterCriticalSection(&g_khCliLk);
    for (int i = 0; i < KH_MAX_CLI; i++) {
        /* ⛔ 准入只看 `s == INVALID_SOCKET`（槽位已归还），**不再看 closing**：
           closing 只对「s 仍有效、正等持有线程收尾」的槽位有意义；s 已归还时它是脏值，
           旧代码用它当准入条件 ⇒ 每个断开过的槽位永久报废（见 kh_cli_remove 注释）。 */
        if (g_khCli[i].s == INVALID_SOCKET) {
            g_khCli[i].s = s;
            g_khCli[i].closing = 0;
            g_khCli[i].notPlugin = 0;
            ok = 1;
            break;
        }
    }
    LeaveCriticalSection(&g_khCliLk);
    if (!ok) kh_log("客户端表已满（%d 条仍在位）⇒ 拒收新连接（18923 可能残留僵尸连接）", KH_MAX_CLI);
    return ok;
}

/* ⛔⛔ 2026-10-23 修的严重缺陷（「PS 运行一阵子后热键突然未连接、reload 也不恢复、
   必须重启 PS」的根因）：
   旧实现把 `closing` 置 **1** 就返回，而 kh_cli_add 的准入条件是
   `s == INVALID_SOCKET && !closing` ⇒ 这一格**永久报废**（add 成功后才会把 closing 写回 0，
   但正因为 closing=1 而永远进不来）。表只有 KH_MAX_CLI=8 格 ⇒ 断 8 次连接之后，
   accept 上来的新连接全部被 `kh_cli_add` 拒收 + closesocket ⇒ 面板永远「未连接」，
   连 UXP reload 都救不了（表在 PS 进程里，只有重启 PS 才清零）。
   槽位归还时必须把 closing 一起清 0：此时 s 已是 INVALID_SOCKET，广播/shutdown 都以
   s 为准跳过它，所以 closing=0 不会让任何人拿到「正在关闭」的旧连接。 */
static void kh_cli_remove(SOCKET s)
{
    EnterCriticalSection(&g_khCliLk);
    for (int i = 0; i < KH_MAX_CLI; i++)
        if (g_khCli[i].s == s) {
            g_khCli[i].s = INVALID_SOCKET;
            g_khCli[i].closing = 0;
            g_khCli[i].notPlugin = 0;
            break;
        }
    LeaveCriticalSection(&g_khCliLk);
}

/* 0x0205：插件本体在位判据 = 客户端表里还有活着的连接（面板进程的化身）。
 * 建连（握手成功后）与断连（kh_cli_remove 之后）都会重算；
 * 多面板/多 JS 上下文各自一条连接，全部消失才算不在位。
 * ⛔ notPlugin（迁移探测，path=/jw-migrate）不计 —— 多开 PS 时非持有实例
 *    每 10s 探一次，若计入就会给持有端伪造「插件在位」。 */
static void kh_plug_recompute(void)
{
    int live = 0;
    EnterCriticalSection(&g_khCliLk);
    for (int i = 0; i < KH_MAX_CLI; i++)
        if (g_khCli[i].s != INVALID_SOCKET && !g_khCli[i].closing && !g_khCli[i].notPlugin) live++;
    LeaveCriticalSection(&g_khCliLk);
    InterlockedExchange(&g_khPlug, live > 0 ? 1 : 0);
}

/* 0x0205：把一条已登记连接标记为「非面板」（握手 path ≠ "/" 时由客户端线程调用）。 */
static void kh_cli_tag_not_plugin(SOCKET s)
{
    EnterCriticalSection(&g_khCliLk);
    for (int i = 0; i < KH_MAX_CLI; i++)
        if (g_khCli[i].s == s) { g_khCli[i].notPlugin = 1; break; }
    LeaveCriticalSection(&g_khCliLk);
}

/* 广播/代发失败 ⇒ 标记关闭并唤醒阻塞的 recv；句柄归所属客户端线程。 */
static void kh_cli_mark_close(SOCKET s)
{
    EnterCriticalSection(&g_khCliLk);
    for (int i = 0; i < KH_MAX_CLI; i++) {
        if (g_khCli[i].s == s && !g_khCli[i].closing) {
            g_khCli[i].closing = 1;
            shutdown(s, SD_BOTH);
            break;
        }
    }
    LeaveCriticalSection(&g_khCliLk);
}

static void kh_cli_shutdown_all(void)
{
    EnterCriticalSection(&g_khCliLk);
    for (int i = 0; i < KH_MAX_CLI; i++) {
        if (g_khCli[i].s != INVALID_SOCKET && !g_khCli[i].closing) {
            g_khCli[i].closing = 1;
            shutdown(g_khCli[i].s, SD_BOTH);
        }
    }
    LeaveCriticalSection(&g_khCliLk);
}

/* ================================================================ 发送 / 广播 */

static void kh_send_to(SOCKET s, const char* msg)
{
    if (!wc_send_text_lk(s, msg, &g_khSendLk)) kh_cli_mark_close(s);
}

static void kh_broadcast(const char* msg)
{
    EnterCriticalSection(&g_khCliLk);
    for (int i = 0; i < KH_MAX_CLI; i++) {
        SOCKET s = g_khCli[i].s;
        if (s == INVALID_SOCKET || g_khCli[i].closing) continue;
        if (!wc_send_text_lk(s, msg, &g_khSendLk)) {
            g_khCli[i].closing = 1;
            shutdown(s, SD_BOTH);
        }
    }
    LeaveCriticalSection(&g_khCliLk);
}

/* ================================================================ 热键表（seqlock） */

/* 混合模式热键内置表（PS 原生 Alt+Shift+<key>，Adobe 官方快捷键表）。
 * 由配置里的 blendHotkey 标志条目控制装载（2026-10-19 用户要求：
 * 套索/笔刷工具下按这些键不再改图层混合模式，而是改 APP 面板「选区填充」
 * 的混合模式）。命中后广播 action='blendMode'，brush = PS 枚举值，
 * 由 UXP 侧映射回中文名写进面板状态。
 * ⚠️ combo 格式必须与 kh_build_combo 的输出逐字一致（Ctrl→Alt→Shift→Win 序），
 *    匹配用 _stricmp 大小写不敏感，但分隔符与顺序必须相同。 */
typedef struct { const char* combo; const char* mode; } KhBlendDef;
static const KhBlendDef KH_BLEND_DEFS[] = {
    { "Alt+Shift+N", "normal" },      { "Alt+Shift+I", "dissolve" },
    { "Alt+Shift+Q", "behind" },      { "Alt+Shift+K", "darken" },
    { "Alt+Shift+M", "multiply" },    { "Alt+Shift+B", "colorBurn" },
    { "Alt+Shift+A", "linearBurn" },  { "Alt+Shift+G", "lighten" },
    { "Alt+Shift+S", "screen" },      { "Alt+Shift+D", "colorDodge" },
    { "Alt+Shift+W", "linearDodge" }, { "Alt+Shift+O", "overlay" },
    { "Alt+Shift+F", "softLight" },   { "Alt+Shift+H", "hardLight" },
    { "Alt+Shift+V", "vividLight" },  { "Alt+Shift+J", "linearLight" },
    { "Alt+Shift+Z", "pinLight" },    { "Alt+Shift+L", "hardMix" },
    { "Alt+Shift+E", "difference" },  { "Alt+Shift+X", "exclusion" },
    { "Alt+Shift+U", "hue" },         { "Alt+Shift+T", "saturation" },
    { "Alt+Shift+C", "color" },       { "Alt+Shift+Y", "luminosity" },
};
#define KH_BLEND_N ((int)(sizeof(KH_BLEND_DEFS) / sizeof(KH_BLEND_DEFS[0])))

static void kh_map_publish(const KhItem* items, int n)
{
    EnterCriticalSection(&g_khMapLk);
    KhItem* dst = (g_khMap == g_khMapBuf[0]) ? g_khMapBuf[1] : g_khMapBuf[0];
    int cnt = (n > KH_MAX_ITEMS) ? KH_MAX_ITEMS : n;
    if (cnt > 0) memcpy(dst, items, sizeof(KhItem) * (size_t)cnt);
    InterlockedExchange(&g_khMapSeq, g_khMapSeq + 1);          /* 变奇：写中 */
    g_khMapCount = cnt;
    g_khMap = dst;
    InterlockedExchange(&g_khMapSeq, g_khMapSeq + 1);          /* 变偶：稳定 */
    LeaveCriticalSection(&g_khMapLk);
}

/* 由已解析条目发布热键表：过滤「空 combo（已解绑）」与重复组合键。
 * ⛔⛔ 0x0123：这段逻辑原先只内联在 kh_reload() 里，导致**只有「配置路径切换」和
 *    「面板保存配置」两条路会重建表**；而「面板建连后 getConfig 拉配置」这条路
 *    只读文件回帧、不碰热键表 ⇒ 首帧读到的表如果是空的（启动时那次 kh_reload
 *    撞上文件暂时不可读/路径尚未对齐），热键就**一直全失效**，直到用户重录一条
 *    触发 kh_save_config → kh_reload 才恢复（用户实测的「重录一个快捷键后恢复」）。
 *    抽成独立函数后，三条路（启动装载 / 路径下发 / 拉配置）共用同一段语义。 */
static int kh_map_apply(const KhItem* items, int n)
{
    KhItem map[KH_MAX_ITEMS];
    int mn = 0;
    int blendOn = 0;
    for (int i = 0; i < n; i++) {
        /* 混合模式热键标志条目：combo 非空 = 开关打开。⛔ 它本身**不参与匹配**
           （ combo='1' 是个普通按键，混进表里会把用户的数字键吞掉），
           只作为「是否装载内置混合模式表」的开关。 */
        if (_stricmp(items[i].action, "blendHotkey") == 0) {
            if (items[i].combo[0]) blendOn = 1;
            continue;
        }
        if (!items[i].combo[0]) continue;                 /* 空 combo = 已解绑，仅留存 */
        int dup = 0;
        for (int j = 0; j < mn; j++)
            if (_stricmp(map[j].combo, items[i].combo) == 0) { dup = 1; break; }
        if (dup) { kh_log("跳过重复组合键: %s", items[i].combo); continue; }
        map[mn++] = items[i];
    }
    /* 装载内置混合模式表：用户显式录制的同名组合键优先（上面已先入表，这里去重跳过）。
       钩子命中即吞键 ⇒ PS 收不到 Alt+Shift+<key>，原生「改图层/工具混合模式」
       被静默替换成「改 APP 面板混合模式」（广播 action='blendMode'）。 */
    if (blendOn) {
        int added = 0;
        for (int b = 0; b < KH_BLEND_N && mn < KH_MAX_ITEMS; b++) {
            int dup = 0;
            for (int j = 0; j < mn; j++)
                if (_stricmp(map[j].combo, KH_BLEND_DEFS[b].combo) == 0) { dup = 1; break; }
            if (dup) continue;
            KhItem* it = &map[mn++];
            memset(it, 0, sizeof(*it));
            _snprintf(it->id,     sizeof(it->id),     "blend_hotkey");
            _snprintf(it->combo,  sizeof(it->combo),  "%s", KH_BLEND_DEFS[b].combo);
            _snprintf(it->action, sizeof(it->action), "blendMode");
            _snprintf(it->brush,  sizeof(it->brush),  "%s", KH_BLEND_DEFS[b].mode);
            added++;
        }
        kh_log("混合模式热键已装载：内置 %d 条（Alt+Shift+<key> → 面板混合模式）", added);
    }
    kh_map_publish(map, mn);
    InterlockedExchange(&g_khWatchDirty, 1);      /* 表变了 ⇒ 钩子线程重建关注位 */
    return mn;
}

/* 钩子线程专用：seqlock 无锁查表。命中返回 1 并拷贝出条目。 */
static int kh_map_lookup(const char* combo, KhItem* out)
{
    for (int tries = 0; tries < 64; tries++) {
        LONG s1 = g_khMapSeq;
        if (s1 & 1) continue;                       /* 写中 ⇒ 重试 */
        KhItem* m = (KhItem*)g_khMap;
        LONG n = g_khMapCount;
        if (!m || n <= 0) return 0;
        int found = 0;
        for (LONG i = 0; i < n; i++) {
            if (_stricmp(m[i].combo, combo) == 0) {
                if (out) *out = m[i];
                found = 1;
                break;
            }
        }
        if (s1 == g_khMapSeq) return found;         /* 期间未被改写 ⇒ 结论有效 */
    }
    return 0;                                        /* 重试耗尽 ⇒ 本轮不命中 */
}

/* 非钩子线程（调度/看护）专用：加锁快照。 */
static int kh_map_lookup_locked(const char* combo, KhItem* out)
{
    int found = 0;
    EnterCriticalSection(&g_khMapLk);
    KhItem* m = (KhItem*)g_khMap;
    LONG n = g_khMapCount;
    for (LONG i = 0; i < n && m; i++) {
        if (_stricmp(m[i].combo, combo) == 0) {
            if (out) *out = m[i];
            found = 1;
            break;
        }
    }
    LeaveCriticalSection(&g_khMapLk);
    return found;
}

static int kh_map_count(void)
{
    int n = g_khMapCount;
    return n < 0 ? 0 : n;
}

/* ================================================================ 配置解析 / 序列化 */

/* 解析 JSON 对象数组（js 须指向 '['）。返回条数；-1 = 畸形（未闭合）。 */
static int kh_parse_items(const char* js, KhItem* out, int max)
{
    const char* p = js;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p == '[') p++;
    /* ⛔ 0x013A 迁移兼容（2026-10-19）：旧版 .8li 的 kh_items_to_json 漏写数组括号，
       落盘文件是裸对象逗号拼接、首字符即 '{'。若严格拒之，用户已录热键将永久读不到
       （面板随后还会用空视图覆盖保存，2026-10-13「热键全没了」同款事故）。
       这里按隐式数组放行；下次保存（kh_save_config）即转为标准数组格式。 */
    else if (*p != '{') return -1;
    int n = 0;
    while (*p && n < max) {
        while (*p && *p != '{' && *p != ']') p++;
        if (*p != '{') break;
        const char* objStart = p;
        const char* q = p + 1;
        int depth = 1, inStr = 0;
        while (*q && depth > 0) {
            char c = *q;
            if (inStr) {
                if (c == '\\') { if (q[1]) q++; }
                else if (c == '"') inStr = 0;
            } else {
                if (c == '"') inStr = 1;
                else if (c == '{') depth++;
                else if (c == '}') depth--;
            }
            q++;
        }
        if (depth != 0) return -1;                   /* 数组未闭合 */
        char obj[1024];
        int L = (int)(q - objStart);
        if (L >= (int)sizeof(obj)) L = (int)sizeof(obj) - 1;
        memcpy(obj, objStart, (size_t)L);
        obj[L] = 0;
        KhItem it;
        memset(&it, 0, sizeof it);
        json_str(obj, "id",     it.id,     (int)sizeof(it.id));
        json_str(obj, "combo",  it.combo,  (int)sizeof(it.combo));
        json_str(obj, "action", it.action, (int)sizeof(it.action));
        json_str(obj, "brush",  it.brush,  (int)sizeof(it.brush));
        kh_unesc(it.id); kh_unesc(it.combo); kh_unesc(it.action); kh_unesc(it.brush);
        out[n++] = it;
        p = q;
    }
    return n;
}

/* 把条目数组序列化为**标准 JSON 数组**文本（字段集 = 面板 normalizeEntry 的四个）。
 * ⛔⛔ 0x013A（2026-10-19）：本函数自 M3 移植（aead9c0）起漏写数组括号 ——
 *   输出是裸对象逗号拼接，不是合法 JSON；而 kh_parse_items / kh_read_config_file
 *   双双严格要求 '[' 开头 ⇒ 每次 kh_save_config 落盘后，紧跟的 kh_reload 必判
 *   「解析失败」保留旧表（新条目永远进不了热键表），broadcast 还带着空 payload
 *   把面板已录条目清空。用户实测三连：快捷键全失灵 / 已录条目加载后消失 /
 *   混合模式开关开启后秒弹回。修法 = 输出标准数组；两个广播点（kh_reload 与
 *   getConfig 回帧）原先手工包的 [ %s ] 同步拆除，否则面板会收到 [[...]]
 *   被 Array.isArray 拒之门外（同样表现为条目全空）。 */
static int kh_items_to_json(const KhItem* items, int n, char* out, int cap)
{
    int o = 0;
    out[0] = 0;
    if (cap < 4) return -1;                      /* 至少容得下 "[]\0" */
    out[o++] = '[';
    for (int i = 0; i < n; i++) {
        char idE[96], cbE[128], acE[96], brE[256];
        kh_esc(items[i].id,     idE,  (int)sizeof(idE));
        kh_esc(items[i].combo,  cbE,  (int)sizeof(cbE));
        kh_esc(items[i].action, acE,  (int)sizeof(acE));
        kh_esc(items[i].brush,  brE,  (int)sizeof(brE));
        int w = _snprintf(out + o, (size_t)(cap - o), "%s{\"id\":\"%s\",\"combo\":\"%s\",\"action\":\"%s\",\"brush\":\"%s\"}",
                          i ? "," : "", idE, cbE, acE, brE);
        /* 循环内为收尾的 ']' + NUL 预留 2 字节 */
        if (w < 0 || o + w + 2 > cap) { out[0] = 0; return -1; }
        o += w;
    }
    out[o++] = ']';
    out[o] = 0;
    return o;
}

/* 配置路径快照：所有文件 I/O / 回帧 path 字段先取快照再用。
   ⛔ 直读全局路径会在 setConfigPath 的 memcpy 中途拿到"半旧半新"路径，
      表现为：误判文件被删 → 无谓 reload；或回帧 path 与面板请求不一致
      ⇒ canPersistConfig 拒绝持久化（2026-10-17 自查修复）。 */
static void kh_cfg_snapshot(wchar_t* w, int wcap)
{
    EnterCriticalSection(&g_khCfgLk);
    _snwprintf(w, (size_t)wcap, L"%s", g_khCfgPathW);
    w[wcap - 1] = 0;
    LeaveCriticalSection(&g_khCfgLk);
}

static void kh_cfg_snapshot_u8(char* u, int ucap)
{
    EnterCriticalSection(&g_khCfgLk);
    _snprintf(u, (size_t)ucap, "%s", g_khCfgPath);
    u[ucap - 1] = 0;
    LeaveCriticalSection(&g_khCfgLk);
}

/* 读配置文件 → 条目数组。0 = 空/不存在；-1 = 读失败或畸形。 */
static int kh_read_config_file(KhItem* out, int max)
{
    wchar_t path[512];
    kh_cfg_snapshot(path, 512);
    HANDLE f = CreateFileW(path, GENERIC_READ,
                           FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return 0;
    DWORD sz = GetFileSize(f, NULL);
    if (sz == INVALID_FILE_SIZE || sz > 4u * 1024u * 1024u) { CloseHandle(f); return -1; }
    char* buf = (char*)malloc((size_t)sz + 1);
    if (!buf) { CloseHandle(f); return -1; }
    DWORD n = 0;
    if (!ReadFile(f, buf, sz, &n, NULL)) { CloseHandle(f); free(buf); return -1; }
    CloseHandle(f);
    buf[n] = 0;
    char* p = buf;
    if (n >= 3 && (unsigned char)p[0] == 0xEF && (unsigned char)p[1] == 0xBB &&
        (unsigned char)p[2] == 0xBF) p += 3;                     /* 跳 BOM */
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    /* ⛔ 0x013A 迁移兼容：放行旧版无括号格式（首字符 '{'），详见 kh_parse_items 同款注释。
       检测到旧格式时留痕 —— 下次保存会自动转成标准数组，该提示随之消失。 */
    if (*p == '{') kh_log("⚠️ 配置为旧版无括号格式（0x013A 兼容读取，下次保存转标准数组）: %s", g_khCfgPath);
    if (*p != '[' && *p != '{') { free(buf); return -1; }
    int cnt = kh_parse_items(p, out, max);
    free(buf);
    return cnt;
}

static void kh_write_cfg_store(void)
{
    wchar_t lad[MAX_PATH] = L"";
    GetEnvironmentVariableW(L"LOCALAPPDATA", lad, MAX_PATH);
    if (!lad[0]) return;
    char u8[512];
    kh_cfg_snapshot_u8(u8, 512);
    if (!u8[0]) return;
    wchar_t dir[MAX_PATH], store[MAX_PATH];
    _snwprintf(dir,   MAX_PATH, L"%s\\JWautofill", lad);
    _snwprintf(store, MAX_PATH, L"%s\\JWautofill\\configpath.txt", lad);
    CreateDirectoryW(dir, NULL);
    HANDLE f = CreateFileW(store, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    DWORD w;
    WriteFile(f, u8, (DWORD)strlen(u8), &w, NULL);
    CloseHandle(f);
}

static void kh_default_cfg_path(void)
{
    wchar_t lad[MAX_PATH] = L"";
    GetEnvironmentVariableW(L"LOCALAPPDATA", lad, MAX_PATH);
    if (!lad[0]) _snwprintf(g_khCfgPathW, 512, L"hotkeys.json");
    else _snwprintf(g_khCfgPathW, 512, L"%s\\JWautofill\\hotkeys.json", lad);
    g_khCfgPathW[511] = 0;
    kh_w2u8(g_khCfgPathW, g_khCfgPath, (int)sizeof(g_khCfgPath));
}

/* 启动时沿用上一次面板指定的路径（daemon ConfigPathStore 同款）。 */
static void kh_load_cfg_store(void)
{
    wchar_t lad[MAX_PATH] = L"";
    GetEnvironmentVariableW(L"LOCALAPPDATA", lad, MAX_PATH);
    if (lad[0]) {
        wchar_t store[MAX_PATH];
        _snwprintf(store, MAX_PATH, L"%s\\JWautofill\\configpath.txt", lad);
        HANDLE f = CreateFileW(store, GENERIC_READ, FILE_SHARE_READ, NULL,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (f != INVALID_HANDLE_VALUE) {
            char buf[512];
            DWORD n = 0;
            if (ReadFile(f, buf, sizeof(buf) - 1, &n, NULL) && n > 0) {
                buf[n] = 0;
                char* s = buf;
                while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') s++;
                char* e = s + strlen(s);
                while (e > s && (e[-1] == '\r' || e[-1] == '\n' || e[-1] == ' ')) e--;
                *e = 0;
                if (*s) {
                    _snprintf(g_khCfgPath, sizeof(g_khCfgPath), "%s", s);
                    kh_u8_to_w(g_khCfgPath, g_khCfgPathW, 512);
                    CloseHandle(f);
                    kh_log("沿用已记录的配置路径: %s", g_khCfgPath);
                    return;
                }
            }
            CloseHandle(f);
        }
    }
    kh_default_cfg_path();
    kh_log("未找到配置路径记录，使用默认: %s", g_khCfgPath);
}

/* 重载热键表并广播 config 帧（daemon ReloadConfig 同款：两路都广播）。 */
static void kh_reload(void)
{
    KhItem items[KH_MAX_ITEMS];
    int n = kh_read_config_file(items, KH_MAX_ITEMS);
    if (n < 0) {
        /* ⛔ 解析失败**不清空**热键表：半写文件/AV 占用会读出残缺 JSON，
           按 daemon 语义广播空配置可以，但把表也清了会让热键静默全失效。
           保留旧表 + 留痕，等下一轮 mtime 变化自愈。 */
        kh_log("⚠️ 配置读取/解析失败（保留原热键表）: %s", g_khCfgPath);
    } else {
        int mn = kh_map_apply(items, n);
        InterlockedExchange(&g_khItemCount, n);
        kh_log("热键表已装载：配置 %d 条 / 可匹配 %d 条（%s）", n, mn, g_khCfgPath);
    }
    /* 广播 config（读文件原样序列化，带 path —— 面板 canPersistConfig 的判据）。
       ⛔ 0x013A：kh_items_to_json 现已自带数组括号，这里**不能再包** [ %s ]，
          否则面板收到 [[...]] 被 Array.isArray 拒之门外（条目全空）。 */
    KhItem fresh[KH_MAX_ITEMS];
    int fn = kh_read_config_file(fresh, KH_MAX_ITEMS);
    if (fn < 0) fn = 0;
    char* payload = (char*)malloc(160 * 1024);
    if (payload) {
        char pathNow[512], pathEsc[1024];
        kh_cfg_snapshot_u8(pathNow, 512);
        kh_items_to_json(fresh, fn, payload, 160 * 1024);
        kh_esc(pathNow, pathEsc, (int)sizeof(pathEsc));
        char* msg = (char*)malloc(170 * 1024);
        if (msg) {
            _snprintf(msg, 170 * 1024,
                      "{\"type\":\"config\",\"payload\":%s,\"path\":\"%s\"}",
                      payload, pathEsc);
            kh_broadcast(msg);
            free(msg);
        }
        free(payload);
    }
}

/* 面板 config 帧 → 落盘（.bak 备份）→ 热更新（daemon SaveConfig 同款）。 */
static void kh_save_config(const char* payload)
{
    KhItem items[KH_MAX_ITEMS];
    int n = kh_parse_items(payload, items, KH_MAX_ITEMS);
    if (n < 0) { kh_log("保存配置：payload 解析失败，已忽略"); return; }
    if (n >= KH_MAX_ITEMS) kh_log("⚠️ 条目数达到上限 %d，超出部分被丢弃", KH_MAX_ITEMS);

    char* txt = (char*)malloc(160 * 1024);
    if (!txt) return;
    if (kh_items_to_json(items, n, txt, 160 * 1024) < 0) {
        kh_log("保存配置：序列化超长，已忽略");
        free(txt);
        return;
    }
    /* ⛔ 覆盖前先留 .bak：热键是用户一条条录出来的，被默认值冲掉无法重建
       （2026-10-13 事故；面板侧 canPersistConfig 是主护栏，这里再兜一层）。 */
    wchar_t path[512];
    kh_cfg_snapshot(path, 512);
    wchar_t bak[600];
    _snwprintf(bak, 600, L"%s.bak", path);
    if (GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES)
        CopyFileW(path, bak, FALSE);
    HANDLE f = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) {
        kh_log("保存配置失败：无法写入 %s", g_khCfgPath);
        free(txt);
        return;
    }
    DWORD w;
    WriteFile(f, txt, (DWORD)strlen(txt), &w, NULL);
    CloseHandle(f);
    kh_log("配置已写入 %s（%d 条）", g_khCfgPath, n);
    free(txt);
    kh_reload();     /* SaveConfig → ReloadConfig（Program.cs 同款：落盘即热更新） */
}

static void kh_poll_config_file(void)
{
    wchar_t path[512];
    kh_cfg_snapshot(path, 512);
    WIN32_FILE_ATTRIBUTE_DATA fd;
    if (!GetFileAttributesExW(path, GetFileExInfoStandard, &fd)) {
        if (g_khCfgWtOk) { g_khCfgWtOk = 0; kh_reload(); }   /* 文件被删 */
        return;
    }
    if (!g_khCfgWtOk || CompareFileTime(&fd.ftLastWriteTime, &g_khCfgWt) > 0) {
        g_khCfgWt = fd.ftLastWriteTime;
        g_khCfgWtOk = 1;
        kh_reload();
    }
}

static void kh_set_config_path(const char* p)
{
    if (!p || !*p) return;
    char np[512];
    _snprintf(np, sizeof(np), "%s", p);
    char* s = np;
    while (*s == ' ' || *s == '\t') s++;
    if (!*s) return;

    /* 比较+替换必须同锁原子：否则两个客户端线程并发 set 可能互相覆盖。 */
    char old[512];
    old[0] = 0;
    int changed = 0;
    EnterCriticalSection(&g_khCfgLk);
    if (_stricmp(np, g_khCfgPath) != 0) {
        memcpy(old, g_khCfgPath, sizeof(old));
        memcpy(g_khCfgPath, np, sizeof(g_khCfgPath));
        kh_u8_to_w(np, g_khCfgPathW, 512);
        changed = 1;
    }
    LeaveCriticalSection(&g_khCfgLk);
    /* ⛔⛔ 0x0123：路径**没变也必须重载**（早退已删）。
       面板每次建连都会先发 setConfigPath 再发 getConfig，这是它唯一一次「宣告自己
       在线」的机会；若这里因路径相同直接 return，启动时那次 kh_reload 若失败
       （文件正被写 / 路径尚未真实就绪），空表就会一直留到用户手动重录。
       重载成本 = 一次文件读 + 一次表拷贝，且只在握手时发生，完全可接受。 */
    if (!changed) {
        g_khCfgWtOk = 0;          /* 强制让下一次 mtime 轮询也认为「该重读」 */
        kh_reload();
        return;
    }
    int oldHad = old[0] != 0;
    kh_log("配置路径已切换: %s", g_khCfgPath);

    /* 建目录；新路径无文件而旧路径有时，搬迁旧配置（避免用户重新录制）。 */
    wchar_t dir[MAX_PATH];
    memcpy(dir, g_khCfgPathW, sizeof(dir));
    wchar_t* slash = wcsrchr(dir, L'\\');
    if (slash) { *slash = 0; CreateDirectoryW(dir, NULL); }
    if (GetFileAttributesW(g_khCfgPathW) == INVALID_FILE_ATTRIBUTES && oldHad) {
        wchar_t oldW[512];
        kh_u8_to_w(old, oldW, 512);
        if (GetFileAttributesW(oldW) != INVALID_FILE_ATTRIBUTES) {
            if (CopyFileW(oldW, g_khCfgPathW, FALSE))
                kh_log("已迁移旧配置到新路径");
        }
    }
    kh_write_cfg_store();
    g_khCfgWtOk = 0;
    kh_reload();
}

/* ================================================================ 状态帧 */

static int kh_read_ll_timeout(void)
{
    HKEY k;
    if (RegOpenKeyExA(HKEY_CURRENT_USER, "Control Panel\\Desktop", 0, KEY_READ, &k) != ERROR_SUCCESS)
        return 0;
    int out = 0;
    /* ⛔ 必须先 NULL 缓冲问 type+size：REG_SZ 值用小 DWORD 缓冲首查会返回
       ERROR_MORE_DATA 而非 SUCCESS，按类型分流根本到不了 SZ 分支。 */
    DWORD type = 0, sz = 0;
    if (RegQueryValueExA(k, "LowLevelHooksTimeout", NULL, &type, NULL, &sz) == ERROR_SUCCESS) {
        if (type == REG_DWORD && sz == sizeof(DWORD)) {
            DWORD v = 0;
            if (RegQueryValueExA(k, "LowLevelHooksTimeout", NULL, &type, (LPBYTE)&v, &sz) == ERROR_SUCCESS)
                out = (int)v;
        } else if (type == REG_SZ && sz > 0 && sz < 64) {
            char s[64] = "";
            if (RegQueryValueExA(k, "LowLevelHooksTimeout", NULL, &type, (LPBYTE)s, &sz) == ERROR_SUCCESS)
                out = atoi(s);
        }
    }
    RegCloseKey(k);
    return out;
}

/* DPI 感知标签（诊断字段；API 经 GetProcAddress 取，兼容无导出的老系统） */
typedef HANDLE (WINAPI *FnGetThreadDpi)(void);
typedef BOOL   (WINAPI *FnDpiEqual)(HANDLE, HANDLE);
typedef int    (WINAPI *FnDpiAwareness)(HANDLE);

static const char* kh_dpi_label(void)
{
    HMODULE u = GetModuleHandleW(L"user32.dll");
    if (!u) return "n/a";
    FnGetThreadDpi gt = (FnGetThreadDpi)GetProcAddress(u, "GetThreadDpiAwarenessContext");
    if (!gt) return "n/a";
    FnDpiEqual    eq = (FnDpiEqual)GetProcAddress(u, "AreDpiAwarenessContextsEqual");
    FnDpiAwareness ga = (FnDpiAwareness)GetProcAddress(u, "GetAwarenessFromDpiAwarenessContext");
    HANDLE ctx = gt();
    if (eq && eq(ctx, (HANDLE)-4)) return "permonitor-v2";   /* PER_MONITOR_AWARE_V2 */
    if (eq && eq(ctx, (HANDLE)-3)) return "permonitor";      /* PER_MONITOR_AWARE */
    if (ga) {
        switch (ga(ctx)) {
        case 0: return "unaware";
        case 1: return "system";
        case 2: return "permonitor";
        default: return "invalid";
        }
    }
    return "n/a";
}

static void kh_build_hotkey_state(char* out, int cap)
{
    _snprintf(out, (size_t)cap,
        "{\"type\":\"hotkeyState\",\"protocol\":\"2.0\",\"armed\":%s,"
        "\"hookInstalled\":%s,\"safeMode\":%s,\"active\":%s,\"comboCount\":%d,"
        "\"recording\":%s,\"timeoutMs\":%d,\"budgetMs\":%d,\"strikes\":%d}",
        g_khArmed    ? "true" : "false",
        g_khHook     ? "true" : "false",
        g_khSafeMode ? "true" : "false",
        g_khActive   ? "true" : "false",
        kh_map_count(),
        g_khRecording ? "true" : "false",
        kh_read_ll_timeout(), KH_BUDGET_MS, (int)g_khStrikes);
}

static void kh_build_state(char* out, int cap)
{
    char combos[6144];
    int co = 0;
    combos[0] = 0;
    EnterCriticalSection(&g_khMapLk);
    {
        KhItem* m = (KhItem*)g_khMap;
        LONG n = g_khMapCount;
        for (LONG i = 0; i < n && m && co < (int)sizeof(combos) - 80; i++) {
            char esc[128];
            kh_esc(m[i].combo, esc, (int)sizeof(esc));
            co += _snprintf(combos + co, (size_t)(sizeof(combos) - co), "%s\"%s\"",
                            i ? "," : "", esc);
            if (co < 0) { co = 0; break; }
        }
    }
    LeaveCriticalSection(&g_khMapLk);
    _snprintf(out, (size_t)cap,
        "{\"type\":\"state\",\"version\":\"%s\",\"protocol\":\"2.0\","
        "\"features\":[\"hotkey\",\"hotkeyArm\",\"hotkeyState\",\"watchdogs\"],"
        "\"role\":\"\xE7\x83\xBD\xE9\x94\xAE\",\"dpiAwareness\":\"%s\",\"active\":%s,"
        "\"hookInstalled\":%s,\"hookSafeMode\":%s,\"hookTimeoutMs\":%d,"
        "\"comboCount\":%d,\"combos\":[%s],\"items\":%d,\"hotkeyArmed\":%s}",
        KH_VERSION, kh_dpi_label(),
        g_khActive   ? "true" : "false",
        g_khHook     ? "true" : "false",
        g_khSafeMode ? "true" : "false",
        kh_read_ll_timeout(),
        kh_map_count(), combos, (int)g_khItemCount,
        g_khArmed ? "true" : "false");
}

/* ================================================================ 键盘钩子 */

/* vk → token（Program.cs KeyToToken 逐字对应；与 ParseCombo 严格互逆）。 */
static const char* kh_key_to_token(int vk)
{
    if (vk >= 0x41 && vk <= 0x5A) {
        static char one[2];
        one[0] = (char)vk; one[1] = 0;
        return one;
    }
    if (vk >= 0x30 && vk <= 0x39) {
        static char one[2];
        one[0] = (char)vk; one[1] = 0;
        return one;
    }
    if (vk >= 0x70 && vk <= 0x87) {
        static char f[8];
        _snprintf(f, sizeof(f), "F%d", vk - 0x70 + 1);
        return f;
    }
    if (vk >= 0x60 && vk <= 0x69) {
        static char nm[8];
        _snprintf(nm, sizeof(nm), "Num%d", vk - 0x60);
        return nm;
    }
    switch (vk) {
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
    case 0x6A: return "NumMul";
    case 0x6B: return "NumPlus";
    case 0x6D: return "NumMinus";
    case 0x6E: return "NumDot";
    case 0x6F: return "NumDiv";
    default:   return NULL;
    }
}

static int kh_build_combo(int vk, char* out, int cap)
{
    const char* mods[4];
    int nm = 0;
    if (GetAsyncKeyState(0x11) & 0x8000) mods[nm++] = "Ctrl";
    if (GetAsyncKeyState(0x12) & 0x8000) mods[nm++] = "Alt";
    if (GetAsyncKeyState(0x10) & 0x8000) mods[nm++] = "Shift";
    if ((GetAsyncKeyState(0x5B) & 0x8000) || (GetAsyncKeyState(0x5C) & 0x8000)) mods[nm++] = "Win";
    const char* key = kh_key_to_token(vk);
    if (!key) return 0;
    int o = 0;
    out[0] = 0;
    for (int i = 0; i < nm; i++) {
        int w = _snprintf(out + o, (size_t)(cap - o), "%s%s", i ? "+" : "", mods[i]);
        if (w < 0 || o + w >= cap - 2) { out[0] = 0; return 0; }
        o += w;
    }
    int w = _snprintf(out + o, (size_t)(cap - o), "%s%s", nm ? "+" : "", key);
    if (w < 0 || o + w >= cap - 2) { out[0] = 0; return 0; }
    return 1;
}

/* 前台是否落在某个 Photoshop 进程（daemon IsPhotoshopForeground 同款）。 */
static int kh_ps_foreground(void)
{
    HWND fg = GetForegroundWindow();
    if (!fg) return 0;
    DWORD pid = 0;
    GetWindowThreadProcessId(fg, &pid);
    if (!pid) return 0;
    /* ⛔ 0x013B：本进程必然就是 Photoshop —— 前台属于自己直接放行。
       这一条**不依赖** g_khPidBuf（toolhelp 枚举）与看护线程刷新，消除了
       「pid 表为空 / 尚未刷新 ⇒ 整机按键被静默放行」这个单点故障。
       .8li 就活在 PS 进程内，"查不到自己"本来就不该发生。 */
    if (pid == GetCurrentProcessId()) return 1;
    int idx = g_khPidIdx;
    int n = g_khPidCount;
    if (n <= 0) return 0;
    const DWORD* p = g_khPidBuf[idx];
    for (int i = 0; i < n; i++)
        if (p[i] == pid) return 1;
    return 0;
}

/* 录制/退格回帧：钩子线程只入队，调度线程代发（零 I/O 纪律）。 */
static void kh_out_push(SOCKET s, const char* msg)
{
    LONG t = g_khOutTail;
    if (t - g_khOutHead >= KH_OUTQ) return;               /* 环满即丢（低频路径，理论不可达） */
    g_khOutQ[t % KH_OUTQ].s = s;
    _snprintf(g_khOutQ[t % KH_OUTQ].msg, KH_OUTMSG, "%s", msg);
    InterlockedExchange(&g_khOutTail, t + 1);
    SetEvent(g_khWake);
}

static void kh_hit_push(const char* combo)
{
    LONG t = g_khHitTail;
    if (t - g_khHitHead >= KH_HITQ) {
        InterlockedIncrement(&g_khHitDrops);
        return;
    }
    _snprintf(g_khHitQ[t % KH_HITQ], KH_COMBO_MAX, "%s", combo);
    InterlockedExchange(&g_khHitTail, t + 1);
    SetEvent(g_khWake);
}

static void kh_send_recording_progress(const char* combo)
{
    SOCKET c;
    char brush[192];
    EnterCriticalSection(&g_khRecLk);
    c = g_khRecClient;
    memcpy(brush, g_khRecBrush, sizeof(brush));
    LeaveCriticalSection(&g_khRecLk);
    if (c == INVALID_SOCKET) return;
    char msg[384], b[256], cb[128];
    kh_esc(brush, b, (int)sizeof(b));
    kh_esc(combo, cb, (int)sizeof(cb));
    _snprintf(msg, sizeof(msg),
              "{\"type\":\"recordCaptured\",\"brush\":\"%s\",\"combo\":\"%s\"}", b, cb);
    kh_out_push(c, msg);
}

/* combo = NULL 表示取消。仅在钩子线程调用。 */
static void kh_finish_recording(const char* combo)
{
    InterlockedExchange(&g_khRecording, 0);
    g_khRecPending[0] = 0;
    SOCKET c;
    char brush[192];
    EnterCriticalSection(&g_khRecLk);
    c = g_khRecClient;
    g_khRecClient = INVALID_SOCKET;
    memcpy(brush, g_khRecBrush, sizeof(brush));
    g_khRecBrush[0] = 0;
    LeaveCriticalSection(&g_khRecLk);
    if (c == INVALID_SOCKET) return;
    char msg[384], b[256], cb[128];
    kh_esc(brush, b, (int)sizeof(b));
    if (combo) {
        kh_esc(combo, cb, (int)sizeof(cb));
        _snprintf(msg, sizeof(msg),
                  "{\"type\":\"recordResult\",\"brush\":\"%s\",\"combo\":\"%s\"}", b, cb);
    } else {
        _snprintf(msg, sizeof(msg), "{\"type\":\"recordCancel\",\"brush\":\"%s\"}", b);
    }
    kh_out_push(c, msg);
}

static void kh_start_recording(void)
{
    if (!g_khArmed) {
        kh_hlog("热键钩子已禁用，拒绝本次录制");
        kh_finish_recording(NULL);
        return;
    }
    if (!g_khHook) kh_install_hook();
    if (!g_khHook) { kh_finish_recording(NULL); return; }
    g_khRecPending[0] = 0;
    InterlockedExchange(&g_khRecording, 1);
    /* ⛔ 0x013D：录制期间必须撤掉 RegisterHotKey 抢占，否则按下的组合键
       会被系统从输入队列摘走，钩子与轮询都看不见 ⇒ 永远录不到。 */
    kh_hk_reset_for_record();
    kh_hlog("录制已开始，等待组合键…");
}

/* ===== 0x013B 键盘回调诊断（一次性/节流留痕，零 I/O）=====
 *
 * 症状（2026-10-19 用户报，三连）：热键始终失效 / 录制中按键录不到 / 已录条目加载后消失。
 * 实证：整份 pi8li.log 里「热键命中」出现 0 次、「已捕获组合键」0 次，而
 * 「录制已开始」出现多次 ⇒ 面板→C 侧指令通路正常、钩子也装着（日志有"键盘钩子已安装"），
 * 唯独**按键从来没有被处理过**。同线程、同 hMod、同安装方式的鼠标 LL 钩子工作正常
 * （`[mse]` 计数与断流期落笔推断都在跑）⇒ 回调机制本身没问题，问题必然在
 * kh_dispatch 的前置闸门里。这里给每道闸门加"首次命中"留痕，
 * 让用户按一次键就能定性，不再靠猜。
 *
 * 纪律同回调：只入队（kh_hlog），不打文件、不加锁。 */
static volatile LONG g_khDiagIn, g_khDiagFg, g_khDiagSafe, g_khDiagHiBit;

/* 钩子实际逻辑（外层 kh_proc 只负责计时熔断）。⛔ 全程零 I/O、零异常。 */
static LRESULT kh_dispatch(int nCode, WPARAM wParam, LPARAM lParam)
{
    HHOOK h = (HHOOK)g_khHook;
    /* ① 回调是否真的被系统调用（首达即留痕；完全没有这一行 = 钩子没生效） */
    if (InterlockedExchange(&g_khDiagIn, 1) == 0)
        kh_hlog("★诊断：键盘回调首次进入（nCode=%d wParam=%u）", nCode, (unsigned)wParam);

    if (g_khSafeMode) {
        if (InterlockedExchange(&g_khDiagSafe, 1) == 0)
            kh_hlog("★诊断：按键被熔断闸门整体放行（safeMode=1；见上方熔断日志）");
        return CallNextHookEx(h, nCode, wParam, lParam);
    }
    if (nCode < 0) return CallNextHookEx(h, nCode, wParam, lParam);

    int msg = (int)wParam;
    if (msg != WM_KEYDOWN && msg != WM_SYSKEYDOWN)
        return CallNextHookEx(h, nCode, wParam, lParam);

    /* 0x013C：钩子通路计数（诊断用，调度线程按秒打差分）。 */
    InterlockedIncrement(&g_khHookKeys);

    KBDLLHOOKSTRUCT* k = (KBDLLHOOKSTRUCT*)lParam;
    int vk = (int)k->vkCode;
    DWORD flags = k->flags;
    /* ⛔⛔ 0x013B：旧的 `flags & (1u<<30) ⇒ 放行` **没有任何依据** ——
       KBDLLHOOKSTRUCT.flags（LLKHF_*）只定义低字节（0x01/0x02/0x10/0x20/0x80），
       bit30 是未定义位；某些键盘驱动 / 远程输入栈 / KVM 会置高位，
       一旦置位就等于**整机所有按键被静默放行**（录制与热键同时全失灵且零日志，
       与用户实测完全一致）。LL 钩子本来就收不到自身产生的自动重复事件，
       这条过滤纯属多余。现改为只观测不拦（首次留痕）。 */
    if (flags & (1u << 30)) {
        if (InterlockedExchange(&g_khDiagHiBit, 1) == 0)
            kh_hlog("★诊断：按键带 flags 高位 0x%08lX（旧版会整体放行，现已忽略）",
                    (unsigned long)flags);
    }

    /* ===== 录制状态机（两段式）=====
       ⛔⛔ 0x013B：录制分支**前移到前台判定之前**。录制是面板显式发起的短会话
       （Esc 取消 / 关面板即取消 / 面板侧有超时），把它挂在「前台必须是 PS」上
       等于给主链路埋了单点故障：前台判定一旦算错，用户连录都录不了，
       而面板只会显示"按下组合键…"，完全无从排查。 */
    if (g_khRecording) {
        if (vk == 0x1B) {                              /* Esc 取消（两阶段通用） */
            kh_hlog("录制取消 (Esc)");
            kh_finish_recording(NULL);
            return CallNextHookEx(h, nCode, wParam, lParam);
        }
        int isMod = (vk == 0x11 || vk == 0x12 || vk == 0x10 || vk == 0x5B || vk == 0x5C);
        if (!isMod) {
            if (vk == 0x08)                            /* 退格录制期不参与任何逻辑 */
                return CallNextHookEx(h, nCode, wParam, lParam);
            if (g_khRecPending[0]) {
                if (vk == 0x0D) {                      /* Enter 确认 */
                    char confirmed[KH_COMBO_MAX];
                    memcpy(confirmed, g_khRecPending, sizeof(confirmed));
                    kh_hlog("录制确认 (Enter): %s", confirmed);
                    kh_finish_recording(confirmed);
                    return 1;                          /* 吞掉确认键，不穿透给 PS */
                }
                char recap[KH_COMBO_MAX];
                if (kh_build_combo(vk, recap, (int)sizeof(recap))) {
                    memcpy(g_khRecPending, recap, sizeof(g_khRecPending));
                    kh_dual_mark(recap);
                    kh_hlog("重新捕获组合键（待确认）: %s", recap);
                    kh_send_recording_progress(recap);
                }
                return CallNextHookEx(h, nCode, wParam, lParam);
            }
            char combo[KH_COMBO_MAX];
            if (kh_build_combo(vk, combo, (int)sizeof(combo))) {
                memcpy(g_khRecPending, combo, sizeof(g_khRecPending));
                kh_dual_mark(combo);
                kh_hlog("已捕获组合键（待确认）: %s", combo);
                kh_send_recording_progress(combo);
            }
            return CallNextHookEx(h, nCode, wParam, lParam);
        }
        return CallNextHookEx(h, nCode, wParam, lParam);
    }

    /* 焦点不在 Photoshop ⇒ 放行（用户在别的程序里打字不受影响）。
       0x013B：判定失败**必须留痕** —— 这是「按下没任何反应」的头号嫌疑点：
       若前台窗口的 pid 不在 g_khPidBuf（例如 UXP 面板浮成独立进程窗口、
       或 pid 表为空），整机按键都会被静默放行，录制与热键同时全失灵。 */
    if (!kh_ps_foreground()) {
        static DWORD s_lastFgLog;
        DWORD nowT = GetTickCount();
        if (InterlockedExchange(&g_khDiagFg, 1) == 0 || (DWORD)(nowT - s_lastFgLog) >= 2000) {
            s_lastFgLog = nowT;
            HWND fg = GetForegroundWindow();
            DWORD fp = 0;
            if (fg) GetWindowThreadProcessId(fg, &fp);
            kh_hlog("★诊断：前台判定失败 ⇒ 放行 vk=0x%02X（fgPid=%lu 本pid=%lu 表内=%d）",
                    vk, (unsigned long)fp, (unsigned long)GetCurrentProcessId(), (int)g_khPidCount);
        }
        return CallNextHookEx(h, nCode, wParam, lParam);
    }

    /* ===== 退格删绑（面板布防后，PS 前台按退格 = 请求解绑；必须吞键）===== */
    if (vk == 0x08 && g_khArmOn) {
        SOCKET c = INVALID_SOCKET;
        char owner[96];
        EnterCriticalSection(&g_khArmLk);
        c = g_khArmClient;
        memcpy(owner, g_khArmOwner, sizeof(owner));
        LeaveCriticalSection(&g_khArmLk);
        if (c != INVALID_SOCKET) {
            char m[160], ow[192];
            kh_esc(owner, ow, (int)sizeof(ow));
            _snprintf(m, sizeof(m), "{\"type\":\"backspaceDelete\",\"owner\":\"%s\"}", ow);
            kh_hlog("退格解绑请求 -> %s", owner);
            kh_out_push(c, m);
        }
        return 1;
    }

    /* ===== 热键匹配（命中入队 + 吞键，广播交给调度线程）===== */
    if (g_khActive) {
        char combo[KH_COMBO_MAX];
        if (kh_build_combo(vk, combo, (int)sizeof(combo))) {
            KhItem hit;
            if (kh_map_lookup(combo, &hit)) {
                kh_dual_mark(combo);
                kh_hit_push(hit.combo);
                return 1;                              /* 吞掉：PS 不再收到该组合键 */
            }
        }
    }
    return CallNextHookEx(h, nCode, wParam, lParam);
}

static LRESULT CALLBACK kh_proc(int nCode, WPARAM wParam, LPARAM lParam)
{
    LARGE_INTEGER t0;
    QueryPerformanceCounter(&t0);
    LRESULT result = kh_dispatch(nCode, wParam, lParam);
    if (!g_khSafeMode) {
        static LARGE_INTEGER freq;
        if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
        LARGE_INTEGER t1;
        QueryPerformanceCounter(&t1);
        LONGLONG ms = freq.QuadPart ? (t1.QuadPart - t0.QuadPart) * 1000 / freq.QuadPart : 0;
        if (ms > KH_BUDGET_MS) {
            LONG s = g_khStrikes + 1;                  /* 仅钩子线程写 */
            g_khStrikes = s;
            if (s >= KH_STRIKES) {
                InterlockedExchange(&g_khSafeMode, 1);
                InterlockedExchange(&g_khSafeSince, (LONG)GetTickCount());
                g_khBreakMs = (int)ms;
                InterlockedExchange(&g_khPendingBreakLog, 1);
            }
        } else {
            g_khStrikes = 0;                           /* 恢复即清零连续计数 */
        }
    }
    return result;
}

/* ===== 0x013C 键态轮询兜底 =====
 *
 * 为什么需要第二条路：
 *   2026-10-19 实测日志（pi8li.log）铁证：13:59 段钩子回调正常打印
 *   「★诊断：键盘回调首次进入」并逐键留痕，但 14:00:26 / 14:02:21 两次
 *   「录制已开始」之后的按键**一条回调都没有** —— 键根本没进 LL 钩子链
 *   （不是被闸门拦：拦了会留痕）。LL 钩子可能被更上层的钩子吞、被
 *   LowLevelHooksTimeout 跳过、或被输入栈绕过；而 GetAsyncKeyState 读的是
 *   窗口站键态，**不经过任何钩子链**，所以再给一条与钩子完全解耦的通路。
 *
 * 分工：
 *   - LL 钩子 = 主通路，命中即吞键（不穿透给 PS）。
 *   - 轮询   = 兜底通路，只触发不吞键；两者都活时由 kh_dual_mark 去重。
 *   - 轮询跑在钩子线程内 ⇒ 与钩子共享 g_khRecording/g_khRecPending 状态机，
 *     同一线程访问，无需任何锁。
 * ⛔ 纪律同回调：O(1)、无锁、无文件 I/O。
 */
static BYTE g_khPollWatch[256];
static volatile LONG g_khPollWatchAll;
static BYTE g_khPollPrev[256];

/* 关注位表：只轮询「热键表里真正出现过的键 + 修饰键/Enter/Esc/退格」。
 * 认不出的键名 ⇒ 置 all 退回全量轮询（宁多不漏）。 */
static void kh_poll_rebuild_watch(void)
{
    BYTE w[256];
    memset(w, 0, sizeof(w));
    w[0x11] = w[0x12] = w[0x10] = w[0x5B] = w[0x5C] = 1;   /* Ctrl/Alt/Shift/Win */
    w[0x0D] = w[0x1B] = w[0x08] = 1;                       /* Enter / Esc / 退格 */
    int all = 0;
    EnterCriticalSection(&g_khMapLk);
    KhItem* m = (KhItem*)g_khMap;
    LONG n = g_khMapCount;
    for (LONG i = 0; i < n && m; i++) {
        const char* c = m[i].combo;
        if (!c[0]) continue;
        const char* plus = strrchr(c, '+');
        const char* tok = plus ? plus + 1 : c;
        int hit = 0;
        for (int vk = 8; vk < 256 && !hit; vk++) {
            const char* t = kh_key_to_token(vk);
            if (t && _stricmp(t, tok) == 0) { w[vk] = 1; hit = 1; }
        }
        if (!hit) all = 1;
    }
    LeaveCriticalSection(&g_khMapLk);
    memcpy((void*)g_khPollWatch, w, sizeof(w));
    InterlockedExchange(&g_khPollWatchAll, all);
}

/* 单键按下沿（轮询专用）：与钩子共用同一套状态机、同一张热键表。 */
static void kh_poll_edge(int vk)
{
    char combo[KH_COMBO_MAX];
    int haveCombo = kh_build_combo(vk, combo, (int)sizeof(combo));

    /* 去重：钩子已消费同一组合键（≤400ms）⇒ 本次是同一击的影子。 */
    if (haveCombo &&
        (DWORD)(GetTickCount() - (DWORD)g_khLastTick) <= 400 &&
        _stricmp(g_khLastCombo, combo) == 0)
        return;

    if (g_khRecording) {
        if (vk == 0x1B) { kh_hlog("录制取消 (Esc·轮询)"); kh_finish_recording(NULL); return; }
        if (vk == 0x11 || vk == 0x12 || vk == 0x10 || vk == 0x5B || vk == 0x5C) return;
        if (vk == 0x08) return;
        if (g_khRecPending[0]) {
            if (vk == 0x0D) {
                char c[KH_COMBO_MAX];
                memcpy(c, g_khRecPending, sizeof(c));
                kh_hlog("录制确认 (Enter·轮询): %s", c);
                kh_finish_recording(c);
                return;
            }
            if (haveCombo) {
                memcpy(g_khRecPending, combo, sizeof(g_khRecPending));
                kh_hlog("重新捕获组合键（待确认·轮询）: %s", combo);
                kh_send_recording_progress(combo);
            }
            return;
        }
        if (haveCombo) {
            memcpy(g_khRecPending, combo, sizeof(g_khRecPending));
            kh_hlog("已捕获组合键（待确认·轮询）: %s", combo);
            kh_send_recording_progress(combo);
        }
        return;
    }

    if (!kh_ps_foreground()) return;       /* 与钩子同语义：不在 PS 里就不响应 */

    if (vk == 0x08 && g_khArmOn) {
        SOCKET c = INVALID_SOCKET;
        char owner[96];
        EnterCriticalSection(&g_khArmLk);
        c = g_khArmClient;
        memcpy(owner, g_khArmOwner, sizeof(owner));
        LeaveCriticalSection(&g_khArmLk);
        if (c != INVALID_SOCKET) {
            char m[160], ow[192];
            kh_esc(owner, ow, (int)sizeof(ow));
            _snprintf(m, sizeof(m), "{\"type\":\"backspaceDelete\",\"owner\":\"%s\"}", ow);
            kh_hlog("退格解绑请求（轮询） -> %s", owner);
            kh_out_push(c, m);
        }
        return;
    }

    if (g_khActive && haveCombo) {
        KhItem hit;
        if (kh_map_lookup(combo, &hit)) {
            /* ⛔ 轮询**不**记账：kh_dual_mark 是给「钩子已消费这一击」留的指纹，
               轮询若自己也写，400ms 内的第二次同键会被自己误判成影子而吞掉
               （用户连按 Shift+E 切清除模式，第二下就没反应）。 */
            kh_hit_push(hit.combo);
        }
    }
}

/* ===== 0x013D RegisterHotKey 抢占通路（唯一能真正吞掉按键的一路）=====
 *
 * 为什么需要它：
 *   0x013C 的轮询兜底让热键「能触发」了，但轮询**吞不了键** —— 用户实测：
 *   套索模式按 Shift+E 切清除模式时，PS 同时把自己的橡皮擦循环触发了；
 *   按 Alt+Shift+<key> 改面板混合模式时，活动图层的混合模式也跟着变。
 *   根因是 LL 钩子在这些场景收不到键（0x013C 已证），而键态轮询只能"旁观"。
 *
 *   RegisterHotKey 是系统级独占：注册成功后该组合键**从输入队列里被摘走**，
 *   任何窗口（包括 PS 自己）都收不到，只有本线程收到 WM_HOTKEY。这才叫真吞键。
 *
 * 约束与取舍：
 *   1) RegisterHotKey 必须有修饰键（Ctrl/Alt/Shift/Win）⇒ 裸键（L、Num1…）
 *      注册不了，仍由钩子/轮询承载（这两种本来就该让 PS 收到，语义一致）。
 *   2) 注册是**全局独占**，所以只在 PS 前台时挂、失焦立刻全撤 —— 否则用户在
 *      别的程序里按 Ctrl+Q / Shift+E 也会被吞掉。
 *   3) 录制期间必须全撤，否则按下的组合键会被系统摘走，钩子与轮询都看不见。
 *   4) 注册失败（已被别的程序占用）只留痕一次，自动退回钩子/轮询（不吞键）。
 *
 * ⛔ 全部状态只在钩子线程读写（kh_hk_sync / WM_HOTKEY 处理都在该线程）。 */
#define KH_HK_MAX 64
static int  g_khHkUsed[KH_HK_MAX];
static char g_khHkCombo[KH_HK_MAX][KH_COMBO_MAX];
static LONG g_khHkStamp = -1;
static int  g_khHkFailLogged;

/* "Ctrl+Alt+Shift+K" → (MOD_*, vk)。裸键返回 0（RegisterHotKey 不接受）。 */
static int kh_combo_to_hotkey(const char* combo, int* mods, int* vk)
{
    int m = 0, v = 0;
    const char* p = combo;
    while (*p) {
        char tok[32];
        int n = 0;
        while (*p && *p != '+' && n < (int)sizeof(tok) - 1) tok[n++] = *p++;
        tok[n] = 0;
        if (*p == '+') p++;
        if (!tok[0]) continue;
        if (_stricmp(tok, "Ctrl") == 0)       m |= MOD_CONTROL;
        else if (_stricmp(tok, "Alt") == 0)   m |= MOD_ALT;
        else if (_stricmp(tok, "Shift") == 0) m |= MOD_SHIFT;
        else if (_stricmp(tok, "Win") == 0)   m |= MOD_WIN;
        else {
            for (int k = 8; k < 256; k++) {
                const char* t = kh_key_to_token(k);
                if (t && _stricmp(t, tok) == 0) { v = k; break; }
            }
        }
    }
    if (!v || !m) return 0;
    *mods = m;
    *vk = v;
    return 1;
}

static void kh_hk_clear(void)
{
    for (int i = 0; i < KH_HK_MAX; i++) {
        if (g_khHkUsed[i]) { UnregisterHotKey(NULL, i + 1); g_khHkUsed[i] = 0; }
    }
}

/* 录制开始前调用（钩子线程）：先全撤，否则按下的组合键会被系统摘走。 */
static void kh_hk_reset_for_record(void)
{
    kh_hk_clear();
    g_khHkStamp = 0;
}

/* 同步注册集合：want = 插件在位 ∧ 布防 ∧ 非录制 ∧ 非熔断 ∧ PS 前台。 */
static void kh_hk_sync(void)
{
    int want = (g_khPlug && g_khArmed && !g_khRecording && !g_khSafeMode && !g_khSrvStop &&
                kh_ps_foreground()) ? 1 : 0;
    LONG stamp = want ? (LONG)(1000000 + g_khMapSeq) : 0;
    if (stamp == g_khHkStamp) return;
    g_khHkStamp = stamp;
    kh_hk_clear();
    if (!want) return;

    KhItem snap[KH_MAX_ITEMS];
    int n = 0;
    EnterCriticalSection(&g_khMapLk);
    KhItem* m = (KhItem*)g_khMap;
    LONG cnt = g_khMapCount;
    for (LONG i = 0; i < cnt && m && n < KH_MAX_ITEMS; i++) snap[n++] = m[i];
    LeaveCriticalSection(&g_khMapLk);

    int ok = 0, bad = 0, bare = 0;
    for (int i = 0; i < n && ok < KH_HK_MAX; i++) {
        int mods = 0, vk = 0;
        if (!kh_combo_to_hotkey(snap[i].combo, &mods, &vk)) { bare++; continue; }
        int id = ok + 1;
        if (!RegisterHotKey(NULL, id, (UINT)(mods | MOD_NOREPEAT), (UINT)vk)) { bad++; continue; }
        g_khHkUsed[id - 1] = 1;
        _snprintf(g_khHkCombo[id - 1], KH_COMBO_MAX, "%s", snap[i].combo);
        ok++;
    }
    kh_log("RegisterHotKey 接管 %d 条（裸键交给钩子/轮询 %d 条，被占用 %d 条）", ok, bare, bad);
    if (bad && !g_khHkFailLogged) {
        g_khHkFailLogged = 1;   /* 只提示一次，避免前台来回切换刷屏 */
        kh_log("⚠️ 部分组合键已被其它程序注册为全局热键 ⇒ 这些键只能退回「不吞键」模式");
    }
}

/* WM_HOTKEY 兑现（由钩子线程消息泵调用）。 */
static void kh_hk_fire(int id)
{
    if (id < 1 || id > KH_HK_MAX || !g_khHkUsed[id - 1]) return;
    const char* combo = g_khHkCombo[id - 1];
    KhItem hit;
    if (!kh_map_lookup(combo, &hit)) return;
    kh_dual_mark(combo);          /* 轮询仍能读到键况 ⇒ 必须记账，防重复触发 */
    kh_hit_push(hit.combo);
}

/* 一拍轮询。prev 表**无条件**刷新（包括撤防期），这样撤防→布防的切换
 * 不会凭旧状态造出假按下沿。 */
static void kh_poll_step(void)
{
    /* 关注位表在钩子线程内重建（kh_key_to_token 的返回缓冲是 static）。 */
    if (InterlockedExchange(&g_khWatchDirty, 0)) kh_poll_rebuild_watch();

    /* 100ms 一次：按「插件在位 ∧ 布防 ∧ 非录制 ∧ 非熔断 ∧ PS 前台」同步注册集合。
       注册/注销必须跟住前台切换，否则会在别的程序里吞掉用户按键。 */
    static DWORD s_hkTick;
    DWORD nowT = GetTickCount();
    if ((DWORD)(nowT - s_hkTick) >= 100) { s_hkTick = nowT; kh_hk_sync(); }

    BYTE cur[256];
    for (int vk = 0; vk < 256; vk++)
        cur[vk] = (BYTE)((GetAsyncKeyState(vk) & 0x8000) ? 1 : 0);

    /* 0x0205：轮询兜底同样要求在位 —— 插件不在位时轮询只刷新 prev 表（消假沿），
       绝不触发热键（这一路虽然吞不了键，但触发了照样没人执行，纯噪声）。 */
    int armed = (g_khPlug && g_khArmed && !g_khSafeMode && !g_khSrvStop) ? 1 : 0;
    int all = (g_khRecording || g_khPollWatchAll) ? 1 : 0;
    for (int vk = 7; vk < 256; vk++) {
        BYTE p = g_khPollPrev[vk];
        g_khPollPrev[vk] = cur[vk];
        if (!armed || !cur[vk] || p) continue;
        if (!all && !g_khPollWatch[vk]) continue;
        InterlockedIncrement(&g_khPollKeys);
        kh_poll_edge(vk);
    }
}

static void kh_install_hook(void)
{
    if (g_khHook) return;
    if (!g_khPlug) {
        /* 0x0205：插件本体不在位（UXP 未加载/面板未开）⇒ 绝不装钩子。
           用户画图时 PS 原生快捷键（L、NUM1…）必须原样透传。 */
        kh_hlog("插件本体不在位（18923 无客户端），不装键盘钩子");
        return;
    }
    if (!g_khBound) {
        /* 单持有者纪律：没拿到 18923 的实例不装钩子（多 PS 实例下只有
           端口持有者响应热键，与 daemon「一个进程一套钩子」等价）。 */
        kh_hlog("未持有 18923，不装键盘钩子");
        return;
    }
    HHOOK h = (HHOOK)(UINT_PTR)SetWindowsHookExW(WH_KEYBOARD_LL, kh_proc, g_hSelf, 0);
    if (!h) {
        kh_log("❌ 键盘钩子安装失败 err=%lu", GetLastError());
        return;
    }
    InterlockedExchangePointer((PVOID*)&g_khHook, h);
    kh_log("键盘钩子已安装（WH_KEYBOARD_LL，hMod=0x%p）", (void*)(UINT_PTR)g_hSelf);
}

static void kh_uninstall_hook(void)
{
    HHOOK h = (HHOOK)g_khHook;
    if (!h) return;
    InterlockedExchangePointer((PVOID*)&g_khHook, NULL);
    UnhookWindowsHookEx(h);
    kh_log("键盘钩子已卸载");
    /* 钩子没了就不可能再收到录制按键：清掉录制态，避免面板停在「等待按键」。 */
    if (g_khRecording) kh_finish_recording(NULL);
    else g_khRecPending[0] = 0;
}

/* ================================================================ 鼠标左键事件镜像（0x012D）
 *
 * 为什么平滑引擎需要它：
 *   驱动一旦停投递（本项目的常态故障），进程内拿不到**任何**真包 ⇒ 连「笔现在按没按着」
 *   都不知道。合成包必须知道这件事：buttons=0 的包 PS 只会挪光标、绝不落笔；buttons=1
 *   才会继续延长套索路径。真机 jwwh-21032 铁证：13.1s 空档里补流喂了 695 包，可当时
 *   `tip=0`（空档开始时笔正好抬着）⇒ 用户连画 4 笔一笔都没出来，也永不自愈。
 *
 * 为什么是**事件**而不是 `GetAsyncKeyState` 的**电平**：
 *   0x012B 试过电平（第三道守卫），jwwh-6468 全场 `补发=0` 就是被它判死的。
 *   电平会漂（Wintab 独占时笔尖走自己的按钮通路，鼠标模拟不保证一直保持按下态），
 *   而且 250Hz 轮询还会漏掉短按。`WH_MOUSE_LL` 收到的是系统派发的**消息本身**：
 *   按下/抬起各一次，带坐标与时刻，不漏、不漂。
 *
 * ⛔ 回调铁律同键盘钩子：O(1)、无锁、无文件 I/O、恒 CallNextHookEx（绝不吞事件）。
 * ⛔ 本镜像只**记状态**，不做任何决策、不注入、不改写 —— 判定全在平滑引擎侧，
 *    且只在「真实通路已死」的窗口里使用（见 smooth_engine.c 的 0x012D 段）。 */
static volatile LONG  g_mseDown;      /* 最近一次左键消息的按下态（1=按下） */
static volatile LONG  g_mseX, g_mseY; /* 该消息发生时的屏幕坐标 */
static volatile LONG  g_mseT;         /* 该消息的时刻（GetTickCount） */
static volatile LONG  g_mseDn, g_mseUp;   /* 累计按下 / 抬起次数 */
static HHOOK volatile g_mseHook;

static LRESULT CALLBACK kh_mse_proc(int code, WPARAM w, LPARAM l)
{
    if (code == HC_ACTION && (w == WM_LBUTTONDOWN || w == WM_LBUTTONUP)) {
        const MSLLHOOKSTRUCT* m = (const MSLLHOOKSTRUCT*)l;
        if (m) { g_mseX = m->pt.x; g_mseY = m->pt.y; }
        g_mseT = (LONG)GetTickCount();
        if (w == WM_LBUTTONDOWN) { g_mseDown = 1; g_mseDn++; }
        else                     { g_mseDown = 0; g_mseUp++; }
    }
    return CallNextHookEx(NULL, code, w, l);
}

static void kh_install_mouse_hook(void)
{
    if (g_mseHook) return;
    HHOOK h = (HHOOK)(UINT_PTR)SetWindowsHookExW(WH_MOUSE_LL, kh_mse_proc, g_hSelf, 0);
    if (!h) {
        /* 失败只报一次（看护每 5s 重试，别把日志刷成噪音）。 */
        static int s_errLogged;
        if (!s_errLogged) {
            s_errLogged = 1;
            kh_log("❌ 鼠标钩子安装失败 err=%lu（补流将无法推断落笔，退回旧行为）",
                   GetLastError());
        }
        return;
    }
    InterlockedExchangePointer((PVOID*)&g_mseHook, h);
    kh_log("鼠标左键镜像已安装（WH_MOUSE_LL：断流期落笔推断用，只记状态）");
}

static void kh_uninstall_mouse_hook(void)
{
    HHOOK h = (HHOOK)g_mseHook;
    if (!h) return;
    InterlockedExchangePointer((PVOID*)&g_mseHook, NULL);
    UnhookWindowsHookEx(h);
    g_mseDown = 0;
}

int keyhook_mouse_state(int* down, int* x, int* y, unsigned long* t, int* dn, int* up)
{
    LONG tt = g_mseT;
    if (down) *down = (int)g_mseDown;
    if (x)    *x    = (int)g_mseX;
    if (y)    *y    = (int)g_mseY;
    if (t)    *t    = (unsigned long)tt;
    if (dn)   *dn   = (int)g_mseDn;
    if (up)   *up   = (int)g_mseUp;
    /* 返回「这条通路到底有没有数据」。恒 0 ⇒ 该驱动/笔根本不产生鼠标消息，
       调用方必须退回旧行为（绝不能把 0 当成「笔抬着」）。 */
    return (g_mseDn || g_mseUp) ? 1 : 0;
}

/* ================================================================ 线程 */

/* 钩子线程：独立消息循环，承载 WH_KEYBOARD_LL 与 WH_MOUSE_LL。
   ⛔ 每轮包 try 的等价物：C 无 SEH，所有调用点自身防御（句柄检查+零除防护）；
      线程死 = 钩子被系统摘除且指令石沉大海 ⇒ 看护线程负责重建。 */
static DWORD WINAPI kh_hook_thread(LPVOID param)
{
    (void)param;
    g_khRecThreadId = GetCurrentThreadId();
    MSG msg;
    PeekMessage(&msg, NULL, WM_USER, WM_USER, PM_NOREMOVE);   /* 建线程消息队列 */
    SetEvent(g_khThreadReady);
    kh_log("钩子线程已启动 tid=%lu", g_khRecThreadId);
    /* ⛔ 0x012D：鼠标左键镜像**与布防无关**（平滑不是热键功能，撤防也得有落笔证据）。
       装在本线程是唯一选择：LL 钩子的回调由「装它的那个线程」的消息循环驱动，
       而本线程是进程内唯一常驻消息泵。 */
    kh_install_mouse_hook();

    for (;;) {
        /* 安装/卸载意图（轮询兜底：posts 只降延迟，丢消息也不死人） */
        if (InterlockedExchange(&g_khReinstall, 0)) {
            HHOOK cur = (HHOOK)g_khHook;
            /* 0x013D：录制中不重装 —— kh_uninstall_hook 会顺手取消录制，
               而录制正是「钩子失活」时用户最需要轮询兜底撑住的场景。
               挂回去的意图保留到录制结束后的下一轮。 */
            if (cur && g_khRecording) InterlockedExchange(&g_khReinstall, 1);
            else if (cur) kh_uninstall_hook();
        }
        /* 安装意图三判据 + 0x0205 第四判据（插件本体在位）。
           ⚠️ kh_install_hook 内部也查 g_khPlug（双保险，防将来新增调用点漏闸）。 */
        int want = (g_khBound && g_khArmed && !g_khSrvStop && g_khPlug) ? 1 : 0;
        HHOOK cur = (HHOOK)g_khHook;
        if (want && !cur) kh_install_hook();
        else if (!want && cur) kh_uninstall_hook();

        /* 0x012D：鼠标左键镜像的看护。⛔ 它**与布防无关**（平滑不是热键功能），
           但同样会被系统在回调超预算时静默摘掉 ⇒ 每 5s 检查一次、缺了重挂。 */
        if (!(HHOOK)g_mseHook && !g_khSrvStop) {
            static DWORD s_mseTry;
            DWORD nowT = GetTickCount();
            if (!s_mseTry || (DWORD)(nowT - s_mseTry) > 5000) {
                s_mseTry = nowT;
                kh_install_mouse_hook();
            }
        }

        /* 录制请求 */
        LONG rr = InterlockedExchange(&g_khRecReq, 0);
        if (rr == 1) kh_start_recording();
        else if (rr == 2) kh_finish_recording(NULL);

        if (g_khStop) break;

        while (PeekMessage(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) {
                InterlockedExchange(&g_khStop, 1);
                goto quit;
            }
            if (msg.message == WM_KH_RECSTART) InterlockedExchange(&g_khRecReq, 1);
            else if (msg.message == WM_KH_RECSTOP) InterlockedExchange(&g_khRecReq, 2);
            else if (msg.message == WM_HOTKEY) kh_hk_fire((int)msg.wParam);
            /* WM_KH_INSTALL/UNINSTALL 仅作唤醒；安装意图由上面的轮询覆盖 */
        }
        /* 0x013C：键态轮询兜底（10ms 一拍）。钩子可能整段收不到键，
           这条通路不经过任何钩子链，是热键与录制的最低保障。 */
        kh_poll_step();
        MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
    }
quit:
    kh_uninstall_hook();
    kh_uninstall_mouse_hook();
    kh_hk_clear();
    kh_log("钩子线程已退出");
    return 0;
}

/* 调度线程：热键命中广播 + 出站队列代发 + 钩子日志代打（≤20ms 延迟）。 */
static DWORD WINAPI kh_dispatch_thread(LPVOID param)
{
    (void)param;
    kh_log("调度线程已启动（热键广播/出站代发/日志代打）");
    LONG lastDrops = 0;
    LONG lastHK = 0, lastPK = 0;
    DWORD lastStat = GetTickCount();
    while (!g_khStop) {
        WaitForSingleObject(g_khWake, 20);

        /* ================================ 0x0208：宿主交互态边沿（左键 / 空格）
         *
         * 为什么要这条消息（用户报：加载插件后 PS 自带缩放工具 / Ctrl+空格拖拽缩放
         * 变卡顿、抽搐）：
         *   缩放（含 scrubby zoom 与 Animated Zoom）是**宿主主线程上的交互式动画**，
         *   它不派发本插件注册过的任何 PS 通知事件（见 psAccess.PS_NOTIF_EVENTS）
         *   ⇒ 面板侧 isPsBusy() 全程为假、三条常驻巡检照常在动画期间发 psRead()。
         *   而 psRead 的本质是 executeAsModal —— **独占宿主主线程**的模态作用域，
         *   稳态按 MIN_MODAL_GAP_MS=300 排队 ⇒ 每 333ms 抢一次。一次缩放动画只有
         *   300~500ms ⇒ 每次都被劈成两段，正对应用户看到的「卡顿、抽搐」。
         *   ⇒ 由进程内这一侧（唯一能看见全局键/鼠标状态的地方）按**边沿**把
         *     「宿主正在被拖拽/缩放」推给面板，面板据此让路（utils/hostInteraction.ts）。
         *
         * ⛔ 帧率：边沿 + 忙态 2s 保活（约 30 字节/帧）。只发边沿的风险是丢帧或
         *    面板中途重连会让忙态粘住；保活把这种情况收敛到 2s 内，面板侧另有
         *    「忙态最长 30s」兜底自愈。
         * ⛔ 判据刻意窄（左键 ∨ 空格）：
         *    · 左键 = 所有鼠标拖拽（缩放工具、Ctrl+空格拖拽、滑块拖动…）；
         *    · 空格 = PS 的抓手/缩放导航修饰键；
         *    · **笔尖落笔不算**（Wintab 通路里笔尖不是鼠标左键）⇒ 正常绘画不受影响，
         *      绘画期的宿主忙碌仍由 isPsBusy() + 通知事件负责，此处不重复。
         * ⛔ 本线程不在钩子回调里（20ms 调度线程）⇒ GetAsyncKeyState/发送都允许。 */
        {
            static int   s_hbPrev = -1;
            static DWORD s_hbLast;
            int hb = 0;
            if (GetAsyncKeyState(VK_LBUTTON) & 0x8000) hb = 1;
            else if (GetAsyncKeyState(VK_SPACE) & 0x8000) hb = 1;
            DWORD nowHb = GetTickCount();
            /* ⛔ 边沿 + 「忙态」2s 保活：只有边沿的话，一旦丢帧或面板中途重连，
               面板会把忙态粘住（虽然它自己有 30s 兜底，但 30s 的巡检停摆不可接受）。
               保活只在**按着的时候**发（拖拽期），松手后靠那一条 0 边沿收尾。 */
            if (hb != s_hbPrev || (hb && (DWORD)(nowHb - s_hbLast) >= 2000)) {
                s_hbPrev = hb;
                s_hbLast = nowHb;
                char j[48];
                _snprintf(j, sizeof(j), "{\"type\":\"hostBusy\",\"v\":%d}", hb);
                kh_broadcast(j);
            }
        }

        /* 0x013C：双路按键差分（每秒最多一条，仅有增量时打）。
           判读口径：只有「轮询 +N」而「钩子 +0」= 键没进 LL 钩子链；
           两条都涨 = 钩子正常。 */
        DWORD nowS = GetTickCount();
        if ((DWORD)(nowS - lastStat) >= 1000) {
            LONG hk = g_khHookKeys, pk = g_khPollKeys;
            if (hk != lastHK || pk != lastPK) {
                kh_log("按键通路：钩子 +%ld / 轮询 +%ld（累计 钩子=%ld 轮询=%ld）",
                       hk - lastHK, pk - lastPK, hk, pk);
                /* 0x013D：钩子失活自愈。
                   ⛔ 现象（2026-10-19 实测）：累计 钩子 停在同一数值后再不动，而轮询
                      每秒都有增量 —— 键明明在系统里，LL 钩子却一条都收不到。
                      原因不是回调太慢（那样会留熔断日志），而是钩子被**静默摘除**
                      或被更上层的钩子压在链尾（PS 自己的全局键盘管理器就会后装）。
                      原看护判据是 `!g_khHook` —— 句柄非空就认为活着，于是永不重装。
                   ⇒ 判据改成「轮询有货、钩子零货」这个**阳性证据**，卸载重装一次
                      抢回链头（LL 钩子链是后装先调）。带指数退避，避免抖动。 */
                if (hk == lastHK && pk > lastPK) {
                    static DWORD s_forceAt;
                    static int   s_forceN;
                    DWORD cool = s_forceN <= 0 ? 3000 : (s_forceN == 1 ? 10000 : 30000);
                    if (!s_forceAt || (DWORD)(nowS - s_forceAt) >= cool) {
                        s_forceAt = nowS;
                        s_forceN++;
                        InterlockedExchange(&g_khReinstall, 1);
                        kh_log("钩子失活（轮询 +%ld / 钩子 +0）⇒ 第 %d 次强制重装",
                               pk - lastPK, s_forceN);
                    }
                }
                lastHK = hk; lastPK = pk;
            }
            lastStat = nowS;
        }

        /* ① 钩子日志代打 */
        for (;;) {
            LONG t = g_khHlogTail, h = g_khHlogHead;
            if (h == t) break;
            char line[KH_HLOG_L];
            memcpy(line, g_khHlog[h % KH_HLOG_N], KH_HLOG_L);
            line[KH_HLOG_L - 1] = 0;
            g_khHlogHead = h + 1;
            kh_log("%s", line);
        }

        /* ② 出站队列（recordCaptured/Result/Cancel、backspaceDelete） */
        for (;;) {
            LONG t = g_khOutTail, h = g_khOutHead;
            if (h == t) break;
            KhOut e;
            memcpy(&e, &g_khOutQ[h % KH_OUTQ], sizeof(e));
            g_khOutHead = h + 1;
            if (!wc_send_text_lk(e.s, e.msg, &g_khSendLk)) kh_cli_mark_close(e.s);
        }

        /* ③ 热键命中广播 */
        for (;;) {
            LONG t = g_khHitTail, h = g_khHitHead;
            if (h == t) break;
            char combo[KH_COMBO_MAX];
            memcpy(combo, g_khHitQ[h % KH_HITQ], KH_COMBO_MAX);
            combo[KH_COMBO_MAX - 1] = 0;
            g_khHitHead = h + 1;
            KhItem it;
            if (kh_map_lookup_locked(combo, &it)) {
                char m[512], idE[96], cbE[128], acE[96], brE[256];
                kh_esc(it.id,     idE, (int)sizeof(idE));
                kh_esc(it.combo,  cbE, (int)sizeof(cbE));
                kh_esc(it.action, acE, (int)sizeof(acE));
                kh_esc(it.brush,  brE, (int)sizeof(brE));
                _snprintf(m, sizeof(m),
                          "{\"type\":\"hotkey\",\"id\":\"%s\",\"combo\":\"%s\","
                          "\"action\":\"%s\",\"brush\":\"%s\"}",
                          idE, cbE, acE, brE);
                kh_log("热键命中: %s -> %s%s%s", it.combo, it.action,
                       it.brush[0] ? " / " : "", it.brush);
                kh_broadcast(m);
            }
        }

        /* 命中环溢出留痕（静默丢 = 热键莫名不触发，必须可见） */
        {
            LONG d = g_khHitDrops;
            if (d != lastDrops) {
                kh_log("⚠️ 热键命中环溢出，丢弃 %ld 次（广播跟不上触发）", (long)(d - lastDrops));
                lastDrops = d;
            }
        }
    }
    kh_log("调度线程已退出");
    return 0;
}

/* 看护线程（Program.cs HotkeyWatchdog 逐字移植）。 */
static DWORD WINAPI kh_watchdog_thread(LPVOID param)
{
    (void)param;
    int repArmed = 1, repHook = 0, repSafe = 0;
    int candArmed = 1, candHook = 0, candSafe = 0, haveCand = 0;
    DWORD lastHealth = 0, lastPs = 0, lastCfg = 0;
    for (;;) {
        if (g_khStop) break;
        Sleep(120);
        DWORD now = GetTickCount();

        /* ① 线程存活探针（线程死 ⇒ 钩子被摘 + 指令石沉大海 ⇒ 重建） */
        if (g_khHookThread && WaitForSingleObject(g_khHookThread, 0) == WAIT_OBJECT_0) {
            kh_log("⚠️ 钩子线程已不存活，正在重建…");
            CloseHandle(g_khHookThread);
            g_khHookThread = NULL;
            g_khHookThread = CreateThread(NULL, 0, kh_hook_thread, NULL, 0, NULL);
            /* 新线程按当前 bound/armed 自行装配；指令队列就绪前 posts 失败无害 */
        }

        /* ①.5 代打熔断日志（钩子回调严禁 I/O ⇒ 由本线程取走打印） */
        if (InterlockedExchange(&g_khPendingBreakLog, 0)) {
            kh_log("⚠️ 键盘钩子连续 %d 次回调超预算（最近 %dms / 预算 %dms），"
                   "已降级为纯放行：此后不再处理按键，避免拖累系统输入。（%ds 后自动复位并重挂）",
                   KH_STRIKES, (int)g_khBreakMs, KH_BUDGET_MS, KH_COOLDOWN_MS / 1000);
        }

        /* ② 熔断自愈：冷却期满复位 + 请求重挂 */
        if (g_khSafeMode) {
            LONG since = g_khSafeSince;
            if (since && now - (DWORD)since >= (DWORD)KH_COOLDOWN_MS) {
                InterlockedExchange(&g_khSafeMode, 0);
                InterlockedExchange(&g_khSafeSince, 0);
                InterlockedExchange(&g_khStrikes, 0);
                if (g_khBound && g_khArmed) InterlockedExchange(&g_khReinstall, 1);
                kh_log("键盘钩子熔断冷却期满，已复位（下轮重挂）");
            }
        }

        /* ③ 跃变广播（连续两轮一致且与上次上报不同才播，消除安装中间帧） */
        {
            int ca = g_khArmed ? 1 : 0, ch = g_khHook ? 1 : 0, cs = g_khSafeMode ? 1 : 0;
            if (haveCand && ca == candArmed && ch == candHook && cs == candSafe &&
                (ca != repArmed || ch != repHook || cs != repSafe)) {
                repArmed = ca; repHook = ch; repSafe = cs;
                char st[512];
                kh_build_hotkey_state(st, (int)sizeof(st));
                kh_broadcast(st);
            }
            candArmed = ca; candHook = ch; candSafe = cs; haveCand = 1;
        }

        /* ④ 2s 句柄看护（刻意不做定时无条件重挂：重挂窗口会漏键）。
           0x0205：g_khPlug 不在位时钩子为空是正常态，别报假警。 */
        if (now - lastHealth >= 2000) {
            lastHealth = now;
            if (g_khBound && g_khArmed && g_khPlug && !g_khHook)
                kh_log("⚠️ 热键已布防但键盘钩子句柄为空（轮询兜底将重挂）");
        }

        /* ⑤ 3s 刷 PS PID 集合 */
        if (now - lastPs >= 3000) { lastPs = now; kh_refresh_ps_pids(); }

        /* ⑥ 1s 配置 mtime 轮询（FileSystemWatcher 的进程内等价物） */
        if (now - lastCfg >= 1000) { lastCfg = now; kh_poll_config_file(); }

        /* ⑦ 启动兜底（0x0123，只做一次）：init 里那次 kh_reload 可能撞上配置文件
           暂时不可读（PS 启动瞬间 PluginData 正在被面板写 / AV 在扫），失败分支会
           **保留旧表**（= 空），而 ⑥ 的 mtime 轮询只在文件变化时才重载 ⇒ 没有面板
           保存动作就永远空表。启动 1.5s 后若「表为空 + 文件确实存在」，强制补一次。 */
        {
            static DWORD s_bootMs;
            static int   s_bootTried;
            if (!s_bootMs) s_bootMs = now;
            if (!s_bootTried && (DWORD)(now - s_bootMs) >= 1500) {
                s_bootTried = 1;
                if (kh_map_count() == 0) {
                    wchar_t bp[512];
                    kh_cfg_snapshot(bp, 512);
                    if (GetFileAttributesW(bp) != INVALID_FILE_ATTRIBUTES) {
                        kh_log("启动兜底：热键表为空但配置文件存在 ⇒ 强制重载一次");
                        kh_reload();
                    }
                }
            }
        }
    }
    kh_log("看护线程已退出");
    return 0;
}

static void kh_refresh_ps_pids(void)
{
    DWORD buf[KH_PSPID_MAX];
    int n = 0;
    HANDLE h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (h != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe;
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(h, &pe)) {
            do {
                if (n < KH_PSPID_MAX && _wcsicmp(pe.szExeFile, L"photoshop.exe") == 0)
                    buf[n++] = pe.th32ProcessID;
            } while (Process32NextW(h, &pe));
        }
        CloseHandle(h);
    }
    int idx = (g_khPidIdx == 0) ? 1 : 0;
    if (n > 0) memcpy(g_khPidBuf[idx], buf, sizeof(DWORD) * (size_t)n);
    g_khPidCount = n;
    InterlockedExchange(&g_khPidIdx, idx);
}

/* ================================================================ 旧版 daemon 迁移 */

/* bind 18923 失败时探测占用者：确认是旧版 HotkeyDaemon（version 2026-10-12.x）
   就以 WS 客户端发 uninstall，令其自清自启+安装目录后退出；下一轮重试即可接管。
   ⛔ 绝不误伤：握手失败 / 非旧版版本号 ⇒ 什么都不做，只保持重试。
   ⛔ 0x0205：path 必须用 "/jw-migrate" 自报身份 —— 占用者若是新版 .8li，
   这条连接会被标记 notPlugin，**不会**给对方伪造「插件本体在位」。 */
static void kh_try_migrate(void)
{
    DWORD now = GetTickCount();
    if (now - g_khLastMigrate < 10000) return;          /* 10s 内不重复探测 */
    g_khLastMigrate = now;

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(KH_PORT);
    if (connect(s, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        closesocket(s);
        return;                                          /* 没人在听 ⇒ 无需迁移 */
    }
    DWORD to = 1500;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&to, sizeof(to));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&to, sizeof(to));
    if (wc_client_handshake(s, KH_PORT, "/jw-migrate") != 0) {
        closesocket(s);
        kh_log("迁移探测：18923 有占用但握手失败（非 WS 服务？），不处理");
        return;
    }
    wc_send_masked(s, "{\"type\":\"getState\"}");
    /* ⛔ 32KB：getState 内嵌全部 combos（daemon 上限 256 条约 6.5KB），
       2048 会把旧版应答截成 -3（异常大帧）⇒ 误判"非旧版"而永不迁移。 */
    static char mbuf[32768];
    int op = 0, fin = 0;
    int n = wc_read_frame(s, mbuf, (int)sizeof(mbuf), &op, &fin);
    if (n > 0 && strstr(mbuf, "\"version\":\"2026-10-12")) {
        kh_log("检测到旧版 HotkeyDaemon（2026-10-12.x）⇒ 发卸载指令令其自清自启+目录后退出");
        wc_send_masked(s, "{\"type\":\"uninstall\"}");
        Sleep(800);                                      /* 等它退出（DoUninstall→Exit） */
    } else {
        kh_log("18923 占用者不是旧版守护进程（无 getState 应答），仅保持重试");
    }
    closesocket(s);
}

/* ================================================================ WS 18923 服务器 */

static DWORD WINAPI kh_server_thread(LPVOID param)
{
    (void)param;
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        kh_log("WSAStartup 失败");
        return 1;
    }
    SOCKET ls = INVALID_SOCKET;
    while (!g_khStop && !g_khSrvStop) {
        ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (ls == INVALID_SOCKET) { kh_log("socket 失败 %d", WSAGetLastError()); return 1; }
        BOOL reuse = TRUE;
        setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));
        struct sockaddr_in addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons(KH_PORT);
        if (bind(ls, (struct sockaddr*)&addr, sizeof(addr)) == 0) break;
        kh_log("bind 18923 失败 %d（旧版 HotkeyDaemon 或其它 PS 实例占用）", WSAGetLastError());
        closesocket(ls);
        ls = INVALID_SOCKET;
        kh_try_migrate();
        Sleep(3000);
    }
    if (ls == INVALID_SOCKET) {
        kh_log("WS 18923 服务器线程退出（未监听）");
        return 0;
    }
    if (listen(ls, 4) != 0) {
        kh_log("listen 失败 %d", WSAGetLastError());
        closesocket(ls);
        return 1;
    }
    g_khListen = ls;
    InterlockedExchange(&g_khBound, 1);
    kh_log("监听 127.0.0.1:18923 就绪（.8li 进程内热键服务；持有端口者才装键盘钩子）");

    while (!g_khStop && !g_khSrvStop) {
        fd_set rs;
        FD_ZERO(&rs);
        FD_SET(ls, &rs);
        struct timeval tv = { 0, 300 * 1000 };
        int r = select(0, &rs, NULL, NULL, &tv);
        if (g_khStop || g_khSrvStop) break;
        if (r <= 0) continue;
        SOCKET c = accept(ls, NULL, NULL);
        if (c == INVALID_SOCKET) continue;
        if (!kh_cli_add(c)) { closesocket(c); continue; }   /* 登记满 ⇒ 拒收 */
        HANDLE t = CreateThread(NULL, 0, kh_client_thread, (LPVOID)(UINT_PTR)c, 0, NULL);
        if (t) CloseHandle(t);                              /* 句柄不持有：线程自清理 */
        else { kh_cli_remove(c); closesocket(c); }
    }
    if (g_khListen == ls) { closesocket(ls); g_khListen = INVALID_SOCKET; }
    InterlockedExchange(&g_khBound, 0);
    kh_cli_shutdown_all();
    kh_log("WS 18923 服务器线程退出");
    return 0;
}

/* ================================================================ 协议分发 */

static void kh_set_arm(int on)
{
    InterlockedExchange(&g_khArmed, on ? 1 : 0);
    kh_log("热键钩子%s", on ? "已布防" : "已撤防");
    /* 低延迟通道；队列未就绪时失败也无妨（100ms 轮询兜底）。 */
    if (g_khRecThreadId)
        PostThreadMessage(g_khRecThreadId, on ? WM_KH_INSTALL : WM_KH_UNINSTALL, 0, 0);
}

/* .8li 形态的「卸载」：清旧 daemon 遗留 + 撤防 + 释放 18923。
   ⛔ 不能退出宿主进程（.8li 与 PS 共命运）⇒ 停服务器+卸钩子后常驻，
      用户重启 PS 即恢复（面板 UI 会相应改写，见 BrushHotkeySection）。 */
static void kh_do_uninstall(SOCKET s)
{
    kh_log("收到卸载指令（.8li 形态：清旧 daemon 遗留 + 撤防；服务器保持监听）");
    kh_send_to(s, "{\"type\":\"bye\"}");

    /* ① 撤防（防看护重挂） */
    InterlockedExchange(&g_khArmed, 0);

    /* ② 清开机自启（旧版 HotkeyDaemon 的项） */
    HKEY k;
    if (RegOpenKeyExA(HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                      0, KEY_SET_VALUE, &k) == ERROR_SUCCESS) {
        LONG r = RegDeleteValueA(k, "JWautofillHotkeyDaemon");
        RegCloseKey(k);
        kh_log("开机自启项 JWautofillHotkeyDaemon：%s",
               r == ERROR_SUCCESS ? "已移除" : "不存在或移除失败");
    }

    /* ③ 删旧安装目录（隐藏 cmd 延迟 1s，避开占用） */
    wchar_t lad[MAX_PATH] = L"";
    GetEnvironmentVariableW(L"LOCALAPPDATA", lad, MAX_PATH);
    if (lad[0]) {
        wchar_t dir[MAX_PATH], cmd[MAX_PATH * 2];
        _snwprintf(dir, MAX_PATH, L"%s\\JWautofill\\daemon", lad);
        _snwprintf(cmd, MAX_PATH * 2,
                   L"cmd.exe /c timeout /t 1 /nobreak > nul & rmdir /s /q \"%s\"", dir);
        STARTUPINFOW si;
        PROCESS_INFORMATION pi;
        ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
        ZeroMemory(&pi, sizeof(pi));
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            char u8[MAX_PATH];
            kh_w2u8(dir, u8, (int)sizeof(u8));
            kh_log("已安排删除旧安装目录 %s", u8);
        }
    }

    /* ④ ⛔ M4（2026-10-17）：不再停 WS 服务器。.8li 不能退出宿主 ⇒ 停服务器
     *    要重启 PS 才恢复，而用户要的是「随时能反复启用」。旧 daemon 清理 +
     *    撤防已经够用；本连接关闭后重连逻辑 1.5s 内自动恢复，布防态由面板重发。
     *    （旧版 daemon 的自清不走这里——迁移时 .8li 作为客户端直连旧 daemon
     *     发 uninstall，见 kh_try_migrate。） */
    shutdown(s, SD_BOTH);
}

/* ================================================================ 键盘一键修复 */
/* 面板「键盘卡死一键修复」的 .8li 形态实现（原 fix-keyboard.ps1 的进程内等价物）。
 *
 * 分工（与 ps1 的 7 步逐项对应，避免行为回退）：
 *   ① 卸掉我们自己的键盘钩子 —— 键盘冻结的头号嫌疑人就是它，⛔ 必须**先做**，
 *     不能等用户点完 UAC 才卸（冻结期间只有鼠标可点，UAC 可能要等很久）；
 *   ② 重置 LowLevelHooksTimeout（>5000ms 即危险值，删除恢复系统默认）；
 *   ③ 为 Ctrl/Alt/Shift/Win 补发抬起事件（解卡住的修饰键）；
 *   ④ 重启 ctfmon（输入法假死）；
 *   ⑤⑥⑦ 设备层两步（pnputil 软重置键盘设备链 / 关闭 USB 省电策略）需要管理员，
 *     由面板传入的内置 fix-keyboard.ps1 以 runas 提权完成 —— 它自含 UAC 逻辑，
 *     且步骤 1-5 是幂等的（无 daemon 进程/无自启项/超时已重置，重做皆无副作用）。
 *
 * ⛔ 修复后**不自动重挂**：若冻结真是我们的钩子造成的，自动重挂等于再冻一次。
 *     保持撤防，用户确认键盘恢复后可在面板重新打开开关（或重启 PS）。
 */

/* LowLevelHooksTimeout 危险值复位（HKCU，无需管理员）。 */
static void kh_repair_reset_hook_timeout(void)
{
    HKEY k;
    if (RegOpenKeyExA(HKEY_CURRENT_USER, "Control Panel\\Desktop", 0,
                      KEY_READ | KEY_WRITE, &k) != ERROR_SUCCESS) {
        kh_log("键盘修复：打不开 Desktop 键，跳过超时复位");
        return;
    }
    /* ⛔ 与 kh_read_ll_timeout 同款：先 NULL 缓冲问 type+size 再分流。 */
    DWORD type = 0, sz = 0;
    if (RegQueryValueExA(k, "LowLevelHooksTimeout", NULL, &type, NULL, &sz) == ERROR_SUCCESS) {
        DWORD v = 0;
        int have = 0;
        if (type == REG_DWORD && sz == sizeof(DWORD)) {
            sz = sizeof(v);
            if (RegQueryValueExA(k, "LowLevelHooksTimeout", NULL, &type, (LPBYTE)&v, &sz) == ERROR_SUCCESS)
                have = 1;
        } else if (type == REG_SZ && sz > 0 && sz < 64) {
            char s[64] = "";
            if (RegQueryValueExA(k, "LowLevelHooksTimeout", NULL, &type, (LPBYTE)s, &sz) == ERROR_SUCCESS) {
                v = (DWORD)atoi(s); have = 1;
            }
        }
        if (have && v > 5000) {
            if (RegDeleteValueA(k, "LowLevelHooksTimeout") == ERROR_SUCCESS)
                kh_log("键盘修复：LowLevelHooksTimeout=%lu 已删除（恢复系统默认）", v);
            else
                kh_log("键盘修复：LowLevelHooksTimeout=%lu 删除失败 err=%lu", v, GetLastError());
        } else if (have) {
            kh_log("键盘修复：LowLevelHooksTimeout=%lu 在安全范围，保持不变", v);
        } else {
            kh_log("键盘修复：LowLevelHooksTimeout 已是系统默认");
        }
    } else {
        kh_log("键盘修复：LowLevelHooksTimeout 已是系统默认");
    }
    RegCloseKey(k);
}

/* 为 8 个修饰键补发 KEYUP（解「钩子吞键导致系统以为键还按着」的卡死）。 */
static void kh_repair_release_modifiers(void)
{
    static const BYTE vks[8] = { 0xA2, 0xA3, 0xA4, 0xA5, 0xA0, 0xA1, 0x5B, 0x5C };
    for (int i = 0; i < 8; i++) keybd_event(vks[i], 0, KEYEVENTF_KEYUP, 0);
    kh_log("键盘修复：已为 Ctrl/Alt/Shift/Win 补发抬起事件");
}

/* 重启 ctfmon（输入法假死；失败不影响整体修复）。 */
static void kh_repair_restart_ctfmon(void)
{
    int killed = 0;
    HANDLE h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (h != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe;
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(h, &pe)) {
            do {
                if (_wcsicmp(pe.szExeFile, L"ctfmon.exe") == 0) {
                    HANDLE p = OpenProcess(PROCESS_TERMINATE, FALSE, pe.th32ProcessID);
                    if (p) {
                        if (TerminateProcess(p, 0)) killed++;
                        CloseHandle(p);
                    }
                }
            } while (Process32NextW(h, &pe));
        }
        CloseHandle(h);
    }
    wchar_t sys[MAX_PATH], exe[MAX_PATH + 24];
    GetSystemDirectoryW(sys, MAX_PATH);
    _snwprintf(exe, MAX_PATH + 24, L"%s\\ctfmon.exe", sys);
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    if (CreateProcessW(exe, NULL, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        kh_log("键盘修复：ctfmon 已重启（结束 %d 个旧实例）", killed);
    } else {
        kh_log("键盘修复：ctfmon 重启失败 err=%lu（已结束 %d 个）", GetLastError(), killed);
    }
}

/* 提权唤起内置 fix-keyboard.ps1（设备层两步：软重置键盘 + USB 省电策略）。
   script 为空/不存在 ⇒ 跳过（基础 4 步已做完，设备层留给用户手动重插键盘）。 */
static int kh_repair_launch_script(const char* script)
{
    if (!script || !*script) { kh_log("键盘修复：未提供脚本路径，跳过设备层两步"); return 0; }
    wchar_t w[1024];
    kh_u8_to_w(script, w, 1024);
    if (GetFileAttributesW(w) == INVALID_FILE_ATTRIBUTES) {
        kh_log("键盘修复：脚本不存在，跳过设备层两步：%s", script);
        return 0;
    }
    /* runas ⇒ UAC 提权（ps1 顶部检测到已管理员会跳过自提权，只弹一次）。
       控制台可见：修复进度与结果要能让用户看见（键盘卡死时唯一可用的就是眼睛+鼠标）。 */
    wchar_t params[1200];
    _snwprintf(params, 1200,
               L"-ExecutionPolicy Bypass -NoProfile -File \"%s\" -JwElevated", w);
    SHELLEXECUTEINFOW sei;
    ZeroMemory(&sei, sizeof(sei));
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    sei.lpVerb = L"runas";
    sei.lpFile = L"powershell.exe";
    sei.lpParameters = params;
    sei.nShow = SW_SHOWNORMAL;
    if (ShellExecuteExW(&sei)) {
        if (sei.hProcess) CloseHandle(sei.hProcess);
        kh_log("键盘修复：已提权唤起设备层修复脚本（UAC 弹窗请点「是」）");
        return 1;
    }
    kh_log("键盘修复：提权唤起脚本失败 err=%lu（用户可能取消了 UAC）", GetLastError());
    return 0;
}

/* 修复主流程：回一帧 repairResult（ok=基础步骤是否走完，launched=设备层是否已唤起）。 */
static void kh_do_repair(SOCKET s, const char* script)
{
    kh_log("收到键盘修复指令（.8li 进程内形态）");

    /* ① 立即卸钩（bypass 100ms 轮询：冻结期每一毫秒都珍贵）。
           ⛔ 客户端线程直卸：UnhookWindowsHookEx 本身线程安全（钩子线程即便
              正处在回调中，系统也会让其跑完再摘链）；但录制态取消帧不能在此发——
              g_khRecPending 注释约定仅钩子线程可写，出站环是 SPSC（单生产者=
              钩子线程）⇒ 取消走 g_khRecReq=2 + WM_KH_RECSTOP 回钩子线程发。 */
    InterlockedExchange(&g_khArmed, 0);
    HHOOK hh = (HHOOK)InterlockedExchangePointer((PVOID*)&g_khHook, NULL);
    if (hh) {
        UnhookWindowsHookEx(hh);
        kh_log("键盘钩子已卸载（修复流程，客户端线程直卸）");
    }
    if (g_khRecording) {
        InterlockedExchange(&g_khRecReq, 2);
        if (g_khRecThreadId) PostThreadMessage(g_khRecThreadId, WM_KH_RECSTOP, 0, 0);
    }

    /* ②③④ 无需权限的基础步骤 */
    kh_repair_reset_hook_timeout();
    kh_repair_release_modifiers();
    kh_repair_restart_ctfmon();

    /* ⑤ 设备层：提权跑内置 ps1 */
    int launched = kh_repair_launch_script(script);

    char msg[512];
    _snprintf(msg, sizeof(msg),
              "{\"type\":\"repairResult\",\"ok\":true,\"launched\":%s,"
              "\"message\":\"%s\"}",
              launched ? "true" : "false",
              launched
                ? "基础修复已完成（钩子已卸、超时已复位、修饰键已释放、输入法已重启），"
                  "设备层修复脚本已提权打开——请在授权窗口点「是」，按窗口提示查看结果。"
                  "快捷键暂保持关闭，确认键盘正常后可在面板重新打开。"
                : "基础修复已完成（钩子已卸、超时已复位、修饰键已释放、输入法已重启）；"
                  "设备层脚本未找到或未提权，若键盘仍异常请手动重新插拔键盘。"
                  "快捷键暂保持关闭，确认键盘正常后可在面板重新打开。");
    kh_send_to(s, msg);
}

static int kh_handle_message(SOCKET s, const char* js)
{
    char type[32] = "";
    json_str(js, "type", type, (int)sizeof(type));

    if (_stricmp(type, "setConfigPath") == 0) {
        char p[512] = "";
        if (json_str(js, "path", p, (int)sizeof(p))) {
            /* ⛔⛔ 0x0139（2026-10-19 用户报「快捷键全失灵 + 面板显示热键已暂停」）：
               json_str 是**逐字拷贝**（见 plugin_main.c 实现，与 kh_parse_items 里
               显式补调 kh_unesc 的做法不同）⇒ 面板 JSON.stringify 产生的
               "C:\\Users\\..." 在引号内是**两个字面反斜杠**，原样落库后：
                 · 文件读写碰巧不受影响（Win32 路径规范化容忍冗余分隔符）；
                 · 但回帧 path 经 kh_esc 再转义成四倍反斜杠，面板 parse 回双反斜杠，
                   与 requestedConfigPath（单反斜杠）逐字比对**永远不相等** ⇒
                   pathAligned 恒 false ⇒ 面板每收到一帧 config 就重发
                   setConfigPath ⇒ 本函数「路径没变也重载」分支 ⇒ 再广播 ⇒
                   无线速回路（实测 ~1400 次/秒，Pi8li.log 被「热键表已装载」刷屏）。
               面板 JS 线程被 config 帧洪水淹没：热键事件排队直至用户观感「按了没反应」；
               晚挂载的功能快捷键子面板又收不到（无跃变就不播的）hotkeyState 帧 ⇒
               初始 false 常驻，显示「热键已暂停」并拦住录制入口。
               修法 = 与 kh_parse_items 对齐：入库前先反转义成逻辑路径。 */
            kh_unesc(p);
            kh_set_config_path(p);
        }
        return 0;
    }
    if (_stricmp(type, "shutdown") == 0) {
        /* 面板「断开服务」：旧 daemon 会退出进程；.8li 与 PS 共命运不能退，
           退化为「撤防 + bye + 断开本连接」，服务器保持监听。 */
        kh_log("收到断开指令（.8li 常驻：撤防+断开，不退出宿主）");
        kh_send_to(s, "{\"type\":\"bye\"}");
        kh_set_arm(0);
        shutdown(s, SD_BOTH);
        return 0;
    }
    if (_stricmp(type, "uninstall") == 0) {
        kh_do_uninstall(s);
        return 0;
    }
    if (_stricmp(type, "config") == 0) {
        const char* pl = json_find(js, "payload");
        if (pl && *pl == '[') kh_save_config(pl);
        return 0;
    }
    if (_stricmp(type, "getConfig") == 0) {
        KhItem items[KH_MAX_ITEMS];
        int n = kh_read_config_file(items, KH_MAX_ITEMS);
        /* ⛔⛔ 0x0123：面板「拉配置」必须顺带**重建热键表**。
           旧版这里只读文件回帧、不碰表 ⇒ 若启动装载那一次失败（空表），
           面板每次建连拉到的都是空表，热键永远不响（用户实测：重录一条才恢复）。
           解析失败（n<0）时保持 kh_reload 的同款语义：**不清空**旧表。 */
        if (n < 0) {
            kh_log("⚠️ getConfig 解析失败（保留原热键表）: %s", g_khCfgPath);
            n = 0;
        } else {
            InterlockedExchange(&g_khItemCount, n);
            kh_map_apply(items, n);
        }
        char* payload = (char*)malloc(160 * 1024);
        char* msg = payload ? (char*)malloc(170 * 1024) : NULL;
        if (payload && msg) {
            char pathNow[512], pathEsc[1024];
            kh_items_to_json(items, n, payload, 160 * 1024);
            kh_cfg_snapshot_u8(pathNow, 512);
            kh_esc(pathNow, pathEsc, (int)sizeof(pathEsc));
            /* ⛔ 0x013A：括号已由 kh_items_to_json 产出，同 kh_reload 广播点，
               这里再包一层就是 [[...]]，面板直接判空。 */
            _snprintf(msg, 170 * 1024,
                      "{\"type\":\"config\",\"payload\":%s,\"path\":\"%s\"}",
                      payload, pathEsc);
            kh_send_to(s, msg);
        }
        free(payload);
        free(msg);
        return 0;
    }
    if (_stricmp(type, "getState") == 0) {
        char st[8192];
        kh_build_state(st, (int)sizeof(st));
        kh_send_to(s, st);
        return 0;
    }
    if (_stricmp(type, "hotkeyArm") == 0) {
        int on = 1;
        json_bool(js, "on", &on);                        /* 缺省 true（ReadBool 同款） */
        kh_set_arm(on);
        return 0;
    }
    if (_stricmp(type, "hotkeyStatus") == 0) {
        char st[512];
        kh_build_hotkey_state(st, (int)sizeof(st));
        kh_send_to(s, st);
        return 0;
    }
    if (_stricmp(type, "repairKeyboard") == 0) {
        /* 面板「键盘卡死一键修复」：script = 面板解析出的 fix-keyboard.ps1 全路径
           （.8li 装在 PS Plug-ins 目录，无法从自身路径推导插件根 ⇒ 必须由面板传入）。
           ⛔ 同样要 kh_unesc：Windows 路径里的反斜杠经 JSON.stringify 后是两个字面
              反斜杠，原样传给 GetFileAttributesW/ShellExecuteExW 会「脚本不存在」，
              设备层修复（pnputil 软重置/USB 省电）被静默跳过（2026-10-19 同批修复）。 */
        char script[1024] = "";
        json_str(js, "script", script, (int)sizeof(script));
        kh_unesc(script);
        kh_do_repair(s, script);
        return 0;
    }
    if (_stricmp(type, "recordStart") == 0) {
        char brush[192] = "";
        json_str(js, "brush", brush, (int)sizeof(brush));
        kh_unesc(brush);   /* 同 setConfigPath：json_str 不反转义，笔刷名可能含 \" 或 \\ */
        EnterCriticalSection(&g_khRecLk);
        g_khRecClient = s;
        memcpy(g_khRecBrush, brush, sizeof(g_khRecBrush));
        LeaveCriticalSection(&g_khRecLk);
        InterlockedExchange(&g_khRecReq, 1);
        if (g_khRecThreadId) PostThreadMessage(g_khRecThreadId, WM_KH_RECSTART, 0, 0);
        return 0;
    }
    if (_stricmp(type, "recordCancel") == 0) {
        InterlockedExchange(&g_khRecReq, 2);
        if (g_khRecThreadId) PostThreadMessage(g_khRecThreadId, WM_KH_RECSTOP, 0, 0);
        return 0;
    }
    if (_stricmp(type, "armDelete") == 0) {
        char owner[96] = "";
        json_str(js, "owner", owner, (int)sizeof(owner));
        kh_unesc(owner);
        EnterCriticalSection(&g_khArmLk);
        g_khArmClient = s;
        memcpy(g_khArmOwner, owner, sizeof(g_khArmOwner));
        InterlockedExchange(&g_khArmOn, 1);
        LeaveCriticalSection(&g_khArmLk);
        return 0;
    }
    if (_stricmp(type, "disarmDelete") == 0) {
        EnterCriticalSection(&g_khArmLk);
        if (g_khArmClient == s) {
            g_khArmClient = INVALID_SOCKET;
            g_khArmOwner[0] = 0;
            InterlockedExchange(&g_khArmOn, 0);
        }
        LeaveCriticalSection(&g_khArmLk);
        return 0;
    }

    /* 未知消息节流 2s 留痕（静默吞 = 排障无从下手） */
    {
        static volatile LONG s_lastMs;
        DWORD nowM = GetTickCount();
        if ((DWORD)(nowM - (DWORD)s_lastMs) >= 2000) {
            s_lastMs = (LONG)nowM;
            char head[64] = "";
            _snprintf(head, sizeof(head), "%s", js);
            kh_log("未知消息(节流): type=\"%s\" 原文=%.60s", type, head);
        }
    }
    return 0;
}

static void kh_on_text(void* ctx, const char* text)
{
    SOCKET s = (SOCKET)(UINT_PTR)ctx;
    kh_handle_message(s, text);
}

static DWORD WINAPI kh_client_thread(LPVOID param)
{
    SOCKET s = (SOCKET)(UINT_PTR)param;
    int closedBy = 0;
    /* 0x0205：握手抽 path —— 面板（UXP 插件本体）走 "/"；迁移探测走 "/jw-migrate"，
       后者只是来问「你是不是旧版 daemon」的，**不是插件本体**，不能算在位。 */
    char cpath[128] = "";
    if (wc_handshake_path(s, cpath, (int)sizeof(cpath)) != 0) {
        /* ⚠️ 顺序：先归还槽位再 closesocket。反过来的话，系统可能立刻把同一个 SOCKET
           值发给下一条 accept，而本线程随后的 remove(s) 会按值命中并**误删新连接**。 */
        kh_cli_remove(s); closesocket(s); kh_plug_recompute(); return 0;
    }
    int isPlugin = (_stricmp(cpath, "/") == 0);
    if (!isPlugin) kh_cli_tag_not_plugin(s);
    if (isPlugin) kh_log("面板已连接 ws(18923)");
    else kh_log("WS 客户端已连接（path=%s，非面板 ⇒ 不计入插件在位）", cpath);
    kh_plug_recompute();     /* 0x0205：插件本体在位 ⇒ 钩子线程下轮自动装挂 */
    if (g_khPlug)
        kh_log("插件本体在位（18923 客户端在线）⇒ 键盘钩子按当前布防态装挂；断开即全部放行");
    /* ⛔ 建连**不主动推配置**（同 daemon 2026-10-14 修复）：
       面板 onopen 序列 = setConfigPath → getConfig；握手后立刻推会带着
       尚未对齐的路径与空/旧配置，触发面板告警与回写护栏。 */
    wc_client_loop(s, &g_khSendLk, kh_on_text, (void*)(UINT_PTR)s, &closedBy);

    /* 断开清理两段，各自独立：录制取消 + 退格布防撤防 */
    EnterCriticalSection(&g_khRecLk);
    if (g_khRecClient == s) {
        g_khRecClient = INVALID_SOCKET;
        g_khRecBrush[0] = 0;
        InterlockedExchange(&g_khRecReq, 2);             /* 取消进行中的录制 */
    }
    LeaveCriticalSection(&g_khRecLk);
    EnterCriticalSection(&g_khArmLk);
    if (g_khArmClient == s) {
        g_khArmClient = INVALID_SOCKET;
        g_khArmOwner[0] = 0;
        InterlockedExchange(&g_khArmOn, 0);
    }
    LeaveCriticalSection(&g_khArmLk);

    kh_cli_remove(s);
    kh_plug_recompute();     /* 0x0205：最后一个客户端也走了 ⇒ 插件本体不在位 */
    shutdown(s, SD_BOTH);
    closesocket(s);
    kh_log("面板已断开 reason=%s err=%d",
           closedBy == 1 ? "对端close" : closedBy == 2 ? "异常大帧" : "recv错误",
           closedBy == 0 ? WSAGetLastError() : 0);
    if (!g_khPlug)
        kh_log("插件本体不在位 ⇒ 卸键盘钩子 + 撤热键注册，按键全部放行（PS 原生快捷键恢复）");
    return 0;
}

/* ================================================================ 启停 */

int keyhook_started(void)
{
    return (int)g_khStarted;
}

void keyhook_start(void)
{
    if (InterlockedCompareExchange(&g_khStarted, 1, 0) != 0) return;
    wc_lk_init();
    InitializeCriticalSection(&g_khCliLk);
    InitializeCriticalSection(&g_khSendLk);
    InitializeCriticalSection(&g_khRecLk);
    InitializeCriticalSection(&g_khArmLk);
    InitializeCriticalSection(&g_khMapLk);
    InitializeCriticalSection(&g_khCfgLk);
    for (int i = 0; i < KH_MAX_CLI; i++) {
        g_khCli[i].s = INVALID_SOCKET;
        g_khCli[i].closing = 0;
    }
    g_khRecClient = INVALID_SOCKET;
    g_khArmClient = INVALID_SOCKET;
    g_khListen = INVALID_SOCKET;
    g_khHook = NULL;
    g_khRecThreadId = 0;
    InterlockedExchange(&g_khStop, 0);
    InterlockedExchange(&g_khSrvStop, 0);
    InterlockedExchange(&g_khPlug, 0);          /* 0x0205：插件本体不在位（等面板连接） */
    InterlockedExchange(&g_khArmed, 1);          /* 默认布防（daemon 初值 true） */
    InterlockedExchange(&g_khActive, 1);         /* 我们就在 PS 里 ⇒ PS 必然在运行 */
    InterlockedExchange(&g_khSafeMode, 0);
    InterlockedExchange(&g_khStrikes, 0);
    InterlockedExchange(&g_khSafeSince, 0);
    InterlockedExchange(&g_khPendingBreakLog, 0);
    InterlockedExchange(&g_khReinstall, 0);
    InterlockedExchange(&g_khRecReq, 0);
    InterlockedExchange(&g_khRecording, 0);
    InterlockedExchange(&g_khArmOn, 0);
    InterlockedExchange(&g_khMapSeq, 0);
    InterlockedExchange(&g_khMapCount, 0);
    InterlockedExchange(&g_khItemCount, 0);
    g_khMap = g_khMapBuf[0];
    g_khHitHead = g_khHitTail = g_khHitDrops = 0;
    g_khOutHead = g_khOutTail = 0;
    g_khHlogHead = g_khHlogTail = 0;
    g_khPidIdx = 0;
    g_khPidCount = 0;
    g_khCfgWtOk = 0;
    g_khLastMigrate = 0;
    g_khRecPending[0] = 0;

    g_khWake = CreateEventW(NULL, FALSE, FALSE, NULL);       /* 自动复位 */
    g_khThreadReady = CreateEventW(NULL, FALSE, FALSE, NULL);

    kh_load_cfg_store();
    kh_refresh_ps_pids();
    /* 0x013B：启动即留痕 —— 前台判定依赖的 pid 表是否可用，一眼可见。
       （若这里 n=0，旧实现的 kh_ps_foreground 会恒 0 ⇒ 整机按键全部放行。） */
    {
        HWND fg = GetForegroundWindow();
        DWORD fp = 0;
        if (fg) GetWindowThreadProcessId(fg, &fp);
        kh_log("psPid 表：%d 个 photoshop.exe（本进程=%lu；此刻前台 fgPid=%lu）",
               (int)g_khPidCount, (unsigned long)GetCurrentProcessId(), (unsigned long)fp);
    }
    InterlockedExchange(&g_khDiagIn, 0);
    InterlockedExchange(&g_khDiagFg, 0);
    InterlockedExchange(&g_khDiagSafe, 0);
    InterlockedExchange(&g_khDiagHiBit, 0);

    /* 钩子线程先就绪（它的消息队列是 install/record 指令的落点）。 */
    ResetEvent(g_khThreadReady);
    g_khHookThread = CreateThread(NULL, 0, kh_hook_thread, NULL, 0, NULL);
    if (g_khHookThread) WaitForSingleObject(g_khThreadReady, 2000);
    g_khWatchdogThread = CreateThread(NULL, 0, kh_watchdog_thread, NULL, 0, NULL);
    g_khDispatchThread = CreateThread(NULL, 0, kh_dispatch_thread, NULL, 0, NULL);
    g_khServerThread   = CreateThread(NULL, 0, kh_server_thread, NULL, 0, NULL);
    kh_reload();       /* 启动即装载（不等面板；旧 daemon 开机自启的等价物） */
    kh_log("热键子系统已启动（.8li 进程内形态，端口 18923；0x0205：插件本体不在位时不装钩子，面板连上才装挂）");
}

/* ⛔⛔ 0x013E：停服时必须由**调用者线程**同步卸掉两条 LL 钩子。
 *
 * 旧实现只把 g_khStop/g_khSrvStop 置位、再 post WM_QUIT，由钩子线程在自己的退出
 * 路径里 kh_uninstall_hook()。问题在于那是一次**有超时的 join**（键盘 2s / 鼠标无 join
 * 只靠线程自退），超时后我们照样 CloseHandle 返回，接着 DllMain 让 PS 把本模块卸载 ——
 * 而 WH_KEYBOARD_LL / WH_MOUSE_LL 的回调地址就是本模块里的 kh_proc / kh_mse_proc。
 * 模块一旦不在，下一次按键或鼠标事件就是跳进已卸载地址：
 *   WER 现场 = Photoshop.exe BEX64 · 故障模块 JWautofillHost.8li_unloaded ·
 *             c0000005 · 异常数据 8（DEP 执行违规）。2026-10-16/17 一共六起同族。
 * 所以这里不等线程，先原子摘掉两条钩子（ExchangePointer 置空 ⇒ 线程退出路径不会二次
 * Unhook），再去做 join —— join 即使超时，也**不会**再有事件被投递进来。 */
static void kh_unhook_both_now(void)
{
    HHOOK k = (HHOOK)InterlockedExchangePointer((PVOID*)&g_khHook, NULL);
    if (k) { UnhookWindowsHookEx(k); kh_log("键盘钩子已卸载（停服同步路径）"); }
    HHOOK m = (HHOOK)InterlockedExchangePointer((PVOID*)&g_mseHook, NULL);
    if (m) { UnhookWindowsHookEx(m); kh_log("鼠标钩子已卸载（停服同步路径）"); }
}

void keyhook_stop(void)
{
    if (InterlockedCompareExchange(&g_khStarted, 0, 1) == 0) return;
    InterlockedExchange(&g_khStop, 1);
    InterlockedExchange(&g_khSrvStop, 1);
    SetEvent(g_khWake);
    if (g_khListen != INVALID_SOCKET) shutdown(g_khListen, SD_BOTH);
    if (g_khRecThreadId) PostThreadMessage(g_khRecThreadId, WM_QUIT, 0, 0);

    /* ⚠️ 必须在任何 join 之前：join 超时不能让钩子活着走出本函数。 */
    kh_unhook_both_now();

    if (g_khDispatchThread) {
        if (WaitForSingleObject(g_khDispatchThread, 1000) != WAIT_OBJECT_0)
            kh_log("⚠ 调度线程 1s 内未退出（仍 CloseHandle，钩子已卸 ⇒ 不会再有回调）");
        CloseHandle(g_khDispatchThread); g_khDispatchThread = NULL;
    }
    if (g_khHookThread) {
        if (WaitForSingleObject(g_khHookThread, 2000) != WAIT_OBJECT_0)
            kh_log("⚠ 钩子线程 2s 内未退出（仍 CloseHandle，钩子已卸 ⇒ 不会再有回调）");
        CloseHandle(g_khHookThread); g_khHookThread = NULL;
    }
    if (g_khServerThread) {
        if (WaitForSingleObject(g_khServerThread, 5000) != WAIT_OBJECT_0)   /* 覆盖 bind 重试的 3s 睡眠 */
            kh_log("⚠ 服务器线程 5s 内未退出（仍 CloseHandle）");
        CloseHandle(g_khServerThread); g_khServerThread = NULL;
    }
    if (g_khWatchdogThread) {
        if (WaitForSingleObject(g_khWatchdogThread, 1000) != WAIT_OBJECT_0)
            kh_log("⚠ 看护线程 1s 内未退出（仍 CloseHandle）");
        CloseHandle(g_khWatchdogThread); g_khWatchdogThread = NULL;
    }
    /* ⛔ 二次摘钩：钩子线程若在「检查 g_khHook 为空」之后、SetWindowsHookEx 返回之前
       被我们抢先摘掉，会在停服之后再挂回来（窗口极小但存在）。join 之后再过一遍，
       保证本函数返回时两条钩子一定不在链上。 */
    kh_unhook_both_now();

    kh_cli_shutdown_all();     /* 仍未退的客户端线程：只 shutdown，句柄归它们 */
    if (g_khWake) { CloseHandle(g_khWake); g_khWake = NULL; }
    if (g_khThreadReady) { CloseHandle(g_khThreadReady); g_khThreadReady = NULL; }
    g_khRecThreadId = 0;
    kh_log("热键子系统已停止（键盘钩子已卸，18923 已释放；.8li 常驻不退出宿主）");
}
