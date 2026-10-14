/* JWautofill Smooth — .8li 进程内插件（M2：WS 协议层 + 引擎宿主）
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

#define SMOOTH_PORT      18924
#define LOG_MAX          (1024 * 1024)
#define THREAD_WAIT_MS   3000
#define MAX_CLI          8

/* 引擎接口（smooth_engine.c） */
BOOL WINAPI engine_dllmain(HINSTANCE hinst, DWORD reason, LPVOID reserved);

/* ================================================================ M1 日志 */

static void log_line(const char* tag, const char* fmt, ...);

/* ================================================================ CFG 槽位 */
/* ⛔⛔ 与 smooth_engine.c 的 enum CFG_I_*、Program.cs 的 I_* 三处手写逐项对应；
   错位不报错、只静默失效（既有铁律）。 */
#define CFG_NAME_W   L"Local\\JWautofillWintabSmooth"
#define CFG_MAGIC    0x57414A57L      /* 'JWAW' */
#define CFG_NLONGS   48

enum {
    I_MAGIC = 0, I_ENABLED, I_STRENGTH, I_FLAGS, I_SEQ, I_CMDSEQ, I_CMD, I_CMDACK,
    I_STATE, I_CALLS, I_PACKETS, I_SMOOTHED, I_STRIDE, I_OFFX, I_OFFY, I_OFFSER,
    I_AXISMAX, I_PID, I_FROZE, I_HEARTBEAT,
    I_MODE, I_TENSION, I_CATCHUP, I_CORNER, I_RADIUSPX, I_HUD, I_HUDCOLOR, I_PXPERAXIS,
    I_TOOLGATE, I_GATETS, I_PENDOWN, I_GATEOK, I_CTUNKNOWN,
    I_PXPERAXISY, I_SNTS, I_REASON, I_GATEOPEN, I_GATECLOSE,
    I_CTOFF, I_CTVAL, I_PXNX, I_PXNY, I_CTMASK, I_CTELIG, I_CTOFFS
};
typedef char cfg_fit_check[(I_CTOFFS < CFG_NLONGS) ? 1 : -1];

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
static void Wr(int slot, LONG v)
{
    if (g_cfg) InterlockedExchange((LONG*)&g_cfg[slot], v);
}

/* ================================================================ 参数面 */
/* Program.cs PenParams/PenHook.Set 的移植。默认值对齐 C# 字段初始化。 */
typedef struct {
    int mode, strength, radiusPx, catchUp, cornerAngle, flags, hud, hudColor, toolGate;
} PenP;

static PenP g_pen = { 1, 40, 40, 50, 45, 0, 0, 0xE07F0D, 2 };

static volatile LONG g_enabled;
static volatile LONG g_cmdSeq;
static volatile LONG g_cmdKnown;     /* ⛔ cmd 去重：只有开关跃变才下发 1/2，
                                        否则面板 300ms 一次的 toolGate 心跳会反复
                                        重置标定（Program.cs _cmdStateKnown 同款）。 */
static volatile LONG g_cmdStateOn;
static volatile LONG g_lastHealAt;
static volatile LONG g_zeroHeal;

