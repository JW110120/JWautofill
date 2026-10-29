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
   56 → 58（0x0115 新增 I_NOTIFYAGE / I_GATEOWNED，见下面注释）；
   58 → 59（0x020A 新增 I_ALTTOOL：Alt 临时吸管的硬否决位）；
   59 → 60（0x0211 新增 I_POLYALT：物理 Alt「临时多边形套索」的硬否决位）。
   两个文件（plugin_main.c / smooth_engine.c）的 CFG_NLONGS **必须同时改**：
   谁先建节谁定尺寸，不一致的一方 MapViewOfFile 会拿到错误的字节数。 */
#define CFG_NLONGS   60

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
    /* ---- 0x020A：Alt 临时吸管的硬否决位 ---- */
    I_ALTTOOL,        /* 1 = 面板明示「此刻是 Alt 临时吸管」⇒ 引擎不改写、不出 HUD。
                         ⛔ 为什么不能复用 I_TOOLGATE：`write_params()` 在
                            `pstool_owns()` 为真时**不写** TOOLGATE（由 'slct' 独占），
                            面板的 0 会被静默丢弃 ⇒ 吸管态仍按套索放行
                            （用户报：吸管按笔吸色时冒出 HUD、取色点被拉绳偏移）。
                         ⛔ 三处兜底清 0：Alt 物理松开（keyhook）、面板不在位
                            （plug_revoke）、服务停止（services_stop）。 */
    /* ---- 0x0211：物理 Alt = PS 原生「临时多边形套索」的硬否决位 ---- */
    I_POLYALT,        /* 1 = Alt 此刻**物理按着**且前台是本进程 ⇒ 引擎不改写、不出 HUD。
                         ⛔ 为什么与 I_ALTTOOL 分成**两个槽**、而不是合成一个：
                            那个位的语义是「面板的**意图**」（按住临时吸管键在取样），
                            这个位的语义是「原生的**事实**」（Alt 真的按着）。
                            写进同一个槽就是两个写者对打：Alt 松开时原生清 0，会顺手
                            抹掉「面板还在吸管里」这一条；反之面板退出吸管清 0，会把
                            「Alt 还按着」也抹掉 ⇒ 用户按住 Alt 画多边形时平滑又冒出来。
                         ⛔ 由 keyhook 每 20ms **镜像电平**（不是边沿）：写之前先比对，
                            只有变化才落盘。镜像式的好处是「谁在别处清过 0」都能在一拍
                            内自愈（边沿式一旦被清掉就永远停在 0，见铁律 76 第四条）。
                         ⛔ 为什么必须由原生置位、而不是照旧让面板判定：多边形套索是
                            **PS 自己的临时模式**，它既不派发工具变更通知、也不改
                            application.tool（用户看到左上角仍是普通套索）⇒ 面板手上
                            没有任何信号能判出「此刻在折线里」。而按键电平是原生独有
                            的事实。它的效果也只是「不改写、不画 HUD」，与面板意图正交。 */
};
typedef char cfg_fit_check[(I_POLYALT < CFG_NLONGS) ? 1 : -1];

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

/* 0x0207：插件本体在位闸（定义见下面 WS 客户端表之后，这里只是前向声明）。
   ⛔ 为什么 pstool_publish 需要它：进程内 'slct' 通知只能证明「PS 还在投递事件」，
      完全不能证明「UXP 面板加载了」。没有这道闸，只要 .8li 在 PS 里，
      一个孤零零的通知回调就能把闸门心跳无限续命。 */
static int plug_present(void);

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
      等于把闸门推在「即将过期」的状态上。
   ⛔⛔ 0x0207：**面板本体不在位时一个字节都不写**。
      通知回调活着（pstool_owns() 为真）只说明 PS 还在投递 'slct'，与「UXP 插件
      加载了没有」毫无关系 —— 旧版把它当成闸门心跳的合法来源，于是「.8li 装了、
      面板没装」的机器上闸门永远新鲜，引擎一直以为用户在用套索。 */
