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

/* —— 0x012D：笔尖 → 鼠标左键 的**事件**镜像 ——
   平滑引擎在「驱动停投递」的窗口里拿不到任何真包，连「笔按没按着」都不知道；
   而笔尖在 Windows 层面就是一对 LBUTTON 消息 ⇒ 用 WH_MOUSE_LL 抓**事件**
   （⛔ 不是 GetAsyncKeyState 的**电平**：0x012B/6468 已证电平会漂、会漏短按）。
   返回值：1 = 本会话内确实见过 LBUTTON 事件（通路可用）；0 = 该通路完全无数据
   （调用方必须退回旧行为，**不得**把 0 当成「笔抬着」）。
   出参：*down=最近一次消息的按下态；*x 与 *y=该消息的屏幕坐标；
        *t=该消息时刻(GetTickCount)；*dn 与 *up=累计按下/抬起次数。 */
int keyhook_mouse_state(int* down, int* x, int* y, unsigned long* t, int* dn, int* up);

#endif /* KEYHOOK_H */
