#!/usr/bin/env bash
# JWautofill Smooth .8li 构建脚本（M2：引擎 + WS 协议层合并镜像）
#
# 链路: zig cc 编译(plugin_main.c + smooth_engine.c) → gen_pipl.py 生成 PiPL
#       → embed_res.py 注入 'PIPL' 资源
# 产物: build/JWautofillSmooth.8li（拷入 PS 的 Plug-ins 目录即生效，需重启 PS；
#       ⛔ PS 运行时锁文件 ⇒ 覆盖部署前必须先完全退出 PS）
#
# ⛔ zig 编译须在沙箱外执行（子编译进程读标准库会被沙箱拦，见 refs/toolchain-and-env.md §5）
set -euo pipefail
cd "$(dirname "$0")"

ZIG="${ZIG_HOME:-$USERPROFILE/zig-toolchain}/zig.exe"
PY=python

"$ZIG" cc -target x86_64-windows-gnu -shared -O2 \
    -Wall -Wextra \
    -lws2_32 -lgdi32 -luser32 \
    -o build/JWautofillSmooth.dll plugin_main.c smooth_engine.c

$PY tools/gen_pipl.py build/pipl.bin "JWautofill Smooth" "AutoPluginMain"
$PY tools/embed_res.py build/JWautofillSmooth.dll build/pipl.bin build/JWautofillSmooth.8li

# 自验：资源树里应出现 'PIPL'；导出表里应有 AutoPluginMain
$PY tools/pe_res_extract.py build/JWautofillSmooth.8li --type PIPL --out build/roundtrip_pipl.bin
cmp build/pipl.bin build/roundtrip_pipl.bin && echo "✅ PiPL 往返校验一致"
