/* ps_tool.c —— 进程内「当前工具」闸门（照 Lazy Nezumi Pro 的路子）
 *
 * ================================================================ 为什么要它
 * 旧实现：面板每 300ms 用 batchPlay 读一次 `application.tool`，折算成
 * CFG_I_TOOLGATE 写进共享内存。代价有三层：
 *   ① 每次读都要进一次**模态作用域**（psRead/runAsModal）——而全工程的模态请求
 *      共用 `MIN_MODAL_GAP_MS=300` 的节流预算，即上限 3.3/s。300ms 一轮的巡检
 *      **恰好把预算吃满**，于是「自动填充」这类本来就要弹模态的操作一叠加，
 *      请求率立刻超过吞吐 ⇒ 告警风暴（真机：用户报「modal scope 暴涨」）。
 *   ② 巡检有三条提前 return（isPsBusy / 读挂起 / 模态节流），PS 一忙就整段停摆；
 *      而 GATETS 过期是 fail-closed ⇒ 平滑被误杀。
 *   ③ 300ms 的采样间隔本身就是工具切换的感知延迟。
 *
 * 本文件把这件事搬进 PS 进程内，**零 batchPlay、零 UXP 参与、零延迟**：
 *   · 加载时 AcquireSuite 拿到 PS 的三套 action suite；
 *   · 向 sPSActionControl 注册 **'slct'**（"选中项改变"）通知回调；
 *   · PS 每次切换工具都会发这条通知，回调里从 ActionDescriptor 里取出
 *     「当前工具」的类名（形如 lassoTool），就地算出闸门写共享内存。
 *
 * ================================================================ 证据来源
 * 结构体偏移**不是猜的**，是从 LNP 的 MouseHookPro64.dll（v16.8.29.1218，
 * SHA256 17ea8b6b…）逐条读出来的。反编译证据：
 *   PluginMain("SP Access","Reload"):
 *     DAT_18008b450 = *(longlong*)(md + 0x18);        // SPBasicSuite*
 *     DAT_18008b440 = *(undefined8*)(md + 0x08);      // self（通知回调的 refcon）
 *     (*(*basic))("df135117-…", 2, &sPSActionReference);
 *     (*(*basic))("bc1e4d70-…", 2, &sPSActionControl);
 *     (*(*basic))("df135115-…", 2, &sPSActionDescriptor);
 *     err = (*(sPSActionControl + 0x20))(self, 0x736c6374 = 'slct', PSSelectEventCallback);
 *   Unload:
 *     (*(sPSActionControl + 0x28))(self, 0x416c6c20 = 'All ');
 *     (*(*basic + 8))(uuid, 2);                        // ReleaseSuite
 *   回调 PSSelectEventCallback(refcon, descriptor, …)：
 *     (*(sPSActionDescriptor + 0x28))(descriptor, &count);            // GetCount
 *     (*(sPSActionDescriptor + 0x18))(descriptor, i, &key);           // GetKey
 *     (*(sPSActionDescriptor + 0x10))(descriptor, key, &type);        // GetType
 *     type == 0x6f626a20 ('obj ')
 *     (*(sPSActionDescriptor + 0x100))(descriptor, key, &ref);        // GetReference
 *     (*(sPSActionReference + 0x18))(ref, &classID);                  // GetDesiredClass
 *     (*(sPSActionControl + 0x18))(classID, buf, 0xff);               // TypeIDToStringID
 *     strstr(buf, "Tool") ⇒ 命中当前工具
 *
 * ⛔⛔ 有效性验证（本机实测，不是推断）：LNP 的那份日志
 *   `%LOCALAPPDATA%\Lazy Nezumi Pro\log_photoshop.txt` 里
 *     Fri Oct 16 16:29:21 2026 / App path: …\Adobe Photoshop 2026\Photoshop.exe
 *     16:29:37 - LNP::MouseHook::setPSTool(): PS tool name: lassoTool, type: 21, enabled: 1
 *   即 **同一条路径在 PS 2026（27.8）上今天跑通过**，且全程没有
 *   "couldn't acquire … suite" / "couldn't register PS select event callback" 报错。
 *   ⇒ 偏移与 PS 27.8 的 suite v2 布局一致。
 *
 * ⛔⛔ 三态接管（**关键设计**）：通知只在「工具改变」时来，所以插件刚加载时
 *   我们对当前工具一无所知。此时若贸然接管闸门，就会把闸门写成「未知」
 *   ⇒ 原生侧 fail-closed ⇒ 平滑要等用户切一次工具才活。
 *   因此分三态，面板据此决定要不要继续自己轮询：
 *     0 = 不可用（AcquireSuite/注册失败）→ 面板照旧 300ms 轮询
 *     1 = 已注册但**还没读到过**工具      → 面板继续轮询，本模块不写闸门
 *     2 = 已读到过至少一次 ⇒ 正式接管     → 面板停止轮询，本模块独占闸门
 *   这样「接管」严格发生在能力被证明之后，任何一步失败都退回旧行为。
 *
 * ================================================================ 白名单口径
 * 闸门值 = 「工具类名里含 lasso」？1 : 0 —— 与面板 App.isLassoTool() 的
 * `/lasso/i` **逐字同义**（PS 三个套索工具 ID：lassoTool / polygonalLassoTool /
 * magneticLassoTool）。⛔ 两边口径必须一起改，改一处就是静默分歧。
 * ⇒ 2026-10-17 起**优先**读外置白名单 `psTools.xml`（见文件末 load_whitelist），
 *   读不到才回退上面这句 —— 白名单从此是**数据**而不是代码（照 LNP 的 psTools.xml）。
 *
 * ================================================================ 2026-10-17 扩事件（LNP 26.10 逆向迁移）
 * 除 'slct' 外再注册四条，全部走同一套 sPSActionControl：
 *   · modalStateChanged      —— 回调里读描述符键 'Lvl '（0x4c766c20）= **PS 模态嵌套层级**。
 *       这是进程内、零 batchPlay 的忙碌闸门替身（面板 isPsBusy()/probeHostIdle 的解药）：
 *       层级 > 0 ⇒ 宿主正握着模态作用域，此刻面板任何轮询都只会排队。
 *   · toolModalStateChanged  —— 「工具进入/退出绘制态」。LNP 自己的回调是**空函数**
 *       （FUN_180007d60 反编译 = `return;`）⇒ 它是否真的投递、极性如何**没有证据**。
 *       本模块只做「计数 + 记值 + 打日志」，值交给引擎；引擎在极性被证明之前
 *       **不**拿它做硬门控（见 smooth_engine.c hud 段的 drawOk）。
 *   · 'Opn ' / 'Cls '        —— 文档开/关，驱动 docEpoch：面板 500ms 的
 *       pollDocIdentity 从此可大幅降频（正确性仍由那条轮询兜底）。
 * ⛔ 新增常量/偏移全部来自 `analysis/lnp-ps64-reverse-2026-10-16.md` 的静态证据；
 *    未标注「已真机验证」的条目必须在 pi8li.log 里自行核对后再接逻辑。
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* plugin_main.c 提供 */
extern void pstool_publish(int gate);              /* 写 I_TOOLGATE + I_GATETS */
/* ⛔⛔ 只收 fmt 本体，**不要传 tag** —— 它内部已经固定用 "ps_tool" 作为 tag
   （log_line("ps_tool", ...)）。多传一个首实参会被当成 fmt，后面的真文案与
   占位符全部作废、只打出一行 "ps_tool"：编译器不报错（变参合法），
   属于**静默**缺陷。 */
