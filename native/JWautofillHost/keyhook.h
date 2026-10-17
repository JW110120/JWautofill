/* JWautofill .8li — 键盘钩子/热键子系统（keyhook.c）
 *
 * WS 18923（协议与旧版 HotkeyDaemon 逐字对齐：面板 HotkeyBridge.ts 的契约）。
 * ⛔ 单持有者纪律：只有 bind 18923 成功的 .8li 实例才装 WH_KEYBOARD_LL；
 *    前台 PID ∈ photoshop 进程集合时才处理按键（toolhelp 枚举，3s 刷新）。
 * ⛔ 钩子回调铁律：O(1)、无锁（除引用快照）、无文件 I/O、不抛异常 ——
 *    网络写入队 + 调度线程代发；日志入内存环 + 代打。
 */
#ifndef KEYHOOK_H
#define KEYHOOK_H

/* 启动（幂等）：建锁/环 → 钩子线程（自带消息队列）→ 看护/调度/WS 服务器线程
   → 启动即装载热键表 + 默认布防。由 plugin_main.c 的 services_start 调用。 */
void keyhook_start(void);

/* 停止（幂等）：撤防 + 卸钩子 + 关监听 + 逐线程 join。
   ⛔ 不退出宿主进程（.8li 与 PS 共命运）。 */
void keyhook_stop(void);

/* 启动是否成功（1/0）。⛔ 供 services_start 的日志自检 —— 不许写"假成功"。 */
int keyhook_started(void);

#endif /* KEYHOOK_H */
