/* JWautofill .8li 跨 .c 共享声明（M3：keyhook.c 加入后的去 static 面）
 *
 * 背景：键盘钩子子系统（keyhook.c）与平滑协议层（plugin_main.c）编进同一个
 * .8li 镜像，双方都要用日志 / 极简 JSON / DLL 实例句柄。这些原语原本是
 * plugin_main.c 的 static 成员，链接期对其它 .c 不可见 —— 做成 static 就是
 * 「链接期隐式失配」（要么重复定义、要么各写一份迟早不同步）。
 * ⛔ 只放**真的跨文件共享**的成员；clampi/roundi 这类一行函数各文件自持，
 *    避免通用名污染全局命名空间。
 */
#ifndef JW_SHARED_H
#define JW_SHARED_H

#include <windows.h>

/* M1 日志（plugin_main.c 实现，写 %LOCALAPPDATA%\JWautofill\smooth8li\pi8li.log）。
   ⛔ 铁律：键盘钩子回调路径上**绝不**直接调它（文件 I/O 会冻结系统输入），
      钩子侧只入内存环、由非钩子线程代打（keyhook.c 的 kh_hlog 同款纪律）。 */
void log_line(const char* tag, const char* fmt, ...);

/* 日志目录（带尾部反斜杠）；失败返回 ""。smooth_engine.c 的 wtctx_read_ini 也用。 */
const char* jw_log_dir(void);

/* 极简 JSON 定位助手（面板消息是扁平对象，手写定位足够）。
   缺字段 = 调用方保持原值（Program.cs 可空字段合并的同款语义）。 */
const char* json_find(const char* js, const char* key);
int  json_num(const char* js, const char* key, double* out);
int  json_bool(const char* js, const char* key, int* out);
int  json_str(const char* js, const char* key, char* out, int cap);

/* 本 DLL 实例句柄（DllMain ATTACH 时写；SetWindowsHookExW 的 hMod 用它）。 */
extern HINSTANCE g_hSelf;

#endif /* JW_SHARED_H */
