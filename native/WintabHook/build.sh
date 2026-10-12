#!/usr/bin/env bash
# ============================================================================
# 构建「笔输入层平滑」的注入 DLL（P3）。
#
# ⛔ 用**便携 zig**（见 native/get-zig.sh）—— 本机没有任何原生编译器（无 MSVC / Windows Kits）。
# ⛔ zig 必须装在**短路径** `$USERPROFILE/zig-toolchain`：zig 由自身 exe 位置推导 lib_dir，
#    路径一深就退化成相对路径，子编译换 cwd 后报 `unable to load 'std.zig': AccessDenied`
#    （看着像杀软，其实是路径问题）。
#
# 产物：publish/JWautofillWintabHook.dll（x64）
#       依赖：KERNEL32 + UCRT + GDI32 + USER32（P3.1 起多了 HUD 自绘，必须显式链）
#       —— 必须入库：守护进程运行时要把它注入 Photoshop，用户机器没有 zig。
# 用法： bash native/WintabHook/build.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

ZIG="${ZIG:-$USERPROFILE/zig-toolchain/zig.exe}"
if [ ! -x "$ZIG" ]; then
    # Git Bash 下 $USERPROFILE 可能未被展开成 Windows 路径，退一步用 HOME 拼
    ZIG="$HOME/zig-toolchain/zig.exe"
fi
if [ ! -x "$ZIG" ]; then
    echo "找不到 zig：$ZIG"
    echo "先执行： bash native/get-zig.sh"
    exit 1
fi

mkdir -p publish
# ⚠️ -lgdi32 -luser32：WIN32_LEAN_AND_MEAN 下 zig 不会自动链 GDI/USER，
#    HUD 建窗 + 自绘必须要（少了就是一堆 undefined symbol CreateDIBSection）。
"$ZIG" cc -target x86_64-windows-gnu -shared -O2 \
    -lgdi32 -luser32 \
    -o publish/JWautofillWintabHook.dll wintab_hook.c

# zig 会顺带产出 .lib/.pdb，均不需要（.pdb 已被 .gitignore 覆盖，.lib 一并清掉）
# ⚠️ .lib 名跟**源文件名**（wintab_hook.lib）走，不跟 -o 输出名 ⇒ 用通配清。
rm -f publish/*.lib publish/*.pdb

ls -la publish/JWautofillWintabHook.dll
