# -*- coding: utf-8 -*-
"""生成 样本 vs 算法结果 对比图（并排 + diff）。"""
import numpy as np
from PIL import Image
from line_smooth_proto_v1 import parse_log

src = r'C:\Users\Administrator\Desktop\平滑线条样本.log'
a = parse_log(src)
res = np.load(r'F:\Coding\JWautofill\analysis\line_vis\v1_res.npy')

h, w = a.shape
scale = 4
canvas = Image.new('RGB', (w * scale * 3 + 20, h * scale), (240, 240, 240))
px = canvas.load()

def render(img, data, ox, label):
    for y in range(h):
        for x in range(w):
            v = int(round(data[y, x]))
            c = 255 - v
            for dy in range(scale):
                for dx in range(scale):
                    px[(ox + x) * scale + dx, y * scale + dy] = (c, c, c)
    for y in range(0, h, 2):
        px[ox * scale - 1 if ox > 0 else 0, y * scale] = (0, 0, 0)

render(a, a, 0, 'input')
render(res, res, w + 1, 'out')
# diff
diff = np.abs(res - a)
render(diff, diff, (w + 1) * 2, 'diff')
path = r'F:\Coding\JWautofill\analysis\line_vis\v1_compare.png'
canvas.save(path)
print('saved', path)
