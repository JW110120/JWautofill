/* JWautofill Host — .8li 进程内插件（M3：平滑 WS 18924 + 热键 WS 18923 合体）
 *
 * 架构（M2 起）：本模块 = 旧「SmoothDaemon(WS 18924) + 注入 DLL」的**合体**——
 *   · 平滑引擎（smooth_engine.c，源自 native/WintabHook/wintab_hook.c）直接编进
 *     本镜像，由 DllMain(ATTACH) 经 engine_dllmain 启动 worker；不再注入、不再
 *     有守护进程与跨进程共享内存消费方（命名节仅作模块内两半的传导介质保留，
 *     槽位表逐项不变）。
 *   · 本文件承担旧 Program.cs（ROLE_SMOOTH）的职责：WS 18924 服务器、penSmooth
 *     解析 → CFG 槽写入、smoothState 周期推送（500ms 差分广播）、心跳、
 *     cmd 去重（只在开关跃变时下令）与「已卸载自愈」（HealIfUnhooked 同款）。
 *
 * M3（2026-10-17）：旧 HotkeyDaemon(WS 18923, ~70M) + FixKeyboard(~70M) 一并退役 ——
 *   键盘钩子/热键协议整体搬进本镜像（keyhook.c），随 .8li 加载而常驻：
 *     · keyhook.c：WH_KEYBOARD_LL（单持有者纪律：bind 18923 成功者才装钩）、
 *       熔断看护、两段式录制、配置落盘、旧版 daemon 迁移（getState → uninstall）。
 *     · ws_core.c：RFC6455 原语 + wc_client_loop（两个 WS 服务器逐字共用）。
 *     · jw_shared.h：log_line / json_* / g_hSelf 的去 static 面。
 *   ⇒ dist 不再需要 daemon 与 FixKeyboard（合计省 >140M）。
 *
 * 面板契约（SmoothBridge.ts / Program.cs，逐字对齐勿改）：
 *   入站：{type:"penSmooth", on, mode?, strength?, radius?, catchUp?, cornerAngle?,
 *          speedAdaptive?, hud?, hudColor?, toolGate?}；{type:"smoothStatus"}（能力探针，
 *          必回一帧 smoothState）；{type:"shutdown"} 仅断连用（本模块不能退出 PS，忽略）。
 *   出站：{"type":"smoothState","protocol":"2.0","pen":{...}}，pen 字段集 =
 *          Program.cs PenHook.Snapshot() 逐项（含 snAge/ctOff/ctElig/pxPerAxis…）。
 *
 * 入口/消息协议（M1 真机实测）：加载="SP Access"/"Reload"，退出="SP Access"/"Unload"。
 * 日志：%LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log（本层）；引擎日志 %TEMP%\jwwh-<pid>.log。
 */

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "jw_shared.h"      /* 去 static 面：log_line / json_* / g_hSelf */
#include "ws_core.h"        /* M3：RFC6455 原语与客户端会话循环（keyhook.c 共用） */
#include "keyhook.h"        /* M3：WS 18923 键盘钩子/热键子系统 */

/* 0x013D：引擎软闸（smooth_engine.c 导出）。Unload 哑火、Reload 复机。 */
extern int jwwh_set_engine_off(int on);

#define SMOOTH_PORT      18924
#define LOG_MAX          (1024 * 1024)
#define THREAD_WAIT_MS   3000
#define MAX_CLI          8

/* 引擎接口（smooth_engine.c） */
BOOL WINAPI engine_dllmain(HINSTANCE hinst, DWORD reason, LPVOID reserved);

/* 进程内工具闸门（ps_tool.c）：注册 PS 'slct' 通知，在 PS 进程里直接读当前工具。
   ⛔ 面板的 300ms batchPlay 工具巡检是它不可用时的**退路**，不是主路。 */
int  pstool_install(void* basic, void* self);
void pstool_uninstall(void);
int  pstool_state(void);                    /* 0=不可用 1=已注册未读数 2=已接管 */
int  pstool_tool_name(char* out, int cap);
void pstool_diag(char* out, int cap);
/* 2026-10-17（LNP 迁移）：进程内的 PS 模态层级 / 工具模态 / 文档纪元。
   ⛔ ps_tool.c 不碰槽位表（既有铁律），由本文件代写。 */
int  pstool_modal_level(void);              /* -1=未知，0=空闲，>0=宿主握着模态作用域 */
int  pstool_modal_ts(void);
int  pstool_tool_modal(void);               /* -1=未知 */
int  pstool_tool_modal_known(void);         /* 极性是否已证明（见过 0 与 1） */
int  pstool_doc_epoch(void);
int  pstool_notify_age(void);             /* -1=从未投递；≥0=距上次 slct 回调的 ms */
/* 引擎侧（smooth_engine.c）：⑧ wintab32 模块基址自检 */
int  se_wt_moved(void);
void* se_wt_base(void);

/* ================================================================ M1 日志 */

/* ⛔ 非 static：smooth_engine.c 的 wtctx_read_ini() 要按同一目录找外置开关文件
   （④⑤⑥ 的 wtctx.ini）。返回静态缓冲、**带尾部反斜杠**；失败返回 ""。 */
const char* jw_log_dir(void);

/* ================================================================ CFG 槽位 */
/* ⛔⛔ 与 smooth_engine.c 的 enum CFG_I_*、Program.cs 的 I_* 三处手写逐项对应；
   错位不报错、只静默失效（既有铁律）。 */
#define CFG_NAME_W   L"Local\\JWautofillWintabSmooth"
#define CFG_MAGIC    0x57414A57L      /* 'JWAW' */
/* ⛔ 2026-10-17：48 → 56（新增 4 个进程内观测槽，见下面 I_MODALLVL 起的注释）；
   56 → 58（0x0115 新增 I_NOTIFYAGE / I_GATEOWNED，见下面注释）。
   两个文件（plugin_main.c / smooth_engine.c）的 CFG_NLONGS **必须同时改**：
   谁先建节谁定尺寸，不一致的一方 MapViewOfFile 会拿到错误的字节数。 */
#define CFG_NLONGS   58

