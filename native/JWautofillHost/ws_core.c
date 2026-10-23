/* JWautofill .8li — WebSocket（RFC6455）共享原语实现（M3）
 * 从 plugin_main.c 原样搬移，行为逐字不变（SHA1 状态轮换顺序是踩过坑的，别改）。
 */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ws_core.h"

/* ================================================================ 裸收发 */

int wc_send_all(SOCKET s, const char* p, int n)
{
    int got = 0;
    while (got < n) {
        int r = send(s, p + got, n - got, 0);
        if (r <= 0) return -1;
        got += r;
    }
    return 0;
}

int wc_recv_all(SOCKET s, char* p, int n)
{
    int got = 0;
    while (got < n) {
        int r = recv(s, p + got, n - got, 0);
        if (r <= 0) return -1;
        got += r;
    }
    return got;
}

/* ================================================================ SHA1 + base64 */

void wc_sha1(const unsigned char* msg, int len, unsigned char out[20])
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

void wc_b64_encode(const unsigned char* in, int n, char* out)
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
        unsigned int v = ((unsigned int)in[i]) << 16;
        out[o++] = T[(v >> 18) & 63]; out[o++] = T[(v >> 12) & 63];
        out[o++] = '='; out[o++] = '=';
    } else if (n - i == 2) {
        unsigned int v = (((unsigned int)in[i]) << 16) | (((unsigned int)in[i + 1]) << 8);
        out[o++] = T[(v >> 18) & 63]; out[o++] = T[(v >> 12) & 63];
        out[o++] = T[(v >> 6) & 63];  out[o++] = '=';
    }
    out[o] = 0;
}

/* ================================================================ 握手 */

/* 握手实现体。path/pathSz 非空时顺手抽出请求行里的 path（0x0205 迁移探测身份识别用）。
   ⚠️ path 只作**身份识别**，不做路由——两个服务器都只认"/"为面板客户端。 */
static int wc_handshake_ex(SOCKET s, char* path, int pathSz)
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
    if (path && pathSz > 0) {
        path[0] = 0;
        const char* rl = strstr(req, "GET ");
        if (rl) {
            rl += 4;
            int i = 0;
            while (rl[i] && rl[i] != ' ' && rl[i] != '\r' && rl[i] != '\n' && i < pathSz - 1) {
                path[i] = rl[i];
                i++;
            }
            path[i] = 0;
        }
    }
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
    wc_sha1((const unsigned char*)cat, (int)(kl + strlen(GUID)), dg);
    char acc[40];
    wc_b64_encode(dg, 20, acc);

    char rsp[256];
    int rn = _snprintf(rsp, sizeof(rsp),
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n", acc);
    return wc_send_all(s, rsp, rn);
}

int wc_handshake(SOCKET s)
{
    return wc_handshake_ex(s, NULL, 0);
}

/* 0x0205：带 path 输出的服务端握手。热键服务器用它区分
   面板客户端（"/"）与迁移探测（"/jw-migrate"）——后者不是插件本体，
   不能算「插件在位」（否则多开 PS 时探测连接会给持有端伪造在位）。 */
int wc_handshake_path(SOCKET s, char* path, int pathSz)
{
    return wc_handshake_ex(s, path, pathSz);
}

/* 客户端侧随机 key：不追求密码学强度（服务端只回显 SHA1），只求每次不同。
   xorshift64 种子 = TickCount64 ^ pid ^ QPC。 */
static void wc_rand16(unsigned char out[16])
{
    unsigned long long x = GetTickCount64() ^ ((unsigned long long)GetCurrentProcessId() << 32);
    LARGE_INTEGER q;
    QueryPerformanceCounter(&q);
    x ^= (unsigned long long)q.QuadPart;
    if (x == 0) x = 0x9E3779B97F4A7C15ull;
    for (int i = 0; i < 16; i++) {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        out[i] = (unsigned char)(x >> 56);
    }
}

int wc_client_handshake(SOCKET s, int port, const char* path)
{
    unsigned char rnd[16];
    wc_rand16(rnd);
    char key[32];
    wc_b64_encode(rnd, 16, key);

    char req[512];
    int rn = _snprintf(req, sizeof(req),
        "GET %s HTTP/1.1\r\n"
        "Host: 127.0.0.1:%d\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n",
        path && *path ? path : "/", port, key);
    if (rn <= 0 || wc_send_all(s, req, rn) != 0) return -1;

    char rsp[1024];
    int n = 0;
    while (n < (int)sizeof(rsp) - 1) {
        int r = recv(s, rsp + n, (int)sizeof(rsp) - 1 - n, 0);
        if (r <= 0) return -1;
        n += r;
        rsp[n] = 0;
        if (strstr(rsp, "\r\n\r\n")) break;
    }
    if (!strstr(rsp, "101")) return -1;
    return 0;
}