void pstool_publish(int gate)
{
    if (!g_cfg) return;
    if (!plug_present()) return;          /* 0x0207：面板不在位 ⇒ 不续命、不写值 */
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
/* 0x0207：**已握手**的面板连接数（位闸判据）。
   ⛔ 不能拿 g_cliS 的非空槽数（cli_count）当在位判据：accept 就占槽，
      握手可能失败、也可能是一条连上就不说话的第三方 socket。 */
static volatile LONG g_cliReady;

static void cli_remove(SOCKET s)
{
    EnterCriticalSection(&g_cliLk);
    for (int i = 0; i < MAX_CLI; i++)
        if (g_cliS[i] == s) { g_cliS[i] = INVALID_SOCKET; break; }
    LeaveCriticalSection(&g_cliLk);
}

/* 0x0207：原先的 cli_count()（扫槽位非空数）已废弃 —— 位闸改用 g_cliReady。
   ⛔ 不要再拿「槽位非空数」当在位判据：accept 就占槽，握手可能失败、
      也可能是一条连上就不说话的第三方 socket。 */

/* ============================================================ 插件本体在位闸（0x0207） */
/* ⛔⛔ 起因（用户报）：**没通过 UXP 加载插件时，套索平滑照样生效**。
 *
 *   平滑的启用是两道判据相乘：`tool_gate_ok()`（闸门新鲜 + 值是套索）× `I_ENABLED`。
 *   面板不在位时这两道**各自都能独立成立**：
 *     ① `I_ENABLED` 只在「面板发 penSmooth(on=false) / shutdown」「.8li 首次建节」
 *        「.8li 卸载」三处被写 0 ⇒ 面板开过平滑再关闭/崩溃/Reload，它就停在 1；
 *     ② `I_GATETS` 由 pump 每 500ms 续期，条件里写了 `pstool_owns()` ——
 *        而那是**PS 进程内 'slct' 通知**的活性，与 UXP 面板是否加载毫无关系。
 *   两者相乘 ⇒ 面板从未加载的机器上，只要 PS 投递过一个工具切换通知，
 *   平滑（连同 GetCursorPos 接管与 HUD）就永久生效。
 *
 *   修法与 0x0205 的键盘位闸（keyhook.c `g_khPlug`）**同源同语义**：
 *   判据 = 18924 上有已握手的面板客户端。在位 = 放行；不在位 = 收回开关 + 停续心跳。
 *
 *   ⚠️ 宽限期 `PLUG_GRACE_MS`：UXP 面板 reload / 短暂断连会让客户端表归零，
 *      没有宽限就会在用户运笔中途把平滑掐断（表现为一笔硬线）。
 *      宽限内「视同还在位」⇒ 连接回来即无缝续上，不再有 1.5s 的抖动窗口。
 *   ⚠️ 面板侧不需要配合：`penOn`（用户意图）不会被回帧的 enabled 覆写，
 *      重连时 `resendLassoSmoothing()` 会重放 on=true ⇒ 自动恢复。 */
#define PLUG_GRACE_MS 1500

static volatile LONG g_plugOn;          /* 1 = 面板本体在位（含宽限期） */
static volatile LONG g_plugSeenMs;      /* 最近一次真的见到活客户端的 GetTickCount */

static int plug_present(void) { return g_plugOn ? 1 : 0; }

/* 0x0207：面板不在位 ⇒ 收回「平滑开关」这一个权利。
   ⛔ 刻意**不**下发 cmd=2（不卸 detour、不还原字节）：
      与 0x013E 的软停同族 —— 面板重连后 enabled 一变即秒恢复，
      拆挂载反而要重新标定（`CALIB` 会退回未验证态，用户要重切工具才恢复）。
   ⛔ 把 I_TOOLGATE 置 **2（未知）**，不是置 0：
      位闸拦住了 pstool_publish，所以「面板不在位这段时间里用户切过工具」这个事实
      **没有任何人记录** —— 槽里的旧值（比如 1=套索）已经不代表此刻的工具。
      留着它，面板一回来就是「enabled=1 + 新鲜的旧 gate」⇒ 画笔也被平滑。
      置 2 是 fail-closed（引擎阻断），等 ps_tool 的下一次通知或面板轮询给出真值。
      ⛔ 不置 0：那是「我确认当前不是套索」的断言，我们并没有这个证据。 */
/* ============================================================ 0x020A：临时吸管否决位
 *
 * 需求（用户）：工具模式下、当前工具是套索、总开关开着时按住 Alt ⇒ 临时切吸管取样，
 *   松开回套索。自测报出两条：
 *     ① 「Alt 临时切换为吸管后，按下吸色时会错误地触发 HUD 显示」；
 *     ② 「按 Alt 临时切换为吸管后按左键吸色，PS 把它识别成 Alt+左键 ⇒ 改的是背景色」。
 *   ① 的原因是「面板写的 toolGate=0 被 write_params 丢掉」（pstool_owns 时闸门由
 *   'slct' 独占），所以这里开一个**独立槽**，不受任何让位规则影响。
 *   ② 的结论：**无法**让 Alt 绕过 PS（详见 app.tsx `syncAltPickColor` 的根因段），
 *   改用「事后把背景色搬到前景色」。
 *
 * ⛔ 三处清 0 是硬要求：这个位是引擎的**硬否决**（不看心跳、不看闩锁）——
 *   一旦残留 1，套索平滑会整段失效，而界面上看不出任何原因。 */
void srv_alt_tool_clear(const char* why)
{
    if (!g_cfg) return;
    if (Rd(I_ALTTOOL) == 0) return;
    Wr(I_ALTTOOL, 0);
    log_line("alt", "临时吸管：清否决位（%s）", why ? why : "?");
}

/* ==================================================== 0x0211：物理 Alt 否决位
 *
 * 需求（用户）：套索工具下按住 Alt 会临时切到**多边形套索**（PS 原生行为）。此时
 *   ① 光标预览会原地闪烁 / 在几个临近位置来回抖；
 *   ② 每次点击落点后 HUD 会在落点上闪一下再消失；
 *   ③ 平滑本身也不该生效。
 *   要求：**按住 Alt 期间始终不出 HUD、不启用平滑**，松开后两者恢复。
 *
 * 根因：多边形套索是 PS 的**临时模式**，工具仍是 `lassoTool`（用户看到左上角还是
 *   普通套索图标），所以面板的工具闸门、1s 巡检、'slct' 回调**全都看不出变化**
 *   ⇒ 引擎照常改写坐标 ⇒ ① PS 按改写后的（滞后的）光标画折线预览，逐帧推 1~2px
 *   就是抖动；② 点击那一批被当成「一次落笔」，接触判据成立 ⇒ HUD 亮一帧，
 *   拍点无包后 250ms 保持窗到期又灭。
 *
 * ⛔ 判据只能是**按键电平 + 前台是本进程**：这是原生独有的、且是唯一的事实。
 * ⛔ 因此这一位由原生**自己**置位（keyhook 每拍镜像），不经面板往返 —— 面板在
 *    `await batchPlay` 时回不了帧，那种几十~几百毫秒的空档正好是「按下去第一帧还抖」。
 * ⛔ 只镜像电平、不做任何策略：不管当前是什么工具。Alt 在 PS 里就是「临时模式键」
 *    （套索→折线、画笔→吸管、抓手→…），按住期间本来就不会有正常的绘制笔迹。
 * ⛔ 写之前先比对：`Wr` 是共享内存普通写，没必要每 20ms 都落一次。 */
void srv_poly_alt_set(int on)
{
    if (!g_cfg) return;
    LONG v = on ? 1 : 0;
    LONG prev = Rd(I_POLYALT);
    if (prev == v) return;
    Wr(I_POLYALT, v);
    /* ⛔ 只在「平滑开着」时留痕：Alt 在 PS 里被按下的频率很高（Alt+滚轮、Alt+拖拽
       复制、Alt+点蒙版…），每次都写两行会把日志刷成噪音。位本身照写（关着也写），
       只有日志受闸 —— 否则用户重开开关的第一笔就会继承一个陈旧值。 */
    if (Rd(I_ENABLED))
        log_line("alt", "临时多边形套索：物理 Alt %ld → %ld（引擎%s）",
                 (long)prev, (long)v, v ? "停改写 / 停 HUD" : "恢复改写 / 恢复 HUD");
}

static void plug_revoke(void)
{
    log_line("main", "位闸：面板本体不在位 ⇒ 收回平滑开关（enabled 0，detour 保留待复机）");
    InterlockedExchange(&g_enabled, 0);
    Wr(I_ENABLED, 0);
    Wr(I_TOOLGATE, 2);          /* 未知：在位期间的工具变化没人记过账 */
    /* 0x020A：面板不在位 ⇒ 它再也发不出「退出吸管」这一帧了，必须在这里收掉。
       否则用户在一次 Alt 取样中 reload 面板 ⇒ 否决位永远留着 ⇒ 套索平滑整段失效。 */
    srv_alt_tool_clear("面板不在位");
}

/* 每拍调用（pump 500ms + 建连时）。haveCli = 此刻客户端表非空。 */
static void plug_tick(int haveCli)
{
    DWORD now = (DWORD)GetTickCount();
    if (haveCli) {
        InterlockedExchange(&g_plugSeenMs, (LONG)now);
        /* 只在 0→1 翻转时落日志；CAS 保证多线程下也只打一行。 */
        if (InterlockedCompareExchange(&g_plugOn, 1, 0) == 0)
            log_line("main", "位闸：面板本体已就位（ws）⇒ 平滑开关交还面板");
        return;
    }
    if (!g_plugOn) return;
    DWORD seen = (DWORD)g_plugSeenMs;
    if (seen && (DWORD)(now - seen) < PLUG_GRACE_MS) return;   /* 宽限内：视同还在位 */
    if (InterlockedCompareExchange(&g_plugOn, 0, 1) == 1) {
        /* 抢跑保护：撤销前一瞬面板可能刚握手回来（client_thread 已 increment 了
           g_cliReady，但它自己的 plug_tick(1) 还排在后面）。此时撤销会白清一次
           enabled —— 面板要等下一个 1.5s 心跳才恢复，用户看到「平滑偶尔迟一拍」。
           判据用**已握手计数**而不是 plugOn：后者正是本拍要推翻的那一个。 */
        if (g_cliReady > 0) { InterlockedExchange(&g_plugOn, 1); return; }
        plug_revoke();
    }
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

/* ================================================================ 合成点击（0x0201）

 * ── 为什么要合成点击 ────────────────────────────────────────────────
 * 混合器的**储层（reservoir）**是 PS 内部位图：元数据可读
 * （`reservoirState/Cols/Rows/ChannelNumber`），但像素两边都被封死 ——
 * 2026-10-22 实测 `reservoirChannels` = `{}`、单独 `get` 报 -25920（命令不存在）。
 * 而 PS 把**每一条失败的 batchPlay 都画成一条黄色通知** ⇒ 盲试描述符写入这条路
 * 既没有依据、成本又高（一次点击刷十几条黄条，12:05 已踩过）。
 *
 * PS 自己只认一种装填方式：**Alt+左键点画布 = 用画布上的颜色载入画笔**
 * （Photoshop.exe 里的原话：`$$$/WBrushTool/Help/Alt=Click to load brush with colors from canvas.`，
 *  见 2026-10-22 反查）。这是**工具输入层**的手势，AM 事件表里没有对应 command id：
 * 同一份反查里 `wetness`/`reservoir*`/`autoFill`/`loadSolidColorOnly` 全都在，
 * `loadBrush` / `cleanBrush` / `mixerBrushTool` 一个都没有；15:05 的
 * `_mixer-listen.json` 也证实**这个手势不派发任何带储层字段的通知**
 * （30 条全是 modalJavaScriptScopeEnter/Exit、toolModalStateChanged、historyStateChanged）。
 * ⇒ 结论：唯一可行路径是本模块在 PS 进程内**合成一次 Alt+左键**。
 *
 * ── 坐标从哪来（面板不知道文档↔屏幕映射，也不需要知道）────────────────
 * 面板会把彩色图案铺满一张**临时文档**再调这里，所以画布上任何一点都落在图案上。
 * 本模块只需挑一个「确实在 PS 画布上」的点：从主框客户区中心向外试探，接受
 * 第一个「命中窗口在主框子树内 且 面积够大」的点。
 * ⛔ 面积判据不能省：停靠坞 / 工具条 / 选项栏也是主框子树里的窗口，
 *    点在它们上面储层什么也吸不到，而日志里只会显示「失败」。
 */
/**
 * 0x0204：**单击，不拖**。
 *
 * 0x0203 加的 `drag` 已删除 —— 用户口径（16:59）：
 *   「拖动逻辑完全是没必要的，只要正确点到画布中央，吸一下就行；
 *     画布像素少是因为你吸歪了。」
 * 事实核对：16:33 那次 `opaque=340` 的画布是 250×250，而点击点 (1920,1038)
 * 离文档区中心 (1633,1101) 差 287px ⇒ 点已经在画布外，当然"像素少"。
 * 修的是点，不是笔。
 */
typedef struct ClickReq { int alt; int dx; int dy; } ClickReq;
typedef struct ClickFind { DWORD pid; HWND found; } ClickFind;

static volatile LONG g_clkBusy = 0;
static HANDLE g_clkThread = NULL;
/** 挑点结果留痕（0x0202）：命中窗口的类名与尺寸。
 *  判读 `alt` 日志行时，只靠 `pt=(x,y)` 无法区分「点在画布上」还是「点在主框空白处」——
 *  后者点击什么也不会发生，但日志照样 ok=1。 */
static char s_clkHitCls[64] = "";
static int s_clkHitW = 0;
static int s_clkHitH = 0;
/** 命中窗口的左上角（屏幕坐标）。配合 `pt` 就能看出「点在这个窗口内的哪个位置」——
 *  窗口 400×400 而 pt 落在它的右上角 ⇒ 那一枪吸到的是边角料。 */
static int s_clkHitX = 0;
static int s_clkHitY = 0;

static BOOL CALLBACK click_frame_cb(HWND h, LPARAM lp)
{
    ClickFind* f = (ClickFind*)lp;
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    if (pid != f->pid) return TRUE;
    char cls[64];
    cls[0] = 0;
    GetClassNameA(h, cls, (int)sizeof(cls) - 1);
    if (strcmp(cls, "Photoshop") != 0) return TRUE;   /* 与 smooth_engine.c 的 frame_pick_cb 同判据 */
    f->found = h;
    return FALSE;
}

/* 自己解析一遍主框：WS 消息可能比引擎线程先到，不能依赖 s_psFrame 已经就绪。 */
static HWND click_find_frame(void)
{
    ClickFind f;
    f.pid = GetCurrentProcessId();
    f.found = NULL;
    EnumWindows(click_frame_cb, (LPARAM)&f);
    return f.found;
}

static int click_pick_point(HWND frame, int dx, int dy, POINT* out)
{
    RECT cr;
    if (!GetClientRect(frame, &cr)) return 0;
    POINT c;
    c.x = cr.right / 2;
    c.y = cr.bottom / 2;
    if (!ClientToScreen(frame, &c)) return 0;
    static const int offs[][2] = {
        {0,0},{0,-40},{0,40},{-60,0},{60,0},{0,-80},{0,80},{-120,0},{120,0},
        {0,-160},{0,160},{-200,0},{200,0},{0,-260},{0,260},{-320,0},{320,0}
    };
    HWND hit = NULL;
    RECT wr;
    for (unsigned i = 0; i < sizeof(offs) / sizeof(offs[0]); i++) {
        POINT p;
        p.x = c.x + offs[i][0] + dx;
        p.y = c.y + offs[i][1] + dy;
        HWND h = WindowFromPoint(p);
        if (!h) continue;
        if (h != frame && !IsChild(frame, h)) continue;
        RECT r;
        if (!GetWindowRect(h, &r)) continue;
        if (r.right - r.left < 240 || r.bottom - r.top < 240) continue;  /* 排掉 dock/工具条/选项栏 */
        hit = h; wr = r;
        break;
    }
    if (!hit) return 0;

    /* ⛔⛔ 0x0204：**点必须落在文档区的正中，不是主窗口客户区的正中。**
     *
     * 现场（16:53 那三次点击）：
     *   pt=(1920,1038)                          ← 旧代码点的是"主框客户区中心"
     *   hit=Static 3140x1924@(63,139)           ← 命中的文档区矩形
     * 该矩形中心 = (1633,1101) ⇒ 旧点偏右 287px、偏上 63px。
     * 右侧 637px 是浮动面板、顶部 139px 是选项栏，客户区中心天生不在画布上。
     * 400 的画布还勉强压住边，250 的画布就整个点飞了（用户：「位于画布的外侧」）。
     *
     * 解法：从命中窗口继续**往里钻**（取当前窗口中心 → 再命中一次），
     * 直到不再变成更内层的窗口为止。PS 的画布是自绘的 Static，
     * 钻到底就是文档区，它的中心 = 图像中心（JS 侧已 fitOnScreen 居中）。
     */
    for (int i = 0; i < 5; i++) {
        POINT mid;
        mid.x = (wr.left + wr.right) / 2;
        mid.y = (wr.top + wr.bottom) / 2;
        HWND inner = WindowFromPoint(mid);
        if (!inner || inner == hit) break;
        if (inner != frame && !IsChild(frame, inner)) break;
        RECT ir;
        if (!GetWindowRect(inner, &ir)) break;
        if (ir.right - ir.left < 240 || ir.bottom - ir.top < 240) break;
        hit = inner; wr = ir;
    }

    POINT mid;
    mid.x = (wr.left + wr.right) / 2;
    mid.y = (wr.top + wr.bottom) / 2;
    /* dx/dy 是给"图像中心不在窗口中心"的特殊布局留的微调（默认 0）。 */
    mid.x += dx;
    mid.y += dy;
    /* 落点必须仍在这个窗口里，否则宁可不点（点错地方比不点更糟：会画花用户画布）。 */
    if (mid.x < wr.left || mid.x >= wr.right || mid.y < wr.top || mid.y >= wr.bottom) return 0;

    s_clkHitCls[0] = 0;
    GetClassNameA(hit, s_clkHitCls, (int)sizeof(s_clkHitCls) - 1);
    s_clkHitW = (int)(wr.right - wr.left);
    s_clkHitH = (int)(wr.bottom - wr.top);
    s_clkHitX = (int)wr.left;
    s_clkHitY = (int)wr.top;
    *out = mid;
    return 1;
}

/* 绝对坐标移动用虚拟桌面归一化（多屏/负坐标都正确）。 */
static void click_move_abs(POINT pt)
{
    long vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    long vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    INPUT in;
    ZeroMemory(&in, sizeof(in));
    in.type = INPUT_MOUSE;
    if (vw > 1 && vh > 1) {
        in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        in.mi.dx = (LONG)(((LONGLONG)(pt.x - GetSystemMetrics(SM_XVIRTUALSCREEN)) * 65535) / (vw - 1));
        in.mi.dy = (LONG)(((LONGLONG)(pt.y - GetSystemMetrics(SM_YVIRTUALSCREEN)) * 65535) / (vh - 1));
    } else {
        in.mi.dwFlags = MOUSEEVENTF_MOVE;
        in.mi.dx = pt.x;
        in.mi.dy = pt.y;
    }
    SendInput(1, &in, sizeof(INPUT));
}

static void click_key_alt(int down)
{
    INPUT k;
    ZeroMemory(&k, sizeof(k));
    k.type = INPUT_KEYBOARD;
    k.ki.wVk = VK_MENU;
    if (!down) k.ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(1, &k, sizeof(INPUT));
}

static void click_mouse_button(int down)
{
    INPUT m;
    ZeroMemory(&m, sizeof(m));
    m.type = INPUT_MOUSE;
    m.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
    SendInput(1, &m, sizeof(INPUT));
}

static DWORD WINAPI click_thread(LPVOID param)
{
    ClickReq req = *(ClickReq*)param;
    free(param);

    int ok = 0, why = 0;
    POINT pt;
    pt.x = pt.y = -1;
    HWND frame = click_find_frame();
    if (!frame) {
        why = 1;
    } else if (!click_pick_point(frame, req.dx, req.dy, &pt)) {
        why = 2;
    } else {
        /* PS 不在前台时，第一次点击只用于激活窗口（并被吞掉）⇒ 先自己激活再点。 */
        if (GetForegroundWindow() != frame) {
            SetForegroundWindow(frame);
            Sleep(180);
        }
        POINT prev;
        GetCursorPos(&prev);
        click_move_abs(pt);
        Sleep(40);
        /* ⛔ 顺序不能变：Alt 必须先按住，PS 是在**左键按下那一刻**读键态决定
           「载入画笔」还是「画一笔」。 */
        if (req.alt) { click_key_alt(1); Sleep(40); }
        click_mouse_button(1);
        Sleep(60);
        click_mouse_button(0);
        Sleep(40);
        if (req.alt) { click_key_alt(0); Sleep(30); }
        SetCursorPos(prev.x, prev.y);          /* 光标还给用户（笔尖那边的系统光标会跳一下） */
        ok = 1;
    }

    log_line("alt", "合成点击 alt=%d dx=%d dy=%d ok=%d why=%d pt=(%ld,%ld) hit=%s %dx%d@(%ld,%ld) ptInHit=%ld,%ld frame=%p fg=%p fgIsFrame=%d",
             req.alt, req.dx, req.dy, ok, why,
             (long)pt.x, (long)pt.y, s_clkHitCls[0] ? s_clkHitCls : "?", s_clkHitW, s_clkHitH,
             (long)s_clkHitX, (long)s_clkHitY,
             (long)(pt.x - s_clkHitX), (long)(pt.y - s_clkHitY),
             (void*)frame,
             (void*)GetForegroundWindow(), (frame && GetForegroundWindow() == frame) ? 1 : 0);

    char buf[192];
    _snprintf(buf, sizeof(buf),
              "{\"type\":\"canvasClickResult\",\"ok\":%d,\"why\":%d,\"alt\":%d,\"x\":%ld,\"y\":%ld}",
              ok, why, req.alt, (long)pt.x, (long)pt.y);
    buf[sizeof(buf) - 1] = 0;
    broadcast(buf);

    InterlockedExchange(&g_clkBusy, 0);
    return 0;
}

/* 起一枪（异步：WS 客户端线程不能被 Sleep 链占住）。同一时刻只允许一发。 */
static void click_start(int alt, int dx, int dy)
{
    if (InterlockedCompareExchange(&g_clkBusy, 1, 0) != 0) {
        log_line("alt", "合成点击被拒：上一发还没结束（alt=%d dx=%d dy=%d）", alt, dx, dy);
        return;
    }
    if (g_clkThread) { CloseHandle(g_clkThread); g_clkThread = NULL; }
    ClickReq* r = (ClickReq*)malloc(sizeof(ClickReq));
    if (!r) { InterlockedExchange(&g_clkBusy, 0); return; }
    r->alt = alt; r->dx = dx; r->dy = dy;
    g_clkThread = CreateThread(NULL, 0, click_thread, r, 0, NULL);
    if (!g_clkThread) {
        free(r);
        InterlockedExchange(&g_clkBusy, 0);
        log_line("alt", "合成点击线程创建失败");
    }
}

/* 卸载路径必须等它跑完：合成点击线程里的 SendInput 会在本模块被卸载之后继续
   向系统投递事件（与 0x013F 记的「活线程留给系统」同一族风险）。 */
static void click_join(DWORD ms)
{
    if (!g_clkThread) return;
    if (WaitForSingleObject(g_clkThread, ms) != WAIT_OBJECT_0)
        log_line("alt", "⚠ 合成点击线程 %lums 未退出（仍 CloseHandle）", (unsigned long)ms);
    CloseHandle(g_clkThread);
    g_clkThread = NULL;
    InterlockedExchange(&g_clkBusy, 0);
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
    /* 0x020A：Alt 临时吸管开关（面板 → 引擎的**硬否决位**）。
       ⛔ 用 json_num 判非零，不用 json_bool —— 后者只认 true/false，
          数字 1 会**静默失败**（既有铁律：严格类型助手）。
       ⛔ 不走 g_pen / write_params：这一位与 penSmooth 整包无耦合，
          面板也不该在每秒 1.5 次的心跳里反复携带它。 */
    if (_stricmp(type, "altTool") == 0) {
        double v = 0;
        int on = 0;
        if (json_num(js, "on", &v)) on = (v != 0.0) ? 1 : 0;
        LONG prev = Rd(I_ALTTOOL);
        Wr(I_ALTTOOL, on);
        if (prev != on)
            log_line("alt", "临时吸管：否决位 %ld → %d（引擎停改写/停 HUD）", (long)prev, on);
        return;
    }
    if (_stricmp(type, "penSmooth") == 0) {
        double v; int b;        if (json_num(js, "mode", &v))         g_pen.mode        = clampi(roundi(v), 0, 2);
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
    /* 0x0201：合成一次画布点击（alt=1 就是混合器「用画布颜色载入画笔」）。
       面板在**不可脚本化**的储层上唯一能走的路，详见上面 click_thread 的注释。 */
    if (_stricmp(type, "canvasClick") == 0) {
        int alt = 0, dx = 0, dy = 0;
        double v;
        /* ⛔⛔ 0x0202：`json_bool` **只认 true/false 两个字面量**（见它的实现），
           面板发的是数字 `"alt":1` ⇒ 旧写法把它整条吞成 0。
           真实现场（2026-10-22 16:16）：两次点击的日志全是 `alt=0`，
           第一枪本该「用画布颜色载入画笔」，结果变成普通落笔 ——
           储层指纹 1→1 没动、dab 是纯前景色、用户看到的也是纯色。
           所以这里必须按**数字**解析，bool 只作兜底。 */
        if (json_num(js, "alt", &v)) alt = (v != 0.0) ? 1 : 0;
        else json_bool(js, "alt", &alt);
        if (json_num(js, "dx", &v)) dx = roundi(v);
        if (json_num(js, "dy", &v)) dy = roundi(v);
        click_start(alt, dx, dy);
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

    /* 0x0207：18924 只服务 UXP 面板本体。
       ⛔ 为什么必须按 path 收口：位闸的判据是「有已握手客户端」，
          迁移探测（keyhook.c 的 kh_try_migrate）这类**非面板**连接一旦被算进来，
          多开 PS 时就能给持有端伪造「插件在位」⇒ 平滑在面板没加载的机器上照样生效。
       ⛔⛔ 只拒**已知的探测路径**（精确等于 "/jw-migrate"），其余一律放行。
          绝不能写成「非 "/" 就拒」：不同 WebSocket 实现（含 UXP 的 Chromium）请求行
          可能是 `GET ws://host/` 或带 query 的形式，path 抽出来就不是 "/" 了 ——
          那会把真面板锁在门外（表现：面板永远「未连接」，平滑彻底失效）。
          将来若要收口新的探测器，往下面这个判据里加名字即可。 */
    char wpath[64] = "";
    int ready = 0;
    if (wc_handshake_path(s, wpath, (int)sizeof(wpath)) == 0) {
        if (wpath[0] && _stricmp(wpath, "/jw-migrate") == 0)
            log_line("srv", "拒收迁移探测连接 path=%s（不计入插件在位）", wpath);
        else
            ready = 1;
    }
    if (!ready) { closesocket(s); cli_remove(s); return 0; }

    InterlockedIncrement(&g_cliReady);   /* ⛔ 位闸判据只认「已握手」的连接：
                                            accept 占槽发生在握手前，拿 cli_count 判在位
                                            会让一条连上就不说话的 socket 伪造在位。 */
    log_line("srv", "面板已连接 ws");
    plug_tick(1);                 /* 0x0207：不等到下一拍 pump，建连即交还在位 */
    broadcast_smooth_state();     /* 建连即推一帧（Program.cs 建连推送同款） */

    /* M3：会话循环搬 ws_core.c（与 18923 热键服务器逐字一致）：
       TCP_NODELAY + 收发超时、ping→pong、close→回 2 字节关帧、分片累积。
       发送一律经 &g_sendLk（与 broadcast 同锁）。 */
    int closedBy = 0;
    wc_client_loop(s, &g_sendLk, on_text, NULL, &closedBy);

    closesocket(s);
    cli_remove(s);
    InterlockedDecrement(&g_cliReady);
    if (g_cliReady < 0) InterlockedExchange(&g_cliReady, 0);   /* services_start 复位后的僵尸线程兜底 */
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
        /* 0x0207：位闸先行（**必须在 cfgmap 早退之前**）——无面板时也要能收回开关。
           haveCli 一并缓存给下面的 GATETS 判据用。 */
        int haveCli = (g_cliReady > 0) ? 1 : 0;
        plug_tick(haveCli);
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
        /* ⛔⛔ 0x0207：两个来源**都必须先过位闸**。
           `pstool_owns()` 是「PS 进程内的 'slct' 通知还活着」，与「UXP 面板加载了没有」
           毫无关系 —— 旧版把它直接当续期理由，于是「.8li 装了、面板没装」的机器上
           闸门时间戳永远新鲜，引擎一直以为用户在画套索。 */
        if (plug_present() && (haveCli || pstool_owns())) Wr(I_GATETS, (LONG)GetTickCount());
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

/* ================================================================ 崩溃取证（0x013E） */
/* 为什么必须加：2026-10-19 21:39 那场「关闭 PS 弹 Release 崩溃框」既没有 WER 的
   Application Error（事件日志一条都没有），也没有 Adobe crashreporter 的
   crwincrashlog（%LocalLow%\com.adobe.crashreporter\...\5fb7f128-* 里只剩一个
   0 字节的 .session_38280.marker），pi8li.log 停在 21:39:12 的 HUD 行 ⇒
   故障偏移无从得知，只能靠推断。

   这里挂一层**最上层**未处理异常过滤器：写一份 minidump 到
   %LOCALAPPDATA%\JWautofill\dumps\，然后**原样转交给前一个过滤器**
   （PS/Adobe 自己的崩溃上报与「生成报告」对话框完全不受影响）。
   dbghelp 在服务启动时（PS 主线程）加载 —— 绝不在异常上下文里 LoadLibrary。 */
typedef struct JW_MEDIC {
    DWORD              ThreadId;
    EXCEPTION_POINTERS* ExceptionPointers;
    BOOL               ClientPointers;
} JW_MEDIC;
typedef BOOL (WINAPI *fn_write_dump)(HANDLE, DWORD, HANDLE, int,
                                     const void*, const void*, const void*);

static fn_write_dump g_writeDump;
static LPTOP_LEVEL_EXCEPTION_FILTER g_prevFilter;
static volatile LONG g_crashGuard;
static int g_crashInited;

static LONG WINAPI jw_crash_filter(EXCEPTION_POINTERS* ep)
{
    /* ⛔ 只做一次：过滤器内部再抛异常时不重入，避免转储里套转储。 */
    if (InterlockedCompareExchange(&g_crashGuard, 1, 0) == 0) {
        const char* lad = getenv("LOCALAPPDATA");
        if (lad && g_writeDump) {
            char dir[MAX_PATH], path[MAX_PATH];
            _snprintf(dir, sizeof(dir), "%s\\JWautofill\\dumps", lad);
            dir[sizeof(dir) - 1] = 0;
            CreateDirectoryA(dir, NULL);
            _snprintf(path, sizeof(path), "%s\\crash-%lu-%lu.dmp", dir,
                      (unsigned long)GetCurrentProcessId(),
                      (unsigned long)GetTickCount());
            path[sizeof(path) - 1] = 0;
            HANDLE h = CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                                   FILE_ATTRIBUTE_NORMAL, NULL);
            if (h != INVALID_HANDLE_VALUE) {
                JW_MEDIC mi;
                mi.ThreadId = GetCurrentThreadId();
                mi.ExceptionPointers = ep;
                mi.ClientPointers = FALSE;
                BOOL ok = g_writeDump(GetCurrentProcess(), GetCurrentProcessId(), h,
                                      0 /* MiniDumpNormal：含全部线程栈 + 模块表 */,
                                      &mi, NULL, NULL);
                CloseHandle(h);
                log_line("crash", "★未处理异常 code=0x%08X addr=%p ⇒ 转储 %s（%s）",
                         ep && ep->ExceptionRecord ? (unsigned)ep->ExceptionRecord->ExceptionCode : 0u,
                         ep && ep->ExceptionRecord ? ep->ExceptionRecord->ExceptionAddress : NULL,
                         path, ok ? "ok" : "MiniDumpWriteDump 失败");
            } else {
                log_line("crash", "★未处理异常 ⇒ 转储创建失败 %s", path);
            }
        }
    }
    return g_prevFilter ? g_prevFilter(ep) : EXCEPTION_CONTINUE_SEARCH;
}

/* ⛔ 只能装一次：Reload 时 SetUnhandledExceptionFilter 会把「上一次的我们」当成
   前一个过滤器，链成环 ⇒ 崩溃时自己调自己。 */
static void crash_capture_install(void)
{
    if (g_crashInited) return;
    g_crashInited = 1;
    HMODULE m = LoadLibraryA("dbghelp.dll");
    if (m) g_writeDump = (fn_write_dump)(UINT_PTR)GetProcAddress(m, "MiniDumpWriteDump");
    g_prevFilter = SetUnhandledExceptionFilter(jw_crash_filter);
    log_line("crash", "崩溃取证已就绪（dbghelp=%s）", g_writeDump ? "ok" : "缺失");
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
    /* 0x0207：位闸复位到「面板不在位」——新服务会话一律从「无面板」起步。
       ⛔ 旧版只在 MAGIC 不匹配时清 I_ENABLED，于是 **.8li Reload**（同一 PS 进程，
          节里的 MAGIC 仍然匹配）会把上一轮的 enabled=1 原样继承下来：
          面板还没重连的那段时间里，平滑照样生效。 */
    InterlockedExchange(&g_plugOn, 0);
    InterlockedExchange(&g_plugSeenMs, 0);
    InterlockedExchange(&g_cliReady, 0);
    InterlockedExchange(&g_enabled, 0);
    if (cfgmap_open()) {
        if (Rd(I_MAGIC) != CFG_MAGIC) {
            Wr(I_MAGIC, CFG_MAGIC);
            Wr(I_TOOLGATE, g_pen.toolGate);
        }
        Wr(I_ENABLED, 0);                       /* 0x0207：无条件清（Reload 也要清） */
        /* 0x020A：同理，临时吸管的硬否决位必须从「无」起步。
           ⛔ 漏了它，.8li Reload 会把上一轮的 1 继承下来 ⇒ 面板还没连上就整段不平滑。 */
        Wr(I_ALTTOOL, 0);
        /* 0x0211：物理 Alt 的镜像位同理。⛔ 它在正常运行时由 keyhook 每拍自愈
           （镜像式），但「Reload 那一刻用户正按着 Alt 且 keyhook 线程还没起来」
           这段空窗没有人写它 ⇒ 必须在这里无条件清 0。 */
        Wr(I_POLYALT, 0);
        Wr(I_HEARTBEAT, (LONG)GetTickCount());
        Wr(I_GATETS, (LONG)GetTickCount());
    }

    g_stopAll = 0;
    crash_capture_install();    /* 0x013E：崩溃取证（幂等，Reload 不会重复挂链） */
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
        if (WaitForSingleObject(g_srvThread, THREAD_WAIT_MS) != WAIT_OBJECT_0) {
            log_line("main", "⚠ 服务器线程 %dms 未退出（仍 CloseHandle ⇒ 停止标志已置，返回值不再使用）",
                     THREAD_WAIT_MS);
        }
        CloseHandle(g_srvThread); g_srvThread = NULL;
    }
    if (g_pumpThread) {
        if (WaitForSingleObject(g_pumpThread, THREAD_WAIT_MS) != WAIT_OBJECT_0) {
            log_line("main", "⚠ 泵线程 %dms 未退出（仍 CloseHandle）", THREAD_WAIT_MS);
        }
        CloseHandle(g_pumpThread); g_pumpThread = NULL;
    }
    /* M3：热键子系统先于 WS 客户端表清理（它自己的 kh_cli_shutdown_all 会代劳）。 */
    keyhook_stop();
    /* 0x0201：合成点击线程必须在关 socket 之前收干净（它跑完会 broadcast 一次结果）。
       ⛔ 与 0x013F 同纪律：不能把「回调/投递仍在跑」的线程留给卸载后的系统。 */
    click_join(1500);
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

/* 导出表版本（面板不看它，但排障时用来确认「装的是哪一版」）。
   0x0201（2026-10-22）：新增 canvasClick 合成点击（混合器储层重装，见 click_thread）。
   0x0202（2026-10-22）：canvasClick 的 `alt` 改按**数字**解析（json_bool 只认 true/false，
                        数字 1 被吞成 0 ⇒ 两枪都变成普通落笔，储层纹丝不动）；挑点命中
                        窗口的类名/尺寸写进 `[alt]` 日志行。
   0x0203（2026-10-22）：canvasClick 新增 `drag`（按下后水平拖 N 像素再抬笔）。混合器是
                        "湿笔"，**单击几乎落不下颜料**（16:33 那轮 dab 只有 340px，
                        面板误判成"纯色"）⇒ 验货必须拖一段才是真实笔迹；`[alt]` 日志
                        再补命中窗口左上角，好判断点落在窗口的哪个角。
   0x0204（2026-10-22 17:00）：**删掉 drag**（用户裁定：拖动没必要，像素少是吸歪造成的）；
                        挑点改为「命中窗口中心 + 往里钻」——旧的"主框客户区中心"
                        在 3840 屏上比文档区中心偏右 287px，250 的画布因此整个点飞
                        （pt=(1920,1038) vs 文档区中心 (1633,1101)）。
   0x0205（2026-10-23）：**键盘钩子加「插件本体在位」闸**（keyhook.c g_khPlug）——
                        用户报：开发期没装 UXP 本体，但 .8li 随 PS 装上后默认布防，
                        把 L / NUM1 等键吞掉且无人消费广播。现在 LL 钩子安装意图 /
                        键态轮询兜底 / RegisterHotKey 同步三路统一要求 18923 有客户端
                        （面板进程活着）；最后一个客户端断开即卸钩放行，重连自动装挂。
                        ⚠️ 刻意不做「连过一次就粘住」：面板卸载/崩溃后钩子必须熄火。
   0x0206（2026-10-23，热键「跑一阵子就未连接且无法自愈」）：
                        ① ws_core.c：`SO_RCVTIMEO`(60s) 超时被当成断开 ⇒ 空闲连接每 60s
                           被服务端自己踹掉一次。改为 recv_all 返回 -2 =「一字节都没读到的空闲
                           超时」，会话循环 continue 并顺手发 ping 探活（对端已死则 send 失败，
                           照样回收，不留僵尸）；读到半帧才超时仍按错误断开。
                        ② keyhook.c：`kh_cli_remove` 把槽位标成 closing=1 就返回，而
                           `kh_cli_add` 的准入是 `s==INVALID_SOCKET && !closing` ⇒ **每断一次
                           永久废掉一格**，表只有 8 格 ⇒ 断 8 次后所有新连接被拒收（面板永远
                           「未连接」，reload 也没用 —— 表在 PS 进程里，只有重启 PS 才清零）。
                           现在归还槽位时把 closing/notPlugin 一起清 0；准入只看「s 已归还」。
                           另：握手失败路径改成「先还槽位再 closesocket」，防止即时的 SOCKET
                           值复用被随后的 remove(s) 按值误删新连接。
   0x0207（2026-10-24，**没通过 UXP 加载插件时套索平滑仍生效**）：
                        平滑的启用 = `tool_gate_ok()` × `I_ENABLED`，面板不在位时这两道
                        各自都能独立成立：① I_ENABLED 只在「面板命令 / 首次建节 / 卸载」
                        三处写 0 ⇒ 面板开过平滑再关/崩溃/Reload 就停在 1；② pump 每 500ms
                        续期 GATETS 的条件里写了 `pstool_owns()`（PS 进程内 'slct' 通知的
                        活性，**与 UXP 面板是否加载毫无关系**）⇒ 闸门时间戳永远新鲜。
                        现在与 0x0205 的键盘位闸同源：判据 = 18924 上有**已握手**的面板
                        客户端（`g_cliReady`，按 path "/" 收口，拒收迁移探测/第三方脚本）。
                        不在位（宽限 1500ms，盖住面板 reload 抖动）⇒ `plug_revoke()` 收回
                        enabled + 停续 GATETS + `pstool_publish()` 一个字节都不写；
                        detour 与标定保留（面板重连重放 on=true 即秒恢复，无需重标定）。
                        services_start 无条件清 I_ENABLED（Reload 不再继承上一轮的 1）。 */
/* 0x0208：宿主交互态（左键/空格）边沿推送 + 视图导航否决 + HUD 空闲退避。
   面板据 hostBusy 在拖拽/缩放期间让巡检让路；引擎在空格按着时绝不改写坐标。
   见 keyhook.c 调度线程的「0x0208」段、smooth_engine.c 的 view_nav_down()。 */
/* 0x0209：① 工具闸门拆「事实 / 没来得及报」（切工具立刻停，心跳抖动不打断一笔）；
   ② 光标路径抖动不透传（停笔不再画直线）；
   ③ 新增 Alt 边沿推送 `altHold`（工具模式下的临时吸管：按住吸管、松开回套索）。
   见 smooth_engine.c 的 tool_gate_sure_not_lasso / GP_HOLD_MS、keyhook.c 的 0x0209 段。 */
/* 0x020A：① 新增 `I_ALTTOOL`（Alt 临时吸管的**硬否决位**，独立槽、不受 gateOwned 让位）：
   面板按下 Alt 时置 1 ⇒ 引擎立刻停改写/停 HUD；Alt 物理松开 / 面板不在位 /
   服务重启 三处清 0。根因：面板写 toolGate=0 会被 `write_params` 丢弃
   （pstool_owns 时由 'slct' 独占），于是吸管按笔吸色时 HUD 冒出来、取色点被拉绳偏移。
   ② 入站新增 `{"type":"altTool","on":0|1}`。
   见 keyhook.c 的 Alt 边沿块、smooth_engine.c 的 tool_edit_allowed / gateOk。 */
/* 0x020B（2026-10-28，**白背景吸白色时前景色不动**）：
   `hostBusy` 增加 `btn` 字段（1 = 这一帧左键按着），把「左键」与「空格」拆开。
   面板侧 `syncAltPickColor` 原来用「背景色变了没有」判「有没有取色」——
   背景色为白、吸的也是白 ⇒ 两值相等 ⇒ 被判成「没取色」⇒ 前景永不更新。
   颜色相等与压根没吸在**值上不可区分**，只能用输入事实判 ⇒ 见
   utils/hostInteraction.ts 的 busyHadLeft、app.tsx 的 syncAltPickColor。
   ⛔ 只加字段不动 `v` 语义；`btn` 变化单独触发一帧（拖拽中 v 恒 1，没有边沿）。 */
/* 0x020C（2026-10-28，**标准模式的强度滑杆几乎无效**）：
   ① `g_speed` 原来用 `|raw − out| / dt`（滞后）当笔速 —— 强度越大 ⇒ 滞后越大 ⇒
      被判成「甩笔」⇒ 速度适应把平滑削弱 ⇒ 滞后又被压回小值。这条负反馈把稳态滞后
      锁在 4~6px，强度 0→100 的差别只剩 3.7→5.7px（模拟值）。
      现在笔速改由「≥6px 距离窗的真实位移 / 真实时长」结算。
   ② 尖角保护原来要求**单包**位移 > 3px 才判拐角，而 205Hz 下正常运笔每包只有 1~2px
      ⇒ 慢速画线时该参数整段不触发。现在参考方向由 ≥3px 线段推进、当前方向由 ≥2px
      累积位移给出。见 smooth_engine.c 的 s_spRef* / s_cRef* 与 SPEED_WIN_PX。
   协议无字段变化 ⇒ CFG_NLONGS 仍是 59。 */
/* 0x020D（2026-10-28，**拉绳模式：光标在圈内移动时圆环与圆心一直小幅抖动**）：
   圆心屏幕位置 = 光标 − 偏移，而偏移每帧要用「上一包速度 × age」把 raw 外推到当前
   时刻（否则圆心随光标漂）。raw 是整数轴坐标，量化 ±1 屏幕像素 ÷ 包间隔(≈5ms) ⇒
   速度噪声 ≈0.2px/ms，乘 age（0~8ms 逐帧变）⇒ 圆心每帧被推 1~2px（模拟峰峰 2px）。
   而绳没绷紧时**绘制点本来就被冻住**（包路径 distPx ≤ radius 时不改 g_ox）⇒ 此刻
   圆心就该一动不动，外推提供的信息量是零、噪声却是全部。
   现在：`snOutX/Y` 与上次提交位置时相同 ⇒ 复用上一帧位置（判据用绘制点，不用光标）；
   位置另加整像素迟滞（HUD_PX_HYST，边界死区 0.3px）防「停在 .5 边界上翻格」。
   见 smooth_engine.c 的 hud_sticky_px / hud_thread 绘制段。协议无变化。 */
/* 0x020E（2026-10-28，**拉绳模式的绳变成一根直棍、端点跑到圆周外**）：
   0x020D 修抖动时把绳向量从 `rx/ry` 改成「光标 − 已提交的窗口左上角」，但漏了
   `putXc/putYc` 是**左上角**、圆心在窗内 (half, half) ⇒ 实际拿到的是 `(rx+half, ry+half)`。
   后果：vlen ≈ |(124,124)| ≈ 175 > leashPx(100) ⇒ 绷直判据每帧成立 ⇒ sag 恒 0
   （绳变直棍）；端点画在 `half + vx = 2·half + rx`（圆周外）；方向被常量 (half,half)
   主导 ⇒ 只在右下 45° 附近随笔向轻摆。现在减去 half，恢复「光标相对圆心」的语义。
   见 smooth_engine.c 的 rope 段与 rope=%d 日志字段。协议无变化。 */
/* 0x020F（2026-10-28，**拉绳模式正常绘制中 HUD 偶尔消失一下又回来**）：
   日志实证（jwwh-24800，16:53:12–16:55:31 共 18 次「隐藏→显示」，其中 10 次是
   `gate=1 stroke=1 penDown=1`——笔一直按着，消失 224~420ms，肉眼必见）。
   三条根因，逐条收口：
   ① `realOk`（最后一批**真实包** ≤ 400ms）是主因：驱动短暂空转就过期，而快照
      仍来自真实包、几何完全可信。现在「一笔进行中 + 未进合成接管」放到 1500ms
      （`HUD_REAL_SLACK_MS`）；已接管仍按 0x0126 隐藏（合成包喂出的 tip 不可信）。
   ② `lagSkip` / `bigJump` 被并进了 `cheapOk` ⇒ 走 `ShowWindow(SW_HIDE)`，
      而它们的注释明写「窗口保持上一帧内容，不是隐藏」。现在只跳重绘
      （连续超过 `HUD_SKIP_MAX_MS` 则强行画一帧，免得圆僵住）。
   ③ 新增隐藏去抖 `HUD_HIDE_DEBOUNCE_MS`(90ms)：任何单帧判据抖动都不许提交隐藏，
      否则一次 1~2 帧的抖动会被 180ms 重现去抖放大成可见的消失。
   见 smooth_engine.c 的 realOk / staleFrame / s_hudMissSince。协议无变化。 */
/* 0x0210（2026-10-28，**临时吸管键与套索的 Alt 冲突**）：
   用户报：工具模式下按 Alt 临时吸管，但套索工具下 Alt 本身就是 PS 原生的
   「临时切多边形套索」⇒ 同一个键被两个功能抢。
   ⇒ 临时吸管的键源从「物理 Alt」换成配置里的独立条目（action == "altTool"，
   默认 `/`，可在功能快捷键子面板重录）。
   实现要点（keyhook.c）：该条目**不进热键匹配表**（不吞键、不参与 RegisterHotKey，
   否则键被摘走就测不到「按住」），只解析成 (vk, mods) 后由调度线程按电平轮询，
   仍按边沿推 `altHold`（协议、消息名都不变）。未装载（工具模式关闭）= vk 0 ⇒ 恒不按着。
   面板侧（HotkeyBridge）：新增 altTool 条目与装载/重录通路，随工具模式启停。
   协议无变化（消息体与字段逐字不变，仅含义从「Alt 电平」变成「按住键电平」）。 */
/* 0x0211（2026-10-28，**按住 Alt 画多边形套索时 HUD 抖 / 闪 / 平滑不该生效**）：
   用户报（三条）：① 折线落笔前移动光标确认落点时，预览原地闪烁或在几个临近位置
   来回抖；② 每次落笔后落点上 HUD 闪一下再消失；③ 按住 Alt 期间本就该没有平滑。
   根因：多边形套索是 PS 的**临时模式**，工具仍是 lassoTool（左上角图标不变），
   面板的工具闸门 / 巡检 / 'slct' 回调全都看不出变化 ⇒ 引擎照常改写坐标
   ⇒ 滞后的光标被 PS 当折线预览逐帧画（抖），点击那一批又被当成一次落笔（HUD 闪）。
   ⇒ 新增独立槽 `I_POLYALT`：物理 Alt 按着且前台是本进程 ⇒ 硬否决（不改写、不出 HUD）。
   与 `I_ALTTOOL` **分槽**：那个是面板意图（按住取样键），这个是原生事实（Alt 真的按着），
   合槽会互相清掉对方。置位由 keyhook 每 20ms 镜像电平（写前比对），不经面板往返
   —— 面板 `await batchPlay` 期间回不了帧，那段空窗正是「按下去第一帧还在抖」。
   ⛔ CFG_NLONGS 59 → 60（两个 C 文件同步改）；理由码新增 `RS_POLYALT`。 */
/* 0x0212（2026-10-29，**`/` 与 `Shift+/` 的冲突**）：
   用户报：临时吸管按住键是 `/`，新增的「前景色拾色器」默认 `Shift+/` —— 按 Shift+/
   开拾色器时，原生侧仍把「斜杠按着」当成临时吸管按住（组合键是裸键时旧写法只检查
   「列出的修饰键按着没」，等于什么都没检查）⇒ 两个功能同时触发。
   ⇒ keyhook.c 的按住判定改成「修饰键完全匹配 + 一次性起按准入」：
     未列出的修饰键必须抬着；只要出现过一拍不匹配，本次按住作废，必须等键真的抬起
     再按（否则 Shift 比 `/` 先松会剩一拍「斜杠按着 ∧ 无修饰键」，照样误触发）。
   ⛔ 仍不注册热键、不吞键、`altHold` 协议与消息名不变；面板侧只是新增一条普通热键条目
   （action == "pickColor"，默认 `Shift+/`，走 RegisterHotKey 正常接管）。
   无共享内存槽位变化（CFG_NLONGS 仍 60）。 */
/* 0x0213（2026-10-29，**按住键补上布防门**）：
   用户要求确认「所有快捷键都必须在插件加载后、且快捷键总开关打开时才生效」，并核对反例。
   核对结果：表内热键（主开关 / 笔刷 / 功能快捷键 / 套索 / 清除 / 前景色拾色器 / 混合模式内置表）
   全部经 kh_hk_sync（RegisterHotKey）与 kh_poll_step（轮询兜底）两道 `g_khArmed` 门，
   钩子安装另有 `g_khPlug ∧ g_khArmed` —— 均合格。
   ⛔ **唯一反例是临时吸管的按住键**：它不进热键表、另走调度线程自己的电平轮询，
      上面两处布防门一次都管不到它 ⇒ 总开关关着按 `/` 照样切吸管。
   ⇒ keyhook.c 的按住块首补 `if (holdVk && !g_khArmed)`：清起按准入与确认计数、alt 保持 0
     （若正在按着时撤防，边沿仍广播一帧 v=0 并清 I_ALTTOOL，状态不悬空）。
   无共享内存槽位变化（CFG_NLONGS 仍 60）。 */
__declspec(dllexport) long jw8li_version(void) { return 0x0213; }

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved)
{
    /* ⛔ loader lock：ATTACH 只起线程（引擎 worker），绝不做重活。 */
    if (reason == DLL_PROCESS_ATTACH || reason == DLL_PROCESS_DETACH) {
        char self[MAX_PATH] = "?";
        GetModuleFileNameA(hinst, self, sizeof(self));
        if (reason == DLL_PROCESS_ATTACH) {
            DisableThreadLibraryCalls(hinst);
            g_hSelf = hinst;
        }
        /* ⛔⛔ 0x013E：日志**先落**，再干活。
           旧顺序是「services_stop() → log_line(DETACH)」⇒ 停服里任何一个 join 卡住
           （或走 ADO 的异常卸载路径）时，日志里既没有 Unload 也没有 DETACH，
           2026-10-19 21:39 那场崩溃现场就只剩一行 HUD 前台切换 —— 无法归因。
           现在即使后续卡死/崩溃，也能证明「DETACH 到底有没有被调用」。 */
        log_line("dll", "%s pid=%lu tid=%lu reserved=%p self=%s",
                 reason == DLL_PROCESS_ATTACH ? "DLL_PROCESS_ATTACH" : "DLL_PROCESS_DETACH",
                 (unsigned long)GetCurrentProcessId(),
                 (unsigned long)GetCurrentThreadId(),
                 reserved, self);

        if (reason == DLL_PROCESS_DETACH) {
            /* ⛔⛔ 0x013E：PS 侧的通知回调必须在这里注销。
               旧实现只在 AutoPluginMain 的 "Unload" 分支调 pstool_uninstall()，
               而 PS 存在「不发 Unload 直接 FreeLibrary」的路径（见下方 0x0117）；
               更糟的是 pstool_uninstall() 自身因 s_basic 未赋值而恒 return（已修），
               于是 PS 长期持有指向本模块的函数指针 ⇒ 卸载后一投递就跳进已释放内存。
               reserved==NULL ⇒ FreeLibrary（PS 还活着）⇒ 注销是安全的、必须做；
               reserved!=NULL ⇒ 进程正在退出，PS 的 suite 可能已经拆掉 ⇒ 只停线程。 */
            if (!reserved) {
                pstool_uninstall();
            } else {
                log_line("dll", "进程退出路径（reserved!=NULL）⇒ 跳过 PS suite 注销，只停线程");
            }
            /* ⛔⛔ 0x0117：DETACH = 本模块即将被卸载映射。正常路径上 AutoPluginMain
               的 "Unload" 已经跑过 services_stop()（幂等，这里直接返回）；但若 PS
               没发 Unload 就 FreeLibrary（异常路径），WS 服务器 / pump / 热键四个
               线程会活过卸载 ⇒ 与引擎四线程同一族崩溃（WER: .8li_unloaded
               0xC0000005）。这里补一次停干净（幂等：g_started 已为 0 时立即返回）。 */
            services_stop();
        }
        engine_dllmain(hinst, reason, reserved);
    }
    return TRUE;
}