enum {
    I_MAGIC = 0, I_ENABLED, I_STRENGTH, I_FLAGS, I_SEQ, I_CMDSEQ, I_CMD, I_CMDACK,
    I_STATE, I_CALLS, I_PACKETS, I_SMOOTHED, I_STRIDE, I_OFFX, I_OFFY, I_OFFSER,
    I_AXISMAX, I_PID, I_FROZE, I_HEARTBEAT,
    I_MODE, I_TENSION, I_CATCHUP, I_CORNER, I_RADIUSPX, I_HUD, I_HUDCOLOR, I_PXPERAXIS,
    I_TOOLGATE, I_GATETS, I_PENDOWN, I_GATEOK, I_CTUNKNOWN,
    I_PXPERAXISY, I_SNTS, I_REASON, I_GATEOPEN, I_GATECLOSE,
    I_CTOFF, I_CTVAL, I_PXNX, I_PXNY, I_CTMASK, I_CTELIG, I_CTOFFS,
    /* ---- 2026-10-17：PICA 进程内观测（ps_tool.c 写、面板经 smoothState 读）---- */
    I_MODALLVL,       /* PS 模态嵌套层级：-1=未知 0=空闲 >0=宿主握着模态作用域 */
    I_MODALTS,        /* 该层级的观测时刻（GetTickCount 口径；0=从未观测） */
    I_TMODAL,         /* 工具模态：-1=未知 0/1=最近一次值 */
    I_TMODALK,        /* 工具模态「极性是否已证明」（见过 0 与 1）0/1 */
    I_DOCEPOCH,       /* 'Opn '/'Cls ' 累计次数 = 文档级变化的进程内副本 */
    /* ---- 0x0115：'slct' 活性看门狗（面板据此决定「停轮询」还是「降频兜底」）---- */
    I_NOTIFYAGE,      /* 距上次 'slct' 回调的 ms（-1=从未投递） */
    I_GATEOWNED,      /* 此刻闸门是否**真的**由进程内供给（1/0）—— 面板唯一判据。
                         ⛔ 面板绝不自己拿 notifyAge 去比阈值：阈值在原生侧，
                            两边各算一份迟早不同步 ⇒ 由这里下发**结论**。 */
};
typedef char cfg_fit_check[(I_GATEOWNED < CFG_NLONGS) ? 1 : -1];

static volatile LONG* g_cfg   = NULL;
static HANDLE         g_cfgMap = NULL;

static int cfgmap_open(void)
{
    if (g_cfg) return 1;
    if (g_cfgMap) return 0;
    g_cfgMap = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, CFG_NAME_W);
    if (!g_cfgMap) {
        /* 与引擎 cfg_open 同款兜底：谁先到谁创建；尺寸以最先创建者为准。 */
        g_cfgMap = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0,
                                      (DWORD)(CFG_NLONGS * sizeof(LONG)), CFG_NAME_W);
        if (!g_cfgMap) return 0;
    }
    g_cfg = (volatile LONG*)MapViewOfFile(g_cfgMap, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0,
                                          CFG_NLONGS * sizeof(LONG));
    if (!g_cfg) { CloseHandle(g_cfgMap); g_cfgMap = NULL; return 0; }
    return 1;
}

static LONG Rd(int slot) { return g_cfg ? g_cfg[slot] : 0; }

/* ================================================================ 进程内闸门桥 */
/* ps_tool.c 不能碰槽位表（编号是跨文件手写对应的铁律区），所以由本文件代写。 */

/* ⛔ 非 static：ps_tool.c 要 extern 它（做成 static 就是链接期隐式失配）。 */
void pstool_log(const char* fmt, ...)
{
    char body[512];
    va_list ap;
    va_start(ap, fmt);
    _vsnprintf(body, sizeof(body) - 1, fmt, ap);
    va_end(ap);
    body[sizeof(body) - 1] = 0;
    log_line("ps_tool", "%s", body);
}

/* 通知回调（PS 主线程）里调：把闸门值 + 时间戳一起落下。
   ⛔ 时间戳必须同时刷新 —— 引擎按 GATE_STALE_MS=3000 判过期，只写值不写戳
      等于把闸门推在「即将过期」的状态上。 */
void pstool_publish(int gate)
{
    if (!g_cfg) return;
    InterlockedExchange((LONG*)&g_cfg[I_TOOLGATE], gate ? 1 : 0);
    InterlockedExchange((LONG*)&g_cfg[I_GATETS], (LONG)GetTickCount());
}

/** 闸门是否已由进程内通知接管（2 档）。接管后：① 面板下发的 toolGate 一律忽略；
    ② GATETS 由本进程无条件续期（通知只在工具变化时来，不续期会 3s 过期 fail-closed）。 */
/**
 * 此刻闸门是否真的由进程内 'slct' 通知供给。
 *
 * ⛔⛔ 2026-10-17（0x0115）加了**时效**：`state==2` 只代表「曾经读到过工具」，
 *    而 'slct' 是「只在工具变化时投递」的事件通道、**没有心跳**。真机 pid 13428
 *    实测它连投 5 次后彻底静默 72 秒 —— 那一刻 state 仍是 2 ⇒ 闸门被永久冻结在
 *    最后一次的值，面板已停轮询、开关平滑也救不回来。
 * ⇒ 现在只有「最近真的收到过 slct」才算此刻接管；超时 ⇒ 立刻让位给面板轮询。
 *    这是**止损**而非根治：它不需要知道 PS 为什么停，静默了就把真相还给面板。
 */
static int pstool_owns(void)
{
    if (pstool_state() != 2) return 0;
    int age = pstool_notify_age();
    return (age >= 0 && age < 2000) ? 1 : 0;   /* 2000 = PS_NOTIFY_FRESH_MS（ps_tool.c） */
}
static void Wr(int slot, LONG v)
{
    if (g_cfg) InterlockedExchange((LONG*)&g_cfg[slot], v);
}

/* ================================================================ 参数面 */
/* Program.cs PenParams/PenHook.Set 的移植。默认值对齐 C# 字段初始化。 */
typedef struct {
    int mode, strength, radiusPx, catchUp, cornerAngle, flags, hud, hudColor, toolGate;
    /* 0x0133：闸门值有多旧（ms，面板最后一次**真读到工具**到现在）。
       ⛔ 没有它就无法表达「这个值是旧的」—— 见 write_params 里的根因注释。 */
    int gateAge;
} PenP;

static PenP g_pen = { 1, 40, 40, 50, 45, 0, 0, 0xE07F0D, 2, 0 };   /* 末位 gateAge=0：缺省=旧行为 */

static volatile LONG g_enabled;
static volatile LONG g_cmdSeq;
static volatile LONG g_cmdKnown;     /* ⛔ cmd 去重：只有开关跃变才下发 1/2，
                                        否则面板 300ms 一次的 toolGate 心跳会反复
                                        重置标定（Program.cs _cmdStateKnown 同款）。 */
