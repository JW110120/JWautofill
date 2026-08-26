# -*- coding: utf-8 -*-
"""
扣黑「黑底偏亮」修复验证。
模型当前反色往返流程（Invert -> 载入亮度选区 -> Clear -> 复制N份合并 -> Invert），
对比两种输入：
  A) 带透明内容图层 X=(x, a)：getPixels 返回 straight rgb=x，alpha=a
  B) 平铺合成图（内容压在黑底上、不透明）：rgb=x*a，alpha=1
目标：Z 在黑底上的观感 == X 在黑底上的观感 = x*a。
"""
import math

def luma601(rgb):
    return (0.299*rgb[0] + 0.587*rgb[1] + 0.114*rgb[2]) / 255.0

# 用户案例像素 (r,g,b,a)
X_px = {
    'red':   [241, 52, 52, 128],
    'green': [76, 221, 56, 179],
    'cross': [105, 191, 55, 217],
}

def on_black(rgb, a):
    return [rgb[i]*a for i in range(3)]

def current_black_pipeline(x, a):
    """反色往返：返回最终 (rgb, alpha)——假设 merge 把内容 alpha 顶到 1。"""
    # 输入 straight: rgb=x, alpha=a
    # Invert(RGB): 255-x, alpha a
    inv = [255 - v for v in x]
    # 载入亮度选区 M = luma(inv)
    M = luma601(inv)
    # Clear: alpha *= (1-M)
    a_after_clear = a * (1 - M)
    # 复制 N 份合并 -> 内容 alpha 顶到 ~1，rgb 不变
    a_merged = 1.0
    rgb_merged = inv[:]   # 仍 (255-x)
    # Invert 回来
    rgb_back = [255 - v for v in rgb_merged]
    return rgb_back, a_merged

def fixed_black_pipeline(x, a):
    """修复：premult = x*a，写回 rgb，alpha=1。"""
    premult = [xi * a for xi in x]
    return premult, 1.0

def flat_input(x, a):
    """平铺合成图：rgb = x*a, alpha=1（黑底上已预乘）。"""
    return [xi*a for xi in x], 1.0

def run(name, x, a_raw, inp_kind):
    a = a_raw / 255.0  # 归一化 alpha
    if inp_kind == 'layer':
        # 输入 straight x,a（内容图层）
        in_rgb, in_a = x, a
    else:
        in_rgb, in_a = flat_input(x, a)
    target = on_black(x, a)  # X 在黑底上的观感 = x*a（两种输入都一样）

    cur_rgb, cur_a = current_black_pipeline(in_rgb, in_a)
    fix_rgb, fix_a = fixed_black_pipeline(in_rgb, in_a)
    cur_vis = on_black(cur_rgb, cur_a)
    fix_vis = on_black(fix_rgb, fix_a)

    def err(v):
        return max(abs(v[i]-target[i]) for i in range(3))
    print(f"\n===== {name} ({inp_kind})  a={a:.2f} =====")
    print(f"  X在黑底观感      = ({target[0]:.1f},{target[1]:.1f},{target[2]:.1f})")
    print(f"  当前Z在黑底      = ({cur_vis[0]:.1f},{cur_vis[1]:.1f},{cur_vis[2]:.1f})  误差{err(cur_vis):.1f}/255  {'<-- 偏亮' if err(cur_vis)>1 else ''}")
    print(f"  修复Z在黑底      = ({fix_vis[0]:.1f},{fix_vis[1]:.1f},{fix_vis[2]:.1f})  误差{err(fix_vis):.1f}/255")

for k, v in X_px.items():
    x = v[:3]
    run(k, x, v[3], 'layer')
    run(k, x, v[3], 'flat')
