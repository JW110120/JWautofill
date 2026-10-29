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

/* 0x012D：断流期落笔推断要用「笔尖 → 鼠标左键**事件**」镜像（keyhook.c）。
   ⛔ 事件而非电平：电平会漂（0x012B/6468 血案）。 */
#include "keyhook.h"

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
/* ⛔ 2026-10-17：48 → 56（plugin_main.c 新增 I_MODALLVL..I_DOCEPOCH 四个槽）；
   56 → 58（0x0115 新增 I_NOTIFYAGE / I_GATEOWNED）；
   58 → 59（0x020A 新增 I_ALTTOOL：临时吸管的硬否决位）。
   0x020B **无槽位变化**（只给 hostBusy 消息加了 `btn` 字段，见 keyhook.c）⇒ 仍是 59。
   59 → 60（0x0211 新增 I_POLYALT：物理 Alt「临时多边形套索」的硬否决位）。
   两个文件的 CFG_NLONGS **必须同步**：谁先建节谁定尺寸，不一致的一方会
   MapViewOfFile 到错误的字节数（不报错，只静默截断 —— 既有铁律区）。 */
#define CFG_NLONGS    60

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
    CFG_I_CORNER,         /* 0..90    尖角保护：轨迹相邻两段的**转折角** > 本值即判为拐角、
                            本帧减弱平滑。⛔ 阈值越小越易触发保护；**本值就是面板显示值，
                            没有任何反向映射**（2026-10-14「保护范围」回退定案）。        */
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
    /* ---- 2026-10-17：进程内观测（plugin_main.c 写、本文件只读）----
       ⛔ 槽位表与本文件上面的注释同款：两处手写对应，错位不报错只静默失效。 */
    CFG_I_MODALLVL,       /* PS 模态嵌套层级（-1=未知；面板据此跳过自己的轮询） */
    CFG_I_MODALTS,        /* 该层级的观测时刻 */
    CFG_I_TMODAL,         /* 工具模态值（-1=未知） */
    CFG_I_TMODALK,        /* 工具模态极性是否已证明 */
    CFG_I_DOCEPOCH,       /* 文档级事件累计（'Opn '/'Cls '） */
    /* ---- 0x0115：'slct' 活性看门狗（plugin_main.c 写、面板经 smoothState 读）----
       ⛔ 本文件不消费这两个槽（引擎的闸门过期判据仍是 GATETS/GATE_STALE_MS），
          列在这里只为槽位表与 plugin_main.c 逐项对齐 —— 错位不报错、只静默失效。 */
    CFG_I_NOTIFYAGE,      /* 距上次 'slct' 回调的 ms（-1=从未投递） */
    CFG_I_GATEOWNED,      /* 此刻闸门是否**真的**由进程内供给（1/0）—— 面板唯一判据 */
    /* ---- 0x020A：临时吸管（Alt）硬否决位 ----
       ⛔ 为什么必须是一个**独立槽**、而不是借用 CFG_I_TOOLGATE：
          `write_params()` 在 `pstool_owns()` 为真时**一个字节都不写** TOOLGATE
          （由 ps_tool.c 的 'slct' 回调独占写），所以面板在吸管态下发 toolGate=0
          会被静默丢弃 ⇒ 引擎仍按套索放行 ⇒ HUD 显示、坐标被拉绳改写
          （用户报的两条：吸管态冒出 HUD、取色点被偏移）。
       ⛔ 语义刻意单一：1 = **立即否决一切改写与 HUD**，不看闩锁、不看心跳、
          不看 gateOwned。只由「面板进入临时吸管」置 1；由「Alt 物理松开 /
          面板退出吸管 / 服务停止」置 0（三处收口，见 plugin_main.c 的
          srv_alt_tool_clear）。 */
    CFG_I_ALTTOOL,        /* 1 = 正处于「Alt 临时吸管」态（硬否决） */
    /* ---- 0x0211：物理 Alt「临时多边形套索」的硬否决位 ----
       ⛔ 与 CFG_I_ALTTOOL 是**两个位、语义不同**：
          ALTTOOL = 面板的**意图**（用户按住临时吸管键在取样，面板判定的）；
          POLYALT = 原生看到的**事实**（Alt 真的按着，且前台是本进程）。
          合成一个位会互相清掉对方（见 plugin_main.c 的 I_POLYALT 注释）。
       ⛔ 为什么必须有它（用户报：按住 Alt 画折线时预览抖/闪、HUD 在落点上闪现）：
          多边形套索是 PS 的**临时模式**，工具仍是 lassoTool（左上角图标不变），
          面板的工具闸门、巡检、'slct' 回调全都看不出变化 ⇒ 引擎照常改写坐标
          ⇒ PS 拿滞后的光标画折线预览（逐帧 1~2px = 抖），点击那一批又被量成
          「一次落笔」⇒ HUD 亮一帧。这一位由 keyhook 每 20ms 镜像物理电平。 */
    CFG_I_POLYALT,        /* 1 = 物理 Alt 按着（PS 临时模式）⇒ 不改写、不出 HUD */
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
    RS_CTXGONE,           /* 0x0133：PS **关掉了自己的 Wintab 上下文**且没有重开
                            （jwwh-36236 19:39:22 WTClose 之后 0 包到结束）。
                            此时我们没有任何包可改写，唯一出路是让 PS 重建上下文。 */
    RS_ALTTOOL,           /* 0x020A：Alt 临时吸管态 —— 面板明示「此刻是吸管」，
                            引擎硬否决（不改写、不出 HUD）。⚠️ 这不是故障：
                            用户在取样，本来就不该有套索平滑的任何表现。 */
    RS_POLYALT,           /* 0x0211：按住 Alt（PS 临时多边形套索）—— 原生看到的**事实**，
                            引擎硬否决（不改写、不出 HUD）。同样是「本来就不该有」，
                            不是故障：用户在折线模式里逐点确认落点。 */
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
        case RS_CTXGONE:     return "PS上下文已关闭";
        case RS_ALTTOOL:     return "临时吸管";
        case RS_POLYALT:     return "临时多边形";
        default:             return "?";
    }
}

/* ⛔⛔ 这张槽位表是 C 与 C#（Program.cs 的 PenHook）**两处手写**的，错位不会报错、
   只会让参数静默失效（实测过的坑）。所以：① 用编译期断言守住「槽数不超映射」；
   ② 任何一侧增删槽，另一侧必须同步，且 C# 的 EnsureInit 里有运行时兜底校验。 */
typedef char cfg_slot_fit_check[(CFG_NLONGS >= CFG_I_POLYALT + 1) ? 1 : -1];

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
/* ⛔⛔ 0x012A：buttons（笔尖开关，掩码 0x07 低三位）的**逐包边沿** = 真正的「新的一笔」。
 *
 * 用户报（jwwh-5912，LNP 在环、平滑生效的前提下）：「落笔瞬间受力点（圆心）与我下笔的
 * 地方有一个偏移，距离在圆半径内、不固定，位置与偏移似乎与我落笔时轻微的位移有关；
 * 于是我一移动，落笔点就瞬间向那个偏移的受力点画出一段**我没画的折线**，然后再从
 * 偏移点出发画平滑选区。」
 *
 * 根因 = 起笔锚定只有两条路，**两条都不落在真正的落笔包上**：
 *   ① `!g_wasEnabled` 锚在「整批第一个包」—— 落笔边沿落在一批中段时，第一个包还是
 *      **悬空包**（场景 A）⇒ 锚到悬空位，偏移 = 落笔瞬间那点位移（用户原话：
 *      「圆半径内一个不固定的值、与落笔时轻微位移有关」逐字吻合）；
 *   ② 1500ms 长闩把 g_wasEnabled 一直撑着 ⇒ 1.5s 内的「抬笔→再落笔」**根本不锚**
 *      （场景 F）⇒ 输出点还停在悬空跟随的位置，最多差整整一根绳。
 *   jwwh-5912 实证场景 F 是主形态：[gate] penDown 0→1/1→0 的间隔低至 0.26s/0.5s
 *   （用户连续画圆，圆与圆之间 < 1.5s），三个台账各跨多次起笔（悬空批=80/954/792），
 *   复位却只有 1~2 次/台账 ⇒ 长闩把若干次真起笔并成了一条「笔」。
 *
 * 为什么单挑 buttons：它是 **PS 自己用来起/收套索路径的那个字段**（我们从不改写它，
 * PS 读到的与驱动逐字节一致）⇒ 它的 0→1 边沿就是 PS 的路径边界，在那里把输出点钉到
 * **本包原始坐标**，选区就从落笔点起画 —— 正是用户要求的「落笔时边缘长度为 0、
 * 受力点与施力点重合」。
 * ⛔ 为什么不盯 np/tp 的边沿：0x0124 的教训 —— np/tp 在轻压运笔中成段掉零
 *   （本项目多次实证），盯它们等于每记掉零恢复都拽一次输出点，整笔退回硬线。
 *   buttons 在那些掉零里保持 1（PS 的路径没断），只有真抬笔才归 0。
 * ⛔ buttons 不可用（未取得投票权 / 本布局推不出）时 s_ctBtnIdx=-1，本机制整体静默，
 *   行为与 0x0129 完全相同（不赌）。
 * ⛔ 边沿带**最小抬升包数**去抖（BTN_EDGE_MIN_ZERO）：连续抬升不足则判抖动/掉样本，
 *   不锚定 —— 真抬笔（ physically 离纸再落下）不可能短于几十 ms。 */
static int s_ctBtnIdx = -1;    /* buttons 在信号表里的下标；-1 = 本布局没有/不可用 */
static int s_prevBtn  = 0;     /* 上一个处理过的包的 buttons 态（跨批保持） */
static int s_btnZero  = 0;     /* 连续 buttons=0 的包数（边沿去抖；悬空可积累） */
/* ⛔⛔ 0x0135（jwwh-33124 实测）：8 → 16。
   台账四笔的 `落间最小全零` 分别 8 / 9 / 8 / 8 包 —— **全部贴着旧阈值 8**，也就是
   「笔还按着，buttons 只掉了 8~9 个包的零就回来了」，却每次都被当成一次真落笔
   ⇒ 每次都把输出点钉回原始坐标 ⇒ 用户看见的折角/突然追到笔尖。
   （铁律 19：N ≫ 8 是真抬笔、N 贴着 8 是抖动 —— 本场全部落在后者。）
   16 包 ≈ 90ms@176Hz；实测真抬笔再落最短 260ms（0x012A），仍有 2.9 倍余量。
   被滤掉的次数记进台账 `滤=`，避免「改了阈值就看不见了」。 */
#define BTN_EDGE_MIN_ZERO 16
static LONG s_btnRej;          /* 被去抖否决的 0→1 边沿数（台账 `滤=`） */
/* ⛔⛔ 0x0137：**补流结束的下一批必须「重新对表」**，否则会凭空造出一次落笔。
   现场（jwwh-13664）：停摆超过 6s 后合成包的 buttons 只能写 0（没有落笔证据），
   而真包一回来 buttons=1 ⇒ 逐包边沿看见 0→1 且零段远超 16 包 ⇒ 判成「真落笔」
   ⇒ 输出点被钉回原始坐标 ⇒ 用户看见线「啪」地跳到笔尖 = 体感上的「平滑失效」。
   四笔台账里 `落间最小全零=16包` 贴着阈值、`共N次` 远超实际落笔数，就是它。
   ⇒ 由 detour 在「补流 → 交还驱动」那一刻置位；本文件在下一批的**第一包之前**消费：
     把 s_prevBtn 当成 1（假设笔还落着），零段清零 —— 只压掉这一次假边沿，
     真抬笔（下一包 buttons=0）照旧从 0 开始正常累计。 */
static volatile LONG g_btnResync;
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

/* ============================================================ 平滑专用接触闩（0x0124）
 *
 * ⛔⛔ 为什么需要第二个接触判定：**同一个判据不能同时服务「GUI 显隐」与「改不改坐标」**。
 *
 * 真机 jwwh-36348（0x0123 首场）用户原话：「画出来选区是没平滑的硬线，同时 HUD 以
 * 错误形态显示（受力点与施力点重合）」+「断流前刚碰过面板/工具栏/其它窗口」。
 * 日志硬证据（[ct] 行的「连续全零」正是本文档自己定义的定性指标）：
 *     [23:31:08] reason=5(悬空) penDown=0 … 连续全零=90 包
 *     [23:31:49] reason=5(悬空) penDown=0 … 连续全零=39 包
 *     [23:32:09] reason=5(悬空) penDown=0 … 连续全零=121 包
 *   本文件 464 行的判据写着「> 20 包 ⇒ 判据在真实运笔中成段失效」——90/121 包（≈450/600ms
 *   @200Hz）**远超**该门限，即「落着笔但三个接触信号成段读到 0」的老缺陷仍在，
 *   只是当年抬 HOLD(120→250ms) 只够挡住 ≤50 包的抖动。
 *
 * 后果链（与 2026-10-14 第三轮记录的完全一致，只不过这次挡住它的窗口不够长）：
 *   ① 闸门②判悬空 ⇒ `smooth_packets` **整批原样放行** ⇒ 输出点 = 笔尖 ⇒ 硬线；
 *   ② 同一次判定还置 `g_wasEnabled=0` ⇒ 下一包重新锚定（输出点被拽到笔尖）
 *      ⇒ 拉绳死区被重新灌满；
 *   ③ HUD 用的是同一个 `g_penDown` ⇒ 圈与平滑**同时**塌陷成「受力点=施力点」。
 *
 * ⇒ 本版把两件事拆开：
 *    · `g_contact`（HOLD 250ms）继续驱动 **HUD / 面板 / 落笔角标** —— 抬笔要立刻反映；
 *    · `g_contactSmooth`（HOLD 1500ms，0x0125 由 800 上调，见常量处的实测依据）**只**决定「坐标改不改」。
 *    ⛔ 窗口依据：抬笔级零段实测 100~163 包（≈1.0~1.5s @110~150 pkt/s），见下方常量注释。
 *    ⛔ 抬笔后多撑 550ms 期间**没有任何可见副作用**：PS 自己按落笔态判定不画，
 *      我们改写的只是它用不到的坐标；HUD 早已按 g_contact 隐藏。 */
static volatile LONG g_contactSmooth;   /* 1 = 平滑可以改写坐标（长保持版接触判定）*/
static volatile LONG g_contactMsSmooth; /* 最近一次「任一信号非零」的时刻（平滑闩口径）*/
/* ⛔ 0x0125：800 → **1500ms**。0x0124 首场（jwwh-12388）台账实测：
   `末段全零`（收笔那一刻的连续全零包数）= 41 / 118 / 128 / 141 / 160 / 162 / 163 包，
   而该场真实取包率约 110~150 pkt/s ⇒ 抬笔零段就有 1.0~1.5s，比 800ms **还长**；
   运笔中的零段长度当时没测（0x0125 新增 `最长全零` 字段专门量它）。
   ⇒ 窗口取 1500ms：足以跨过抬笔级零段，又不会无限拖长。 */
#define CONTACT_HOLD_SMOOTH_MS 1500

/* —— 每笔台账的原子出口（0x0124）——
   ⛔ smooth_packets 跑在 PS 的取包线程里，铁律禁止在那里做任何 I/O ⇒
      那里只把数字搬进这几个槽并置 g_lgEvt，文本由 worker 每 250ms 落盘。 */
static volatile LONG g_lgEvt;
static volatile LONG g_lgDur, g_lgPk, g_lgChg, g_lgRst, g_lgGrace, g_lgRad, g_lgMode, g_lgZero;
static volatile LONG g_lgRA, g_lgRG, g_lgRJ, g_lgLag, g_lgPin, g_lgSlack;
static volatile LONG g_lgRP;    /* 0x012A：本笔 buttons 落笔边沿锚定次数（每笔正常=1） */
/* 0x0132：`落` 的次数还不够判性质 —— 必须看**每次落之前笔悬空了多久**。
   ⛔ 判据：`落间最小全零` >> BTN_EDGE_MIN_ZERO(8) ⇒ 笔是真抬起过（多笔合并成一段台账，正常）；
      贴着 8 的阈值 ⇒ buttons 在笔中抖动，每次都会把输出点钉回笔尖（会看见折角）。 */
static volatile LONG g_lgEmin = -1, g_lgEn;
static volatile LONG g_lgRej;   /* 0x0135：本笔被去抖否决的 0→1 边沿数（台账 `滤=`） */

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
    /* 0x012A：重建 ⇒ 旧的边沿状态全部作废（偏移都换了，语义不连续）。
       把「已抬升」直接置满：下一个 buttons=1 包就是一次落笔边沿（重建多发生在
       冷启动/换布局，那时本来就要重新起笔）。 */
    s_ctBtnIdx = -1;
    s_prevBtn  = 0;
    s_btnZero  = BTN_EDGE_MIN_ZERO;

    if (stride > 0) {
        /* ① 语义已知（掩码 + 数据双证据 ⇒ src=1）：三个字段直接取用。
              buttons 只取**低三位**（真按钮/笔尖状态）；高位是 cursor number，
              某些驱动会填成非 0 常量。 */
        if (offBtn >= 0 && offBtn + 4 <= stride) { s_ctBtnIdx = g_ctN; ct_push(offBtn, 0x07); }
        if (offNP  >= 0 && offNP  + 4 <= stride) ct_push(offNP, 0);
        if (offTP  >= 0 && offTP  + 4 <= stride) ct_push(offTP, 0);
        /* ② 语义未知（盲扫定解）：补两个**顺序可推**的候选。
              · Buttons 在 wintab.h 的固定顺序里**恒在 X 之前 4 字节**；
              · Y 之后剩余的字节按固定顺序只能是 Z/NP/TP/ORI/ROT（Z/ORI/ROT 各 4/12/12）。
              ⛔ 取错也不会长期作恶：每个候选都要先通过「见过 0 又见过非 0」的资格审查，
                 pkCursor（恒 1）、Orientation/ROTATION（恒非 0）、pkZ（悬空非 0）
                 都会自动出局。 */
        if (offBtn < 0 && offX >= 4) { s_ctBtnIdx = g_ctN; ct_push(offX - 4, 0x07); }
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
        InterlockedExchange(&g_contactSmooth, 1);
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
        LONG c0 = (seen < CT_GRACE_PKT) ? 1 : 0;
        InterlockedExchange(&g_contact, c0);
        InterlockedExchange(&g_contactSmooth, c0);
        return;
    }
    InterlockedExchange(&g_ctUnknown, 0);
    if (anyHit) {
        InterlockedExchange(&g_contactMs, (LONG)now);
        InterlockedExchange(&g_contactMsSmooth, (LONG)now);
        InterlockedExchange(&g_contact, 1);
        InterlockedExchange(&g_contactSmooth, 1);
    } else {
        if ((DWORD)(now - (DWORD)g_contactMs) > CONTACT_HOLD_MS)
            InterlockedExchange(&g_contact, 0);
        /* ⛔ 平滑闩：窗口 CONTACT_HOLD_SMOOTH_MS=1500ms（常量处有实测依据）。
           首次见到非零之前 g_contactMsSmooth=0 ⇒ 这里恒到期 ⇒ 维持「悬空」，
           与旧行为逐位相同（不会因为新增闩而凭空开始平滑）。 */
        if (!g_contactMsSmooth ||
            (DWORD)(now - (DWORD)g_contactMsSmooth) > CONTACT_HOLD_SMOOTH_MS)
            InterlockedExchange(&g_contactSmooth, 0);
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

/* ==================================== 0x0208：视图导航否决（缩放/抓手）
 *
 * 为什么需要（用户报：Ctrl+空格 + 左键左右拖拽缩放「抽搐」）：
 *   Ctrl+空格期间 PS **不会切工具** —— `app.currentTool` 仍是套索 ⇒ 工具闸门
 *   `tool_gate_ok()` 依然为 1、左键按着 ⇒ 本模块把这段操作当成「一笔」，
 *   开始改写坐标（包路径 useGate / 光标路径 det_GetCursorPos 都改写）。
 *   但此刻用户要的是**视图缩放**，它的输入就是光标位移（scrubby zoom 的缩放级别
 *   = 拖拽位移的函数）。我们喂给 PS 的是拉绳**滞后**坐标（半径默认 40 逻辑 px，
 *   换向时输出点还继续往旧方向走）⇒ PS 算出的缩放级别来回跳 ⇒ 用户看到的
 *   「抽搐」。
 *   ⇒ 视图导航修饰键按着时，坐标**一个字节都不改**（原样透传），HUD 也不出
 *     （它画的是轨迹末端，此刻根本没有轨迹）。
 *
 * 判据只取空格（最保守的取舍）
 *   · 空格 = PS 的抓手工具 & Ctrl+空格 缩放，**正常绘画时绝不会按着**；
 *   · Ctrl / Alt 不参与：它们与大量正常操作重叠（Alt 取色、Ctrl 约束…），
 *     拿它们当否决会误杀真实的套索平滑。
 * ⛔ 代价：一次 GetAsyncKeyState（与 det_GetCursorPos 里已有的 VK_LBUTTON 同族），
 *    仍是零 I/O、O(1)，不违反 detour 纪律。 */
static int view_nav_down(void)
{
    return (GetAsyncKeyState(VK_SPACE) & 0x8000) ? 1 : 0;
}

/* ============================== 0x0209：工具闸门的「事实」与「没来得及报」 ======
 *
 * 为什么要把这两件事分开（用户报的两个连锁 BUG，根因同一条）：
 *   BUG1「切到涂抹工具、长按涂抹，HUD 仍错误显示」
 *   BUG2「切回套索画选区，前半段正常、中途失效；停笔时 PS 自己画一条
 *         从选区末端到笔尖的直线，圆心与受力点不再重合」
 *
 * 现场链条（代码级，不是体感推断）：
 *   ① `pollSmoothToolGate` 在 0x0208 被加了 `hostYield()` 让路，而让路判据是
 *      「左键 ∨ 空格」。用户**长按笔涂抹**时左键电平一直为真（Wintab 落笔会模拟
 *      左键）⇒ 工具巡检被无限期跳过 ⇒ `CFG_I_TOOLGATE` 永远停在切走前的 1。
 *   ② 引擎的起笔闩锁写的是 `if (contactPrev && latched == 1) useGate = ENABLED;`
 *      —— **整笔持有上一笔的工具裁决**，一笔之中根本不看工具。于是涂抹被当成
 *      套索：坐标继续被拉绳改写、`g_toolOk=1` ⇒ HUD 继续显示（BUG1 成立）。
 *   ③ 同一段时间里 `GATETS` 也在变老。面板一停报，`tool_gate_ok()` 在 3s 后返回 0。
 *      而短闩 `g_contact` 只要抖一次（轻压运笔中成段全零是已知现象），条件
 *      `contactPrev && latched==1` 就整体失效 ⇒ 走 else ⇒ `tool_gate_ok()=0`
 *      ⇒ **整批原样透传** ⇒ PS 收到真实笔尖坐标 ⇒ 从圆心拉一条直线到笔尖
 *      ⇒ 之后锚定复位、平滑从头再来（BUG2 成立）。
 *
 * ⇒ 判据必须拆成两类：
 *   · `TOOLGATE == 0` 且心跳**新鲜** = 面板刚读过 `application.tool`，这是**事实**
 *     ⇒ 立即否决（无论闩锁、无论是不是一笔之中）。切工具必须立刻停。
 *   · 心跳**过期** = 只说明面板这一拍没来得及报，**不能当工具变了**
 *     ⇒ 不否决（沿用手头结论），否则一笔之中会规律性地被劈成两半、每 3s 画一根直线。
 *
 * ⛔ 代价：一次共享内存读 + 一次 GetTickCount（KUSER_SHARED_DATA）——
 *    与 `tool_gate_ok()` 同族，detour 里安全。 */
static int tool_gate_sure_not_lasso(void)
{
    if (!g_cfg) return 0;
    DWORD ts = (DWORD)g_cfg[CFG_I_GATETS];
    if (ts == 0) return 0;                                        /* 从未上报 ⇒ 不知道 */
    if ((DWORD)(GetTickCount() - ts) > GATE_STALE_MS) return 0;    /* 只是没来得及报 */
    return g_cfg[CFG_I_TOOLGATE] == 0 ? 1 : 0;                     /* 事实：不是套索 */
}

/* 现在该不该改写坐标（只回答「工具维度」）。
 *   顺序：总开关 → 「事实」否决 → 一笔之中的闩锁 → 现判心跳。
 * ⛔ 包路径与光标路径**必须**共用这一个函数：两条路各判一次 = 漂移一次就分叉，
 *    现象正是「HUD 圆心还在画、PS 的选区末端已经跑到笔尖去了」。 */
static int tool_edit_allowed(void)
{
    if (!g_cfg || !g_cfg[CFG_I_ENABLED]) return 0;
    /* ⛔⛔ 0x020A：Alt 临时吸管 = **硬否决**，放在所有推理之前。
       用户报的两条都由这一个位收口：
         ① 吸管态下按笔吸色时 HUD 冒出来 —— 因为切到吸管后 TOOLGATE 由 'slct'
            回调独占写、面板写的 0 被 `write_params` 丢弃，引擎仍按套索放行；
         ② 吸管取色点被拉绳偏移 —— 同一条放行，坐标还在被改写。
       ⛔ 刻意**不**并入 `tool_gate_sure_not_lasso()`：那一个的语义是「面板刚读到
          工具、事实是非套索」，而这里是「面板明示此刻在取样」——两者来源不同，
          混在一起会让『心跳过期』的分支逻辑被误伤。 */
    if (g_cfg[CFG_I_ALTTOOL]) return 0;
    /* ⛔⛔ 0x0211：物理 Alt 按着 = PS 的**临时模式**（套索→多边形套索、画笔→吸管），
       同样放在所有推理之前硬否决。用户报的三条都由这一个位收口：
         ① 折线落笔前移动光标时预览原地抖 —— 因为引擎还在把光标改写成滞后的平滑点，
            PS 拿它当折线预览逐帧画；
         ② 每次点击落点后 HUD 在落点上闪一帧 —— 点击那一批被量成「一次落笔」；
         ③ 按住期间本来就不该有平滑。
       ⛔ 与上一行的 ALTTOOL 分开判、不合并成一个 `||`：两条来源不同（面板意图 /
          原生事实），合并后日志与原因码就分不清是谁压住的；分开判的开销是零。 */
    if (g_cfg[CFG_I_POLYALT]) return 0;
    if (tool_gate_sure_not_lasso()) return 0;
    if (g_strokeGate == 1) return 1;      /* 一笔之中：心跳抖动不打断（见上方长注释） */
    return tool_gate_ok();
}

/* ================================================================== 标定状态 */
typedef struct {
    HCTX  hCtx;          /* 0 = 未标定 */
    int   stride;        /* 每包字节数 */
    int   offSerial;
    int   offTime;       /* pkTime（合成包要盖时间戳） */
    int   offChanged;    /* pkChanged */
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
    int  stride, offSerial, offTime, offChanged, offX, offY;
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
        out->offTime = g_ctxCache[i].offTime; out->offChanged = g_ctxCache[i].offChanged;
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
    g_ctxCache[slot].offTime = c->offTime; g_ctxCache[slot].offChanged = c->offChanged;
    g_ctxCache[slot].offX = c->offX;     g_ctxCache[slot].offY = c->offY;
    g_ctxCache[slot].offBtn = c->offBtn; g_ctxCache[slot].offZ = c->offZ;
    g_ctxCache[slot].offNP = c->offNP;   g_ctxCache[slot].offTP = c->offTP;
    g_ctxCache[slot].axisMax = c->axisMax; g_ctxCache[slot].axisMaxY = c->axisMaxY;
}
static volatile LONG g_state = 0;          /* CFG_I_STATE 的镜像（供 worker 上报） */
/* ⛔⛔ 0x013D 引擎总闸（面板 unload ⇒ 立刻哑火）。
 *
 * 用户实测（2026-10-19）：「在 UXP 里 unload 之后，它还会平滑我的其他工具」。
 * 原因是 Unload 路径只做了 `services_stop()`，而它按设计**不停引擎**
 * （plugin_main.c 原注释：「引擎不在这里卸载…Unload 后继续驻留正是 .8li 形态的意义」），
 * 于是 Wintab detour 与 GetCursorPos detour 还在原地址上，笔一按照旧推光标。
 *
 * 为什么不用 jwwh_unhook()：它会 join 四个线程、还原补丁、关日志，**不可逆**
 * （g_stop 置 1，worker 不会自己回来），而面板关掉再打开（Reload）必须能恢复。
 * ⇒ 用一个纯内存闸：detour 入口第一行判断，为 1 时原样转发、一个字节都不加工。
 *   Reload 时清零即无缝复机，线程与补丁全部保留。 */
static volatile LONG g_engineOff;
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
/* —— 2026-10-28：`g_speed` 与「拐角参考方向」都必须来自**笔尖的真实位移** ——
   ⛔⛔ 旧版 `g_speed = 0.72·g_speed + 0.28·(|raw − out| / dt)` 里 `|raw − out|`
      **是滞后，不是位移**：强度越大 → 滞后越大 → 被判成「甩笔」→ 速度适应把平滑
      自动削弱 → 滞后又被压回小值。这条负反馈把稳态滞后锁死在 4~6px，
      滑杆从 0 拉到 100 几乎分不出差别（用户报的正是「不管数值多少都一样」）。
      数值模拟（0.3px/ms、5ms/包）：强度 40 → 3.7px，强度 100 → 5.7px；
      把速度换成真实位移后是 5.8 → 24.0px；关掉速度适应则是 7.2 → 75.0px。
   ⇒ 现在按「累计位移 ≥ SPEED_WIN_PX 的真实时长」结算笔速（见 SPEED_WIN_MS）。 */
static double s_spRefX, s_spRefY;   /* 速度窗起点（原始轴坐标） */
static DWORD  s_spRefMs;            /* 速度窗起点时刻 */
static int    s_hasSpRef;
/* 拐角判据的两级基准（0x020C）：
     · 参考方向 g_dirX/g_dirY —— 只由**≥ CORNER_MIN_PX** 的线段推进，亚像素抖动改不动它；
     · 当前方向 —— 由「自参考点起 ≥ CORNER_PROBE_PX」的累积位移给出。
   ⛔ 二者缺一不可：只有前者 ⇒ 慢速（每包 1~2px）永远攒不够 3px，保护失效；
      只有后者 ⇒ 抖动（每包 0.2px 的噪声方向）每帧都被判成拐角，平滑被关掉。 */
static double s_cRefX, s_cRefY;
static int    s_hasCRef;
static DWORD  g_lastMs;
static int    g_wasEnabled;
/* ⛔ 0x0125：删掉 0x0124 的 `g_wasHover`（它是个**倒退**）。
   真机 jwwh-12388 台账：单笔 `复位=49/109/173`，全局 `rst=1471/0/2` 全是 anchor ——
   因为 `g_wasHover` 在「同一批里置位、同一批的循环里立刻被消费」⇒ 只要短闩
   有一拍判悬空，就换来一次锚定，输出点被拽回笔尖 ⇒ **整笔又变成硬线**。
   ⇒ 起笔锚定改回「`!downS`（长闩真的过期）⇒ g_wasEnabled=0 ⇒ 下一包锚定」这一条，
      再加一条**位移门**：短闩曾垂过、恢复时若笔尖离输出点 > 4×绳长，才算「抬笔移位、
      另起一笔」。运笔中零段恢复时位移只有几 px ⇒ 不锚定、平滑不断。
   （旧的 RST_JUMP 门限 jumpPx = 0.15·axMax ≈ 1350px，太粗，接不住真实的抬笔移位。） */
/* 1 = 断流刚刚恢复（worker 置位、smooth_packets 消费）：
   恢复后的第一批包要**强制锚定**（输出点回到笔尖），否则会拿停摆前的输出点续画，
   得到一段被拉长的假轨迹（观感：选区线忽然被拽到新位置）。 */
static volatile LONG g_deadRecovered;

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
/* 0x012F：内部取真实光标 —— 必须绕过我方 user32!GetCursorPos 的 detour。
   ⛔ 若内部也走 detour，就会出现「补流输入 = 自己的滞后输出」的自激环：
      snOut 由输入算出 ⇒ 输入又被 snOut 拉走 ⇒ 每拍再滞后一点，几秒内发散。 */
static BOOL se_real_GetCursorPos(LPPOINT p);
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
    if (!se_real_GetCursorPos(&pt)) return;
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
#define RST_PENDOWN 4    /* 0x012A：buttons 0→1 边沿（真正的落笔，见 s_ctBtnIdx 处） */
static volatile LONG g_rstAnchor, g_rstGap, g_rstJump, g_rstPenDown;
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

/* —— 断流判定时序（第九轮 2026-10-15 建立；第十三轮 2026-10-16 定稿）——
   ⛔⛔ 此处**只剩判定门槛**：自愈/抢救已全部删除（0x0123 连一次性探针也删了，
      见文件内「已删除：一次性方向判决实验」段）。判决见「不再主动抢救」段与
      worker 内注释：WTEnable 翻转（12 轮）、周期性抢顶层
      （199 次）、WTOverlap（120+30 轮）三者全返成功值却一包未回，且每个动作都会
      让外来上下文短占重叠序顶层 = 亲手延长 PS 的断流。
   ⛔ 曾被这条时序解释的「恢复 9s 左右」已随抢救一起作废：本版恢复时长完全由驱动
      决定（真机实测 0.3s~31s 随机）。 */
#define DEAD_DETECT_MIN_MS 350   /* 包冻结达此值（且光标仍在动）才判「断流」 */
/* ⛔⛔ 「最近落笔」窗口（2026-10-16 第十二轮）—— 替代瞬时 `g_penDown == 1`：
   真机 jwwh-24524 第 12 笔（12:06:13.9）断流，判定门槛 350ms 要等到 12:06:14.25
   才满足，而 `g_penDown` 在 12:06:14.237 就被清零（断流前最后几包恰好是悬空包，
   `[ct] 连续全零=13 包`）—— **只差 13ms**，于是整段 3.5 分钟的永久断流
   一条 `[dead]` 都没打、HUD 一直「显示」着冻结几何。
   ⇒ 判据从「此刻落笔」放宽为「最近 PEN_RECENT_MS 内落笔过」。这既抓住
      「笔刚落纸就断」的形态，又不会把「笔早就放下、单纯在用鼠标」当成断流
      （那种情况下 penDown 早已长期为 0，窗口过期即不判）。 */
#define PEN_RECENT_MS     2000

/* ⛔ [stall] 无前置条件的停摆记录门限（2026-10-16 第十五轮）。取 400ms：比 [dead] 的
   350ms 稍宽 ⇒ 先由 [stall] 无条件记下每一次停摆，再看 [dead] 是否给同一段加判定，
   两者的差集就是「被落笔判据遮蔽掉的停摆」。纯诊断常量，不参与任何行为决策。 */
#define STALL_LOG_MS       400

#define SPEED_FULL        3.0    /* 屏幕等效像素/ms：达到即「甩笔」（人手常规 ≤1.5，见下） */
/* —— 笔速估计（2026-10-28）：按**距离窗**结算，而不是逐包除 dt ————————
   ⛔ 必须给最小窗时：GetTickCount 只有 1ms 精度，而一个冲包批次里十几个包的
      `now` 可能完全相同 ⇒ 逐包算会得到「0.x ms 走 2px」= 6px/ms 的假甩笔。
      要求 wms ≥ 4ms 才结算，冲包期自然只累距离、不结算。 */
#define SPEED_WIN_PX      6.0    /* 距离窗（逻辑像素）：累计位移到它就结算一次笔速 */
#define SPEED_WIN_MS      4.0    /* 窗时下限（ms）：不足就不结算（抗时间戳量化） */
#define SPEED_MAX         6.0    /* 笔速上限（物理 px/ms）：只用于挡住量化造成的假尖峰 */
#define CORNER_MIN_PX     3.0    /* 参考方向的最小基线：段长小于它的「拐角」一律当抖动 */
#define CORNER_PROBE_PX   2.0    /* 探测方向的最小位移：205Hz 下正常运笔每包仅 1~2px，
                                    ⛔ 旧写法要求**单包** > 3px 才算拐角 ⇒ 慢速画线时
                                    尖角保护整段不触发（参数与文案说的完全不是一回事）。
                                    取 2.0 而非 1.5：模拟里 1.5px 的方向只剩 ~5° 噪声余量，
                                    阈值调到 10° 时误判明显增多；2.0px 兼顾灵敏与抗噪。 */
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

/** 取包快照「距现在多久」（ms，**有符号**）。
 * ⛔⛔ 必须按有符号解释（2026-10-16 第十轮真机定案）：`g_snMs` 由 PS 线程（detour）
 *    写、读它的却是 worker / HUD 线程，两者竞争时 `g_snMs` 可能比读到的 `now` 大
 *    十几 ms ⇒ 旧写法 `(DWORD)(now - g_snMs)` 会**下溢**成 ~4.29e9，把「刚有包」
 *    误判成「久无包」。真机证据：`[hud] 未显示: active=0(t=4294967280ms)
 *    gate=1(toolOk=1 penDown=1)` —— 笔正落纸面 HUD 却不显示（13 笔里出现 6+ 次）。
 * ⛔ 写法要点（两个坑都要躲，缺一不可）：
 *    ① 先按 **DWORD 相减**（无符号模运算）⇒ 在 2^31 以内得到正确的小差值，规避
 *       「直接 (LONG)now − (LONG)g_snMs 在 GetTickCount 超过 2^31（开机 ~24.8 天）
 *       时变负」那个老坑；
 *    ② 再整体解释为 **LONG** ⇒ 负值 = 快照在未来 = 视作「刚刚」，
 *       `sn_age_ms(now) < HUD_IDLE_MS` 这类判据天然成立。 */
static __inline LONG sn_age_ms(DWORD now)
{
    return (LONG)(DWORD)(now - (DWORD)g_snMs);
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
/* ⛔ 0x0125：初值必须是「未标定」而不是 0(=RS_REWRITE)。真机 jwwh-12388 前 41s
   `state=0 packets=0 calib=否` 而面板/日志报 `reason=0(改写中)` —— 一个包都没见过
   却宣称在改写，属于同一类「日志说假话」缺陷（参见 0x0118 的假交还）。 */
static volatile LONG g_reason = RS_NOCAL;      /* RS_* 原因码（0 = 正在改写） */
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
    int offTime;         /* pkTime            -1 = 掩码里没有（合成包用） */
    int offChanged;      /* pkChanged         -1 */
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
    L->offSerial = L->offTime = L->offChanged = L->offX = L->offY = -1;
    L->offBtn = L->offZ = L->offNP = L->offTP = -1;
    for (int i = 0; i < (int)(sizeof(bits) / sizeof(bits[0])); i++) {
        if (!(mask & bits[i])) continue;
        int sz = 4;
        if (bits[i] == PK_CONTEXT) sz = ctxSize;
        else if (bits[i] == PK_ORIENTATION || bits[i] == PK_ROTATION) sz = 12;
        if (bits[i] == PK_TIME)          L->offTime = off;
        if (bits[i] == PK_CHANGED)       L->offChanged = off;
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
    int cTime = -1, cChg = -1;                    /* 合成包用的 pkTime/pkChanged 偏移（仅 src=1） */
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

    /* ⓸′ 0x0131：**小批次的取证标准必须更严**。
       ⛔ 背景（jwwh-39120 全场卡死在「准备中」的根因）：真机上 PS 绝大多数时候
          一次只取 1 个包（`最大单次=2` 是整场上限），而旧版把「n>=3 才敢标定」
          当硬门槛 ⇒ 一个 `[calib]` 都没有 ⇒ `state` 永远是 0 ⇒ 面板永远「准备中」、
          HUD 与平滑全死。**这比断流严重得多，且完全不依赖驱动状态。**
       ⇒ 现在允许 n==2 定案，但**只接受「掩码 + 数据」互相印证（src=1）**：
          2 个包能凑出大量假的「序号逐包 +1」组合，盲扫单独定案在 n=2 上不可信；
          而掩码（WTGet 回的 lcPktData）与盲扫指向同一个 stride/offSerial 时，
          两路独立证据互证，概率上等同 n=3 的强度。n>=3 时规则不变（盲扫可独走）。 */
    if (ok && n < 3 && src != 1) {
        calib_logf("# [calib] n=%d 且掩码未印证（src=%d）⇒ 证据不足，等下一批\n", n, src);
        ok = 0;
        /* ⛔ 这**不算**一次「裁决失败」：否则真机上一次只给 2 个包时会连烧 8 次预算，
           直接锁进 `tried=1 / state=2（标定失败）`，把后面真正够证据的批次挡在门外。 */
        if (g_calib.attempts > 0) g_calib.attempts--;
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
    /* ⛔ 同一条理由：这两个偏移只给「独立笔通路」合成包盖时间戳/变更位用，
       指错字段会污染别的语义 ⇒ 同样只在 src=1 采信。 */
    cTime = (ok && src == 1) ? mL.offTime    : -1;
    cChg  = (ok && src == 1) ? mL.offChanged : -1;
    calib_logf("# [calib] 接触字段偏移 采用 btn=%d z=%d np=%d tp=%d time=%d chg=%d（src=%d；"
               "掩码推算本应是 btn=%d z=%d np=%d tp=%d）\n",
               cBtn, cZ, cNP, cTP, cTime, cChg, src, mL.offBtn, mL.offZ, mL.offNP, mL.offTP);
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
    /* —— 轴数量级口径：**每次标定都必须重算**（2026-10-16 第十六轮修）——
       ⛔⛔ 旧版把这三行关在下面的 `if (g_pxSrc != 1)` 里 ⇒ 首次标定把 g_pxSrc 置 1
          之后整块被跳过 ⇒ axisMax 永远退回 lcInExt。真机证据（jwwh-9252）：
          重新挂载后 `[status] axMax` 从 55040 变 44800，而同一次 `[calib]`
          报的 `lcOut* ext=(55040,23040)` 根本没变 —— 纯守卫造成的，不是驱动变了。
          影响面：`jumpPx = JUMP_RESET_FRAC × axisMax × px × dpi` 等**位移门限的分母**
          就是它 ⇒ 门限会随「插件被重载过几次」漂移 19%。 */
    long oex = outExtX < 0 ? -outExtX : outExtX;   /* Wintab 惯例 lcOutExtY 可为负 */
    long oey = outExtY < 0 ? -outExtY : outExtY;
    int haveOut = (oex > 1 && oey > 1);
    if (haveOut) {
        /* ⛔ 包坐标真实上界 = lcOutExt（不是 lcInExt）：必须与 px 同源 ——
           axisMax×px 才等于屏幕跨度（55040×0.0625=3440 ✓）。 */
        axMax = (u32)oex;
        inExtY = oey;
    }
    g_calib.axisMaxY = (u32)(inExtY > 0 ? inExtY : 32767);

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
    }
    calib_logf("# [calib] lcOut*: org=(%ld,%ld) ext=(%ld,%ld)  ⇒ px=屏幕/lcOutExt X=%.6f Y=%.6f%s\n",
               (long)outOrgX, (long)outOrgY, (long)outExtX, (long)outExtY,
               g_pxAxisX, g_pxAxisY, haveOut ? "" : "（lcOutExt 无效，退屏幕标称）");
    calib_logf("# [calib] 标称(旧/lcInExt 分母，仅作对照不再采用) X=%.6f Y=%.6f\n",
               (double)g_screenW / (double)(inExtX > 0 ? inExtX : 1),
               (double)g_screenH / (double)(oey > 0 ? oey : 1));
    calib_logf("# [calib] 采用 %s： X=%.6f Y=%.6f（符号另由标定投票定）\n",
               haveOut ? "屏幕/lcOutExt" : "屏幕标称", g_pxAxisX, g_pxAxisY);
    calib_logf("# [calib] 轴上界最终 = %u（与 px 同源，应 = lcOutExtX）\n", axMax);

    g_calib.hCtx = hCtx;
    g_calib.stride = ok ? stride : (haveScan ? sStride : 0);
    g_calib.offSerial = ok ? offS : sOff;
    g_calib.offX = ok ? offX : -1;
    g_calib.offY = ok ? offY : -1;
    /* ⛔⛔ 落笔判据的字段偏移在上面的日志段就已经裁决好了（cBtn/cZ/cNP/cTP，见那里的注释）。 */
    g_calib.offBtn = cBtn; g_calib.offZ = cZ; g_calib.offNP = cNP; g_calib.offTP = cTP;
    g_calib.offTime = cTime; g_calib.offChanged = cChg;
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

/* ============================================================================
 * 独立笔通路（Raw Input / HID 自读）—— 2026-10-16 第十四轮
 *
 * ── 为什么要它（三轮交叉定案）──────────────────────────────────────────────
 * 断流 = **驱动侧 WinTab 采样整体停摆**：`calls` 一直涨、`packets` 冻结数分钟，
 * 而同时
 *   · `WTOverlap` 全返 1（PS 的上下文一直在重叠序顶层）、
 *   · 插件**自建**上下文 + 推顶 + 笔在动，`WTPacketsGet` 读包依然为 **0**
 *     （0x0108 探针 / 0x010C `[relay]`：8×40ms 共读 0 包）。
 * ⇒ Wintab 这条通路在停摆期**没有任何杠杆**可用（进程内无解）。恢复瞬间驱动把
 *   攒下的包一次性交出来（冲包量 ≈ 队列容量 128）⇒ PS 在一帧里画完整根弧线，
 *   用户看到的就是「卡顿 → 整根弧线一次性冒出来」。
 *
 * 唯一的出路：**绕开 Wintab**，用 Windows 自己的 Raw Input 通道另读一份笔数据，
 * 在 Wintab 空转时把合成包喂给 PS。
 *
 * ── 三级安全门（本模块的全部风险都在这里）─────────────────────────────────
 *   ① **镜像有效性**：合成包必须落在 PS 认的坐标空间里。做法不是猜，而是
 *      与**真实包配对做逐轴最小二乘仿射拟合**（raw → 平板坐标），并统计残差 rms；
 *      只有 `n ≥ 300 且 rms ≤ 1.5px` 才认（见 RIFIT）。拟合不成立 ⇒ 本模块
 *      **一个字节都不会写**（与 0x010C 行为逐位相同）。
 *   ② **只在空转时接管**：真实通路返回 0 包、且 raw 样本新鲜（≤150ms）、且笔在
 *      范围内 ⇒ 才补流。真实通路一旦有包，永远以真实包为准。
 *   ③ **丢弃冲包**：刚补流过而真实通路一次吐回 ≥25 包 ⇒ 丢弃。否则补流已经把
 *      输出点推到光标，冲包又把几十个**旧**坐标重放一遍 ⇒ PS 会把整根弧线倒着
 *      画回去（比不补流更糟）。
 *
 * ── 采样源优先级 ───────────────────────────────────────────────────────────
 * HID 笔报告（有真实压力/落笔位）优先；若本机根本不派 HID 笔报告，退回
 * **绝对鼠标**（`MOUSE_MOVE_ABSOLUTE`，只有位置 + 按键当落笔位）。两条源各自
 * 有独立的拟合，切换时清空配对环（两套 raw 量纲不同，混在一起必然拟合失败）。
 *
 * ⛔ 本线程**不在 detour 上**：建窗/注册/解析/落日志都允许系统调用。
 *    detour 只做三件 O(1) 的事：读几个原子、偶尔记一对配对、需要时填合成包。
 * ==========================================================================*/
#define PENRAW_CLASS   L"JWautofillPenRaw"
#define RIPSZ          512                  /* raw 样本环（2 的幂） */
#define RIPAIR_N       1024                 /* 配对环（2 的幂） */
#define RI_RAW_MAXAGE  400                  /* 补流时只采用这么久以内的样本 */
#define RI_STALL_MS    250                  /* 真实通路静默多久才算「空转」 */
#define RI_FRESH_MS    150                  /* raw 样本多久算新鲜 */
#define RI_PAIR_GAP_MS 10                   /* 配对节流 + 「raw 新鲜」窗口（一份 raw 样本只配一次） */
#define RI_PAIR_MAX_AGE 400                 /* 0x0119：配对入口的包龄上限（ms）——停摆恢复冲包不进环，见 penraw_maybe_pair */
#define RI_PAIR_MAXPKT 4                    /* 只配「正常轮询」的包（冲包不配） */
#define RI_FIT_MIN_N   150                  /* 拟合最少样本数（**稳健剔除之后**的） */
#define RI_FIT_OUT_KEEP 96                  /* 单对残差超过此值即判离群（平板单位；1 单位=1/16px ⇒ 6px） */
/* ⛔⛔ 0x0119：8.0 → 48.0（与 RI_ANA_MAX_RMS 对齐 = 3px）。真机 jwwh-32560
   实测：映射系数 a=16.003/-16.012（真值 ±16，比例/符号/原点全对）时，保留集
   rms 持续 18~35 单位（1.1~2.2px）——残差全部来自「raw 光标采样 64Hz 与
   wintab 包 ~66Hz 的配对时间错位」（本函数注释自己预言的运动噪声：10ms
   ≈ 160 单位）。0.5px 的门槛在**任何运笔场景**都达不到 ⇒ g_fit.valid 全程 0
   ⇒ 补流强映射从未武装，只剩解析兜底（还时通时断）。
   48 仍与「映射整体错」差一个量级（错轴/符号/倍错的残差是几百到几万，
   见本函数注释），且 RI_FIT_OUT_KEEP=96 的离群剔除在前；解析阈值 48 曾在
   jwwh-32560 验证能区分对错（17:49:46 解析★可用 rms=42.7/31.9，喂包正确），
   但 0x0129 的 jwwh-5288 显示 48 坐在噪声带里（残差 52.1 即卡死）⇒ 已抬到 96，
   见 RI_ANA_MAX_RMS 处。 */
#define RI_FIT_MAX_RMS 48.0                 /* 重拟合后逐轴 rms 上限（48 单位 = 3px） */
#define RI_FIT_MIN_SPAN 1000                /* 保留集的 raw 跨度下限（防「点全挤在一处」的病态拟合） */
#define RI_BIG_BURST   25                   /* 单次 ≥ 这么多包 = 冲包 */
/* ⛔⛔ 0x0129：48 → 96。真机 jwwh-5288（0x0128 + queueSize=128 复测场）实测：
   拟合全程卡在跨度（小笔画保留集跨度 191/661 < RI_FIT_MIN_SPAN=1000，设计如此），
   只剩解析兜底——而解析的核对残差持续 42~128（09:03:07 118.9/95.7、09:03:09
   52.3/53.2、09:03:16 52.1/41.7），**映射全部正确**（同场污染拍 840/1073 才是
   错映射量级）。48 的准入线坐在噪声带里 ⇒ g_anaOk 全程 0 ⇒ g_synOn 恒 0 ⇒
   补流从未武装（[dead] 行 syn=0「补流未武装 ⇒ 平滑实质中断」）。
   与 0x0119 把 RI_FIT_MAX_RMS 从 0.5px 放宽到 3px 是同一笔账：运笔时间错位
   本身就有 1~2px（raw 光标 64Hz vs wintab 包 ~66Hz）。96 仍在「错映射几百到
   几万」之下一个量级 ⇒ 区分度不丢；滞回保留（见 RI_ANA_OFF_RMS）。
   ⚠️ 已知残余风险：停摆期配对环冻结，若停摆前最后一窗 64 对已被恢复冲包污染
   （0x0119 的 400ms 配对门拦不住的 157ms 级余波），本场停摆映射可能一直不武装——
    primary defense 仍是配对门，此处不恶化也不解决它。 */
#define RI_ANA_MAX_RMS 96.0                 /* 解析映射的核对残差上限（平板单位；1 单位=1/16px ⇒ 6px） */
/* ⛔⛔ 0x0120：滞回。真机 jwwh-37300：运笔中 64 对核对窗口的残差在 31↔71 间震荡
   （raw 光标 64Hz 与 wintab 包 ~66Hz 的配对时间错位随运笔速度波动），48 单阈值
   被反复穿越 ⇒ 解析映射时通时断 ⇒ g_synOn 被 worker 每 2s 的复验抖一次。
   已启用后改用 96（=6px）复验：错映射的残差是几百到几万（见 rifit 注释），
   96 仍决定性；而对救援而言 6px 误差远好过整笔冻结。
   ⚠️ 0x0129 复核：这段只抬了「保持线」没抬「准入线」——jwwh-5288 证明准入线 48
   才是死点（残差 42~128 全程进不来 ⇒ syn 恒 0）。现准入 96 / 保持 160。 */
#define RI_ANA_OFF_RMS 160.0                /* 已启用后的复验上限（滞回；0x0129 96→160：准入已抬到 96，保持线再抬一档才构成滞回；错映射仍是几百到几万） */
/* —— 陈旧回包合并 v2（2026-10-16 第十八轮）—— */
#define RI_PKT_FRESH_MS 400                 /* 包在多少 ms 内到达算「新鲜」——
                                               ⛔ 只用来**正面证明** pkTime 与 GetTickCount 同基，
                                                  与「判陈旧」无关（旧版正是把两者混成一个量纲才死的） */
#define RI_RECOV_MS     4000                /* 停摆恢复后多久内仍做陈旧合并（覆盖一拍只吐 1~5 包的分批回吐） */
#define RI_PKT_STALE_MS 1500                /* 包龄超过它即判陈旧（覆盖「停摆期没补流」的那条路：
                                               没有补流前沿可比时，包龄是唯一的凭据） */

typedef struct { DWORD t; int x, y, p, tip, inr; } RIPS;

static RIPS            g_riRing[RIPSZ];
static volatile LONG   g_riHead;            /* 生产端单调递增序号 */
static volatile LONG   g_riHidN, g_riMouseN, g_riAbsN, g_riBadN;
/* ⛔ 判决「Raw Input 通道本身通不通」的两个计数：注册返回 TRUE 只说明请求被接受，
   设备不存在也照样回 TRUE ⇒ 必须看**有没有 WM_INPUT 真的到达窗口过程**。
   键盘（01/06）只计数、不解析内容。 */
static volatile LONG   g_riAllN, g_riKbdN;
static volatile LONG   g_riLastMs;          /* 最近一份 raw 样本时刻 */
static volatile LONG   g_riX, g_riY, g_riP, g_riTip, g_riIn;
static volatile LONG   g_riSrc;             /* 0=未定 1=HID 笔 2=绝对鼠标 */
static volatile LONG   g_riReg, g_riWndOk;  /* 注册结果位 / 建窗成功 */
static HANDLE          g_riThread;
static DWORD           g_riTid;
static volatile LONG   g_riStop;

/* —— 配对（detour 写、worker 读）—— */
typedef struct { int rx, ry, wx, wy; } RIP_pair;
static RIP_pair        g_pair[RIPAIR_N];
static volatile LONG   g_pairHead;
static volatile LONG   g_pairMs;

/* —— 合成包底本：真包里最后一包原样留一份，合成时先克隆再改字段，
        这样所有我们不认识的字段（cursor/orientation/...）都保持合法。 —— */
static u8              g_tpl[256];
static volatile LONG   g_tplOk;

/* —— 补流状态 —— */
static volatile LONG   g_synOn;             /* 门控总闸（由 syn_set() 统一发布：强拟合 ∨ 解析映射） */
/* ⛔⛔ 0x0120：补流「最后可用映射」快照。接管期间 worker 的 2s 复验可能把
   g_synOn 抖成 0（残差在阈值边缘震荡，真机 jwwh-37300 18:12:24.687：接管
   1.1s 后按「引擎已关闭」退出，余下 9.4s 冻结到驱动自愈），此时 penraw_synth
   两个 live 来源全灭 —— 没有快照就一个包都喂不出，救援等于被自己人拆台。
   快照只在任一 live 来源可用时刷新 ⇒ 内容恒为「某刻通过过验证」的系数；
   g_calib.valid / enNow 仍在 detour 门里硬性把关。 */
static double          g_holdAx, g_holdBx, g_holdAy, g_holdBy;
static volatile LONG   g_holdOk;
static volatile LONG   g_synHead;           /* 上次补流消费到的 raw 序号 */
static volatile LONG   g_synSerial;         /* 合成包序号 */
/* ⛔⛔ 0x0128：PS 的 Wintab 上下文是**消息驱动**的 —— 真机 jwwh-28756 首行实测
   `[ctx] WTOpenW hCtx=0x802 opt=0x801D ★CXO_MESSAGES msgBase=0x7FF0`。
   含义：PS 的画布**不轮询**取包，它等驱动投递 `WT_PACKET`（msgBase+0）消息，收到才去
   WTPacketsGet 并重绘。驱动一停投递，PS 就只剩空闲定时器那 ~67 次/2s 的在跑，
   我们塞进去的合成包**没人读** —— 这正是「我方每拍都返回、PS 取包速率却掉到空闲」的机制。
   ⇒ 补流期间由采样线程（不在 detour 里，可安全调 Win32）代为 PostMessage，
      把 PS 的取包/重绘循环叫醒。 */
static HWND  g_ctxHwnd;                 /* WTOpenW/A 收到的窗口（PS 画布） */
static volatile LONG g_ctxMsgBase = 0x7FF0;
static volatile LONG g_ctxOpt;
static volatile LONG g_ctxPostN;        /* 补发 WT_PACKET 次数（诊断） */
/* ⛔ 这两个变量的正式声明在本文件更靠后的「断流诊断」段，但 cursamp_thread 想用它们
   （它在前）⇒ 此处提前给出 tentative 定义（C 允许同名 tentative definition 合并）。 */
static volatile LONG g_synWas;
static HCTX g_ctxNow;
static volatile LONG   g_synLastMs;
static volatile LONG   g_synRuns, g_synPkts, g_dropBurst, g_dropLast;
/* ⛔⛔ **补流前沿**（2026-10-17 第十七轮）：最后一次喂给 PS 的合成样本时刻。
   它是「回包该不该丢」的唯一判据 —— 真实包的 pkTime 早于它 ⇒ 这段位移补流已经
   喂过，再放行就是在已经画到当下的路径后面**追加旧坐标**（选区倒退+猛追 = 过冲）。
   ⛔ 与包数无关：PS 每拍只取 1~5 包，48 包的恢复冲包被拆成十几拍，任何「单次包数」
   门限都拦不住（这正是上一版 丢冲包 恒 0 的原因）。 */
static volatile LONG   g_synFrontT;
static volatile LONG   g_dropStaleN, g_dropStaleMs, g_dropStaleEvt;
/* —— 陈旧回包合并 v2 的状态 —— */
static volatile LONG   g_pkBaseOk;         /* pkTime 与 GetTickCount 同基（**正面证据**，见 detour 注释） */
static volatile LONG   g_lastRecovMs;      /* 最近一次「停摆后的首批真包」时刻；窗口 RI_RECOV_MS */
static volatile LONG   g_dropStaleAgeN;    /* 其中由「包龄」判掉的个数（与按前沿判掉的区分开） */
static volatile LONG   g_baseEvt;          /* 时间基首次证实 ⇒ 交给 worker 落盘（detour 内零 I/O） */
/* ⛔⛔ 补流门控的**真凭据**：最近一次收到**真实**包的时刻。
   采样源换成系统光标之后，raw 环会被 250Hz 的光标采样一直喂饱 ⇒ 旧判据
   「raw 新鲜」恒真 ⇒ 会在驱动**完全正常**时也每次 r==0 都补流（把 Wintab
   通路变成 250Hz 的重复坐标流）。必须以「真实包是否已经空转」为闸：
   `r == 0 && now - g_lastRealMs >= RI_STALL_MS` 才是「真实通路空转」。 */
static volatile LONG   g_lastRealMs;
/* ⛔⛔ 断流期的「笔还按着吗」唯一可信来源（2026-10-16 第十六轮）：
   `g_penDown` 只在**来包时**更新，断流 >5s 会被 `[pen] 落笔锁存超时` 强制清零。
   而合成包要有非零压力才不会被闸门判成悬空 ⇒ 一清零就**死锁**（补流给 0 压力 ⇒
   penDown 仍 0 ⇒ 后续全 0）。这里记住**最后一个真实包**结束时的落笔态：
   断流越久它越可靠 —— 因为「用户抬没抬笔」这件事只有真实包说了算。
   ⛔ 它带来的唯一副作用是：真抬笔后驱动仍停摆时会继续补流 —— 但抬笔后
   **光标不再移动** ⇒ 合成包坐标一成不变 ⇒ PS 画不出任何新东西，无害。 */
static volatile LONG   g_lastRealTip;

/* —— 观测范围（自标定，不依赖任何 HID 描述符解析）—— */
static volatile LONG   g_riXMin, g_riXMax, g_riYMin, g_riYMax, g_riPMax;

/* —— 拟合结果 —— */
typedef struct {
    int    valid;
    int    n;          /* 保留集样本数 */
    int    nAll;       /* 参与拟合的全部配对数 */
    double ax, bx, ay, by;
    double rmsX, rmsY;
    int    spanX, spanY;
} RIFIT;
static RIFIT g_fit;

/* —— 解析映射（第二来源）：屏幕 → 平板 ——
   ⛔⛔ 为什么需要它（2026-10-16 第十七轮，对照 Lazy Nezumi Pro 的结论）：
     补流的**唯一**放行凭据原先只有「强拟合」`g_fit`，而强拟合要求
     `保留集 ≥150 且逐轴 rms ≤8 且两轴跨度 ≥1000`。这三条都建立在**配对**上，
     而配对只在**真实包**到达时产生（detour 侧）⇒ 一旦「插件刚挂上就断流」，
     配对永远攒不够 ⇒ 拟合永不成立 ⇒ 补流永不激活 ⇒ 断流无解。这是一个
     自锁：**最需要补流的时候，恰恰是补流建不起来的时候。**
   ⛔ 而「屏幕 → 平板」这条映射其实**不需要配对规模**就能拿到：
     `px_x()/px_y()` 的驱动权威 = `屏幕/lcOutExt`，来自 LOGCONTEXT（首次取包即得），
     断流不影响它；**只有原点**需要一对配对来定，而 `g_tplOk` 成立本身就意味着
     至少有过一对（否则连 g_tpl 都没有）。⇒ 解析映射的成立条件比强拟合低两个数量级。
   ⛔ 与强拟合的关系：**并存、强拟合优先**。拟合有稳健剔除 + 跨度判据，是更可信的
     来源；解析映射是断流早发时的兜底。二者算的是同一份物理映射。
   ⛔ 系数经 seqlock（`g_anaVer` 奇=写入中）跨线程交给 detour —— detour 侧
     `penraw_synth` 会在一次调用内多次读它，必须拿到**自洽**的一份快照。 */
typedef struct {
    double ax, bx, ay, by;   /* 平板 = a·屏幕 + b（与 RIFIT 同构，便于互换） */
    int    nPair;            /* 定原点所用的配对序号（诊断） */
    int    nCheck;           /* 用多少对配对核对过 rms（0 = 无从核对） */
    double rmsX, rmsY;       /* 核对残差 */
} ANAMAP;
static ANAMAP          g_ana;               /* 诊断用（worker 自用，不进 detour） */
static volatile double g_anaCoef[4];        /* ax,bx,ay,by —— detour 经 ana_get 读 */
static volatile LONG   g_anaOk;
static volatile LONG   g_anaVer;            /* seqlock：奇数 = 正在写入 */
static int             g_anaLogged;         /* 「解析映射就绪」只落一行日志 */

/* ---- HID 解析（hid.dll 动态加载：不进导入表，缺文件也不影响主功能）---- */
typedef LONG (WINAPI *PFN_HidP_GetUsageValue)(int, USHORT, USHORT, USHORT,
                                              ULONG*, void*, char*, ULONG);
typedef LONG (WINAPI *PFN_HidP_GetCaps)(void*, void*);

typedef struct {                             /* HIDP_CAPS（只用到前几个字段） */
    USHORT UsagePage; USHORT Usage;
    USHORT InputReportByteLength; USHORT OutputReportByteLength;
    USHORT FeatureReportByteLength; USHORT Reserved[17];
    USHORT NumberLinkCollectionNodes;
    USHORT NumberInputButtonCaps;  USHORT NumberInputValueCaps;  USHORT NumberInputDataIndices;
    USHORT NumberOutputButtonCaps; USHORT NumberOutputValueCaps; USHORT NumberOutputDataIndices;
    USHORT NumberFeatureButtonCaps; USHORT NumberFeatureValueCaps; USHORT NumberFeatureDataIndices;
} RI_CAPS;

#define RI_HIDP_OK      0x00110000L
#define RI_HIDP_INPUT   0

typedef struct { HANDLE dev; void* ppd; } RI_DEV;
static RI_DEV   g_riDev[8];
static int      g_riDevN;
static HMODULE  g_riHidMod;
static PFN_HidP_GetUsageValue g_riGetVal;
static PFN_HidP_GetCaps       g_riCaps;

static void ri_minmax(volatile LONG* lo, volatile LONG* hi, LONG v)
{
    if (!*lo && !*hi) { *lo = v; *hi = v; return; }   /* 哨兵：0/0 = 还没样本 */
    if (v < *lo) *lo = v;
    if (v > *hi) *hi = v;
}

/** 取（并缓存）某 HID 设备的 preparsed data；新设备时落一行设备描述。 */
static void* ri_dev_ppd(HANDLE dev)
{
    for (int i = 0; i < g_riDevN; i++)
        if (g_riDev[i].dev == dev) return g_riDev[i].ppd;
    if (g_riDevN >= (int)(sizeof(g_riDev) / sizeof(g_riDev[0]))) return NULL;

    if (!g_riHidMod) {
        g_riHidMod = LoadLibraryA("hid.dll");
        if (g_riHidMod) {
            g_riGetVal = (PFN_HidP_GetUsageValue)(void*)GetProcAddress(g_riHidMod, "HidP_GetUsageValue");
            if (!g_riGetVal)
                g_riGetVal = (PFN_HidP_GetUsageValue)(void*)GetProcAddress(g_riHidMod, "HidP_GetUsageValue_64");
            g_riCaps   = (PFN_HidP_GetCaps)(void*)GetProcAddress(g_riHidMod, "HidP_GetCaps");
        }
        logf("# [raw] hid.dll=%s HidP_GetUsageValue=%s HidP_GetCaps=%s\n",
             g_riHidMod ? "载入" : "★载入失败",
             g_riGetVal ? "有" : "无", g_riCaps ? "有" : "无");
    }
    if (!g_riGetVal) return NULL;

    UINT sz = 0;
    GetRawInputDeviceInfoW(dev, RIDI_PREPARSEDDATA, NULL, &sz);
    if (sz == 0) { logf("# [raw] ★设备 0x%p 取 preparsed data 失败（sz=0）\n", (void*)dev); return NULL; }
    void* buf = HeapAlloc(GetProcessHeap(), 0, sz);
    if (!buf) return NULL;
    if (GetRawInputDeviceInfoW(dev, RIDI_PREPARSEDDATA, buf, &sz) != sz) {
        HeapFree(GetProcessHeap(), 0, buf);
        logf("# [raw] ★设备 0x%p preparsed data 读取失败\n", (void*)dev);
        return NULL;
    }
    g_riDev[g_riDevN].dev = dev;
    g_riDev[g_riDevN].ppd = buf;
    g_riDevN++;

    /* 设备描述（一次）：名字 + HID caps（page/usage 能区分「笔」与「触摸」） */
    WCHAR name[256];
    UINT  nsz = sizeof(name);
    if (GetRawInputDeviceInfoW(dev, RIDI_DEVICENAME, name, &nsz) != (UINT)-1) name[255] = 0;
    else name[0] = 0;
    RI_CAPS caps;
    memset(&caps, 0, sizeof(caps));
    if (g_riCaps) g_riCaps(buf, &caps);
    logf("# [raw] ★HID 设备 #%d hDev=0x%p caps(page=0x%04X usage=0x%04X "
         "inLen=%d valCaps=%d btnCaps=%d) name=%ls\n",
         g_riDevN, (void*)dev, (unsigned)caps.UsagePage, (unsigned)caps.Usage,
         (int)caps.InputReportByteLength, (int)caps.NumberInputValueCaps,
         (int)caps.NumberInputButtonCaps, name);
    return buf;
}

/** 一份 raw 样本入环。生产者：Raw Input 线程（唯一）。 */
static void ri_push(DWORD now, int x, int y, int p, int tip, int inr)
{
    LONG h = g_riHead;
    RIPS* s = &g_riRing[(u32)h & (RIPSZ - 1)];
    s->t = now; s->x = x; s->y = y; s->p = p; s->tip = tip; s->inr = inr;
    InterlockedIncrement(&g_riHead);
    /* ⛔ 顺序：先写样本体，最后才抬 g_riLastMs（读者用它当「新鲜」判据）。 */
    InterlockedExchange(&g_riX, (LONG)x);
    InterlockedExchange(&g_riY, (LONG)y);
    InterlockedExchange(&g_riP, (LONG)p);
    InterlockedExchange(&g_riTip, (LONG)tip);
    InterlockedExchange(&g_riIn, (LONG)inr);
    ri_minmax(&g_riXMin, &g_riXMax, (LONG)x);
    ri_minmax(&g_riYMin, &g_riYMax, (LONG)y);
    if (p > g_riPMax) InterlockedExchange(&g_riPMax, (LONG)p);
    InterlockedExchange(&g_riLastMs, (LONG)now);
}

/** HID 笔报告 → 样本。usage：X/Y 在通用桌面页，压力/落笔位/在范围内在 Digitizer 页。 */
static void ri_parse_hid(const RAWINPUT* ri, DWORD now)
{
    if (!ri->data.hid.dwSizeHid || ri->header.dwSize <= sizeof(RAWINPUTHEADER)) {
        InterlockedIncrement(&g_riBadN); return;
    }
    ULONG len = ri->data.hid.dwSizeHid;
    if (len > 256) len = 256;
    char rep[264];
    memcpy(rep, ri->data.hid.bRawData, len);
    ULONG vx = 0, vy = 0;
    void* ppd = ri_dev_ppd(ri->header.hDevice);
    if (!ppd) { InterlockedIncrement(&g_riBadN); return; }
    int okx = (g_riGetVal(RI_HIDP_INPUT, 0x01, 0, 0x30, &vx, ppd, rep, len) == RI_HIDP_OK);
    int oky = (g_riGetVal(RI_HIDP_INPUT, 0x01, 0, 0x31, &vy, ppd, rep, len) == RI_HIDP_OK);
    if (!okx || !oky) {                       /* 少数设备把 X/Y 也放在 Digitizer 页 */
        okx = (g_riGetVal(RI_HIDP_INPUT, 0x0D, 0, 0x30, &vx, ppd, rep, len) == RI_HIDP_OK);
        oky = (g_riGetVal(RI_HIDP_INPUT, 0x0D, 0, 0x31, &vy, ppd, rep, len) == RI_HIDP_OK);
    }
    if (!okx || !oky) { InterlockedIncrement(&g_riBadN); return; }

    ULONG tip = 0, inr = 1, pr = 0;
    if (g_riGetVal(RI_HIDP_INPUT, 0x0D, 0, 0x42, &tip, ppd, rep, len) != RI_HIDP_OK) tip = 0;
    if (g_riGetVal(RI_HIDP_INPUT, 0x0D, 0, 0x32, &inr, ppd, rep, len) != RI_HIDP_OK) inr = 1;
    if (g_riGetVal(RI_HIDP_INPUT, 0x0D, 0, 0x30, &pr,  ppd, rep, len) != RI_HIDP_OK) pr = 0;

    if (InterlockedExchange(&g_riSrc, 1) != 1) {
        /* 从「绝对鼠标」切到 HID 笔：量纲不同，配对环必须清空重来 */
        InterlockedExchange(&g_pairHead, 0);
        logf("# [raw] 采样源切到 **HID 笔**，配对环清空重拟合\n");
    }
    InterlockedIncrement(&g_riHidN);
    ri_push(now, (int)vx, (int)vy, (int)pr, tip ? 1 : 0, inr ? 1 : 0);
}

static void ri_handle_input(HRAWINPUT hri)
{
    BYTE buf[512];
    UINT sz = sizeof(buf);
    if (GetRawInputData(hri, RID_INPUT, buf, &sz, sizeof(RAWINPUTHEADER)) != sz) return;
    const RAWINPUT* ri = (const RAWINPUT*)buf;
    DWORD now = GetTickCount();
    if (ri->header.dwType == RIM_TYPEHID) {
        ri_parse_hid(ri, now);
    } else if (ri->header.dwType == RIM_TYPEMOUSE) {
        InterlockedIncrement(&g_riMouseN);
        const RAWMOUSE* rm = &ri->data.mouse;
        if (rm->usFlags & MOUSE_MOVE_ABSOLUTE) {
            /* ⛔ 落笔状态必须**保持**：绝对鼠标报告绝大多数只带位置、不带按键位，
               若「没带按键位」就当成抬起，落笔会被每帧冲成 0 ⇒ 合成包全被判成悬空、
               闸门关闭、补流白做。只有报告里**确实**带了按键位时才更新状态。 */
            static int s_mouseTip;
            if (rm->usButtonFlags & RI_MOUSE_BUTTON_1_DOWN) s_mouseTip = 1;
            else if (rm->usButtonFlags & RI_MOUSE_BUTTON_1_UP) s_mouseTip = 0;
            if (InterlockedExchange(&g_riSrc, 2) != 2) {
                InterlockedExchange(&g_pairHead, 0);
                logf("# [raw] 采样源切到 **绝对鼠标**（本机未派 HID 笔报告），配对环清空重拟合\n");
            }
            InterlockedIncrement(&g_riAbsN);
            ri_push(now, (int)(LONG)rm->lLastX, (int)(LONG)rm->lLastY, 0, s_mouseTip, 1);
        }
    } else if (ri->header.dwType == RIM_TYPEKEYBOARD) {
        InterlockedIncrement(&g_riKbdN);      /* 只计数：用来判「通道通不通」，不解析内容 */
    }
}

static LRESULT CALLBACK penraw_wndproc(HWND h, UINT m, WPARAM w, LPARAM l)
{
    if (m == WM_INPUT) {
        InterlockedIncrement(&g_riAllN);      /* 通道是否真的通：只要 >0，「实现」就没问题 */
        ri_handle_input((HRAWINPUT)l);
        return 0;
    }
    if (m == WM_NCHITTEST) return HTTRANSPARENT;
    if (m == WM_ERASEBKGND) return 1;
    return DefWindowProcW(h, m, w, l);
}

static DWORD WINAPI penraw_thread(LPVOID param)
{
    (void)param;
    HINSTANCE inst = g_hInst ? g_hInst : GetModuleHandleW(NULL);
    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof(wc));
    wc.cbSize        = sizeof(wc);
    wc.lpfnWndProc   = penraw_wndproc;
    wc.hInstance     = inst;
    wc.lpszClassName = PENRAW_CLASS;
    if (!RegisterClassExW(&wc)) {
        logf("# [raw] ★RegisterClassExW 失败 err=%lu\n", (unsigned long)GetLastError());
        return 0;
    }
    /* 0×0 的不可见 WS_POPUP：只用来接收 WM_INPUT，永不显示、永不激活。
       ⛔ 不能建在 DllMain（loader lock）；本线程由 worker 拉起。 */
    HWND w = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, PENRAW_CLASS, L"",
                             WS_POPUP, 0, 0, 0, 0, NULL, NULL, inst, NULL);
    if (!w) {
        logf("# [raw] ★CreateWindowExW 失败 err=%lu\n", (unsigned long)GetLastError());
        return 0;
    }
    InterlockedExchange(&g_riWndOk, 1);

    /* 四条 usage 分别注册：哪条成了、哪条没成，日志里要能一眼看出来。
       ⛔ 第四条**键盘**是**判决用**的对照项（2026-10-16 第十六轮）：它是唯一
          一定在 Raw Input 队列里的设备 ⇒ 「键盘也没 WM_INPUT」说明通道/窗口有问题，
          「键盘有、笔没有」才说明是笔设备不在队列（Wacom WinTab 模式）。
          只计数，不解析、不记录内容。 */
    RAWINPUTDEVICE rd[4];
    memset(rd, 0, sizeof(rd));
    rd[0].usUsagePage = 0x0D; rd[0].usUsage = 0x02;   /* Digitizer / Pen */
    rd[1].usUsagePage = 0x0D; rd[1].usUsage = 0x01;   /* Digitizer / Digitizer */
    rd[2].usUsagePage = 0x01; rd[2].usUsage = 0x02;   /* Generic Desktop / Mouse（兜底） */
    rd[3].usUsagePage = 0x01; rd[3].usUsage = 0x06;   /* Generic Desktop / Keyboard（对照） */
    LONG reg = 0;
    const char* tag[4] = { "0D/02 笔", "0D/01 数字化仪", "01/02 鼠标", "01/06 键盘" };
    for (int i = 0; i < 4; i++) {
        rd[i].dwFlags = RIDEV_INPUTSINK;
        rd[i].hwndTarget = w;
        DWORD e = 0;
        BOOL ok = RegisterRawInputDevices(&rd[i], 1, sizeof(RAWINPUTDEVICE));
        if (!ok) e = GetLastError();
        if (ok) reg |= (1L << i);
        logf("# [raw] 注册 %s 输入: %s err=%lu\n", tag[i], ok ? "OK" : "★失败",
             (unsigned long)e);
    }
    InterlockedExchange(&g_riReg, reg);

    /* —— 一次性设备枚举（2026-10-16 第十五轮）——
       ⛔ 注册**成功**不等于**收得到**：真机 jwwh-22288 三条 usage 全 OK（reg=0b111），
          但整场 HID=0、绝对鼠标=0 —— 一条 WM_INPUT 都没有。必须区分两种可能：
            ① 本机 Raw Input **根本看不见**笔/数字化仪（Wacom 处于 WinTab 模式时就会这样，
               笔只走 Wintab 驱动，不进 Raw Input 队列）⇒ 独立笔通路**原理上不可行**；
            ② 设备在列表里、只是没派输入 ⇒ 那才是我们实现的问题。
          `GetRawInputDeviceList` + `RIDI_DEVICENAME` 直接给出答案（设备路径里带 VID/PID
          与集合号）。这一步只做一次，不占热路径。 */
    {
        UINT n = 0;
        if (GetRawInputDeviceList(NULL, &n, sizeof(RAWINPUTDEVICELIST)) == 0 && n) {
            if (n > 512) n = 512;
            RAWINPUTDEVICELIST* dl = (RAWINPUTDEVICELIST*)
                HeapAlloc(GetProcessHeap(), 0, sizeof(RAWINPUTDEVICELIST) * n);
            if (dl) {
                UINT got = GetRawInputDeviceList(dl, &n, sizeof(RAWINPUTDEVICELIST));
                int cHid = 0, cMouse = 0, cKbd = 0, cOther = 0;
                for (UINT i = 0; i < got; i++) {
                    if (dl[i].dwType == RIM_TYPEHID)            cHid++;
                    else if (dl[i].dwType == RIM_TYPEMOUSE)     cMouse++;
                    else if (dl[i].dwType == RIM_TYPEKEYBOARD)  cKbd++;
                    else                                        cOther++;
                }
                logf("# [raw] 设备枚举：共 %u 个（HID=%d 鼠标=%d 键盘=%d 其他=%d）\n",
                     (unsigned)got, cHid, cMouse, cKbd, cOther);
                int shown = 0;
                for (UINT i = 0; i < got && shown < 12; i++) {
                    if (dl[i].dwType != RIM_TYPEHID) continue;
                    UINT sz = 0;
                    GetRawInputDeviceInfoW(dl[i].hDevice, RIDI_DEVICENAME, NULL, &sz);
                    if (sz == 0 || sz > 512) continue;
                    WCHAR nb[512];
                    UINT got2 = GetRawInputDeviceInfoW(dl[i].hDevice, RIDI_DEVICENAME, nb, &sz);
                    if (got2 == (UINT)-1) continue;
                    nb[511] = 0;
                    logf("# [raw]   HID#%d %ls\n", shown, nb);
                    shown++;
                }
                HeapFree(GetProcessHeap(), 0, dl);
            }
        } else {
            logf("# [raw] ★GetRawInputDeviceList 失败 err=%lu\n",
                 (unsigned long)GetLastError());
        }
    }

    MSG msg;
    while (!g_riStop && GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    DestroyWindow(w);
    return 0;
}

static void penraw_start(void)
{
    if (g_riThread) {
        DWORD code = 0;
        if (GetExitCodeThread(g_riThread, &code) && code == STILL_ACTIVE) return;
        CloseHandle(g_riThread);           /* 已死：回收句柄后再建（同 hud_start） */
        g_riThread = NULL; g_riTid = 0;
    }
    InterlockedExchange(&g_riStop, 0);
    g_riThread = CreateThread(NULL, 0, penraw_thread, NULL, 0, &g_riTid);
}

static void penraw_stop(void)
{
    if (!g_riThread) return;
    InterlockedExchange(&g_riStop, 1);
    if (g_riTid) PostThreadMessageW(g_riTid, WM_QUIT, 0, 0);
    WaitForSingleObject(g_riThread, 3000);
    CloseHandle(g_riThread);
    g_riThread = NULL; g_riTid = 0;
}

/* ========================================================= 采样源：系统光标
 * ⛔⛔ 为什么换源（2026-10-16 第十六轮，真机 jwwh-9252 定案）：
 *   Raw Input 两轮真机都是 `HID=0 绝对鼠标=0` —— Wacom 设备
 *   （VID_056A&PID_0357 三个 collection）**明明在 `GetRawInputDeviceList` 里**，
 *   三条 usage 注册也全 OK，却一条 WM_INPUT 都没有。这条路已判死。
 *   而同一份日志里 `[dead] ★包流断供: 包冻结 516ms 而光标仍移动(Δ累计509px)`
 *   ⇒ **`GetCursorPos` 在停摆期是活的**。要绕开 Wintab 拿到笔的位置，
 *   最可靠的一手就是直接读系统光标 —— 它与 Wintab 停不停摆无关。
 *
 * 采样值照样进 raw 环 ⇒ 下面「配对 → 逐轴仿射拟合 → 补流」**一行都不用改**：
 * 拟合是自适应的（采样坐标是屏幕像素还是 HID 原始值，它自己会算出 a/b），
 * 而 `penraw_synth` 本来就按样本序号消费、不重复 ⇒ 天然节流，无需另加。
 * ⛔ 一旦 HID / 绝对鼠标哪天真有数据，本线程立即让位，绝不混源。 */
static volatile LONG g_csStop, g_csN;
static HANDLE g_csThread;
static DWORD  g_csTid;

/* ——— 0x012B：补流窗口 + 两道防幽灵守卫的必要状态 ———
   🩺 `g_csBtn`/`g_csBtnOn` 是**诊断**：笔尖在 Windows 眼里是否等于「左键按下」。
      Wintab 独占时 Raw Input 拿不到笔的 tip（[raw] 里 HID=0），而驱动为了让光标动
      必然开着鼠标模拟 ⇒ VK_LBUTTON 有希望成为**断流期唯一可用的真实落笔证据**。
      下一轮看 `[raw] ... btn=状态/on=0→1次数`：on 的次数应≈起笔次数（本场 18 笔）。
      成立 ⇒ 0x012C 直接用它做补发判据，幽灵窗口可以彻底去掉（本版先只观测，不改行为）。
   前向声明 g_canvasOkDbg：定义在 HUD 段（带初值），补发前要读它 ——
   光标离开文档画布（去点面板/菜单/标题栏）时必须立刻停发，否则 PS 会继续画
   一条跟着鼠标走的幽灵线（这是 0x012B 防幽灵的第二道守卫）。 */
static volatile LONG g_csBtn, g_csBtnOn;
static volatile LONG g_canvasOkDbg;
static volatile LONG g_canvasHitDbg;   /* 0x0134：宽判（不看前台），只给平滑/补流救援用 */
/* 0x0138：`canvas_hit_ok()` 定义在 HUD 段（依赖 s_psFrame），而 det_GetCursorPos
   （LHOOK 段）要用它决定「这一段坐标能不能喂」⇒ 前向声明。 */
static int canvas_hit_ok(POINT cur);
/* 0x012F：user32 光标钩的诊断计数（[raw] 行要用，故前置于此；钩子槽位在 LHOOK 段）。
   ⛔ 与 g_lhGcp/g_lhGmp 分开声明：那两者依赖 LHOOK 类型，定义在后面。 */
static volatile LONG g_gcpCalls, g_gcpRw, g_gmpCalls;
/* 0x0137/0x0138：光标路径推进器计数（[raw] 行要用，故前置）。
   arms = 贴合（起笔重锚）次数；steps = 被绳拖动的次数 —— 断流期与正常期都该涨。 */
static volatile LONG g_gpArms, g_gpSteps, g_gpRej;
/* 0x0136：Windows Ink 探针计数（[raw]/[ink] 行要用，故同样前置；实现在 LHOOK 段）。
   hits=命中笔设备的轮次 contact=其中笔尖接触 contactNow=当前是否接触 (x,y)=Ink 屏幕坐标 */
static volatile LONG g_inkHits, g_inkContact, g_inkContactNow, g_inkX, g_inkY;
/* 只统计**真实**驱动包（不含独立笔通路合成的那部分）——
   断流看门狗必须看它：合成补流会把 g_packets 一直抬高，用它判冻结点就等于
   把断流藏起来了（诊断必须能说真话）。
   ⛔ 0x0136 前移到这里：[ink] 行要读它，而 penraw_report 在本行之上。 */
static volatile LONG g_pkReal;
static volatile LONG g_gcpArmed;      /* 最近一拍是否处于「接管」态（1/0） */
static volatile LONG g_csPostLog;      /* [post] 首包代投只打一次 */
/* ⛔⛔ 0x012E：断流期「喂入冻结」状态 + 最后一个画布内点（见喂入段/代投段注释）。 */
static volatile LONG g_csFrozen;
static int s_csGoodX, s_csGoodY, s_csGoodOk;
/* 前向声明 PS 主框：定义在 HUD 段。补发目标的第一备选（g_ctxHwnd 为空时用）。 */
static HWND s_psFrame;

/* ⛔⛔ 0x012B：**补流（合成包 + 代投 WT_PACKET）的安全窗口**，与接触判据的
   CONTACT_HOLD_SMOOTH_MS(1500ms) **刻意分开**。
   真机 jwwh-20708（0x012A，LNP 插件确在环：LNP 自己日志 11:14:04 进驻、11:15:44 随
   PS 退出）实证：本场 3 次真停摆 = 2.36s / 3.95s / >9.7s，而补发计数在每次停摆后
   **固定停在 1.5s 处不再增长**（tip 链到期 ⇒ 不再投 WT_PACKET ⇒ PS 的消息驱动循环
   下线 ⇒ 只剩 960 次/s 的空轮询，合成包照发但**不重绘**）。
   后果是用户看到的确切形态：线画到一半冻住、只好抬笔 ⇒ 整笔报废（"后几笔稳不住"）。
   ⇒ 窗口抬到 6s（覆盖实测 2.4~4.0s 的运笔期停摆）。
   ⛔ 为什么敢抬：0x0126 的幽灵顾虑（我方判据被自己喂成落笔、HUD 悬空冒出）已经由
      **realOk**（HUD 必须 400ms 内有真实包）独立堵死，本窗口只管合成包与消息投递。
      剩下的唯一风险 = 用户**在停摆期间抬笔并移动光标**时画出一段幽灵线 ⇒ 用两道
      守卫把窗口再收窄（见下方补发条件的注释），最坏情况也被画布边界/静止判据截断。 */
#define SYNTH_TIP_MAX_MS 6000

/* ⛔⛔ 0x012D：**断流期的落笔推断**（唯一的包外证据 = 笔尖 → 鼠标左键**消息**）
 *
 * 0x012B/0x012C 的 tip 全部来自包证据（g_penDown / g_lastRealTip），因此有一个
 * **构造性漏洞**：空档如果恰好在「笔抬着」的时候开始，之后用户按下笔尖也永远
 * 看不见（没有任何真包来告诉他 0→1）⇒ 整段空档只喂 buttons=0 的悬空包 ⇒
 * PS 收包却不落笔 ⇒ 用户连画几笔一笔都出不来，而且不会自愈（只能等驱动自己活）。
 * 真机 jwwh-21032 铁证：13.1s 空档里补流喂了 695 包、`零包次`735（驱动力零输出），
 * 用户报「4–7 断流」。
 *
 * 规则（全部只在 `realAge > RI_STALL_MS` 的窗口内生效，绝不干扰正常绘制）：
 *   · 武装：见到一次 0→1 事件，且**光标在活动文档画布内**（g_canvasOkDbg）；
 *   · 解除：见到抬起事件 / 光标离开画布 / 停手 MSE_IDLE_MS / 单次按下硬上限 /
 *          真实包回来（判据交还包流）；
 *   · 武装后至少 MSE_MIN_DOWN_MS 不因「抬起」解除 —— 有的驱动按下时立刻补一条
 *     抬起消息（鼠标模拟只做边沿），照单全收的话一次也画不出来。
 *   ⛔ 镜像无数据（keyhook_mouse_state 返 0）⇒ 本段静默，行为与 0x012C 逐位相同。 */
#define MSE_ARM_LOOKBACK_MS 600  /* 按下发生在空档起点之前这么久，仍然认（空档判据本身滞后 250ms） */
#define MSE_MIN_DOWN_MS   800    /* 见到按下后至少算落笔这么久（抵掉按下即抬起的回声） */
#define MSE_IDLE_MS      2000    /* 光标静止这么久 = 停手，停止喂绘制包 */
#define MSE_HOLD_MAX_MS 15000    /* 单次按下硬上限（收不到抬起时的兜底） */
static volatile LONG g_mseTip;                 /* 1 = 当前处于「推断落笔」态 */
static volatile LONG g_mseArms, g_mseRels;     /* 武装 / 解除累计（诊断） */
static volatile LONG g_mseRelWhy;              /* 末次解除原因 1..5（见解除处 whyTxt） */

#define CS_PERIOD_MS 4          /* 250Hz：喂得满 100Hz 的笔，CPU 开销可忽略 */

static DWORD WINAPI cursamp_thread(LPVOID param)
{
    (void)param;
    while (!g_csStop) {
        if (g_riHidN > 0 || g_riAbsN > 0) {     /* 真源有数据 ⇒ 让位 */
            Sleep(50);
            continue;
        }
        POINT c; c.x = 0; c.y = 0;
        if (se_real_GetCursorPos(&c)) {
            DWORD now = GetTickCount();
            if (InterlockedExchange(&g_riSrc, 3) != 3)
                logf("# [raw] 采样源切到 **系统光标**（Raw Input 两轮零输入 ⇒ 弃用），"
                     "光标坐标直接进配对环\n");
            InterlockedIncrement(&g_csN);
            /* —— tip（笔是否按着）：决定合成包的压力与 buttons ——
               ⛔ 直接用 g_penDown 会在长断流（>5s）后失效 —— 那时它已被
                  `[pen] 落笔锁存超时` 清零，而补流恰恰只在长断流时才需要。
                  回退顺序：当前值 → 最后一次真实包的落笔态 → 最近补流过（会话自持）。
                  见 g_lastRealTip 处的长注释（含「抬笔后继续补流为何无害」的论证）。
               ⛔⛔ 0x0126：**「没有真实证据就不得断言落笔」**。旧版这条回退链没有任何
                  时间上限 ⇒ 若用户在**断流期间**抬笔（没有真实包来告诉 0），合成包会
                  一直宣称 tip=1 ⇒ 我方自身判据被自己喂成「落笔」，HUD 在悬空时
                  冒出几秒才消失（用户 0x0125 验收的第 3 条新 BUG）。
                  ⇒ 所有推断最远只到「最后一批真实包 + CONTACT_HOLD_SMOOTH_MS」。 */
            LONG realAge = g_lastRealMs ? (LONG)(now - (DWORD)g_lastRealMs) : 0x7FFFFFFF;
            int tip = 0;
            /* ⛔ 0x012B：窗口用 SYNTH_TIP_MAX_MS（6s），不是接触判据的 1500ms。
               见常量处：1500ms 会让 2.4~4.0s 的运笔期停摆在半途失去「笔还落着」的
               断言 ⇒ 补发停 ⇒ PS 不重绘 ⇒ 线冻住。 */
            if (realAge <= SYNTH_TIP_MAX_MS) {
                tip = (int)g_penDown;
                if (!tip && g_lastRealTip == 1) tip = 1;
            }

            /* ⛔⛔ 0x012D：断流期落笔推断（包外证据：笔尖 → 左键**消息**）。
               完整理由见常量段（SYNTH_TIP_MAX_MS 之后）。一句话：空档在「笔抬着」
               时开始时，上面那条 tip 链永远是 0 ⇒ 用户按下笔尖也画不出来。
               ⛔ 只加不减：本段只会把 tip 从 0 抬到 1，绝不否决包证据
                 （否决 = 0x012B 第三道守卫的老路，已被 6468 判死）。 */
            {
                static int   s_dnPrev, s_upPrev;   /* 上次看到的累计次数（边沿检测） */
                static int   s_hold;               /* 1 = 推断落笔中 */
                static DWORD s_downMs;             /* 本次按下的时刻 */
                static DWORD s_lastDownMs;         /* 最近一次按下的时刻（含"未武装"的那些） */
                static DWORD s_liveMs;             /* 光标最后移动的时刻 */
                static POINT s_prevC; static int s_haveC;
                int mDown = 0, mDn = 0, mUp = 0, mx = 0, my = 0;
                int mOk = keyhook_mouse_state(&mDown, &mx, &my, NULL, &mDn, &mUp);
                int newDown = (mOk && mDown && mDn != s_dnPrev);
                int newUp   = (mOk && !mDown && mUp != s_upPrev);
                int moved = 1;
                if (s_haveC) {
                    int dx = c.x > s_prevC.x ? c.x - s_prevC.x : s_prevC.x - c.x;
                    int dy = c.y > s_prevC.y ? c.y - s_prevC.y : s_prevC.y - c.y;
                    moved = ((dx + dy) >= 2);
                }
                s_prevC = c; s_haveC = 1;
                if (moved) s_liveMs = now;
                s_dnPrev = mDn; s_upPrev = mUp;
                if (newDown) s_lastDownMs = now;   /* 任何一次按下都记账 */

                if (realAge > RI_STALL_MS) {
                    /* ⛔ 为什么要「回看 600ms」：按下的时刻可能只比空档判据早一点点
                       （空档门槛 250ms 是**滞后**判据）。只认「此刻正好按下」的话，
                       "笔刚落纸、驱动就死"这种最常见的形态会被整段漏掉。 */
                    int arm = (!s_hold && g_canvasHitDbg && s_lastDownMs
                               && (DWORD)(now - s_lastDownMs) <= MSE_ARM_LOOKBACK_MS);
                    if (arm) {
                        InterlockedIncrement(&g_mseArms);
                        s_hold = 1;
                        s_downMs = s_lastDownMs ? s_lastDownMs : now;
                        s_liveMs = now;
                        InterlockedExchange(&g_mseTip, 1);
                        logf("# [mse] ★断流期落笔推断·武装：左键按下 (%d,%d) 在画布内"
                             "（真实通路已静默 %ldms；按下于 %lums 前；此前 tip=%d）\n",
                             mx, my, (long)realAge,
                             (unsigned long)(now - s_downMs), tip);
                    } else if (s_hold) {
                        LONG why = 0;
                        if (newUp && (DWORD)(now - s_downMs) >= MSE_MIN_DOWN_MS) why = 1;
                        else if (!g_canvasHitDbg)                         why = 2;
                        else if ((DWORD)(now - s_liveMs) > MSE_IDLE_MS)    why = 3;
                        else if ((DWORD)(now - s_downMs) > MSE_HOLD_MAX_MS) why = 4;
                        if (why) {
                            static const char* whyTxt[] = { "",
                                "见到抬起事件", "光标离开画布", "停手(光标静止)", "到达硬上限" };
                            s_hold = 0;
                            InterlockedExchange(&g_mseTip, 0);
                            InterlockedExchange(&g_mseRelWhy, why);
                            InterlockedIncrement(&g_mseRels);
                            logf("# [mse] 断流期落笔推断·解除：%s（本次按下 %lums）\n",
                                 whyTxt[why], (unsigned long)(now - s_downMs));
                        }
                    }
                    if (s_hold) tip = 1;

                    /* ⛔⛔ 0x0137：**长停摆续命**（>SYNTH_TIP_MAX_MS）。
                       旧版的 tip 链最长只撑 6s（0x012B 为了让「悬空挥手」不画幽灵线而设），
                       于是**任何超过 6 秒的停摆都必然冻住**：合成包的 buttons 只能写 0，
                       PS 收到包却当成悬停 ⇒ 只挪光标不落笔 ⇒ 用户看到的正是「线断了、
                       平滑失效」。本场 jwwh-13664 的 32 次停摆里有 5 次 >5.5s（最长 54.6s），
                       覆盖了 145s 停摆时间的绝大部分 ⇒ 这是「失效概率高」的第一原因。
                       判据只用**包外证据**（与 0x012D 同源、同样「只加不减」）：
                         · 左键电平为按下（我方 WH_MOUSE_LL 镜像的累积电平，或系统电平）；
                         · 光标仍在活动文档画布内；
                         · 光标 1.5s 内动过（静止 = 停手，不许悬空描边）。
                       ⛔ 三条同时成立才抬 tip；任一条不成立立刻回落到旧行为。 */
                    if (!tip && realAge > SYNTH_TIP_MAX_MS && g_canvasHitDbg
                        && (mDown || (GetAsyncKeyState(VK_LBUTTON) & 0x8000))
                        && (DWORD)(now - s_liveMs) <= 1500) {
                        static DWORD s_keepMs;
                        tip = 1;
                        if ((DWORD)(now - s_keepMs) >= 5000) {
                            s_keepMs = now;
                            logf("# [mse] ★长停摆续命：真实通路已静默 %ldms，"
                                 "左键电平仍按下且光标在画布内移动 ⇒ tip=1（否则 PS 只挪光标不落笔）\n",
                                 (long)realAge);
                        }
                    }
                } else if (s_hold) {
                    s_hold = 0;
                    InterlockedExchange(&g_mseTip, 0);
                    InterlockedExchange(&g_mseRelWhy, 5);
                    logf("# [mse] 断流期落笔推断·解除：真实包已回来，判据交还包流\n");
                }
            }
            /* ⛔⛔ 0x012E：断流期改成「**喂入冻结**」，而不是「停止唤醒」。
               0x012B/0x012C 把「光标离开画布」接成了**停发**（cv 守卫）。jwwh-2200
               实测这个接法把整段停摆判死：`[dead] 持续中 ... 补发=30/43/44/46
               pre=(tip1/syn1/hw1/cv0/…)`，同一窗口里合成包一路涨到 1356 包，而 PS
               取包次从 1200/s 崩到 ~60/s ⇒ 消息驱动循环下线 ⇒ 线冻住、只能 reload。
               ⇒ 改为：光标离开画布时只**钉住喂入位置**（最后一个画布内点），唤醒照旧。
                 位置钉住 ⇒ 画不出幽灵线（不会从画布边界往外拉）；
                 唤醒不断 ⇒ PS 的取包/重绘循环不倒，笔一回到画布就立刻接着画。 */
            {
                int frozen = (tip && realAge > RI_STALL_MS && !g_canvasHitDbg && s_csGoodOk);
                if (frozen) {
                    ri_push(now, s_csGoodX, s_csGoodY, 0, tip, 1);
                } else {
                    ri_push(now, (int)c.x, (int)c.y, 0, tip, 1);
                    if (g_canvasHitDbg) {
                        s_csGoodX = (int)c.x; s_csGoodY = (int)c.y; s_csGoodOk = 1;
                    }
                }
                if (frozen != (int)g_csFrozen) {
                    InterlockedExchange(&g_csFrozen, (LONG)frozen);
                    if (frozen)
                        logf("# [post] 喂入冻结：光标离开活动文档画布 ⇒ 位置钉在(%d,%d)"
                             "（唤醒照旧，等笔回到画布）\n", s_csGoodX, s_csGoodY);
                    else
                        logf("# [post] 喂入解冻：恢复跟随真实光标\n");
                }
            }

            /* 🩺 0x012B 诊断：笔尖 = Windows 左键？只观测，不参与任何决策。 */
            {
                static LONG s_prevBtn;
                LONG b = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) ? 1 : 0;
                if (b && !s_prevBtn) InterlockedIncrement(&g_csBtnOn);
                s_prevBtn = b;
                InterlockedExchange(&g_csBtn, b);
            }

            /* ⛔ 0x0128：补流期间代为投递 WT_PACKET，把消息驱动的 PS 叫醒。
               ⛔ 只在「我方认为笔仍落着」（tip=1，见上）时才补 —— 悬空挥手时不投，
                  否则会诱发幽灵笔画。⛔ 每 2 拍至少投一次（DS 线程 250Hz，够密）。
                ⛔ PostMessage 只在**本线程**调用：detour 内仍然零系统调用。
               ⛔⛔ 0x012B 两道防幽灵守卫（缺一不可）：
                 ① `g_canvasOkDbg` —— 光标必须仍在**活动文档画布的矩形内**。用户抬笔后
                    去点面板/菜单/标题栏时这一项立刻为 0 ⇒ 停发（否则幽灵线会画到画布
                    边缘后继续延伸，把选区搞脏）。
                 ② **光标必须真的动过**（与上一次投递时的坐标不同）。静止 = 没有新笔画
                    可画；「抬笔就停住」是最常见的放弃形态，这一条把窗口从「整个 6s」
                    收窄到「抬笔后仍在移动的那一段」。
                 ③ ⛔⛔ 0x012C **删掉**了原第三道守卫（「VK_LBUTTON 已证明可用且当前
                    抬起 ⇒ 停发」）：jwwh-6468 实证它是致命的 —— `on` 从 0 涨到 36
                    （≈起笔次数，笔尖**确实**映射成左键），但 `btn` 的电平在笔明确仍
                    按着（tip=1/penDown=1）时成段读 0 ⇒ 断流期每一拍都被它判成「已抬笔」
                    ⇒ 补发恒 0（本场全程 `补发=0`，五段停摆一次也没补过）。
                    结论：**左键电平不能当「笔还在纸上」的证据**（Wintab 独占时笔尖走
                    Wintab 按钮、鼠标模拟的按下态并不保持）；`on` 边沿可靠、电平不可靠。
                ⛔ 窗口本身（6s）由 tip 的 realAge 控制；守卫是与它独立的必要条件。
               ⛔ 0x012C 补发目标：`g_ctxHwnd`（WTOpenW 收到的窗口）→ 空则退 `s_psFrame`
                  （PS 主框，焦点门已实测解析过）。并打一行 `[post] 首包代投` 记录目标
                  与 PostMessageW 的返回值/errno —— 本场无法从日志判断 g_ctxHwnd 是否为空，
                  下一轮用这一行定案。
               ⛔⛔ 0x012E 改口径（jwwh-2200 判死旧口径）：
                  · 旧 ①「cv=0 ⇒ 停发」：光标一旦离开画布就整段不投（本场 `补发=46`
                    冻死，PS 取包 1200/s → 60/s）。⇒ 改成**喂入冻结 + 照旧投**
                    （见上方喂入段），这里只需 `(cv || 有钉住点)` 即放行。
                  · 旧 ②「光标必须动过 ⇒ 才投」：**这是最致命的**。用户看到线不动时会
                    **停住笔等它追上来**，而我们的输出本来就滞后一整根绳（实测平均滞后
                    38px）⇒ 光标静止时恰恰最需要 PS 继续取包才能追上；旧口径却一次也不投。
                    ⇒ 删掉 moved 判据，改为**按拍节流**：喂入侧 250Hz 一直在推进，
                      代投 62Hz；冻结期降到 15Hz（只维持循环不倒，不刷屏幕）。 */
            if (tip && g_synWas && (g_canvasHitDbg || s_csGoodOk)) {
                HWND tgt = g_ctxHwnd ? g_ctxHwnd : s_psFrame;
                if (!tgt) tgt = GetForegroundWindow();
                /* ⛔ 节流到 ~62Hz（本线程 250Hz）：与 PS 空闲轮询的 67 次/s 同量级，
                   不淹它的消息队列（单队列上限 1 万条）。 */
                static int s_tk;
                int every = g_csFrozen ? 16 : 4;
                if ((++s_tk & (every - 1)) == 0) {
                    BOOL okp = PostMessageW(tgt, (UINT)g_ctxMsgBase,
                                            (WPARAM)(UINT_PTR)g_ctxNow,
                                            (LPARAM)(LONG)g_synSerial);
                    /* ⛔ 0x012C 兜底：用备选窗口代投时（g_ctxHwnd 为空 ⇒ 说明我们不知道
                       PS 当初把 lcMsgBase 的收件窗交给 Wintab 的是哪一个），再给该窗口所在
                       线程投一条**线程消息**。标准 GetMessage 循环同样会被它叫醒；线程消息
                       不会被 DispatchMessage 派给任何窗口过程 ⇒ 不产生副作用。只在
                       「主目标不是 g_ctxHwnd」时补，正常路径不加噪音。 */
                    if (!g_ctxHwnd && tgt) {
                        DWORD tidT = GetWindowThreadProcessId(tgt, NULL);
                        if (tidT) PostThreadMessageW(tidT, (UINT)g_ctxMsgBase,
                                                     (WPARAM)(UINT_PTR)g_ctxNow,
                                                     (LPARAM)(LONG)g_synSerial);
                    }
                    InterlockedIncrement(&g_ctxPostN);
                    /* 🩺 首次代投留痕：目标窗口、消息号、返回值。下一轮据此定案
                       「g_ctxHwnd 有没有值」「PS 主框代投能不能把它叫醒」。 */
                    if (InterlockedCompareExchange(&g_csPostLog, 1, 0) == 0) {
                        logf("# [post] ★首个代投: ctxHwnd=%p psFrame=%p 用=%p msg=0x%X "
                             "ret=%ld err=%lu synSerial=%ld\n",
                             (void *)g_ctxHwnd, (void *)s_psFrame, (void *)tgt,
                             (unsigned)g_ctxMsgBase, (long)okp,
                             okp ? 0ul : (unsigned long)GetLastError(),
                             (long)g_synSerial);
                    }
                }
            }
        }
        Sleep(CS_PERIOD_MS);
    }
    return 0;
}

static void cursamp_start(void)
{
    if (g_csThread) {
        DWORD code = 0;
        if (GetExitCodeThread(g_csThread, &code) && code == STILL_ACTIVE) return;
        CloseHandle(g_csThread);
        g_csThread = NULL; g_csTid = 0;
    }
    InterlockedExchange(&g_csStop, 0);
    g_csThread = CreateThread(NULL, 0, cursamp_thread, NULL, 0, &g_csTid);
}

static void cursamp_stop(void)
{
    if (!g_csThread) return;
    InterlockedExchange(&g_csStop, 1);
    WaitForSingleObject(g_csThread, 2000);
    CloseHandle(g_csThread);
    g_csThread = NULL; g_csTid = 0;
}

/* ---------------------------------------------------------------- 配对 / 拟合
 * detour 侧（penraw_maybe_pair）：真实包来了、且 raw 样本新鲜 ⇒ 记一对。
 *   ⛔ 四条过滤缺一不可：
 *     · `RI_PAIR_MAXPKT`：**冲包不配** —— 一次吐回上百个包时它们对应的是同一份
 *       raw 样本，配进去会把拟合按「时间堆积密度」加权，彻底歪掉；
 *     · `RI_PAIR_GAP_MS`：一份 raw 样本只配一次（否则 52Hz 轮询会把 100Hz 的
 *       raw 样本重复计 2 次）；
 *     · 只用**最新一包**：一批里的旧包在时间上离 raw 样本更远；
 *     · `RI_PAIR_MAX_AGE`（0x0119）：**停摆恢复的冲包不配** —— 旧坐标与当前
 *       光标样本错位整段停摆时长，进环即把拟合/解析残差撑爆（补流武装被
 *       自己的恢复冲包打死），依据见 penraw_maybe_pair 内注释。
 * worker 侧（penraw_fit_tick）：对环内全部配对做逐轴最小二乘。 */
static void penraw_maybe_pair(const u8* buf, int r, DWORD now)
{
    if (r <= 0 || r > RI_PAIR_MAXPKT) return;
    if (!g_calib.valid || g_calib.offX < 0 || g_calib.offY < 0 || g_calib.stride <= 0) return;
    if (g_calib.stride > (int)sizeof(g_tpl)) return;
    LONG rawMs = g_riLastMs;
    if (!rawMs) return;
    LONG age = (LONG)(now - (DWORD)rawMs);
    if (age < 0 || age > RI_PAIR_GAP_MS) return;
    if (!g_riIn) return;                          /* 笔离开范围：位置无意义 */
    LONG ps = g_pairMs;
    if (ps && (LONG)(now - (DWORD)ps) >= 0 && (LONG)(now - (DWORD)ps) < RI_PAIR_GAP_MS) return;
    InterlockedExchange(&g_pairMs, (LONG)now);

    const u8* p = buf + (SIZE_T)(r - 1) * g_calib.stride;
    /* ⛔⛔ 0x0119：停摆恢复的冲包（旧坐标）**不进配对环**。真机 jwwh-32560：
       17:49:48.66 恢复时驱动一次吐 19 包停摆期攒的旧坐标，[dead] 行的「陈旧
       回包合并」因为 RI_PKT_STALE_MS=1500 > 停摆 1.3s 而一个都没丢 ⇒ 旧包
       与当前光标样本错位整段停摆时长 ⇒ 解析残差当场从 42 飙到 128、17:51:52
       更是 172/411 ⇒ 拟合/解析双双失效 ⇒ 补流武装被自己的恢复冲包打死
       （真停摆来时反而没有补流）。配对语义要比「给 PS 的丢包」更严：正常
       包龄实测 15~16ms，400ms 必是停摆余波。offTime 未标定（pt=0）⇒ 放行。 */
    if (g_calib.offTime >= 0 && g_calib.offTime + 4 <= g_calib.stride) {
        u32 pt = 0;
        memcpy(&pt, p + g_calib.offTime, 4);
        if (pt) {
            LONG pkAge = (LONG)(now - pt);
            if (pkAge < 0 || pkAge > RI_PAIR_MAX_AGE) return;
        }
    }
    /* 合成包底本：原样留最后一包（所有不认识的字段都跟着合法） */
    memcpy(g_tpl, p, g_calib.stride);
    InterlockedExchange(&g_tplOk, 1);

    int wx = 0, wy = 0;
    memcpy(&wx, p + g_calib.offX, 4);
    memcpy(&wy, p + g_calib.offY, 4);
    LONG h = g_pairHead;
    RIP_pair* q = &g_pair[(u32)h & (RIPAIR_N - 1)];
    q->rx = g_riX; q->ry = g_riY; q->wx = wx; q->wy = wy;
    InterlockedIncrement(&g_pairHead);
}

/** 单次最小二乘（keep==NULL 时用全部点）。返回参与拟合的点数，0 = 退化。 */
static int rifit_pass(LONG start, LONG n, const u8* keep,
                      double* ax, double* bx, double* rmsX,
                      double* ay, double* by, double* rmsY)
{
    double N = 0, srx = 0, srxx = 0, swx = 0, srxwx = 0;
    double sry = 0, sryy = 0, swy = 0, srywy = 0;
    for (LONG i = 0; i < n; i++) {
        if (keep && !keep[i]) continue;
        const RIP_pair* q = &g_pair[(u32)(start + i) & (RIPAIR_N - 1)];
        double rx = (double)q->rx, ry = (double)q->ry;
        double wx = (double)q->wx, wy = (double)q->wy;
        N += 1.0;
        srx += rx; srxx += rx * rx; swx += wx; srxwx += rx * wx;
        sry += ry; sryy += ry * ry; swy += wy; srywy += ry * wy;
    }
    if (N < 8.0) return 0;
    double dX = N * srxx - srx * srx;
    double dY = N * sryy - sry * sry;
    if (dX <= 0.0 || dY <= 0.0) return 0;
    *ax = (N * srxwx - srx * swx) / dX;
    *bx = (swx - *ax * srx) / N;
    *ay = (N * srywy - sry * swy) / dY;
    *by = (swy - *ay * sry) / N;
    double ex = 0, ey = 0;
    for (LONG i = 0; i < n; i++) {
        if (keep && !keep[i]) continue;
        const RIP_pair* q = &g_pair[(u32)(start + i) & (RIPAIR_N - 1)];
        double dx = *ax * (double)q->rx + *bx - (double)q->wx;
        double dy = *ay * (double)q->ry + *by - (double)q->wy;
        ex += dx * dx; ey += dy * dy;
    }
    *rmsX = dsqrt_(ex / N);
    *rmsY = dsqrt_(ey / N);
    return (int)N;
}

/* —— 门控总闸的**统一**发布点 ——
   原先 `g_synOn` 散落在 penraw_fit_tick 的 4 个 return 上各写一次；新增解析映射
   后必须两处（强拟合 / 解析兜底）取或 ⇒ 集中到这里，避免以后加第三条来源漏改。 */
static void syn_set(void)
{
    InterlockedExchange(&g_synOn, (g_fit.valid || g_anaOk) ? 1 : 0);
}

/** 取解析映射的自洽快照（detour 侧）。1 = 拿到；0 = 不可用 / 正在被改写。 */
static int ana_get(double* ax, double* bx, double* ay, double* by)
{
    if (!g_anaOk) return 0;
    LONG v1 = g_anaVer;
    if (v1 & 1) return 0;
    double a1 = g_anaCoef[0], b1 = g_anaCoef[1];
    double a2 = g_anaCoef[2], b2 = g_anaCoef[3];
    LONG v2 = g_anaVer;
    if (v1 != v2 || (v2 & 1)) return 0;
    *ax = a1; *bx = b1; *ay = a2; *by = b2;
    return 1;
}

/**
 * 由「解析映射」决定补流是否可放行 —— 强拟合的**兜底**（见 ANAMAP 注释）。
 * ⛔ 只需四样，**全都不依赖配对规模**：
 *    ① 标定成立（拿到 stride / offX / offY）；② px 权威来自驱动（`g_pxSrc==1`）；
 *    ③ 两轴符号**已实测投票**（驱动报的 Y 符号不可信 ⇒ 绝不能直接采信它的符号，
 *       见 px_x/px_y 注释）；④ 至少一对配对（用来定原点）。
 * ⛔ 核对（配对 ≥16 时）：用解析系数算最近 64 对的逐轴 rms，超 `RI_ANA_MAX_RMS`
 *    即判映射错、**不启用**。这拦得住「错轴 / 错比例 / 错符号」；而「点数够但
 *    跨度不够」（短笔划）恰恰是解析映射**最该**顶上的场景 —— 映射是全局的，
 *    本来就不需要跨度。
 * ⛔ 点数太少（<16）时无从核对 ⇒ 不核对直接启用：此时方向与量级来自驱动权威
 *    （与 g_tpl 同源），符合既有「宁可不平滑，也绝不写坏数据」的取舍 —— 写坏的
 *    前提是映射错，而这里的映射两个来源都不是凭空的。
 */
static void ana_update(void)
{
    int wasOk = g_anaOk;        /* 0x0120 滞回：已启用时放宽复验上限（RI_ANA_OFF_RMS） */
    InterlockedExchange(&g_anaOk, 0);
    g_ana.nPair = 0; g_ana.nCheck = 0; g_ana.rmsX = g_ana.rmsY = 0.0;
    if (!g_calib.valid || !g_tplOk) return;
    if (g_pxSrc != 1) return;
    if (g_axCalX.voteStreak < SIGN_VOTE || g_axCalY.voteStreak < SIGN_VOTE) return;
    double px = px_x(), py = px_y();
    if (!(px > 1e-9 || px < -1e-9)) return;
    if (!(py > 1e-9 || py < -1e-9)) return;
    double ax = 1.0 / px, ay = 1.0 / py;         /* 屏幕 → 平板 */
    LONG h = g_pairHead;
    if (h <= 0) return;                          /* 一对都没有 ⇒ 无从定原点 */
    const RIP_pair* q = &g_pair[(u32)(h - 1) & (RIPAIR_N - 1)];
    double bx = (double)q->wx - ax * (double)q->rx;
    double by = (double)q->wy - ay * (double)q->ry;
    g_ana.nPair = (int)h;

    LONG n = h > 64 ? 64 : h;
    if (n >= 16) {
        double ex = 0, ey = 0;
        for (LONG i = 0; i < n; i++) {
            const RIP_pair* p = &g_pair[(u32)(h - 1 - i) & (RIPAIR_N - 1)];
            double dx = ax * (double)p->rx + bx - (double)p->wx;
            double dy = ay * (double)p->ry + by - (double)p->wy;
            ex += dx * dx; ey += dy * dy;
        }
        g_ana.rmsX = dsqrt_(ex / (double)n);
        g_ana.rmsY = dsqrt_(ey / (double)n);
        g_ana.nCheck = (int)n;
        /* 0x0120 滞回（0x0129：准入 48→96、保持 96→160，依据见 RI_ANA_MAX_RMS 处）：
           未启用 ⇒ 96 才准启用；已启用 ⇒ 160 才算失效。 */
        LONG limRms = wasOk ? (LONG)RI_ANA_OFF_RMS : (LONG)RI_ANA_MAX_RMS;
        if (g_ana.rmsX > limRms || g_ana.rmsY > limRms) return;
    }

    g_ana.ax = ax; g_ana.bx = bx; g_ana.ay = ay; g_ana.by = by;
    InterlockedIncrement(&g_anaVer);             /* → 奇（写入中） */
    g_anaCoef[0] = ax; g_anaCoef[1] = bx;
    g_anaCoef[2] = ay; g_anaCoef[3] = by;
    InterlockedIncrement(&g_anaVer);             /* → 偶（稳定） */
    InterlockedExchange(&g_anaOk, 1);
    if (!g_anaLogged) {
        g_anaLogged = 1;
        logf("# [raw] ★解析映射就绪（驱动 px 定比例 + %d 对配对定原点）"
             " ax=%.6f bx=%.0f ay=%.6f by=%.0f 核对=%d对 rms=%.1f/%.1f\n",
             (int)h, ax, bx, ay, by, g_ana.nCheck, g_ana.rmsX, g_ana.rmsY);
    }
}

/**
 * 由配对环拟合「raw → 平板坐标」的逐轴仿射映射，并裁决是否放行补流。
 *
 * ⛔⛔ 为什么必须是**两趟**（这是本模块最容易做错的一处）：
 *   配对的 raw 坐标与平板坐标**取自不同时刻**（两份数据各有自己的采样节拍，
 *   窗口内可差到 `RI_PAIR_GAP_MS`）。运笔越快，这个时间错位折算成的位置差越大
 *   （1000px/s 下 10ms ≈ 160 个平板单位）。也就是说**残差里天然混着运动噪声**，
 *   一趟最小二乘的 rms 会被它撑到几百单位 ⇒ 拿一个「绝对很小」的阈值去卡，
 *   正确的映射也会被误判为失败（本模块就永远不激活）。
 *   所以：第一趟出粗略映射 → 按**绝对残差门限** `RI_FIT_OUT_KEEP` 剔掉离群
 *   （远动期间那部分配对）→ 第二趟只用保留集重拟合，并对**保留集**的 rms 下狠手
 *   （`RI_FIT_MAX_RMS` = 48 单位 = 3px，0x0119 从 0.5px 放宽，依据见常量处注释：
 *   运笔时间错位本身就有 1~2px，0.5px 永远达不到）。
 *
 * 这个判据为什么仍然决定性：**映射整体错**（错轴、错比例、错符号）时，残差是
 * 几百到几万个单位 ⇒ 保留集几乎为空 ⇒ 直接判失败。只有「确实对上了」才可能留下
 * 一批残差 <6px 的点。
 */
static void penraw_fit_tick(void)
{
    static u8 keep[RIPAIR_N];
    LONG h = g_pairHead;
    LONG start = h - (LONG)RIPAIR_N;
    if (start < 0) start = 0;
    LONG n = h - start;
    if (n > (LONG)RIPAIR_N) n = (LONG)RIPAIR_N;
    g_fit.nAll = (int)(n < 0 ? 0 : n);
    if (n < RI_FIT_MIN_N) {
        g_fit.valid = 0; g_fit.n = 0; syn_set(); g_fit.spanX = g_fit.spanY = 0;
        return;
    }

    double ax, bx, ay, by, rx_, ry_;
    if (!rifit_pass(start, n, NULL, &ax, &bx, &rx_, &ay, &by, &ry_)) {
        g_fit.valid = 0; g_fit.n = 0; syn_set(); return;
    }

    /* 第一趟 → 按绝对残差门限做稳健剔除 */
    int nk = 0;
    for (LONG i = 0; i < n; i++) {
        const RIP_pair* q = &g_pair[(u32)(start + i) & (RIPAIR_N - 1)];
        double dx = ax * (double)q->rx + bx - (double)q->wx;
        double dy = ay * (double)q->ry + by - (double)q->wy;
        if (dx < 0) dx = -dx;
        if (dy < 0) dy = -dy;
        keep[i] = (dx <= RI_FIT_OUT_KEEP && dy <= RI_FIT_OUT_KEEP) ? 1 : 0;
        if (keep[i]) nk++;
    }
    if (nk < RI_FIT_MIN_N) {
        g_fit.valid = 0; g_fit.n = nk; syn_set(); return;
    }

    /* 第二趟：只用保留集 */
    int kn = rifit_pass(start, n, keep, &g_fit.ax, &g_fit.bx, &g_fit.rmsX,
                        &g_fit.ay, &g_fit.by, &g_fit.rmsY);
    if (!kn) { g_fit.valid = 0; g_fit.n = 0; g_synOn = 0; return; }
    g_fit.n = kn;

    /* 保留集的 raw 跨度：点全挤在一处时最小二乘的斜率是病态的 */
    LONG x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (LONG i = 0; i < n; i++) {
        if (!keep[i]) continue;
        const RIP_pair* q = &g_pair[(u32)(start + i) & (RIPAIR_N - 1)];
        if (!x0 && !x1) { x0 = x1 = q->rx; y0 = y1 = q->ry; }
        if (q->rx < x0) x0 = q->rx; if (q->rx > x1) x1 = q->rx;
        if (q->ry < y0) y0 = q->ry; if (q->ry > y1) y1 = q->ry;
    }
    g_fit.spanX = (int)(x1 - x0);
    g_fit.spanY = (int)(y1 - y0);

    /* ⛔ 有效性的**唯一**判据：保留集够多 + 残差够小 + 跨度够宽。 */
    g_fit.valid = (kn >= RI_FIT_MIN_N
                   && g_fit.rmsX <= RI_FIT_MAX_RMS && g_fit.rmsY <= RI_FIT_MAX_RMS
                   && g_fit.spanX >= RI_FIT_MIN_SPAN && g_fit.spanY >= RI_FIT_MIN_SPAN
                   && g_calib.valid && g_calib.stride > 0) ? 1 : 0;
    syn_set();
}

/* ------------------------------------------------------------- 合成补流（门控）
 * 只有在「映射可用（强拟合 ∨ 解析兜底）+ 真实通路空转 + raw 新鲜 + 笔在范围内」
 * 时才被 detour 调到。返回真正写进调用方缓冲的包数（0 = 没写，调用方维持原返回值）。 */
#define RI_FIELD_OK(o) ((o) >= 0 && (o) + 4 <= stride)

static int penraw_synth(void* buf, int maxPkts, DWORD now)
{
    if (!g_tplOk || maxPkts <= 0) return 0;   /* 0x0120：映射可用性下沉到取系数处（含 hold 兜底） */
    int stride = g_calib.stride;
    if (stride <= 0 || stride > (int)sizeof(g_tpl)) return 0;
    if (!RI_FIELD_OK(g_calib.offX) || !RI_FIELD_OK(g_calib.offY)) return 0;

    /* ⛔ 系数来源：强拟合优先，其次解析映射（见 ANAMAP 注释）。
       ⛔⛔ 0x0120：两路 live 全灭时退到「最后可用映射」快照 —— 接管中途 worker
          复验把 g_synOn 抖掉，不应拆掉正在救场的补流（断流期配对环冻结，
          复验恒失败 ⇒ 不兜底就永远喂不出包）。快照在任一 live 来源可用时
          刷新，错映射残差是几百到几万，进不了快照。 */
    double cax, cbx, cay, cby;
    int liveMap = 0;
    if (g_fit.valid) { cax = g_fit.ax; cbx = g_fit.bx; cay = g_fit.ay; cby = g_fit.by; liveMap = 1; }
    else if (ana_get(&cax, &cbx, &cay, &cby)) liveMap = 1;
    if (liveMap) {
        g_holdAx = cax; g_holdBx = cbx; g_holdAy = cay; g_holdBy = cby;
        InterlockedExchange(&g_holdOk, 1);
    } else if (g_holdOk) {
        cax = g_holdAx; cbx = g_holdBx; cay = g_holdAy; cby = g_holdBy;
    } else return 0;

    LONG head = g_riHead;
    LONG last = g_synHead;
    if (!last) { InterlockedExchange(&g_synHead, head); return 0; }  /* 首次：从当前起，不补历史 */
    if (head - last <= 0) return 0;
    if (head - last > (LONG)RIPSZ) last = head - (LONG)RIPSZ;       /* 落后太多：丢掉旧的 */

    LONG pmax = g_riPMax;
    int  k = 0;
    LONG ft = 0;                                  /* 本次喂出去的最新样本时刻（补流前沿） */
    for (LONG s = last; s < head && k < maxPkts; s++) {
        const RIPS* rp = &g_riRing[(u32)s & (RIPSZ - 1)];
        if ((LONG)(now - rp->t) > RI_RAW_MAXAGE) continue;           /* 太旧：跳过并推进序号 */
        int wx = (int)(cax * (double)rp->x + cbx + 0.5);
        int wy = (int)(cay * (double)rp->y + cby + 0.5);
        if (wx < 0) wx = 0;
        if (wy < 0) wy = 0;
        if (g_calib.axisMax  && (u32)wx > g_calib.axisMax)  wx = (int)g_calib.axisMax;
        if (g_calib.axisMaxY && (u32)wy > g_calib.axisMaxY) wy = (int)g_calib.axisMaxY;

        u8* d = (u8*)buf + (SIZE_T)k * stride;
        memcpy(d, g_tpl, stride);                   /* 底本：未知字段全部保持合法 */
        if (RI_FIELD_OK(g_calib.offTime)) {
            u32 v = (u32)rp->t; memcpy(d + g_calib.offTime, &v, 4);
        }
        if (RI_FIELD_OK(g_calib.offChanged)) {
            /* ⛔⛔ 0x0126：**不能再写 0**。pkChanged（wintab.h 的 PACKET.pkChanged）语义是
               「本包相对上一包变了哪些字段」，写 0 等于告诉读包方「什么都没变」。
               真机 jwwh-2024 铁证（0x0125 首场）：
                 · 停摆期我方每拍都返回合成包，`补流` 计数照涨；
                 · 但 PS 的取包速率从 绘画中的 2472 次/2s **掉到 162 次/2s**
                   （= 空闲速率）⇒ PS 退出了绘制循环、根本没在画；
                 · 真实包一回来立刻回到 2550 次/2s。
               而 smooth_packets 改写真包的 x/y 时**不动** pkChanged（保留驱动的非零值），
               平滑一直有效 —— 两者唯一的差别就是这个字段。
               ⇒ 底本值 OR 上我们真正改过的那几位（按钮/时间/序号/X/Y/法向压）。
               底本若本来就是 0（个别驱动不填），退到「全变化」掩码。 */
            u32 v = 0;
            memcpy(&v, d + g_calib.offChanged, 4);   /* d 里已是底本 */
            v |= 0x000005D4u;                        /* PK_TIME|PK_SERIAL_NUMBER|PK_BUTTONS
                                                        |PK_X|PK_Y|PK_NORMAL_PRESSURE */
            if (!v) v = 0x00001FFCu;
            memcpy(d + g_calib.offChanged, &v, 4);
        }
        if (RI_FIELD_OK(g_calib.offSerial)) {
            /* ⛔⛔ 0x0127：**序号必须接在驱动后面连续 +1**，不能自己从 0 起算。
               标定本身就用「序号逐包 +1」当硬判据（见 try_calibrate ③）⇒ 真实包的
               pkSerialNumber 是严格递增且步长 1 的。旧版合成包用我们自己的计数器
               （从 1 开始），在 PS 眼里就是「序号倒退了十几万」——若 PS 按序号判重/
               判新（这是 Wintab 里该字段唯一的用途），整批合成包会被直接丢弃，
               而那正好解释了「我方每拍都返回、PS 取包速率却掉到空闲」。
               现在：每次先跟上底本（= 最后一批真实包）的序号，再 +1。 */
            u32 tser = 0;
            memcpy(&tser, g_tpl + g_calib.offSerial, 4);
            if ((LONG)(tser - (u32)g_synSerial) > 0) InterlockedExchange(&g_synSerial, (LONG)tser);
            u32 v = (u32)InterlockedIncrement(&g_synSerial);
            memcpy(d + g_calib.offSerial, &v, 4);
        }
        if (RI_FIELD_OK(g_calib.offBtn)) {
            u32 v = rp->tip ? 1u : 0u; memcpy(d + g_calib.offBtn, &v, 4);
        }
        { u32 v = (u32)wx; memcpy(d + g_calib.offX, &v, 4); }
        { u32 v = (u32)wy; memcpy(d + g_calib.offY, &v, 4); }
        if (RI_FIELD_OK(g_calib.offNP)) {
            /* ⛔ 落笔判据以「非零」为凭 ⇒ 落笔时必须给非零压力，否则合成包会被
               当成悬空、闸门关闭、补流白做。 */
            u32 v = 0;
            if (rp->tip) {
                if (pmax > 0 && rp->p > 0) v = (u32)((double)rp->p * 2047.0 / (double)pmax);
                if (v == 0) v = 1023u;
            }
            if (v > 2047u) v = 2047u;
            memcpy(d + g_calib.offNP, &v, 4);
        }
        if (RI_FIELD_OK(g_calib.offTP)) {
            u32 v = 0; memcpy(d + g_calib.offTP, &v, 4);
        }
        ft = (LONG)rp->t;
        k++;
    }
    if (ft) InterlockedExchange(&g_synFrontT, ft);
    InterlockedExchange(&g_synHead, head);
    return k;
}

/** worker 每 2s 落一行：raw 见到什么、拟合成不成、补流做了多少。 */
static void penraw_report(int win)
{
    static LONG s_hid, s_abs, s_bad, s_cur;
    static int  s_printed;
    LONG hid = g_riHidN, abs = g_riAbsN, bad = g_riBadN, cur = g_csN;
    LONG dh = hid - s_hid, da = abs - s_abs, db = bad - s_bad, dc = cur - s_cur;
    s_hid = hid; s_abs = abs; s_bad = bad; s_cur = cur;
    if (!s_printed || dh || da || db || dc || g_fit.valid || g_anaOk) {
        s_printed = 1;
        LONG age = g_riLastMs ? (LONG)(GetTickCount() - (DWORD)g_riLastMs) : -1;
        int per = win > 0 ? win : 1;
        logf("# [raw] 注册=0b%ld 窗=%ld HID=%ld(%ld/s) 绝对鼠标=%ld(%ld/s) 光标=%ld(%ld/s) "
             "解析失败=%ld 全部WM_INPUT=%ld(键盘=%ld) "
             "源=%s 最近=%ldms 采样范围 x=%ld..%ld y=%ld..%ld p=0..%ld 现值=(%ld,%ld,p=%ld,tip=%ld,in=%ld) "
             "btn=%ld/on=%ld mse=%ld/arm=%ld/rel=%ld 补发=%ld/frz=%ld "
             "gcp=%ld/rw=%ld/a=%ld gp=%ld/%ld/rej=%ld gmp=%ld ink=%ld/ct=%ld/now=%ld=(%ld,%ld) "
             "| 拟合=%s 配对=%d 保留=%d rms=%.2f/%.2f 跨度=%d/%d a=%.6f/%.6f b=%.0f/%.0f "
             "| 解析=%s(%d对 核对%d 残差%.1f/%.1f) "
             "| 补流=%ld次/%ld包 丢冲包=%ld(末次%ld) "
             "陈旧包=%ld(按龄%ld 末次落后前沿%ldms 时间基=%s)\n",
             (long)g_riReg, (long)g_riWndOk,
             (long)hid, (long)(dh * 1000 / per),
             (long)abs, (long)(da * 1000 / per), (long)cur, (long)(dc * 1000 / per),
             (long)db, (long)g_riAllN, (long)g_riKbdN,
             g_riSrc == 1 ? "HID笔" : (g_riSrc == 2 ? "绝对鼠标" :
                                      (g_riSrc == 3 ? "★系统光标" : "未定")),
             (long)age, (long)g_riXMin, (long)g_riXMax, (long)g_riYMin, (long)g_riYMax,
             (long)g_riPMax,
             (long)g_riX, (long)g_riY, (long)g_riP, (long)g_riTip, (long)g_riIn,
             /* 0x012B：btn = 当前 VK_LBUTTON（笔尖是否被 Windows 当成左键按下），
                on = 本会话 0→1 累计次数（应≈起笔次数；远小于它 ⇒ 笔尖不走鼠标模拟）。 */
             (long)g_csBtn, (long)g_csBtnOn,
             /* 0x012D：mse = 当前是否处于「断流期推断落笔」，arm/rel = 累计武装/解除。 */
             (long)g_mseTip, (long)g_mseArms, (long)g_mseRels,
             /* 0x012E：补发 = 累计代投 WT_PACKET 次数（停摆期必须持续增长）；
                frz = 1 表示喂入位置已被钉住（光标离开画布）。 */
             (long)g_ctxPostN, (long)g_csFrozen,
             /* 0x012F：gcp = user32!GetCursorPos 被调用次数（累计）；rw = 我方改写次数；
                a = 当前是否处于接管态；gmp = GetMessagePos 调用次数（判定 PS 从哪取坐标）。 */
             (long)g_gcpCalls, (long)g_gcpRw, (long)g_gcpArmed,
             /* 0x0138：gp = 光标路径的 贴合次数 / 拖动步数。判据 ——
                **画线时这几项必须一直在涨**；只在断流期涨 = 还在走 0x0137 的老门闩。 */
             (long)g_gpArms, (long)g_gpSteps, (long)g_gpRej, (long)g_gmpCalls,
             /* 0x0136：ink = 本拍之前 Windows Ink 探针命中笔的轮次；ct = 其中接触；
                now = 当前是否接触；后面是 Ink 报的屏幕坐标（⚠️ 与 Wintab 包无关，独立源）。 */
             (long)g_inkHits, (long)g_inkContact, (long)g_inkContactNow,
             (long)g_inkX, (long)g_inkY,
             g_fit.valid ? "★有效" : "未建立", g_fit.nAll, g_fit.n,
             g_fit.rmsX, g_fit.rmsY, g_fit.spanX, g_fit.spanY,
             g_fit.ax, g_fit.ay, g_fit.bx, g_fit.by,
             g_anaOk ? "★可用" : "未建立", g_ana.nPair, g_ana.nCheck,
             g_ana.rmsX, g_ana.rmsY,
             (long)g_synRuns, (long)g_synPkts, (long)g_dropBurst, (long)g_dropLast,
             (long)g_dropStaleN, (long)g_dropStaleAgeN, (long)g_dropStaleMs,
             g_pkBaseOk ? "★同基" : "未证实");
        /* 0x0136：Ink 增量单独一行。判据只有一句 —— **Wintab 包为 0 的那些秒里，
           这里涨不涨**。涨 ⇒ Windows Ink 是断流期的活水源泉（接成第四路）；
           不涨 ⇒ 这条路判死（和 Raw Input 一样），别再指望 API 层解决。 */
        {
            static LONG s_ih = -1, s_ic = -1;
            static int  s_inkEver, s_inkDead;
            LONG ih = g_inkHits, ic = g_inkContact;
            LONG dh = (s_ih < 0) ? 0 : ih - s_ih;
            LONG dc = (s_ic < 0) ? 0 : ic - s_ic;
            if (s_ih < 0) { s_ih = ih; s_ic = ic; }
            if (dh || dc || (!s_inkEver && !s_inkDead && ih == 0)) {
                s_ih = ih; s_ic = ic;
                if (ih > 0) s_inkEver = 1;
                if (!ih && !s_inkEver) s_inkDead = 1;
                logf("# [ink] 命中=%ld(+%ld) 接触=%ld(+%ld) 坐标=(%ld,%ld) now=%ld "
                     "真实包=%ld ⇒ %s\n",
                     (long)ih, (long)dh, (long)ic, (long)dc,
                     (long)g_inkX, (long)g_inkY, (long)g_inkContactNow,
                     (long)g_pkReal,
                     (ih == 0 ? "本场至今 Windows Ink 一次笔都没报（这条路可能也是死的）"
                              : (g_pkReal == 0 && dh > 0
                                 ? "★断流期 Ink 仍在报笔 ⇒ 这就是缺的那一路"
                                 : "Ink 有笔数据（常态）")));
            }
        }
    }
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

/* 0x0131：单次最大包数 / 冲包次数 / 零包次数（声明前移：标定心跳要读 g_pkMax）。 */
static volatile LONG g_pkMax, g_pkBig, g_pkZero;

/* ================================================= 标定取证：队列只读快照（0x0131）
 * ⛔ 为什么需要它（jwwh-39120 根因）：真机上 PS 几乎**一次只取 1 个包**
 *    （`[pk] 最大单次=1/2`，整场上限 2），而标定要「序号逐包 +1」的证据
 *    ——1 个包什么也证不了。旧版因此一个 `[calib]` 都打不出来 ⇒ `state` 恒 0
 *    ⇒ 面板永远「准备中」、HUD 与平滑一起死。**这是构造性死锁，与驱动状态无关。**
 * ⇒ 补一条**只读**取证通道：`WTPacketsPeek` 按规范**不消费**队列，把此刻积压的
 *    包整块复制出来做证据。取到 >=2 个包就够「掩码+盲扫互证」。
 * ⛔ 绝不改用 WTPacketsGet（会真的把包从 PS 手里吃掉 ⇒ PS 少画点）。
 * ⛔ 节流：一包一拍的热路径上不能每次 8KB 拷贝，只在「还没标定」时每 32 拍探一次。
 * ⛔ 缓冲按 8 包 × 1024 字节静态开（真机 stride=52，留 20 倍余量）。 */
#define CALIB_PEEK_N   8
#define CALIB_PEEK_SZ  1024
static u8  s_calPeekBuf[CALIB_PEEK_N * CALIB_PEEK_SZ];
static int calib_peek_batch(HCTX hCtx)
{
    typedef UINT (*PFN_PEEK)(HCTX, int, LPVOID);
    static PFN_PEEK s_pk;
    static int s_tried;
    if (!s_tried) {
        s_tried = 1;
        HMODULE hm = GetModuleHandleA("Wintab32.dll");
        if (hm) s_pk = (PFN_PEEK)(void*)GetProcAddress(hm, "WTPacketsPeek");
    }
    if (!s_pk || !hCtx) return 0;
    UINT n = s_pk(hCtx, CALIB_PEEK_N, s_calPeekBuf);
    if (n < 2 || n > CALIB_PEEK_N) return 0;
    return (int)n;
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
        /* 0x0131 分层取证（⛔ 不要再退回「n>=3 一刀切」，那是 39120 死锁的根因）：
             n>=3 → 老规矩，双证据优先、盲扫可独走；
             n==2 → 也判，但 try_calibrate 内部只认「掩码+盲扫互证」（见 ④′）；
             n<2  → 走**只读**队列快照（WTPacketsPeek，不消费）凑一批证据。
           ⛔ 旧版注释说的「n>=2 一次判死、此后永不重试」风险仍然存在 ⇒
              `tried` 只在 ok 或 attempts>=8 时才置位（那段逻辑没变），
              所以 n==2 判失败只是「这一批不算数」，不会把机会用光。 */
        static DWORD s_calHbMs;
        static LONG  s_calHbN;
        if (n >= 2) {
            try_calibrate(hCtx, buf, n);
        } else {
            int pn = ((++s_calHbN & 31) == 0) ? calib_peek_batch(hCtx) : 0;
            if (pn >= 2) try_calibrate(hCtx, s_calPeekBuf, pn);
            InterlockedExchange(&g_reason, RS_NOCTX);
            /* 取证心跳（2s）：把「等什么样的证据、等到了多少」落盘 ——
               ⛔ 没有这条，标定不成立时日志里**一行 calib 都没有**，
                  只能靠推断（39120 就是这么查了半天的）。 */
            DWORD nowH = GetTickCount();
            if (nowH - s_calHbMs >= 2000) {
                s_calHbMs = nowH;
                calib_logf("# [calib] 等证据 2s: 本批 n=%d peek=%d 最大单次=%ld 累计包=%ld 尝试=%d\n",
                           n, pn, (long)g_pkMax, (long)g_packets, g_calib.attempts);
            }
            return 0;
        }
    }
    if (!g_calib.valid || g_calib.offX < 0 || g_calib.offY < 0) {
        InterlockedExchange(&g_reason, RS_NOCAL);
        /* ⛔⛔ 0x020A：**不裁决就必须显式归零门变量**（旧版只写 reason 就 return）。
           根因：HUD 读的是 g_penDown / g_toolOk / g_strokeGate，它们会**冻结**在
           失效前的 1 上；而 HUD 的 activeNow 只看「包新不新鲜」（pktAge<250）——
           于是包流一恢复的头几帧，HUD 就拿**陈旧几何**画一圈。
           用户报的「填充完选区后挪动光标，HUD 意外短暂闪现」有一条通路正落在这里：
           自动填充/换文档会让 PS 重建 Wintab 上下文 ⇒ 触发重标定窗口 ⇒ 冻结。
           归零的语义也正确：此刻我们根本没在改写，HUD 本来就不该显示。 */
        InterlockedExchange(&g_strokeGate, -1);
        InterlockedExchange(&g_penDown, 0);
        InterlockedExchange(&g_toolOk, 0);
        gate_set(0);
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
     *  ⛔⛔ 0x0207：CFG_I_ENABLED 有**两个**写入方 —— 面板（penSmooth / shutdown）
     *     与 .8li 的**插件本体位闸**（plugin_main.c 的 plug_revoke：18924 上没有
     *     已握手的 UXP 面板客户端 ⇒ 归 0；同时把 I_TOOLGATE 置 2=未知）。
     *     因此本文件里「enabled=1」现在隐含「面板本体在位」，不必再单独判在位；
     *     反过来也**不能**把 enabled 当成「用户的意图」——面板从未加载时它就是 0，
     *     `tool_gate_ok()` 也不再被进程内 'slct' 通知续命（pstool_publish 过位闸）。
     *     这是「没装 UXP 面板，套索平滑却在跑」的根治点，别把它当成冗余判断删掉。
     * ⚠️ 闸门不成立时**仍然刷新快照**：HUD 线程的「轴→像素比」标定靠
     *    g_snOutX/g_snMs，闸门一关就不再更新的话，标定会永远停在初值
     *    （这正是「关掉提示就再也不标定」那个旧 bug 的同构版本）。
     *    快照刷新是普通内存写，且**不改写缓冲区一个字节** ⇒ 迟滞感为零。 */
    /* 0x0209：判据收口到 `tool_edit_allowed()`（工具维度的唯一答案）。
       ⛔ 旧写法是 `if (contactPrev && latched == 1) useGate = ENABLED;`
          —— **整笔持有上一笔的工具裁决**，一笔之中完全不看工具。用户长按笔涂抹时
          左键电平一直为真、面板巡检又被让路挡住 ⇒ 闸门停在切走前的 1 ⇒ 涂抹被当成
          套索一直平滑、HUD 一直显示（BUG1）。现在：
            · 面板**明确报 0**（心跳新鲜）⇒ 立即否决，闩锁也压不住；
            · 心跳**过期** ⇒ 沿用手头结论，不在笔中劈开（否则每 3s 从圆心拉一根直线，BUG2）。
       ⛔ `contactPrev` / `latched` 仍留着只为落盘诊断，不再参与裁决。 */
    LONG contactPrev = g_contact;
    LONG latched = g_strokeGate;
    (void)contactPrev; (void)latched;
    int useGate = tool_edit_allowed() ? 1 : 0;
    /* 0x0208：视图导航（空格/抓手/Ctrl+空格缩放）期间整批原样透传。
       ⛔ 判据放在 useGate 之后、改写之前：不改写、但仍刷新快照与接触判据
          （HUD 与标定都靠它们，且都是普通内存写，迟滞为零）。*/
    if (useGate && view_nav_down()) useGate = 0;
    if (!useGate) {
        g_wasEnabled = 0;
        /* 0x012A：闸门关着（工具不是套索/面板关闭）⇒ 没有「一笔」在进行，
           下一个 buttons=1 包必须算落笔边沿（否则跨闸门的悬空会让边沿状态发霉）。 */
        s_prevBtn = 0; s_btnZero = BTN_EDGE_MIN_ZERO;
        InterlockedExchange(&g_strokeGate, -1);
        int tg = tool_gate_ok();
        InterlockedExchange(&g_toolOk, tg ? 1 : 0);
        gate_set(0);
        InterlockedExchange(&g_penDown, 0);
        /* P3.5：把「为什么被挡」定死（面板只做展示）。⛔ 顺序 = 用户能理解的原因链：
           先看总开关，再看工具闸门。tool_gate_reason() 与 tool_gate_ok() 同源，
           所以这里报出的原因与上面的裁决**必然一致**。 */
        if (!g_cfg[CFG_I_ENABLED]) InterlockedExchange(&g_reason, RS_OFF);
        else if (g_cfg[CFG_I_ALTTOOL]) InterlockedExchange(&g_reason, RS_ALTTOOL);
        else if (g_cfg[CFG_I_POLYALT]) InterlockedExchange(&g_reason, RS_POLYALT);
        else if (!tg)              InterlockedExchange(&g_reason, (LONG)tool_gate_reason());
        else                       InterlockedExchange(&g_reason, RS_OFF);   /* 防御：理论到不了 */
        snapshot_only((u8*)buf, S, n, ox_, oy_);
        return 0;
    }
    InterlockedExchange(&g_toolOk, 1);

    /* ——— 闸门 ②：笔尖必须接触画布（落笔）———
     * ⛔ 判据 = buttons / pkNormalPressure / pkTangentPressure **任一非零**（见 contact_update）。
     *    判据尚未建立（无信号 / 冷启动宽限之后仍无信号取得投票权）时一律按「未落笔」处理：
     *    宁可在用户第一次落笔时少平滑一帧，也不要退化成「悬空也在平滑」—— 那正是要修的缺陷。
     * ⛔⛔ 0x0124：**「坐标改不改」与「HUD 显不显」用两个不同的保持窗口**（见
     *    CONTACT_HOLD_SMOOTH_MS 的长注释）。这里只用长闩 `g_contactSmooth` 决定
     *    要不要整批放行；`g_penDown` 仍写短闩口径，HUD/面板手感不变。
     *    ⇒ 轻压运笔中「三个信号成段全零 400~600ms」不再把整笔劈成硬线。 */
    contact_update((const u8*)buf, S, n);
    LONG down = g_contact;              /* HUD / 面板口径（250ms） */
    LONG downS = g_contactSmooth;       /* 改写口径（1500ms） */
    InterlockedExchange(&g_penDown, down);

    /* ⛔ 每笔台账（0x0124）：用户报「整笔硬线」时，唯一能一次判死的东西是
       「这一笔走了哪条分支」。旧日志只有 10s 一次的 [why] 采样，落点全靠运气：
       jwwh-36348 的 29 笔里只采到 3 次 reason=5，无法说清哪几笔是硬线。
       现在**每笔一行**：包数 / 改写数 / 内部复位 / 宽限救回包数 / 半径 / 模式 / 时长。
       `救回` = 短闩已判悬空但长闩仍在撑 ⇒ 这一笔靠 0x0124 的新闩救回来了多少批；
       该值 > 0 即证明「轻压成段全零」真的存在，且新闩确实接住了。 */
    static int  s_in;
    static LONG s_t0, s_pk, s_chg, s_rst, s_grace, s_rA, s_rG, s_rJ, s_rP, s_zmax;
    static LONG s_eMin, s_eN;      /* 0x0132：本笔每次「落」之前的悬空包数最小值 / 次数 */
    static int  s_zfrz;   /* 1 = 本笔还处在「第一批」状态（不计全零） */
    /* ⛔ 0x0127：路的**客观形态**（不再靠体感描述推断） */
    static LONG s_lagSum;  /* 滞后累加（0.1px 单位） */
    static LONG s_pin;     /* 贴笔包数：滞后 < 3px ⇒ 这一包就是硬线 */
    static LONG s_slack;   /* 死区包数：绳没绷紧 ⇒ 本包输出点没动 */
    static LONG s_np;      /* 参与统计的包数 */
    static LONG s_rej0;    /* 0x0135：本笔起点处的「被否决边沿」基线（smooth_packets 每次调用都进，
                              不置基线就会把上一笔的累计数算进这一笔） */
    if (!s_in && downS) {
        s_in = 1; s_t0 = (LONG)GetTickCount();
        s_pk = n; s_chg = 0; s_rst = 0; s_grace = down ? 0 : 1;
        s_rA = s_rG = s_rJ = s_rP = 0; s_zmax = 0; s_zfrz = 1;
        s_eMin = -1; s_eN = 0;
        s_rej0 = s_btnRej;
        s_lagSum = s_pin = s_slack = s_np = 0;
    } else if (s_in && downS) {
        s_pk += n;
        if (!down) s_grace++;          /* 短闩已关、长闩仍开 ⇒ 本批由新闩救回 */
    }

    if (!downS) {
        if (s_in) {
            /* ⛔ 铁律：detour 内零 I/O ⇒ 只把台账搬进原子槽，文本由 worker 落盘。
               （旧版这里是 logf ⇒ 等于在 PS 的取包线程里做文件 I/O。） */
            s_in = 0;
            g_lgDur   = (LONG)((LONG)GetTickCount() - s_t0);
            g_lgPk    = s_pk; g_lgChg = s_chg; g_lgRst = s_rst; g_lgGrace = s_grace;
            g_lgRad   = g_cfg[CFG_I_RADIUSPX];
            g_lgMode  = g_cfg[CFG_I_MODE];
            /* 收笔瞬间的「连续全零」包数 = 这一笔末尾接触判据失效了多久（本项目
               自定义的定性指标：>20 包即「真实运笔中成段失效」）。 */
            g_lgZero  = s_zmax;
            g_lgRA = s_rA; g_lgRG = s_rG; g_lgRJ = s_rJ; g_lgRP = s_rP;
            g_lgEmin = s_eMin; g_lgEn = s_eN;
            g_lgRej  = s_btnRej - s_rej0;    /* 0x0135：本笔被去抖否决的假落笔边沿数 */
            g_lgLag = s_np ? (LONG)(s_lagSum / s_np) : 0;                 /* 0.1px 均值 */
            g_lgPin = s_np ? (LONG)((s_pin * 100) / s_np) : 0;            /* 贴笔 % */
            g_lgSlack = s_np ? (LONG)((s_slack * 100) / s_np) : 0;        /* 死区 % */
            InterlockedExchange(&g_lgEvt, 1);
        }
        g_wasEnabled = 0;            /* 抬笔 ⇒ 下一笔重新起笔锚定 */
        /* 0x012A：长闩过期 = 全部接触信号（含 buttons）已连续 1.5s 为 0 ⇒ 这一定是
           真悬空。把边沿状态复位成「已抬升」：下一个 buttons=1 包就是新一笔的起点，
           必须在那里锚定（用户报的「落笔偏移」在 <1.5s 再落笔时全靠这一条）。 */
        s_prevBtn = 0; s_btnZero = BTN_EDGE_MIN_ZERO;
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

    /* ⛔ 0x0125：本批是否是「悬空 → 落笔」的边沿（**短闩**口径）。
       只在「位移 > 4×绳长」时才据此另起一笔 —— 运笔中的零段恢复位移只有几 px，
       不能因为短闩抖一下就锚定（0x0124 的 revert：那会让整笔又变硬线）。
       ⚠️ 0x012A 起，**真正的落笔锚定由 buttons 逐包边沿负责**（见下面 penDownEdge），
       本条退化为「buttons 不可用时的兜底」；两者目的相同（起笔钉在落笔点），判据不同。 */
    static LONG s_prevDown = 1;
    int hoverEdge = (down && !s_prevDown) ? 1 : 0;
    s_prevDown = down;
    const double reanchorPx = 4.0 * radiusPxF;

    /* 每笔台账：本批开始时的「连续全零」包数（取全程最大值）。
       ⛔ 0x0126：**跳过本笔第一批** —— 那时 g_ctZeroRun 还是「起笔前悬空」攒下的值
       （真机 jwwh-2024 笔#1 因此把它记成 599 包，等于把起笔前的悬空算进这一笔）。 */
    if (s_zfrz) s_zfrz = 0;
    else if ((LONG)g_ctZeroRun > s_zmax) s_zmax = (LONG)g_ctZeroRun;

    for (int i = 0; i < n; i++) {
        u8* p = (u8*)buf + (SIZE_T)i * S;
        u32 rawX, rawY;
        memcpy(&rawX, p + ox_, 4);
        memcpy(&rawY, p + oy_, 4);
        double x = (double)rawX, y = (double)rawY;

        /* ⛔⛔ 0x012A：逐包读 buttons（笔尖开关）。0→1 边沿（带去抖）⇒ 真正的落笔，
           本包必须锚定到原始坐标。必须算在下面的复位块**之前**。
           代价 = 每包一次 4 字节读 + 掩码（detour 里零系统调用，与读 rawX/rawY 同族）。 */
        int penDownEdge = 0;
        if (i == 0 && s_ctBtnIdx >= 0 && InterlockedExchange(&g_btnResync, 0)) {
            s_prevBtn = 1; s_btnZero = 0;   /* 0x0137：补流交还 —— 不许把「补流写 0」算成抬笔 */
        }
        if (s_ctBtnIdx >= 0 && s_ctBtnIdx < g_ctN && g_ctElig[s_ctBtnIdx] == 1) {
            u32 bv; memcpy(&bv, p + g_ctOff[s_ctBtnIdx], 4);
            if (g_ctMsk[s_ctBtnIdx]) bv &= (u32)g_ctMsk[s_ctBtnIdx];
            if (bv) {
                if (!s_prevBtn && s_btnZero >= BTN_EDGE_MIN_ZERO) {
                    penDownEdge = 1;
                    if (s_eMin < 0 || s_btnZero < s_eMin) s_eMin = s_btnZero;
                    s_eN++;
                } else if (!s_prevBtn) {
                    s_btnRej++;    /* 0x0135：0→1 但零段太短 ⇒ 判抖动，锚定不触发 */
                }
                s_btnZero = 0;
            } else {
                s_btnZero++;   /* 悬空/掉零：累计抬升包数（真悬空可积累到很大） */
            }
            s_prevBtn = bv ? 1 : 0;
        }

        /* ⛔⛔ `now` 必须**每包**取样，不能整批取一次。
           旧版写在循环外，而 g_lastMs 在循环内被更新 ⇒ 一批里第 2 个包起
           dt = now − now = 0，被钳到 1ms ⇒ k = dt/(dt+τ) 退化成 1/(1+τ)
           （强度 40 时 0.11 而非 0.38）、追笔的 step 也被缩小一个量级
           ⇒ 参数与真实采样率脱钩，「拖滑杆没反应」的第三层根因。
           GetTickCount 只是读 KUSER_SHARED_DATA 的一个常量，不是系统调用，
           detour 里每包调一次完全安全。 */
        DWORD now = GetTickCount();

        /* ——— 复位守卫（起笔锚定 / 抬笔重定位 / 开关刚打开）———
           ⛔ 四种原因分开计数（g_rstPenDown/Anchor/Gap/Jump）：用户看到的「圆闪现回光标、
           折线瞬间连到光标」就是一次复位，不分开计数就只能靠猜是哪一种。 */
        double dx = x - g_ox, dy = y - g_oy;
        double dpx = dx * cX, dpy = dy * cY;                  /* 逐轴换算后的像素位移 */
        double distPx = dsqrt_(dpx * dpx + dpy * dpy);
        int reset = 0;
        /* ⛔⛔ 0x012A：buttons 落笔边沿**优先于**下面一切判据 —— PS 的套索路径就在
           这里起笔，输出点必须钉在本包原始坐标上（用户：「落笔时选区边缘长度为 0，
           受力点与施力点应该重合」）。没有这一条，长闩内的快速再落笔会整体漏锚。 */
        if (penDownEdge)                                     reset = RST_PENDOWN;
        else if (!g_wasEnabled)                              reset = RST_ANCHOR;
        else if (hoverEdge && distPx > reanchorPx)           reset = RST_ANCHOR;  /* 抬笔移位 ⇒ 另起一笔 */
        else if (now - g_lastMs > TIME_GAP_RESET_MS)         reset = RST_GAP;
        else if (distPx > jumpPx)                            reset = RST_JUMP;
        /* ⛔⛔ 断流恢复 ⇒ 强制锚定（2026-10-16 第十三轮）：断流期笔早已走远，停摆前的
           输出点已经没有任何意义。这里**覆盖**上面三种判定（哪怕间隔没到 5s）——
           驱动实测会在恢复瞬间一次性涌进 ~128 个包（见 worker 的「冲包量」），
           不锚定的话这一批包会被当成「笔尖连续移动」处理，输出点从旧位置被硬拽过来。 */
        if (InterlockedExchange(&g_deadRecovered, 0)) reset = RST_ANCHOR;

        if (reset) {
            g_lastGapMs = (LONG)(now - g_lastMs);
            s_rst++;      /* 1 = 本笔起笔锚定（正常）；>1 = 笔中又被复位（硬线元凶） */
            if (reset == RST_GAP)        s_rG++;
            else if (reset == RST_JUMP)  s_rJ++;
            else if (reset == RST_PENDOWN) s_rP++;   /* 0x012A：真落笔边沿 */
            else                         s_rA++;
            if (reset == RST_GAP)        InterlockedIncrement(&g_rstGap);
            else if (reset == RST_JUMP)  InterlockedIncrement(&g_rstJump);
            else if (reset == RST_PENDOWN) InterlockedIncrement(&g_rstPenDown);
            else                     InterlockedIncrement(&g_rstAnchor);
            g_ox = x; g_oy = y;
            g_speed = 0; g_dirX = g_dirY = 0; g_hasDir = 0;
            /* ⛔ 两个估计量的基准点在锚定时必须一起作废：锚定意味着笔尖与输出
               重合、「上一段」的历史已无意义，沿用旧基准会把跨越复位的那一段
               当成一条长线段，算出一个假方向 / 假笔速。 */
            s_hasSpRef = 0;
            s_hasCRef = 0;
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

        /* 笔速（物理 px/ms）：距离窗结算，与面板的 px/ms 同域。
           ⛔ 绝不能再写回 `distPx / dt` —— distPx 是**滞后**，不是位移：用它当速度
              会形成一个把滞后锁死的负反馈（推导见 g_speed 声明处），
              结果就是「强度滑杆怎么拉，选区落后光标的距离都差不多」。 */
        if (!s_hasSpRef) {
            s_spRefX = x; s_spRefY = y; s_spRefMs = now; s_hasSpRef = 1;
        } else {
            double mx = (x - s_spRefX) * cX, my = (y - s_spRefY) * cY;
            double mPx = dsqrt_(mx * mx + my * my);
            DWORD  wms = now - s_spRefMs;
            if (mPx >= SPEED_WIN_PX * dpiS && (double)wms >= SPEED_WIN_MS) {
                double sp = mPx / (double)wms;
                if (sp > SPEED_MAX * dpiS) sp = SPEED_MAX * dpiS;
                g_speed = g_speed * 0.5 + sp * 0.5;
                s_spRefX = x; s_spRefY = y; s_spRefMs = now;
            }
        }

        /* 拐角守卫：相邻两段方向的**转折角**超过阈值 ⇒ 本帧减弱平滑，保住尖角。
           ⚠️ 只对「标准」模式生效 —— 拉绳/追笔的跟随机制本身不磨圆（拉绳甚至会主动
           把输出点按在绳长处，尖角由绳长决定），加拐角削弱反而破坏它们的手感。
           ⛔ 双基准（0x020C）：参考方向只由 ≥3px 的线段推进（抗亚像素抖动 ——
              抖动的段长通常只有亚像素~2px，而 205Hz 下相邻两帧的夹角极易超过 45°，
              不开门限的话「拐角」几乎每帧都成立 ⇒ k 被抬到 0.75 ⇒ 平滑被关掉，
              只剩下滞后，观感正是「有延迟却不平滑」）；
              当前方向由「自参考点起 ≥2px」的累积位移给出 —— 旧版要求**单包** >3px，
              而正常运笔每包只有 1~2px ⇒ 慢速画线时这个参数整段不触发，
              与「偏折超过设定角就减少平滑」的说明完全对不上。
           ⚠️ 夹角在**屏幕像素域**判定（逐轴对称后两轴比例仍不同，轴空间里的夹角
              与用户看到的夹角不是一回事）。 */
        int corner = 0;
        if (mode == 0) {
            if (!s_hasCRef) { s_cRefX = x; s_cRefY = y; s_hasCRef = 1; }
            else {
                double rx = (x - s_cRefX) * cX, ry = (y - s_cRefY) * cY;
                double rlen = dsqrt_(rx * rx + ry * ry);
                if (rlen >= CORNER_PROBE_PX * dpiS) {
                    double ux = rx / rlen, uy = ry / rlen;
                    int fired = 0;
                    if (g_hasDir) {
                        double dot = ux * g_dirX + uy * g_dirY;
                        if (dot > 1.0) dot = 1.0; else if (dot < -1.0) dot = -1.0;
                        if (dot < cornerCos) { corner = 1; fired = 1; }
                        /* ⟺ 转折角 > cornerDeg。⛔ 阈值越小越容易触发保护；
                           面板显示值就是本阈值，**没有任何反向映射**（2026-10-14 回退定案）。 */
                    }
                    /* 触发即重设基准（否则整个转弯过程会每拍都判成拐角、把平滑一直关着）；
                       否则只有累积到 CORNER_MIN_PX 才推进基准 ⇒ 基准方向始终来自真实线段。 */
                    if (fired || rlen >= CORNER_MIN_PX * dpiS) {
                        g_dirX = ux; g_dirY = uy; g_hasDir = 1;
                        s_cRefX = x; s_cRefY = y;
                    }
                }
            }
        } else {
            /* 拉绳/追笔不判拐角，顺手把基准作废：切回标准模式时不能拿旧方向当「上一段」。 */
            g_hasDir = 0;
            s_hasCRef = 0;
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

        /* ⛔ 0x0127：每笔台账的**客观形态**。用户只能用「硬线/断流」描述观感，
           这一组数字把它变成可判定的量：
             `贴笔` = 写出去的点就压在笔尖上（滞后<3px）⇒ 这些包画出来就是硬线；
             `死区` = 绳没绷紧 ⇒ 本包输出点一像素没动（拉绳的正常行为，占比过高则顿）；
             `平均滞后` ≈ 绳长 ⇒ 输出一直在拖（平滑生效）。
           ⛔ 只在窗口内做四则运算，无系统调用。 */
        {
            double lg = (lagPx > radiusPxF) ? radiusPxF : lagPx;
            s_lagSum += (LONG)(lg * 10.0);
            if (lg < 3.0) s_pin++;
            if (distPx <= radiusPxF) s_slack++;
            s_np++;
        }

        /* HUD 快照（普通内存写，detour 内零系统调用） */
        sn_publish((LONG)rawX, (LONG)rawY, (LONG)wx, (LONG)wy, (LONG)now);
    }
    s_chg += changed;      /* 每笔台账：本笔实际改写了多少个包的坐标 */
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
/* 0x0133：上下文看门狗用的时间戳（0 = 当前有上下文）。
   ⛔ 只用「WTClose 之后多久没有 WTOpen」这一个事实，不猜别的。 */
static volatile LONG g_ctxClosedMs;
static volatile LONG g_wtOpenN;   /* WTOpenA 次数 */
static volatile LONG g_wtCloseN;  /* WTClose 次数 */
static volatile LONG g_streamDead;/* 1 = 断流判定成立（worker 看门狗写） */
static HCTX g_ctxNow;             /* 最近一次被轮询的上下文（detour 普通写即可） */

/* HUD 门控各项的**诊断镜像**（渲染线程写、`[hud] 未显示` 与 `[stall]` 行读）。
   ⛔ 只为排障：真正门控是局部门控变量，不要反过来读这些字段。
   ⛔ 声明必须早于 worker 的 [stall] 记录点（0x0117 起该行要打 fg=）。 */
static volatile LONG g_fgOkDbg      = 1;   /* 前台是本进程（已去抖） */
static volatile LONG g_drawOkDbg    = 1;   /* 工具模态放行 */
static volatile LONG g_strokeOkDbg  = 0;   /* 真的在一笔之中 */
static volatile LONG g_lagSkipDbg   = 0;   /* 本帧因滞后被跳过 */
static volatile LONG g_jumpSkipDbg  = 0;   /* 本帧因大跳跃被跳过 */
static volatile LONG g_canvasOkDbg  = 1;   /* 焦点在活动文档画布上（0x0116 焦点门，**只门 HUD**） */
/* 0x0134：**宽判**——只看「笔落点是不是在 PS 的窗口/画布上」，**不看前台**。
   ⛔ 为什么需要它：Wintab 是系统上下文，PS 在后台时包**照常进来、也照常绘制**
      （jwwh-40408 实测：fg=0 的一整段里 packets 仍在涨、`[gate] penDown 0→1` 照常发生）。
      而旧版把「前台必须是 PS 主框」这根 HUD 门槛也用在了**平滑/补流的救援路径**上
      ⇒ 只要用户把聊天窗/浏览器切到前面（哪怕在另一块屏、根本不挡画布），
         断流救援立刻被禁（`pre=(…cv0…)`、`补发` 冻结）⇒ 用户感知「断流且不自愈」。
   ⇒ 救援路径一律改用本标志；HUD 仍用严格判据（浮在别的程序上会碍事）。 */
static volatile LONG g_canvasHitDbg = 1;
static volatile LONG g_ctOkDbg      = 0;   /* 落笔判据已建立（g_ctUnknown==0） */

/* —— 取包突发计量（2026-10-16 第十四轮）——
   真机 jwwh-13772 的教训：10s 窗口的平均包率在 62/s 与 174/s 之间来回摆，而驱动
   标称 `rate=100`。也就是说「卡顿 → 一口气冲出来」是**常态**而不是例外，可此前
   没有任何一个探针能量出它（`[dead]` 只抓长于 350ms 且光标在动的那种长断流）。
   这里补三个原子 —— 单次最大包数 / ≥25 包次数 / 零包次数，worker 每 2s 落一行。 */
/** 只统计**真实**驱动包（不含独立笔通路合成的那部分）——
    断流看门狗必须看它：合成补流会把 g_packets 一直抬高，用它判冻结点就等于
    把断流藏起来了（诊断必须能说真话）。
    ⛔ 0x0136：变量本体已前移到 `g_gcpCalls` 那一组（[ink] 行要读它）。 */
/* 补流进出事件（detour 置位、worker 落盘 —— detour 里一个字都不写文件） */
static volatile LONG g_synEnter, g_synExit, g_synSpanMs;
/* 0x0118：退出原因码（随 g_synExit 一起置位，worker 落盘时按码打文案）。
   0=真通路回包 1=引擎被关（撤钩/拟合失效）2=面板开关关 3=标定失效 4=采样源无新样本 */
static volatile LONG g_synExitWhy;
/* 接管沿边缘检测 + 接管起点：⛔ 0x0118 从 det_WTPacketsGet 的函数级 static
   上提为文件级 —— 撤钩（do_unhook）时补流正接管的话必须在这里复位，否则重挂后
   条件仍成立却因 s_synWas 残留=1 而不再打「★接管」日志、g_synSpanMs 也会把
   两段接管拼成一段（排障时对不上时间线）。 */
static volatile LONG g_synWas;          /* 0x0120：volatile LONG —— do_unhook（worker 线程）会清它 */
static DWORD        g_synT0L;

/* 只读诊断钩的槽位（与主钩同款 E9-thunk 前提；独立于主钩状态，互不影响） */
typedef struct {
    const char* name;
    u8* entry; u8* impl; u8* relay; u8 orig[5];
    int patched;
    void* detour;
    char skip[128];
    const char* mod;      /* 0x012F：导出所在 DLL（默认 Wintab32.dll；光标钩用 user32.dll） */
} LHOOK;
static LHOOK g_lhPkt1  = { "WTPacket", 0, 0, 0, {0}, 0, 0, {0}, "Wintab32.dll" };
static LHOOK g_lhOpen  = { "WTOpenA", 0, 0, 0, {0}, 0, 0, {0}, "Wintab32.dll" };
/* ⛔ 0x0127：PS 用的是 **WTOpenW**（历次日志里 `open=0` 就是因为我们只挂了 A 版，
   一次都没被调用过）。挂上它才能拿到 PS 自己那份 LOGCONTEXT —— 尤其是
   `lcOptions`（是否 CXO_MESSAGES=0x4）与 `lcMsgBase`：若 PS 走**消息驱动**，
   那么停摆期没有任何 WT_PACKET 消息进来，它根本不会来取包 —— 这正是
   「我方每拍都返回、PS 取包速率却掉到空闲」的另一种解释，且可解（我们补发消息）。
   本钩**只读**：不碰 lcLocks、不改任何字段。 */
static LHOOK g_lhOpenW = { "WTOpenW", 0, 0, 0, {0}, 0, 0, {0}, "Wintab32.dll" };
static LHOOK g_lhClose = { "WTClose", 0, 0, 0, {0}, 0, 0, {0}, "Wintab32.dll" };
/* ⑤（LNP hookedWTInfoA/W）：只读观测 WTInfo 取回的 LOGCONTEXT，判定 DPI 虚拟化。
   默认**只落日志不改值** —— 改写会动 PS 的坐标映射，必须先拿真机日志证明
   「lcSysExt ≠ 真实虚拟屏」确实发生，再开 `fixDpi=1`。 */
static LHOOK g_lhInfoA = { "WTInfoA", 0, 0, 0, {0}, 0, 0, {0}, "Wintab32.dll" };
static LHOOK g_lhInfoW = { "WTInfoW", 0, 0, 0, {0}, 0, 0, {0}, "Wintab32.dll" };

/* ============================ 0x012F：照搬 LNP 的「光标查询」入口 ============================
   背景（O29/O30）：驱动一停，PS 不再走 Wintab 包路径，**退化成鼠标路径**仍有笔感
   （用户实测：断流当下套索照常画，只是没有平滑）。我们只钩了包路径 ⇒ 此时彻底插不上手。

   LNP（`MouseHookPro64.8li` 26.10.14，REA 反编）的做法（= 本段的依据）：
     · 钩 `user32!GetCursorPos`（钩子 FUN_18002c440），**先调真函数**，再按开关改写输出；
     · 改写函数 FUN_180058310 / FUN_180058500：
         若 `GetAsyncKeyState(VK_LBUTTON) < 0`（笔尖按着）⇒ 把真实坐标喂平滑引擎
         （FUN_180058e90）⇒ 用引擎输出 `state+0x2aae8` **覆盖** POINT；
         若左键电平读 0 但笔画进行中（`b26e18`）⇒ 仍返回**缓存的平滑点**，绝不透传真实坐标
         （这正是我们 0x012B 用 VK_LBUTTON 电平判抬笔翻车的那个坑，LNP 用「缓存」绕开了）；
         不在笔画中 ⇒ 透传。窗口用 `WindowFromPoint` 限定（FUN_18002bd40）。
     · 它是**不搬动光标**的：只改「PS 读到的那份副本」⇒ 系统光标（施力点）保持真实，
       PS 拿到的（受力点）是平滑后的 —— 与 HUD 的「圆心=绘制点、光标在圈内」同一语义。
     · 反向验证：`SetCursor`（改光标形状）被钩，但**没有** `SetCursorPos` ⇒ 确认不搬光标。

   我方落地：我们的平滑引擎本来就在跑（250Hz 系统光标采样 + 合成包），`g_snOutX/Y`
   就是平滑输出、`g_snRawX/Y` 是输入 ⇒ **不需要新算法**，只要在 GetCursorPos 里
   把「光标 → 输出点」的位移补上，与 HUD 圆心用的同一个换算（`px_x()/px_y()`）。

   ⛔ 只在**真实包通路停摆**时接管：正常运笔时 Wintab 路径已经在改写了，两条路同时
      改写会变成双重滞后。两者互斥 = 天然的分工。
   ⛔ 内部调用（补流输入、dead 判据、HUD）必须走 `se_real_GetCursorPos()` 直调真函数，
      否则会「自己吃自己的输出」：补流输入变成滞后值 ⇒ 输出再滞后 ⇒ 发散。
   ⛔ 开关外置 `wtctx.ini` 的 `cursorInject`（**缺省 1**；写 0 才只观测），改口径不重编。 */
static LHOOK g_lhGcp = { "GetCursorPos",   0, 0, 0, {0}, 0, 0, {0}, "user32.dll" };
static LHOOK g_lhGmp = { "GetMessagePos",  0, 0, 0, {0}, 0, 0, {0}, "user32.dll" };
static int lhook_prepare(LHOOK* L);
static int lhook_commit(LHOOK* L);
static void lhook_restore(LHOOK* L);

/* ============================================================ ④⑤ 外置开关
   照 ⑨ 白名单外置的同一套路：`%LOCALAPPDATA%\JWautofill\smooth8li\wtctx.ini`。
   为什么外置而不是编译期宏：这两条都会**改写 PS 传进来的结构**，一旦判错会
   直接影响笔的坐标；改口径不该以「重编 + 重部署 .8li」为代价。缺文件 = 全 0
   （只观测、不改写），这是唯一安全默认值。
     clearLocks=1  ④ 清掉 lcLocks 的 CXL_SYSOUT(0x10) 后再交给真 WTOpenA
     fixDpi=1      ⑤ 把 lcSysExt 改写成真实虚拟屏尺寸并记 dpiRatio
     queueSize=N   ⑥ WTOpen 成功后调 WTQueueSizeSet(hCtx, N)（0=不动）
   ⛔ 只在 do_install 里读一次（低频），不在包路径上碰文件。 */
#define WTCTX_INI_CLEARLOCKS   0
#define WTCTX_INI_FIXDPI       1
#define WTCTX_INI_QUEUESIZE    2
#define WTCTX_INI_CURSORINJECT 3      /* 0x012F：1 = 断流期接管 GetCursorPos（改写 PS 读到的坐标） */
static int g_wtctxIni[4];                 /* 默认全 0 */
static int g_wtctxIniRead;                /* 是否已读过（只读一次） */
extern const char* jw_log_dir(void);      /* plugin_main.c：日志目录（带尾部反斜杠） */
static void wtctx_read_ini(void)
{
    if (g_wtctxIniRead) return;
    g_wtctxIniRead = 1;
    char path[MAX_PATH];
    const char* dir = jw_log_dir();
    if (!dir || !*dir) return;
    _snprintf(path, sizeof(path), "%swtctx.ini", dir);
    path[sizeof(path) - 1] = 0;
    /* ⛔⛔ 0x0131 修正：`cursorInject` 的**缺省值必须在这里给**，不能只写在
       「文件不存在」分支里 —— jwwh-39120 的 ini 只有 `queueSize=128` 一行，
       走的是「文件存在」分支，于是数组第 4 位保持 0 ⇒ 日志打 `cursorInject=0`
       ⇒ GetCursorPos 接管从头到尾没生效（用户以为开了，其实关着）。
       ⇒ 先置 1，再让文件里的 `cursorInject=0` 覆盖它。 */
    g_wtctxIni[WTCTX_INI_CURSORINJECT] = 1;
    FILE* f = fopen(path, "rb");
    if (!f) {
        logf("# [wtctx] 无外置开关文件（%s）⇒ ④⑤ 只观测不改写、⑥ 不动队列、"
             "GetCursorPos **改写开启**（缺省 cursorInject=1，可建 ini 写 0 关闭）\n", path);
        return;
    }
    char line[256];
    while (fgets(line, (int)sizeof(line), f)) {
        if (line[0] == '#' || line[0] == ';') continue;
        int v = 0;
        if      (!_strnicmp(line, "clearLocks=", 11)) { v = atoi(line + 11); g_wtctxIni[WTCTX_INI_CLEARLOCKS] = v; }
        else if (!_strnicmp(line, "fixDpi=",     7))  { v = atoi(line +  7); g_wtctxIni[WTCTX_INI_FIXDPI]     = v; }
        else if (!_strnicmp(line, "queueSize=", 10))  { v = atoi(line + 10); g_wtctxIni[WTCTX_INI_QUEUESIZE]  = v; }
        else if (!_strnicmp(line, "cursorInject=", 13)) { v = atoi(line + 13); g_wtctxIni[WTCTX_INI_CURSORINJECT] = v; }
        else continue;
    }
    fclose(f);
    logf("# [wtctx] 外置开关 clearLocks=%d fixDpi=%d queueSize=%d cursorInject=%d（%s）\n",
         g_wtctxIni[0], g_wtctxIni[1], g_wtctxIni[2], g_wtctxIni[3], path);
}

/* —— ⑥⑦ 上下文打开后的队列动作（LNP WTPktUtil 同款），A/W 两个入口共用 ——
   ⑦ 实测量：无论外置开关与否，每个上下文都记一次 WTQueueSizeGet 的真实容量。
      旧会话 jwwh-9304 的恢复冲包 ~125/127 反推队列=128、新无 LNP 会话默认只有
      几十——容量差异从此是日志里的**直接证据**，不再靠冲包数反推。
   ⑥ 扩容：仅 wtctx.ini 显式 queueSize=N 时执行（默认 0=不动）。
   ⛔⛔ 0x0129：本块原先只挂在 det_WTOpenA 里，而 PS 一直走 WTOpenW（历次日志
      `open=0`）⇒ 用户按指引建 wtctx.ini(queueSize=128) 的复测（jwwh-5288）
      **一次都没执行**（日志第 2 行读到 128、WTOpenW 成功、全场无 ⑥ 行）——
      那次「测试无效」。现抽成共用函数，A/W 都调。 */
static void wtctx_post_open(HCTX h)
{
    if (!h) return;
    HMODULE hm = GetModuleHandleA("Wintab32.dll");
    if (!hm) {
        logf("# [ctx] ⑦ 跳过：Wintab32.dll 未加载\n");
        return;
    }
    typedef UINT (*PFN_QG)(HCTX);
    PFN_QG pQG = (PFN_QG)(void*)GetProcAddress(hm, "WTQueueSizeGet");
    UINT q0 = 0;
    if (pQG) q0 = pQG(h);
    else logf("# [ctx] ⑦ WTQueueSizeGet 导出缺失\n");
    if (g_wtctxIni[WTCTX_INI_QUEUESIZE] > 0) {
        typedef BOOL (*PFN_QS)(HCTX, int);
        PFN_QS pQS = (PFN_QS)(void*)GetProcAddress(hm, "WTQueueSizeSet");
        if (pQS) {
            int qs = g_wtctxIni[WTCTX_INI_QUEUESIZE];
            BOOL ok = pQS(h, qs);
            logf("# [ctx] ⑥ WTQueueSizeSet(hCtx=0x%llX, %d) ⇒ %d（实测原容量 %u）\n",
                 (unsigned long long)(UINT_PTR)h, qs, (int)ok, q0);
        } else {
            logf("# [ctx] ⑥ WTQueueSizeSet 导出缺失（queueSize=%d 未执行，实测容量 %u）\n",
                 g_wtctxIni[WTCTX_INI_QUEUESIZE], q0);
        }
    } else if (pQG) {
        logf("# [ctx] ⑦ WTQueueSizeGet(hCtx=0x%llX) = %u（queueSize=0 不动）\n",
             (unsigned long long)(UINT_PTR)h, q0);
    }
}

/* ⑤ 观测结果（无论开关与否都记，供真机定案） */
static volatile LONG g_dpiSeen;           /* 见过几次 DEFCONTEXT/DEFSYSCTX 查询 */
static volatile LONG g_dpiMismatch;       /* lcSysExt ≠ 真实虚拟屏的次数 */
static volatile LONG g_dpiRatioX1000;     /* 真实虚拟屏 / lcSysExt ×1000（0=未算出） */
static volatile LONG g_ctxSysOutLock;     /* ④ WTOpenA 里见到 CXL_SYSOUT 的次数 */
static volatile LONG g_ctxLockCleared;    /* ④ 实际清掉的次数 */

/* —— ⑧（LNP WTSanityCheck）：wintab32 被重载 ⇒ 重挂 ——
   LNP 的做法是周期性看 wintab32 的模块是否还是「挂 hook 时那一份」；被重载/被
   别人重新加载后，我们的 E9 改写就落在了旧映像上 ⇒ **取包通路整体失效**
   （表象与 O1 断流一模一样：calls 不涨、包不来）。我们以前的自愈是「state=0
   且 calls=0 就重挂」，**不留痕** —— 真机日志里看到断流无法归因是不是这一类。
   ⇒ 这里按 LNP 的形态补上：pump 线程每 500ms 比一次模块基址，变了就落
   `[wt] ★wintab32 已重载` 并让调用方重挂。 */
static void* volatile g_wtBase;           /* 挂 hook 那一刻 wintab32 的 AllocationBase */
/** 与当前进程里的 wintab32 基址比对；不同 ⇒ 返回 1（并更新记录）。未加载返回 0。 */
int se_wt_moved(void)
{
    HMODULE hm = GetModuleHandleA("Wintab32.dll");
    if (!hm) return 0;                    /* 还没加载：不是「被换掉」，不动 */
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery((LPCVOID)hm, &mbi, sizeof(mbi)) != sizeof(mbi)) return 0;
    void* now = (void*)mbi.AllocationBase;
    void* was = (void*)g_wtBase;
    if (!was) { g_wtBase = now; return 0; }   /* 首次记录 */
    if (now == was) return 0;
    g_wtBase = now;
    return 1;
}
void* se_wt_base(void) { return (void*)g_wtBase; }

/* Wintab WTInfo 类别常量（wintab.h） */
#define WTI_DEFCONTEXT  3u
#define WTI_DEFSYSCTX   4u

static u64 det_WTPacket(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)d; (void)e; (void)f;
    typedef UINT (*PFN_WTPacket)(HCTX, UINT, void*);
    PFN_WTPacket impl = (PFN_WTPacket)g_lhPkt1.impl;
    UINT r = impl((HCTX)a, (UINT)b, (void*)c);
    if (r) InterlockedIncrement(&g_wtPkt1);
    return r;
}

static volatile LONG g_wtOpenWN;


/* ⛔ LOGCONTEXTW 布局（相对 A 版整体 +40：lcName 是 WCHAR[40] = 80 字节）：
     lcOptions 80 · lcStatus 84 · lcLocks 88 · lcMsgBase 92 · lcDevice 96 ·
     lcPktRate 100 · lcPktData 104 · lcPktMode 108 · lcMoveMask 112 ·
     lcBtnDnMask 116 · lcBtnUpMask 120 · lcInOrg(124,128,132) · lcInExt(136,140,144) ·
     lcOutOrg(148,152,156) · lcOutExt(160,164,168)
   ⛔ 只读：一个字节都不改写（改写 PS 的 LOGCONTEXT 会直接动坐标映射）。 */
static u64 det_WTOpenW(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)d; (void)e; (void)f;
    typedef HCTX (*PFN_WTOpenW)(HWND, void*, BOOL);
    PFN_WTOpenW impl = (PFN_WTOpenW)g_lhOpenW.impl;
    HCTX h = impl((HWND)a, (void*)b, (BOOL)c);
    InterlockedIncrement(&g_wtOpenWN);
    const unsigned char* p = (const unsigned char*)b;
    if (p) {
        unsigned int opt = *(const unsigned int*)(p + 80);
        /* 0x0128：记住「往哪个窗口补发消息」+ 消息基址（PS 用默认 0x7FF0）。 */
        if (h) {
            g_ctxHwnd = (HWND)a;
            InterlockedExchange(&g_ctxMsgBase, (LONG)*(const unsigned int*)(p + 92));
            InterlockedExchange(&g_ctxOpt, (LONG)opt);
        }
        logf("# [ctx] WTOpenW hCtx=0x%llX hwnd=%p opt=0x%X%s msgBase=0x%X pktData=0x%X pktMode=0x%X "
             "inExt=(%ld,%ld) outExt=(%ld,%ld) dn=0x%X up=0x%X\n",
             (unsigned long long)(UINT_PTR)h, (void *)(UINT_PTR)a,
             opt, (opt & 0x4u) ? "★CXO_MESSAGES" : "",
             *(const unsigned int*)(p + 92), *(const unsigned int*)(p + 104),
             *(const unsigned int*)(p + 108),
             (long)*(const int*)(p + 136), (long)*(const int*)(p + 140),
             (long)*(const int*)(p + 160), (long)*(const int*)(p + 164),
             *(const unsigned int*)(p + 116), *(const unsigned int*)(p + 120));
    } else {
        logf("# [ctx] WTOpenW hCtx=0x%llX (logctx=NULL)\n", (unsigned long long)(UINT_PTR)h);
    }
    /* ⑥⑦（0x0129）：A/W 共用——PS 一直走 W 版，⑥ 以前只挂在 A 版 ⇒ 从未执行 */
    wtctx_post_open(h);
    return (u64)(UINT_PTR)h;
}

static u64 det_WTOpenA(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)d; (void)e; (void)f;
    typedef HCTX (*PFN_WTOpenA)(HWND, void*, BOOL);
    PFN_WTOpenA impl = (PFN_WTOpenA)g_lhOpen.impl;
    const unsigned char* p = (const unsigned char*)b;

    /* —— ④（LNP hookedWTOpenA/W）：lcLocks(+48) 的 CXL_SYSOUT(0x10) ——
       LNP 在把 LOGCONTEXT 交给真 WTOpenA 之前，只要见到该位就把**整个 lcLocks
       清零**。语义是「不让驱动把输出坐标锁进系统（屏幕）坐标」——DPI 虚拟化 /
       多显示器下这条锁会把坐标按错误的缩放比换算，表现为「取包在但坐标不更新」
       或「HUD 位置与光标对不上」，正是我们 O1 断流的一种形态。
       ⛔⛔ 这是**改写 PS 传进来的结构**：判错会直接动到笔坐标。所以默认只计数 +
       落日志（`wtctx.ini` 里 clearLocks=0），真机日志证明「确实带 0x10 且确实
       错位」之后再开 1。LNP 的清零是 `lcLocks = 0`；我们保守只清 0x10 这一位，
       其余锁位（inOrg/inExt/outOrg/outExt）保持 PS 原意。 */
    if (p) {
        unsigned int locks = *(const unsigned int*)(p + 48);
        if (locks & 0x10u) {
            InterlockedIncrement(&g_ctxSysOutLock);
            if (g_wtctxIni[WTCTX_INI_CLEARLOCKS]) {
                *(unsigned int*)((unsigned char*)b + 48) = locks & ~0x10u;
                InterlockedIncrement(&g_ctxLockCleared);
                logf("# [ctx] ④ lcLocks=0x%X 带 CXL_SYSOUT ⇒ 已清该位（现 0x%X，clearLocks=1）\n",
                     locks, locks & ~0x10u);
            } else {
                logf("# [ctx] ④ lcLocks=0x%X 带 CXL_SYSOUT（clearLocks=0 ⇒ 仅记录，未改写）\n", locks);
            }
        }
    }

    /* 低频调用（开上下文）⇒ 允许落盘；205Hz 包路径的铁律不适用于这里。 */
    HCTX h = impl((HWND)a, (void*)b, (BOOL)c);

    /* —— ⑥⑦（LNP WTPktUtil / WTQueueSizeSet）：队列实测量 + 按需扩容 ——
       冲包的一种根因不是「我们处理慢」，而是**驱动队列溢出后补发**：队列太小、
       主线程被模态作用域卡住几百毫秒，驱动攒的包一次倾泻出来。WTQueueSizeSet
       是标准 API，LNP 用它配 WTPacketsPeek / WTQueuePacketsEx 观测深度。
       ⚠️ 反过来也会加剧延迟（包在队列里排队更久），所以默认 0=不动，只在
       wtctx.ini 里显式给 queueSize=N 才生效。⛔ 0x0129：抽成 A/W 共用函数
       （原先只挂 A 版，PS 走 W 版 ⇒ 从未执行，jwwh-5288 复测无效）。 */
    wtctx_post_open(h);

    /* 0x012C：A 版同样记住代投目标（LOGCONTEXTA 的 lcMsgBase 在 +52）。
       ⛔ 别指望 PS 走这条（历次日志都是 W 版），但别的宿主/A 版驱动会走。 */
    if (h && p) {
        g_ctxHwnd = (HWND)a;
        InterlockedExchange(&g_ctxMsgBase, (LONG)*(const unsigned int*)(p + 52));
    }

    if (p) {
        /* ⛔ LOGCONTEXTA 真实布局 —— 本仓库 [calib] 段已逐项实测确认（4 字节整型、无对齐缝）：
             lcName[40] 0 · lcOptions 40 · lcStatus 44 · lcLocks 48 · lcMsgBase 52 ·
             lcDevice 56 · lcPktRate 60 · lcPktData 64 · lcPktMode 68 · lcMoveMask 72 ·
             lcBtnDnMask 76 · lcBtnUpMask 80 · lcInOrg(84,88,92) · lcInExt(96,100,104) ·
             lcOutOrg(108,112,116) · lcOutExt(120,124,128)
           ⛔ 0x0107 那版把「inExt」打在 92/96（实为 lcInOrgZ / lcInExtX）、「outExt」打在
              108/112（实为 lcOutOrgX / lcOutOrgY）—— 字段整体错位一格，真机日志读出来的
              `inExt=(-1023,44800)` 其实是 `lcInOrgZ=-1023, lcInExtX=44800`，排查时白绕一圈
              （当时一度怀疑「结构体布局不对导致 WTOpen 失败」，就是这么被带偏的）。
              现在 inOrg/inExt/outOrg/outExt 四段全打，不再有歧义。 */
        logf("# [ctx] WTOpenA hCtx=0x%llX name=\"%s\" opt=%X msgBase=%X device=%X rate=%ld "
             "pktData=%X pktMode=%X move=%X btnDn=%X btnUp=%X "
             "inOrg=(%ld,%ld,%ld) inExt=(%ld,%ld,%ld) outOrg=(%ld,%ld,%ld) outExt=(%ld,%ld,%ld)\n",
             (unsigned long long)(UINT_PTR)h, (const char*)p,
             *(const unsigned int*)(p + 40), *(const unsigned int*)(p + 52),
             *(const unsigned int*)(p + 56), (long)*(const int*)(p + 60),
             *(const unsigned int*)(p + 64), *(const unsigned int*)(p + 68),
             *(const unsigned int*)(p + 72),
             *(const unsigned int*)(p + 76), *(const unsigned int*)(p + 80),
             (long)*(const int*)(p + 84), (long)*(const int*)(p + 88), (long)*(const int*)(p + 92),
             (long)*(const int*)(p + 96), (long)*(const int*)(p + 100), (long)*(const int*)(p + 104),
             (long)*(const int*)(p + 108), (long)*(const int*)(p + 112), (long)*(const int*)(p + 116),
             (long)*(const int*)(p + 120), (long)*(const int*)(p + 124), (long)*(const int*)(p + 128));
    } else {
        logf("# [ctx] WTOpenA hCtx=0x%llX (logctx=NULL)\n",
             (unsigned long long)(UINT_PTR)h);
    }
    InterlockedIncrement(&g_wtOpenN);
    InterlockedExchange(&g_ctxClosedMs, 0);   /* 0x0133：上下文回来了 */
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
    /* 0x0133：PS 主动关掉了上下文 ⇒ 记时刻，worker 1.5s 后若仍无 WTOpen 就定性。 */
    InterlockedExchange(&g_ctxClosedMs, (LONG)GetTickCount());
    return (u64)(u32)r;
}

/* —— ⑤（LNP hookedWTInfoW）：DPI 虚拟化检测 ——
   LNP 的判据：单显示器且 `lcSysExt` == GetClipBox 的尺寸、**但** != SM_CXVIRTUALSCREEN
   ⇒ 该上下文被 DPI 虚拟化了；它随后把 lcSysExt 改写成真实虚拟屏尺寸并记 dpiRatio。

   ⛔⛔ **偏移已于 2026-10-17 由真机定案（jwwh-3064 的 `[dpi]` 行）** —— 昨天的两套
   猜测**都错**，正确答案是「A 版 144/148、W 版 184/188」，差值是 lcName：

     LOGCONTEXTA 的 `lcName` 是 `char[40]`（40 字节）⇒ lcSysExt 在 **144/148**；
     LOGCONTEXTW 的 `lcName` 是 `WCHAR[40]`（**80** 字节）⇒ 全体字段 **+40**
     ⇒ W 版的 lcSysExt 在 **184/188**。

   证伪过程（拿那行实测值逐个回填，六个字段全部自洽 ⇒ 结论唯一）：
     虚拟屏=(6000,3840)、显示器=2，本次是 **WTInfoW**（cat=4 = WTI_DEFSYSCTX）：
       A 偏移 132/136/140 读到 (-1023, 44800, ?) ⇒ 实为 A-layout 92/96 = **lcInOrgZ=-1023**、
         **lcInExtX=44800**（笔 Z 原点与 X 量程，合理 ✓）
       A 偏移 144/148     读到 (2047, 0)          ⇒ 实为 A-layout 104/108 = **lcInExtZ=2047**、
         **lcOutOrgX=0**（Z 量程与输出原点，合理 ✓）
       A 偏移 160/164     读到 (6000, 3840)       ⇒ 实为 A-layout 120/124 = **lcOutExtX/Y**，
         只是**恰好等于**虚拟屏 —— 昨天据此误判成「LNP 的 +0xA0 是对的」，实为巧合。
     ⇒ 真正的 lcSysExt 在 W 版 = 144+40 = **184/188**，本版按 A/W 分别取。
   默认 fixDpi=0（只观测）。 */
#define LC_SYSEXT_OFF_A   144       /* LOGCONTEXTA：lcSysExtX / lcSysExtY */
#define LC_SYSEXT_OFF_W   184       /* LOGCONTEXTW：同上（lcName 宽字符 ⇒ +40） */
static void wtinfo_observe(const char* which, const unsigned char* p, unsigned int cat, int wide)
{
    if (!p || (cat != WTI_DEFCONTEXT && cat != WTI_DEFSYSCTX)) return;
    InterlockedIncrement(&g_dpiSeen);

    const int off = wide ? LC_SYSEXT_OFF_W : LC_SYSEXT_OFF_A;
    long sx = (long)*(const int*)(p + off);
    long sy = (long)*(const int*)(p + off + 4);

    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    int nMon = GetSystemMetrics(SM_CMONITORS);

    /* ⛔ 只认 X：**Y 不参与判定**（多显示器上下排列时 lcSysExtY 本就可能不等于
       虚拟屏高度，拿它判会误报）。且只在「读到了正数」时才判 —— 读到 0 说明
       偏移仍不对，那是**偏移错**，不是「被虚拟化」。 */
    int mism = (sx > 0 && sx != vw) ? 1 : 0;
    if (mism) InterlockedIncrement(&g_dpiMismatch);
    if (sx > 0) InterlockedExchange(&g_dpiRatioX1000, (LONG)((long long)vw * 1000 / sx));

    logf("# [dpi] ⑤ %s cat=%u %s 虚拟屏=(%d,%d) 显示器=%d "
         "lcSysExt(+%d)=(%ld,%ld)%s dpiRatio=%ld/1000 fixDpi=%d\n",
         which, cat, wide ? "W版" : "A版", vw, vh, nMon,
         off, sx, sy, mism ? "★≠虚拟屏X" : "",
         (long)g_dpiRatioX1000, g_wtctxIni[WTCTX_INI_FIXDPI]);

    if (g_wtctxIni[WTCTX_INI_FIXDPI] && mism) {
        *(int*)((unsigned char*)p + off)     = vw;
        *(int*)((unsigned char*)p + off + 4) = vh;
        logf("# [dpi] ⑤ 已改写 lcSysExt(+%d) = (%d,%d)（fixDpi=1）\n", off, vw, vh);
    }
}

static u64 det_WTInfoA(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)d; (void)e; (void)f;
    typedef UINT (*PFN)(UINT, UINT, void*);
    PFN impl = (PFN)g_lhInfoA.impl;
    UINT r = impl((UINT)a, (UINT)b, (void*)c);
    if (r) wtinfo_observe("WTInfoA", (const unsigned char*)c, (unsigned int)a, 0);
    return (u64)r;
}

static u64 det_WTInfoW(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)d; (void)e; (void)f;
    typedef UINT (*PFN)(UINT, UINT, void*);
    PFN impl = (PFN)g_lhInfoW.impl;
    UINT r = impl((UINT)a, (UINT)b, (void*)c);
    if (r) wtinfo_observe("WTInfoW", (const unsigned char*)c, (unsigned int)a, 1);
    return (u64)r;
}

/* ==================== 0x012F：user32!GetCursorPos / GetMessagePos ====================
   ⛔ 先调真函数 —— 与 LNP FUN_18002c440 第一行 `(*DAT_180180a38)()` 同序：
      真实光标必须先落袋，后面的位移才是「相对真实笔尖」的，而不是相对上一拍的假值。
   ⛔ 只在真实包通路停摆时接管（正常运笔由 Wintab 包路径改写，两条同时改 = 双重滞后）。
   ⛔ 快照必须新鲜（`sn_age_ms <= 300`）：PS 彻底不取包时 snOut 是死值，
      拿它做偏移会把线钉在一个固定位移上 —— 那比不平滑更糟。宁可透传。 */
typedef BOOL  (WINAPI *PFN_GCP)(LPPOINT);
typedef DWORD (WINAPI *PFN_GMP)(void);

static BOOL se_real_GetCursorPos(LPPOINT p)
{
    if (g_lhGcp.impl) return ((PFN_GCP)g_lhGcp.impl)(p);
    return GetCursorPos(p);
}

/* ==================== 0x0137/0x0138：光标路径的**独立推进器**（= LNP 分支 A+C 的等价物） ====================
 * ⛔⛔ 为什么必须与包解耦（O31 逆向定案 + jwwh-13664 / jwwh-22732 实证）：
 *    LNP 的平滑引擎**不是**被 Wintab 包驱动的，而是被「PS 每一次 GetCursorPos 查询」驱动的
 *    （`FUN_180058500` 在每次查询里推进一步，输出直接覆盖 `*pt`）⇒ 所以它断流也不掉平滑。
 * ⇒ 每次查询都把光标喂进一个独立的拉绳推进器，输出覆盖返回值。
 *    绳长/模式与包路径同源（同一份 g_cfg），手感一致；推进器不读任何包快照。
 *
 * ⛔⛔ 0x0138 撤回 0x0137 的「只在停摆期武装」——那条门闩是**根本性错误**，不是参数问题：
 *    jwwh-22732 实录：22:14:41 → 22:15:40 **整整 60 秒**里 PS 问了 8.5 万次光标
 *    （`gcp=19667→106933`），而我们改写次数 `rw` **卡在 5938 一动不动**（`a=0`）——
 *    因为包还在以 200/s 流（`[pk] 真实包=425 (202/s)`）⇒ 门闩认定「没断流 ⇒ 不用接管」。
 *    可用户此刻已经画不出平滑线了：**PS 收着包、却把绘制交给了鼠标路径**
 *    （在画布外的浮窗上按一下再回到画布，PS 的输入通路就切过去了）。
 *    ⇒ 「包流健康」与「PS 在用包画」是**两件事**，门闩把它们当成一件 ⇒ 全天候失手。
 *    ⇒ 新判据只看用户的手：**笔按着就推，笔抬着就透传**。包、断流、前台、画布
 *      一个都不参与「要不要推」的决策（画布只用于「这一段坐标能不能喂」）。
 *
 * ⛔ 绝不搬动真实光标（LNP 只钩 SetCursor 不钩 SetCursorPos，O30 ②）：这里只改返回值。 */
static int   s_gpOn;                    /* 1 = 推进中 */
static int   s_gpBtn;                   /* 上一拍看到的「笔按着」态（0→1 边沿 = 新的一笔） */
static double s_gpX, s_gpY;             /* 平滑点（物理屏幕像素） */
static DWORD s_gpLast;
static DWORD s_gpSeen;                  /* 0x0209：最后一次**确实收到「手按着」证据**的时刻 */

/* 0x0209：手松开后继续「钉住」输出点的时长。
 * ⛔ 为什么必须有（用户报的 BUG2）：本函数的 armed 判据由三路证据并集而成
 *    （按钮镜像 / VK_LBUTTON / 包证据），而这三路**都会抖**：轻压运笔中包证据
 *    成段全零是已知现象（0x0124 就是为它加的 1500ms 长闩），按钮边沿也可能漏采。
 *    旧写法 `if (!armed) return ok;` 在抖动的**那一拍**把真实坐标透传给 PS ⇒
 *    PS 立刻从平滑输出点（用户说的「圆心」）拉一条直线到真实笔尖（「施力点」），
 *    选区末端就此跑到笔尖上，平滑看起来「中途失效」。
 *    ⇒ 抖动窗口内继续返回平滑点（PS 认为笔停住了），只有连续 700ms 没有任何
 *      「按着」的证据才认定真的抬笔、恢复透传。700ms 覆盖实测 400~600ms 的零段。 */
#define GP_HOLD_MS 700

static void gp_step(int rx, int ry, DWORD now, int edge)
{
    if (!g_cfg) return;
    int rp = g_cfg[CFG_I_RADIUSPX];
    if (rp < 1) rp = 1;
    if (rp > RADIUS_PX_MAX) rp = RADIUS_PX_MAX;
    const int mode = g_cfg[CFG_I_MODE];
    double rope = (double)rp * dpi_scale();          /* 逻辑 px → 物理 px（与滤波同源） */
    if (mode == 0)      rope *= 0.60;                /* 标准：略紧一些，避免标准模式过度拖尾 */
    else if (mode == 2) rope *= 0.25;                /* 追笔：本就要求跟手 */
    if (rope < 1.5) rope = 1.5;

    /* ⛔ 起笔必须贴合：`edge` = 这一拍之前笔是抬着的（0→1 边沿）⇒ 输出点直接落到笔尖。
       少了它，上一笔的残留输出点会被当成起点，新一笔开头就被绳拽着走一条斜线
       （LNP 分支 A 的「初始化笔画」干的正是这件事）。 */
    if (edge || !s_gpOn || (LONG)(now - s_gpLast) > 3000) {
        s_gpOn = 1; s_gpX = (double)rx; s_gpY = (double)ry; s_gpLast = now;
        InterlockedIncrement(&g_gpArms);
        return;
    }
    s_gpLast = now;

    double dx = (double)rx - s_gpX, dy = (double)ry - s_gpY;
    double d  = dsqrt_(dx * dx + dy * dy);
    /* 拉绳语义与包路径逐字相同：绳没绷紧（d ≤ 绳长）输出点一像素都不动；
       绷紧则被拖到恰好「绳长」处（f = 1 − 绳长/d，位移 = d − 绳长）。
       ⛔⛔ 0x0209：大跳跃**不再「直接贴合」**。旧写法把输出点一步搬到笔尖，
          那一拍的返回值就是一个 200px 的瞬移 —— 包路径那边 PS 会把它画成一条直线，
          光标路径这边则让 scrubby/选区末端瞬间跳到「施力点」。
          正确做法照 LNP 的 `bigJumpSqDist`：**本拍不推进**（PS 认为笔停住），
          下一拍继续按绳长追 ⇒ 用户看到的是一条追上去的曲线。
          真「抬笔在别处落下」不会走到这里 —— 那条路由 `edge` 直接贴合。 */
    if (d > rope * 4.0) { InterlockedIncrement(&g_gpRej); return; }
    if (d > rope && d > 0.0001) {
        double f = 1.0 - rope / d;
        s_gpX += dx * f; s_gpY += dy * f;
        InterlockedIncrement(&g_gpSteps);
    }
}

static u64 det_GetCursorPos(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)b; (void)c; (void)d; (void)e; (void)f;
    /* 0x013D：面板 unload ⇒ 一个字节都不加工，原样转发。 */
    if (g_engineOff) return (u64)se_real_GetCursorPos((LPPOINT)a);
    LPPOINT p = (LPPOINT)a;
    BOOL ok = se_real_GetCursorPos(p);
    InterlockedIncrement(&g_gcpCalls);
    if (!ok || !p) return (u64)ok;

    DWORD nowT = GetTickCount();
    /* ⛔⛔ 0x0138：「要不要推」只问用户的手（LNP 分支 A/C），**三个来源取并集**：
         · keyhook_mouse_state 的 mseDown —— WH_MOUSE_LL 的**事件**镜像电平
           （Wintab 独占时鼠标模拟只发边沿、VK_LBUTTON 电平可能读 0 ⇒ 这是主证据源）；
         · GetAsyncKeyState(VK_LBUTTON) —— 系统电平兜底；
         · g_penDown / g_mseTip —— 包证据与断流期推断（有就并上，没有也不挡）。
       ⛔ 三类证据**只加不减**（铁律 27）：任一条说「按着」就按着；
          任一条说「抬着」都**不能**否决另一条 —— 否决 = 0x012B 那道守卫的老路。
       ⛔ 包里一个字段都不读；断流与否、前台是谁、包龄多大，全部不参与判定。 */
    int btn = 0;
    {
        int mDown = 0;
        if (keyhook_mouse_state(&mDown, NULL, NULL, NULL, NULL, NULL) && mDown) btn = 1;
        if (!btn && (GetAsyncKeyState(VK_LBUTTON) & 0x8000)) btn = 1;
    }
    int stroke = btn || (g_penDown != 0) || ((LONG)g_mseTip != 0);
    /* 0x0209：手松开后先「钉住」输出点，不立刻透传（根因见 GP_HOLD_MS 处长注释）。 */
    int hold = (s_gpOn && (DWORD)(nowT - s_gpSeen) <= GP_HOLD_MS) ? 1 : 0;
    int armed = 0;
    /* ⛔⛔ 0x013D：**工具闸门必须参与光标路径**。
       0x0138 撤掉的是「断流才接管」那道门闩（包流健康 ≠ PS 在用包画），
       **不是**工具闸门 —— 本路径当时只判 enabled+按笔，于是铅笔/橡皮/画笔下
       系统光标仍在被拉绳推着走，用户感知就是「平滑作用到了别的工具」。
       ⛔ 0x0209：判据换成与包路径**同一个** `tool_edit_allowed()`。
          旧写法这里调 `tool_gate_ok()`，于是面板心跳一过期（3s）光标路径就停止改写，
          而包路径还靠闩锁继续 —— 两条路各判一次，漂移一次就分叉：
          HUD（包路径快照）还在圆心，PS 的选区末端（光标路径）已经跳到笔尖。
          「圆心与受力点不再重合」就是这么来的。 */
    if (g_wtctxIni[WTCTX_INI_CURSORINJECT] && (stroke || hold) && tool_edit_allowed())
        armed = 1;
    /* 0x0208：视图导航（空格 = 抓手，Ctrl+空格 = 缩放）期间绝不改写返回值。
       ⛔ 这条比工具闸门更靠前地被触发：缩放期间 PS 不切工具（仍是套索 ⇒ 闸门绿），
          而 scrubby zoom 的缩放级别**就是光标位移的函数** —— 喂滞后坐标 = 抽搐。
       ⛔ 不推绳、不贴笔：下面的 `!armed` 分支会把 s_gpOn/s_gpBtn 复位，
          导航结束后的第一拍按「0→1 边沿」处理 ⇒ 输出点重新贴合笔尖，不会把
          导航前的残留点连成一条斜线。 */
    if (armed && view_nav_down()) armed = 0;
    InterlockedExchange(&g_gcpArmed, armed);
    if (!armed) { s_gpOn = 0; s_gpBtn = 0; return (u64)ok; }

    /* 0x0209：已武装但这一拍**没有**「手按着」的证据 ⇒ 钉住输出点。
       ⛔ 既不推进（不跟着已经抬起的手跑），也不透传（不让 PS 看到真实坐标）。
          这一分支就是「停笔后 PS 自己画一条从圆心到笔尖的直线」的封堵点。
       ⛔ `s_gpBtn` 归零：手已松开 ⇒ 下一次按着的瞬间必须算新一笔的边沿。 */
    if (!stroke) {
        s_gpBtn = 0;
        if (!s_gpOn) return (u64)ok;                 /* 还没真正起过笔 ⇒ 透传 */
        LONG nx0 = (LONG)(s_gpX >= 0 ? s_gpX + 0.5 : s_gpX - 0.5);
        LONG ny0 = (LONG)(s_gpY >= 0 ? s_gpY + 0.5 : s_gpY - 0.5);
        if (nx0 == p->x && ny0 == p->y) return (u64)ok;
        p->x = nx0; p->y = ny0;
        InterlockedIncrement(&g_gcpRw);
        return (u64)ok;
    }
    s_gpSeen = nowT;                                  /* 只有「按着」的证据才能续期 */

    /* 0→1 边沿 = 新的一笔 ⇒ 输出点贴合笔尖（LNP 分支 A 的「初始化笔画」）。 */
    int edge = !s_gpBtn;
    s_gpBtn = 1;

    {   /* 接管切换打一行（限流 2s），下一轮靠它确认「光标路径到底有没有在推」 */
        static DWORD s_logMs;
        if (!s_gpOn && (DWORD)(nowT - s_logMs) >= 2000) {
            s_logMs = nowT;
            logf("# [gcp] ★光标路径接管（LNP 分支 A/C）：每次查询推进一步，"
                 "判据=笔按着(btn=%d mse=%d pen=%d) 光标=(%ld,%ld) 绳=%.0fpx 模式=%d\n",
                 btn, (int)(g_penDown != 0), (int)g_mseTip,
                 (long)p->x, (long)p->y,
                 (double)g_cfg[CFG_I_RADIUSPX] * dpi_scale(), (int)g_cfg[CFG_I_MODE]);
        }
    }
    {
        LONG rx = p->x, ry = p->y;
        /* ⛔ 画布宽判只决定「这一段坐标能不能喂」，**不决定要不要推**：
           笔落在别的窗口上时把输出**钉住**（与包路径的「喂入冻结」同一语义），
           避免把画布外的坐标灌进绳子里被 PS 钳到画布边界（LNP 那个锯齿轮廓 BUG）。
           ⛔ 用宽判（不看前台），否则切窗口就整段失效（0x0134 铁律 12）。 */
        POINT cur; cur.x = rx; cur.y = ry;
        if (canvas_hit_ok(cur)) {
            gp_step((int)rx, (int)ry, nowT, edge);
        } else if (!s_gpOn) {
            return (u64)ok;                              /* 还没起笔 ⇒ 直接透传 */
        } else {
            s_gpLast = nowT;                             /* 钉住：位置不变，只续时限 */
        }
        LONG nx = (LONG)(s_gpX >= 0 ? s_gpX + 0.5 : s_gpX - 0.5);
        LONG ny = (LONG)(s_gpY >= 0 ? s_gpY + 0.5 : s_gpY - 0.5);
        if (nx == rx && ny == ry) return (u64)ok;        /* 没差异 ⇒ 一个字节都不动 */
        p->x = nx; p->y = ny;
        InterlockedIncrement(&g_gcpRw);
        return (u64)ok;
    }
}

/* ===================== user32!GetCursorPos 的**导入表（IAT）**接管（0x0131）
   ⛔⛔ 为什么不能像 Wintab32 那样直接打入口 5 字节 —— jwwh-39120 的实测证据：
      `user32!GetCursorPos` 入口首字节 = **BA**（不是 E9 转发桩），说明那是一段**真代码**。
      我们的 LHOOK 机制是「顺着 E9 找到真函数，detour 里直调它」；打真代码入口必须
      先造 trampoline（把被覆盖的那几条指令搬出来再跳回），而 `BA` 到底是
      「mov edx,imm32（5 字节一条指令）」还是「BT/BTS/BTR/BTC 组（后跟 ModRM，只有 3 字节）」，
      **在没有反汇编器的情况下不能猜** —— 猜错就是把 PS 的代码从中间劈开 = 当场崩。
   ⇒ 换一条零风险的等价路：**只改 PS 自己导入表里的那根指针**。
      PS 每次调 GetCursorPos 都要走它自己 IAT 里的槽，我们把这个槽指向我们的 detour：
        · user32 的代码一个字节都没动（无指令长度问题，也不碰只读共享页）；
        · 写时复制，只影响本进程；
        · 我们自己的模块**不参与**扫描 ⇒ `se_real_GetCursorPos()` 里那句
          `GetCursorPos(p)` 拿到的仍是系统真函数，不会自己吃自己。
   ⛔ 覆盖不到的只有「用 GetProcAddress 现取地址」的调用方（PS 一般是静态导入）；
      真机上 `gcp=` 恒 0 就说明它走的是现取，那时再考虑入口 trampoline。 */
static int g_gcpIatSlots;      /* 已改写的 IAT 槽数（累计） */
static int g_gcpIatTried;
static int g_gcpIatSweeps;

static int iat_patch_one(HMODULE hMod, const char* wantDll, const char* wantFn, void* repl)
{
    u8* base = (u8*)hMod;
    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    IMAGE_NT_HEADERS* nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;
    DWORD impRva = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
    if (!impRva) return 0;
    IMAGE_IMPORT_DESCRIPTOR* d = (IMAGE_IMPORT_DESCRIPTOR*)(base + impRva);
    int n = 0;
    for (; d->Name; d++) {
        const char* mod = (const char*)(base + d->Name);
        if (_stricmp(mod, wantDll) != 0) continue;
        IMAGE_THUNK_DATA* oft = (IMAGE_THUNK_DATA*)(base + (d->OriginalFirstThunk ? d->OriginalFirstThunk
                                                                                : d->FirstThunk));
        IMAGE_THUNK_DATA* ft = (IMAGE_THUNK_DATA*)(base + d->FirstThunk);
        for (int i = 0; ft[i].u1.Function; i++) {
            if (oft[i].u1.Ordinal & IMAGE_ORDINAL_FLAG) continue;   /* 按序号导入，无名字 */
            IMAGE_IMPORT_BY_NAME* ibn = (IMAGE_IMPORT_BY_NAME*)(base + oft[i].u1.AddressOfData);
            if (!ibn || strcmp((const char*)ibn->Name, wantFn) != 0) continue;
            void** slot = (void**)&ft[i].u1.Function;
            if (*slot == repl) continue;                            /* 已经是我们，别重复 */
            DWORD old = 0;
            if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &old)) continue;
            *slot = repl;
            VirtualProtect(slot, sizeof(void*), old, &old);
            n++;
        }
    }
    return n;
}

/* 扫一遍本进程所有已加载模块的导入表。可重复调用（模块是陆续加载的）。 */
static void gcp_iat_sweep(int verbose)
{
    typedef BOOL (WINAPI *PFN_EPM)(HANDLE, HMODULE*, DWORD, LPDWORD);
    static PFN_EPM s_epm;
    if (!s_epm) {
        HMODULE k32 = GetModuleHandleA("kernel32.dll");
        if (k32) {
            s_epm = (PFN_EPM)(void*)GetProcAddress(k32, "K32EnumProcessModules");
            if (!s_epm) s_epm = (PFN_EPM)(void*)GetProcAddress(k32, "EnumProcessModules");
        }
    }
    if (!s_epm) {
        if (verbose) logf("# [gcp] 拿不到 EnumProcessModules ⇒ 导入表接管不可用\n");
        return;
    }
    g_gcpIatTried = 1;
    g_gcpIatSweeps++;
    HMODULE mods[256];
    DWORD need = 0;
    if (!s_epm(GetCurrentProcess(), mods, (DWORD)sizeof(mods), &need)) return;
    DWORD cnt = need / (DWORD)sizeof(HMODULE);
    if (cnt > 256) cnt = 256;
    HMODULE self = NULL;
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCSTR)(void*)&gcp_iat_sweep, &self);
    int added = 0;
    for (DWORD i = 0; i < cnt; i++) {
        if (!mods[i] || mods[i] == self) continue;      /* ⛔ 绝不改自己（否则真函数调用自激） */
        int k = iat_patch_one(mods[i], "USER32.dll", "GetCursorPos", (void*)det_GetCursorPos);
        if (k <= 0) continue;
        added += k;
        if (verbose) {
            char nm[MAX_PATH];
            if (GetModuleFileNameA(mods[i], nm, (DWORD)sizeof(nm))) {
                const char* p = strrchr(nm, '\\');
                logf("# [gcp] 导入表接管 GetCursorPos: %s（%d 槽）\n", p ? p + 1 : nm, k);
            }
        }
    }
    g_gcpIatSlots += added;
    if (verbose || added > 0)
        logf("# [gcp] 导入表扫第 %d 轮：模块 %lu 个，本次改写 %d 槽，累计 %d 槽\n",
             g_gcpIatSweeps, (unsigned long)cnt, added, g_gcpIatSlots);
}

/* ============ 0x0136：Windows Ink 主动探针（第四路，LNP 明确在用而我们一直缺）
   ⛔ 为什么非做不可 —— jwwh-23344 vs jwwh-23992 的对照把话说死了：
      · 无 LNP（23344）：断流且笔按着时，`[raw] 现值` 连续 4 次一模一样 (1260,1311)
        ⇒ 系统光标**冻死** ⇒ 我们的 GetCursorPos 接管没有原料 ⇒ 平滑失效。
      · 有 LNP（23992）：同样 `真实包=0` 的 105 秒里，`现值` 一路在变
        (1823,924)→(2150,751)→(2248,829)→(4148,249)→… ⇒ 光标**完整跟笔**
        ⇒ PS 退回鼠标路径照画，我们的 IAT 接管把平滑坐标喂给它 ⇒ rw 涨到 6 万次。
      ⇒ 结论：我们的平滑引擎没错，缺的是「断流期笔在哪」这个坐标。
        Wintab 包空、系统光标冻，只剩 Windows Ink 没试过 —— LNP 恰恰钩了
        `GetPointerInfo/History` 全家桶（O30 ②）。
   ⛔ 这里**主动拉取**（不依赖 PS 调不调）：断流时 PS 可能根本不问 Ink，
      被动挂钩就永远等不到。每 100ms 枚举 pointerId 0..31 各问一次，只读。 */
typedef struct {          /* POINTER_INFO 前 40 字节（x64 布局） */
    unsigned int type;    /* 0  pointerType（PT_PEN = 2） */
    unsigned int id;      /* 4  pointerId */
    unsigned int frame;   /* 8  frameId */
    unsigned int flags;   /* 12 pointerFlags */
    void*        dev;     /* 16 sourceDevice */
    void*        hwnd;    /* 24 hwndTarget */
    long         px;      /* 32 ptPixelLocation.x */
    long         py;      /* 36 ptPixelLocation.y */
} INKPI;
#define INK_INRANGE  0x00000001u
#define INK_INCONTACT 0x00000004u
#define INK_PT_PEN   2u

typedef BOOL (WINAPI *PFN_GetPointerInfo)(unsigned int, void*);
static PFN_GetPointerInfo s_pfnGpi;
static int  s_gpiTried;
static volatile LONG g_inkHits;    /* 命中「有笔设备」的轮次 */
static volatile LONG g_inkContact; /* 其中笔尖接触的轮次 */
static volatile LONG g_inkX, g_inkY;
static volatile LONG g_inkContactNow;

static void ink_probe_tick(void)
{
    if (!s_pfnGpi) {
        if (s_gpiTried) return;
        s_gpiTried = 1;
        HMODULE u = GetModuleHandleA("user32.dll");
        if (u) s_pfnGpi = (PFN_GetPointerInfo)(void*)GetProcAddress(u, "GetPointerInfo");
        if (!s_pfnGpi) { logf("# [ink] user32!GetPointerInfo 拿不到 ⇒ Windows Ink 这条路不可用\n"); return; }
        logf("# [ink] 探针就绪：每 100ms 枚举 pointerId 1..32（只读，不改任何行为）\n");
    }
    int pen = 0, contact = 0, px = 0, py = 0;
    for (unsigned int id = 1; id <= 32; id++) {
        INKPI pi;
        memset(&pi, 0, sizeof(pi));
        if (!s_pfnGpi(id, &pi)) continue;
        if (pi.type != INK_PT_PEN) continue;
        pen = 1;
        if (pi.flags & INK_INCONTACT) { contact = 1; px = (int)pi.px; py = (int)pi.py; }
        else if (!contact) { px = (int)pi.px; py = (int)pi.py; }
    }
    if (pen) {
        InterlockedIncrement(&g_inkHits);
        InterlockedExchange(&g_inkX, px);
        InterlockedExchange(&g_inkY, py);
        InterlockedExchange(&g_inkContactNow, contact);
        if (contact) InterlockedIncrement(&g_inkContact);
    } else {
        InterlockedExchange(&g_inkContactNow, 0);
    }
}

/* GetMessagePos：LNP 同样挂钩（返 DWORD 打包的屏幕坐标）。本版**只计数**，
   用来判定「PS 到底从哪条路取坐标」，下一版再决定要不要一起改写。 */
static u64 det_GetMessagePos(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    (void)a; (void)b; (void)c; (void)d; (void)e; (void)f;
    PFN_GMP impl = (PFN_GMP)g_lhGmp.impl;
    DWORD r = impl ? impl() : GetMessagePos();
    InterlockedIncrement(&g_gmpCalls);
    return (u64)r;
}

static u64 det_WTPacketsGet(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f)
{
    /* d/e/f 只为凑齐 ABI 参数位（转发桩是 `jmp`，不搬栈）：
       WTPacketsGet 只用到前三个，多出的声明不会被读取。 */
    (void)d; (void)e; (void)f;
    static int  s_cfgTick;
    PFN_WTPacketsGet impl = (PFN_WTPacketsGet)g_impl;
    /* 0x013D：面板 unload ⇒ 原样交还驱动数据，不改写一个字节、不留一个快照。 */
    if (g_engineOff) return (u64)impl((HCTX)a, (int)b, (void*)c);
    int r = impl((HCTX)a, (int)b, (void*)c);            /* 先取包，再加工 */
    int rRaw = r;                                       /* 驱动**原始**返回（丢包前的「通路活着」凭据） */
    DWORD nowT = GetTickCount();
    int synth = 0;

    /* ⛔ 进这一拍**之前**真实通路静默了多久 —— 「刚经历过停摆」的判据。
       必须在下面更新 `g_lastRealMs` 之前取，否则永远算成 0。 */
    LONG prevRealAge = g_lastRealMs ? (LONG)(nowT - (DWORD)g_lastRealMs) : 0x7FFFFFFF;

    InterlockedIncrement(&g_calls);
    g_ctxNow = (HCTX)a;                                 /* 断流诊断：看门狗要比对上下文 */

    /* —— 突发计量：单次最大包数 / 冲包次数 / 零包次数 —— */
    if (r > 0) {
        if (r > (int)g_pkMax) InterlockedExchange(&g_pkMax, (LONG)r);
        if (r >= RI_BIG_BURST) InterlockedIncrement(&g_pkBig);
    } else {
        InterlockedIncrement(&g_pkZero);
    }

    /* —— 时间基的**正面证据** + 停摆恢复打点（2026-10-16 第十八轮）——
       ⛔⛔ 上一版（0x0111）用「陈旧程度」反推「时间基是否相同」：
              |now − pkTime| ≤ 5000 ⇒ 同基，否则放弃判据。
           这条看似稳妥，实则把两个量纲混成一个：停摆 13s（真机实测）或 111s 时，
           恢复冲包的头几个包**天生**就是 13000/111000ms 旧，于是「不同基」被误判、
           判据整条丢弃 ⇒ 真机日志里 `陈旧包` 恒 0、`陈旧回包合并` 一次都没触发，
           过冲原样复现。**判陈旧的能力必须与时间基的证明彻底解耦。**
       ⇒ 现在改用正面证据：只要**见过**一个 age ∈ [0, RI_PKT_FRESH_MS] 的包，
         就说明两路同基（正常运笔时 age 实测 15~16ms，必然成立），此后
         前沿比较不再受任何幅度限制 —— 多旧的包都照样判得出。
       另一条判据（包龄 > RI_PKT_STALE_MS）覆盖「停摆期间没有补流可当前沿」的情形。 */
    if (rRaw > 0) {
        int st0 = g_calib.stride;
        if (!g_pkBaseOk && g_calib.offTime >= 0 && st0 > 0 && g_calib.offTime + 4 <= st0) {
            u32 pt0 = 0;
            memcpy(&pt0, (const u8*)c + g_calib.offTime, 4);
            LONG d0 = (LONG)(nowT - pt0);
            if (pt0 != 0 && d0 >= 0 && d0 <= RI_PKT_FRESH_MS) {
                InterlockedExchange(&g_pkBaseOk, 1);
                InterlockedExchange(&g_baseEvt, 1);     /* 落盘交给 worker */
            }
        }
        if (prevRealAge >= RI_STALL_MS) InterlockedExchange(&g_lastRecovMs, (LONG)nowT);
    }

    /* ⛔ 共享内存低频重试：**必须无条件**（2026-10-16 第十六轮）。
       旧版把它关在下面的 `if (r > 0)` 里 ⇒ 若「插件一上电就断流」，`r` 恒 0、
       `cfg_open()` 永不重试 ⇒ `g_cfg` 永远 NULL ⇒ 补流与平滑**一起**失效。
       采样源换成系统光标后这条尤其致命：断流期恰恰是 `r == 0` 占绝对多数。 */
    if (!g_cfg && ((++s_cfgTick & 0xFF) == 0)) cfg_open();

    /* —— 独立笔通路（2026-10-16 第十四轮）：只补流、只在真实通路空转时 ——
       ⛔ 门控总闸 g_synOn 由 worker 的拟合结果驱动（见 penraw_fit_tick）；它不成立时
          本段等价于空语句，行为与 0x010C 逐位相同 —— 这是本版**不会引入回归**的依据。
       ⛔⛔ `enNow`（面板开关 + 心跳防呆）**必须在补流之前算出来**：
          补流是「往调用方缓冲里写坐标」，比平滑更"越界" ——
          用户关掉开关就该一个字节都不动。旧版把它放在 r>0 之后、补流之前没检查 ⇒
          关掉开关也照补（这是本轮自查出来的漏洞，不是真机报的）。 */
    LONG enNow = 0;
    if (g_cfg) {
        enNow = g_cfg[CFG_I_ENABLED];
        if (enNow && (DWORD)(nowT - (DWORD)g_cfg[CFG_I_HEARTBEAT]) > 3000) enNow = 0;
    }
    /* ⛔⛔ 0x0120：接管保持 —— 已接管（g_synWas）期间不再逐拍复验 g_synOn。
       worker 每 2s 的复验在阈值边缘会把总闸抖成 0，救援被自己拆台
       （真机 jwwh-37300 18:12:24.687：接管 1.1s 后按「引擎已关闭」退出，
       余下 9.4s 冻结到驱动自愈）。首次接管仍要求 g_synOn；保持期间
       calib.valid / enNow / 真路空转 / 采样源新鲜全部照旧硬性把关，
       交还仍只由真实条件驱动（0x0117 语义不变）。 */
    if ((g_synOn || g_synWas) && g_calib.valid && enNow) {
        LONG rawAge = g_riLastMs ? (LONG)(nowT - (DWORD)g_riLastMs) : 0x7FFFFFFF;
        /* ⛔ 两层闸门缺一不可：
           ① `realAge >= RI_STALL_MS` —— **真实通路**已空转（这是"该不该接管"的判据）；
           ② `rawAge <= RI_FRESH_MS` —— 采样源还活着、样本是新的（"能不能接管"的判据）。
           只留 ② 会在驱动正常时也一直补流（见 g_lastRealMs 注释）。 */
        LONG realAge = g_lastRealMs ? (LONG)(nowT - (DWORD)g_lastRealMs) : 0x7FFFFFFF;
        if (r == 0 && realAge >= RI_STALL_MS
            && rawAge >= 0 && rawAge <= RI_FRESH_MS && g_riIn) {
            int k = penraw_synth((void*)c, (int)b, nowT);
            if (k > 0) {
                r = k;
                InterlockedExchange(&g_synLastMs, (LONG)nowT);
                InterlockedExchangeAdd(&g_synPkts, (LONG)k);
                InterlockedIncrement(&g_synRuns);
            }
            /* ⛔⛔ 0x0117：`k == 0` = **本轮没有新样本可喂**（光标采样 64Hz 与 PS
               轮询 ~64Hz 相位错开时的正常空转拍），**不是**「驱动恢复了」。
               旧代码把 k>0 当接管、k==0 当交还 ⇒ 真机 jwwh-32984 的 25s 断流里
               「接管/交还」翻了 6 次，每一次都是假交还，日志把空转报成
               「真实通路已回包，交还给驱动」—— 排障时完全被带偏。
               ⇒ 接管条件成立即置 synth=1（状态机只看条件，不看得包数），
               交还只发生在条件真正不成立时（真包回来了 / 采样源死了 / 开关撤了）。 */
            synth = 1;
        }
        /* ⛔ 丢冲包：刚补过流、真实通路又一次性吐回一大批 ⇒ 丢掉。
           不丢的话 PS 会先按补流画到光标、再把几十个**旧**坐标重放一遍 ⇒
           整根弧线倒着画回去，比不补流更难看（补流的收益全被吃掉）。 */
        if (!synth && r >= RI_BIG_BURST && g_synLastMs) {
            LONG dGap = (LONG)(nowT - (DWORD)g_synLastMs);
            if (dGap >= 0 && dGap <= 2000) {
                InterlockedExchangeAdd(&g_dropBurst, (LONG)r);
                InterlockedExchange(&g_dropLast, (LONG)r);
                r = 0;
            }
        }
    }

    /* —— 陈旧回包合并 v2（2026-10-16 第十八轮）：把「判陈旧」与「证时间基」解耦 ——
       ⛔ 上面那条「单次 ≥ RI_BIG_BURST 包 = 冲包」的判据在真机上是**死代码**：
          PS 每拍只取 1~5 包（真机日志实测 最大单次 ∈ {0,1,3,4,5}、≥25包次数恒 0），
          于是 48 包的恢复冲包被拆成十几拍、一拍都到不了 25 ⇒「丢冲包」恒为 0。
       现象（用户报的「过冲」，真机两次复现）：
          补流已经把笔尖喂到**当下**，驱动恢复时再把停摆期攒下的旧坐标**追加**在它
          后面 ⇒ 选区路径先倒退再猛追；随即收笔、选区一次性生成、自动填充。
          低配机填充更久 ⇒ 队列攒得更多 ⇒ **必现**。
       ⛔ 判据与包数**无关**，且**不依赖补流是否发生过**（两条并列，任一成立即算陈旧）：
          ① 早于补流前沿：`pkTime < g_synFrontT` —— 这段位移补流已经喂过；
          ② 包龄过大：`now − pkTime > RI_PKT_STALE_MS` —— 停摆期没补流可当前沿时的凭据。
       只丢**队首连续**的一段（包按时间递增），一旦遇到新鲜包立刻停手。
       ⛔⛔ fail-open 护栏（任一不成立就一个字节都不动）：
          · `g_pkBaseOk` —— 时间基已被**正面证明**（见上面的取证段落）。
            旧版在这里用「陈旧幅度」当同基判据 ⇒ 13s/111s 级的真陈旧包被当成
            「不同基」而整条放弃 ⇒ 判据全死（真机 陈旧包 恒 0）。这是本轮的根因。
          · `g_lastRecovMs` 恢复窗口 RI_RECOV_MS —— 只在「刚从停摆恢复」的窗口内动手，
            平时两路本来就同步，也没有陈旧可言。
          · offTime 必须已标定。 */
    if (!synth && r > 0 && (g_synFrontT || g_lastRecovMs)) {
        LONG sinceRecov = g_lastRecovMs ? (LONG)(nowT - (DWORD)g_lastRecovMs) : 0x7FFFFFFF;
        int stride = g_calib.stride;
        if (g_pkBaseOk && g_lastRecovMs && sinceRecov >= 0 && sinceRecov <= RI_RECOV_MS
            && stride > 0 && g_calib.offTime >= 0 && g_calib.offTime + 4 <= stride) {
            u32  front = (u32)g_synFrontT;
            int  n = 0, nAge = 0;
            LONG newest = 0;
            while (n < r) {
                const u8* q = (const u8*)c + (SIZE_T)n * stride;
                u32 pt = 0;
                memcpy(&pt, q + g_calib.offTime, 4);
                LONG age = (LONG)(nowT - pt);
                if (pt == 0 || age < 0) break;                     /* 时间戳不可信 ⇒ 停手 */
                LONG behind = (LONG)(front - pt);                  /* >0 = 早于补流前沿 */
                int byFront = (g_synFrontT && behind > 0);
                int byAge   = (age > RI_PKT_STALE_MS);
                if (!byFront && !byAge) break;                     /* 新鲜 ⇒ 后面都是新的 */
                if (byFront && behind > newest) newest = behind;
                if (!byFront && byAge) nAge++;                     /* 只有按龄判掉的那部分 */
                n++;
            }
            if (n > 0) {
                if (n < r) {                                       /* 把后面的新鲜包压到队首 */
                    u8* dst = (u8*)c;
                    const u8* src = (const u8*)c + (SIZE_T)n * stride;
                    for (SIZE_T i = 0; i < (SIZE_T)(r - n) * (SIZE_T)stride; i++) dst[i] = src[i];
                }
                r -= n;
                InterlockedExchangeAdd(&g_dropStaleN, (LONG)n);
                InterlockedExchangeAdd(&g_dropStaleAgeN, (LONG)nAge);
                InterlockedExchange(&g_dropStaleMs, newest);
                InterlockedExchange(&g_dropStaleEvt, 1);
            }
        }
    }

    /* ⛔ 真实通路「活着」的凭据必须按**驱动原始返回**记，不能用丢包后的 `r`：
       否则把一次恢复冲包丢干净的那几拍 r 会变 0 ⇒ `g_lastRealMs` 不更新 ⇒
       `realAge` 继续增长 ⇒ 补流继续接管 —— 而驱动其实早已恢复（自锁到死）。 */
    if (rRaw > 0) InterlockedExchange(&g_lastRealMs, (LONG)nowT);

    /* 补流进出事件（只置原子，落盘交给 worker） */
    if (synth && !g_synWas) {
        g_synWas = 1; g_synT0L = nowT;
        InterlockedExchange(&g_synEnter, 1);
    } else if (!synth && g_synWas) {
        g_synWas = 0;
        InterlockedExchange(&g_synSpanMs, (LONG)(nowT - g_synT0L));
        /* 0x0137：补流交还 ⇒ 下一批 buttons 重新对表（详见 g_btnResync 定义处）。 */
        InterlockedExchange(&g_btnResync, 1);
        /* ⛔⛔ 0x0118：退出原因必须按真实路径分类落盘。旧版恒打印
           「真实通路已回包，交还给驱动」—— 真机 jwwh-36936 16:01:34.879 那条
           就是假话：同帧 [pk] 真实包=0，真实退出原因是 enNow=0（面板拨了
           开关 OFF ⇒ commit(0) ⇒ cmd=2 撤钩）。一句错的归因把整场排障带偏，
           才会有人顺着「驱动恢复了」去查 Wintab，而真凶在状态机里。 */
        LONG why;
        if (rRaw > 0)               why = 0;   /* 真通路回包：唯一正常的交还 */
        else if (!g_synOn)          why = 1;   /* 引擎被关：拟合失效（syn_set 置 0；撤钩的直接落账在 do_unhook） */
        else if (!enNow)            why = 2;   /* 面板开关 OFF / 心跳超时（commit(0)） */
        else if (!g_calib.valid)    why = 3;   /* 标定失效：指纹变化重置（cmd=1 已不再作废，见 0x0118） */
        else                        why = 4;   /* 采样源死：rawAge 超窗或 g_riIn=0 */
        InterlockedExchange(&g_synExitWhy, why);
        InterlockedExchange(&g_synExit, 1);
    }

    if (r > 0) {
        InterlockedExchangeAdd(&g_packets, (LONG)r);
        if (!synth) {
            InterlockedExchangeAdd(&g_pkReal, (LONG)r);
            InterlockedExchange(&g_lastRealMs, (LONG)nowT);   /* 补流门控凭据：真实包确实来了 */
            /* 只在**真实包**且非冲包时配对（见 penraw_maybe_pair 的三条过滤） */
            penraw_maybe_pair((const u8*)c, r, nowT);
        }
        if (g_cfg) {
            LONG en = enNow;    /* 上面已按「面板开关 + 心跳防呆」算好，这里不再重读 */
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
        /* ⛔ 落笔「记忆」：必须在 smooth_packets 之后读 g_penDown（它在那里面更新）。
           放在 if(g_cfg) 之外 ⇒ 关掉平滑开关时也照样记，恢复时不会错判。 */
        if (!synth) InterlockedExchange(&g_lastRealTip, (LONG)g_penDown);
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
    g_wtBase = (void*)imgBase;            /* ⑧ 记录，供 se_wt_moved() 比对 */
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
            g_lhOpenW.detour = (void*)det_WTOpenW;
            g_lhClose.detour = (void*)det_WTClose;
            g_lhInfoA.detour = (void*)det_WTInfoA;
            g_lhInfoW.detour = (void*)det_WTInfoW;
            /* 0x012F：user32 两路（照搬 LNP）。⛔ 它们**不碰 PS 的结构**，只在
               「断流 + 一笔之中 + cursorInject=1」时改 GetCursorPos 的输出副本。 */
            g_lhGcp.detour   = (void*)det_GetCursorPos;
            g_lhGmp.detour   = (void*)det_GetMessagePos;
            LHOOK* lhs[8] = { &g_lhPkt1, &g_lhOpen, &g_lhOpenW, &g_lhClose,
                              &g_lhInfoA, &g_lhInfoW, &g_lhGcp, &g_lhGmp };
            for (int i = 0; i < 8; i++) {
                if (!lhook_prepare(lhs[i])) continue;
                lhook_commit(lhs[i]);
            }
        }
    }
    thaw_threads();
    /* ⛔ 必须在 do_install 里读（低频、且要在 det_WTOpenA 可能被调用之前）：
       ④⑤ 的改写开关与 ⑥ 的队列尺寸都来自这个文件，读到什么值决定上面三个钩
       是「只观测」还是「真改写」。 */
    wtctx_read_ini();
    /* 0x0131：user32!GetCursorPos 的入口是真代码（首字节 BA），LHOOK 的「顺 E9 找真函数」
       模型挂不上 ⇒ 改走**导入表**（见 gcp_iat_sweep 上方的取舍说明）。
       只在开关打开时动手；缺省 cursorInject=1（见 wtctx_read_ini 里的 0x0131 注释）。 */
    if (g_wtctxIni[WTCTX_INI_CURSORINJECT]) gcp_iat_sweep(1);
    else logf("# [gcp] cursorInject=0 ⇒ 不接管 GetCursorPos（只观测，gcp 计数照旧）\n");
    logf("# 挂载: %s  entry=0x%llX impl=0x%llX relay=0x%llX（改写期挂起线程 %d 个）\n",
         ok ? "OK" : g_skip, (unsigned long long)(UINT_PTR)g_entry,
         (unsigned long long)(UINT_PTR)g_impl, (unsigned long long)(UINT_PTR)g_relay, g_frzLast);
    if (g_cfg) g_cfg[CFG_I_FROZE] = g_frzLast;
    logf("# 诊断钩: WTPacket=%s WTOpenA=%s WTOpenW=%s WTClose=%s WTInfoA=%s WTInfoW=%s "
         "GetCursorPos=%s GetMessagePos=%s\n",
         g_lhPkt1.patched ? "挂" : (g_lhPkt1.skip[0] ? g_lhPkt1.skip : "未挂"),
         g_lhOpen.patched ? "挂" : (g_lhOpen.skip[0] ? g_lhOpen.skip : "未挂"),
         g_lhOpenW.patched ? "挂" : (g_lhOpenW.skip[0] ? g_lhOpenW.skip : "未挂"),
         g_lhClose.patched ? "挂" : (g_lhClose.skip[0] ? g_lhClose.skip : "未挂"),
         g_lhInfoA.patched ? "挂" : (g_lhInfoA.skip[0] ? g_lhInfoA.skip : "未挂"),
         g_lhInfoW.patched ? "挂" : (g_lhInfoW.skip[0] ? g_lhInfoW.skip : "未挂"),
         g_lhGcp.patched ? "挂" : (g_lhGcp.skip[0] ? g_lhGcp.skip : "未挂"),
         g_lhGmp.patched ? "挂" : (g_lhGmp.skip[0] ? g_lhGmp.skip : "未挂"));
}

static void do_unhook(void)
{
    if (!g_patched || !g_entry) return;
    lhook_restore(&g_lhPkt1);
    lhook_restore(&g_lhOpen);
    lhook_restore(&g_lhOpenW);
    lhook_restore(&g_lhClose);
    lhook_restore(&g_lhInfoA);
    lhook_restore(&g_lhInfoW);
    lhook_restore(&g_lhGcp);
    lhook_restore(&g_lhGmp);
    freeze_threads();
    int ok = repatch(g_entry, g_orig);
    thaw_threads();
    if (ok) InterlockedExchange(&g_patched, 0);
    /* 撤钩后闸门语义不再成立 ⇒ 清掉，否则 HUD 会以为「还在平滑」而永久驻留。
       ⛔ 这里用裸 InterlockedExchange 而不是 gate_set()：撤钩不是一次「收笔」，
          记进 g_gateClose 会让面板的「一笔内开合差」统计凭空多一次。 */
    InterlockedExchange(&g_gateOk, 0);
    /* ⛔⛔ 0x0118：**不再**清 g_anaOk / g_synOn / g_synFrontT / g_lastRecovMs。
       真机 jwwh-36936 的 353s 永久冻结四因叠加，第一因就是这里：停摆中补流
       已正确接管（喂了 118 包），用户拨开关 OFF ⇒ commit(0) ⇒ cmd=2 撤钩
       ⇒ 这四行把正在救场的补流**亲手杀掉**；紧接着重挂（cmd=1）又作废
       g_calib.valid ⇒ 接管条件永远凑不齐 ⇒ 直到用户重新画出真实包才恢复，
       而冻结期 PS 不在前台、驱动零包 ⇒ 永远等不到（见 0x0118 版本史）。
       撤钩期间 detour 本就不被调用，补流逻辑天然停摆；保留这四个量，
       重挂后若条件仍成立（g_synOn ∧ calib.valid ∧ enNow ∧ 真路空转 ∧
       采样源新鲜）补流**立即重新武装** —— 这正是「开关循环无损」的本意。
       ⛔ 旧注释担心的「跨会话误丢真包」不成立：g_synFrontT 的比较是
          `behind = front − pkTime > 0`（旧前沿只丢早于它的包，跨会话后
          pkTime 必然更大 ⇒ behind<0 天然免疫），g_lastRecovMs 有
          RI_RECOV_MS 恢复窗上限（sinceRecov ≤ 窗才动手），双双与绝对值无关。 */
    if (g_synWas) {
        /* 撤钩时补流正接管 ⇒ 这段接管是被卸载终止的，按「引擎被关」落账，
           并复位沿检测（重挂后重新接管要能再打一条 ★接管 日志）。 */
        InterlockedExchange(&g_synWas, 0);
        InterlockedExchange(&g_synSpanMs, (LONG)(GetTickCount() - g_synT0L));
        InterlockedExchange(&g_synExitWhy, 1);
        InterlockedExchange(&g_synExit, 1);
    }
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
    const char* mod = (L->mod && *L->mod) ? L->mod : "Wintab32.dll";
    HMODULE hm = GetModuleHandleA(mod);
    if (!hm) { sprintf(L->skip, "%s 未加载", mod); return 0; }
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

/* ========== 已删除：一次性「方向判决实验」（0x0123，2026-10-17 深夜）
 *
 * ⛔⛔ 原实现（0x0113~0x0122 一直存活）：断流持续 ≥2s 时，用 WTOpenA 临时建一个
 *    自己的上下文（真机得 0x803）→ `WTOverlap(hc, TRUE)` 推到重叠序顶层 →
 *    8×40ms 读包 → `WTClose`，据「读到几包」判断 Wintab 通路是「只对 PS 的上下文
 *    死」还是「整体死」。
 *
 * ⛔⛔ 删除理由（jwwh-9616，0x0122 真机会话，铁证）：
 *    · 22:59:14.343 探针 WTOpenA 出 0x803、推顶、320ms 后 WTClose；
 *    · **22:59:21.546 起真实包归零，一直到 23:01:26 卸载（105 秒）一个包都没回来**，
 *      期间 `peek=0` / `单包=0`（队列是**空的**，不是满的），补流全程 syn=1 空转；
 *    · 同会话探针执行**之前**的四次断流（22:58:39 / 22:58:52 / 22:58:59 / 22:59:00）
 *      全部在 0.8~2.9s 内自愈 —— 断流「永久化」的分界线精确落在探针那 320ms 上；
 *    · 探针本身的产出为零信息量：`共读 1 包，首包轴坐标 x=0 y=0`（垃圾包），
 *      却被判读成「Wintab 通路活着」（日志里 [relay] ★实测 那一行）。
 *    ⇒ 机制与函数注释当年自己预言的风险完全一致：**WTClose 之后驱动不再把 PS 的
 *      上下文推回重叠序顶层，PS 就被永久饿死**，而 reload 插件也救不回来
 *      （驱动状态，不在我们进程里）。收益 0、代价 = 整个会话作废 ⇒ 整段删除。
 *
 * ⛔ 现在断流期对本进程外的一切 Wintab 状态**只读**：只调 WTPacketsGet（转发原件）、
 *    WTPacketsPeek（只读探针），绝不 WTOpen / WTClose / WTOverlap / WTEnable。
 *    恢复时长完全交给驱动（真机实测 0.3s~3s，极少数 31s）。
 * ⛔ 以后若再想加「临时上下文」类实验：先证明它不会改变重叠序顶层归属，否则一律不进主流程。 */

/* ============================ 断流：进程内没有杠杆，故**不再做任何主动抢救**
 * ⛔⛔ 三轮真机判决（全部否证，结论只剩一个）：
 *   ① `WTEnable(hCtx,0)→Sleep→(1)`  12 轮 → 全返 1/1，一包未回（jwwh-10472，冻结 678s）；
 *   ② `WTOverlap(hCtx, TRUE)`      120 轮 → 全返 1，一包未回（jwwh-25000）；
 *                                  +30 轮 → 全返 1，一包未回（jwwh-9304，冻结 31s）；
 *   ③ 插件**自建**新上下文并推到重叠序顶层 → 笔在移动，读包 = 0（jwwh-24036 / 9304）。
 *   ⇒ 唯一自洽的解释：**Wacom 驱动的 WinTab 采样整体停摆**。
 *     不是「PS 的 hCtx 被挤出重叠序」（否则 ③ 的自建上下文该收到包）；
 *     不是队列溢出（那是满而不是空，日志 `peek=0` 恒为空）；
 *     不是我们漏挂了通路（`单包=0`：WTPacket 通路同样没有数据）。
 *     ⚠️ 顺带反证：`WTOverlap` 恒返 1 ⇒ PS 的上下文**一直在顶层**，驱动照样不排包。
 *   ⛔ 为什么把动作**全部删掉**（本版起 DLL 对 Wintab 只读不写）：
 *     · 它们一个都没用（①②③ 全是实证），继续调用只是把「无效」重复成噪声；
 *     · 它们**有害**：探针会把外来上下文推到顶层并占用 ~320ms，期间 PS 必然收不到包，
 *       `WTClose` 之后驱动若不自动把 PS 推回顶层，我们就自己把断流**延长**了。
 *       真机 9304 有两次恢复恰好落在探针动作后 0.5~2.3s，无法排除是我们在添乱；
 *     · 0x0122 之前还留了一个「只做一次」的方向判决探针（临时 WTOpenA + WTOverlap
 *       推顶 + WTClose）—— ⛔⛔ 0x0123 已把它**整段删除**：真机 jwwh-9616 里它执行后
 *       立刻进入 105s 永久断流（reload 也不恢复），收益却是一包 x=0 y=0 的垃圾数据。
 *       详见文件内「已删除：一次性方向判决实验」段。
 * ⇒ 本版起对本进程外的 Wintab 状态**全只读**（WTPacketsGet 转发 / WTPacketsPeek 只读），
 *   恢复时长完全由驱动决定（实测 0.3s ~ 3s，罕见 31s）。
 *   要缩短体感断流只能靠补流，不能靠碰驱动。 */

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
    penraw_start();       /* Raw Input 自读：自带线程与不可见窗口（真机零输入，仅留作设备枚举） */
    cursamp_start();      /* 采样源：系统光标 250Hz（真正喂配对环的那一路） */

    LONG lastSeq = -1;
    DWORD lastPublish = 0;
    int loggedDump = 0;
    if (g_cfg) g_cfg[CFG_I_CMDACK] = g_cfg[CFG_I_CMDSEQ];  /* 把「当前序号」当基线，避免立刻执行陈旧命令 */

    while (!g_stop) {
        Sleep(250);
        if (!g_cfg) cfg_open();
        /* 0x0136：Windows Ink 探针。每拍（250ms）枚举一次 pointerId，只读。
           目的只有一个：回答「Wintab 包空 + 系统光标冻死时，Windows Ink 里还有没有笔」。
           有 ⇒ 下一版把它接成真正独立的第四路数据源；没有 ⇒ 这条路彻底判死，
           剩下只能从驱动层想办法。⛔ 本版绝不拿它改任何输出，纯观测。 */
        ink_probe_tick();
        publish_status();

        /* 0x0133：**上下文看门狗**。PS 会自己把 Wintab 上下文关掉（jwwh-36236 的
           19:39:22：一个 PS 对话框抢了前台之后 `WTClose hCtx=0x802`，此后 packets
           定格在 43125 再没涨过），而它不会自动重开 ⇒ 我们手上一个包都没有，
           平滑/HUD/补流**全都无从下手**（不是我们的状态机坏了）。用户感知就是
           「断流、怎么都不自愈，reload 才好」——reload 之所以有效，是因为 PS 在
           插件重新加载时才重建上下文。
           ⇒ 这里只做两件事：如实定性（原因码 9）+ 落一行可操作的话。 */
        {
            LONG closed = g_ctxClosedMs;
            if (closed && (LONG)(GetTickCount() - (DWORD)closed) >= 1500) {
                static LONG s_goneLogged;
                if (g_reason != RS_CTXGONE) InterlockedExchange(&g_reason, RS_CTXGONE);
                if (s_goneLogged != closed) {
                    s_goneLogged = closed;
                    logf("# [ctx] ★PS 已关闭 Wintab 上下文且 1.5s 未重开：没有包可改写 ⇒ "
                         "平滑与 HUD 必然停摆（不是插件状态机坏了）。处置：切回文档画布/"
                         "重开文档；仍不行重启 Photoshop。packets=%ld\n", (long)g_packets);
                }
            }
        }

        /* —— 每笔台账落盘（0x0124）——
           判据：`复位` > 1 ⇒ 这一笔在笔中被内部复位过（输出点被拽回笔尖 = 硬线段）；
                `最长全零` > 20 包 ⇒ 运笔中接触判据真的成段失效，是 1500ms 长闩接住的。
           两者相加即可把「整笔硬线」拆成「闸门问题」与「复位问题」两类，不再靠猜。
           0x012A：`落` = buttons 落笔边沿锚定次数。**每一笔正常必须 = 1**（一个真起笔
               一次锚定）；= 0 ⇒ 这一笔的起笔没被边沿抓到（buttons 不可用/被去抖滤掉），
               用户报的「落笔偏移」会原样复现；> 1 ⇒ buttons 在笔中抖动（边沿去抖失灵）。 */
        if (InterlockedExchange(&g_lgEvt, 0)) {
            logf("# [stroke] 笔收尾: 时长=%ldms 包=%ld 改写=%ld 复位=%ld(锚%ld/gap%ld/jump%ld/落%ld) "
                 "悬空批=%ld 最长全零=%ld包 落间最小全零=%ld包(共%ld次) 滤=%ld 半径=%ldpx 模式=%ld "
                 "平均滞后=%ld.%ldpx 贴笔=%ld%% 死区=%ld%%\n",
                 (long)g_lgDur, (long)g_lgPk, (long)g_lgChg, (long)g_lgRst,
                 (long)g_lgRA, (long)g_lgRG, (long)g_lgRJ, (long)g_lgRP,
                 (long)g_lgGrace, (long)g_lgZero, (long)g_lgEmin, (long)g_lgEn,
                 (long)g_lgRej, (long)g_lgRad, (long)g_lgMode,
                 (long)(g_lgLag / 10), (long)(g_lgLag % 10),
                 (long)g_lgPin, (long)g_lgSlack);
        }

        /* —— 每 2s：取包突发计量 + 独立笔通路拟合/上报（2026-10-16 第十四轮）——
           这两条是本轮**唯一**的新观测面：
             · [pk]  把「卡顿 → 一口气冲出来」量成数字（单次最大包数 / 冲包次数 /
               零包次数），并顺带定出真实标称采样率 —— 此前只有 10s 均值的 [status]，
               而冲包恰恰是秒级现象，均值的摆动说不清是冲包还是笔没在动；
             · [raw] 独立笔通路见到什么、配对拟合成不成（成 ⇒ 补流接管，不成 ⇒ 本版
               与 0x010C 行为相同）。 */
        {
            static DWORD s_meterWin;
            static DWORD s_lastCalls, s_lastPkAll;
            static int   s_pkPeakSeen;
            DWORD tick = GetTickCount();
            if (tick - s_meterWin >= 2000) {
                int win = (int)(tick - s_meterWin);
                if (win < 1) win = 1;
                s_meterWin = tick;

                /* 补流进出事件（detour 只置原子，文本在这里落） */
                if (InterlockedExchange(&g_synEnter, 0))
                    logf("# [raw] ★补流接管：真实通路空转，改由独立笔通路合成包喂 PS\n");
                if (InterlockedExchange(&g_synExit, 0)) {
                    /* 0x0118：按 detour 分类的真实原因落盘（旧版恒称「真实通路已回包」，
                       停摆中拨开关被杀的那次也被误报成驱动恢复，排障全被带偏）。 */
                    static const char* const kWhy[] = {
                        "真实通路已回包，交还给驱动",
                        "引擎已关闭（钩子被卸或拟合失效）",
                        "面板开关已关闭",
                        "标定已失效",
                        "采样源无新样本（光标通路静默）",
                    };
                    LONG w = g_synExitWhy;
                    logf("# [raw] 补流结束：%s（本次接管 %ldms）\n",
                         (w >= 0 && w < 5) ? kWhy[w] : "原因未知", (long)g_synSpanMs);
                }
                if (InterlockedExchange(&g_baseEvt, 0))
                    logf("# [raw] 时间基已证实：pkTime 与 GetTickCount 同基 ⇒ 陈旧回包判据生效\n");
                if (InterlockedExchange(&g_dropStaleEvt, 0))
                    logf("# [raw] 陈旧回包合并：丢弃停摆期攒下的旧坐标（落后补流前沿 %ldms）\n",
                         (long)g_dropStaleMs);

                DWORD cAll = (DWORD)g_calls, pAll = (DWORD)g_pkReal;
                DWORD dCall = cAll - s_lastCalls, dPkt = pAll - s_lastPkAll;
                s_lastCalls = cAll; s_lastPkAll = pAll;
                LONG mx = g_pkMax, big = g_pkBig, zr = g_pkZero;
                InterlockedExchange(&g_pkMax, 0);
                InterlockedExchange(&g_pkBig, 0);
                InterlockedExchange(&g_pkZero, 0);
                if (dCall || dPkt || mx || big) {
                    if (mx >= RI_BIG_BURST) s_pkPeakSeen = 1;
                    logf("# [pk] %dms: PS取包次=%lu 真实包=%lu (%.0f/s) 零包次=%ld "
                         "最大单次=%ld ≥25包次数=%ld 累计冲包峰值=%d\n",
                         win, (unsigned long)dCall, (unsigned long)dPkt,
                         (double)dPkt * 1000.0 / (double)win,
                         (long)zr, (long)mx, (long)big, s_pkPeakSeen);
                }
                ana_update();          /* 解析映射：断流早发（配对攒不够）时的兜底 */
                penraw_fit_tick();
                penraw_report(win);
            }
        }
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
                g_anaLogged = 0;          /* 重标定 ⇒ 解析映射重建，日志重报一次 */
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

        /* —— 本版对 Wintab **只读不写**（2026-10-16 第十三轮）——
           ⛔ 三个「主动抢救」动作全部删除，且各有真机判决：
              · 第八轮 `WTEnable` 翻转：jwwh-10472 冻结 678s，12/12 轮全返 1/1 却一包未回；
              · 第九轮「每 500ms 保持重叠序顶层」：jwwh-25000 跑满 199 次照样每笔断流；
              · 第十轮 `dead_heal` 的 `WTOverlap`：25000 的 120 轮 + 9304 的 30 轮全返 1、
                一包未回。
           而且每个动作都会让**外来上下文短占重叠序顶层** —— 那一瞬间 PS 必然收不到包，
           关掉之后驱动若不自动把 PS 推回去，就是我们亲手延长断流。杠杆既已全无效，
           唯一正确的姿势是**不再动它**。 */

        /* —— 断流看门狗（2026-10-14 第七轮；判定规则此后未变）——
           本轮真机形态：penDown 卡 1、packets 冻结数分钟、calls 一直涨、
           用户笔还在画 ⇒ 平滑实质中断。
           ⛔ 与「停笔正常冻结」的判别：停笔=笔静止 ⇒ 光标（跟原始笔）也静止；
             penDown=1 + 包冻结 + **光标还在动** ⇒ 包流真断了。
           判定后置 g_streamDead（HUD 立即隐藏，避免拿旧位置误导）；包恢复自动清零并记
           中断时长 + **冲包量**（下一批包一次性涌进来多少 —— 这条直接量出了驱动队列）。
           单包通路计数一并打出（本症实测恒 0 ⇒ 排除「PS 改走消息驱动、我们漏挂了通路」）。
           ⛔⛔ 根因（三轮交叉定案；0x0123 起探针已删，见文件内同名段）：**驱动侧
              WinTab 采样整体停摆** —— 插件自建上下文 + 推顶 + 笔在移动，读包依然为 0
              （jwwh-24036 / 9304）；`WTOverlap` 恒返 1 反证 PS 的上下文一直在顶层。
              进程内没有杠杆 ⇒ 本节只做**判定 + 诊断**，不做任何补救。
              ⛔ 唯一例外是「自建上下文」那条：jwwh-9616 证明它反而会把 PS 永久饿死。 */
        {
            static DWORD s_pkts, s_calls, s_dead0, s_deadLog;
            static DWORD s_lastPenMs;   /* 最近一次见到 penDown=1 的时刻（见 PEN_RECENT_MS） */
            static DWORD s_frzLog;      /* [frz] 诊断节流 */
            static POINT s_lastCur;     /* **上一拍**的光标（逐拍增量用，见下） */
            static int   s_have;
            static int   s_still;      /* 连续「基本没动」的拍数 */
            static LONG  s_movedTot;   /* 冻结期累计位移（逐拍增量求和） */
            static LONG  s_stallPk;    /* 上次见到新包时的包数（[stall] 用） */
            static DWORD s_stallT0, s_stallCl;
            static int   s_stallOn;
            DWORD nowW = GetTickCount();
            POINT c; se_real_GetCursorPos(&c);
            /* ⛔⛔ 只看**真实**驱动包（g_pkReal，不含独立笔通路的合成包，2026-10-16）：
               合成补流会把 g_packets 一直抬高 ⇒ 拿它当冻结判据等于把断流**藏起来**，
               而诊断的第一要求是「能说真话」。 */
            LONG pk = g_pkReal, cl = g_calls;
            /* ⛔ 落笔的「记忆」必须比 g_penDown 活得久：断流一发生，contact_update
               就再也收不到包，g_penDown 冻结/清零，判据随之失效（见 PEN_RECENT_MS）。 */
            if (g_penDown == 1) s_lastPenMs = nowW;
            if (!s_have) { s_pkts = pk; s_calls = cl; s_lastCur = c; s_have = 1; }

            /* ⛔⛔ 2026-10-16 第十五轮：**无前置条件的包流停摆记录**。
               `[dead]` 要求「最近 PEN_RECENT_MS 内落笔过 + 光标累计移动过门限」，于是
               当接触判据把 penDown 判成 0 时（真机 `[ct] 连续全零=3049 包` 就是这种
               情形），一段真实的停摆会被**完全遮蔽**：jwwh-22288 里 13:45:56~13:46:47
               整整 50s 闸门判「悬空」，这段时间包流到底是活着还是断了，从 [dead] 与
               [status] 都读不出来。这里只按「多久没见到新包」记录，并把手上的闸门状态
               一并打出 ⇒ 「停摆是否真实」与「当时闸门怎么判」两件事立刻能对上。
               ⛔ 纯诊断，不改任何行为。 */
            {
                static DWORD s_lastPkMs;
                static int   s_stallInit;
                static int   s_stallBoot;   /* 0x0135：这一段空转发生时本进程**一个真包都还没见过** */
                if (!s_stallInit) { s_stallInit = 1; s_stallPk = pk; s_lastPkMs = nowW; }
                else if ((DWORD)pk != (DWORD)s_stallPk) {
                    if (s_stallOn) {
                        /* ⛔⛔ 0x0135（jwwh-33124 判读）：**「还没开始画」与「画着画着断了」是两件事**。
                           旧版一律写成 `[stall] 结束：停摆 44359ms` —— 而真相是插件 reload
                           之后前台还是 Chrome、用户在浏览器里待了 44 秒、笔压根没上板
                           （`g_pkReal` 全程 0、`[frz] 落笔=0(末次 本次尚未见)`）。
                           一行假「停摆 44 秒」直接把人引向「一开局就断流」的错误结论。
                           ⇒ 零真包 ⇒ 只算冷启动空转，用 `[boot]` 措辞、不再叫停摆。 */
                        if (s_stallBoot) {
                            logf("# [boot] 首包到达：冷启动空转 %lums 后拿到第 1 个真实包"
                                 "（期间 PS 空轮询 %ld 次）⇒ **从此刻起才算「运笔」**，"
                                 "之前的空档不是断流\n",
                                 (unsigned long)(nowW - s_stallT0),
                                 (long)((DWORD)cl - s_stallCl));
                        } else {
                            logf("# [stall] 结束：停摆 %lums（期间 PS 轮询 %ld 次，"
                                 "光标=(%ld,%ld)）\n",
                                 (unsigned long)(nowW - s_stallT0),
                                 (long)((DWORD)cl - s_stallCl), (long)c.x, (long)c.y);
                        }
                        s_stallOn = 0;
                    }
                    s_stallPk = pk; s_lastPkMs = nowW;
                } else if (!s_stallOn && (DWORD)(nowW - s_lastPkMs) >= STALL_LOG_MS) {
                    s_stallOn = 1; s_stallT0 = s_lastPkMs; s_stallCl = (DWORD)cl;
                    s_stallBoot = (pk == 0);
                    /* ⛔ 0x0117 加 `fg=`（前台是否本进程，HUD 焦点门的诊断镜像）：
                       真机 jwwh-32984 三场停摆**全部**与「PS 失前台」同时发生
                       （点一键修复 → UAC + 15s 倒计时窗口抢前台；点插件面板；
                       点任务栏）⇒ Wintab 驱动只给前台上下文派包、其余攒在队列
                       （冲包量 40~47 ≈ 队列容量）。这是判「驱动随机停摆」还是
                       「焦点门控派包」的唯一现场字段，下一场日志直接可查。
                       ⛔⛔ 0x0122 加 `syn=`（补流接管中）：[stall]/[dead] 的冻结判据
                       只看真实驱动包（g_pkReal，见上）⇒ **补流正在喂包时这些行照打**，
                       旧版没有任何字段能区分「真断」与「救场中」，用户体感的「断流」
                       与排障全被带偏（真机 jwwh-38216：22:33:42~57 三段停摆期间
                       补流实际喂了 134 包，[dead] 仍写「平滑实质中断」——那是假话）。
                       syn=1 ⇒ 补流在救场（用户的「断流」体感若仍在，问题在几何层：
                       陈旧回包追赶/HUD deadHide），syn=0 ⇒ 武装链真断。 */
                    if (s_stallBoot) {
                        /* 0x0135：见上「零真包 ⇒ 冷启动」的注释。这条不叫停摆、也不该被
                           人读成「一开局就断流」——它只说明笔还没上板。 */
                        logf("# [boot] 冷启动：本进程至今**零个真实包**（笔还没上板 / 还没开始画）"
                             "—— 这不是断流，不计入停摆统计；拿到第 1 个包时另打一行。"
                             "fg=%ld 光标=(%ld,%ld) calls=%ld\n",
                             (long)g_fgOkDbg, (long)c.x, (long)c.y, (long)cl);
                    } else {
                        logf("# [stall] ★包流停摆 ≥%lums：penDown=%ld toolOk=%ld contact=%ld "
                             "ctZeroRun=%ld ctUnknown=%ld fg=%ld syn=%ld 光标=(%ld,%ld) calls=%ld\n",
                             (unsigned long)(nowW - s_lastPkMs), (long)g_penDown, (long)g_toolOk,
                             (long)g_contact, (long)g_ctZeroRun, (long)g_ctUnknown,
                             (long)g_fgOkDbg, (long)g_synWas, (long)c.x, (long)c.y, (long)cl);
                    }
                }
            }
            if ((DWORD)pk != s_pkts) {                /* 有包：正常或从断流恢复 */
                if (g_streamDead) {
                    /* ⛔★ 判决性字段：**冲包量** = 恢复这一瞬间一次性涌进来多少包。
                       真机 jwwh-9304 的五次恢复分别约 +125 / +127 / +117 / …，**全部落在
                       128 附近**，恰好等于 `WTQueueSizeGet` 报出的队列容量 ⇒ 驱动在停摆
                       期间把包**攒在队列里**，恢复时一次性交给 PS。
                       这正是用户报的「画了 800px 圆弧、全程不出线，按住几秒后**整根
                       圆弧一次性冒出来**」的直接机制：PS 在**一次** WTPacketsGet 调用里
                       拿到上百个点，当然一帧画完（不是我们的平滑在憋，也不是性能问题）。 */
                    DWORD flush = (DWORD)(pk - s_pkts);
                    logf("# [dead] 恢复：包流恢复（断流约 %lu ms；冲包量=%lu 包"
                         "（≈驱动队列容量 ⇒ 停摆期是「攒着」不是「丢」）；"
                         "期间单包通路收包 %ld）\n",
                         (unsigned long)(nowW - s_dead0), (unsigned long)flush,
                         (long)g_wtPkt1);
                    InterlockedExchange(&g_streamDead, 0);
                    /* ⛔ 让下一批包**锚定复位**（输出点回到笔尖）：断流期笔早已走远，
                       拿停摆前的输出点续画只会得到一段被拉长的假轨迹。 */
                    InterlockedExchange(&g_deadRecovered, 1);
                }
                s_pkts = pk; s_calls = cl; s_lastCur = c; s_dead0 = 0;
                s_movedTot = 0; s_still = 0;
            } else if ((DWORD)cl != s_calls) {        /* 无包但 PS 在轮询 ⇒ 冻结期 */
                s_calls = cl;
                int moved = (c.x > s_lastCur.x ? c.x - s_lastCur.x : s_lastCur.x - c.x)
                          + (c.y > s_lastCur.y ? c.y - s_lastCur.y : s_lastCur.y - c.y);
                s_lastCur = c;
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
                if (!s_dead0) { s_dead0 = nowW; s_movedTot = 0; s_still = 0; }
                s_movedTot += moved;
                /* ⛔⛔ 2026-10-16 第十四轮：累计量必须是**逐拍增量之和**。
                   旧版算的是 |cur − s_cur0|（自冻结起点的差）却逐拍累加 ⇒ 同一段
                   位移被反复计入，只要光标偏离过基线 2px 就不再归零 ⇒ 「停笔」也
                   被判成「光标在动」。真机 jwwh-13772 正是这个形态：用户报 5 次冲包，
                   日志只打出 1 条 [dead]，其余全被这条假累计掩盖。
                   现在：逐拍增量求和；只有**连续 3 拍**位移都 <2px（真停笔）才清零，
                   慢速运笔（每拍 2~10px）不再被误清零。 */
                if (moved < 2) { if (++s_still >= 3) s_movedTot = 0; }
                else s_still = 0;
                if (!g_streamDead) {
                    /* ⛔⛔ 落笔判据 = 「最近 PEN_RECENT_MS 内落笔过」（2026-10-16
                       第十二轮），不再是瞬时 g_penDown。真机 jwwh-24524 第 12 笔：
                       断流起点 12:06:13.9、判定门槛 350ms 到 12:06:14.25 才满足，
                       而 penDown 恰在 12:06:14.237 清零 ⇒ 差 13ms 错开，此后
                       3.5 分钟永久断流一条 [dead] 都不打（HUD 还一直显示冻结几何）。 */
                    DWORD penAgo = s_lastPenMs ? (nowW - s_lastPenMs) : 0xFFFFFFFFu;
                    /* ⛔ 「末次 X 前」必须是可读文本：`s_lastPenMs==0` = 本次进程从未
                       见过 penDown=1，打印那个哨兵值（4294967295）会被误读成下溢。 */
                    char penTxt[40];
                    if (s_lastPenMs) sprintf(penTxt, "%lums 前", (unsigned long)penAgo);
                    else             sprintf(penTxt, "本次尚未见");
                    if (g_patched && penAgo < PEN_RECENT_MS && s_movedTot >= mvDead
                        && nowW - s_dead0 > DEAD_DETECT_MIN_MS) {
                        InterlockedExchange(&g_streamDead, 1);
                        s_deadLog = nowW;
                        logf("# [dead] ★包流断供: 包冻结 %lums 而光标仍移动(Δ累计%ldpx) "
                             "落笔=%ld(末次 %s) hCtx=0x%llX calls=%ld 单包=%ld "
                             "open=%ld close=%ld syn=%ld ⇒ 驱动侧 WinTab 采样停摆"
                             "（本进程对其只读：不再自建/推顶上下文，0x0123）；"
                             "%s\n",
                             (unsigned long)(nowW - s_dead0), (long)s_movedTot,
                             (long)g_penDown, penTxt,
                             (unsigned long long)(UINT_PTR)g_ctxNow, (long)cl,
                             (long)g_wtPkt1, (long)g_wtOpenN, (long)g_wtCloseN,
                             (long)g_synWas,
                             g_synWas ? "平滑由补流接管，线条应仍在走（若仍硬/断 ⇒ 查闸门②与复位台账）"
                                      : "补流未武装 ⇒ 平滑实质中断");
                    } else if (nowW - s_dead0 > 500 && nowW - s_frzLog >= 2000) {
                        /* ⛔ 「为什么还没判成断流」必须可读（否则又只能猜）：
                           把三个判据的实际取值全打出来 ——
                             penAgo  ≥ PEN_RECENT_MS ⇒ 早就抬笔了（正常冻结，不判）
                             movedTot < mvDead        ⇒ 光标没在动（停笔，不判）
                             冻结 < 350ms             ⇒ 还没到判定门槛 */
                        s_frzLog = nowW;
                        /* 0x0135：零真包 ⇒ 这是「等笔上板」，不是「冻结」。两件事混在一行
                           （jwwh-33124 那条 `冻结 2640ms … 落笔=0(末次 本次尚未见)`）就是
                           「一开局就断流」误判的来源之一。 */
                        if (pk == 0) {
                            logf("# [boot] 冷启动仍在等第 1 个包（已 %lums，PS 空轮询 %ld 次）"
                                 "cur=(%ld,%ld) ⇒ 笔还没上板，不是断流\n",
                                 (unsigned long)(nowW - s_dead0), (long)cl,
                                 (long)c.x, (long)c.y);
                        } else {
                        logf("# [frz] 无包但仍在轮询: 冻结 %lums movedTot=%ld/%d "
                             "落笔=%ld(末次 %s) cur=(%ld,%ld) 上拍=(%ld,%ld) calls=%ld\n",
                             (unsigned long)(nowW - s_dead0), (long)s_movedTot, mvDead,
                             (long)g_penDown, penTxt,
                             (long)c.x, (long)c.y, (long)s_lastCur.x, (long)s_lastCur.y, (long)cl);
                        }
                    }
                } else {
                  /* —— 断流期诊断（2s 节流）—— */
                  if (nowW - s_deadLog >= 2000) {
                    s_deadLog = nowW;
                    /* ⛔ 队列探针（只读、非消费）：WTPacketsPeek 按规范不动队列，且我们
                       只 inline-hook 了 WTPacketsGet，此调用直达驱动。
                       ⛔⛔ 真机里**恒为 0**：不是我们这侧队列溢出（溢出是「满」而不是
                       「空」），而是驱动**压根没往这个上下文排包**。配合「插件自建上下文
                       同样读包=0」，根因指向**驱动侧 WinTab 采样整体停摆**。
                       peek>0 才会是另一类故障（队列有货而 WTPacketsGet 恒返 0）。 */
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
                    /* 0x0122：补 syn=（补流接管中，0/1）—— 冻结判据只看真实包，
                       补流喂包期间本行照打；没有这个字段就无法区分「真断」与
                       「救场中」（jwwh-38216 三段停摆期补流实喂 134 包）。 */
                    logf("# [dead] 持续中: 已冻结 %lums calls=%ld 单包=%ld peek=%u syn=%ld "
                         "补发=%ld pre=(tip%ld/syn%ld/hw%ld/cv%ld/frz%ld/btn%ld)\n",
                         (unsigned long)(nowW - s_dead0), (long)cl, (long)g_wtPkt1, peekN,
                         (long)g_synWas, (long)g_ctxPostN,
                         /* 0x012C：补发的前置条件逐个可见 —— 补发仍为 0 时一眼定位是哪一项
                            不成立（tip=接触断言 / syn=补流已武装 / hw=代投目标有值 /
                            cv=光标在活动文档画布内 / frz=喂入已冻结（0x012E，cv=0 时
                            应转成 1 而不是停发） / btn=VK_LBUTTON 电平，仅诊断）。 */
                         (long)(g_penDown ? 1 : 0), (long)g_synWas,
                         (long)((g_ctxHwnd || s_psFrame) ? 1 : 0), (long)g_canvasOkDbg,
                         (long)g_csFrozen, (long)g_csBtn);
                  }
                  /* —— 不再「主动抢救」（2026-10-16 第十三轮）——
                     ⛔ 这里曾经按轮次反复做两个动作，双双被真机证伪：
                        · 第八轮 `WTEnable 翻转`：jwwh-10472 冻结 678s，12/12 轮全返
                          1/1 却一包未回，直到用户退出 PS；
                        · 第九/十轮 `WTOverlap(hCtx, TRUE)`：jwwh-25000 的 120 轮、
                          jwwh-9304 的 30 轮**全部返回 1** 却同样一包未回。
                     而且它们**可能有害**：把外来上下文推上重叠序顶层会让 PS 收不到包，
                     关掉之后驱动若不自动把 PS 推回去，就是我们亲手在延长断流。
                     ⇒ 本版起：断流期**一个 Wintab 写动作都不做**（0x0123 把最后一个
                        「方向判决实验」dead_relay_probe() 也删了，见下方 0x0123 说明）。
                        恢复时长完全交给驱动（真机实测 0.3s~3s 随机）。

                     ⛔⛔ 0x0123 删探针的实证（jwwh-9616，0x0122 真机会话）：
                        22:59:14.343 探针 WTOpenA 出 0x803 → WTOverlap 推顶 → 320ms 后
                        WTClose；**22:59:21.546 起真实包归零，直到 23:01:26 卸载（105s）
                        一个包都没回来**，期间 peek=0 / 单包=0（队列是空的，不是满的）。
                        而同会话探针执行前的四次断流（22:58:39/52/59、22:59:00）全部
                        在 0.8~2.9s 内自愈 —— 分界线正好落在探针那 320ms 上。
                        这与函数注释自己预言的风险完全一致：**WTClose 之后驱动不再把
                        PS 的上下文推回重叠序顶层，PS 就被永久饿死**。探针的收益（"读到
                        1 包、轴坐标 x=0 y=0"）连信息量都没有，代价却是整个会话作废，
                        ⇒ 整段删除，断流期彻底只读。 */
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
                LONG ageP = sn_age_ms(GetTickCount());   /* ⛔ 有符号：见 sn_age_ms 注释 */
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
                    /* ⛔⛔ 0x0118：不再无条件作废 g_calib.valid。真机 jwwh-36936
                       的 353s 永久冻结第二因：重挂即作废 ⇒ ana_update 早退
                       （`!g_calib.valid` 第一行就 return）+ 补流接管条件要求
                       calib.valid ⇒ 补流永远无法重新武装，而恢复标定需要真实
                       包、真实包需要 PS 在前台 —— 冻结期两者都不成立，死锁。
                       环境变化（换屏 / DPI / 驱动映射变更）归 worker 每 250ms
                       的指纹段管（那里才清 valid，见 [calib] ★变化日志），
                       与本处无关；从未标定过时 valid 本就是 0，行为零变化。 */
                    InterlockedExchange(&g_state, st);
                }
                g_cfg[CFG_I_CMDACK] = seq;
            }
        }

        if (GetTickCount() - lastPublish >= 10000) {
            lastPublish = GetTickCount();
            /* 0x0131：导入表是可增长的（PS 的面板/延迟加载 DLL 会在运行中才载入），
               每 30s 静默重扫一遍；新槽数为 0 时不打日志（只有真改了才出声）。 */
            {
                static int s_iatTick;
                if (g_wtctxIni[WTCTX_INI_CURSORINJECT] && (++s_iatTick % 3) == 0)
                    gcp_iat_sweep(0);
            }
            /* rst=a/g/j/p = 起笔锚定 / 取包超时(假复位) / 位置跳变 / buttons 落笔边沿
               的次数（0x012A 起 p = 真落笔锚定，每笔正常 1 次）。
               ⛔ 「圆忽然闪现回光标、折线瞬间连到光标」= 一次复位，只有把四种原因
                  分开计数才能一眼看出是哪一种（gap 居多 ⇒ 停笔被误判成新的一笔）。
               calX/calY = 该轴是否已由**真实光标**标定（1）还是仍在用中性兜底（0）。
                  ⛔ 判符号只能看 calX/calY=1 时的 pxX/pxY：那才是测出来的真符号；
                     =0 时是兜底（不含方向信息），别当成结论。 */
            logf("# [status] state=%ld calls=%ld packets=%ld smoothed=%ld calib=%s dpi=%ld‰ "
                 "stride=%d offX=%d offY=%d axMax=%u pxX=%.4f pxY=%.4f calX=%ld calY=%ld "
                 "rst=%ld/%ld/%ld/%ld lastGap=%ldms ctxN=%ld last=0x%lX->0x%lX "
                 "dead=%ld pkt1=%ld open=%ld close=%ld\n",
                 (long)g_state, (long)g_calls, (long)g_packets, (long)g_smoothed,
                 g_calib.valid ? "OK" : "否", (long)g_dpiScaleMilli,
                 g_calib.stride, g_calib.offX, g_calib.offY,
                 g_calib.axisMax, px_x(), px_y(),
                 (long)g_axCalX.done, (long)g_axCalY.done,
                 (long)g_rstAnchor, (long)g_rstGap, (long)g_rstJump, (long)g_rstPenDown,
                 (long)g_lastGapMs,
                 (long)g_hCtxChanges,
                 (unsigned long)(LONG_PTR)g_ctxLastFrom, (unsigned long)(LONG_PTR)g_ctxLastTo,
                 (long)g_streamDead, (long)g_wtPkt1, (long)g_wtOpenN, (long)g_wtCloseN);
            /* P3.5：与面板诊断条**同一份数据**的日志版 —— 面板来不及看时看这里。
               ⛔ reason 名字必须与 C#/TS 的原因码表逐项一致（见 RS_* 枚举）。 */
            logf("# [why] reason=%d(%s) gate/open=%ld close=%ld penDown=%ld toolOk=%ld "
                 "sureNo=%d edit=%d "
                 "ctUnknown=%ld ctN=%d ctVal=%ld pxN=%ld/%ld（闸门为累计值；判抖动看两次读数的增量）\n",
                 (long)g_reason, rs_name(g_reason),
                 (long)g_gateOpen, (long)g_gateClose, (long)g_penDown, (long)g_toolOk,
                 /* 0x0209：sureNo = 面板**明确**报「不是套索」（心跳新鲜 ∧ TOOLGATE==0）；
                    edit = 此刻「该不该改写坐标」的最终答案。两者与引擎裁决同源，
                    判读：切到涂抹后 1s 内 sureNo 必须变 1 且 edit 变 0。 */
                 (int)tool_gate_sure_not_lasso(), (int)tool_edit_allowed(),
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
    /* ⛔ 同 hud_stop 的理由：Raw Input 窗口过程在本模块内，必须先 join 再走人。 */
    penraw_stop();
    cursamp_stop();
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
/* ⛔ 0x0126：HUD 只认真实包（合成包不算证据）。
   依据：0x0124 放开断流期隐藏后，用户实测「悬空时 HUD 冒出几秒再消失」——
   那几秒正是断流期合成包的 sticky tip 把我方判据喂成落笔。
   ⛔ HUD 是视觉承诺：合成包负责维持 PS 的笔迹，不负责点亮 HUD。 */
#define HUD_REAL_MS  400
/* ⛔⛔ 0x020F：「一笔进行中、快照仍来自真实包」时的**真实包过期宽限**。
   日志实证（jwwh-24800，16:55:21.535）：HUD 隐藏时
   `ck=0` 而 `active=1(t=16ms) gate=1 stroke=1 penDown=1 dead=0` —— 唯一为假的是
   `real=422ms`（只超阈值 22ms）。驱动短暂空转（该次 343ms 后就恢复）足以让 HUD
   消失，而消失后还要再吃 180ms 重现去抖 ⇒ 用户看到「闪一下又回来」。
   ⛔ 判据只放宽到「快照仍来自真实包」：`g_synWas == 0`。一旦合成包接管，
      `g_lastRealMs` 不再更新、快照也由合成包推进 ⇒ 几何不再可信 ⇒ 仍按 0x0126 隐藏。
   取 1.5s = CONTACT_HOLD_SMOOTH_MS：跨过它就不再是「同一笔的尾巴」。 */
#define HUD_REAL_SLACK_MS 1500
/* ⛔ 笔尖落纸面期间的**保活窗口**：数位板停笔时不再出包（实测 packets 会冻结很久），
   若只看 HUD_IDLE_MS，用户一停笔圆就消失、一动又在复位后的位置冒出来。
   只要闸门（工具对 + 笔尖接触）还成立，就再撑这么久。 */
#define HUD_HOLD_MS  3000
/* ⛔⛔ 0x020A：HUD「刚隐藏过 ⇒ 重新出现要连续满足这么久」的去抖窗口。
   根因（用户报）：「开启套索平滑自动填充好一个选区后，挪动光标找下一笔落点
   （还未落笔）时，HUD 会意外短暂闪现，随后消失」。
   机制：`g_penDown` 带 CONTACT_HOLD_MS(250ms) 的保持窗口（那是为「轻压运笔中
   三信号成段全零 400~600ms」留的，删了就会在运笔中闪灭，不能动）。抬笔后
   正好在这 250ms 内移动笔（笔还在感应区 ⇒ 持续有包 ⇒ pktAge 很小）
   ⇒ HUD 的**全部**条件在这段窗口里都是真的 ⇒ 亮一下再灭。
   ⛔ 没有任何信号能在这 250ms 内区分「真抬笔」与「轻压零段」——两者在
      buttons / pressure 上完全同形（这正是 BTN_EDGE_MIN_ZERO=16 包的由来）。
   ⇒ 只能从**显示时机**上消除：250 − 180 = 70ms 残留（4~5 帧），肉眼不可辨；
      而首次显示 / 隔久了再显示走立即路径，起笔零延迟。 */
#define HUD_RESURF_DEBOUNCE_MS 180
/* 去抖的**有效期**：距上次隐藏超过这么久就认为「这是新的一笔」，立即显示。
   取 1.5s = 平滑长闩 CONTACT_HOLD_SMOOTH_MS，跨过它就不再是「同一笔的尾巴」。 */
#define HUD_RESURF_WINDOW_MS   1500
/* ⛔⛔ 2026-10-14：16 → 8ms（~60Hz → ~120Hz）。
   用户报「拖动稍快，圆心与受力点就分离」。间距的主要来源是**帧间隔**
   （HUD 是轮询渲染，笔画以包率前进，圆心最多滞后一帧）⇒ 帧间隔减半、
   滞后距离减半。⚠️ 降帧必须同时改等待方式才有意义：Sleep(N) 的粒度是
   系统时钟 tick（默认 15.6ms），Sleep(8) 实际仍睡 ~15.6ms ⇒ 必须用
   waitable timer（100ns due time，见 hud_frame_wait）。 */
#define HUD_FRAME_MS 8
#define HUD_CLASS    L"JWautofillWintabHUD"

/* ——— 2026-10-17（LNP `overlay.maxMsgLagForRender` / `Very fast fg change` 迁移）———
   ① 帧滞后阈值：本帧距上一帧超过这么多 ms ⇒ 本帧**不渲染**（几何已经陈旧，
      画上去只会误导）。LNP 的 `maxMsgLagForRender` 就是这条语义：宁可不画，
      也不拿过期的圆心糊一帧。⛔ 与 O1 不冲突：这里只是跳过**重画**，
      窗口保持上一帧内容，不是隐藏。 */
#define HUD_MAX_LAG_MS     60
/* ② 前台切换去抖：PS 面板/对话框抢焦点会造成毫秒级的前后台抖动，
   直接跟随会让 HUD 闪烁（LNP 日志原话：
   `foregroundWindowChange Very fast fg change (%d ms), ignoring`）。
   ⇒ 「前台不是本进程」要**连续保持**这么久才真的隐藏。 */
#define HUD_FG_DEBOUNCE_MS 250
/* ③ 大跳跃阈值（LNP `overlay.bigJumpSqDist`）：一帧内光标位移超过该距离
   （物理像素，**平方**比较）⇒ 本帧不画。场景：跨屏 / 面板弹窗把光标瞬移 /
   驱动回中。旧的「瞬移拉一条长线」正是缺这一条。 */
#define HUD_BIG_JUMP_PX    400
#define HUD_BIG_JUMP_SQ    ((double)HUD_BIG_JUMP_PX * (double)HUD_BIG_JUMP_PX)
/* ⛔⛔ 0x020F：**隐藏去抖** —— 门槛短暂断裂不许提交隐藏。
   用户报（2026-10-28）：「拉绳模式正常绘制选区的过程中，HUD 有时会短暂消失一下，
   随后重新出现」。一次「隐藏 → 重现」的观感成本远高于「多显示 90ms」：
     · 隐藏后重现要过 `HUD_RESURF_DEBOUNCE_MS`(180ms) 的去抖 ⇒ 一次 1~2 帧的门槛
       抖动会被**放大成 180ms 以上的消失**，肉眼必见；
     · 而任何单帧判据（包龄、笔态、焦点门）都会偶发抖动。
   ⇒ 判据连续为假满这么久才真的隐藏。抬笔本来就有 CONTACT_HOLD_MS(250ms) 的保持
     窗口，再加的 90ms 落在「已经看不见圆之后」的尾巴上，手感无差别。 */
#define HUD_HIDE_DEBOUNCE_MS 90
/* ⛔ 0x020F：`lagSkip`/`bigJump` 的**连续跳帧上限**。
   这两项的语义是「本帧几何已陈旧，别糊上去」，**不是**隐藏窗口（见上）。
   但若线程被持续抢占（PS 在算选区、DWM 忙），会连续跳很久 ⇒ 圆静止不动。
   超过这个时长就强行画一帧陈旧的几何 —— 静止的圆也比消失的圆好。 */
#define HUD_SKIP_MAX_MS    200

static HANDLE        g_hudThread;
static DWORD        g_hudTid;
/* 绳身「已绷直」的渲染侧状态（滞回死区用；仅渲染线程读写）。
   g_ropeLowMs = 最近一次跌破「解除绷直阈值」的帧时刻（0 = 未在低位）。 */
static int          g_ropeTaut;
static DWORD        g_ropeLowMs;
static volatile LONG g_hudStop;
static volatile LONG g_hudRunning;
/* 2026-10-17：HUD 门控各项的**诊断镜像**（渲染线程写、`[hud] 未显示` 行读）。
   ⛔ 只为排障：真正门控是局部门控变量，不要反过来读这些字段。
   （声明已随 0x0117 上移至取包诊断区，[stall] 行也要读 g_fgOkDbg。） */

/* ============================================== 焦点门（0x0116，2026-10-17 第十八轮）=====
 * ⛔⛔ 用户铁律（原话）：「焦点不在活动文档的画布上 & 未在画布上落笔时，避免生成 hud」。
 *    第十七轮的显式 AND 门补了 strokeOk / drawOk / fgOk 三个维度，但用户复测
 *    **同样两条抱怨依然存在** ⇒ 缺的正是铁律字面的那两个必要条件：
 *     ⓵ **焦点在活动文档画布上**（canvasOk，本块）—— 实测根因（jwwh-36628）：
 *        套索工具下在**浮动的 UXP 插件面板**（manifest type=panel，可浮动）上用
 *        数位笔调参时，Wintab 是**系统上下文**（CXO_SYSTEM，由驱动侧移动光标），
 *        笔落在面板上包**照常进 detour**（用户截图诊断：取包 18495 / 改写 5966）
 *        ⇒ 压力/按钮非零 ⇒ 接触判据必然为真 ⇒ 起笔闩锁闩住 ⇒ 旧门控全过。
 *        **引擎从 Wintab 数据里分辨不了笔在画布还是面板** —— 必须问 Windows 要焦点。
 *     ⓶ **落笔判据已建立**（!g_ctUnknown，见 wantVisible 处）—— 「程序刚加载
 *        没落笔就出 HUD」的根因：contact_update 有两条**刻意 fail-open** 的路径
 *        （判据不可用 g_ctN<=0 / 冷启动宽限 CT_GRACE_PKT=600），加载后信号未取得
 *        投票权期间 g_contact 恒为 1（jwwh-36628 实测：07:28:45–07:29:46 共 61 秒
 *        `信号=（无）生效=0`，penDown 随包流置 1）⇒ 只要套索已选 + 面板闸门新鲜，
 *        没落笔也出 HUD。本场日志因 toolOk=0 侥幸未触发（上了膛没扣扳机），
 *        用户此前的会话已实见 ⇒ 不是偶发，是**时序依赖**的必然。
 *    ⚠️ ⓶ 只门 HUD，**不改平滑路径**：fail-open 是防「一开就是死的」的刻意取舍，
 *       悬空期改写对用户不可见（没落笔 PS 不画），对 HUD 却直接违反铁律。
 * ========================================================================================= */
static HWND  s_psFrame;        /* PS 主框（class="Photoshop"、本进程；EnumWindows 实测不猜） */
static HWND  s_psMdi;          /* 主框内的 MDIClient = 文档区（停靠面板在框内但不在其下） */
/* 0x0121：PS 2026（OWL 架构）**没有 MDIClient**（jwwh-26156 全程 mdi=0000000000000000
   实测）⇒ 曾把 class="OWL.WindowGroup"、title="Document Layer" 的顶层窗口当作文档区
   判据（同一日志的全景转储实见）。⛔⛔ **0x0122 起该判据已被推翻、不再作 HUD 门
   硬判据**：真机 jwwh-38216 实锤画布上作笔时 WindowFromPoint 的 hit 也不在其子树
   （OWL「层」概念窗 vis=0，画布视图不在其下）⇒ why=4 恒真、HUD 全 Session 不显示。
   HUD 光标判据改认**主框子树**（见 canvas_focus_ok）。此处解析**保留仅作诊断**：
   「Document Layer=...」行仍是 PS 2026 文档窗口存在的有效信号，且全景转储依赖它触发。 */
#define DOCLAYER_MAX 4          /* 多文档同开时可能并列多个；收满即停（排障够用） */
static HWND  s_docLayer[DOCLAYER_MAX];
static int   s_docLayerN;       /* 已解析出的个数（0=未解析/已全部失效） */
static DWORD s_dlTryAt;         /* 解析退避计时（与 s_frameTryAt 同周期 2s） */
static int   s_dlStateLogged = -1; /* 已登录的解析态：-1=从未登录 0=已登录「没有」 1=已登录「有」。
                                   ⛔ 必须按**状态翻转**登录：PS 启动时可能还没有文档
                                   （Document Layer 未创建），用户随后打开文档要能看见
                                   「已解析」行 —— 那是本判据是否武装的唯一验收信号。 */
static DWORD s_frameTryAt;     /* 上次解析尝试时刻（未解析出时 2s 退避重试，不每帧 EnumWindows） */
static int   s_noFrameLogged;  /* 「找不到主框」只打一次（fail-open 降级要留痕但不刷屏） */
static int   s_cvWhyDbg = -1;  /* 焦点门子原因（边沿触发日志）：0 过 / 1 无框(fail-open) /
                                  2 前台非主框 / 3 焦点不在文档区 / 4 光标不在文档区矩形 */
static int   s_frameAttempts;  /* 解析尝试计数（全景转储节流用） */
static int   s_treeDumped;     /* 解析成功后的全景是否已转储过 */

static BOOL CALLBACK frame_pick_cb(HWND h, LPARAM lp)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    if (pid != (DWORD)lp) return TRUE;
    char cls[64];
    cls[0] = 0;
    GetClassNameA(h, cls, sizeof(cls) - 1);
    if (strcmp(cls, "Photoshop") != 0) return TRUE;   /* 只要主框：浮出面版/对话框类名不同 */
    s_psFrame = h;
    return FALSE;                                     /* 找到即停 */
}

/* 全景转储：本进程全部顶层窗口的类名/可见性/标题。
   ⛔ 存在的意义 = 类名假设万一不成立时，日志里有**地面真相**可一次修对，
      而不是再问用户要一轮窗口截图。只在「首次解析」与「解析成功」两个时机打。 */
static BOOL CALLBACK frame_dump_cb(HWND h, LPARAM lp)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    if (pid != (DWORD)lp) return TRUE;
    char cls[64], title[96];
    cls[0] = 0; title[0] = 0;
    GetClassNameA(h, cls, sizeof(cls) - 1);
    GetWindowTextA(h, title, sizeof(title) - 1);
    logf("# [hud] 焦点门·本进程顶层窗口: hwnd=%p class=%s vis=%d title=%s\n",
         (void *)h, cls, IsWindowVisible(h) ? 1 : 0, title);
    return TRUE;
}

/* 0x0121：Document Layer 采集回调（与 frame_dump_cb 同用 A 版 API —— 该类名/标题
   在 ANSI 下可读，jwwh-26156 转储原文即如此）。⛔ 多匹配全收（多文档同开），
   由调用方逐个验活。 */
static BOOL CALLBACK doclayer_pick_cb(HWND h, LPARAM lp)
{
    if (s_docLayerN >= DOCLAYER_MAX) return FALSE;    /* 收满即停 */
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    if (pid != (DWORD)lp) return TRUE;
    char cls[64], title[96];
    cls[0] = 0; title[0] = 0;
    GetClassNameA(h, cls, sizeof(cls) - 1);
    if (strcmp(cls, "OWL.WindowGroup") != 0) return TRUE;
    GetWindowTextA(h, title, sizeof(title) - 1);
    if (strcmp(title, "Document Layer") != 0) return TRUE;
    s_docLayer[s_docLayerN++] = h;
    return TRUE;
}

/* 解析（或重解析）主框与文档区。泵线程调用，2s 退避；解析成功后每帧只 IsWindow。 */
static void frame_resolve(DWORD now)
{
    if (s_psFrame && !IsWindow(s_psFrame)) {
        s_psFrame = NULL; s_psMdi = NULL;
        s_docLayerN = 0; s_dlStateLogged = -1;   /* 0x0121：连文档区判据一起失效 */
    }
    if ((!s_psFrame || !s_psMdi) && (DWORD)(now - s_frameTryAt) >= 2000) {
        s_frameTryAt = now;
        s_frameAttempts++;
        if (!s_psFrame) {
            s_psFrame = NULL;
            EnumWindows(frame_pick_cb, (LPARAM)GetCurrentProcessId());
            if (s_psFrame) {
                s_noFrameLogged = 0;
                logf("# [hud] 焦点门：主框=%p（class=Photoshop 实测）\n", (void *)s_psFrame);
            } else if (!s_noFrameLogged) {
                s_noFrameLogged = 1;
                logf("# [hud] 焦点门：未找到 class=Photoshop 主框 ⇒ 本门 fail-open"
                     "（保持旧行为，HUD 仍受其余门控约束）\n");
            }
        }
        if (s_psFrame) {
            HWND m = FindWindowExW(s_psFrame, NULL, L"MDIClient", NULL);
            if (m != s_psMdi) {
                s_psMdi = m;
                logf("# [hud] 焦点门：MDIClient=%p%s\n", (void *)s_psMdi,
                     s_psMdi ? "" : "（缺失 ⇒ 退粗判：焦点根窗口须为框）");
            }
            /* 0x0121：无 MDIClient（PS 2026 OWL）⇒ 解析 Document Layer 作文档区判据。
               ⛔ 只在没有 MDIClient 时才做：老 PS 的 MDI 路径已同时校验焦点与光标，
                  两条判据同时上场只会互相打架。 */
            if (!s_psMdi) {
                if (!s_docLayerN && (DWORD)(now - s_dlTryAt) >= 2000) {
                    s_dlTryAt = now;
                    s_docLayerN = 0;
                    EnumWindows(doclayer_pick_cb, (LPARAM)GetCurrentProcessId());
                    int st = s_docLayerN > 0 ? 1 : 0;
                    if (st != s_dlStateLogged) {   /* 状态翻转才打：启动无文档→打开文档要可见 */
                        s_dlStateLogged = st;
                        if (st)
                            logf("# [hud] 焦点门：Document Layer=%p（共 %d 个，OWL 文档区）\n",
                                 (void *)s_docLayer[0], s_docLayerN);
                        else
                            logf("# [hud] 焦点门：无 MDIClient 也未找到 Document Layer"
                                 " ⇒ 维持粗判（焦点根窗口须为框，光标不校验）\n");
                    }
                }
                /* 已解析出的逐个验活（文档关闭可能连窗销毁）；全灭才允许重新解析 */
                if (s_docLayerN) {
                    int w = 0;
                    for (int i = 0; i < s_docLayerN; i++)
                        if (IsWindow(s_docLayer[i])) s_docLayer[w++] = s_docLayer[i];
                    if (w != s_docLayerN) {
                        s_docLayerN = w;
                        if (!w) s_dlStateLogged = -1;
                    }
                }
            }
            if (!s_treeDumped) {
                s_treeDumped = 1;
                EnumWindows(frame_dump_cb, (LPARAM)GetCurrentProcessId());
            }
        } else if (s_frameAttempts == 1) {
            /* 第一次就没找到：立刻转储全景（此刻 PS 可能刚起，框未必已建；
               若之后才找到，上面的 !s_treeDumped 分支会再转储一次完整画面） */
            EnumWindows(frame_dump_cb, (LPARAM)GetCurrentProcessId());
        }
    }
}

/* 焦点门求值。返回 1 = 焦点在活动文档画布上（HUD 才准出）。
 * why 出参：0 过 / 1 主框未解析(fail-open) / 2 前台不是主框（浮出面版·对话框·别的 app）
 *          / 3 焦点不在文档区（停靠面板·工具条·选项栏） / 4 光标不在文档区
 *          （有 MDIClient 时判矩形；无 MDIClient 时 0x0122 起判**主框子树**——
 *           不抢焦点的浮动插件面板的最后一网；0x0121 曾判 Document Layer 子树，
 *           被 jwwh-38216 实锤恒真挡死画布 HUD，见实现处注释）。
 * ⛔ cur 必须与快照同刻读（调用方保证）：判的是**原始笔尖**（系统光标）在不在文档区。 */
/* 0x0134：**宽判**——笔落点是否落在 PS 的窗口子树里（**不看前台**）。
   ⛔ 只给「平滑改写 / 补流救援 / GetCursorPos 接管」用；HUD 仍用上面的严格判据。
   ⛔ 为什么不能直接复用 canvas_focus_ok：它第一句就是 `GetForegroundWindow() != 主框 ⇒ 0`，
      而 Wintab 是**系统上下文**，PS 在后台时包照进、也照常绘制（jwwh-40408 实测 fg=0
      的一整段里 `[gate] penDown 0→1` 与 packets 增长照旧）。把那根 HUD 门槛用到救援路径上，
      等于「用户切到聊天窗（哪怕在另一块屏、根本不挡画布）⇒ 断流救援立刻被禁」。
   ⛔ 仍然拒绝「笔落在 PS 自己的对话框/浮动面板上」：那些是独立顶层窗口（root=自身），
      不在主框子树里 ⇒ 与 0x0116/0x0122 的既有语义一致。 */
static int canvas_hit_ok(POINT cur)
{
    if (!s_psFrame) return 1;                      /* 解析不出 ⇒ fail-open 保功能 */
    HWND hit = WindowFromPoint(cur);
    if (!hit) return 1;                            /* 恰在所有窗口外（多屏缝隙）⇒ 放过 */
    if (hit == s_psFrame || IsChild(s_psFrame, hit)) return 1;
    return 0;
}

static int canvas_focus_ok(POINT cur, int *why)
{
    *why = 0;
    if (!s_psFrame) { *why = 1; return 1; }        /* 解析不出 ⇒ fail-open 保功能 */
    HWND fg = GetForegroundWindow();
    if (fg != s_psFrame) { *why = 2; return 0; }
    DWORD pid = 0;
    DWORD tid = GetWindowThreadProcessId(fg, &pid);
    GUITHREADINFO gti;
    gti.cbSize = sizeof(gti);
    HWND focus = (tid && GetGUIThreadInfo(tid, &gti)) ? gti.hwndFocus : NULL;
    if (s_psMdi) {
        if (!(focus && (focus == s_psMdi || IsChild(s_psMdi, focus)))) { *why = 3; return 0; }
        RECT mr;
        if (!GetWindowRect(s_psMdi, &mr)) { *why = 3; return 0; }
        InflateRect(&mr, 1, 1);   /* PtInRect 排除右/下边界 ⇒ 贴边作画会闪，外扩 1px 兜底 */
        if (!PtInRect(&mr, cur)) { *why = 4; return 0; }
        return 1;
    }
    /* 无 MDIClient（PS 2026 OWL 架构）⇒ 粗判焦点根窗口须为框，**再用主框子树判
       光标**（0x0122；0x0121 曾用 Document Layer 子树，被 jwwh-38216 实锤判错，
       见下方实现处注释）。
       ⛔⛔ 只做到粗判是**漏打**：套索工具下在**浮动的插件面板**上用笔调参时，
       Wintab 是系统上下文、包照常进 detour ⇒ 接触判据为真 ⇒ 起笔闩锁闩住；而面板
       不抢焦点（WS_EX_NOACTIVATE）、前台仍是主框 ⇒ 「焦点根窗口=主框」恒过 ⇒ HUD
       在面板上泄漏 —— 正是用户铁律「焦点不在活动文档的画布上 & 未在画布上落笔时，
       避免生成 hud」要禁的形态（jwwh-26156 复现，日志全程 mdi=0000000000000000）。
       ⛔ 主框解析不出 ⇒ 只保留粗判：与 0x0116 行为一致，不引入新回归；
          那时的地面真相由全景转储留给下一轮。 */
    HWND root = focus ? GetAncestor(focus, GA_ROOT) : NULL;
    if (root != s_psFrame) { *why = 3; return 0; }
    /* —— 0x0122：光标必须落在**主框子树**内 ——
       ⛔⛔ 0x0121 的「Document Layer 子树」判据被真机 jwwh-38216 实锤判错：
       画布上正常作画（gate=1 toolOk=1 penDown=1 stroke=1 ctU=1 全绿）时
       WindowFromPoint 的 hit 仍不在 docLayer 子树 ⇒ why=4 恒真 ⇒ 整个
       Session HUD 都不显示（46 条「未显示」里 11 次 why=4，全部发生在
       作笔中）。Document Layer（class=OWL.WindowGroup, vis=0）是 OWL 的
       「层」概念窗，画布视图不在其下。
       ✅ 同一份全景转储给出的地面真相：所有非文档窗口 —— OWL.Dock、
          OWL.WindowGroup（Modal/Palette/Document Layer）、OWL.ShadowView、
          PSFloatC（插件浮窗）、PSToolTip、ComboLBox —— 全是**独立顶层窗口**
          （root=自身）；文档画布窗从不出现在顶层枚举里 ⇒ 它必在主框子树内。
          ⇒ 判据取「hit 在主框子树」：画布作画必过；笔落在任何面板/浮窗/
             停靠坞上时，hit 的 root 是那些顶层窗口自身 ⇒ 一刀切挡掉。
       ⛔ hit==NULL（光标恰在所有窗口外：多屏缝隙/巨型全屏窗边缘）⇒ 放过：
          罕见且 PS 同样收不到这笔，保守不断 HUD。判据若再错，下面 2s
          限流留痕直接给出 hit 类名/标题，下一轮按类名修，不用再要截图。 */
    {
        HWND hit = WindowFromPoint(cur);
        if (hit && hit != s_psFrame && !IsChild(s_psFrame, hit)) {
            *why = 4;
            static DWORD s_hitLogAt;
            DWORD nowH = GetTickCount();
            if ((DWORD)(nowH - s_hitLogAt) >= 2000) {
                s_hitLogAt = nowH;
                char hc[64], ht[96];
                hc[0] = 0; ht[0] = 0;
                GetClassNameA(hit, hc, sizeof(hc) - 1);
                GetWindowTextA(hit, ht, sizeof(ht) - 1);
                logf("# [hud] 焦点门·挡: hit=%p class=%s title=%s cur=(%ld,%ld) frame=%p\n",
                     (void *)hit, hc, ht[0] ? ht : "(无)",
                     (long)cur.x, (long)cur.y, (void *)s_psFrame);
            }
            return 0;
        }
    }
    return 1;
}

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
    /* —— ⑦（LNP `offWhileDrawing` / `renderSleep`）：运笔中把 HUD 帧率减半 ——
       落笔期间 PS 主线程正在跑笔路径，HUD 每 8ms 抢一次只是加剧主线程抖动
       （用户感知到的「冲包」有一部分是它喂出来的）；而运笔时 HUD 画的是拉绳，
       16ms 一帧肉眼无差别。⛔ 只动等待时长、不动门控：HUD 显隐判据不受影响。 */
    int ms = ((g_penDown && g_gateOk) ? HUD_FRAME_MS * 2 : HUD_FRAME_MS);
    if (!timer) { Sleep((DWORD)ms); return; }
    LARGE_INTEGER due;
    due.QuadPart = -(LONGLONG)ms * 10000;             /* 相对时间，100ns 单位 */
    if (SetWaitableTimer(timer, &due, 0, NULL, NULL, FALSE)) {
        WaitForSingleObject(timer, INFINITE);
    } else {
        Sleep((DWORD)ms);
    }
}

/* 0x0208：**隐藏态**的帧等待（见下方 hud_frame_wait_idle 的根因说明）。
   32ms ≈ 31Hz：笔一接触画布，最迟 32ms 后就能判定「该显示了」，肉眼无感
   （HUD 出现本来就带着一帧的建立延迟），而空闲期对窗口管理器的打扰降到 ~1/4。
   ⛔ 必须明显小于 HUD_MAX_LAG_MS(60)：否则空闲态自己就会把下几帧判成「帧滞后」
      （lagSkip），HUD 该显示时反而要多等一轮。 */
#define HUD_IDLE_FRAME_MS 32

/**
 * 隐藏态帧等待：把「什么都没发生」时的唤醒频率从 120Hz 降到 25Hz。
 *
 * ⛔ 为什么（用户报：加载插件后 PS 缩放动画卡顿、抽搐）：
 *    本线程是一个**永久循环**，隐藏时也每 8ms 醒一次，而每一轮都会做一串
 *    **跨线程窗口查询**：`frame_resolve` 的 IsWindow、`canvas_focus_ok` 的
 *    GetForegroundWindow → GetWindowThreadProcessId → **GetGUIThreadInfo（查 PS 的
 *    UI 线程）** → GetAncestor → **WindowFromPoint**（命中测试）→ 可能再 GetWindowRect。
 *    也就是 120 次/秒 × 5~6 个 win32k 调用 ≈ 600~700 次/秒，全部与 PS 自己的
 *    窗口/合成路径争同一把窗口管理锁 —— 而缩放的 Animated Zoom 恰恰是 PS 主线程
 *    最依赖这把锁的一段。⇒ 空闲期（窗口不可见）没必要按渲染帧率跑：
 *    这些查询只用来判断「要不要显示」，40ms 的判定延迟用户不可能察觉。
 * ⛔ 只改**隐藏态**的等待时长；可见态（真正在画拉绳圈）仍是 HUD_FRAME_MS，
 *    手感与之前逐字一致。 */
static void hud_frame_wait_idle(HANDLE timer)
{
    const int ms = HUD_IDLE_FRAME_MS;
    if (!timer) { Sleep((DWORD)ms); return; }
    LARGE_INTEGER due;
    due.QuadPart = -(LONGLONG)ms * 10000;
    if (SetWaitableTimer(timer, &due, 0, NULL, NULL, FALSE)) {
        WaitForSingleObject(timer, INFINITE);
    } else {
        Sleep((DWORD)ms);
    }
}

static LRESULT CALLBACK hud_wndproc(HWND h, UINT m, WPARAM w, LPARAM l)
{
    if (m == WM_NCHITTEST) return HTTRANSPARENT;    /* 穿透：绝不抢任何输入 */
    /* ⛔ 内容一律由 UpdateLayeredWindow 提交（见 hud_thread）⇒ 不参与 GDI 重绘路径：
       擦背景直接吞掉，WM_PAINT 只验证不绘制。否则系统一旦要求重绘，
       DefWindowProc 会把 layered surface 冲掉（表现 = 窗口忽然变空/变黑）。 */
    if (m == WM_ERASEBKGND) return 1;
    if (m == WM_PAINT) { ValidateRect(h, NULL); return 0; }
    return DefWindowProcW(h, m, w, l);
}

/**
 * 按需重建 DIB 并改窗口边长（DPI 缩放变化 / 半径拉大时）。只**增大**，不缩回
 * （缩回会在跨屏移动时来回抖）。返回新的边长；失败沿用旧值（功能不中断）。
 */
static int hud_resize(HWND wnd, int need, HBITMAP* dib, HDC mem, int cur, void** pbits)
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
    if (pbits) *pbits = bits;                   /* 像素基址交给调用方（alpha 化用） */
    SetWindowPos(wnd, NULL, 0, 0, need, need,
                 SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    return need;
}

/* 四舍五入到整像素（负坐标按「远离 0」取整 —— `(int)` 是截断，会在 0 附近
   产生 1px 的系统性偏移，多屏左侧/上侧坐标就是负的）。 */
static int hud_round_px(double v)
{
    return (int)(v >= 0.0 ? (v + 0.5) : (v - 0.5));
}

/* ⛔⛔ 0x020D：整像素**迟滞**提交（Schmitt 触发）。
   窗口只能摆整数坐标，而候选位置是「光标(整数) − 偏移(浮点)」⇒ 天生带亚像素噪声；
   噪声在 .5 边界左右穿，窗口就会在相邻两格之间**反复跳 1px** —— 这正是用户报的
   「圆环与圆心一直非常小幅地抖」的最后一环（前面的噪声源见绘制段的长注释）。
   规则：已提交 = N 时，候选要偏出 N ± (0.5 + HUD_PX_HYST) 才换格；换格之后要回到
   原格，必须反向偏出 (0.5 − HUD_PX_HYST)。
   ⇒ 边界处死区宽 2·HYST(=0.3px)，代价是最大 0.5+HYST(=0.65px) 的静态偏移 ——
     肉眼不可见，换来的是「停在边界上也不再翻格」。 */
#define HUD_PX_HYST 0.15
static int hud_sticky_px(double cand, double* committed)
{
    double d = cand - *committed;
    if (d >= 0.5 + HUD_PX_HYST || d <= -(0.5 + HUD_PX_HYST))
        *committed = (double)hud_round_px(cand);
    return (int)*committed;
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
    void*    dibBits = NULL;       /* DIB 像素基址（alpha 化用；随 hud_resize 更新） */
    int      hudSize = HUD_SIZE;   /* 当前窗口/DIB 边长（随 DPI 按需放大，见 hud_resize） */
    /* —— 0x020D：位置稳定化的三件状态（根因与判据见绘制段注释）——
       putX/putY = 已提交的窗口左上角（整像素，用 double 存是为了做迟滞比较）；
       putOutX/Y = 提交这个位置时快照里的**绘制点**（轴坐标）。两者相等 ⇒ 绘制点
                   这几帧一个字节都没动 ⇒ 圆心不许动，位置直接复用。 */
    double   putX = 0.0, putY = 0.0;
    int      putValid = 0;                 /* 0 = 没有可复用的位置（首次 / 刚隐藏过 / 换过尺寸） */
    LONG     putOutX = 0, putOutY = 0;

    if (atom || GetLastError() == ERROR_CLASS_ALREADY_EXISTS) {
        /* ⛔⛔ WS_EX_TRANSPARENT **必须留着**（2026-10-16 第十四轮，代价惨重的回归）。
           0x010A 曾把它删掉，理由「鼠标穿透已由 WM_NCHITTEST→HTTRANSPARENT 保证」
           是错的 —— 两条事实：
             ① `WM_NCHITTEST→HTTRANSPARENT` 只在**同一个线程内**向下传递
                （MSDN：the message will be sent to underlying windows in the
                 **same thread**）。HUD 窗口跑在 hud_thread 上，PS 的主窗在另一个
                线程 ⇒ **跨线程根本传不过去**，这条路等于没有。
             ② 分层窗口的命中测试是**按像素 alpha** 走的：alpha=0 的像素穿透，
                **画了东西的像素会把鼠标消息吃掉**。而 HUD 的拉绳曲线终点恰好画在
                光标上（见绘制段 `(half+vx, half+vy)`，vx/vy 就是光标相对窗口中心的
                偏移）⇒ **光标下永远压着一个不透明像素** ⇒ HUD 恒抢走笔按下事件
                ⇒ PS 收不到拖拽 ⇒ 真机形态「平滑生效时什么都画不出来，断流期
                （HUD 被 SW_HIDE）反而能画出未平滑的选区」。
           正解就是 WS_EX_TRANSPARENT（MSDN「Layered Windows」原文）：
             "if the layered window has the WS_EX_TRANSPARENT extended window style,
              the shape of the layered window will be ignored and the mouse events
              will be passed to other windows underneath the layered window."
           ⛔ 它**不影响**我们的显示：ULW 是直接提交给 DWM 的，不走 WM_PAINT
              （`hud_wndproc` 已把 WM_ERASEBKGND/WM_PAINT 吞掉）；
              「等兄弟窗口绘制」那条语义只作用于 GDI 重绘路径。
              ✅ 旁证：0x0106/0x0107 时代带着这个样式，HUD 看得见**且**能正常绘制。 */
        /* ⛔⛔ 2026-10-16 第十五轮：**建窗即置顶**（`WS_EX_TOPMOST`）。
           真机判决（jwwh-22288 vs jwwh-13772/21904，各 30~56 条 `[hud] 显示:` 样本）：
             有 WS_EX_TOPMOST 的会话 → 用户看得到 HUD；
             没有的会话（ex=0x80800A0）      → 五条自检全绿却一秒看不见。
           ⇒ 可见性的**唯一**依赖是「窗口真的在 topmost 带里」。既然
             `SetWindowPos(HWND_TOPMOST)` 返回值不可信（raise=1 却读不到该位），
             就把它钉在建窗参数上，不再依赖那一次调用。 */
        wnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TOPMOST
                              | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE,
                              HUD_CLASS, L"", WS_POPUP,
                              0, 0, HUD_SIZE, HUD_SIZE, NULL, NULL, inst, NULL);
        if (!wnd) {
            logf("# [hud] CreateWindowExW 失败 err=%lu\n", (unsigned long)GetLastError());
        }
    }
    if (wnd) {
        /* ⛔⛔ 2026-10-16 第十二轮：**不再** SetLayeredWindowAttributes(LWA_COLORKEY)。
           改用 UpdateLayeredWindow + 32bpp 预乘 alpha 提交（见绘制段）：
             · 两者互斥（先设 color key 会让 ULW 失败）；
             · color key 的坑是「画笔色一旦为纯黑 = 整窗透明」，ULW 没这个问题；
             · ULW 是 layered window 的**官方提交路径**，DWM 一定认，
               不像 GetDC+BitBlt 那样「调用全成功却不上屏」。 */
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
        dibBits = bits;
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
           ⛔ 年龄一律走 sn_age_ms()（有符号）——它同时躲开「2^31 翻转」与「跨线程
           超前下溢」两个坑，细节见 sn_age_ms 定义处的长注释。 */
        DWORD now = GetTickCount();
        /* ⛔ 帧滞后（LNP `maxMsgLagForRender`）：本帧距上一帧超过阈值 ⇒ 本帧不渲染。
           成因是渲染线程被拖慢（PS 主线程卡、DWM 忙），此时圆心几何已经陈旧，
           硬画一帧只会把「陈旧的圆」糊在屏幕上。窗口保持上一帧内容，**不隐藏**。 */
        int lagSkip = 0;
        {
            static DWORD s_prevFrameMs;
            lagSkip = (s_prevFrameMs && (DWORD)(now - s_prevFrameMs) > HUD_MAX_LAG_MS) ? 1 : 0;
            s_prevFrameMs = now;               /* ⛔ 每条路径都只经过这里一次 ⇒ 必然更新 */
            InterlockedExchange(&g_lagSkipDbg, lagSkip ? 1 : 0);
        }
        int active = 0;
        if (g_cfg && g_patched && g_calib.valid && g_cfg[CFG_I_ENABLED]) {
            if (sn_age_ms(now) < HUD_IDLE_MS) active = 1;
        }

        /* ⛔⛔ 闸门闸门闸门：HUD 只在「工具是套索」且「笔尖确实接触画布」时出现。
           用户的原话是「使用别的工具，或者用户落笔前，我不希望……错误的 HUD 的干扰」。
           这两个判据由 detour 写入 g_toolOk / g_penDown —— 渲染线程只读它们，
           不重复判一次（判据写两遍，漂移一次就再也对不上）。 */
        int gateOk = ((g_toolOk && g_penDown) && !tool_gate_sure_not_lasso()) ? 1 : 0;
        /* 0x020A：Alt 临时吸管态 ⇒ HUD **一定**不显示。
           用户原话：「Alt 键临时切换为吸管后，按下吸色时会错误地触发 HUD 显示；
           吸管工具不应带有类似套索平滑的 HUD」。
           ⛔ 为什么这一项必须独立于 gateOk：g_toolOk 由包路径写，而吸管点击那一批
              可能正好落在 useGate 由 1→0 的边界上（旧值还是 1）；只靠 g_toolOk
              会让 HUD 在吸管的第一笔闪一下。这里是纯内存读，零成本。 */
        if (g_cfg && (g_cfg[CFG_I_ALTTOOL] || g_cfg[CFG_I_POLYALT])) gateOk = 0;
        /* 0x0211：`CFG_I_POLYALT` 也必须在这里单独压一次（而不是只靠 tool_edit_allowed）：
           渲染线程用的是 `g_toolOk && g_penDown` 这两个由**包路径**写的值，而包路径在
           标定失效时会提前 return（永不更新）—— 那两位可能冻在 1。物理 Alt 是纯内存
           事实，与 `g_toolOk` 的链路完全无关 ⇒ 在这里直接压。 */
        /* 0x0209：`!tool_gate_sure_not_lasso()` 这一项是**独立兜底**，不是重复判断。
           `g_toolOk` 由包路径写，而包路径在标定失效时会**提前 return**（永不更新）
           ⇒ 那个值会一直冻结在上一次成功改写时的 1。用户报的「切到涂抹、HUD 还在」，
           除了闩锁冻结之外，这一条冻结是第二条通路。面板一旦明确报了非套索，
           无论包路径有没有在跑，HUD 都必须立刻收起来（纯内存读，零成本）。 */

        /* —— 2026-10-17 第十七轮：HUD 显示门控由「两个布尔」升级为**显式 AND 门** ———
           ⛔⛔ 起因（用户报的两条）：
             ① 「程序刚加载时没有落笔就产生 HUD」；
             ② 「套索工具下调面板参数落笔，也会意外出现 HUD」。
           旧的 `gateOk = toolOk && penDown` 只有**两个**维度，而这两条抱怨要的是
           第三、第四个维度：
             · **strokeOk**（真的在一笔之中）：`g_strokeGate == 1` 只在「工具对 + 笔尖
               接触 + 已开始改写」时被闩住。加载后没落笔 ⇒ 它必为 -1 ⇒ 绝不出 HUD。
             · ~~**drawOk**（工具确实在绘制态）：来自 PS 的 `toolModalStateChanged`。~~
               ⛔⛔ **2026-10-17 真机判决（jwwh-3064）：这一项已被证伪并移除，见下。**
             · **fgOk**（前台是本进程）：照 LNP 的 `foregroundWindowChange` 判据，
               并配 `Very fast fg change (%d ms), ignoring` 的同款**去抖**
               ⇒ 面板/对话框抢焦点造成的毫秒级抖动不会让 HUD 闪。
             · **!bigJump**：照 LNP 的 `overlay.bigJumpSqDist`，一帧内光标瞬移超过
               阈值 ⇒ 本帧不画（防「瞬移拉一条长线」）。
           ⛔ 每多一个维度都要能**单独**在 `[hud] 未显示:` 行里看出来，否则排障靠猜。 */
        int strokeOk = (g_strokeGate == 1) ? 1 : 0;
        LONG tmv = g_cfg ? g_cfg[CFG_I_TMODAL] : -1;
        int  tmK = g_cfg ? (g_cfg[CFG_I_TMODALK] != 0 ? 1 : 0) : 0;
        /* ⛔⛔ 2026-10-17 真机判决（jwwh-3064 + pi8li.log）：`toolModalStateChanged`
           **不能用作门控** —— 原实现 `drawOk = 极性已证 ? (值==1) : 放行` 在真机上
           把 HUD **永久挡死**了。证据链：
             · 该事件 64 次投递**全部**是「1ms 内 1→0 成对翻转」
               （06:32:00.072 变 1、.073 变 0；06:33:33 第 64 次亦然）；
             · 于是「最后一次值」恒为 0，而极性一经那两次翻转就被判「已证明」⇒
               `drawOk` 从 06:32:02 起恒为 0，`[hud] 未显示` 行里
               `draw=0(tm=0,k=1)` 一路持续到日志末尾；
             · 后果 = **即使切回套索，HUD 也再不会显示**（这正是用户报的
               「切换工具后 HUD 就失效了」里那条本不该有的失效）。
           ⇒ 它不是「工具是否在绘制态」，而是 PS 每次工具操作的**模态抖动**
           （`'Lvl '` 与 `modalStateChanged` 是同一个键，只是层级瞬时起落）。
           ⇒ **门控移除，只保留诊断显示**。①诉求（只在套索绘制时出 HUD）由
             `gateOk`（工具闸门）∧ `strokeOk`（一笔之中，含 penDown）完全覆盖：
             真机 06:31:57 之前的正常显示正是这两项在工作。 */
        int drawOk = 1;   /* ⛔ 恒放行 —— 见上方真机判决；tmv/tmK 仍落日志供继续取证 */
        {
            /* 前台判定 + 去抖（只在稳定态翻转时才改 s_fgOk）。 */
            static int   s_fgOk = 1;        /* 初值取「是」：加载时 PS 必然在前台 */
            static int   s_fgInst = 1;
            static DWORD s_fgChgAt = 0;
            DWORD fgPid = 0;
            HWND  fg = GetForegroundWindow();
            if (fg) GetWindowThreadProcessId(fg, &fgPid);
            int inst = (fgPid != 0 && fgPid == GetCurrentProcessId()) ? 1 : 0;
            if (inst != s_fgInst) { s_fgInst = inst; s_fgChgAt = now; }
            if (inst != s_fgOk && s_fgChgAt && (DWORD)(now - s_fgChgAt) >= HUD_FG_DEBOUNCE_MS) {
                s_fgOk = inst;
                logf("# [hud] 前台切换（去抖 %dms 后确认）：本进程=%d\n",
                     HUD_FG_DEBOUNCE_MS, s_fgOk);
            }
            g_fgOkDbg = s_fgOk ? 1 : 0;
        }

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
        /* ⛔⛔ `cur` 必须**先初始化**再交给 GetCursorPos：该调用在失败时**不写**
           出参（例如线程未附着到输入桌面），旧版直接用未初始化的栈值做
           `SetWindowPos(cur.x - rx - half, …)` ⇒ 窗口被钉到任意坐标（很可能在屏外）
           ⇒ 观感正是「HUD 该显示却完全看不到」。失败时按 (0,0) 兜底并节流报一次。 */
        POINT cur = { 0, 0 };
        if (!se_real_GetCursorPos(&cur)) {
            static DWORD s_lastCurFail;
            if ((DWORD)(now - s_lastCurFail) >= 5000) {
                s_lastCurFail = now;
                logf("# [hud] ★GetCursorPos 失败 err=%lu ⇒ 本帧窗口位置不可信（按 0,0 兜底）\n",
                     (unsigned long)GetLastError());
            }
        }
        /* ⛔⛔ 大跳跃丢弃（LNP `overlay.bigJumpSqDist`）：一帧内光标瞬移超过阈值 ⇒ 本帧不画。
           场景：跨显示器 / 面板弹窗把光标顶走 / 驱动回中。少了这一条，就会出现
           「一次瞬移拉出一条横跨屏幕的长绳」—— 用户眼里就是「HUD 忽然乱画一下」。 */
        int bigJump = 0;
        {
            static double s_pcx = 0, s_pcy = 0;
            static int    s_havePc = 0;
            if (s_havePc) {
                double jx = (double)cur.x - s_pcx, jy = (double)cur.y - s_pcy;
                if (jx * jx + jy * jy > HUD_BIG_JUMP_SQ) bigJump = 1;
            }
            s_pcx = (double)cur.x; s_pcy = (double)cur.y; s_havePc = 1;
            InterlockedExchange(&g_jumpSkipDbg, bigJump ? 1 : 0);
        }
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
            /* ⛔⛔ 必须**有符号**（2026-10-16 第十轮）：`snMs` 是 g_snMs 的局部拷贝，
               PS 线程刚写、HUD 线程紧跟着读时它会比 now 大 ⇒ 无符号相减下溢成 ~4.29e9
               ⇒ 下面的 `age <= 40` 恒假 ⇒ **整段外推被跳过** ⇒ 圆心退回「out 的包时刻
               位置」，用户报告过的「圆心与受力点错位 15px」会**偶发回归**。
               改用 LONG 后：负值（快照在未来）被 `age >= 1` 正常排除，语义不变。 */
            LONG age = (LONG)(DWORD)(now - (DWORD)snMs);
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
            LONG snAgeG = sn_age_ms(now);   /* ⛔ 有符号：见 sn_age_ms 注释 */
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
        LONG pktAge = sn_age_ms(now);   /* ⛔ 有符号：见 sn_age_ms 注释；负值=刚有包 */
        /* ⛔ enabled 也必须判（第八轮补）：平滑关着时 out 快照冻结在旧值，
           HUD 会拿冻结快照画圈 —— 真机实锤「前十笔 HUD 显示但显示错误」。
           ⛔⛔ 断流态**不再画 HUD**（2026-10-16 第十一轮，用户实测判决）：
              上一版让 HUD 在断流期「降级显示」（圆心钉光标、不画绳、改红色）。
              用户判定这就是错误显示：「断流时 HUD 也会出错，受力点施力点重合」。
              几何上确实如此 —— 圆心（受力点）本该是选区末端，钉到光标上就与施力点
              重合，与用户的术语约定完全相反。**画一个错的圆比不画更糟**。
              ⇒ 断流期一律隐藏；断流状态由面板状态条「平滑中断」告知，HUD 只负责
                 正常期「选区末端 vs 笔尖」的几何提示。 */
        /* ⛔⛔ 0x0126：救场期仍可显示，但**必须有真实包作证**。
           0x0124 用 `!g_synWas` 放开了断流期隐藏，代价是「用户在断流期间抬笔」时
           合成包的 sticky tip 把我方判据喂成落笔 ⇒ **悬空时 HUD 冒出几秒再消失**
           （用户 0x0125 验收第 3 条新 BUG，复现频率很高）。
           ⇒ HUD 是「视觉承诺」，只能建立在真实证据上：最后一批真实包必须在
             HUD_REAL_MS 内。合成包负责维持 PS 的笔迹（那是另一件事），不负责点亮 HUD。
           ⛔ 0x020F 补一档（用户报「正常绘制中 HUD 偶尔闪一下」）：这条规则原本连
             「一笔进行中、快照仍冻结在最后一批真实包上」也一起否掉 —— 那种几何是可信的，
             隐藏它只有闪烁没有收益。见下面 realOk 的分档。 */
        LONG realAgeHud = g_lastRealMs ? (LONG)(now - (DWORD)g_lastRealMs) : 0x7FFFFFFF;
        int deadNow = (g_streamDead && g_penDown == 1 && !g_synWas) ? 1 : 0;
        int realOk  = 0;
        if (realAgeHud >= 0 && realAgeHud <= HUD_REAL_MS) realOk = 1;
        else if (g_synWas == 0 && g_strokeGate == 1 && realAgeHud <= HUD_REAL_SLACK_MS) {
            /* 0x020F：一笔进行中且快照仍来自真实包 ⇒ 冻结的几何仍可信，不许隐藏。
               留痕（节流 2s）以便真机核对「这次没闪」是宽限挡住的还是根本没过期。 */
            static DWORD s_slackLogAt;
            realOk = 1;
            if ((DWORD)(now - s_slackLogAt) >= 2000) {
                s_slackLogAt = now;
                logf("# [hud] 真实包过期宽限: real=%ldms（一笔进行中，几何取最后一批真实包）\n",
                     (long)realAgeHud);
            }
        }
        int activeNow = (pktAge < HUD_IDLE_MS || (gateOk && pktAge < HUD_HOLD_MS));
        /* ⛔⛔ 显式 AND 门（第十七轮 + 第十八轮）—— 每一项都是**必要条件**，少一项就不出 HUD：
             窗口在 · 有包流 · 工具是套索且笔尖接触 · **真的在一笔之中**
             · **前台是本进程** · **焦点在活动文档画布上** · **落笔判据已建立**
             · 非断流 · 拉绳模式 · 面板开了 bit0 · 总开关开
             （0x020F 起「大跳跃」「帧滞后」不在此门内：它们只决定要不要重绘）
           ⚠️ 「工具在绘制态」（`toolModalStateChanged`）**已于 2026-10-17 真机证伪并移出
              门控**（见 `drawOk` 定义处），此处保留在诊断行里只为继续取证。
           ⛔ 初值语义：`strokeOk` 在加载后必然是 0（g_strokeGate 初值 -1，只有真正
             起笔才被闩成 1）⇒ 「刚加载就出 HUD」从构造上就不可能。
           ⛔⛔ 第十八轮（0x0116）补铁律字面的最后两项，用户复测十七条抱怨仍在：
             · **canvasOk**（焦点在活动文档画布上）：面板上用数位笔调参时 Wintab
               系统上下文照常进包（接触判据必然为真）⇒ 必须问 Windows 要焦点，
               见 `canvas_focus_ok` 上方大注释。
             · **ctOk**（落笔判据已建立）：contact_update 有两条刻意 fail-open
               （判据不可用 / 冷启动宽限），加载后 61s 实测 penDown 随包流置 1
               （jwwh-36628：07:28:45–07:29:46 `信号=（无）生效=0`）⇒ 没落笔也出 HUD。 */
        int fgOk = (g_fgOkDbg != 0) ? 1 : 0;
        int ctOk = (g_ctUnknown == 0) ? 1 : 0;
        /* 0x0208：**先过便宜闸门，再问窗口管理器**。
           ⛔ 为什么（用户报缩放动画卡顿）：`canvas_focus_ok` 每帧要做
              GetForegroundWindow → GetWindowThreadProcessId → **GetGUIThreadInfo
              （查 PS 的 UI 线程）** → GetAncestor → **WindowFromPoint**（命中测试），
              必要时再 GetWindowRect —— 4~6 次跨线程 win32k 调用。
              而在此之前的一串判据（笔抬着 / 工具不对 / 不在一笔之中 / 非拉绳 /
              功能关着）全都是**普通内存读**，它们不成立时 HUD 本来就不可能显示。
              ⇒ 把这些免费判据提到前面，不成立就一个窗口调用都不发。
           ⛔ 跳过时保留上一次的焦点门结论（供诊断行显示），否则 cvWhy 会在 0↔x
              之间翻转，把「焦点门: why=」的边沿日志刷成噪音。 */
        int cheapOk = (wnd && mem && activeNow && gateOk && strokeOk && drawOk && fgOk
                       && ctOk && !deadNow && ropeMode && realOk
                       && (hf & 1) && g_cfg && g_cfg[CFG_I_ENABLED] && !g_engineOff) ? 1 : 0;
        /* ⛔⛔ 0x020F：`bigJump` / `lagSkip` 已从本闸门**移出**。
           它们描述的是「这一帧不适合**重画**」，不是「HUD 不该存在」——
           放进 AND 门就会走 `!wantVisible` 分支调 ShowWindow(SW_HIDE)，
           与 `HUD_MAX_LAG_MS` 注释写的「只是跳过重画，窗口保持上一帧内容」
           直接矛盾，也正是用户报的「绘制过程中 HUD 偶尔闪一下又回来」。
           ⇒ 现在它们在 wantVisible 之后再判，只跳过重绘（见 `staleFrame`）。 */
        frame_resolve(now);
        static int s_cvOkLast, s_cvHitLast;   /* 跳帧时沿用的上一次结论（仅诊断用） */
        int cvWhy = s_cvWhyDbg;               /* 默认不翻转 ⇒ 不误报「焦点门恢复」 */
        int canvasOk, canvasHit;
        if (cheapOk) {
            cvWhy = 0;
            canvasOk = canvas_focus_ok(cur, &cvWhy);
            canvasHit = (canvasOk ? 1 : canvas_hit_ok(cur));
            s_cvOkLast = canvasOk; s_cvHitLast = canvasHit;
        } else {
            canvasOk = s_cvOkLast; canvasHit = s_cvHitLast;
        }
        if (cvWhy != s_cvWhyDbg) {
            /* 边沿触发：只在焦点门结论翻转时打一行，带窗口类名 ⇒ 用户日志可与操作逐条对齐 */
            s_cvWhyDbg = cvWhy;
            if (cvWhy == 0) {
                logf("# [hud] 焦点门恢复: 焦点回到活动文档画布（frame=%p mdi=%p）\n",
                     (void *)s_psFrame, (void *)s_psMdi);
            } else {
                static const char *whyTxt[] = {
                    "", "主框未解析⇒本门放行(fail-open)", "前台不是主框",
                    "焦点不在文档区", "光标不在文档区矩形"
                };
                HWND fg2 = GetForegroundWindow();
                DWORD pid2 = 0, tid2 = fg2 ? GetWindowThreadProcessId(fg2, &pid2) : 0;
                GUITHREADINFO gti2;
                gti2.cbSize = sizeof(gti2);
                HWND foc2 = (tid2 && GetGUIThreadInfo(tid2, &gti2)) ? gti2.hwndFocus : NULL;
                char fa[64], fb[64];
                fa[0] = 0; fb[0] = 0;
                if (fg2)  GetClassNameA(fg2, fa, sizeof(fa) - 1);
                if (foc2) GetClassNameA(foc2, fb, sizeof(fb) - 1);
                logf("# [hud] 焦点门: why=%d(%s) fg=%p(%s) focus=%p(%s)"
                     " frame=%p mdi=%p cur=(%ld,%ld)\n",
                     cvWhy, whyTxt[cvWhy], (void *)fg2, fa, (void *)foc2, fb,
                     (void *)s_psFrame, (void *)s_psMdi, (long)cur.x, (long)cur.y);
            }
        }
        InterlockedExchange(&g_strokeOkDbg, strokeOk ? 1 : 0);
        InterlockedExchange(&g_drawOkDbg,   drawOk  ? 1 : 0);
        InterlockedExchange(&g_canvasOkDbg, canvasOk ? 1 : 0);
        InterlockedExchange(&g_canvasHitDbg, canvasHit ? 1 : 0);
        InterlockedExchange(&g_ctOkDbg,     ctOk ? 1 : 0);
        /* ⛔ 0x0208：判据收成「便宜闸门 ∧ 焦点门」。便宜闸门里已含全部
           wnd/mem/active/gate/stroke/draw/fg/ct/dead/rope/实包/hudBits/开关
           各项（0x020F 起不含 jump/lag，它们只影响是否重绘），逐字等价于原来的
           整条 AND；这样跳帧时 canvasOk 的**沿用值**不会再冒充「焦点在画布上」。 */
        int wantVisible = (cheapOk && canvasOk) ? 1 : 0;
        /* —— 0x020A：显示去抖（根因见 HUD_RESURF_DEBOUNCE_MS 处）——
           ⛔ 只在「刚隐藏过」时启用：正常起笔（首次 / 隔了 >1.5s）必须立即出现，
              否则每一笔的圆都会迟到 180ms，手感立刻变钝。 */
        static int   s_hudVisible;
        static DWORD s_hudHideAt;
        static DWORD s_hudWantSince;
        static DWORD s_hudMissSince;      /* 0x020F：门槛连续为假的起点（0 = 现在为真） */
        static int   s_hudMissHold;       /* 0x020F：本段抖动里被「维持显示」吃掉的帧数 */
        if (wantVisible) {
            if (!s_hudWantSince) s_hudWantSince = now;
            if (s_hudHideAt && (DWORD)(now - s_hudHideAt) < HUD_RESURF_WINDOW_MS
                && (DWORD)(now - s_hudWantSince) < HUD_RESURF_DEBOUNCE_MS)
                wantVisible = 0;
        } else {
            s_hudWantSince = 0;
        }
        /* —— 0x020F：隐藏去抖（根因见 HUD_HIDE_DEBOUNCE_MS 处）——
           ⛔ 只对「本来正在显示」的 HUD 生效：该不显示的时候多撑几十毫秒没有意义，
              而正在显示时闪一下的代价要大得多（它还会被 180ms 重现去抖放大）。
           判据是「连续为假」的时长，中间只要有一帧为真就重新计时。 */
        if (wantVisible) {
            s_hudMissSince = 0;
        } else if (s_hudVisible) {
            if (!s_hudMissSince) s_hudMissSince = now;
            if ((DWORD)(now - s_hudMissSince) < HUD_HIDE_DEBOUNCE_MS) {
                wantVisible = 1;          /* 瞬时抖动：维持显示，不提交隐藏 */
                s_hudMissHold++;
            }
        }
        if (!wantVisible) {
            if (s_hudVisible) {
                s_hudVisible = 0;
                s_hudHideAt = now;
                /* ⛔ 0x020F：这一行是「HUD 为什么消失」的**唯一**直接证据，必须自带
                   全部子项 —— 旧版只打 ck/cv/gate/stroke，ck=0 时看不出是谁断的，
                   排障只能靠 2s 节流的「未显示」行反推。 */
                logf("# [hud] 隐藏: 门槛断满 %ldms（其间抑制抖动 %d 帧）"
                     " ck=%d cv=%d gate=%d(toolOk=%ld penDown=%ld) stroke=%d draw=%d"
                     " fg=%d ctU=%ld dead=%ld rope=%d real=%ldms active=%d(t=%ldms)"
                     " altTool=%ld poly=%ld\n",
                     (long)(s_hudMissSince ? (DWORD)(now - s_hudMissSince) : 0),
                     s_hudMissHold, cheapOk, canvasOk, gateOk,
                     (long)g_toolOk, (long)g_penDown, strokeOk, drawOk,
                     fgOk, (long)g_ctUnknown, (long)deadNow, ropeMode,
                     (long)realAgeHud, activeNow, (long)pktAge,
                     (long)(g_cfg ? g_cfg[CFG_I_ALTTOOL] : -1),
                     (long)(g_cfg ? g_cfg[CFG_I_POLYALT] : -1));
                s_hudMissHold = 0;
            }
            s_hudMissSince = 0;
            if (wnd && IsWindowVisible(wnd)) ShowWindow(wnd, SW_HIDE);
            /* 0x020D：隐藏期间不维护位置 ⇒ 下次出现必须重新定位（否则会先复用
               上一笔的旧位置，视觉上等于「冒出来时先错一帧再跳回来」）。 */
            putValid = 0;
            /* ⛔ 「HUD 没能显示」必须能一眼定位：把六个条件逐个打出来（节流 2 秒，
               并且只在功能开着时打，避免关着的时候刷屏）。
               判读：
                 wnd/mem=0      ⇒ 建窗或 DIB 失败（本实例根本没窗口）
                 active=0       ⇒ 钩子没挂（g_patched=0 ⇒ t 会一直涨）或久无包
                 gate=0         ⇒ toolOk/penDown 有 0：工具不对，或笔没落纸面，
                                  或落笔判据不可用（另见 contactUnknown）
                 cv=0           ⇒ 焦点门挡住：前台是浮出面版/对话框、焦点在停靠面板/
                                  工具条、或光标（原始笔尖）不在文档区矩形内。
                                  子原因看上一行「焦点门: why=」（边沿触发）
                 ctU=1          ⇒ 落笔判据未建立（信号无投票权 / 判据不可用）——
                                  刻意不出 HUD：此刻的 penDown 可能是 fail-open 假值
                 rope=0         ⇒ 当前不是「拉绳」模式（HUD 只在拉绳模式出现）
                 hudBits 无 bit0 ⇒ 面板的「拉绳提示」是关的
                 ck=0           ⇒ 0x0208：便宜闸门已否 ⇒ 本轮**没有**问窗口管理器，
                                  cv 是上一次评估的沿用值（看它没有意义） */
            if (g_cfg && g_cfg[CFG_I_ENABLED] && (DWORD)(now - lastHudWhy) >= 2000) {
                lastHudWhy = now;
                logf("# [hud] 未显示: wnd=%d mem=%d active=%d(t=%ldms) gate=%d"
                     "(toolOk=%ld penDown=%ld) stroke=%d draw=%d(tm=%ld,k=%ld) fg=%d cv=%d ctU=%ld "
                     "jump=%d lag=%d rope=%d hudBits=%ld dead=%ld deadHide=%d real=%ldms ck=%d\n",
                     wnd ? 1 : 0, mem ? 1 : 0, activeNow, (long)pktAge, gateOk,
                     (long)g_toolOk, (long)g_penDown, strokeOk, drawOk,
                     (long)tmv, (long)tmK,
                     fgOk, canvasOk, (long)g_ctUnknown, bigJump, lagSkip, ropeMode, (long)hf,
                     (long)g_streamDead, deadNow, (long)realAgeHud, cheapOk);
            }
            /* 0x0208：隐藏态走 25Hz 的低频等待（根因见 hud_frame_wait_idle）。 */
            hud_frame_wait_idle(frameTimer);
            continue;
        }
        /* —— 0x020F：陈旧帧只「跳过重绘」，绝不隐藏 ——
           ⛔⛔ 这是 `HUD_MAX_LAG_MS` / `HUD_BIG_JUMP_PX` 注释里写明的语义（「窗口保持
              上一帧内容，不是隐藏」），但旧版把它们并进了 `cheapOk` ⇒ 走的是
              `ShowWindow(SW_HIDE)` ⇒ 用户看到的就是「绘制过程中 HUD 闪一下又回来」。
              一帧（8ms）的陈旧圆心，代价远小于一次消失—重现（那还要再吃 180ms 去抖）。
           ⛔ 两种例外必须照常重绘：
              · 窗口当前不可见 ⇒ 没有「上一帧内容」可保持，画一帧才有东西看；
              · 连续跳帧超过 HUD_SKIP_MAX_MS ⇒ 线程被长时间抢占，此时圆会静止不动，
                宁可糊一帧陈旧几何也不能让窗口僵在那里。 */
        static DWORD s_skipSince;
        int staleFrame = (lagSkip || bigJump) ? 1 : 0;
        if (staleFrame) {
            if (!s_skipSince) s_skipSince = now;
            if (!IsWindowVisible(wnd) || (DWORD)(now - s_skipSince) >= HUD_SKIP_MAX_MS)
                staleFrame = 0;
        }
        if (staleFrame) {
            static DWORD s_skipLogAt;
            if ((DWORD)(now - s_skipLogAt) >= 2000) {
                s_skipLogAt = now;
                logf("# [hud] 跳过重绘（不隐藏）: lag=%d jump=%d 连续=%ldms\n",
                     lagSkip, bigJump, (long)(DWORD)(now - s_skipSince));
            }
            hud_frame_wait(frameTimer);
            continue;
        }
        s_skipSince = 0;
        /* 0x020A：显示边沿留痕（与上面的「隐藏」成对）。
           ⛔ 这两行是「HUD 意外闪现」类问题的**唯一**直接证据 —— 此前显示动作
              完全不留痕，只能靠「未显示」行的 2s 节流缺口反推，4 帧的闪现根本看不见。 */
        if (!s_hudVisible) {
            s_hudVisible = 1;
            logf("# [hud] 显示: stroke=%d penDown=%ld toolOk=%ld roi=(%ld,%ld) "
                 "altTool=%ld poly=%ld t=%ldms real=%ldms\n",
                 strokeOk, (long)g_penDown, (long)g_toolOk,
                 (long)g_snOutX, (long)g_snOutY,
                 (long)(g_cfg ? g_cfg[CFG_I_ALTTOOL] : -1),
                 (long)(g_cfg ? g_cfg[CFG_I_POLYALT] : -1),
                 (long)pktAge, (long)realAgeHud);
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
        /* ⛔ 黑色防线：0x010A 起透明走 ULW_ALPHA（真 alpha 通道），纯黑**不再**等于
           透明，理论上这个兜底已经不需要了（留着是因为它另一个作用仍然成立：面板漏推 /
           推 0 / 槽位被清零时给一个可见的默认色，否则 HUD 会画成纯黑、在深色画布上
           等于隐形）。⇒ 遇到黑色一律退回默认橙。 */
        if ((c & 0xFFFFFF) == 0) c = 0xE07F0D;
        COLORREF col = RGB((c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF);
        /* ⛔ 断流态不再在此降级呈现（2026-10-16 第十一轮）：wantVisible 已把
           `g_streamDead` 挡在外面 ⇒ 走到这里必然不是断流态，无需再改 rx/ry/col。 */

        int rpx = g_cfg[CFG_I_RADIUSPX]; if (rpx < 1) rpx = 1;
        if (rpx > RADIUS_PX_MAX) rpx = RADIUS_PX_MAX;
        /* ⛔⛔ DPI 归一（2026-10-15）：面板的「半径」是**逻辑像素**，而窗口边长与
           圆周半径都是**物理像素** ⇒ 两边都要乘 dpiS，否则高分屏上圆被窗口裁掉、
           且「画的圈」比真实约束小（150% 下小 33%）。 */
        double dpiS = dpi_scale();
        {
            int newSize = hud_resize(wnd, 2 * ((int)((double)RADIUS_PX_MAX * dpiS) + 24),
                                     &dib, mem, hudSize, &dibBits);
            /* 0x020D：边长变了 ⇒ half 变了 ⇒ 已提交位置的基准作废，重新定位。 */
            if (newSize != hudSize) putValid = 0;
            hudSize = newSize;
        }
        /* 圆周半径 = 真实绳长（= 半径，张力已删除）⇒ 圈与约束永远一致。
           与滤波分支同源：那边 radiusPxF 同样乘了 dpiS。
           ⚠️ 模式判据在上面 wantVisible 处已经用过一次（ropeMode）；这里不再取一次，
              取了也只是个未使用变量。 */
        int leashPx = (int)(leash_px(rpx) * dpiS + 0.5);
        if (leashPx < 2) leashPx = 2;

        int half = hudSize / 2;
        /* 0x020E：本帧画的绳长（= 光标相对圆心的真实屏幕距离），只用于日志取证。
           判读：正常必须 ≤ leashPx（0x020D 的坐标系错误会让它恒 ≈ |(half,half)|）。 */
        int ropeLenDbg = -1;
        /* ⛔⛔ 0x020D：绘制点没动 ⇒ 窗口位置**一个像素都不许动**（圆心抖动的根因）。
           圆心屏幕位置 = 光标 − 偏移，而偏移里的 raw 每帧都要按速度**外推**到当前
           时刻（否则圆心会随光标漂，见上方 axX/aoX 的长注释）。问题出在速度本身：
           raw 是整数轴坐标，量化 ±1 屏幕像素 ÷ 包间隔(≈5ms) ⇒ 速度噪声 ≈0.2px/ms，
           再乘 age（每帧 0~8ms 逐帧变） ⇒ 圆心每帧被推来推去 1~2px。
           数值模拟（20px 小圆、60px/s、5ms 包、8ms 帧、px=0.0768）：圆心峰峰 **2px**。
           而拉绳模式**绳没绷紧时绘制点是被冻住的**（包路径 `distPx ≤ radius` 时
           一个字节都不改 g_ox）⇒ 圆心此刻的正确位置就是上一帧那个位置：
           外推在这里提供的信息量是**零**，带来的噪声却是全部。
           ⇒ 判据：快照里的绘制点（snOutX/Y）与上次提交位置时相同 ⇒ 直接复用。
           ⛔ 判据必须用**绘制点**，不是光标 —— 光标在圈里自由移动是正常行为，
              圆心跟着它动才是 bug。
           ⛔ 不能用「光标没动」当判据：那时圆心反而该被外推/低通带着走。
           ⛔ putValid 的失效点必须齐三处：隐藏过 / 换过窗口边长（half 变） / 首次。
             漏一处就会出现「复用一笔之前的旧位置」。 */
        int putXc, putYc, putFrozen = 0;
        if (putValid && snOutX == putOutX && snOutY == putOutY) {
            putXc = (int)putX; putYc = (int)putY;
            putFrozen = 1;
        } else {
            double cx = (double)cur.x - (axX - aoX) * px_x() - (double)half;
            double cy = (double)cur.y - (axY - aoY) * px_y() - (double)half;
            if (!putValid) {                       /* 首帧直接吸住，不做迟滞 */
                putX = (double)hud_round_px(cx);
                putY = (double)hud_round_px(cy);
            }
            putXc = hud_sticky_px(cx, &putX);
            putYc = hud_sticky_px(cy, &putY);
            putOutX = snOutX; putOutY = snOutY; putValid = 1;
        }
        /* ⛔⛔ 2026-10-16 第十二轮：背景从「不透明黑 + LWA_COLORKEY 键色」改为
           「全 0 = 完全透明」（ULW_ALPHA 路径）。
           两个收益：① 彻底消灭「画笔色 = 纯黑 ⇒ 整窗透明」这个坑；
                     ② 走 DWM 官方合成路径（旧 GetDC+BitBlt 已被真机证明
                        「show 成功、BitBlt 成功、屏幕全空」）。
           ⚠️ GDI 往 32bpp DIB 绘制时**不写 alpha 字节** ⇒ 先清零，
              绘制完成后统一把「非黑像素」的 alpha 置 255（见下方 alpha 化）。 */
        if (dibBits) memset(dibBits, 0, (SIZE_T)hudSize * (SIZE_T)hudSize * 4u);

        HPEN pen = CreatePen(PS_SOLID, 1, col);
        HPEN old = (HPEN)SelectObject(mem, pen);
        if (hf & 2) {                     /* 绳长圆：光标（原始笔）的活动范围 */
            HBRUSH nb = (HBRUSH)GetStockObject(NULL_BRUSH);
            HBRUSH ob = (HBRUSH)SelectObject(mem, nb);
            Ellipse(mem, half - leashPx, half - leashPx, half + leashPx, half + leashPx);
            SelectObject(mem, ob);
        }
        if (hf & 1) {
            /* 「绳」：从圆心（绘制点）连到光标（原始笔尖）。
               ⛔ 断流态到不了这里（wantVisible 已挡住 g_streamDead），不再需要分支。
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
            /* ⛔⛔ 0x020D：绳的末端必须**由几何反算**，不能再用 rx/ry。
               rx/ry 是「光标 − 偏移」的估算值（含外推噪声，亚像素级抖动 ±1px），
               而窗口位置现在可能是**复用的上一帧**（putFrozen）⇒ 两者不再一致：
               窗口不动、rx 却在抖 ⇒ 绳末端在窗内自己抖，还会与真实光标脱开 1~2px。
               正解：用几何反算（整数相减，恒精确）。顺带把 vlen 变成「绘制点↔笔尖」
               的**真实屏幕距离**（此前含 ±1~2px 噪声）：sag 与绷直判据都吃它
               ⇒ 「绳身在绷紧附近一抽一抽」的残余噪声一并消失。
               ⛔⛔⛔ 坐标系（0x020E 修正）：`putXc/putYc` 是窗口**左上角**，圆心在
               窗内 (half, half) ⇒ 光标相对圆心的向量 = `cur − (put + half)`。
               0x020D 初版漏了减 half（等价于 vx = rx + half），症状正是用户实测的：
                 · vlen = |(rx,ry) + (half,half)| ≈ 115~235 > leashPx(100)
                   ⇒ 绷直判据每帧成立 ⇒ sag 恒 0 ⇒ 绳永远是一条**直棍**；
                 · 端点画在 `half + vx = 2·half + rx`（248~318），落到**圆周外**；
                 · 方向被常量 (half, half) 主导 ⇒ 只在右下 **25°~65°** 扇形内随笔向轻摆。
               ⚠️ half 与 leashPx 同量级（都 ≈ RADIUS_PX_MAX·dpiS），所以这个错误
                  在观感上不像「错位」，而像「绳变硬了」——正是它躲过了自检。 */
            double vx = (double)cur.x - (double)putXc - (double)half;
            double vy = (double)cur.y - (double)putYc - (double)half;
            double vlen = dsqrt_(vx * vx + vy * vy);
            ropeLenDbg = (int)(vlen + 0.5);
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
                /* ⛔⛔ 0x0134：垂度方向 = **重力方向（屏幕正下方）**，不是「弦的法线」。
                   旧版取的是「垂直于圆心→光标」的法线并把它翻到 ny>0：弦**水平**时
                   看着没问题，可弦一旦接近竖直，法线就接近水平 ⇒ 绳子往**左右两侧**
                   鼓出去（用户实测原话：「虽然不会向上弯，但是会往左右侧面弯」）。
                   真实悬链线的垂度永远是竖直的（重力向下，与弦的角度无关）。
                   ⛔ 弦越竖直，能垂的空间越小（两根钉子几乎上下对齐时绳必被拉直）
                     ⇒ 用水平跨度占比 |dx|/d 衰减；弦水平时 = 1（满垂度），竖直时 = 0。
                   ⛔ 不按运动方向定侧：停笔时方向未定义，会突然翻面。 */
                double hor = (vx < 0.0 ? -vx : vx) / (vlen > 0.001 ? vlen : 1.0);   /* 无 math.h：手写 abs */
                cqy = my + 2.0 * sag * hor;      /* 只加竖直分量 ⇒ 抛物线开口朝下 */
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

        /* ⛔ 1px 白色边框已删除（2026-10-16 第十四轮，用户明确要求）：
           它只是 0x010A 排查「窗口到底上没上屏」时的临时判决器，HUD 可见性
           已定案（真因是 ULW 不碰 z 序 ⇒ 靠每帧 SetWindowPos 置顶解决），
           判决器完成使命即移除。⛔ 后续任何调试都不要再加可见的临时装饰。 */

        /* —— alpha 化（32bpp 预乘 alpha；alpha=255 ⇒ 不透明，无需再预乘）——
           GDI 往 32bpp DIB 绘制时**不写 alpha 字节** ⇒ 背景保持 0（全透明），
           画上去的非黑像素在这里把 alpha 补成 255。画笔色已在上方强制非黑
           （黑 → 橙），所以「非黑 ⇒ 不透明」是安全判据。 */
        if (dibBits) {
            u32* px = (u32*)dibBits;
            int tot = hudSize * hudSize;
            for (int i = 0; i < tot; i++) {
                u32 v = px[i];
                if (v & 0x00FFFFFFu) px[i] = v | 0xFF000000u;
            }
        }

        /* —— 提交：UpdateLayeredWindow（layered window 的官方路径）——
           位置 + 尺寸 + 内容一次性交给 DWM。旧版是「SetWindowPos 移动 + GetDC/
           BitBlt 画内容」两步走 —— 真机 120s 里 vis/swp/blt 全 =1 却一秒看不见，
           正是那套走法在 DWM 下不被合成的典型形态。
           ⛔ hdcDst 传 NULL = 用屏幕 DC；ULW_ALPHA + AC_SRC_ALPHA = 以 DIB 的
              alpha 通道做透明（这正是去掉 color key 后要用的模式）。 */
        POINT ptDst; ptDst.x = putXc; ptDst.y = putYc;
        SIZE  szLay; szLay.cx = hudSize; szLay.cy = hudSize;
        POINT ptSrc; ptSrc.x = 0; ptSrc.y = 0;
        BLENDFUNCTION bf;
        bf.BlendOp = AC_SRC_OVER; bf.BlendFlags = 0;
        bf.SourceConstantAlpha = 255; bf.AlphaFormat = AC_SRC_ALPHA;
        BOOL ulwOk = FALSE;
        if (wnd && mem && dibBits)
            ulwOk = UpdateLayeredWindow(wnd, NULL, &ptDst, &szLay, mem, &ptSrc, 0,
                                        &bf, ULW_ALPHA);
        DWORD ulwErr = ulwOk ? 0 : (DWORD)GetLastError();
        /* ⛔⛔ 每帧置顶（2026-10-16 第十三轮）——**HUD 全程不可见的真凶**：
           0x010A 把「每帧 `SetWindowPos(HWND_TOPMOST, …SWP_SHOWWINDOW)`」整套换成了
           `UpdateLayeredWindow`。ULW **只提交内容与位置，完全不碰 z 序**，于是窗口
           落在 Photoshop 主窗**之下**：`vis=1 / ex 含 LAYERED / ulw=1 / rect 在屏内 /
           像素逐点正确` 五项全绿，屏幕上却一秒都看不见 —— 真机 jwwh-9304 全程如此
           （那些行里的像素采样证明内容画对了，只是没人看得见）。
           0x0107（用户明确「还能看到 HUD」的那版，见 git show HEAD^:…）正是靠每帧
           这一句置顶；本轮把内容继续交给 ULW（DWM 官方合成路径），**置顶每帧重申**。
           ⛔ SWP_NOACTIVATE：绝不抢焦点；SWP_NOMOVE|SWP_NOSIZE：位置尺寸仍归 ULW。 */
        /* ⛔⛔ 2026-10-16 第十五轮：改回 **0x0107 那条已知能见的确切形状** ——
           位置 + z 序在**同一次调用**里给出（不带 SWP_NOMOVE），flags 只留
           SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW。
           0x0107 用户明确「能看到 HUD」，用的正是这一条；0x0109 起把位置交给 ULW、
           这次调用退化成 `SWP_NOMOVE`，之后就再也没稳定见过 HUD。
           ⛔ 传的坐标就是刚交给 ULW 的 ptDst，两者一致 ⇒ 不会互相打架。 */
        BOOL raiseOk = FALSE;
        DWORD exBefore = 0, exAfter = 0;
        if (wnd) {
            exBefore = (DWORD)GetWindowLongW(wnd, GWL_EXSTYLE);
            raiseOk = SetWindowPos(wnd, HWND_TOPMOST, ptDst.x, ptDst.y, 0, 0,
                                   SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            exAfter = (DWORD)GetWindowLongW(wnd, GWL_EXSTYLE);
            /* 兜底：调用声称成功、却没拿到 WS_EX_TOPMOST ⇒ 显式钉样式再来一次。
               真机实证过 raise=1 而该位仍为 0（ex=0x80800A0）的情形。 */
            if (!(exAfter & WS_EX_TOPMOST)) {
                SetWindowLongW(wnd, GWL_EXSTYLE, (LONG)(exAfter | WS_EX_TOPMOST));
                SetWindowPos(wnd, HWND_TOPMOST, ptDst.x, ptDst.y, 0, 0,
                             SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
                exAfter = (DWORD)GetWindowLongW(wnd, GWL_EXSTYLE);
            }
        }
        /* 兜底：要它显示却没显示 ⇒ 补一次显式 ShowWindow（SW_SHOWNA = 不抢焦点）。
           分层窗口被 SW_HIDE 过之后偶发「SWP_SHOWWINDOW 不生效」。 */
        BOOL reShow = FALSE;
        if (!IsWindowVisible(wnd)) { ShowWindow(wnd, SW_SHOWNA); reShow = TRUE; }

        /* —— 显示路径自检（2026-10-16 第十二轮，**只读探测**，2s 节流）——
           缘起：用户报「HUD 全程不显示，而平滑功能正常」。上一轮日志已排除了
           位置/颜色/分层/API 失败四种可能 ⇒ 本轮直接换提交路径并把**像素内容**
           一起落盘，把「窗口没上屏」与「内容没画出来」彻底分开：
              vis=0            ⇒ 窗口不可见
              ex 无 0x80000    ⇒ WS_EX_LAYERED 丢了（ULW 用不了）
              ex 无 0x20       ⇒ WS_EX_TRANSPARENT 丢了 ⇒ **HUD 会吃掉笔按下事件**
                                 （第十四轮血案，见 CreateWindowExW 处注释）
              ulw=0            ⇒ 提交失败，err= 给原因
              raise=0          ⇒ 置顶失败 ⇒ 窗口会落到 PS 主窗之下（不可见）
              rect 全在屏外    ⇒ 位置算错（rx/ry 或 cur 异常）
              px ctr≠col       ⇒ 圆心/笔尖点没画进 DIB
              px ring≠col      ⇒ 绳长圆没画进 DIB（hf bit1 关着时本就该是 0）
              px far≠0         ⇒ 透明背景被写脏（alpha 化出问题） */
        {
            static DWORD s_lastShowLog;
            static int   s_ulwErrLogged;
            static int   s_zDumped;
            if ((DWORD)(now - s_lastShowLog) >= 2000) {
                s_lastShowLog = now;
                RECT rr = { 0, 0, 0, 0 };
                GetWindowRect(wnd, &rr);
                DWORD lex = (DWORD)GetWindowLongW(wnd, GWL_EXSTYLE);
                /* ⛔ 像素值一律按 **%08lX** 打（含 alpha 字节）：
                   ULW_ALPHA 下 alpha=0 的像素就是「完全透明」⇒ 若 ctr 的 alpha 为 0，
                   则「内容画对了却看不见」，问题在 alpha 化而非 z 序。 */
                unsigned long pCtr = 0, pFar = 0, pRing = 0;
                const u32* px = (const u32*)dibBits;
                if (px) {
                    int ctr = half * hudSize + half;
                    int rxs = half - leashPx; if (rxs < 0) rxs = 0;
                    pCtr  = (unsigned long)px[ctr];
                    pFar  = (unsigned long)px[(hudSize - 2) * hudSize + (hudSize - 2)];
                    pRing = (unsigned long)px[half * hudSize + rxs];
                }
                logf("# [hud] 显示: vis=%d ex=0x%lX exb=0x%lX top=%ld raise=%d ulw=%d "
                     "rect=(%ld,%ld,%ld,%ld) cur=(%ld,%ld) off=(%d,%d) put=(%d,%d) frz=%d "
                     "rope=%d size=%d col=%06lX "
                     "leash=%d(物理px) px[ctr=%08lX ring=%08lX far=%08lX] reShow=%d z=%p err=%lu\n",
                     (int)IsWindowVisible(wnd), (unsigned long)lex, (unsigned long)exBefore,
                     (long)((exBefore & WS_EX_TOPMOST) ? 1 : 0), (int)raiseOk, (int)ulwOk,
                     (long)rr.left, (long)rr.top, (long)rr.right, (long)rr.bottom,
                     (long)cur.x, (long)cur.y, rx, ry, putXc, putYc, putFrozen,
                     ropeLenDbg, hudSize,
                     (unsigned long)(col & 0xFFFFFF), leashPx,
                     pCtr, pRing, pFar, (int)reShow,
                     /* z = 在我们**上面**的那个窗口（NULL = 已是最顶）。
                        目标态：置顶成功后恒为 NULL；若它等于 PS 主窗，说明我们又掉到下面了。 */
                     (void*)GetWindow(wnd, GW_HWNDPREV),
                     (unsigned long)ulwErr);
                /* ⛔ 一次性 z 链取证（每个进程只做一次）：把 HUD 之上最多 8 个窗口的
                   类名 / 尺寸 / 是否可见 / 是否 topmost 打出来。
                   判读：若其中某个**覆盖 HUD 中心**的可见窗口出现 ⇒ 找到遮挡者（就是它）。
                   没有任何窗口覆盖 HUD 中心、且 HUD 自身 topmost ⇒ 遮挡论不成立，
                   问题在合成路径（那时看 px 的 alpha）。 */
                if (!s_zDumped && (exBefore & WS_EX_TOPMOST)) {
                    s_zDumped = 1;
                    HWND up = GetWindow(wnd, GW_HWNDPREV);
                    logf("# [hud] ★z 链（HUD 自身 rect=(%ld,%ld,%ld,%ld) top=%ld）：\n",
                         (long)rr.left, (long)rr.top, (long)rr.right, (long)rr.bottom,
                         (long)((lex & WS_EX_TOPMOST) ? 1 : 0));
                    for (int lv = 0; lv < 8 && up; lv++) {
                        WCHAR cn[128]; cn[0] = 0;
                        GetClassNameW(up, cn, 128);
                        RECT ur = { 0, 0, 0, 0 };
                        GetWindowRect(up, &ur);
                        DWORD ux = (DWORD)GetWindowLongW(up, GWL_EXSTYLE);
                        int covers = (ur.left <= cur.x && cur.x < ur.right
                                   && ur.top  <= cur.y && cur.y < ur.bottom) ? 1 : 0;
                        DWORD wpid = 0;
                        GetWindowThreadProcessId(up, &wpid);
                        logf("# [hud]    #%d hwnd=%p cls=%ls vis=%d top=%ld "
                             "rect=(%ld,%ld,%ld,%ld) 覆盖光标=%d pid=%lu\n",
                             lv, (void*)up, cn, (int)IsWindowVisible(up),
                             (long)((ux & WS_EX_TOPMOST) ? 1 : 0),
                             (long)ur.left, (long)ur.top, (long)ur.right, (long)ur.bottom,
                             covers, (unsigned long)wpid);
                        up = GetWindow(up, GW_HWNDPREV);
                    }
                }
                if (!ulwOk && !s_ulwErrLogged) {
                    s_ulwErrLogged = 1;
                    logf("# [hud] ★UpdateLayeredWindow 失败 err=%lu（wnd=%p mem=%p bits=%p）"
                         " ⇒ HUD 本轮起将不可见，请把这一行发回\n",
                         (unsigned long)ulwErr, (void*)wnd, (void*)mem, dibBits);
                }
            }
        }

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
/* ⛔ 版本史（核验方式：引擎日志头 `ver=`，**不要**静态反汇编 —— 编译器序言是
   `55 48 83 EC 20` 且 `mov eax` 后会插 `xchg`，裸搜 `B8 xx 01 00 00 C3` 必漏）：
   0x0113 = 9 条 LNP 迁移（slct/modalStateChanged/toolModalStateChanged/Opn/Cls…）
   0x0114 = drawOk 恒放行（toolModalStateChanged 的 'Lvl ' 1ms 翻转误门控）+ lcSysExt A/W 分偏移
   0x0115 = 'slct' 活性看门狗：pstool_owns() 加 2s 时效 + I_NOTIFYAGE/I_GATEOWNED 下发
            + 面板 inProcGateOwned() 统一判据（静默即让位，自愈轮询兜底）
   0x0116 = HUD 焦点门（用户铁律「焦点不在活动文档画布上 & 未落笔 ⇒ 不出 HUD」）：
            canvasOk（主框/MDIClient/焦点/光标四子条件，实测类名不猜）+ ctOk
            （落笔判据已建立才准出 HUD，堵死 contact 两条 fail-open 对 HUD 的泄漏）
   0x0117 = ① PS 关闭崩溃修复：DETACH 调 jwwh_unhook() 全停引擎四线程
            （WER: .8li_unloaded 0xC0000005，卸载后线程在已卸载代码上跑）；
            ② 补流假交还修复：接管条件成立即 synth=1，penraw_synth 返 0（无新
            光标样本）不再被误判成「真实通路已回包」；③ [stall] 行加 fg= 字段
   0x0118 = 开关循环无损化（真机 jwwh-36936 353s 永久冻结修复）：
            ① do_unhook 不再清 g_anaOk/g_synOn/g_synFrontT/g_lastRecovMs
               （停摆中拨开关 OFF 不再亲手杀掉正在救场的补流；跨会话误判由
               前沿差符号与 RI_RECOV_MS 窗天然免疫），撤钩时若正接管则按
               「引擎被关」落账并复位 g_synWas 沿检测；
            ② cmd=1 不再无条件作废 g_calib.valid（环境变化归 worker 250ms
               指纹段管），重挂后接管条件可立即重新武装，不再等真实包死锁；
            ③ 补流退出按真实原因分类落盘（真包回/引擎关/开关关/标定失效/
               采样源死），堵死「恒称真实通路已回包」的误导性归因
   0x0119 = 补流武装加固（真机 jwwh-32560：落笔点 PS UI 仍秒级断流）：
            ① RI_FIT_MAX_RMS 8→48（3px，与 RI_ANA_MAX_RMS 对齐）：运笔的
               配对时间错位本身就有 1~2px 残差，0.5px 门槛永不达标 ⇒ 强拟合
               从未武装，只剩时通时断的解析兜底；
            ② penraw_maybe_pair 加 RI_PAIR_MAX_AGE=400ms 包龄过滤：停摆恢复
               冲包（旧坐标）不进配对环 —— 它把拟合/解析残差撑爆（42→128、
               172/411），补流武装被自己的恢复冲包打死，真停摆来时反无补流
   0x0120 = 补流救援生存性（真机 jwwh-37300 18:12:21–34：落笔中断流 12.9s）：
            ① detour 门改 (g_synOn ∨ g_synWas)：已接管期间不再逐拍复验总闸 ——
               worker 每 2s 的解析复验在阈值边缘把 g_synOn 抖成 0，救援
               1.1s 后被自己拆台（why=1），余下 9.4s 冻结到驱动自愈；
               断流期配对环冻结 ⇒ 复验恒失败 ⇒ 永远无法重新武装；
            ② penraw_synth 加「最后可用映射」快照兜底：live 两路（强拟合/
               解析）全灭时沿用某刻通过验证的系数继续喂包；
            ③ ana 复验滞回：启用门槛 48 不变，已启用后 96 才判失效 ——
               运笔中残差实测在 31↔71 震荡（配对时间错位随速度波动），
               48 单阈值 ⇒ 映射时通时断，救援常常根本武装不起来
   0x0121 = ① HUD 焦点门补漏（真机 jwwh-26156：套索下拖插件面板仍出 HUD）：
               PS 2026 无 MDIClient（全程 mdi=0 实测）⇒ 0x0116 的粗判只校验
               「焦点根窗口=主框」、**不校验光标**，不抢焦点的浮动面板恒过。
               新增 Document Layer（class=OWL.WindowGroup、顶层窗口，全景转储
               实测）解析 + WindowFromPoint 子树判据（最多 4 个、逐个验活）；
               解析不出时维持粗判不回归；
            ② 可观测性：plugin_main 的 penSmooth 到达留痕（变化门+250ms 节流，
               pi8li.log）+ [hud] 显示行补 leash=（物理圆半径）——「调参不生效」
               类故障此前的零留痕状态到此结束
   0x0122 = 修 0x0121 的 HUD 恒不显示回归 + 断流叙事补 syn= 字段（真机 jwwh-38216，
               用户部署 0x0121 后报「连 HUD 都不能显示了，断流也不能通过 reload
               修复」）：
            ① 【回归根因】0x0121 的 Document Layer 子树判据被实锤判错：画布上
               正常作画（gate/toolOk/penDown/stroke/ctU 全绿）时 WindowFromPoint
               的 hit 也不在 docLayer 子树 ⇒ why=4 恒真 ⇒ 全 Session HUD 不显示
               （46 条未显示里 11 次 why=4 全在作笔中）。Document Layer
               （OWL.WindowGroup, vis=0）是 OWL「层」概念窗，画布视图不在其下；
            ② 【修法】判据整个反转：全景转证实所有非文档窗口（OWL.Dock /
               OWL.WindowGroup / OWL.ShadowView / PSFloatC / PSToolTip /
               ComboLBox）都是独立顶层窗口、画布窗从不在顶层枚举 ⇒ 画布必在
               **主框子树**内。改判 hit==s_psFrame ∨ IsChild(s_psFrame, hit)；
               笔落任何面板/浮窗/停靠坞 ⇒ hit 的 root 是顶层窗口自身 ⇒ 挡。
               hit==NULL 放过（罕见且 PS 同样收不到这笔）；why=4 时 2s 限流
               打 hit 类名/标题 ⇒ 判据再错下一轮按类名直接修；
            ③ 【断流叙事】[stall]/[dead]/[dead]持续中 行补 syn=（补流接管中）：
               冻结判据只看真实驱动包（g_pkReal，0x0120 语义）⇒ 补流救场时
               这些行照打「平滑实质中断」——那是假话。jwwh-38216 三段停摆期
               补流实喂 134 包而日志零字段可证，用户体感与排障全被带偏。
               syn=1 ⇒ 救场中（体感断流若仍在 ⇒ 几何层：陈旧回包追赶 /
               HUD deadHide）；syn=0 ⇒ 武装链真断
   0x0123 = ① 【断流永久化根因】删除 dead_relay_probe()（临时 WTOpenA +
               WTOverlap 推顶 + WTClose 的一次性方向判决实验）。真机 jwwh-9616
               （0x0122 会话）铁证：22:59:14.343 探针推顶 0x803，320ms 后关闭；
               **22:59:21.546 起真实包归零到 23:01:26 卸载（105s）一包未回**，
               期间 peek=0 / 单包=0（队列是空的），而探针执行前的四次断流
               （22:58:39/52/59、22:59:00）全在 0.8~2.9s 自愈 —— 分界线正好
               是那 320ms。机制即当年注释自己预言的风险：WTClose 后驱动不再把
               PS 的 0x802 推回重叠序顶层 ⇒ PS 被永久饿死，reload 也救不回
               （驱动状态不在进程内）。探针收益仅「1 包 x=0 y=0」的垃圾数据；
               ⇒ 断流期对本进程外的 Wintab 状态**彻底只读**；
            ② 【热键初次加载失效】keyhook.c 三条修（详见该文件）：
               getConfig 顺带重建热键表 / setConfigPath 路径未变也重载 /
               启动 1.5s 后「表空且文件存在」强制补一次重载。
               旧版只有「保存配置」会重建表 ⇒ 启动装载失败即全失效，重录一条
               才恢复（用户实测）；
            ③ 【平滑开关持久化】面板侧新 settings/smooth-enabled.json
               （src/lasso/SmoothPersist.ts）：setPenSmooth 落盘用户意图，
               面板 state 恢复完成后按持久值重开 ⇒ PS 重启不再弹回关闭
   0x0124 = ① 【整笔硬线 / HUD 塌陷的真凶 = 接触判据把「轻压」判成「悬空」】
               真机 jwwh-36348（0x0123 首场）用户原话：「画出来选区是没平滑的
               硬线，同时 HUD 以错误形态显示（受力点与施力点重合）」「断流前刚
               碰过面板/工具栏/其它窗口」。日志 [ct] 行（本项目自定义定性指标：
               >20 包 = 判据在真实运笔中成段失效）实录：连续全零 = 90 / 39 / 121 包
               （≈450~600ms @200Hz）⇒ 闸门②判悬空 ⇒ smooth_packets **整批原样
               放行** ⇒ 输出点=笔尖 ⇒ 硬线；同时置 g_wasEnabled=0 ⇒ 下一包重新
               锚定、拉绳死区被重新灌满；HUD 也吃同一个 g_penDown ⇒ 圈与平滑一起塌。
               ⇒ 拆成两个保持窗口：HUD/面板仍用 250ms（抬笔立刻反映），
                 **改写坐标**改用 800ms（CONTACT_HOLD_SMOOTH_MS，实测最长零段
                 600ms × 1.3 余量）。抬笔后多撑的 550ms 无可见副作用（PS 不画）。
            ② 【每笔台账】smooth_packets 每笔收尾把 时长/包/改写/复位/悬空批/半径
               /模式 搬进原子槽，worker 落 `# [stroke]` 行（detour 内零 I/O 不破）。
               判据：`复位` > 1 = 笔中被复位（硬线段真正来源）；`悬空批` > 0 =
               轻压成段全零确实发生、被新长闩接住。
            ③ 【HUD】救场期（syn=1）**不再 deadHide**：合成包坐标来自系统光标 +
               已标定映射（实测 a=16.000000 b=8 逐像素吻合），比停摆前快照更新；
               旧版无条件藏 ⇒ 「其实还在救场」的几秒里圈消失，体感就是断流。
            ④ 【[dead] 文案】按 syn 分叉，不再一律写「平滑实质中断」。
   0x0125 = ① 【修 0x0124 的倒退：g_wasHover 同批置位同批消费】。真机 jwwh-12388
               台账铁证：单笔 `复位=49/109/173`，全局 `rst=1471/0/2` 全是 anchor ——
               短闩每垂一拍就换来一次锚定（输出点被拽回笔尖），整笔仍是硬线。
               ⇒ 删 g_wasHover；起笔锚定回归「!downS（长闩过期）⇒ g_wasEnabled=0」，
                 另加**位移门**：短闩悬空→落笔的边沿，只有 distPx > 4×绳长 才另起一笔
                 （运笔中零段恢复位移≈绳长，不锚定；真实抬笔移位几十上百 px，必锚定）。
            ② 平滑长闩 800 → **1500ms**：同场台账实测抬笔零段 100~163 包
               （≈1.0~1.5s @110~150 pkt/s），800ms 本身就挡不住。
            ③ 台账升级：`复位=N(锚a/gap g/jump j)` + `最长全零`（全程最大值，
               不再只看收笔那一刻）⇒ 下一轮可直接判定「零段是否超过长闩」。
            ④ `g_reason` 初值改 RS_NOCAL：加载后尚未取到任何一个包时，面板不该
               显示「改写中」（本场前 41s state=0 packets=0 却报 reason=0）。
   0x0126 = ① 【补流不生效的根因：合成包 pkChanged 被写成 0】。真机 jwwh-2024
               铁证：停摆期我方每拍都返回合成包（补流计数照涨），但 PS 取包速率从
               绘画中的 2472 次/2s **掉到 162 次/2s**（= 空闲速率）⇒ PS 退出了绘制
               循环；真实包一回立刻回到 2550 次/2s。而 smooth_packets 改写真包的
               x/y 时**不动** pkChanged（保留驱动非零值），平滑一直有效 ——
               两者唯一差别就是这个字段。pkChanged=0 的语义是「本包什么都没变」。
               ⇒ 底本值 OR 上真正改过的那几位（TIME|SERIAL|BUTTONS|X|Y|NP，
                  掩码 0x5D4；底本为 0 时退 0x1FFC）。
            ② 【HUD 幽灵（用户报悬空冒出几秒再消失）】0x0124 放开断流期隐藏后，
               断流中抬笔时合成包的 sticky tip 把我方判据喂成落笔。
               ⇒ HUD 增 `realOk`（最后一批**真实**包 ≤ HUD_REAL_MS=400ms）。
               合成包负责维持 PS 笔迹，不负责点亮 HUD。
            ③ 【同源】`cursamp_thread` 的 tip 回退链加上「最后真实包 + 1500ms」上限，
               没有真实证据就不得断言落笔。
            ④ 台账 `最长全零` 跳过本笔第一批（否则把起笔前的悬空算进这一笔，
               jwwh-2024 笔#1 因此记成 599 包）。
   0x0127 = ① 【合成包序号必须接在驱动后面】。标定本身就用「pkSerialNumber 逐包 +1」
               当硬判据 ⇒ 真包序号严格递增、步长 1。旧版合成包用我们自己的计数器
               （从 1 起算），在 PS 眼里是「序号倒退十几万」——若 PS 按序号判新/判重
               （该字段唯一的用途），整批合成包会被丢弃，正好解释「我方每拍都返回、
               PS 取包速率却掉到空闲」。现在先跟上底本序号再 +1。
            ② 【挂 WTOpenW 只读钩】：历次日志 `open=0` 说明 PS 走的是 W 版，我们只挂了
               A 版、一次没被调用过。挂上后能拿到 PS 自己那份 LOGCONTEXT 的
               `lcOptions`（是否 CXO_MESSAGES=0x4）与 `lcMsgBase` —— 若 PS 是**消息
               驱动**，停摆期没有 WT_PACKET 消息进来它就不会来取包（另一种解释，
               且可解：我们补发消息）。⛔ 只读，一个字节都不改写。
            ③ 【每笔台账加客观形态】`平均滞后 px / 贴笔% / 死区%`：
               贴笔=滞后<3px（画出来就是硬线）、死区=绳没绷紧（本包输出没动）。
               把「硬线/断流」这种观感描述变成可判定的数字。
   0x0128 = ① 【补流喂包没人读的机制找到了：PS 是消息驱动】。jwwh-28756 实测
               `[ctx] WTOpenW hCtx=0x802 opt=0x801D ★CXO_MESSAGES msgBase=0x7FF0`
               ⇒ PS 的画布不轮询，等驱动投递 WT_PACKET(msgBase+0) 才去 WTPacketsGet
               并重绘。驱动停投递 ⇒ PS 只剩空闲定时器（实测 134~147 次/2s），
               我们的合成包堆着没人读 —— 与「补流计数照涨、PS 不画」完全吻合。
               ⇒ 补流期间由**采样线程**代为 PostMessage 补发 WT_PACKET（~62Hz，
                  detour 内仍然零系统调用），把 PS 的取包/重绘循环叫醒。
               ⛔ 只在 tip=1（我方认为笔仍落着）时补发：悬空挥手不投，避免幽灵笔画。
                 代价是断流中抬笔后最长 1500ms 内可能多画一小段（这是桥在工作的表现）。
               ⛔ [dead] 持续中 行加 `补发=` 便于核对。
            ② 0x0127 首场台账（jwwh-28756）证明**引擎侧干净**：`贴笔=0~3%`、
               `平均滞后=54.9~83.5px ≈ 绳长` ⇒ 写出去的坐标确实带整段滞后，
               用户看到的「没平滑」不可能出自平滑数学。
   0x0129 = ① 【queueSize 复测无效：⑥ 只挂在 WTOpenA，PS 一直走 W 版】。用户按指引建
               wtctx.ini(queueSize=128) 复测（jwwh-5288）：日志第 2 行确认读到 128、
               WTOpenW hCtx=0x802 成功，但**全场无 ⑥ 行** ⇒ 扩容一次都没跑，那次
               「测试无效」。现抽成 wtctx_post_open()，A/W 两入口都调；并加 ⑦
               WTQueueSizeGet 实测量（无开关也记）——每会话留存真实队列容量，
               「旧 128 vs 新默认」从冲包数反推变成日志直接证据（佐证：jwwh-9304
               恢复冲包 ~125/127 ≈ 128）。
            ② 【解析映射准入线坐在噪声带里 ⇒ syn 恒 0 ⇒ 补流从未武装】。jwwh-5288：
               拟合全程卡跨度（小笔画保留集跨度 191/661 < 1000，设计如此），解析卡
               残差（52.1 > 48）——而同场**错映射**的量级是 840/1073（陈旧冲包污染
               拍），42~128 分明是运笔时间错位噪声（0x0119 已为拟合认过同笔账）。
               RI_ANA_MAX_RMS 48→96、RI_ANA_OFF_RMS 96→160。按该场数据回放：
               09:03:09 即可武装 ⇒ 09:03:16.5 那次 [dead] 将是 syn=1 + 补流接管 +
               WT_PACKET 补发，而非「补流未武装 ⇒ 平滑实质中断」。
            ③ 背景结论（LNP 对照实验，jwwh-31980 vs 19848/3336/5288）：同 0x0128
               二进制，LNP 在环 12 笔 0 断流、不在环每 1~2 笔一次 [dead] ⇒ 停摆的
               触发条件在 Wintab 派送层，引擎修不动它；0x0116「OK」是 LNP 功劳。
               REA+Ghidra 逆 MouseHookPro64.8li 26.10 实证（详见 refs O23）：
               LNP **不调** WTQueueSizeSet/WTEnable/WTOverlap/WTQueuePacketsEx
               （init 里 GetProcAddress 后**结果被丢弃**，字节级证明）⇒ 队列扩容
               假设对 LNP 本身不成立；其钩子表 = WTOpenA/W（lcLocks 全零）·
               WTInfoW（DPI 修复）· WTPacket（旁路喂包）· WTPacketsGet（**替换
               缓冲内容与返回值**）· WTGetA/W · WTDataPeek + 8 个 user32。且
               31980 场 LNP 自带日志证明：上下文钩子当场**空转**（无 CXL_SYSOUT
               警告、lcSys==vrect 无 DPI 差）⇒ 救命的是包路径交互，不是上下文改写。
   0x012A = ① 【落笔瞬间受力点与施力点分离（用户报，jwwh-5912，LNP 在环、平滑生效场）】。
               原话要旨：「按理落笔时选区边缘长度为 0、圆心（受力点）与施力点应重合，
               实际却差一个**圆半径内的不固定值**，位置与偏移似乎与落笔时轻微位移有关；
               于是我一移动，落笔点就瞬间向那个偏移的受力点画出一段**我没画的折线**，
               然后再从偏移点出发画平滑选区。」
               根因 = 起笔锚定的两条路**都不落在真正的落笔包上**：
                 · `!g_wasEnabled` 锚在「整批第一个包」—— 落笔边沿落在一批中段时，
                   第一个包还是悬空包（场景 A，偏移 = 落笔瞬间那点位移）；
                 · 1500ms 长闩一直撑着 g_wasEnabled ⇒ <1.5s 的「抬笔→再落笔」根本不锚
                   （场景 F，输出点还停在悬空跟随的位置，最多差整整一根绳）。
               jwwh-5912 实证场景 F 是主形态：[gate] penDown 0→1 间隔低至 0.26s/0.5s
               （用户连续画圆、圆距 <1.5s），三个台账各跨多次起笔（悬空批=80/954/792）
               而复位仅 1~2 次/台账 ⇒ 长闩把多次真起笔并成了一条「笔」。
               ⇒ 逐包读 buttons（笔尖开关，掩码 0x07 低三位）—— 它是 **PS 自己用来
                 起/收套索路径的字段**（我们从不改写，PS 读到的与驱动一致）⇒ 它的
                 0→1 边沿就是 PS 的路径边界，在那里强制锚定到本包原始坐标。
                 带去抖（连续抬升 < BTN_EDGE_MIN_ZERO=8 包不当真抬笔）。
               ⛔ 为什么不盯 np/tp 边沿：0x0124 教训 —— np/tp 轻压下成段掉零，
                 盯它们等于每记掉零恢复都拽一次输出点，整笔退回硬线；buttons 在那些
                 掉零里保持 1（PS 路径没断），只有真抬笔才归 0。
               ⛔ buttons 不可用（无投票权/布局推不出）时机制整体静默，行为同 0x0129。
               台账加 `落` 计数：每笔正常 =1；=0 ⇒ 边沿没抓到（偏移会原样复现）；
               >1 ⇒ buttons 在笔中抖动（去抖失灵）。
            ② 同场顺带确认 0x0129 两项已生效：⑥ `WTQueueSizeSet(128) ⇒ 1（实测原容量
               50）`（queueSize 测试从此真正有效，原容量 50 与历次冲包 20~54 吻合）；
               无 LNP 场（jwwh-9316）[dead] 仍 18 次但 syn=1 已占多数（补流武装成功，
               与 O22「停摆根因在派送层、引擎侧修不动」并不矛盾）。
   0x012B = ① 【长停摆中途补流自己先断了：tip 断言的 1500ms 窗口把补发掐死】。
               用户验收 0x012A（jwwh-20708）原话：「前几次画笔效果很好，我一度以为要成了，
               但是后几笔就稳不住开始断流了」。台账证明落笔边沿修复本身生效（`落` 每笔
               1~16 次 = 每个真起笔一次，用户此场画了 18 笔），所以问题不在锚定。
               本场 3 次**真**停摆（判据 = 包冻结 + 光标仍在动）：2.36s / 3.95s / >9.7s。
               关键证据：`补发=` 在每次停摆后**固定停在同一秒级位置不再增长** ——
               因为 tip 断言窗口 = CONTACT_HOLD_SMOOTH_MS(1500ms)，到期后
               `if (tip && ...)` 直接不成立 ⇒ 不再代投 WT_PACKET ⇒ PS 的消息驱动
               取包/重绘循环下线（`[pk]` 实测掉到 960 次/s 的空轮询、真实包=0），
               合成包照发但**不重绘** ⇒ 用户看到线冻住 ⇒ 只好抬笔 ⇒ 整笔报废。
               本场最后一次停摆更直接：tip 窗口到期(≈36.07) 与用户抬笔(36.15) **几乎同刻**，
               说明用户就是被冻住的线逼停的。
               ⇒ 新增 `SYNTH_TIP_MAX_MS=6000`（与接触判据的 1500ms 刻意分开）。
               ⛔ 0x0126 的幽灵顾虑已由 realOk 独立堵死（HUD 必须 400ms 内有真实包），
                  本窗口只管合成包与消息投递；抬笔期的幽灵线再用**三道守卫**收窄：
                 ① 光标必须仍在活动文档画布矩形内（g_canvasOkDbg，去点面板/菜单即停）；
                 ② 光标必须真的移动过（静止 = 没有新笔画可画，抬笔停住即停）；
                 ③ 本次会话内 VK_LBUTTON 已被证明可用（g_csBtnOn>0）且当前抬起 ⇒ 停发
                    —— 停摆期看不见抬笔（g_penDown 卡在 1），①②都拦不住「抬笔后悬空
                    移动」，而笔尖在 Windows 层面就是左键。g_csBtnOn 恒 0（该驱动不产生
                    左键）时本条永不生效，安全退回 ①②。
            ② 【笔尖映射诊断】`[raw]` 增 `btn=状态/on=0→1次数`（VK_LBUTTON，只观测）：
               若 on ≈ 起笔次数，说明笔尖在 Windows 眼里就是一个左键 ⇒ 下一版可直接用它
               做断流期的**真实落笔证据**，把 6s 补发窗口与幽灵风险一并去掉。
            ③ 【O22 的重要修正】本场 LNP 插件**确在环**（LNP 自己 logs/log_photoshop.txt：
               11:14:04 随 PS 进驻并建 Wintab 上下文、11:15:44 随 PS 退出），而停摆照旧
               ⇒「LNP 在环 ⇒ 0 断流」（jwwh-31980）**不可复现**，LNP 至多是概率性缓解，
               不能当作方案依赖；进程内唯一的容错手段就是补流桥（本条修的）。
   0x012C = ① ⛔⛔ 【**回滚 0x012B 的第三道守卫**：它让补发恒为 0】。
               jwwh-6468 全场 `补发=0`（五段停摆、含 6.3s 与 >13.6s 两段长的，一次也没代投）
               ⇒ 用户「断流不再自愈」的直接原因就在这一条。
               证据：`on`（VK_LBUTTON 的 0→1 次数）从 0 涨到 36，与起笔次数同量级 ⇒ 笔尖
               **确实**映射成左键；但 `btn`（电平）在 tip=1/penDown=1（笔明确还按着）的
               时刻成段读 0 —— 12:05:43/45/47、12:06:31/33/35 六次采样全是 btn=0。
               ⇒ 守卫的判据（「已证明可用且当前抬起」）在断流期**必然成立** ⇒ 每一拍都停发。
               ⛔ 定性：**Wintab 独占时笔尖走 Wintab 按钮，鼠标模拟只发按下/抬起的边沿、
                  不保持按下电平** ⇒ 左键**电平**不能当「笔还在纸上」，**边沿**可以。
                  0x012B 的 ③ 是基于「笔尖就是左键」这个看似合理但错误的前提写的。
            ② 补发目标加固：`g_ctxHwnd`（WTOpen 收到的窗口）为空时退 `s_psFrame`
               （PS 主框，焦点门已实测解析过），再退前台窗口；A 版 WTOpen 也补记目标。
            ③ 诊断补齐（本轮无法从日志区分「g_ctxHwnd 为空」与「守卫拦死」，必须一次消掉）：
               · `[ctx] WTOpenW` 行加 `hwnd=`；
               · `[post] ★首个代投` 记录 ctxHwnd/psFrame/实际目标/msg/返回值/errno（只打一次）；
               · `[dead] 持续中` 行加 `pre=(tip/syn/hw/cv/btn)` —— 补发仍为 0 时一眼看到
                 是哪一项不成立。
   0x012D = ① ⛔⛔ 【**空档在「笔抬着」时开始 ⇒ 整段盲区，一笔都画不出来且不自愈**】。
               用户验收 0x012C（jwwh-21032，12 笔）原话：「1-3 正常，4-7 断流，重启后
               断流自愈，8-12 正常」。本场唯一的长空档 = 12:43:57.4–12:44:06.8（**9.9s**，
               前后合计 13.1s 无一次落笔）。
               同场同时成立的事实：
                 · `[post] ★首个代投 ... ret=1 err=0` ⇒ 0x012C 的敲门机制**通了**；
                 · 空档期 `零包次=735`（PS 735 次取包全拿到 0）、`真实包=0` ⇒ 驱动力零输出；
                 · `补流` 从 127 涨到 695 次 ⇒ 我方**一直在喂**合成包；
                 · 但 `现值=(...,tip=0,...)` 整段为 0 ⇒ 喂进去的全是 **buttons=0 的悬空包**
                   ⇒ PS 只挪光标、不落笔 ⇒ 用户连画 4 笔一笔都出不来；
                 · `[dead]` 一条都没打 ⇒ 看门狗（要求 1500ms 内落过笔）也跟着瞎了。
               根因：tip 链**全部来自包证据**（g_penDown / g_lastRealTip），而空档恰好在
               笔抬起后 2.4s 开始（12:43:54.5 抬笔、12:43:56.9 断流）⇒ 之后用户按下笔尖
               也永远看不见（没有真包来报 0→1）⇒ 合成包自称悬空 ⇒ PS 不落笔 ⇒ 只能等
               驱动自己活过来（本场 9.9s）。这是 0x012B/0x012C 补流桥的**构造性盲区**。
               ⇒ 新增**包外证据**：笔尖在 Windows 层面是一对 LBUTTON **消息** ⇒ 在 keyhook.c
                 的钩子线程上挂 `WH_MOUSE_LL` 做事件镜像（keyhook_mouse_state），平滑引擎
                 只在 `realAge > RI_STALL_MS` 的窗口里用它把 tip 抬到 1（**只加不减**，
                 绝不否决包证据 —— 否决 = 0x012B 第三道守卫的老路，已被 6468 判死）。
                 武装 = 见到按下且**光标在活动文档画布内**；解除 = 见到抬起 / 离开画布 /
                 停手 2s / 单次按下 15s 硬上限 / 真包回来。按下后 800ms 内不因「抬起」解除
                 （有的驱动按下即补一条抬起消息，照单全收就一次也画不出来）；按下时刻
                 回看 600ms（空档判据本身滞后 250ms，"笔刚落纸驱动就死"不能漏）。
               ⛔ 镜像无数据（该驱动/笔不产生鼠标消息）⇒ 本段静默，行为与 0x012C 逐位相同。
            ② 诊断：`[mse] ★武装 / ·解除：<原因>` 边沿各一行；`[raw]` 加 `mse=状态/arm=/rel=`。
               下一轮判读：arm 次数应 ≈ 空档期用户真正下笔的次数；rel 原因若是 3(停手)，
               说明靠静止收尾；若是 1(抬起) 则证明该驱动的抬起消息可靠。
   0x012E = ① ⛔⛔ 【**代投的节流口径错了：`moved` 判据把「用户停住等线追上来」判死**】。
               用户验收 0x012D（jwwh-2200，15 笔）原话：「1-4 正常，5-6 断流，reload 之后
               自愈，7-15 正常」（并纠正上一轮的「重启」= **UXP reload**，不是 PS 重启）。
               本场致命停摆 13:01:25.7 → 13:01:35.5（**9.9s**，止于 reload/卸载）铁证：
                 · 合成包**一直在喂**：`补流` 463→594→730→849→982→1105 次、包 672→1356；
                 · 代投（唤醒）**几乎不动**：`补发` 30→43→44→46（10s 只 46 次）；
                 · PS 取包次从 1200/s **崩到 60/s**（2546/2.1s → 127/2.1s）⇒ 线冻住。
               ⇒ 两条守卫各自判死一半：
                 · 旧②「光标必须动过才投」：用户见线不动就**停住笔等它**（13:01:25.9
                   `[frz] movedTot=0/12`）⇒ 一次也不投。而我们的输出本来就滞后一整根绳
                   （平均滞后 38px）⇒ 静止时恰恰最需要 PS 继续取包才能追上。
                 · 旧①「cv=0 ⇒ 停发」：用户随后把笔移出画布（13:01:27 起 cv=0）⇒ 继续不投。
               修法：删 moved；改**按拍节流**（62Hz，冻结期 15Hz）；cv=0 不再停发，而是
               **把喂入位置钉在最后一个画布内点**（`s_csGoodX/Y`）——位置钉住 ⇒ 画不出
               幽灵线；唤醒不断 ⇒ PS 的取包/重绘循环不倒，笔一回画布就接着画。
            ② 诊断：`[raw]` 加 `补发=N/frz=0|1`；`[dead] pre=` 加 `frz`；喂入冻结/解冻各打一行。
               下一轮判据：长停摆中 `补发` **必须持续增长**（≈62/s，不再冻结在某个数），
               PS 取包次不再崩到 60/s，线不再中途冻住；抬笔后无幽灵线。
   0x012F = ① ⛔⛔ 【**只钩 Wintab 包 = 只覆盖 1/3 输入通路；断流时 PS 退回鼠标路径，
               我方彻底失手 ⇒ 平滑失效**】。用户实测（2026-10-18）：断流当下套索照常画
               （跟手、但**没有平滑**），HUD 环跟着笔跑而**圆心与轨迹末端分离**
               （施力点=受力点重合 = 无滞后；圆心取自平滑输出 = 另一套坐标）。
               ⇒ 不是虚拟笔尖失效，是「HUD 用的坐标」和「PS 实际绘制的坐标」分家了。
               REA 反编 LNP `MouseHookPro64.8li` 26.10.14（见 analysis/lnp）定案：
                 它钩的不止 Wintab —— 还有 `GetCursorPos`、`GetMessageW` / `PeekMessageW`、
                 `GetMessagePos`、`GetPointerInfo` 系列（Windows Ink）、坐标换算一组。
                 · 钩子 FUN_18002c440 的第一行就是**先调真 GetCursorPos**，再改写输出；
                 · 改写 FUN_180058310/500：`GetAsyncKeyState(VK_LBUTTON)<0`（笔尖按着）
                   ⇒ 真坐标喂引擎 FUN_180058e90 ⇒ 用 `state+0x2aae8` 覆盖 POINT；
                   左键电平读 0 但**笔画进行中**（b26e18）⇒ 仍返回**缓存的平滑点**，
                   绝不透传（正是 0x012B 用 VK_LBUTTON 电平判抬笔翻车的那个坑，
                   LNP 用「缓存」绕开）；不在笔画中 ⇒ 透传。窗口用 WindowFromPoint 限定。
                 · 它钩 `SetCursor`（改光标形状）但**不钩** `SetCursorPos` ⇒ 证实
                   **从不搬动真实光标**，只改「PS 读到的那份副本」。
               本版照搬：给 `user32!GetCursorPos` 装 detour（先调真 → 按条件改写），
               并**复用现有平滑引擎**（`g_snOutX/Y` 是输出、`g_snRawX/Y` 是输入，
               250Hz 系统光标采样一直在推进）⇒ 不需要新算法：
                    PS 读到的光标 += (snOut − snRaw) × px（与 HUD 圆心同一换算、反号）
               ⛔ 只在**真实包通路停摆**（`realAge >= RI_STALL_MS`）时接管：正常运笔
                  由包路径改写，两条同时改 = 双重滞后。互斥即分工。
               ⛔ 内部四处 `GetCursorPos`（补流输入 / [dead] 判据 / HUD / DPI）全部改走
                  `se_real_GetCursorPos()` 直调真函数 —— 否则「输入吃自己的滞后输出」
                  ⇒ 每拍再加一点滞后 ⇒ 自激发散。
               ⛔ 快照必须新鲜（`sn_age_ms <= 300`），否则 snOut 是死值，会把线钉死在
                  一个固定位移上（比不平滑更糟）⇒ 宁可透传。
            ② `GetMessagePos` 同挂但**只计数**（LNP 也钩它），用来判定 PS 到底从哪条路
               取坐标；`[raw]` 加 `gcp=调用/rw=改写/a=接管态 gmp=调用`。
            ③ 开关外置 `wtctx.ini`：`cursorInject` 缺省 1（0x0131 修正，旧版把缺省放错了分支）。
               下一轮判据：① `诊断钩 ... GetCursorPos=挂`；② 断流期 `gcp` 是否在涨
               （涨 ⇒ PS 确实在问光标）；③ `rw` 是否随之一同涨（= 真改写了）；
               ④ **断流期线是否恢复平滑**（这是本版全部目的）；⑤ 正常运笔时 `a` 必须
               恒 0（接管态别乱入），HUD 圆心/轨迹末端不再分离。
   0x0130 = ① 补齐 0x012F 漏抄的那一条（用户点出来的）：**平滑的「节拍」必须与 PS 的
               查询同拍**。LNP 是「PS 每问一次 GetCursorPos，就推进引擎一步」
               （FUN_180058500 每调一次 `FUN_180058e90` + `n2ea1c++`）；
               我方引擎随**包**推进，断流期包少 ⇒ PS 在几十拍里拿到同一个偏移量 ⇒
               线"一顿一顿"。修法 = 在 det_GetCursorPos 里把 raw / out **两端都外推**
               到此刻（复用 HUD 2026-10-14 那套 v·Δt，限幅 40ms、有符号相减），
               差值才等于此刻的真实滞后。⛔ 不改引擎状态（外推是纯几何，不推进滤波）。
            ② 复核「缓存点」那条：**已等价具备** —— LNP 在「笔画中但左键电平读 0」时
               返回缓存平滑点；我方 `g_penDown` 自带 1500/6000ms 接触闩（0x012A/0x012B），
               电平掉落期间 `armed` 仍成立 ⇒ 同样继续返回平滑点而非透传。
            ③ 复核 `g_canvasOkDbg`：它在 `wantVisible` 判定**之前**无条件每帧更新
               （第 6063 行）⇒ 断流期不会冻结，可安全作为接管条件。
            下一轮判据：断流期线**跟手连续、无台阶感**（0x012F 的目的），
            且 `[raw] gcp=/rw=` 同步增长。
   0x0131 = ① ⛔⛔【**标定死锁：整场「准备中」、HUD 与平滑全死**】（jwwh-39120 实测）。
               旧版把「n>=3 个包才敢标定」当硬门槛（防盲扫巧合），而真机上 PS
               **几乎一次只取 1 个包**（整场 `[pk] 最大单次=2`）⇒ 一个 `[calib]` 都
               打不出来 ⇒ `g_calib.tried` 永远 0 ⇒ `state` 恒 0 ⇒ 面板永远「准备中」、
               HUD 全部门闩失守、平滑零改写。**这是在补流之外的一条独立死路。**
               修法（分层取证，`tried` 的预算逻辑不变）：
                 · n>=3 → 老规矩（掩码+数据双证据优先，盲扫可独走）；
                 · n==2 → 也判，但**只认「掩码 + 盲扫」互证**（2 个包能凑出大量假的
                   「序号逐包 +1」，盲扫单独定案不可信；两路独立证据互证 ≈ n=3 强度）；
                 · n<2  → 走 `WTPacketsPeek` **只读**快照（按规范不消费队列）凑一批，
                   每 32 拍探一次；⛔ 绝不用 WTPacketsGet（会真把包从 PS 手里吃掉）。
               并新增 `[calib] 等证据 2s: 本批 n=… peek=… 最大单次=… 累计包=… 尝试=…`
               心跳 —— 没有它，标定不成立时日志里**一行 calib 都没有**（39120 就是
               只能靠推断查了半天）。
            ② `cursorInject` 缺省值给错了位置：旧版只在「ini 文件不存在」分支里置 1，
               而真实 ini（`queueSize=128`）存在 ⇒ 数组第 4 位保持 0 ⇒ 日志打
               `cursorInject=0`，GetCursorPos 接管**从头到尾没开过**。
               修法 = 进 `fopen` 之前无条件置 1，再由文件里的 `cursorInject=0` 覆盖。
            ③ `user32!GetCursorPos` 根本挂不上：入口首字节 = **BA**（真代码，非 E9 转发桩），
               LHOOK 的「顺 E9 找真函数再直调」模型不适用；硬打 5 字节又必须造
               trampoline，而 `BA` 是「mov edx,imm32（5 字节）」还是「BT 组（3 字节）」
               **没反汇编器就不能猜**（猜错 = 把 PS 代码从中间劈开）。
               修法 = 改走**导入表（IAT）**：扫本进程所有已加载模块，把 USER32!GetCursorPos
               的槽指向 detour。user32 代码一个字节不动、无指令长度问题、写时复制只影响
               本进程；⛔ 自己的模块不参与扫描 ⇒ `se_real_GetCursorPos()` 里那句
               `GetCursorPos(p)` 仍是系统真函数（不会自己吃自己）。模块是陆续加载的
               ⇒ 每 30s 静默重扫一遍（只有真的新增了槽才出声）。
               下一轮判据：① `[gcp] 导入表接管 GetCursorPos: …（N 槽）` 出现且 N>0；
               ② 断流期 `[raw] gcp=` 在涨（涨 ⇒ PS 确实在问光标）；③ `rw=` 随之涨；
               ④ `[calib]` 第一段出现且 `结论: ★启用改写`，面板离开「准备中」。
               仍为 0 ⇒ PS 是用 GetProcAddress 现取地址，再考虑入口 trampoline。
   0x0132 = 纯诊断（**零行为变化**）：0x0131 实测 14 笔全绿（jwwh-9020），但台账里
               `落` 在一段「笔」中出现 9/6/3 次 —— 铁律 19 说「>1 ⇒ buttons 笔中抖动」，
               可是这次用户完全没看到折角，怀疑真相是「1500ms 接触闩把多次真落笔合并成
               一段台账」。数据里无法区分这两者 ⇒ 补一条直接证据：
               台账加 `落间最小全零=N包(共M次)` = 本笔每次「落」之前笔连续悬空的包数最小值。
               `N` 远大于 BTN_EDGE_MIN_ZERO(8) ⇒ 笔真的抬起过（多笔合并，正常）；
               `N` 贴着 8 ⇒ 抖动，每次都会把输出点钉回笔尖（会看见折角）。
               ⛔ 铁律 19 的判据据此改写为：**每段台账的 `落` 可以 >1，但 `落间最小全零`
                  必须显著大于去抖阈值**；只有后者贴着 8 才是真抖动。
            下一轮判据：`[stroke] … 落间最小全零=` 这串数字是否 >= 20 包。
   0x0133 = ① ⛔⛔ **PS 会自己关掉 Wintab 上下文，且不会自动重开**（jwwh-36236，
               19:39:22 `WTClose hCtx=0x802` 之后 packets 定格 43125 到日志结束）。
               用户感知「后半段断流、怎么都不自愈，reload 才好」——reload 有效是因为
               PS 在插件重新加载时才重建上下文。我们手上零包 ⇒ 平滑/HUD/补流全都
               无从下手（**不是**状态机坏了）。
               ⇒ 加**上下文看门狗**：WTClose 之后 1.5s 仍无 WTOpen 就置原因码 9
                 （`PS上下文已关闭`）并落一行可操作提示。只定性，不臆造恢复手段
                 （自建上下文是 0x0123 明确禁止的）。
            ② **闸门值可以过期**（用户报「用铅笔时套索 HUD 意外出现」的机制）：
               面板心跳每 1.5s 整包重发 penSmooth，而旧 `write_params` 每次都把
               `I_GATETS = now` ⇒ 一个过期的「是套索」被心跳永久续命 ⇒ 引擎永远放行
               ⇒ 画笔类工具落笔也出 HUD；反过来若冻结在 0，就是「开关怎么拨都不恢复」。
               ⇒ 面板改发 `gateAge`（= 距最后一次**真读到工具**的毫秒数；从没读到过
                 则发 0 = 旧行为），原生侧写 `I_GATETS = now - gateAge`。读失败 / 被
                 忙碌闸门挡住时年龄自然增长 ⇒ 3s 后 fail-closed。心跳只续「参数」，
                 不再续「真相」。
            下一轮判据：① 用铅笔落笔时 HUD 不再出现（`[why] toolOk=0` 或 `reason=4`）；
               ② 换回套索后 3s 内恢复（`toolOk` 回到 1）；
               ③ 若再遇「断流」，日志里应出现 `[ctx] ★PS 已关闭 Wintab 上下文`。
   0x0134 = ① ⛔⛔ **悬链线的垂度方向只能是「重力方向」**（用户实测两个截图：
               旧版在弦接近竖直时把绳子往**左右两侧**鼓）。旧代码取的是「弦的法线」再翻到
               ny>0 —— 弦水平时侥幸正确，弦一竖就变成横向鼓包。真实悬链的垂度永远竖直。
               ⇒ 控制点只加**竖直分量**（屏幕 +Y），并按水平跨度占比 |dx|/d 衰减
                 （弦越竖可垂空间越小；完全竖直时拉直）。形状仍是二次贝塞尔抛物线
                 = 小垂度悬链的标准近似。
            ② ⛔⛔ **「前台必须是 PS」这根 HUD 门槛被错用到了救援路径上**（jwwh-40408：
               用户抱怨「一早就出现无法自愈的断流」）。铁证：整段 `fg=0`（前台是
               Chrome_WidgetWin_1）里 `[gate] penDown 0→1` 与 packets 增长**照旧**
               ——因为 Wintab 是系统上下文，PS 在后台也照收包、照绘制；
               而 `[dead] pre=(tip1/syn1/hw1/cv0/frz1/btn0)` 说明补流全副武装、
               只被 `cv=0`（= 前台不是主框）一个人挡住 ⇒ 线冻 58 秒到用户重按笔。
               ⇒ 新增宽判 `g_canvasHitDbg = canvas_hit_ok(cur)`：只看「笔落点是否在
                 PS 主框子树里」，**不看前台**。平滑改写/补流武装/喂入冻结/GetCursorPos
                 接管全部改用它；**HUD 继续用严格判据**（HUD 浮在别的程序上会碍事）。
            下一轮判据：① 把聊天窗切到前面再画，平滑**照旧生效**（`[raw] cv` 不再变 0）；
               ② 断流期 `[dead] pre=(…cv1…)`、`补发` 持续增长、线不再冻住；
               ③ HUD 在别的程序前台时仍然**不显示**（严格门槛没被放宽）；
               ④ 悬链线在任何弦角度下都只朝屏幕下方鼓。
            验收（jwwh-33124，0x0134 实跑）：④ 用户确认「悬链线的样式我满意了」；
               ② 断流占比从 0x0133 的 68%（jwwh-40408）降到 21%（去掉冷启动空转），
               宽判确实救回了大半 —— 但**仍有 6 次/118s**，见 0x0135 的排查口径修正。
   0x0135 = ① ⛔⛔ **「还没开始画」被记成了「停摆 44359ms」**（jwwh-33124 判读现场）：
               插件 reload 之后前台还是 Chrome_WidgetWin_1，用户在浏览器里待了 44 秒、
               笔压根没上板（`g_pkReal` 全程 0、`[frz] 落笔=0(末次 本次尚未见)`）。
               而 `[stall] 结束：停摆 44359ms` 这行字直接把人引向「一开局就断流」的
               错误结论 —— 排障从第一分钟就被带偏。
               ⇒ `[stall]`/`[frz]` 增加 `s_stallBoot`：**进程至今零个真实包**时改用
                 `[boot]` 措辞、不再叫停摆、不计入停摆统计；第 1 个包到达时另打一行
                 `[boot] 首包到达：冷启动空转 Nms … ⇒ 从此刻起才算「运笔」`。
               ⛔ 判据：日志里第一个 `[stall] ★` 之前必须先见到 `[boot] 首包到达`
                 （或启动后 400ms 内就有包）。否则「断流」结论不可信。
            ② ⛔⛔ **buttons 去抖阈值 8 包太松，把「笔中抖动」当成了真落笔**：
               本场四笔的 `落间最小全零` = 8 / 9 / 8 / 8 包 —— **全部贴着旧阈值**，
               即「笔还按着，buttons 只掉 8~9 包零就回来」却每次都触发锚定 ⇒ 输出点
               被钉回原始坐标 ⇒ 看得见的折角/突然追到笔尖（铁律 19 的抖动形态）。
               ⇒ `BTN_EDGE_MIN_ZERO` 8 → 16（≈90ms@176Hz），真抬笔再落实测 ≥260ms，
                 仍有 2.9 倍余量；台账新增 `滤=N`（被去抖否决的 0→1 边沿数），
                 避免「改了阈值就看不见了」。
            下一轮判据：① 日志里 `[boot] 首包到达` 出现，且「停摆 44 秒」类记录消失；
               ② `落间最小全零` 应远离 16（≥30 包）且 `共N次` 与用户实际落笔数吻合；
               ③ `滤=` > 0 ⇒ 抖动确实存在且被拦住了；`滤=0` 且 `落` 仍多 ⇒ 阈值可再收。
   0x0136 = ⛔⛔ **「三路输入」只做了一半 —— 补 Windows Ink 主动探针**（用户质问：
               「我之前不是让你设计了和 LNP 一样的三路：wintab、光标查询、Windows Ink，
                为啥还是会失效？你就完全复刻不行吗？」）。
               先认账：我们实际只有 **1.5 路**。
                 · Wintab 包（inline hook `WTPacketsGet`）——有，真断流时全空（`真实包=0`）。
                 · 系统光标（IAT `GetCursorPos`）——有，但**与 Wintab 同源**：笔停则光标停。
                 · Windows Ink ——**没有**。我们从头到尾只注册了 Raw Input(HID)，
                   而三场日志 `HID=0(0/s)` 全空（Wintab 独占时驱动吞掉 HID 原始输入），
                   和 LNP 钩的 `GetPointerInfo/History` 根本不是一个接口。
               现场对照（jwwh-23344 无 LNP vs jwwh-23992 开过 LNP）把差异钉死：
                 · 两场 Wintab 都会周期性全空（`真实包=0` 的连续块，23344 最长 10s，
                   23992 最长 105s）—— 所以断流本身不是「LNP 与否」的变量。
                 · 23344 断流且笔按着时：`[raw] 现值` 连续 4 次一模一样 (1260,1311)
                   ⇒ **系统光标冻死** ⇒ `GetCursorPos` 接管没有原料 ⇒ 平滑失效。
                 · 23992 同样 `真实包=0` 的 105 秒里：`现值` 一路在变
                   (1823,924)→(2150,751)→(2248,829)→(4148,249)→(3099,772)…
                   ⇒ **光标完整跟笔** ⇒ PS 退回鼠标路径照画，我方 IAT 接管把平滑坐标
                   喂给它（`gcp/rw` 从 248 涨到 60977）⇒ 用户看到「平滑始终生效」。
               ⇒ 结论：**平滑引擎没坏，缺的是「断流期笔在哪」这个坐标**。三条路里
                  Wintab 空、系统光标冻，只剩 Windows Ink 没试过。
               本版做法：`ink_probe_tick()` 每 250ms 主动枚举 pointerId 1..32 问
                 `user32!GetPointerInfo`（**主动拉取**，不依赖 PS 调不调 —— 断流时 PS
                 可能压根不问 Ink，被动挂钩就永远等不到），只读、绝不改输出。
               日志判据（一句话）：**Wintab 为 0 的那些秒里 `[ink]` 涨不涨**。
                 涨 ⇒ 接成真正独立的第四路（断流期平滑就有原料）；
                 不涨 ⇒ Windows Ink 也判死，API 层到此为止，只剩驱动层可选。
               ⛔ `gmp=0` 两场全程为 0 ⇒ `GetMessagePos` 不是 PS 的取坐标路径，
                 别再去补消息层（LNP 钩它只是保险，不是主路）。
   0x0137 = ⛔⛔ **把「光标路径」做成 LNP 那样自给自足 —— 这是「避免平滑失效」的主修**
               （用户指令：「尽可能参考 LNP 的设计，避免平滑失效才是最关键的，
                 BUG 发生的场景都是极端小众场景，不要搞错优先级」）。
               本场取证 jwwh-13664（LNP 关闭，0x0136 实跑，318s）：
                 · `[ink] 命中=0` 全程 —— Windows Ink 这条也判死（探针只报了启动那一行），
                   三路里第三路正式宣告不可用；Raw Input 早就是 `HID=0`。
                 · 32 次停摆 / 停摆合计 145s（45%）；中位 2.4s，最长 **54.6s**。
                 · 停摆期 `[raw] 现值` 时而跟笔（本场光标确实在动），时而冻死
                   （`[frz] movedTot=0/12 cur=上拍`）⇒ 原料时有时无。
                 · 四笔台账 `落间最小全零=16包`，`共N次` 远超实际落笔数 ⇒ 每次停摆
                   恢复都被当成一次「新落笔」，输出点被钉回原始坐标。
               两个真凶（都在自己代码里，不在驱动）：
               ① **tip 链最长只撑 6s**（`SYNTH_TIP_MAX_MS`）⇒ 超过 6s 的停摆里合成包
                  buttons 只能写 0 ⇒ PS 收包却当悬停 ⇒ 只挪光标不落笔 ⇒ 线冻住。
                  本场 >5.5s 的停摆有 5 次，覆盖 145s 里的绝大部分。
               ② **GetCursorPos 接管的门太窄**：要求 `sAge<=300`（快照新鲜）——
                  而快照只在「PS 取到包」时才更新，断流期必然过期 ⇒ 长停摆一次都不接管。
                  且改写量仍来自「最后一包」的 (raw,out) 差 ⇒ 包停后偏移是死值。
               ⇒ ① 长停摆续命：`realAge > 6s` 时改用**包外按钮电平**（我方 WH_MOUSE_LL
                    镜像的累积电平 ∨ 系统电平）＋ 光标在画布内 ＋ 1.5s 内动过 ⇒ tip=1。
                    三条缺一不可（静止/离画布立刻回落），只加不减，绝不否决包证据。
                 ② 光标路径换成**独立推进器** `gp_step()`：照 LNP 分支 C（O31），
                    **每次 GetCursorPos 查询都推进一步**拉绳模型，参数与包路径同源
                    （同一份 g_cfg 的绳长/模式/DPI），完全不读包快照。停摆期 PS 退回
                    鼠标路径时，拿到的就是我们平滑后的点 —— 不再有「包停 ⇒ 平滑停」。
                    去掉了 `sAge<=300` 与 `g_penDown` 的单一口径（改用包证据 ∨ 包外证据）。
                 ③ 补流交还驱动时置 `g_btnResync`，下一批 buttons 重新对表
                    （`s_prevBtn=1; s_btnZero=0`）⇒ 停摆恢复不再凭空造出一次落笔边沿。
            下一轮判据：① `[gcp] ★断流期接管光标查询` 行出现，且 `[raw] rw=` 在停摆期
               持续增长（旧版长停摆时几乎不涨）；
               ② `[mse] ★长停摆续命` 行出现时，那段停摆里笔仍能画（线不再冻）；
               ③ 台账 `共N次` 掉到与用户实际落笔数同量级、`落间最小全零` 不再贴在 16；
               ④ 断流占比（145s/318s）应显著下降 —— 注意它统计的是**驱动停投递**，
                  不会因为本版改动而消失；本版要改的是「停投递期间不再掉平滑」。
   0x0138 = ⛔⛔ **撤掉「只在断流期接管」这道门闩 —— 光标路径改成「笔按着就推」**
               （用户指令：「我要求你实现 LNP 的『PS 每问一次光标在哪，就把绳子往前
                 拽一小步，答案从来不依赖包』，把原来的门闩的逻辑改成这个」）。
               本场取证 jwwh-22732（0x0137 实跑，112s）：
                 · 22:14:41 → 22:15:40 **整整 60 秒**：`gcp` 从 19667 涨到 106933
                   （PS 问了 8.7 万次光标），而 `rw` **卡在 5938 一动不动**、`a=0`。
                 · 同一段里包流是**健康**的：`[pk] 真实包=425 (202/s)`，台账改写率 99%。
                 · ⇒ 「包流健康」和「PS 在用包画」是两件事。用户在画布外的浮窗（Coolorus）
                   上按一下再回到画布，PS 的绘制通路就切到了鼠标侧；包照收、但不用于绘制。
                   0x0137 的门闩要求「必须断流才接管」⇒ 在这种状态下**一格都不推**，
                   于是用户看到的就是「平滑失效且永不自愈」（直到 reload）。
               ⇒ 新判据只有一条：**笔按着（三类证据取并集）⇒ 推；笔抬着 ⇒ 透传**。
                  包、断流、包龄、前台、画布一律不参与「要不要推」。
                  画布宽判 `canvas_hit_ok()` 只决定「这段坐标能不能喂」：
                  笔落在别的窗口上时把输出钉住（与包路径「喂入冻结」同一语义），
                  避免把画布外坐标灌进绳子被 PS 钳到边界（LNP 那个锯齿轮廓 BUG）。
                  另加「0→1 边沿贴合」= LNP 分支 A 的初始化笔画。
            下一轮判据：① `[raw] gp=` 两项在**正常运笔时也一直涨**（旧版只在断流期涨）；
               ② `gcp/rw` 比例在画线时明显上升（旧版 112s 里只改了 8029 次 / 11 万次调用）；
               ③ 用户主观：在画布外浮窗上按一下再回画布，平滑**不再丢**；
               ④ 笔抬着时 `a=0`（不许把系统光标永久顶偏，否则点菜单会点歪）。 */
/* 0x0139 = ⛔⛔ **工具闸门拆成「事实」与「没来得及报」；光标路径不许抖动透传**
               （用户报的两个连锁 BUG：①切到涂抹长按涂抹，HUD 仍错误显示；
                 ②切回套索画选区，前半段正常、中途失效，停笔时 PS 自己从选区末端
                   画一条直线到笔尖，圆心与受力点不再重合）。
               代码级真凶（两条，都不是参数问题）：
               ① `if (contactPrev && latched == 1) useGate = ENABLED;` —— **整笔冻结工具裁决**。
                  用户长按笔时左键电平恒真 ⇒ 面板巡检被 `hostYield` 无限期让路 ⇒
                  `CFG_I_TOOLGATE` 停在切走前的 1 ⇒ 涂抹被当成套索一直改写、HUD 一直显示。
               ② 同一条链的后半段：短闩 `g_contact` 抖一次（轻压运笔成段全零是已知现象）
                  就掉进 else 现判 `tool_gate_ok()`；而此刻心跳已过期 3s ⇒ 判 0
                  ⇒ **整批原样透传** ⇒ PS 收到真实笔尖 ⇒ 从圆心拉一根直线到笔尖。
               本版做法：
                 · 新增 `tool_gate_sure_not_lasso()`：只有「GATETS 新鲜 ∧ TOOLGATE==0」
                   才算**事实**（面板刚读过 application.tool）⇒ 立即否决，闩锁也压不住；
                   心跳过期一律只当「面板没来得及报」，**不**否决。
                 · 新增 `tool_edit_allowed()`：包路径与光标路径**共用**它（旧版各判一次，
                   漂移一次就分叉 = HUD 在圆心、选区末端在笔尖）。
                 · HUD 的 gateOk 追加 `!tool_gate_sure_not_lasso()`：兜住「包路径因标定
                   失效提前 return、`g_toolOk` 冻结在 1」这第二条通路。
                 · 光标路径：手松开后 `GP_HOLD_MS=700` 内**钉住**输出点（既不推进也不透传），
                   覆盖实测 400~600ms 的零段；大跳跃不再「瞬间贴合」而是本拍不推进
                   （LNP `bigJumpSqDist` 同义），主笔那一帧的 200px 瞬移就是「凭空直线」。
            下一轮判据：① 切到涂抹后 `[why] gate/close` 在 1s 内增长、HUD 立刻收起；
               ② 套索运笔中不再出现「一笔之内 close 增长又 open 增长」；
               ③ 停笔不动时 `[raw] rw` 不再跳一次（跳 = 透传了一拍）。 */

/*   0x013A = 0x020A 配套：Alt 临时吸管硬否决位 + HUD 显示去抖 + 不裁决即归零
            ① `tool_edit_allowed()` 与 HUD 的 `gateOk` 都先看 `CFG_I_ALTTOOL`
               —— 吸管态下**一个字节都不改写、一圈都不画**（用户报：「Alt 切吸管后
               按笔吸色会错误触发 HUD」；同一放行还会让取色点被拉绳偏移）。
            ② HUD 新增显示去抖：刚隐藏过的 1.5s 内必须连续满足 180ms 才重新出现
               ⇒ 吃掉「抬笔后 CONTACT_HOLD_MS(250ms) 保持窗口 + 立刻挪笔」造成的
               短暂闪现（用户报：「填充完选区后挪动光标找落笔点，HUD 意外闪一下」）。
            ③ 包路径在「标定失效」提前 return 时把 g_penDown/g_toolOk/g_strokeGate
               显式归零 —— 旧版冻在 1，包流一恢复就用陈旧几何画一圈。
            ④ 新增 `[hud] 显示` / `[hud] 隐藏` 边沿日志（此前显示动作零留痕，
               4 帧的闪现只能靠「未显示」行的 2s 节流缺口反推，根本看不见）。 */
__declspec(dllexport) int jwwh_version(void) { return 0x013A; }

/* ⛔⛔ 0x013D：引擎软闸（面板 unload / reload 专用）。
 *
 * on=1 ⇒ WTPacketsGet 与 GetCursorPos 两个 detour **立刻原样透传**，HUD 强制隐藏；
 *         线程、补丁、标定全部原样保留 ⇒ 再 on=0 时无需重新标定即可复机。
 * ⛔ 绝不能用 jwwh_unhook() 代劳：它会 join 四个线程、还原 Wintab 字节、关日志，
 *    且 `g_stop` 置 1 后 worker 不会自己回来 —— 面板关掉再打开（Reload）就彻底没平滑了。
 *    这正是旧实现「Unload 后引擎继续驻留」与「停干净」之间缺的那一档。
 */
__declspec(dllexport) int jwwh_set_engine_off(int on)
{
    InterlockedExchange(&g_engineOff, on ? 1 : 0);
    if (on) {
        /* 立刻解掉光标路径的「按着」状态：否则复机时第一笔会被当成续笔，
           输出点从上一笔的残留位置被绳拽过来（LNP 那个斜线开头）。 */
        g_penDown = 0;
    }
    return (int)g_engineOff;
}

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
    penraw_stop();
    cursamp_stop();
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

/* M2（.8li 进程内形态）：本文件被直接编进 JWautofillHost.8li，与 plugin_main.c
   同镜。DllMain 归 plugin_main.c 所有 ⇒ 这里改名为 engine_dllmain，由它在
   DLL_PROCESS_ATTACH / DETACH 时原样转发（attach = start_worker，detach = 兜底
   repatch —— 语义与旧注入版逐字节一致）。

   ⛔⛔ 0x0117：DETACH 必须把引擎**整体停干净**再返回（2026-10-17 崩溃四连修）。
   旧代码在 DETACH 里只 repatch，worker / hud / cursamp / penraw 四个线程全部
   存活 ⇒ FreeLibrary 一返回，它们就在**已卸载的代码**上继续跑 ⇒ 0xC0000005。
   WER 实证（今日四场，旧名新名都崩）：
     Photoshop.exe 27.11 · 出错模块 JWautofillHost.8li_unloaded ·
     异常代码 0xc0000005 · 错误偏移 0x10eb8（崩溃时刻 = pi8li.log 的 DETACH 行）。
   cursamp 4ms / hud 16ms 两个循环在卸载后**几毫秒内**必然踩空 ⇒ 稳定复现。
   jwwh_unhook 全序列幂等（线程 join + 各自销毁窗口 + 还原钩子 + 关日志），
   且 ExitProcess 路径（reserved != NULL）上其它线程已被系统终结、各 wait 立即
   返回 ⇒ 两条卸载路径都安全。 */
BOOL WINAPI engine_dllmain(HINSTANCE hinstDLL, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        g_hInst = hinstDLL;      /* HUD 注册窗口类用（见 g_hInst 声明处） */
        /* ⛔ 重活绝不放在 DllMain（loader lock）⇒ 只起线程立刻返回。 */
        start_worker(hinstDLL);
    } else if (reason == DLL_PROCESS_DETACH) {
        /* 模块即将被卸载映射 ⇒ 先停全部引擎线程（见上方 0x0117 说明）。 */
        jwwh_unhook();
        /* 兜底（幂等）：jwwh_unhook 内部已还原过；worker 没起来过时它early-return，
           这里保证「挂过钩」的路径字节一定写回。 */
        if (g_patched && g_entry) repatch(g_entry, g_orig);
    }
    return TRUE;
}