/* ================================================================ 发送 */

static CRITICAL_SECTION g_wcLk;
static volatile LONG   g_wcLkInit = 0;   /* 0=未初始化 1=初始化中 2=就绪 */

void wc_lk_init(void)
{
    if (g_wcLkInit == 2) return;
    if (InterlockedCompareExchange(&g_wcLkInit, 1, 0) == 0) {
        InitializeCriticalSection(&g_wcLk);
        InterlockedExchange(&g_wcLkInit, 2);
    } else {
        while (g_wcLkInit != 2) Sleep(1);
    }
}

/* 帧头构造（FIN + 给定 opcode + 不掩码长度编码）。返回头长度。 */
static int wc_build_hdr(unsigned char* hdr, int op, unsigned long long len)
{
    int hl = 0;
    hdr[hl++] = (unsigned char)(0x80 | op);
    if (len < 126) hdr[hl++] = (unsigned char)len;
    else if (len < 65536) {
        hdr[hl++] = 126;
        hdr[hl++] = (unsigned char)(len >> 8); hdr[hl++] = (unsigned char)len;
    } else {
        hdr[hl++] = 127;
        for (int i = 7; i >= 0; i--) hdr[hl++] = (unsigned char)(((unsigned long long)len) >> (8 * i));
    }
    return hl;
}

static int wc_send_frame_lk(SOCKET s, int op, const char* p, unsigned long long len,
                            CRITICAL_SECTION* lk)
{
    unsigned char hdr[10];
    int hl = wc_build_hdr(hdr, op, len);
    int ok;
    if (lk) EnterCriticalSection(lk);
    else   wc_lk_init(), EnterCriticalSection(&g_wcLk);
    ok = (wc_send_all(s, (const char*)hdr, hl) == 0) &&
         (len == 0 || wc_send_all(s, p, (int)len) == 0);
    if (lk) LeaveCriticalSection(lk);
    else   LeaveCriticalSection(&g_wcLk);
    return ok;
}

int wc_send_text_lk(SOCKET s, const char* msg, CRITICAL_SECTION* lk)
{
    return wc_send_frame_lk(s, 0x1, msg, (unsigned long long)strlen(msg), lk);
}

int wc_send_text(SOCKET s, const char* msg)
{
    return wc_send_text_lk(s, msg, NULL);
}

int wc_send_masked(SOCKET s, const char* msg)
{
    /* RFC6455：客户端→服务端帧必掩码 */
    unsigned long long len = (unsigned long long)strlen(msg);
    unsigned char mk[4];
    wc_rand16(mk);
    unsigned char hdr[14];
    int hl = 0;
    hdr[hl++] = 0x81;
    if (len < 126) hdr[hl++] = (unsigned char)(0x80 | (int)len);
    else if (len < 65536) {
        hdr[hl++] = (unsigned char)(0x80 | 126);
        hdr[hl++] = (unsigned char)(len >> 8); hdr[hl++] = (unsigned char)len;
    } else {
        hdr[hl++] = (unsigned char)(0x80 | 127);
        for (int i = 7; i >= 0; i--) hdr[hl++] = (unsigned char)(((unsigned long long)len) >> (8 * i));
    }
    for (int i = 0; i < 4; i++) hdr[hl++] = mk[i];
    if (wc_send_all(s, (const char*)hdr, hl) != 0) return 0;

    char stackbuf[1024];
    char* buf = stackbuf;
    if (len + 1 > sizeof(stackbuf)) {
        buf = (char*)malloc((size_t)len + 1);
        if (!buf) return 0;
    }
    memcpy(buf, msg, (size_t)len);
    for (unsigned long long i = 0; i < len; i++) buf[i] ^= mk[i % 4];
    int ok = (wc_send_all(s, buf, (int)len) == 0);
    if (buf != stackbuf) free(buf);
    return ok;
}

/* ================================================================ 帧读取 */

