# -*- coding: utf-8 -*-
"""v8 续6：关键区域三层图（fill/line/good）"""
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
    print("  图例: 8=255, 5=128-254, .=1-127, 空格=0")
    for y in range(y0, y1+1):
        row = ''
        for x in range(x0, x1+1):
            v = m[y*CW+x]
            row += '8' if v >= 255 else ('5' if v >= 128 else ('.' if v > th else ' '))
        print(f"{y:3d}|{row}")
    print()

# 真孔洞簇0: x[49-56] y[30-43]（帽子底部区域）
print("########## 真孔洞簇0 区域 x[44-60] y[25-45] ##########")
show(fill, '含孔隙填充', 44, 60, 25, 45)
show(line, '线稿', 44, 60, 25, 45)
show(good, '补全目标', 44, 60, 25, 45)

# 凹尖角簇1: x[42-61] y[17-43]
print("########## 凹尖角簇1 区域 x[38-64] y[15-45] ##########")
show(fill, '含孔隙填充', 38, 64, 15, 45)
show(line, '线稿', 38, 64, 15, 45)
show(good, '补全目标', 38, 64, 15, 45)