extern void pstool_log(const char* fmt, ...);      /* 写 pi8li.log */

/* ================================================================ suite 取用 */

/* ⛔ 返回类型一律 `short`：LNP 的调用点把返回值读进 `short sVar1` 再与 0 比较 ——
   即**只读 ax**。照抄这个宽度最安全：不管宿主真正写的是 16 位还是 32 位 SPErr，
   读 ax 都不会因为上半寄存器是脏值而误判成失败（误判的代价是「退回面板轮询」，
   虽安全但平白丢掉收益）。 */
typedef short (*fn_acquire)(const char* name, int version, const void** suite);
typedef short (*fn_release)(const char* name, int version);

typedef short (*fn_ctrl_register)(void* refcon, unsigned int event, void* proc);
typedef short (*fn_ctrl_unregister)(void* refcon, unsigned int event);
typedef short (*fn_ctrl_tid2str)(unsigned int typeID, char* out, unsigned int cap);
/* 2026-10-17：StringIDToTypeID —— LNP initInstance（FUN_180006f50）里逐键取 ID 用的
   就是 `sPSActionControl + 0x10`，签名 `(const char*, uint32*)`，与 +0x18 的
   TypeIDToStringID 互为逆运算（同一套 suite ⇒ 偏移自洽）。 */
typedef short (*fn_ctrl_str2tid)(const char* str, unsigned int* out);
typedef short (*fn_desc_getcount)(void* desc, unsigned int* count);
typedef short (*fn_desc_getkey)(void* desc, unsigned int index, unsigned int* key);
typedef short (*fn_desc_gettype)(void* desc, unsigned int key, unsigned int* type);
typedef short (*fn_desc_getref)(void* desc, unsigned int key, void** ref);
typedef short (*fn_ref_getclass)(void* ref, unsigned int* cls);
/* 2026-10-17：描述符取整数 —— LNP 的 modalStateChanged 回调（FUN_180007ce0）里
   `(**(code**)(descSuite + 0xb0))(descriptor, 'Lvl ', &lvl)`。
   ⛔ 这是本模块**唯一**没有真机验证过的偏移 ⇒ 调用前一律过 fn_exec_ok() 闸门。 */
typedef short (*fn_desc_getint)(void* desc, unsigned int key, unsigned int* out);

/* PSActionControl / PSActionDescriptor / PSActionReference 的方法偏移
   （v2；逐条来自上面反编译证据，**改这里必须重新对照二进制**）。 */
#define OFF_CTRL_STR2TID       0x10
#define OFF_CTRL_REGISTER      0x20
#define OFF_CTRL_UNREGISTER    0x28
#define OFF_CTRL_TID2STR       0x18
#define OFF_DESC_GETCOUNT      0x28
#define OFF_DESC_GETKEY        0x18
#define OFF_DESC_GETTYPE       0x10
#define OFF_DESC_GETREF        0x100
#define OFF_DESC_GETINT        0xb0
#define OFF_REF_GETCLASS       0x18

#define SUITE_REFERENCE  "df135117-c769-11d0-8079-00c04fd7ec47"
#define SUITE_CONTROL    "bc1e4d70-f953-11d0-8d9f-00c04fd5f7ee"
#define SUITE_DESCRIPTOR "df135115-c769-11d0-8079-00c04fd7ec47"
#define SUITE_VERSION    2                 /* ⛔ LNP 传的就是整数 2，不是字符串 */