int wc_read_frame(SOCKET s, char* buf, int cap, int* op, int* fin)
{
    unsigned char h2[2];
    if (wc_recv_all(s, (char*)h2, 2) < 0) return -1;
    *fin = (h2[0] & 0x80) ? 1 : 0;
    *op  = h2[0] & 0x0F;
    int masked = h2[1] & 0x80;
    unsigned long long len = h2[1] & 0x7F;
    if (len == 126) {
        unsigned char e[2];
        if (wc_recv_all(s, (char*)e, 2) < 0) return -1;
        len = ((unsigned long long)e[0] << 8) | e[1];
    } else if (len == 127) {
        unsigned char e[8];
        if (wc_recv_all(s, (char*)e, 8) < 0) return -1;
        len = 0;
        for (int i = 0; i < 8; i++) len = (len << 8) | e[i];
    }
    if (len > 1024ull * 1024ull) return -3;               /* 异常大帧 ⇒ 断开 */
    unsigned char mk[4] = { 0, 0, 0, 0 };
    if (masked && wc_recv_all(s, (char*)mk, 4) < 0) return -1;
    if (len > (unsigned long long)(cap > 0 ? cap - 1 : 0)) return -3;  /* 缓冲区不够 */
    if (len > 0 && wc_recv_all(s, buf, (int)len) < 0) return -1;
    if (masked)
        for (unsigned long long i = 0; i < len; i++) buf[i] ^= mk[i % 4];
    buf[len] = 0;
    return (int)len;
}

/* ================================================================ 会话循环 */

static int wc_acc_append(char** acc, size_t* n, size_t* cap, const char* p, int len)
{
    if (*n + (size_t)len + 1 > *cap) {
        size_t nc = (*cap ? *cap * 2 : 512) + (size_t)len + 1;
        char* np = (char*)realloc(*acc, nc);
        if (!np) return -1;
        *acc = np; *cap = nc;
    }
    memcpy(*acc + *n, p, (size_t)len);
    *n += (size_t)len;
    return 0;
}

#define WC_MAX_ACC (1024 * 1024)

int wc_client_loop(SOCKET s, CRITICAL_SECTION* lk, wc_on_text on_text, void* ctx,
                   int* closedBy)
{
    BOOL nd = TRUE;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&nd, sizeof(nd));
    DWORD rcvTo = 60000, sndTo = 2000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&rcvTo, sizeof(rcvTo));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&sndTo, sizeof(sndTo));

    /* 单帧缓冲：面板最大单帧是 config 整包（数十条目 ≈ 数 KB），64KB 足够；
       真超出按「异常大帧」断开（与旧版 1MB 上限相比更严，但 64KB 以上的
       单帧在本协议里不存在 —— 旧版的 1MB 判据本是防畸形帧，不是容泄露大）。 */
    int cap = 64 * 1024;
    char* buf = (char*)malloc((size_t)cap);
    if (!buf) { *closedBy = 2; return -1; }

    char* acc = NULL; size_t accn = 0, accCap = 0;
    if (closedBy) *closedBy = 0;
    for (;;) {
        int op = 0, fin = 0;
        int n = wc_read_frame(s, buf, cap, &op, &fin);
        if (n == -3) { if (closedBy) *closedBy = 2; break; }   /* 异常大帧 ⇒ 断开 */
        if (n < 0)   { if (closedBy) *closedBy = 0; break; }   /* recv 错误 */

        if (op == 0x8) {                                        /* close */
            unsigned char cl[2] = { 0x88, 0x00 };               /* ⛔ 帧头必须 2 字节 */
            if (lk) EnterCriticalSection(lk);
            else   wc_lk_init(), EnterCriticalSection(&g_wcLk);
            wc_send_all(s, (const char*)cl, 2);
            if (lk) LeaveCriticalSection(lk);
            else   LeaveCriticalSection(&g_wcLk);
            if (closedBy) *closedBy = 1;
            break;
        }
        if (op == 0x9) {                                        /* ping → pong */
            wc_send_frame_lk(s, 0xA, buf, (unsigned long long)n, lk);
            continue;
        }
        if (op == 0xA) continue;                                /* pong */

        if (op == 0x1 || op == 0x0) {
            if (wc_acc_append(&acc, &accn, &accCap, buf, n) != 0 ||
                accn > WC_MAX_ACC) {
                if (closedBy) *closedBy = 2;
                break;
            }
            if (fin && acc && accn > 0) {
                if (accCap > accn) acc[accn] = 0;
                if (on_text) on_text(ctx, acc);
                accn = 0;
            }
        }
        /* 其它 opcode（0x2 二进制等）忽略 */
    }
    free(acc);
    free(buf);
    return 0;
}