static HINSTANCE g_hSelf;

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
    Wr(I_TOOLGATE,  g_pen.toolGate);
    /* ⛔ 闸门时间戳与闸门值必须同时写：引擎按 GATE_STALE_MS=3000 判过期。 */
    Wr(I_GATETS,    (LONG)GetTickCount());
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
        "\"axisMax\":%d,\"hookPid\":%d,\"frozeThreads\":%d,\"lastError\":0}}",
        (int)g_enabled, g_pen.strength, g_pen.mode, g_pen.radiusPx, g_pen.catchUp,
        g_pen.cornerAngle, (g_pen.flags & 1) ? "true" : "false", g_pen.hud, g_pen.toolGate,
        Rd(I_TOOLGATE) != 0 ? 1 : 0, (int)Rd(I_PENDOWN), (int)Rd(I_GATEOK), (int)Rd(I_CTUNKNOWN),
        (int)Rd(I_REASON), (int)Rd(I_GATEOPEN), (int)Rd(I_GATECLOSE),
        (int)Rd(I_CTOFF), (int)Rd(I_CTVAL), (int)Rd(I_CTELIG), (int)Rd(I_CTMASK), (int)Rd(I_CTOFFS),
        (int)Rd(I_PXNX), (int)Rd(I_PXNY), (int)Rd(I_PXPERAXIS), (int)Rd(I_PXPERAXISY),
        dllEsc, (unsigned long)GetCurrentProcessId(),
        (int)Rd(I_STATE), (int)Rd(I_CALLS), (int)Rd(I_PACKETS), (int)Rd(I_SMOOTHED),
        snAge, (int)Rd(I_STRIDE), (int)Rd(I_OFFX), (int)Rd(I_OFFY), (int)Rd(I_OFFSER),
        (int)Rd(I_AXISMAX), (int)Rd(I_PID), (int)Rd(I_FROZE));
    return n > 0 ? n : 0;
}

/* ================================================================ 极简 JSON */
/* 面板消息是扁平对象（值 = 布尔/数字/短字符串），手写定位足够；
   缺字段 = 保持原值（Program.cs 可空字段合并的同款语义）。 */
static const char* json_find(const char* js, const char* key)
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

static int json_num(const char* js, const char* key, double* out)
{
    const char* p = json_find(js, key);
    if (!p) return 0;
    char* end = NULL;
    double v = strtod(p, &end);
    if (end == p) return 0;
    *out = v;
    return 1;
}

static int json_bool(const char* js, const char* key, int* out)
{
    const char* p = json_find(js, key);
    if (!p) return 0;
    if (_strnicmp(p, "true", 4) == 0)  { *out = 1; return 1; }
    if (_strnicmp(p, "false", 5) == 0) { *out = 0; return 1; }
    return 0;
}

static int json_str(const char* js, const char* key, char* out, int cap)
{
    const char* p = json_find(js, key);
    if (!p || *p != '"') return 0;
    p++;
    int i = 0;
    while (*p && *p != '"' && i < cap - 1) out[i++] = *p++;
    out[i] = 0;
    return 1;
}

/* ================================================================ WS（RFC6455） */

static CRITICAL_SECTION g_sendLk;
static CRITICAL_SECTION g_cliLk;
static SOCKET g_cliS[MAX_CLI];

static int send_all(SOCKET s, const char* p, int n)
{
    int got = 0;
    while (got < n) {
        int r = send(s, p + got, n - got, 0);
        if (r <= 0) return -1;
        got += r;
    }
    return 0;
}

static int recv_all(SOCKET s, char* p, int n)
{
    int got = 0;
    while (got < n) {
        int r = recv(s, p + got, n - got, 0);
        if (r <= 0) return -1;
        got += r;
    }
    return got;
}