#define EV_SELECT        0x736c6374u       /* 'slct' */
#define EV_ALL           0x416c6c20u       /* 'All ' */
#define TYPE_OBJ_        0x6f626a20u       /* 'obj ' */
/* 2026-10-17（LNP 同款硬编码四字符码，见其 initCallbacks FUN_180007500） */
#define EV_OPEN          0x4f706e20u       /* 'Opn ' 文档打开 */
#define EV_CLOSE         0x436c7320u       /* 'Cls ' 文档关闭 */
#define KEY_LVL          0x4c766c20u       /* 'Lvl ' modalStateChanged 里的模态层级（整数） */

/* 从 suite 结构体里取第 off 字节处的方法指针（suite 本体是函数指针数组）。 */
static void* meth(void* suite, size_t off)
{
    void* p = NULL;
    if (suite) memcpy(&p, (const char*)suite + off, sizeof(p));
    return p;
}

/**
 * 函数指针可执行性闸门（2026-10-17）。
 *
 * ⛔ 为什么要有：OFF_DESC_GETINT(0xb0) 是**静态反编译**读出来的偏移，本机从未验证。
 *   取到野指针再在 **PS 主线程**上调一次，代价是整个 PS 崩掉 —— 而它只是为了拿一个
 *   诊断数值。⇒ 调用前先问 VirtualQuery：指针不在一块可执行映像里就整段放弃
 *   （后果只是「模态层级不可用」，面板继续走它原来的轮询，安全侧）。
 * ⛔ 只在 install / 首次回调时判一次（结果缓存进 s_getIntOk），不要放热点。
 */
static int fn_exec_ok(void* p)
{
    if (!p) return 0;
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery((LPCVOID)p, &mbi, sizeof(mbi)) != sizeof(mbi)) return 0;
    DWORD pr = mbi.Protect;
    return (pr & (PAGE_EXECUTE | PAGE_EXECUTE_READ |
                  PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) != 0;
}

/* ================================================================ 状态 */

#define PS_UNAVAIL  0
#define PS_REGISTERED 1
#define PS_OWNED    2

static volatile LONG s_state;              /* 见文件头「三态接管」 */
static void* s_basic;
static void* s_refSuite;
static void* s_ctrlSuite;
static void* s_descSuite;
static void* s_self;
static volatile LONG s_notifyN;            /* 回调次数 */
static volatile LONG s_toolN;              /* 成功读出工具的次數 */
static volatile LONG s_lastNotifyMs;       /* 最后一次 slct 回调时刻（看门狗用；0=从未） */
static volatile LONG s_lastGate = -1;
static volatile LONG s_failCode;

/* ——— 2026-10-17：PICA 扩事件的观测槽（全部由 PS 主线程回调写、pump 线程读）——— */
static volatile LONG s_modalN;             /* modalStateChanged 投递次数 */
static volatile LONG s_modalLvl    = -1;   /* 最近一次读到的 'Lvl '（-1 = 从未读到） */
static volatile LONG s_modalTs;            /* 最近一次读到的 GetTickCount() */
static volatile LONG s_modalErr;           /* 'Lvl ' 读取失败 / 指针不可用的次数 */
static volatile int  s_getIntOk   = -1;    /* 0xb0 可用性缓存：-1 未判 0 不可用 1 可用 */

static volatile LONG s_tModalN;            /* toolModalStateChanged 投递次数 */
static volatile LONG s_tModal     = -1;    /* 最近一次的工具模态值（-1 = 从未读到） */
static volatile LONG s_tModalKey;          /* 该值取自哪个描述符键（调试用，十六进制） */
static volatile LONG s_tModalSeen;         /* 位 0 = 见过 0，位 1 = 见过 1（极性证据） */
static unsigned int  s_evModal, s_evTModal;/* StringIDToTypeID 取到的事件 ID（0 = 没取到）*/

static volatile LONG s_docEpoch;           /* 'Opn '/'Cls ' 计数：文档级变化的进程内副本 */
static volatile LONG s_docN;

int pstool_state(void) { return (int)s_state; }

/* —— 活性看门狗（2026-10-17 0x0115）——
   ⛔⛔ 起因（真机 pid 13428）：`'slct'` 通知**会停止投递**。
     06:53:13~06:53:36 连续 5 次回调一切正常，此后 72 秒里用户持续操作
     （`toolModalStateChanged` 从 n=52 涨到 92，说明有 40 次点击）却**一次 slct
     都没有**；而 `modalStateChanged` 与 `toolModalStateChanged` 同期照常投递
     ⇒ 停止的是 slct 这一路，不是 PS 的通知系统整体。
     那一刻的后果是灾难性的：闸门已被 `state=2` 独占、面板停止轮询
     ⇒ 闸门永久冻结在 `gate=0` ⇒ **HUD 再也不显示，开关平滑开关也修不好**
     （开关不改变闸门值，闸门只由 ps_tool 写 —— 与用户报的完全一致）。

   ⛔ 根因是**架构缺陷**而非偶发：'slct' 是「**只在工具变化时才有真相**」的通道，
     它没有心跳语义。把它当成闸门的**唯一**供给者，等于把「当前工具是什么」
     这个持续量押在一个事件通道的持续可靠上 —— 一旦通道静默，真相就永久丢失。

   ⇒ 修复思路（不依赖"PS 为什么停"这个未知）：
     给"接管"加**时效**。只有「最近 PS_NOTIFY_FRESH_MS 内真的收到过 slct」才算
     此刻真的接管；超时 ⇒ 自动让位给面板轮询（`pstool_owns()` 返回 0），
     面板因此恢复喂闸门；slct 一旦恢复，立刻重新接管。
   ⚠️ 取值 2000ms：它是「闸门陈旧的最大容忍窗口」。太小 ⇒ 稳态（用户不切工具）
     频繁让位，省不到模态预算；太大 ⇒ 通道静默后 HUD 错得久。
     2s 是这两者的折中 —— 正常切工具后闸门立刻由事件更新，静默 2s 后才回落到
     面板的低频兜底（面板侧同步降频，见 app.tsx 的 GATE_FALLBACK_MS）。 */