static volatile LONG g_cmdStateOn;
static volatile LONG g_lastHealAt;
static volatile LONG g_zeroHeal;

HINSTANCE g_hSelf;

static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
static int roundi(double v) { return (int)(v + (v >= 0 ? 0.5 : -0.5)); }

/* Program.cs WriteParams 逐项移植。⛔ 新增参数必须在这里补一行。 */
static void write_params(void)
{
    Wr(I_STRENGTH,  g_pen.strength);
    Wr(I_FLAGS,     g_pen.flags);
    Wr(I_MODE,      g_pen.mode);
    Wr(I_CATCHUP,   g_pen.catchUp);
    Wr(I_CORNER,    g_pen.cornerAngle);
    Wr(I_RADIUSPX,  g_pen.radiusPx);
    Wr(I_HUD,       g_pen.hud);
    Wr(I_HUDCOLOR,  g_pen.hudColor);
    /* ⛔⛔ 进程内通知已接管时**绝不能**再写闸门值：面板的值来自它自己 300ms 前的
       读数（或它在接管前收到的旧值），两边都写就是互相覆盖 —— 表现为工具切了
       却不生效、或换回套索不恢复（两侧时间戳各自刷新，谁都「新鲜」）。
       接管后闸门值只由 ps_tool.c 的通知回调独占写入。 */
    /* ⛔⛔ 0x0133：闸门时间戳**不能写 now**。
       根因（jwwh-36236，用户报「用铅笔时套索 HUD 意外出现」）：面板的心跳每 1.5s
       整包重发一次 penSmooth，旧代码每次都用 now 刷新 I_GATETS ⇒ 一个**过期的
       「是套索」**被心跳反复续命，永远「新鲜」⇒ 引擎永远放行 ⇒ 画笔类工具落笔也出
       HUD；反过来若冻结在 0，就成了用户说的「断流、开关怎么拨都不恢复」。
       ⇒ 时间戳改成「面板最后一次**真读到工具**的时刻」：gateAge = 读数年龄(ms)，
          由面板给出。面板读工具被忙碌闸门挡住 / 读失败时不更新该年龄 ⇒ 年龄自然增长
          ⇒ 超过 GATE_STALE_MS 就被引擎 fail-closed 挡掉。心跳只续「参数」，不再续「真相」。
       ⛔ 缺省 gateAge=0（老面板不发该字段）⇒ 完全保持旧行为，避免把老面板打死。 */
    if (!pstool_owns()) {
        Wr(I_TOOLGATE, g_pen.toolGate);
        LONG age = (LONG)g_pen.gateAge;
        if (age < 0) age = 0;
        if (age > 60000) age = 60000;
        Wr(I_GATETS, (LONG)GetTickCount() - age);
    }
    /* 进程内 'slct' 接管时：值与戳都由 ps_tool.c 的 publish 独占写，这里一个字节都不碰。 */
}

/* Program.cs SendCommand：先写命令体、再抬序号（顺序反了会执行陈旧命令）。 */
static void send_cmd(int cmd)
{
    Wr(I_CMD, cmd);
    Wr(I_CMDSEQ, InterlockedIncrement(&g_cmdSeq));
}

static void broadcast_smooth_state(void);

/* Program.cs HealIfUnhooked 移植：enabled 且 (state==3 || (state==0 && calls==0)) ⇒ cmd=1。
   ⛔ 冷却 2s；state==0 的自愈有限次（用户只是没运笔时不该无限刷命令）；
     state==4（需重启 PS）/ state==2（标定失败）不自愈。 */
static void heal_if_unhooked(void)
{
    if (!g_enabled || !g_cfg) return;
    DWORD now = GetTickCount();
    if (now - (DWORD)g_lastHealAt < 2000) return;
    LONG st = Rd(I_STATE);
    if (st == 3) {
        g_lastHealAt = (LONG)now;
        send_cmd(1);
    } else if (st == 0 && Rd(I_CALLS) == 0) {
        if (g_zeroHeal < 8) { g_lastHealAt = (LONG)now; g_zeroHeal++; send_cmd(1); }
    } else {
        g_zeroHeal = 0;
    }
}

/* Program.cs Set()：写参数面 + SEQ++ + 跃变判 cmd + 自愈 + 广播。 */
static void commit(int on)
{
    InterlockedExchange(&g_enabled, on ? 1 : 0);   /* ⛔ 本地副本与槽位同步写：
                                                      smoothState 的 enabled 读这里 */
    Wr(I_ENABLED, on ? 1 : 0);
    write_params();
    Wr(I_SEQ, Rd(I_SEQ) + 1);

    int changed = !g_cmdKnown || (int)g_cmdStateOn != (on ? 1 : 0);
    g_cmdKnown = 1;
    g_cmdStateOn = on ? 1 : 0;
    if (on && changed)      send_cmd(1);   /* 挂载（引擎 do_install + 重新给标定机会） */
    else if (!on && changed) send_cmd(2);  /* 卸载（还原字节；引擎留在进程内秒开） */
    heal_if_unhooked();
    broadcast_smooth_state();
}

