# -*- coding: utf-8 -*-
"""解析平滑线条样本/理想情况/最低要求的 alpha log，生成放大可视化 PNG。
用法: python vis_line_logs.py <log1> <log2> ... --outdir <dir>
"""
import re
import sys
import os
from PIL import Image

LOG_LINE = re.compile(r'^(?:AdjustmentPanel\.tsx:\d+\s+)?y=(\d+):\s*(.*)$')

def parse_log(path):
    grid = {}
    header = None
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if line.startswith('=====') and '图层' in line:
                header = line
                continue
            m = LOG_LINE.match(line)
            if not m:
                continue
            y = int(m.group(1))
            vals = [int(v) for v in m.group(2).split(',')]
            grid[y] = vals
    if not grid:
        raise ValueError(f'no data in {path}')
    h = max(grid.keys()) + 1
    w = max(len(v) for v in grid.values())
    data = [[0] * w for _ in range(h)]
    for y, vals in grid.items():
        for x, v in enumerate(vals):
            data[y][x] = v
    return header, w, h, data

def render(name, w, h, data, outdir, scale=6):
    img = Image.new('RGB', (w * scale, h * scale), (255, 255, 255))
    px = img.load()
    for y in range(h):
        for x in range(w):
            a = data[y][x]
            c = 255 - a  # 白底黑线
            for dy in range(scale):
                for dx in range(scale):
                    px[x * scale + dx, y * scale + dy] = (c, c, c)
    path = os.path.join(outdir, f'{name}.png')
    img.save(path)
    print(f'saved {path}  ({w}x{h})')

def main():
    outdir = os.path.dirname(os.path.abspath(__file__))
    args = [a for a in sys.argv[1:] if not a.startswith('--outdir')]
    if '--outdir' in sys.argv:
        outdir = sys.argv[sys.argv.index('--outdir') + 1]
    os.makedirs(outdir, exist_ok=True)
    for path in args:
        if not path.lower().endswith('.log'):
            continue
        header, w, h, data = parse_log(path)
        name = os.path.splitext(os.path.basename(path))[0]
        print(f'== {name}: {header}')
        render(name, w, h, data, outdir)

if __name__ == '__main__':
    main()