#define PS_NOTIFY_FRESH_MS 2000

int pstool_notify_age(void)
{
    DWORD t = (DWORD)s_lastNotifyMs;
    if (!t) return -1;                       /* -1 = 从未投递过 */
    return (int)((DWORD)GetTickCount() - t); /* ⛔ GetTickCount 差用无符号减，跨 49.7 天回绕仍正确 */
}

/* —— 供 plugin_main.c 写进 CFG 槽（本文件不碰槽位表，是既有铁律）—— */
int  pstool_modal_level(void) { return (int)s_modalLvl; }     /* -1 = 未知 */
int  pstool_modal_ts(void)    { return (int)s_modalTs; }
int  pstool_modal_n(void)     { return (int)s_modalN; }
int  pstool_tool_modal(void)  { return (int)s_tModal; }       /* -1 = 未知 */
int  pstool_doc_epoch(void)   { return (int)s_docEpoch; }

/**
 * 工具模态的「极性是否已证明」。
 * ⛔ 只有**同时见过 0 和 1** 才算证明 —— 那说明它确实是个状态信号而不是常量。
 *    极性（1 = 绘制中）本身仍未证明；引擎据此决定要不要拿它做硬门控。
 */
int  pstool_tool_modal_known(void)
{
    return ((s_tModalSeen & 3) == 3) ? 1 : 0;
}

/** 面板取用的「工具名」快照（只给诊断/展示；闸门判定不依赖它）。 */
static char  s_toolName[64];
static volatile LONG s_toolNameOk;

int pstool_tool_name(char* out, int cap)
{
    if (!out || cap <= 0) return 0;
    out[0] = 0;
    if (!s_toolNameOk) return 0;
    int i = 0;
    for (; i < cap - 1 && s_toolName[i]; i++) out[i] = s_toolName[i];
    out[i] = 0;
    return i;
}

/* 大小写不敏感的子串查找（PS 的工具类名是 camelCase，但别赌它不变）。 */
static int ci_has(const char* hay, const char* needle)
{
    size_t n = strlen(needle);
    if (!hay || n == 0) return 0;
    for (const char* p = hay; *p; p++) {
        size_t i = 0;
        while (i < n) {
            char a = p[i], b = needle[i];
            if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
            if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
            if (a != b) break;
            i++;
        }
        if (i == n) return 1;
    }
    return 0;
}

/* ================================================================ 工具白名单（外置）
 * 照 LNP 的 `psTools.xml` 形态（`<lassoTool>true</lassoTool>` 逐工具布尔表），
 * 放在 `%LOCALAPPDATA%\JWautofill\psTools.xml`。
 *
 * ⛔ 为什么外置：「哪些工具吃平滑」是一个**会反复改口径**的判断，写死在 C 里每改一次
 *   就要重编 + 重启 PS。做成数据后改文件即可（下次加载生效）。
 * ⛔ 回退口径必须**逐字等价于**原来的 `ci_has(name,"lasso")`：文件不存在 / 解析出 0 项
 *   时走回退，行为与 2026-10-17 之前完全一致 —— 这是「不会引入回归」的依据。
 * ⛔ 只认 ASCII 标签与 true/1（其它一律 false）：解析器刻意做成极简，不引第三方库。
 */
#define WL_MAX 24
static char s_wlName[WL_MAX][48];
static int  s_wlN;
static int  s_wlLoaded;                    /* 1 = 外置文件生效 0 = 走内置回退 */

static void load_whitelist(void)
{
    const char* lad = getenv("LOCALAPPDATA");
    char path[MAX_PATH];
    if (!lad) return;
    _snprintf(path, sizeof(path), "%s\\JWautofill\\psTools.xml", lad);
    path[sizeof(path) - 1] = 0;

    HANDLE f = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) {
        pstool_log("工具白名单：%s 不存在 ⇒ 内置回退（类名含 lasso）", path);
        return;
    }
    DWORD sz = GetFileSize(f, NULL);
    if (sz == INVALID_FILE_SIZE || sz == 0 || sz > 65536) { CloseHandle(f); return; }
    char* buf = (char*)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)sz + 1);
    if (!buf) { CloseHandle(f); return; }
    DWORD got = 0;
    if (!ReadFile(f, buf, sz, &got, NULL)) { CloseHandle(f); HeapFree(GetProcessHeap(), 0, buf); return; }
    CloseHandle(f);
    buf[got] = 0;

    for (const char* p = buf; *p && s_wlN < WL_MAX; ) {
        const char* lt = strchr(p, '<');
        if (!lt) break;
        lt++;
        if (*lt == '/' || *lt == '?') { p = lt + 1; continue; }
        const char* gt = strchr(lt, '>');
        if (!gt) break;
        size_t nl = (size_t)(gt - lt);
        if (nl == 0 || nl >= sizeof(s_wlName[0])) { p = gt + 1; continue; }
        char nm[48];
        memcpy(nm, lt, nl); nm[nl] = 0;
        /* 自闭合标签（<x/>）没有正文 ⇒ 视为 true（XML 里常这么写开关） */
        int closed = (gt[-1] == '/') ? 1 : 0;
        const char* body = gt + 1;
        int val = 0;
        if (!closed) {
            char open[64];
            _snprintf(open, sizeof(open), "</%s>", nm);
            const char* end = strstr(body, open);
            size_t bl = end ? (size_t)(end - body) : strlen(body);
            if (bl >= 4 && (_strnicmp(body, "true", 4) == 0)) val = 1;
            else if (bl >= 1 && body[0] == '1') val = 1;
        } else {
            val = 1;
        }
        if (val) {
            memcpy(s_wlName[s_wlN], nm, nl + 1);
            s_wlN++;
        }
        p = gt + 1;
    }
    HeapFree(GetProcessHeap(), 0, buf);
    if (s_wlN > 0) {
        s_wlLoaded = 1;
        pstool_log("★工具白名单：外置 %s（%d 项：%s%s%s%s）", path, s_wlN,
                   s_wlName[0],
                   s_wlN > 1 ? ", " : "", s_wlN > 1 ? s_wlName[1] : "",
                   s_wlN > 2 ? ", …" : "");
    } else {
        pstool_log("工具白名单：%s 里没有 true 项 ⇒ 内置回退（类名含 lasso）", path);
    }
}