/* ================================================================ smoothState */
/* PenHook.Snapshot() 的 JSON 逐项移植。字段名/口径与面板消费方一致。 */
static int build_smooth_state(char* out, int cap)
{
    char dll[MAX_PATH] = "";
    GetModuleFileNameA(g_hSelf, dll, (DWORD)sizeof(dll));
    /* ⛔ Windows 路径的反斜杠必须转义成 \\（JSON.stringify 同款），否则
       面板 JSON.parse 直接抛异常 ⇒ smoothState 整帧被丢（真机实测踩过）。 */
    char dllEsc[MAX_PATH * 2];
    {
        const char* src = dll;
        char* dst = dllEsc;
        while (*src && dst < dllEsc + sizeof(dllEsc) - 2) {
            if (*src == '\\' || *src == '"') *dst++ = '\\';
            *dst++ = *src++;
        }
        *dst = 0;
    }

    LONG snts = Rd(I_SNTS);
    int snAge;
    if (snts == 0) snAge = -1;
    else {
        DWORD d = GetTickCount() - (DWORD)snts;
        snAge = (d > 0x40000000) ? 0 : (int)d;   /* 回绕⇒0，正常≤几十 ms */
    }

    /* 进程内工具名（ps_tool.c 已清洗成 [A-Za-z0-9_-]，JSON 安全）。 */
    char toolName[64];
    pstool_tool_name(toolName, (int)sizeof(toolName));

    int n = _snprintf(out, (size_t)cap,
        "{\"type\":\"smoothState\",\"protocol\":\"2.0\",\"pen\":{"
        "\"enabled\":%d,\"strength\":%d,\"mode\":%d,\"radiusPx\":%d,\"catchUp\":%d,"
        "\"cornerAngle\":%d,\"speedAdaptive\":%s,\"hud\":%d,\"toolGate\":%d,"
        "\"toolOk\":%d,\"penDown\":%d,\"gateOk\":%d,\"contactUnknown\":%d,"
        "\"reason\":%d,\"gateOpen\":%d,\"gateClose\":%d,"
        "\"ctOff\":%d,\"ctVal\":%d,\"ctElig\":%d,\"ctHit\":%d,\"ctOffs\":%d,"
        "\"pxNx\":%d,\"pxNy\":%d,\"pxPerAxis\":%d,\"pxPerAxisY\":%d,"
        "\"dll\":\"%s\",\"injectedPids\":[%lu],"
        "\"state\":%d,\"calls\":%d,\"packets\":%d,\"smoothed\":%d,"
        "\"snAge\":%d,\"stride\":%d,\"offX\":%d,\"offY\":%d,\"offSerial\":%d,"
        "\"axisMax\":%d,\"hookPid\":%d,\"frozeThreads\":%d,"
        "\"toolSrc\":%d,\"psTool\":\"%s\","
        "\"modalLvl\":%d,\"modalKnown\":%d,\"toolModal\":%d,\"toolModalKnown\":%d,"
        "\"docEpoch\":%d,\"notifyAge\":%d,\"gateOwned\":%d,\"lastError\":0}}",
        (int)g_enabled, g_pen.strength, g_pen.mode, g_pen.radiusPx, g_pen.catchUp,
        g_pen.cornerAngle, (g_pen.flags & 1) ? "true" : "false", g_pen.hud, g_pen.toolGate,
        Rd(I_TOOLGATE) != 0 ? 1 : 0, (int)Rd(I_PENDOWN), (int)Rd(I_GATEOK), (int)Rd(I_CTUNKNOWN),
        (int)Rd(I_REASON), (int)Rd(I_GATEOPEN), (int)Rd(I_GATECLOSE),
        (int)Rd(I_CTOFF), (int)Rd(I_CTVAL), (int)Rd(I_CTELIG), (int)Rd(I_CTMASK), (int)Rd(I_CTOFFS),
        (int)Rd(I_PXNX), (int)Rd(I_PXNY), (int)Rd(I_PXPERAXIS), (int)Rd(I_PXPERAXISY),
        dllEsc, (unsigned long)GetCurrentProcessId(),
        (int)Rd(I_STATE), (int)Rd(I_CALLS), (int)Rd(I_PACKETS), (int)Rd(I_SMOOTHED),
        snAge, (int)Rd(I_STRIDE), (int)Rd(I_OFFX), (int)Rd(I_OFFY), (int)Rd(I_OFFSER),
        (int)Rd(I_AXISMAX), (int)Rd(I_PID), (int)Rd(I_FROZE),
        pstool_state(), toolName,
        /* ⛔⛔ 进程内观测（2026-10-17）：面板靠这三项**零 batchPlay**地知道
           「宿主忙不忙 / 工具是否在绘制 / 文档换没换」，从而把自己那几条
           300~500ms 的模态轮询降下来（见 app.tsx 的 psBusyHint 接线）。
           modalKnown = 「层级槽是否有意义」（-1 表示 PS 从未投递 modalStateChanged）。 */
        (int)Rd(I_MODALLVL), (int)Rd(I_MODALLVL) >= 0 ? 1 : 0,
        (int)Rd(I_TMODAL), pstool_tool_modal_known(),
        (int)Rd(I_DOCEPOCH),
        /* ⛔⛔ 0x0115：'slct' 活性看门狗下发。`gateOwned` 是**结论**（原生侧算好），
           面板必须只信它、不要自己拿 notifyAge 比阈值 —— 阈值在原生侧，
           两边各存一份迟早不同步，而不同步的表现恰好是「两边都以为自己该写闸门」。 */
        (int)Rd(I_NOTIFYAGE), (int)Rd(I_GATEOWNED));
    return n > 0 ? n : 0;
}

/* ================================================================ 极简 JSON */
/* 面板消息是扁平对象（值 = 布尔/数字/短字符串），手写定位足够；
   缺字段 = 保持原值（Program.cs 可空字段合并的同款语义）。
   ⛔ 非 static：keyhook.c 的热键协议分发共用（jw_shared.h 声明）。 */
const char* json_find(const char* js, const char* key)
{
    char pat[48];
    _snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char* p = js;
    while ((p = strstr(p, pat)) != NULL) {
        p += strlen(pat);
        while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
        if (*p == ':') {
            p++;
            while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
            return p;
        }
    }
    return NULL;
}

int json_num(const char* js, const char* key, double* out)
{
    const char* p = json_find(js, key);
    if (!p) return 0;
    char* end = NULL;
    double v = strtod(p, &end);
    if (end == p) return 0;
    *out = v;
    return 1;
}

int json_bool(const char* js, const char* key, int* out)
{
    const char* p = json_find(js, key);
    if (!p) return 0;
    if (_strnicmp(p, "true", 4) == 0)  { *out = 1; return 1; }
    if (_strnicmp(p, "false", 5) == 0) { *out = 0; return 1; }
    return 0;
}

int json_str(const char* js, const char* key, char* out, int cap)
{
    const char* p = json_find(js, key);
    if (!p || *p != '"') return 0;
    p++;
    int i = 0;
    /* ⛔ 0x013A 附属修复（2026-10-19 逻辑测试 T8 抓出）：旧写法见到 '"' 就停，
       把 \"（转义引号）误判为串尾 ⇒ 含引号/反斜杠的字段被截断（kh_unesc 随后
       还会在半个转义对上产出乱码）。配置读取路径（kh_parse_items 每字段都走这里）
       对用户录的异常 combo/笔刷名即是静默数据损坏。改为成对拷贝转义序列，
       由调用方的 kh_unesc 统一还原；对不含转义的所有现存输入行为不变。 */
    while (*p && *p != '"' && i < cap - 1) {
        if (*p == '\\' && p[1]) {
            if (i + 1 >= cap - 1) break;      /* 容量容不下整个转义对 ⇒ 截断 */
            out[i++] = *p++;
            out[i++] = *p++;
        } else {
            out[i++] = *p++;
        }
    }
    out[i] = 0;
    return 1;
}

