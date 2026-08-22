# -*- coding: utf-8 -*-
"""生成 样本 vs v3输出 vs 理想情况 vs 最低要求 四联对比图。"""
import numpy as np
from PIL import Image
from line_smooth_proto_v3 import parse_log

a = parse_log(r'C:\Users\Administrator\Desktop\平滑线条样本.log')
res = np.load(r'F:\Coding\JWautofill\analysis\line_vis\v3_res.npy')
ideal = parse_log(r'C:\Users\Administrator\Desktop\理想情况结果.log')
minimum = parse_log(r'C:\Users\Administrator\Desktop\最低要求结果.log')

scale = 3
h_max = max(a.shape[0], res.shape[0], ideal.shape[0], minimum.shape[0])
w_max = max(a.shape[1], res.shape[1], ideal.shape[1], minimum.shape[1])
canvas = Image.new('RGB', (w_max * scale * 4 + 30, h_max * scale + 30), (245, 245, 245))
px = canvas.load()

def render(data, ox, oy, label):
    h, w = data.shape
    for y in range(h):
        for x in range(w):
            v = int(round(data[y, x]))
            c = 255 - v
            for dy in range(scale):
                for dx in range(scale):
                    if oy + y * scale + dy < h_max * scale and ox + x * scale + dx < w_max * scale:
                        px[ox + x * scale + dx, oy + y * scale + dy] = (c, c, c)
    # 标签
    from PIL import ImageDraw
    d = ImageDraw.Draw(canvas)
    d.text((ox, oy - 8 if oy > 10 else oy + h * scale + 2), label, fill=(0, 0, 0))

render(a, 0, 10, '样本')
render(res, w_max * scale + 10, 10, 'v3输出')
render(ideal, (w_max * scale + 10) * 2, 10, '理想情况')
render(minimum, (w_max * scale + 10) * 3, 10, '最低要求')

path = r'F:\Coding\JWautofill\analysis\line_vis\v3_quad.png'
canvas.save(path)
print('saved', path, '尺寸', canvas.size)
