# -*- coding: utf-8 -*-
"""v8 续7：凹尖角簇0（左侧竖条）三层图 + 全图缩略"""
import json

def load(p):
    d = json.load(open(p))
    return int(d['meta']['w']), int(d['meta']['h']), {int(k): v for k, v in d['rows'].items()}

CW, CH = 150, 145
def place(path, ox, oy):
    w, h, rows = load(path)
    c = [0]*(CW*CH)
    for y in range(h):
        r = rows.get(y, [])
        for x in range(len(r)):
            if x < w: c[(y+oy)*CW+(x+ox)] = r[x]
    return c

line = place('analysis/line.json', 10, 9)
fill = place('analysis/fill_with_holes.json', 13, 11)
good = place('analysis/fill_filled.json', 11, 9)

def show(m, label, x0, x1, y0, y1, th=16):
    print(f"=== {label} x[{x0}-{x1}] y[{y0}-{y1}] ===")
    for y in range(y0, y1+1):
        row = ''
        for x in range(x0, x1+1):
            v = m[y*CW+x]
            row += '8' if v >= 255 else ('5' if v >= 128 else ('.' if v > th else ' '))
        print(f"{y:3d}|{row}")
    print()

# 凹尖角簇0: x[11-18] y[60-118] 竖条——左侧线稿描边
print("########## 凹尖角簇0（左侧竖条）x[8-22] y[58-70] ##########")
show(fill, '含孔隙填充', 8, 22, 58, 70)
show(line, '线稿', 8, 22, 58, 70)
show(good, '补全目标', 8, 22, 58, 70)

# 全图缩略（每 2px 采样）
print("########## 全图缩略对比（# = 有值）##########")
def thumb(m, label):
    print(f"--- {label} ---")
    for y in range(0, CH, 2):
        row = ''
        for x in range(0, CW, 2):
            v = m[y*CW+x]
            row += '#' if v > 16 else ' '
        print(f"{y:3d}|{row}")
    print()
thumb(fill, '含孔隙填充')
thumb(good, '补全目标')