/* ================================================================ WS（RFC6455） */
/* ⛔ M3：sha1/b64/握手/收发/ws_send_text 原语已搬 ws_core.c（keyhook.c 的 18923
   服务器共用）。本文件只保留平滑服务器自己的锁与客户端表；发送一律
   wc_send_text_lk(s, msg, &g_sendLk) —— 广播（持 g_cliLk）与单发必须同锁，
   锁序 CliLk → SendLk 不变。 */

static CRITICAL_SECTION g_sendLk;
static CRITICAL_SECTION g_cliLk;
static SOCKET g_cliS[MAX_CLI];

static void cli_remove(SOCKET s)
{
    EnterCriticalSection(&g_cliLk);
    for (int i = 0; i < MAX_CLI; i++)
        if (g_cliS[i] == s) { g_cliS[i] = INVALID_SOCKET; break; }
    LeaveCriticalSection(&g_cliLk);
}

static int cli_count(void)
{
    int n = 0;
    EnterCriticalSection(&g_cliLk);
    for (int i = 0; i < MAX_CLI; i++)
        if (g_cliS[i] != INVALID_SOCKET) n++;
    LeaveCriticalSection(&g_cliLk);
    return n;
}

static void broadcast(const char* msg)
{
    EnterCriticalSection(&g_cliLk);
    for (int i = 0; i < MAX_CLI; i++) {
        SOCKET s = g_cliS[i];
        if (s == INVALID_SOCKET) continue;
        if (!wc_send_text_lk(s, msg, &g_sendLk)) {   /* 发送失败 ⇒ 强制断开，recv 线程负责回收 */
            closesocket(s);
            g_cliS[i] = INVALID_SOCKET;
        }
    }
    LeaveCriticalSection(&g_cliLk);
}

static void broadcast_smooth_state(void)
{
    char buf[2048];
    if (build_smooth_state(buf, (int)sizeof(buf)) > 0) broadcast(buf);
}

/* ================================================================ 消息分发 */

static void handle_message(const char* js)
{
    char type[32] = "";
    json_str(js, "type", type, (int)sizeof(type));

    if (_stricmp(type, "smoothStatus") == 0) {
        /* 能力探针：必回一帧，否则面板标记「版本过旧」（Program.cs 同款语义）。 */
        broadcast_smooth_state();
        return;
    }
    if (_stricmp(type, "penSmooth") == 0) {
        double v; int b;
        if (json_num(js, "mode", &v))         g_pen.mode        = clampi(roundi(v), 0, 2);
        if (json_num(js, "strength", &v))     g_pen.strength    = clampi(roundi(v), 0, 100);
        if (json_num(js, "radius", &v))       g_pen.radiusPx    = clampi(roundi(v), 1, 100);
        if (json_num(js, "catchUp", &v))      g_pen.catchUp     = clampi(roundi(v), 0, 100);
        if (json_num(js, "cornerAngle", &v))  g_pen.cornerAngle = clampi(roundi(v), 0, 90);
        if (json_num(js, "hud", &v))          g_pen.hud         = roundi(v) & 7;
        if (json_num(js, "hudColor", &v))     g_pen.hudColor    = roundi(v) & 0xFFFFFF;
        if (json_num(js, "toolGate", &v))     g_pen.toolGate    = clampi(roundi(v), 0, 2);
        /* 0x0133：闸门读数的年龄（ms）。缺省保持 0 = 旧行为（老面板不发）。 */
        if (json_num(js, "gateAge", &v))      g_pen.gateAge     = clampi(roundi(v), 0, 60000);
        if (json_bool(js, "speedAdaptive", &b)) g_pen.flags = b ? 1 : 0;
        int on = 0;
        json_bool(js, "on", &on);            /* 缺省 = false（Program.cs ReadBool 同款） */
        /* 0x0121：penSmooth 到达留痕（变化门 + 250ms 节流）。
           ⛔ 为什么补：整条「面板 → WS 18924 → g_pen → 槽位 → HUD」链路此前**零留痕**，
              「调参没生效」类故障（真机 2026-10-17 用户报「减小半径 HUD 圆不变」）
              排了两轮仍只能靠截图反推。现在每次内容变化落一行：
               · 没有行            ⇒ 面板根本没发（sendParams 的 !penOn 早退 / WS 断）
               · 有行但值不对      ⇒ 面板侧状态被覆盖或线格式映射错
               · 行值正确仍不改    ⇒ 槽位→HUD 段（那时再看 [hud] 显示行的 leash=）
           ⚠️ 节流不能没有：拖滑杆时 90ms 一推，不节流就是每秒十几行刷屏。 */
        {
            static volatile LONG s_lastMs;
            static int s_lastOn = -1, s_lastMode = -1, s_lastStr = -1, s_lastRad = -1,
                         s_lastCatch = -1, s_lastCorner = -1, s_lastHud = -1,
                         s_lastCol = -1, s_lastGate = -1, s_lastSpd = -1;
            DWORD nowM = GetTickCount();
            int changed = on != s_lastOn || g_pen.mode != s_lastMode
                       || g_pen.strength != s_lastStr || g_pen.radiusPx != s_lastRad
                       || g_pen.catchUp != s_lastCatch || g_pen.cornerAngle != s_lastCorner
                       || g_pen.hud != s_lastHud || g_pen.hudColor != s_lastCol
                       || g_pen.toolGate != s_lastGate || g_pen.flags != s_lastSpd;
            if (changed && (DWORD)(nowM - (DWORD)s_lastMs) >= 250) {
                s_lastMs = (LONG)nowM;
                s_lastOn = on; s_lastMode = g_pen.mode; s_lastStr = g_pen.strength;
                s_lastRad = g_pen.radiusPx; s_lastCatch = g_pen.catchUp;
                s_lastCorner = g_pen.cornerAngle; s_lastHud = g_pen.hud;
                s_lastCol = g_pen.hudColor; s_lastGate = g_pen.toolGate; s_lastSpd = g_pen.flags;
                log_line("srv", "penSmooth: on=%d mode=%d strength=%d radius=%d catchUp=%d"
                         " corner=%d hud=%d color=%06X toolGate=%d spd=%d",
                         on, g_pen.mode, g_pen.strength, g_pen.radiusPx, g_pen.catchUp,
                         g_pen.cornerAngle, g_pen.hud, (unsigned)g_pen.hudColor,
                         g_pen.toolGate, g_pen.flags);
            }
        }
        commit(on);
        return;
    }
    /* "shutdown" = 面板「服务」开关关闭（disconnectSmoothDaemon 发出，真机实锤
       2026-10-14 jwwh-14480 期）⇒ 进程内形态下等价于**关平滑**（enabled=0），
       服务本身常驻（.8li 不能退出宿主进程）。旧版静默忽略 ⇒ 用户拨开关 OFF
       毫无反应、诊断条也不变 ——「开关怎么拨都没用」的直接原因。 */
    if (_stricmp(type, "shutdown") == 0) {
        commit(0);
        log_line("main", "shutdown ⇒ 平滑已关（服务常驻）");
        return;
    }
    /* 其余未知消息**必须留痕**（节流 2s）：面板侧协议一变，这里静默吞掉的表现就是
       「面板显示一切正常、引擎参数/心跳却停在旧值」——排障时无从下手。 */
    {
        static volatile LONG s_lastMs;
        DWORD nowM = GetTickCount();
        if ((DWORD)(nowM - (DWORD)s_lastMs) >= 2000) {
            s_lastMs = (LONG)nowM;
            char head[64] = "";
            _snprintf(head, sizeof(head), "%s", js);
            log_line("srv", "未知消息(节流): type=\"%s\" 原文=%.60s", type, head);
        }
    }
}

