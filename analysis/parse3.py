import re, json

def parse(path):
    rows = {}
    meta = {}
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            m = re.search(r'y=(\d+):\s*(.*)', line)
            if m:
                y = int(m.group(1))
                vals = [int(x) for x in m.group(2).split(',') if x.strip() != '']
                rows[y] = vals
            m2 = re.search(r'尺寸:\s*(\d+)x(\d+)', line)
            if m2:
                meta['w'] = int(m2.group(1)); meta['h'] = int(m2.group(2))
    return meta, rows

for name, p in [('line', r'C:/Users/Administrator/Desktop/线稿.log'),
                ('fill_with_holes', r'C:/Users/Administrator/Desktop/含孔隙孔洞内部填充.log'),
                ('fill_filled', r'C:/Users/Administrator/Desktop/补全空隙与孔洞内部填充.log')]:
    meta, rows = parse(p)
    print(f"{name}: meta={meta} rows={len(rows)}")
    json.dump({'meta': meta, 'rows': rows}, open(f'analysis/{name}.json', 'w'))
    # 有值范围
    xs, ys = [], []
    for y, r in rows.items():
        for x, v in enumerate(r):
            if v > 0:
                xs.append(x); ys.append(y)
    print(f"  有值像素: {len(xs)}, x范围: {min(xs)}-{max(xs)}, y范围: {min(ys)}-{max(ys)}")