/** 当前工具是否吃平滑。⛔ 白名单未加载时**必须**等价于 ci_has(name,"lasso")。 */
static int tool_enabled(const char* name)
{
    if (!name || !*name) return 0;
    if (!s_wlLoaded) return ci_has(name, "lasso");
    for (int i = 0; i < s_wlN; i++) {
        /* 自带大小写不敏感比较：不赌 `stricmp` 在各工具链下的可用性。 */
        const char* a = name; const char* b = s_wlName[i];
        int eq = 1;
        for (; *a && *b; a++, b++) {
            char ca = *a, cb = *b;
            if (ca >= 'A' && ca <= 'Z') ca = (char)(ca - 'A' + 'a');
            if (cb >= 'A' && cb <= 'Z') cb = (char)(cb - 'A' + 'a');
            if (ca != cb) { eq = 0; break; }
        }
        if (eq && *a == 0 && *b == 0) return 1;
    }
    return 0;
}

/* ================================================================ 通知回调 */
/* ⛔ 运行在 PS 主线程；主路径只做「读描述符 + 写两个 LONG」，不分配。
   唯一的 I/O 是 **工具变化时** 的一行日志（pstool_log → log_line 无锁自开自关，
   与 pump 线程不共用互斥量 ⇒ 不会死锁）。工具切换是用户驱动的低频事件，
   在这里落一行日志可以接受；但**不要**把周期性的东西塞进来。 */
static void __cdecl ps_select_notify(void* refcon, void* descriptor, void* a3, void* a4)
{
    (void)refcon; (void)a3; (void)a4;
    InterlockedIncrement(&s_notifyN);
    /* ⛔ 看门狗心跳：必须在**任何**提前 return 之前打（包括下面那些「读不到就放弃」
       的分支）—— 它证明的是「PS 还在往我们这里投递 slct」，与「这次读没读到工具」
       是两件事。放在 return 之后会让「通道活着但解析失败」被误判成通道静默。 */
    InterlockedExchange(&s_lastNotifyMs, (LONG)GetTickCount());
    if (!descriptor || !s_descSuite || !s_refSuite || !s_ctrlSuite) return;

    fn_desc_getcount  getCount = (fn_desc_getcount) meth(s_descSuite, OFF_DESC_GETCOUNT);
    fn_desc_getkey    getKey   = (fn_desc_getkey)   meth(s_descSuite, OFF_DESC_GETKEY);
    fn_desc_gettype   getType  = (fn_desc_gettype)  meth(s_descSuite, OFF_DESC_GETTYPE);
    fn_desc_getref    getRef   = (fn_desc_getref)   meth(s_descSuite, OFF_DESC_GETREF);
    fn_ref_getclass   getClass = (fn_ref_getclass)  meth(s_refSuite,  OFF_REF_GETCLASS);
    fn_ctrl_tid2str   tid2str  = (fn_ctrl_tid2str)  meth(s_ctrlSuite, OFF_CTRL_TID2STR);
    if (!getCount || !getKey || !getType || !getRef || !getClass || !tid2str) return;

    unsigned int count = 0;
    if (getCount(descriptor, &count) != 0) return;

    for (unsigned int i = 0; i < count; i++) {
        unsigned int key = 0, type = 0;
        if (getKey(descriptor, i, &key) != 0) continue;
        if (getType(descriptor, key, &type) != 0) continue;
        if (type != TYPE_OBJ_) continue;              /* 只要「对象」型条目 */

        /* ⛔ 引用槽必须给足 16 字节：LNP 用的是 `longlong local_118[2]`（Ghidra 显示
           只初始化了 [0]，但分配了两个 qword）。宿主写多宽没有文档，照抄它的宽度 ——
           少给 8 字节就是**栈越界写**，那是最难查的一类崩溃。 */
        unsigned long long refBuf[2];
        refBuf[0] = 0; refBuf[1] = 0;
        if (getRef(descriptor, key, (void**)refBuf) != 0) continue;
        void* ref = (void*)(UINT_PTR)refBuf[0];
        if (!ref) continue;

        unsigned int cls = 0;
        if (getClass(ref, &cls) != 0) continue;

        char buf[256];
        buf[0] = 0;
        if (tid2str(cls, buf, 0xff) != 0) continue;
        buf[sizeof(buf) - 1] = 0;

        if (!ci_has(buf, "tool")) continue;            /* strstr(buf,"Tool") 同义 */

        /* 命中当前工具：清洗成安全字符集后发布（它会进 JSON 与日志，不能带引号/控制符）。 */
        int ok = 0;
        for (int k = 0; k < (int)sizeof(s_toolName) - 1 && buf[k]; k++) {
            char c = buf[k];
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') || c == '_' || c == '-') {
                s_toolName[ok++] = c;
            }
        }
        s_toolName[ok] = 0;
        InterlockedExchange(&s_toolNameOk, ok > 0 ? 1 : 0);
        if (ok == 0) break;

        int gate = tool_enabled(s_toolName) ? 1 : 0;
        InterlockedIncrement(&s_toolN);
        if (InterlockedExchange(&s_state, PS_OWNED) != PS_OWNED)
            pstool_log("★接管工具闸门（首次读到工具 \"%s\" ⇒ gate=%d）", s_toolName, gate);
        if (InterlockedExchange(&s_lastGate, gate) != gate)
            pstool_log("工具切换：\"%s\" ⇒ gate=%d", s_toolName, gate);
        pstool_publish(gate);
        break;
    }
}