/* ================================================================ 客户端线程 */

static void on_text(void* ctx, const char* text)
{
    (void)ctx;
    handle_message(text);
}

static DWORD WINAPI client_thread(LPVOID param)
{
    SOCKET s = (SOCKET)(UINT_PTR)param;

    if (wc_handshake(s) != 0) { closesocket(s); cli_remove(s); return 0; }
    log_line("srv", "面板已连接 ws");
    broadcast_smooth_state();     /* 建连即推一帧（Program.cs 建连推送同款） */

    /* M3：会话循环搬 ws_core.c（与 18923 热键服务器逐字一致）：
       TCP_NODELAY + 收发超时、ping→pong、close→回 2 字节关帧、分片累积。
       发送一律经 &g_sendLk（与 broadcast 同锁）。 */
    int closedBy = 0;
    wc_client_loop(s, &g_sendLk, on_text, NULL, &closedBy);

    closesocket(s);
    cli_remove(s);
    /* ⛔ 断连原因必须可见（2026-10-14 第七轮）：面板每 ~30-55s 被断一次，
       GATETS 断供 ⇒ 闸门 fail-closed ⇒ 「平滑时好时坏」。先落证据再定责：
       0 = recv 异常（err=10054 对端 RST / 10060 超时 / 10038 …），
       1 = 对端正常 close，2 = 异常大帧。 */
    log_line("srv", "面板已断开 reason=%s err=%d",
             closedBy == 1 ? "对端close" : closedBy == 2 ? "异常大帧" : "recv错误",
             closedBy == 0 ? WSAGetLastError() : 0);
    return 0;
}

/* ================================================================ 服务器线程 */

static volatile LONG g_stopAll = 0;
static HANDLE g_srvThread = NULL;
static HANDLE g_pumpThread = NULL;
static SOCKET g_listen = INVALID_SOCKET;

static DWORD WINAPI server_thread(LPVOID arg)
{
    (void)arg;
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        log_line("srv", "WSAStartup 失败");
        return 1;
    }
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) { log_line("srv", "socket 失败 %d", WSAGetLastError()); return 1; }

    BOOL reuse = TRUE;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(SMOOTH_PORT);
    if (bind(s, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        log_line("srv", "bind 18924 失败 %d —— 多半旧 SmoothDaemon 仍占用端口（M2 起不再需要它），线程退出",
                 WSAGetLastError());
        closesocket(s);
        return 1;
    }
    if (listen(s, 4) != 0) { log_line("srv", "listen 失败"); closesocket(s); return 1; }
    g_listen = s;
    log_line("srv", "监听 127.0.0.1:%d 就绪（进程内 .8li 形态）", SMOOTH_PORT);

    while (!g_stopAll) {
        fd_set rs;
        FD_ZERO(&rs);
        FD_SET(s, &rs);
        struct timeval tv = { 0, 300 * 1000 };
        int r = select(0, &rs, NULL, NULL, &tv);
        if (g_stopAll) break;
        if (r <= 0) continue;

        SOCKET c = accept(s, NULL, NULL);
        if (c == INVALID_SOCKET) continue;
        /* 登记客户端（占用满 ⇒ 拒收新连接） */
        SOCKET slot = INVALID_SOCKET;
        EnterCriticalSection(&g_cliLk);
        for (int i = 0; i < MAX_CLI; i++)
            if (g_cliS[i] == INVALID_SOCKET) { g_cliS[i] = c; slot = c; break; }
        LeaveCriticalSection(&g_cliLk);
        if (slot == INVALID_SOCKET) { closesocket(c); continue; }
        HANDLE t = CreateThread(NULL, 0, client_thread, (LPVOID)(UINT_PTR)c, 0, NULL);
        if (t) CloseHandle(t);           /* 句柄不持有：线程自己退出自清理 */
        else { closesocket(c); cli_remove(c); }
    }
    closesocket(s);
    g_listen = INVALID_SOCKET;
    log_line("srv", "服务器线程退出");
    return 0;
}

/* ================================================================ 推送/心跳线程 */
/* Program.cs SmoothStatePump（500ms 差分广播）+ Heartbeat（1s 写 I_HEARTBEAT）
   合并：引擎 1864 行按「GetTickCount − I_HEARTBEAT > 3000 ⇒ 强制关」判心跳，
   本线程就是心跳的唯一来源（旧守护进程的心跳职责移交于此）。 */
