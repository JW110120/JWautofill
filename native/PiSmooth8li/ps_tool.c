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
 */

#include <windows.h>
#include <stdio.h>
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
typedef short (*fn_desc_getcount)(void* desc, unsigned int* count);
typedef short (*fn_desc_getkey)(void* desc, unsigned int index, unsigned int* key);
typedef short (*fn_desc_gettype)(void* desc, unsigned int key, unsigned int* type);
typedef short (*fn_desc_getref)(void* desc, unsigned int key, void** ref);
typedef short (*fn_ref_getclass)(void* ref, unsigned int* cls);

/* PSActionControl / PSActionDescriptor / PSActionReference 的方法偏移
   （v2；逐条来自上面反编译证据，**改这里必须重新对照二进制**）。 */
#define OFF_CTRL_REGISTER      0x20
#define OFF_CTRL_UNREGISTER    0x28
#define OFF_CTRL_TID2STR       0x18
#define OFF_DESC_GETCOUNT      0x28
#define OFF_DESC_GETKEY        0x18
#define OFF_DESC_GETTYPE       0x10
#define OFF_DESC_GETREF        0x100
#define OFF_REF_GETCLASS       0x18

#define SUITE_REFERENCE  "df135117-c769-11d0-8079-00c04fd7ec47"
#define SUITE_CONTROL    "bc1e4d70-f953-11d0-8d9f-00c04fd5f7ee"
#define SUITE_DESCRIPTOR "df135115-c769-11d0-8079-00c04fd7ec47"
#define SUITE_VERSION    2                 /* ⛔ LNP 传的就是整数 2，不是字符串 */

#define EV_SELECT        0x736c6374u       /* 'slct' */
#define EV_ALL           0x416c6c20u       /* 'All ' */
#define TYPE_OBJ_        0x6f626a20u       /* 'obj ' */

/* 从 suite 结构体里取第 off 字节处的方法指针（suite 本体是函数指针数组）。 */
static void* meth(void* suite, size_t off)
{
    void* p = NULL;
    if (suite) memcpy(&p, (const char*)suite + off, sizeof(p));
    return p;
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
static volatile LONG s_lastGate = -1;
static volatile LONG s_failCode;

int pstool_state(void) { return (int)s_state; }

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

/* ================================================================ 通知回调 */
/* ⛔ 运行在 PS 主线程；主路径只做「读描述符 + 写两个 LONG」，不分配。
   唯一的 I/O 是 **工具变化时** 的一行日志（pstool_log → log_line 无锁自开自关，
   与 pump 线程不共用互斥量 ⇒ 不会死锁）。工具切换是用户驱动的低频事件，
   在这里落一行日志可以接受；但**不要**把周期性的东西塞进来。 */
static void __cdecl ps_select_notify(void* refcon, void* descriptor, void* a3, void* a4)
{
    (void)refcon; (void)a3; (void)a4;
    InterlockedIncrement(&s_notifyN);
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

        int gate = ci_has(s_toolName, "lasso") ? 1 : 0;
        InterlockedIncrement(&s_toolN);
        if (InterlockedExchange(&s_state, PS_OWNED) != PS_OWNED)
            pstool_log("★接管工具闸门（首次读到工具 \"%s\" ⇒ gate=%d）", s_toolName, gate);
        if (InterlockedExchange(&s_lastGate, gate) != gate)
            pstool_log("工具切换：\"%s\" ⇒ gate=%d", s_toolName, gate);
        pstool_publish(gate);
        break;
    }
}

/* ================================================================ 安装 / 卸载 */

int pstool_install(void* basic, void* self)
{
    if (s_state == PS_OWNED || s_state == PS_REGISTERED) return 1;
    if (!basic) { pstool_log("安装失败：SPBasicSuite 为空（md->basic=NULL）"); return 0; }

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
    /* 三态的中间态：已注册、还没读到过工具 ⇒ 闸门仍由面板轮询供给。 */
    InterlockedExchange(&s_state, (s_state == PS_OWNED) ? PS_OWNED : PS_REGISTERED);
    pstool_log("★已注册 PS 'slct' 通知（suite v%d）—— 读到首个工具后正式接管闸门", SUITE_VERSION);
    return 1;
}

void pstool_uninstall(void)
{
    if (!s_ctrlSuite || !s_basic) return;
    fn_ctrl_unregister unreg = (fn_ctrl_unregister) meth(s_ctrlSuite, OFF_CTRL_UNREGISTER);
    if (unreg) unreg(s_self, EV_ALL);
    fn_release release = (fn_release) meth(s_basic, 8);        /* SPBasicSuite + 0x08 */
    if (release) {
        release(SUITE_REFERENCE,  SUITE_VERSION);
        release(SUITE_CONTROL,    SUITE_VERSION);
        release(SUITE_DESCRIPTOR, SUITE_VERSION);
    }
    pstool_log("已注销 'slct' 通知（回调 %ld 次、读到工具 %ld 次）",
               (long)s_notifyN, (long)s_toolN);
    s_refSuite = s_ctrlSuite = s_descSuite = NULL;
    s_self = NULL;
    InterlockedExchange(&s_state, PS_UNAVAIL);
    InterlockedExchange(&s_toolNameOk, 0);
}

/* 诊断快照（写进 pi8li.log 的周期行）。 */
void pstool_diag(char* out, int cap)
{
    char nm[64];
    pstool_tool_name(nm, (int)sizeof(nm));
    if (!out || cap <= 0) return;
    _snprintf(out, (size_t)cap,
              "state=%ld 回调=%ld 读到=%ld 工具=\"%s\" gate=%ld fail=%ld",
              (long)s_state, (long)s_notifyN, (long)s_toolN,
              s_toolNameOk ? nm : "?", (long)s_lastGate, (long)s_failCode);
    out[cap - 1] = 0;
}
