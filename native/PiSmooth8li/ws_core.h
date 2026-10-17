/* JWautofill .8li — WebSocket（RFC6455）共享原语（M3 抽取）
 *
 * 从 plugin_main.c 原样搬移（sha1/b64/send_all/recv_all/ws_handshake），
 * 并补齐两个消费方都要用的件：
 *   · wc_read_frame —— 帧读取器（服务端侧；客户端帧必掩码，自动解掩码）
 *   · wc_client_loop —— 客户端会话循环（ping→pong / close→回关 / 分片累积），
 *     平滑（18924）与热键（18923）两个服务器共用，行为逐字一致
 *   · wc_send_masked / wc_client_handshake —— .8li 作为 WS **客户端**用
 *     （旧版 HotkeyDaemon 迁移探测：发 getState / uninstall）
 *
 * ⛔ 帧头铁律：close 帧必须 2 字节（{0x88,0x00}），旧版只发 1 字节 = 残帧。
 * ⛔ 锁纪律：所有对同一 socket 的发送必须串行（否则两线程各写半帧 ⇒ 坏帧）。
 *     wc_send_text 用内置默认锁；调用方自带锁的用 wc_send_text_lk 传入
 *     （两个服务器各持自己的锁，互不阻塞）。
 */
#ifndef WS_CORE_H
#define WS_CORE_H

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 裸 socket 收发（不持锁；调用方负责串行化） */
int  wc_send_all(SOCKET s, const char* p, int n);
int  wc_recv_all(SOCKET s, char* p, int n);

/* 握手 challenge 应答用（输入 ≤ 几百字节） */
void wc_sha1(const unsigned char* msg, int len, unsigned char out[20]);
void wc_b64_encode(const unsigned char* in, int n, char* out);

/* 服务端：读 HTTP Upgrade 请求 → Sec-WebSocket-Key + GUID → SHA1/b64 → 101 */
int  wc_handshake(SOCKET s);
/* 客户端：发 Upgrade 请求（带随机 Sec-WebSocket-Key）→ 等 101 */
int  wc_client_handshake(SOCKET s, int port, const char* path);

/* 服务端→客户端帧（不掩码）。lk 传 NULL 用内置默认锁。 */
int  wc_send_text(SOCKET s, const char* msg);
int  wc_send_text_lk(SOCKET s, const char* msg, CRITICAL_SECTION* lk);
/* 客户端→服务端帧（必掩码，RFC6455） */
int  wc_send_masked(SOCKET s, const char* msg);

/* 读一个完整帧。返回 payload 长度（≥0）；-1 = 错误/断开，-2 = 对端 close，
   -3 = 异常大帧（>1MB 或超出 buf）。op/fin 输出 opcode 与 FIN。
   ⛔ ping(0x9)/pong(0xA)/close(0x8) 原样返回 opcode，由调用方处置。 */
int  wc_read_frame(SOCKET s, char* buf, int cap, int* op, int* fin);

/* 客户端会话循环（两个 WS 服务器共用）：
   设 TCP_NODELAY + RCVTIMEO 60s + SNDTIMEO 2s；
   ping→pong、close→回 2 字节关帧、分片累积，完整文本帧交 on_text。
   closedBy：0=recv 错误 1=对端 close 2=异常大帧。
   ⛔ 发送一律走 lk（传 NULL 用内置默认锁）——广播与单发必须同锁。 */
typedef void (*wc_on_text)(void* ctx, const char* text);
int  wc_client_loop(SOCKET s, CRITICAL_SECTION* lk, wc_on_text on_text, void* ctx,
                    int* closedBy);

/* 内置默认锁的一次性初始化（services_start / keyhook_start 主动调；懒初始化兜底） */
void wc_lk_init(void);

#ifdef __cplusplus
}
#endif

#endif /* WS_CORE_H */
