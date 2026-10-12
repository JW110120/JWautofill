#!/usr/bin/env bash
# 安装便携 zig 工具链 —— 写「注入 DLL」所需的原生编译器。
#
# 为什么需要它：本机没有任何原生编译器（无 MSVC / Windows Kits / gcc / clang），
# 连 .NET 的 NativeAOT 也要 MSVC 的 link.exe。要 inline-hook Photoshop 里的
# Wintab32（见 docs/lasso-realtime-smoothing-plan.md §12），必须自带工具链。
# zig cc 自带 clang + lld + mingw-w64 头文件，解压即用，不写系统目录、不需管理员。
#
# 用法：  bash native/get-zig.sh          # 装到 %USERPROFILE%\zig-toolchain
#         ZIG_HOME=D:/zig bash native/get-zig.sh
#
# ⛔ 两个真机踩过的坑，别改：
#   ① 从 ziglang.org 直下约 18KB/s（100MB 要一个半小时）；PyPI 官方维护的 ziglang
#      包走清华镜像约 2.8MB/s（约 35 秒）。因此走 PyPI。
#   ② 必须解压到**短且绝对**的路径。zig 由 exe 所在位置推导 lib_dir；放在过深或
#      含非 ASCII 的路径下会推成**相对路径**，其内部子编译换 cwd 后解析失败，报
#      "unable to load 'std.zig': AccessDenied"（看起来像权限/杀软问题，其实是路径问题）。
set -euo pipefail

VER="0.16.0"
DEST="${ZIG_HOME:-$USERPROFILE/zig-toolchain}"
WHL="$DEST/.cache/ziglang-${VER}-py3-none-win_amd64.whl"
URL="https://pypi.tuna.tsinghua.edu.cn/packages/a6/3c/baff40b3fc8ab4e83530246a52e8f3a5186c3606562712dfb58483b04f79/ziglang-${VER}-py3-none-win_amd64.whl"

mkdir -p "$DEST/.cache"

if [ -x "$DEST/zig.exe" ] && "$DEST/zig.exe" version >/dev/null 2>&1; then
  echo "已存在：$("$DEST/zig.exe" version)  ($DEST)"
  exit 0
fi

echo ">>> 下载 ziglang ${VER} wheel（约 99MB，清华镜像）"
curl -L --progress-bar --max-time 900 -o "$WHL" "$URL"

echo ">>> 解压到 $DEST"
python - "$WHL" "$DEST" <<'PY'
import sys, zipfile, pathlib, shutil
whl, dest = sys.argv[1], pathlib.Path(sys.argv[2])
with zipfile.ZipFile(whl) as z:
    for n in z.namelist():
        if not n.startswith('ziglang/'):
            continue
        rel = n[len('ziglang/'):]
        if not rel:
            continue
        target = dest / rel
        if n.endswith('/'):
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(n) as src, open(target, 'wb') as out:
                shutil.copyfileobj(src, out)
print('解压完成')
PY

echo ">>> 校验"
"$DEST/zig.exe" version
echo
echo "工具链就绪： $DEST/zig.exe"
echo "编译 DLL：   \"$DEST/zig.exe\" cc -target x86_64-windows-gnu -shared -O2 -o out.dll src.c"
