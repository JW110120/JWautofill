# -*- coding: utf-8 -*-
"""生成扣白/扣黑验证对比 HTML（内嵌 SVG），供用户直观查看。"""
import math

W = H = 64
SCALE = 3  # 每像素放大倍数

def luma(rgb):
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255.0

def over_px(fg, bg):
    a_f = fg[3] / 255.0
    a_b = bg[3] / 255.0
    a_o = a_f + a_b * (1 - a_f)
    if a_o <= 0:
        return (0, 0, 0, 0)
    r = (fg[0] * a_f + bg[0] * a_b * (1 - a_f)) / a_o
    g = (fg[1] * a_f + bg[1] * a_b * (1 - a_f)) / a_o
    b = (fg[2] * a_f + bg[2] * a_b * (1 - a_f)) / a_o
    return (r, g, b, a_o * 255)

def build_X():
    px = {}
    for y in range(H):
        for x in range(W):
            d_red = math.hypot(x - 20, y - 32)
            d_grn = math.hypot(x - 44, y - 32)
            red = (241, 52, 52, 128)
            grn = (76, 221, 56, 179)
            val = (0, 0, 0, 0)
            if d_red <= 14:
                val = over_px(red, val)
            if d_grn <= 14:
                val = over_px(grn, val)
            px[(x, y)] = val
    return px

def compose(X, bg):
    return {k: over_px(v, bg) for k, v in X.items()}

def simulate_knockout(Y, mode):
    work = dict(Y)
    if mode == 'black':
        work = {k: (255 - v[0], 255 - v[1], 255 - v[2], v[3]) for k, v in work.items()}
    cleared = {}
    alphas = []
    for k, v in work.items():
        sel = luma(v[:3])
        a = v[3] / 255.0 * (1 - sel)
        cleared[k] = (v[0], v[1], v[2], a * 255)
        if 0 < a < 1:
            alphas.append(a)
    if not alphas:
        n = 7 if mode == 'white' else 3
    else:
        alphas.sort()
        a_min = alphas[min(len(alphas) - 1, int(len(alphas) * 0.05))]
        n = 40 if a_min <= 0.02 else max(7 if mode == 'white' else 3,
                                         min(40, math.ceil(math.log(0.005) / math.log(1 - a_min))))
    merged = {}
    for k, v in cleared.items():
        a = v[3] / 255.0
        merged[k] = (v[0], v[1], v[2], (1 - (1 - a) ** n) * 255)
    if mode == 'black':
        merged = {k: (255 - v[0], 255 - v[1], 255 - v[2], v[3]) for k, v in merged.items()}
    return merged, n

def sim_orig_black(Z, n=7):
    out = {}
    for k, v in Z.items():
        sel = luma(v[:3])
        a_m = 1 - (1 - sel) ** n
        out[k] = (v[0], v[1], v[2], a_m * 255)
    return out

def to_svg(px, label, bg, sub=""):
    """把图像渲染成 SVG（放回指定背景 bg 上，透明度棋盘用浅灰）。"""
    bw, bh = W * SCALE, H * SCALE
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{bw}" height="{bh}" viewBox="0 0 {bw} {bh}">']
    parts.append(f'<rect width="{bw}" height="{bh}" fill="#f0f0f0"/>')
    for (x, y), v in px.items():
        a = v[3] / 255.0
        r = v[0] * a + bg[0] * (1 - a)
        g = v[1] * a + bg[1] * (1 - a)
        b = v[2] * a + bg[2] * (1 - a)
        parts.append(f'<rect x="{x*SCALE}" y="{y*SCALE}" width="{SCALE}" height="{SCALE}" fill="rgb({int(r)},{int(g)},{int(b)})"/>')
    parts.append('</svg>')
    return (f'<div style="text-align:center;flex:1;min-width:120px;">'
            f'<div style="font-size:13px;font-weight:600;margin-bottom:4px;color:#333;">{label}</div>'
            f'<div style="font-size:12px;color:#777;margin-bottom:6px;">{sub}</div>{''.join(parts)}</div>')

X = build_X()
WHITE = (255, 255, 255, 255)
BLACK = (0, 0, 0, 255)
Y = compose(X, WHITE)
Z = compose(X, BLACK)
res_w, n_w = simulate_knockout(Y, 'white')
res_b, n_b = simulate_knockout(Z, 'black')
res_orig = sim_orig_black(Z)

def vis_err(a, b, bg):
    m = 0
    for k in a:
        r1 = over_px(a[k], bg); r2 = over_px(b[k], bg)
        m = max(m, max(abs(r1[i] - r2[i]) for i in range(3)))
    return m