/**
 * modalStateChanged —— 读 'Lvl '（= PS 的模态嵌套层级）。
 *
 * ⛔⛔ 价值：这是 `isPsBusy()` + `MIN_MODAL_GAP_MS` 那整套东西的**进程内替身** ——
 *   不进模态作用域、不吃 3.3/s 的预算。面板据此可以在「层级 > 0」时**整轮跳过**
 *   自己的轮询（此刻发出去也只会排队），直接砍掉 modal scope 告警的主要来源。
 * ⛔ 回调里只做「一次 GetInteger + 两个 LONG 写」；日志只在**层级变化**时落一行
 *   （模态进出不是高频事件，但「每帧都打」会把 pi8li.log 冲垮）。
 */
static void __cdecl ps_modal_notify(void* refcon, void* descriptor, void* a3, void* a4)
{
    (void)refcon; (void)a3; (void)a4;
    InterlockedIncrement(&s_modalN);
    if (!descriptor || !s_descSuite) return;

    if (s_getIntOk < 0) {
        void* fp = meth(s_descSuite, OFF_DESC_GETINT);
        s_getIntOk = fn_exec_ok(fp) ? 1 : 0;
        if (!s_getIntOk)
            pstool_log("⚠ sPSActionDescriptor+0xb0 不可用（%p，非可执行映像）"
                       " ⇒ 放弃进程内模态层级，面板维持原轮询", fp);
    }
    if (!s_getIntOk) return;

    fn_desc_getint getInt = (fn_desc_getint) meth(s_descSuite, OFF_DESC_GETINT);
    unsigned int lvl = 0;
    if (getInt(descriptor, KEY_LVL, &lvl) != 0) {
        if (InterlockedIncrement(&s_modalErr) == 1)
            pstool_log("⚠ modalStateChanged 里读 'Lvl ' 失败 code≠0（描述符键可能变了）");
        return;
    }
    if ((unsigned long)lvl > 64) lvl = 64;          /* 防御：不为日志留下天文数字 */
    LONG prev = InterlockedExchange(&s_modalLvl, (LONG)lvl);
    InterlockedExchange(&s_modalTs, (LONG)GetTickCount());
    if (prev != (LONG)lvl)
        pstool_log("PS 模态层级 %ld ⇒ %lu（modalStateChanged 第 %ld 次）",
                   (long)prev, (unsigned long)lvl, (long)s_modalN);
}

/**
 * toolModalStateChanged —— 「工具进入/退出绘制态」的**探针**（不是门控）。
 *
 * ⛔⛔ LNP 的这个回调是空函数（FUN_180007d60 = return;）⇒ **没有**「它有效」的证据。
 *    本实现的定位是取证：把「投递几次、值是什么、从哪个键读出来」原样落到日志，
 *    交给真机判决。引擎侧在 `pstool_tool_modal_known()` 为真之前不会拿它挡 HUD。
 * ⛔ 读值策略：先试 'Lvl '；不行就枚举描述符，取**第一个 GetInteger 成功**的键。
 *    ⛔ 枚举只在**前 4 次**回调里做（之后只试已知键）—— 回调跑在 PS 主线程上，
 *      不能让取证动作长期挂在用户每次落笔的路径上。
 */
static void __cdecl ps_toolmodal_notify(void* refcon, void* descriptor, void* a3, void* a4)
{
    (void)refcon; (void)a3; (void)a4;
    LONG n = InterlockedIncrement(&s_tModalN);
    if (!descriptor || !s_descSuite) return;

    if (s_getIntOk < 0) {
        void* fp = meth(s_descSuite, OFF_DESC_GETINT);
        s_getIntOk = fn_exec_ok(fp) ? 1 : 0;
    }
    if (!s_getIntOk) return;

    fn_desc_getint  getInt  = (fn_desc_getint)  meth(s_descSuite, OFF_DESC_GETINT);
    fn_desc_getcount getCnt = (fn_desc_getcount) meth(s_descSuite, OFF_DESC_GETCOUNT);
    fn_desc_getkey   getKey = (fn_desc_getkey)   meth(s_descSuite, OFF_DESC_GETKEY);
    if (!getInt) return;

    unsigned int keyTried = (unsigned int)s_tModalKey;
    int found = 0;
    unsigned int val = 0;

    if (keyTried && getInt(descriptor, keyTried, &val) == 0) {
        found = 1;
    } else if (getInt(descriptor, KEY_LVL, &val) == 0) {
        keyTried = KEY_LVL; found = 1;
    } else if (n <= 4 && getCnt && getKey) {
        unsigned int cnt = 0;
        if (getCnt(descriptor, &cnt) == 0) {
            if (cnt > 16) cnt = 16;
            for (unsigned int i = 0; i < cnt; i++) {
                unsigned int k = 0;
                if (getKey(descriptor, i, &k) != 0) continue;
                if (getInt(descriptor, k, &val) == 0) { keyTried = k; found = 1; break; }
            }
        }
    }
    if (!found) {
        if (n == 1)
            pstool_log("toolModalStateChanged 已投递，但描述符里没有可取整数的键 ⇒ 只计数");
        return;
    }

    int v = (val != 0) ? 1 : 0;
    InterlockedExchange(&s_tModalKey, (LONG)keyTried);
    LONG seen = s_tModalSeen;
    InterlockedExchange(&s_tModalSeen, (LONG)(seen | (1 << v)));
    LONG prev = InterlockedExchange(&s_tModal, (LONG)v);
    if (prev != (LONG)v && (n <= 8 || (n % 32) == 0))
        pstool_log("工具模态 %ld ⇒ %d（键=0x%08lX，第 %ld 次；%s）",
                   (long)prev, v, (unsigned long)keyTried, (long)n,
                   pstool_tool_modal_known() ? "★极性已证明" : "极性待证");
}