static DWORD WINAPI pump_thread(LPVOID arg)
{
    (void)arg;
    char cur[2048], last[2048];
    last[0] = 0;
    while (!g_stopAll) {
        Sleep(500);
        if (!g_cfg && !cfgmap_open()) continue;
        Wr(I_HEARTBEAT, (LONG)GetTickCount());
        /* ⛔ GATETS（工具心跳）接管（2026-10-14 第七轮真机）：面板侧的 1500ms 心跳
           （penOn 时 setInterval 整包 penSmooth）被实测证明**不可靠**——面板 JS 状态
           机（penOn 门控/重连/UXP 定时器节流）任一环抖动，GATETS 就断供，
           reason=4「工具上报已超时」⇒ 闸门 fail-closed ⇒ 平滑高频失效。
           改为：**只要有 WS 客户端连着，pump 就每 500ms 刷 GATETS** ——
           「面板活着」由 WS 连接本身背书（与引擎注释的设计意图一致：可用性由
           与读数解耦的纯 WS 心跳保证），工具**值**仍由面板巡检消息更新。
           客户端全断 ⇒ 停刷 ⇒ 3s 后自然过期 ⇒ fail-closed 语义保留。 */
        /* ⛔ 进程内闸门接管后，GATETS 的续期不能再依赖「面板连着」：
           'slct' 通知只在**工具变化**时来，而引擎按 GATE_STALE_MS=3000 判过期 ⇒
           不主动续期就会过期 ⇒ fail-closed 阻断 ⇒ 平滑要等用户再切一次工具才活。 */
        if (cli_count() > 0 || pstool_owns()) Wr(I_GATETS, (LONG)GetTickCount());
        /* ⛔ 进程内观测槽（2026-10-17）：模态层级 / 工具模态 / 文档纪元由 ps_tool.c 的
           PICA 回调写进 statics，这里统一搬到共享内存 —— 面板经 smoothState 读到，
           **全程零 batchPlay**。⛔ 槽位表归本文件所有，ps_tool.c 只暴露 getter。 */
        Wr(I_MODALLVL, (LONG)pstool_modal_level());
        Wr(I_MODALTS,  (LONG)(DWORD)pstool_modal_ts());
        Wr(I_TMODAL,   (LONG)pstool_tool_modal());
        Wr(I_TMODALK,  (LONG)(pstool_tool_modal_known() ? 1 : 0));
        Wr(I_DOCEPOCH, (LONG)pstool_doc_epoch());
        Wr(I_NOTIFYAGE, (LONG)pstool_notify_age());
        Wr(I_GATEOWNED, (LONG)(pstool_owns() ? 1 : 0));
        /* 闸门来源状态变化时落一行（只在变化时，避免刷屏）。 */
        {
            static char lastDiag[320];
            char diag[320];
            pstool_diag(diag, (int)sizeof(diag));
            if (strcmp(diag, lastDiag) != 0) {
                memcpy(lastDiag, diag, strlen(diag) + 1);
                pstool_log("闸门状态 %s", diag);
            }
        }
        /* ⑧（LNP WTSanityCheck）：wintab32 被重载 ⇒ 落痕 + 立刻重挂。
           ⛔ 为什么不能只靠 heal_if_unhooked()：它看的是 state/calls，而 wintab32
              被换掉时 state 仍是 1（我们以为自己还挂着），calls 也可能因为 PS 走
              另一条通路而照样涨 ⇒ 那一类断流永远无法归因。这里按模块基址判，
              判据与「是否还在取包」无关。 */
        if (se_wt_moved()) {
            pstool_log("[wt] ★wintab32 已重载（新基址=0x%llX）⇒ 重新挂载",
                       (unsigned long long)(UINT_PTR)se_wt_base());
            send_cmd(2);                  /* 先卸（还原旧映像上的字节） */
            send_cmd(1);                  /* 再挂（在新映像上重新改写） */
        }
        heal_if_unhooked();              /* 守护进程 3s 巡检自愈职责的进程内版 */
        if (build_smooth_state(cur, (int)sizeof(cur)) > 0 &&
            strcmp(cur, last) != 0) {
            memcpy(last, cur, (size_t)strlen(cur) + 1);
            broadcast(cur);
        }
    }
    return 0;
}

/* ================================================================ 服务启停 */

static volatile LONG g_started = 0;

static void services_start(void)
{
    if (InterlockedCompareExchange(&g_started, 1, 0) != 0) return;
    /* 0x013D：Reload ⇒ 引擎复机（与 services_stop 的软停配对）。 */
    jwwh_set_engine_off(0);
    InitializeCriticalSection(&g_sendLk);
    InitializeCriticalSection(&g_cliLk);
    for (int i = 0; i < MAX_CLI; i++) g_cliS[i] = INVALID_SOCKET;
    wc_lk_init();               /* ws_core 内置默认锁（懒初始化兜底，这里主动就绪） */

    /* 先把配置节建好（引擎 worker 在 ATTACH 时已起，250ms 一轮重试 open；
       这里主动建可让首帧参数立刻就位）。 */
    if (cfgmap_open()) {
        if (Rd(I_MAGIC) != CFG_MAGIC) {
            Wr(I_MAGIC, CFG_MAGIC);
            Wr(I_ENABLED, 0);
            Wr(I_TOOLGATE, g_pen.toolGate);
        }
        Wr(I_HEARTBEAT, (LONG)GetTickCount());
        Wr(I_GATETS, (LONG)GetTickCount());
    }

    g_stopAll = 0;
    g_srvThread  = CreateThread(NULL, 0, server_thread, NULL, 0, NULL);
    g_pumpThread = CreateThread(NULL, 0, pump_thread, NULL, 0, NULL);
    /* M3：热键子系统（WS 18923 + WH_KEYBOARD_LL）。⛔ 放在最后起：
       它自带看护/调度/钩子/服务器四个线程，启动即默认布防。 */
    keyhook_start();
    log_line("main", "M2 服务已启动 srv=%s pump=%s kh=%s（引擎 worker 由 ATTACH 启动）",
             g_srvThread ? "ok" : "FAIL", g_pumpThread ? "ok" : "FAIL",
             keyhook_started() ? "ok" : "FAIL");
}

static void services_stop(void)
{
    if (InterlockedCompareExchange(&g_started, 0, 1) == 0) return;
    g_stopAll = 1;
    if (g_listen != INVALID_SOCKET) {      /* 踢醒 select 轮询 */
        shutdown(g_listen, SD_BOTH);
    }
    if (g_srvThread) {
        WaitForSingleObject(g_srvThread, THREAD_WAIT_MS);
        CloseHandle(g_srvThread); g_srvThread = NULL;
    }
    if (g_pumpThread) {
        WaitForSingleObject(g_pumpThread, THREAD_WAIT_MS);
        CloseHandle(g_pumpThread); g_pumpThread = NULL;
    }
    /* M3：热键子系统先于 WS 客户端表清理（它自己的 kh_cli_shutdown_all 会代劳）。 */
    keyhook_stop();
    /* 关掉所有客户端连接 */
    EnterCriticalSection(&g_cliLk);
    for (int i = 0; i < MAX_CLI; i++) {
        if (g_cliS[i] != INVALID_SOCKET) { closesocket(g_cliS[i]); g_cliS[i] = INVALID_SOCKET; }
    }
    LeaveCriticalSection(&g_cliLk);
    /* ⛔ 引擎不在这里卸载：cmd 通道已不可用；PS 退出时 DETACH 有 repatch 兜底，
       「Unload 后继续驻留」正是 .8li 形态的意义（面板重连即恢复）。 */
    /* ⛔⛔ 0x013D：引擎必须**真的哑火**。
       「保持驻留」的本意是线程与 Wintab 补丁不拆（Reload 零成本复机），
       不是「继续平滑」。用户实测：UXP unload 之后铅笔/橡皮仍在被拉绳推着走 ——
       因为两个 detour 还挂在原地址上，软停之前它们只认 enabled，
       而 enabled 与「面板还在不在」并不是一回事。
       ⇒ 置软闸：WTPacketsGet / GetCursorPos 原样透传，HUD 强制隐藏；
         services_start() 里清零复机。 */
    jwwh_set_engine_off(1);
    log_line("main", "M2 服务已停止（引擎软停：detour 透传、线程保留待 Reload 复机）");
    if (g_cfg) Wr(I_ENABLED, 0);
}