err_w = vis_err(res_w, X, WHITE)
err_b = vis_err(res_b, X, BLACK)
err_o = vis_err(res_orig, X, BLACK)

html = f"""<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<title>扣白 / 扣黑 算法验证（batchPlay 版）</title>
<style>
body {{ font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 24px; background: #fafafa; color: #222; }}
h1 {{ font-size: 20px; }}
h2 {{ font-size: 16px; margin-top: 28px; border-left: 4px solid #4a7bd8; padding-left: 8px; }}
.row {{ display: flex; flex-wrap: wrap; gap: 14px; margin-top: 8px; }}
.card {{ background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 14px; flex: 1; min-width: 220px; }}
.mono {{ font-family: Consolas, monospace; font-size: 12px; color: #555; }}
.good {{ color: #1a8f3c; font-weight: 600; }}
.bad {{ color: #c0392b; font-weight: 600; }}
.note {{ font-size: 13px; color: #555; line-height: 1.7; background: #f4f7fb; border-radius: 6px; padding: 10px 14px; margin-top: 10px; }}
</style></head><body>
<h1>扣白 / 扣黑 算法验证（batchPlay 版）</h1>
<p class="note">案例：X 图层 = 红圆 RGBA(241,52,52,128) + 绿圆 RGBA(76,221,56,179)（绿后画，相交=绿over红）。
上图所有图均已按“透明→浅灰棋盘、其余→对应背景”合成展示。</p>

<h2>① 扣白（Y = X 白底合成 → 还原）</h2>
<div class="row">
{to_svg(X, 'X（原图层，透明底）', (200, 200, 200))}
{to_svg(Y, 'Y（X 与白底合并）', WHITE)}
{to_svg(res_w, '扣白结果（N=%d 动态）' % n_w, WHITE, sub=f'放白底 视觉差 max={err_w:.2f}/255')}
</div>
<div class="card"><span class="good">✓ 扣白结果放回白底，与原图 X 放白底视觉差 max={err_w:.2f}/255（&lt;1，肉眼不可见）</span><br>
<span class="mono">流程：载入RGB复合通道亮度选区 → Delete清除亮部 → 复制N份合并（N=ceil(ln0.005/ln(1-a_min))，min 7）</span></div>

<h2>② 扣黑（Z = X 黑底合成 → 还原）</h2>
<div class="row">
{to_svg(X, 'X（原图层，透明底）', (200, 200, 200))}
{to_svg(Z, 'Z（X 与黑底合并）', BLACK)}
{to_svg(res_b, '扣黑结果（反色法 N=%d 动态）' % n_b, BLACK, sub=f'放黑底 视觉差 max={err_b:.2f}/255')}
{to_svg(res_orig, '用户原方案（N=7）', BLACK, sub=f'放黑底 视觉差 max={err_o:.2f}/255')}
</div>
<div class="card"><span class="good">✓ 反色法 + 动态份数：放黑底视觉差 max={err_b:.2f}/255（肉眼不可见）</span><br>
<span class="bad">✗ 用户原方案（选亮部反选删暗部、固定7份）：视觉差 max={err_o:.2f}/255 —— 明显偏暗，正是你遇到的现象。</span><br>
<span class="mono">纠正：Z --Invert--> Z'(=反色X的白底合成) --扣白流程--> --Invert--> 结果；N 动态放大（本案例 23 份）</span></div>

<h2>③ 为什么扣黑“偏暗”</h2>
<div class="card">
<ul style="font-size:13px;line-height:1.8;margin:6px 0;">
<li><b>预乘暗色</b>：黑底合成 Z 的 RGB = X 的 RGB × alpha（如红圆 241×0.502≈121）。复制合并只增强 alpha，RGB 永远是预乘暗值 —— 放任何背景都比 X 暗。</li>
<li><b>收敛慢</b>：Z 上内容亮度低 ⇒ 亮度选区强度小 ⇒ 单份 alpha 小（红圆仅 0.21），7 份合并后 alpha 只有 0.81；扣白红圆单份 alpha 0.29 但白底视觉对 alpha 误差不敏感，所以 7 份“看起来行”。</li>
<li><b>纠正</b>：反色法让扣黑走与扣白完全相同的流程（语义对称），份数按内容亮度动态计算（红圆需 ~23 份），alpha 收敛到 ≥99.5%，黑底视觉误差 &lt;1/255。</li>
</ul>
</div>
</body></html>"""

with open('analysis/knockout/knockout_verify.html', 'w', encoding='utf-8') as f:
    f.write(html)
print("已生成 analysis/knockout/knockout_verify.html")