/**
 * 'Opn ' / 'Cls ' —— 文档开/关。
 *
 * ⛔ 只推进一个计数器，**不解析描述符**（这两个事件在打开大文档时会连着来，
 *    解析成本没必要）。面板拿它跟自己的 lastDocId 比对即可发现「文档换了」，
 *    从而把 500ms 的 pollDocIdentity 降成低频兜底。
 */
static void __cdecl ps_doc_notify(void* refcon, void* descriptor, void* a3, void* a4)
{
    (void)refcon; (void)descriptor; (void)a3; (void)a4;
    LONG n = InterlockedIncrement(&s_docN);
    InterlockedIncrement(&s_docEpoch);
    if (n <= 4 || (n % 8) == 0)
        pstool_log("★文档级事件 第 %ld 次 ⇒ docEpoch=%ld", (long)n, (long)s_docEpoch);
}

/* ================================================================ 安装 / 卸载 */

int pstool_install(void* basic, void* self)
{
    if (s_state == PS_OWNED || s_state == PS_REGISTERED) return 1;
    if (!basic) { pstool_log("安装失败：SPBasicSuite 为空（md->basic=NULL）"); return 0; }

    /* ⛔⛔ 2026-10-19：这一行以前**漏了**（s_basic 全文件只有声明、没有赋值）⇒
       pstool_uninstall() 的第一道判空 `!s_basic` 恒真，**永远直接 return**：
       ① 5 个 PS 通知回调从来没被注销；② 3 个 suite 从来没 release。
       PS 侧于是长期持有指向本 DLL 的函数指针，一旦模块被 FreeLibrary / 重载，
       下一次 'slct'/'Cls '/'Opn ' 投递就跳进已卸载内存（WER：*.8li_unloaded + c0000005）。
       必须在这里存下来，卸载路径才有办法真正注销。 */
    s_basic = basic;

    fn_acquire acquire = (fn_acquire) meth(basic, 0);      /* SPBasicSuite + 0x00 */
    if (!acquire) { pstool_log("安装失败：SPBasicSuite->AcquireSuite 为空"); return 0; }

    int e1 = acquire(SUITE_REFERENCE,  SUITE_VERSION, (const void**)&s_refSuite);
    int e2 = acquire(SUITE_CONTROL,    SUITE_VERSION, (const void**)&s_ctrlSuite);
    int e3 = acquire(SUITE_DESCRIPTOR, SUITE_VERSION, (const void**)&s_descSuite);
    if (e1 || e2 || e3 || !s_refSuite || !s_ctrlSuite || !s_descSuite) {
        InterlockedExchange(&s_failCode, e1 ? e1 : (e2 ? e2 : e3));
        pstool_log("AcquireSuite 失败 ref=%d ctrl=%d desc=%d（ptr %p/%p/%p）⇒ 退回面板轮询",
                   e1, e2, e3, s_refSuite, s_ctrlSuite, s_descSuite);
        s_refSuite = s_ctrlSuite = s_descSuite = NULL;
        return 0;
    }

    fn_ctrl_register reg = (fn_ctrl_register) meth(s_ctrlSuite, OFF_CTRL_REGISTER);
    if (!reg) {
        pstool_log("安装失败：sPSActionControl+0x20 为空 ⇒ 退回面板轮询");
        return 0;
    }
    s_self = self;
    int e4 = reg(self, EV_SELECT, (void*)ps_select_notify);
    if (e4 != 0) {
        InterlockedExchange(&s_failCode, e4);
        pstool_log("注册 'slct' 通知失败 code=%d ⇒ 退回面板轮询", e4);
        return 0;
    }

    /* ——— 2026-10-17：扩事件注册（每一条失败都只记日志，绝不影响已注册的 'slct'）———
       ⛔ 顺序：先 StringIDToTypeID 拿 ID，再 AddNotify。LNP 的 initInstance 就是这个次序
          （键 ID 存在 self 的字段里，initCallbacks 才拿它去注册）。 */
    load_whitelist();

    fn_ctrl_str2tid str2tid = (fn_ctrl_str2tid) meth(s_ctrlSuite, OFF_CTRL_STR2TID);
    if (str2tid && fn_exec_ok((void*)str2tid)) {
        unsigned int id = 0;
        if (str2tid("modalStateChanged", &id) == 0 && id) {
            s_evModal = id;
            int e5 = reg(self, id, (void*)ps_modal_notify);
            pstool_log("%s modalStateChanged（ID=0x%08lX）⇒ %s",
                       e5 == 0 ? "★已注册" : "⚠注册失败 code=", id, e5 == 0 ? "OK" : "跳过");
            if (e5 != 0) s_evModal = 0;
        } else {
            pstool_log("⚠ StringIDToTypeID(\"modalStateChanged\") 失败 ⇒ 跳过进程内模态层级");
        }
        id = 0;
        if (str2tid("toolModalStateChanged", &id) == 0 && id) {
            s_evTModal = id;
            int e6 = reg(self, id, (void*)ps_toolmodal_notify);
            pstool_log("%s toolModalStateChanged（ID=0x%08lX）⇒ %s（LNP 此回调为空，"
                       "本实现只取证不门控）",
                       e6 == 0 ? "★已注册" : "⚠注册失败 code=", id, e6 == 0 ? "OK" : "跳过");
            if (e6 != 0) s_evTModal = 0;
        } else {
            pstool_log("⚠ StringIDToTypeID(\"toolModalStateChanged\") 失败 ⇒ 跳过工具模态探针");
        }
    } else {
        pstool_log("⚠ sPSActionControl+0x10（StringIDToTypeID）不可用 ⇒ 只保留 'slct'");
    }
    /* 'Opn '/'Cls ' 是硬编码四字符码，不需要 str2tid。 */
    int eo = reg(self, EV_OPEN,  (void*)ps_doc_notify);
    int ec = reg(self, EV_CLOSE, (void*)ps_doc_notify);
    pstool_log("%s 文档级事件 'Opn '(%d) / 'Cls '(%d)",
               (eo == 0 && ec == 0) ? "★已注册" : "⚠部分失败", eo, ec);

    /* 三态的中间态：已注册、还没读到过工具 ⇒ 闸门仍由面板轮询供给。 */
    InterlockedExchange(&s_state, (s_state == PS_OWNED) ? PS_OWNED : PS_REGISTERED);
    pstool_log("★已注册 PS 'slct' 通知（suite v%d）—— 读到首个工具后正式接管闸门", SUITE_VERSION);
    return 1;
}

