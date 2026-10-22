#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把笔尖图拼成「混合器载入用」的方形图案（RGB + 透明底）。

── 为什么需要这一步 ────────────────────────────────────────────────
PS 的混合器笔刷「载入」是把**一块画布区域**吸进储层，所以吸之前画布上必须站着一张
尺寸与笔刷一致的方形图。用户实测（2026-10-22）：

  · 250×250 图案 + 250×250 方形笔刷 + 在正中间(50%,50%)吸一下
    ⇒ 图案严丝合缝地进到笔里，笔尖形状 = 图案的形状（方形内接的那块）。

  · 图案必须是 **RGB 模式**：灰度文档没有「通道混合器」，捡不起来颜色。

  · 图案的**白色必须改成透明底**：混合器会把整块 400×400 都当真，
    白底会在黑背景上画出一个白方块（用户截图实证）。

── 这个脚本产出什么 ────────────────────────────────────────────────
  输入  PAT-<id>.png   形状/亮度图（黑底、亮=有料）
  输出  MIX-<id>.png   边长 SIDE 的正方形 RGBA，笔尖居中，白→透明

  通道分工（关键）：
    A（透明度） = 形状覆盖   —— 决定「笔尖轮廓」，直接来自 PAT 的亮度归一化
    R=G=B       = 立体亮度   —— 决定「这一笔有多亮」，之后由通道混合器上色

  这样「轮廓」和「明暗」是两条独立的通道，上色时只动 RGB、不动 alpha
  ⇒ 换前景色不会改变笔尖形状。这正是 Krita 印章笔的通道结构。

用法:
  python scripts/build_mixer_pattern.py --id impasto-detail
  python scripts/build_mixer_pattern.py --id impasto-detail --side 512 --alpha-gamma 0.75
"""
from __future__ import annotations

import argparse
import os
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit('需要 Pillow：用 C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe 跑')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRUSH_ROOT = os.path.join(ROOT, 'dist', 'brushes')


def load_luma(path: str) -> Image.Image:
    """读成 L（8 位灰度）。黑底 = 背景，越亮越"有料"。"""
    return Image.open(path).convert('L')


def normalize(im: Image.Image) -> Image.Image:
    """
    线性拉伸到 0..255。

    ⛔ 必须拉伸：我们的 PAT 最亮只有 ~112（见 2026-10-22 实测），
       直接当 alpha 用的话整个笔尖最浓处也只有 44% 不透明，
       叠出来的浮雕会像"雾里看花"，而且通道混合器上色后依旧发灰。
    """
    lo, hi = im.getextrema()
    if hi <= lo:
        return im
    scale = 255.0 / (hi - lo)
    return im.point(lambda v: max(0, min(255, int(round((v - lo) * scale)))))


def apply_gamma(im: Image.Image, gamma: float) -> Image.Image:
    """
    只给 alpha 用的 gamma。

    1.0 = 线性；<1 整体变浓（笔尖更实）；>1 更淡。
    形状（alpha）与明暗（RGB）分开调，是因为"轮廓要实、明暗要软"这两件事的期望曲线不同。
    """
    if abs(gamma - 1.0) < 1e-6:
        return im
    lut = [max(0, min(255, int(round(255.0 * (i / 255.0) ** gamma)))) for i in range(256)]
    return im.point(lut)


def cover_mask(im: Image.Image, floor: float, ceil: float) -> Image.Image:
    """
    从亮度里提取"**覆盖度**"，而不是把亮度本身当透明度。

    ⛔⛔ 这是 2026-10-22 第一次生成的教训：直接把亮度当 alpha 会得到
       "沟槽里半透明 + 颜色又被乘暗" ⇒ 叠在深底上就是一坨暗红泥（预览已复现）。
       颜料是**不透明**的 —— 有料的地方 alpha 就该是 1，明暗只走 RGB 通道。
       ⇒ floor..ceil 之间做线性斜坡：低于 floor 全透（笔丝间隙），高于 ceil 全实。
    """
    lo, hi = im.getextrema()
    if hi <= lo:
        return im
    a = max(1e-6, (ceil - floor) * 255.0)
    lut = []
    for i in range(256):
        t = (i - floor * 255.0) / a
        lut.append(max(0, min(255, int(round(t * 255)))))
    return im.point(lut)


def build(brush_id: str, side: int, alpha_gamma: float, rgb_gamma: float,
          cover_floor: float, cover_ceil: float, out_name: str) -> str:
    folder = os.path.join(BRUSH_ROOT, brush_id)
    pat_path = os.path.join(folder, f'PAT-{brush_id}.png')
    if not os.path.exists(pat_path):
        sys.exit(f'找不到 {pat_path}')

    pat = normalize(load_luma(pat_path))
    w, h = pat.size
    if w > side or h > side:
        sys.exit(f'笔尖 {w}x{h} 比方形 {side} 还大，先改 --side')

    # 明暗与形状**同源但曲线不同**：
    #   明暗（RGB）— 抬中间调。我们的 PAT 中位亮度只有 85/255，直接上色会黑成一片；
    #                0.6 的 gamma 把中位抬到 ~132，配上高光 255，才像"有厚度的颜料"。
    #   形状（alpha）— 0.85，让轮廓比明暗更实一点，笔丝边缘不至于虚掉。
    # ⚠️ 二者同源是刻意的：这张图本身就是浮雕，明暗就该跟着形状走。
    #    将来若要"轮廓宽、明暗窄"，给 alpha 单独喂 SHD-<id>.png 即可。
    luma = apply_gamma(pat, rgb_gamma)
    alpha = cover_mask(pat, cover_floor, cover_ceil)
    alpha = apply_gamma(alpha, alpha_gamma)

    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(Image.merge('RGB', (luma, luma, luma)), ((side - w) // 2, (side - h) // 2), alpha)

    # ⛔ 400×400 的边角必须**完全透明**：混合器会把整块方形都当真，
    #    留一点白边就会在画面上拖出一个方框（用户 2026-10-22 截图实证）。
    px = canvas.load()
    for x, y in ((0, 0), (side - 1, 0), (0, side - 1), (side - 1, side - 1)):
        if px[x, y][3] != 0:
            sys.exit(f'边角不透明：({x},{y}) alpha={px[x, y][3]}')

    out = os.path.join(folder, out_name)
    canvas.save(out)
    print(f'✅ {out}  {side}x{side}  笔尖 {w}x{h} 居中偏移 x={(side - w) // 2} y={(side - h) // 2}')
    print(f'   采样点 = 画布正中 ({side // 2}, {side // 2})；笔刷尺寸 = {side}px 方形')
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--id', required=True, help='笔 id，如 impasto-detail')
    ap.add_argument('--side', type=int, default=400, help='方形边长（默认 400 = 笔尖高度）')
    ap.add_argument('--alpha-gamma', type=float, default=0.85, help='形状透明度 gamma，<1 更浓')
    ap.add_argument('--rgb-gamma', type=float, default=0.6, help='明暗 gamma，<1 抬中间调（默认 0.6）')
    ap.add_argument('--cover-floor', type=float, default=0.04, help='低于此亮度算全透明（0..1）')
    ap.add_argument('--cover-ceil', type=float, default=0.30, help='高于此亮度算全覆盖（0..1）')
    ap.add_argument('--out', default='', help='输出文件名，默认 MIX-<id>.png')
    a = ap.parse_args()
    build(a.id, a.side, a.alpha_gamma, a.rgb_gamma, a.cover_floor, a.cover_ceil,
          a.out or f'MIX-{a.id}.png')


if __name__ == '__main__':
    main()