/* --- SHA1 + base64（握手 challenge 应答用；输入 ≤ 几百字节） --- */
static void sha1(const unsigned char* msg, int len, unsigned char out[20])
{
    unsigned int h0 = 0x67452301u, h1 = 0xEFCDAB89u, h2 = 0x98BADCFEu;
    unsigned int h3 = 0x10325476u, h4 = 0xC3D2E1F0u;
    int total = ((len + 8) / 64 + 1) * 64;
    unsigned char* buf = (unsigned char*)malloc((size_t)total);
    if (!buf) return;
    memset(buf, 0, (size_t)total);
    memcpy(buf, msg, (size_t)len);
    buf[len] = 0x80;
    unsigned long long bits = (unsigned long long)len * 8;
    for (int i = 0; i < 8; i++) buf[total - 1 - i] = (unsigned char)(bits >> (8 * i));

    for (int off = 0; off < total; off += 64) {
        unsigned int w[80];
        for (int i = 0; i < 16; i++)
            w[i] = ((unsigned int)buf[off + 4 * i] << 24) | ((unsigned int)buf[off + 4 * i + 1] << 16) |
                   ((unsigned int)buf[off + 4 * i + 2] << 8) | (unsigned int)buf[off + 4 * i + 3];
        for (int i = 16; i < 80; i++) {
            unsigned int x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (x << 1) | (x >> 31);
        }
        unsigned int a = h0, b = h1, c = h2, d = h3, e = h4;
        for (int i = 0; i < 80; i++) {
            unsigned int f, k;
            if (i < 20)     { f = (b & c) | ((~b) & d);            k = 0x5A827999u; }
            else if (i < 40){ f = b ^ c ^ d;                       k = 0x6ED9EBA1u; }
            else if (i < 60){ f = (b & c) | (b & d) | (c & d);     k = 0x8F1BBCDCu; }
            else            { f = b ^ c ^ d;                       k = 0xCA62C1D6u; }
            unsigned int t = ((a << 5) | (a >> 27)) + f + e + k + w[i];
            /* ⛔ 状态轮换顺序（SHA1 标准）：e←d, d←c, c←rotl30(b), b←a, a←t。
               写成 c=b / b=rotl30(b) 会产出看似合理却错误的摘要 —— 真机教训：
               只有用 RFC6455 附录 A 的已知向量实测过才能信。 */
            e = d; d = c; c = (b << 30) | (b >> 2); b = a; a = t;
        }
        h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
    }
    free(buf);
    unsigned int hs[5] = { h0, h1, h2, h3, h4 };
    for (int i = 0; i < 5; i++) {
        out[4 * i]     = (unsigned char)(hs[i] >> 24);
        out[4 * i + 1] = (unsigned char)(hs[i] >> 16);
        out[4 * i + 2] = (unsigned char)(hs[i] >> 8);
        out[4 * i + 3] = (unsigned char)(hs[i]);
    }
}

static void b64_encode(const unsigned char* in, int n, char* out)
{
    static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int i = 0, o = 0;
    while (i + 3 <= n) {
        unsigned int v = ((unsigned int)in[i] << 16) | ((unsigned int)in[i + 1] << 8) | in[i + 2];
        out[o++] = T[(v >> 18) & 63]; out[o++] = T[(v >> 12) & 63];
        out[o++] = T[(v >> 6) & 63];  out[o++] = T[v & 63];
        i += 3;
    }
    if (n - i == 1) {
        unsigned int v = (unsigned int)in[i] << 16;
        out[o++] = T[(v >> 18) & 63]; out[o++] = T[(v >> 12) & 63];
        out[o++] = '='; out[o++] = '=';
    } else if (n - i == 2) {
        unsigned int v = ((unsigned int)in[i] << 16) | ((unsigned int)in[i + 1] << 8);
        out[o++] = T[(v >> 18) & 63]; out[o++] = T[(v >> 12) & 63];
        out[o++] = T[(v >> 6) & 63];  out[o++] = '=';
    }
    out[o] = 0;
}