void pstool_uninstall(void)
{
    /* ⛔ 判据只看 ctrlSuite：s_basic 在 install 中途失败时可能是 NULL，
       但「注册过通知」只取决于 ctrlSuite 是否拿到 —— 用 s_basic 做前置条件
       会把「已注册、未注销」这条最危险的状态漏掉（见 install 里的说明）。 */
    if (!s_ctrlSuite) { s_refSuite = s_descSuite = NULL; s_self = NULL;
                        InterlockedExchange(&s_state, PS_UNAVAIL); return; }
    fn_ctrl_unregister unreg = (fn_ctrl_unregister) meth(s_ctrlSuite, OFF_CTRL_UNREGISTER);
    if (unreg) unreg(s_self, EV_ALL);
    fn_release release = s_basic ? (fn_release) meth(s_basic, 8) : NULL; /* SPBasicSuite + 0x08 */
    if (release) {
        release(SUITE_REFERENCE,  SUITE_VERSION);
        release(SUITE_CONTROL,    SUITE_VERSION);
        release(SUITE_DESCRIPTOR, SUITE_VERSION);
    }
    pstool_log("已注销通知（slct %ld 次/读到工具 %ld 次；modal %ld 次 层级=%ld；"
               "toolModal %ld 次 值=%ld 极性%s；文档事件 %ld 次）",
               (long)s_notifyN, (long)s_toolN,
               (long)s_modalN, (long)s_modalLvl,
               (long)s_tModalN, (long)s_tModal,
               pstool_tool_modal_known() ? "已证" : "未证",
               (long)s_docN);
    s_refSuite = s_ctrlSuite = s_descSuite = NULL;
    s_evModal = s_evTModal = 0;
    s_self = NULL;
    s_basic = NULL;                            /* 幂等：下次 install 重新记 basic */
    InterlockedExchange(&s_state, PS_UNAVAIL);
    InterlockedExchange(&s_toolNameOk, 0);
    InterlockedExchange(&s_lastNotifyMs, 0);   /* 看门狗：卸载 ⇒ 心跳作废 */
}

/* 诊断快照（写进 pi8li.log 的周期行）。 */
void pstool_diag(char* out, int cap)
{
    char nm[64];
    pstool_tool_name(nm, (int)sizeof(nm));
    if (!out || cap <= 0) return;
    /* ⛔ 回调龄只按**秒**取整：pump 是「diag 字符串变了才打一行」，而毫秒值每 500ms
       都在变 ⇒ 'slct' 静默期会每拍打一行（实测 72s 静默 = 144 行，把 pi8li.log 冲垮）。
       按秒取整后：新鲜期恒为 "0s"（不产生任何行），静默期约 1 行/s，密度与旧版一致。 */
    int age = pstool_notify_age();
    char ageBuf[48];
    if (age < 0) strcpy(ageBuf, "从未");
    else _snprintf(ageBuf, sizeof(ageBuf), "%ds%s", age / 1000,
                   age > PS_NOTIFY_FRESH_MS ? "★陈旧⇒让位面板" : "");
    ageBuf[sizeof(ageBuf) - 1] = 0;
    _snprintf(out, (size_t)cap,
              "state=%ld 回调=%ld 读到=%ld 工具=\"%s\" gate=%ld fail=%ld"
              " 回调龄=%s"
              " modal=%ld(lvl=%ld,n=%ld) tModal=%ld(n=%ld,%s) doc=%ld",
              (long)s_state, (long)s_notifyN, (long)s_toolN,
              s_toolNameOk ? nm : "?", (long)s_lastGate, (long)s_failCode,
              ageBuf,
              s_evModal ? 1L : 0L, (long)s_modalLvl, (long)s_modalN,
              (long)s_tModal, (long)s_tModalN,
              pstool_tool_modal_known() ? "极性已证" : "极性未证",
              (long)s_docEpoch);
    out[cap - 1] = 0;
}