/* ================================================================ M1 日志实现 */

const char* jw_log_dir(void)
{
    static char dir[MAX_PATH];
    static int  done;
    if (done) return dir;
    done = 1;
    dir[0] = 0;
    const char* lad = getenv("LOCALAPPDATA");
    if (!lad) return dir;
    _snprintf(dir, sizeof(dir), "%s\\JWautofill\\smooth8li\\", lad);
    dir[sizeof(dir) - 1] = 0;
    return dir;
}

/* ⛔ 非 static：keyhook.c 的 kh_log 走同一实现（jw_shared.h 声明）。 */
void log_line(const char* tag, const char* fmt, ...)
{
    char path[MAX_PATH];
    const char* lad = getenv("LOCALAPPDATA");
    if (!lad) return;
    _snprintf(path, sizeof(path), "%s\\JWautofill\\smooth8li\\pi8li.log", lad);
    {
        char p2[MAX_PATH];
        _snprintf(p2, sizeof(p2), "%s\\JWautofill", lad);
        CreateDirectoryA(p2, NULL);
        _snprintf(p2, sizeof(p2), "%s\\JWautofill\\smooth8li", lad);
        CreateDirectoryA(p2, NULL);
    }

    HANDLE f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    LARGE_INTEGER sz;
    if (GetFileSizeEx(f, &sz) && sz.QuadPart > LOG_MAX) {
        CloseHandle(f);
        DeleteFileA(path);
        f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL,
                        OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (f == INVALID_HANDLE_VALUE) return;
    }
    SYSTEMTIME st;
    GetLocalTime(&st);
    char head[64];
    int nh = _snprintf(head, sizeof(head), "[%04u-%02u-%02u %02u:%02u:%02u.%03u] [%s] ",
                       st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute,
                       st.wSecond, st.wMilliseconds, tag);
    char body[1024];
    va_list ap;
    va_start(ap, fmt);
    int nb = _vsnprintf(body, sizeof(body) - 2, fmt, ap);
    va_end(ap);
    if (nb < 0) nb = 0;
    body[nb] = '\r'; body[nb + 1] = '\n';
    DWORD wr;
    WriteFile(f, head, (DWORD)nh, &wr, NULL);
    WriteFile(f, body, (DWORD)nb + 2, &wr, NULL);
    CloseHandle(f);
}

/* ================================================================ 插件入口 */

typedef struct SPMessageData {
    int  SPCheck;
    void* self;
    void* globals;
    void* basic;
} SPMessageData;

__declspec(dllexport) long AutoPluginMain(const char* caller, const char* selector, void* message)
{
    SPMessageData* md = (SPMessageData*)message;

    if (!caller || !selector) {
        log_line("entry", "异常消息：caller/selector 为空");
        return 0;
    }
    log_line("entry", "消息 caller=\"%.60s\" selector=\"%.60s\" SPCheck=0x%08X self=%p",
             caller, selector,
             md ? (unsigned)md->SPCheck : 0,
             md ? md->self : NULL);

    /* ⛔ 真机实测（M1）：加载="SP Access"/"Reload"，退出="SP Access"/"Unload"。 */
    if ((_stricmp(caller, "SP Interface") == 0 && _stricmp(selector, "Startup") == 0) ||
        (_stricmp(caller, "SP Access")    == 0 && _stricmp(selector, "Reload")  == 0)) {
        /* 进程内工具闸门要在服务起来之前挂上：共享内存节得先存在（pstool 会写槽），
           而引擎 worker 是 ATTACH 时就起的、250ms 一轮重试 open，所以主动建一次。 */
        if (md) {
            cfgmap_open();
            pstool_install(md->basic, md->self);
        } else {
            pstool_log("加载消息里 message=NULL ⇒ 跳过进程内闸门注册");
        }
        services_start();
        return 0;
    }
    if ((_stricmp(caller, "SP Interface") == 0 && _stricmp(selector, "Shutdown") == 0) ||
        (_stricmp(caller, "SP Access")    == 0 && _stricmp(selector, "Unload")   == 0)) {
        pstool_uninstall();
        services_stop();
        return 0;
    }

    log_line("entry", "未处理消息（原样放行）");
    return 0;
}

__declspec(dllexport) long jw8li_version(void) { return 0x0200; }

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved)
{
    /* ⛔ loader lock：ATTACH 只起线程（引擎 worker），绝不做重活。 */
    if (reason == DLL_PROCESS_ATTACH || reason == DLL_PROCESS_DETACH) {
        char self[MAX_PATH] = "?";
        GetModuleFileNameA(hinst, self, sizeof(self));
        if (reason == DLL_PROCESS_ATTACH) {
            DisableThreadLibraryCalls(hinst);
            g_hSelf = hinst;
        } else {
            /* ⛔⛔ 0x0117：DETACH = 本模块即将被卸载映射。正常路径上 AutoPluginMain
               的 "Unload" 已经跑过 services_stop()（幂等，这里直接返回）；但若 PS
               没发 Unload 就 FreeLibrary（异常路径），WS 服务器 / pump / 热键四个
               线程会活过卸载 ⇒ 与引擎四线程同一族崩溃（WER: .8li_unloaded
               0xC0000005）。这里补一次停干净（幂等：g_started 已为 0 时立即返回）。 */
            services_stop();
        }
        log_line("dll", "%s pid=%lu tid=%lu self=%s",
                 reason == DLL_PROCESS_ATTACH ? "DLL_PROCESS_ATTACH" : "DLL_PROCESS_DETACH",
                 (unsigned long)GetCurrentProcessId(),
                 (unsigned long)GetCurrentThreadId(),
                 self);
        engine_dllmain(hinst, reason, reserved);
    }
    return TRUE;
}