/* HTTP Upgrade 握手：读请求头 → Sec-WebSocket-Key + 固定 GUID → SHA1/b64 → 101。 */
static int ws_handshake(SOCKET s)
{
    char req[4096];
    int n = 0;
    while (n < (int)sizeof(req) - 1) {
        int r = recv(s, req + n, (int)sizeof(req) - 1 - n, 0);
        if (r <= 0) return -1;
        n += r;
        req[n] = 0;
        if (strstr(req, "\r\n\r\n")) break;
    }
    req[n] = 0;
    const char* k = strstr(req, "Sec-WebSocket-Key:");
    if (!k) k = strstr(req, "sec-websocket-key:");
    if (!k) return -1;
    k += strlen("Sec-WebSocket-Key:");
    while (*k == ' ') k++;
    int kl = 0;
    while (k[kl] && k[kl] != '\r' && k[kl] != '\n' && kl < 64) kl++;

    static const char* GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    char cat[128];
    if (kl <= 0 || kl + strlen(GUID) >= (int)sizeof(cat)) return -1;
    memcpy(cat, k, (size_t)kl);
    memcpy(cat + kl, GUID, strlen(GUID) + 1);

    unsigned char dg[20];
    sha1((const unsigned char*)cat, (int)(kl + strlen(GUID)), dg);
    char acc[40];
    b64_encode(dg, 20, acc);

    char rsp[256];
    int rn = _snprintf(rsp, sizeof(rsp),
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n", acc);
    return send_all(s, rsp, rn);
}

static int ws_send_text(SOCKET s, const char* msg)
{
    int len = (int)strlen(msg);
    unsigned char hdr[10];
    int hl = 0;
    hdr[hl++] = 0x81;                                  /* FIN + text */
    if (len < 126) hdr[hl++] = (unsigned char)len;
    else if (len < 65536) {
        hdr[hl++] = 126;
        hdr[hl++] = (unsigned char)(len >> 8); hdr[hl++] = (unsigned char)len;
    } else {
        hdr[hl++] = 127;
        for (int i = 7; i >= 0; i--) hdr[hl++] = (unsigned char)(((unsigned long long)len) >> (8 * i));
    }
    EnterCriticalSection(&g_sendLk);
    int ok = (send_all(s, (const char*)hdr, hl) == 0) && (send_all(s, msg, len) == 0);
    LeaveCriticalSection(&g_sendLk);
    return ok;
}

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
        if (!ws_send_text(s, msg)) {          /* 发送失败 ⇒ 强制断开，recv 线程负责回收 */
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
        if (json_bool(js, "speedAdaptive", &b)) g_pen.flags = b ? 1 : 0;
        int on = 0;
        json_bool(js, "on", &on);            /* 缺省 = false（Program.cs ReadBool 同款） */
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

static void acc_append(char** acc, size_t* n, size_t* cap, const char* p, int len)
{
    if (*n + (size_t)len + 1 > *cap) {
        size_t nc = (*cap ? *cap * 2 : 512) + (size_t)len + 1;
        char* np = (char*)realloc(*acc, nc);
        if (!np) return;
        *acc = np; *cap = nc;
    }
    memcpy(*acc + *n, p, (size_t)len);
    *n += (size_t)len;
}

static DWORD WINAPI client_thread(LPVOID param)
{
    SOCKET s = (SOCKET)(UINT_PTR)param;
    BOOL nd = TRUE;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&nd, sizeof(nd));

    if (ws_handshake(s) != 0) { closesocket(s); cli_remove(s); return 0; }
    log_line("srv", "面板已连接 ws");
    broadcast_smooth_state();     /* 建连即推一帧（Program.cs 建连推送同款） */

    char* acc = NULL; size_t accn = 0, accCap = 0;
    int closedByPeer = 0;                             /* 0=recv 错误 1=对端正常关 2=异常大帧 */
    for (;;) {
        unsigned char h2[2];
        if (recv_all(s, (char*)h2, 2) < 0) break;
        int fin = h2[0] & 0x80, op = h2[0] & 0x0F, masked = h2[1] & 0x80;
        unsigned long long len = h2[1] & 0x7F;
        if (len == 126) {
            unsigned char e[2];
            if (recv_all(s, (char*)e, 2) < 0) break;
            len = ((unsigned long long)e[0] << 8) | e[1];
        } else if (len == 127) {
            unsigned char e[8];
            if (recv_all(s, (char*)e, 8) < 0) break;
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | e[i];
        }
        if (len > 1024 * 1024) { closedByPeer = 2; break; }   /* 异常大帧 ⇒ 断开 */
        unsigned char mk[4] = { 0, 0, 0, 0 };
        if (masked && recv_all(s, (char*)mk, 4) < 0) break;
        char* pl = (char*)malloc((size_t)len + 1);
        if (!pl) break;
        if (len > 0 && recv_all(s, pl, (int)len) < 0) { free(pl); break; }
        if (masked)
            for (unsigned long long i = 0; i < len; i++) pl[i] ^= mk[i % 4];
        pl[len] = 0;

        if (op == 0x8) {                                  /* close */
            const char cl[2] = { (char)0x88, 0x00 };
            send_all(s, cl, 2);                           /* ⛔ 帧头必须 2 字节（旧版只发 1 字节=残帧） */
            closedByPeer = 1;
            free(pl);
            break;
        }
        if (op == 0x9) {                                  /* ping → pong */
            unsigned char hdr[10];
            int hl = 0;
            hdr[hl++] = 0x8A;
            if (len < 126) hdr[hl++] = (unsigned char)len;
            else { hdr[hl++] = 126; hdr[hl++] = (unsigned char)(len >> 8); hdr[hl++] = (unsigned char)len; }
            EnterCriticalSection(&g_sendLk);
            send_all(s, (const char*)hdr, hl);
            if (len > 0) send_all(s, pl, (int)len);
            LeaveCriticalSection(&g_sendLk);
            free(pl);
            continue;
        }
        if (op == 0xA) { free(pl); continue; }            /* pong */
        if (op == 0x1) acc_append(&acc, &accn, &accCap, pl, (int)len);
        else if (op == 0x0) acc_append(&acc, &accn, &accCap, pl, (int)len);
        free(pl);

        if (fin && acc && accn > 0 && (op == 0x1 || op == 0x0)) {
            if (accCap > accn) acc[accn] = 0;
            handle_message(acc);
            accn = 0;
        }
    }
    free(acc);
    closesocket(s);
    cli_remove(s);
    /* ⛔ 断连原因必须可见（2026-10-14 第七轮）：面板每 ~30-55s 被断一次，
       GATETS 断供 ⇒ 闸门 fail-closed ⇒ 「平滑时好时坏」。先落证据再定责：
       0 = recv 异常（err=10054 对端 RST / 10060 超时 / 10038 …），
       1 = 对端正常 close，2 = 异常大帧。 */
    log_line("srv", "面板已断开 reason=%s err=%d 本帧累计=%lu 字节",
             closedByPeer == 1 ? "对端close" : closedByPeer == 2 ? "异常大帧" : "recv错误",
             closedByPeer == 0 ? WSAGetLastError() : 0,
             (unsigned long)accn);
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
        if (cli_count() > 0) Wr(I_GATETS, (LONG)GetTickCount());
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
    InitializeCriticalSection(&g_sendLk);
    InitializeCriticalSection(&g_cliLk);
    for (int i = 0; i < MAX_CLI; i++) g_cliS[i] = INVALID_SOCKET;

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
    log_line("main", "M2 服务已启动 srv=%s pump=%s（引擎 worker 由 ATTACH 启动）",
             g_srvThread ? "ok" : "FAIL", g_pumpThread ? "ok" : "FAIL");
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
    /* 关掉所有客户端连接 */
    EnterCriticalSection(&g_cliLk);
    for (int i = 0; i < MAX_CLI; i++) {
        if (g_cliS[i] != INVALID_SOCKET) { closesocket(g_cliS[i]); g_cliS[i] = INVALID_SOCKET; }
    }
    LeaveCriticalSection(&g_cliLk);
    /* ⛔ 引擎不在这里卸载：cmd 通道已不可用；PS 退出时 DETACH 有 repatch 兜底，
       「Unload 后继续驻留」正是 .8li 形态的意义（面板重连即恢复）。 */
    log_line("main", "M2 服务已停止（引擎保持驻留，enabled=0 不改写）");
    if (g_cfg) Wr(I_ENABLED, 0);
}

/* ================================================================ M1 日志实现 */

static void log_line(const char* tag, const char* fmt, ...)
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
    if (_stricmp(caller, "SP Interface") == 0) {
        if (_stricmp(selector, "Startup") == 0)  { services_start(); return 0; }
        if (_stricmp(selector, "Shutdown") == 0) { services_stop();  return 0; }
    } else if (_stricmp(caller, "SP Access") == 0) {
        if (_stricmp(selector, "Reload") == 0)   { services_start(); return 0; }
        if (_stricmp(selector, "Unload") == 0)   { services_stop();  return 0; }
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
