# -*- coding: utf-8 -*-
"""Measure the HUD/UI geometry from real screenshots (pure stdlib, no numpy).

工具链：img2bmp.ps1（任意图→24bpp BMP）→ 本脚本（测量）→ img_crop_zoom.ps1（局部放大细看）。
颜色判据（orange/dark 阈值）针对 HUD 橙色取证硬编码，测其他对象时按需改。
⛔ 仅可用于用户确认为真实的截图；示意图/渲染描述绝不可作测量源。
"""
import sys, struct, math
from collections import deque

def read_bmp(path):
    with open(path, 'rb') as f:
        d = f.read()
    assert d[:2] == b'BM', 'not bmp'
    off = struct.unpack_from('<I', d, 10)[0]
    w, h = struct.unpack_from('<ii', d, 18)
    bpp = struct.unpack_from('<H', d, 28)[0]
    assert bpp == 24, bpp
    flip = h > 0
    h = abs(h)
    stride = ((w * 3 + 3) // 4) * 4
    px = bytearray(w * h * 3)
    for y in range(h):
        src = off + y * stride
        row = h - 1 - y if flip else y
        px[row * w * 3:(row + 1) * w * 3] = d[src:src + w * 3]
    return w, h, px

def analyze(path):
    w, h, px = read_bmp(path)
    print('=' * 72)
    print('IMAGE %s  %dx%d' % (path.split('\\')[-1].split('/')[-1], w, h))
    # colour census (coarse)
    from collections import Counter
    c = Counter()
    orange = bytearray(w * h)
    dark = bytearray(w * h)
    for i in range(w * h):
        b, g, r = px[i * 3], px[i * 3 + 1], px[i * 3 + 2]
        c[(r >> 5, g >> 5, b >> 5)] += 1
        if r > 140 and b < 120 and (r - b) > 70 and g < 210:
            orange[i] = 1
        elif r < 120 and g < 120 and b < 120:
            dark[i] = 1
    print('top colours (r>>5,g>>5,b>>5):', c.most_common(5))
    print('orange px = %d, dark px = %d' % (sum(orange), sum(dark)))

    def centroid(mask):
        sx = sy = n = 0
        for i in range(w * h):
            if mask[i]:
                sx += i % w; sy += i // w; n += 1
        return (sx / n, sy / n, n) if n else (0, 0, 0)

    # --- circle: farthest orange pixel per angle bin from the coarse centroid ---
    cx0, cy0, n_or = centroid(orange)
    pts = []
    BINS = 360
    best = [(-1.0, 0, 0)] * BINS
    for i in range(w * h):
        if not orange[i]:
            continue
        x = i % w; y = i // w
        dx = x - cx0; dy = y - cy0
        d2 = dx * dx + dy * dy
        a = int((math.atan2(dy, dx) + math.pi) / (2 * math.pi) * BINS) % BINS
        if d2 > best[a][0]:
            best[a] = (d2, x, y)
    pts = [(p[1], p[2]) for p in best if p[0] >= 0]
    print('ring candidates = %d' % len(pts))

    def kasa(pts):
        n = len(pts)
        sx = sum(p[0] for p in pts); sy = sum(p[1] for p in pts)
        sxx = sum(p[0] * p[0] for p in pts); syy = sum(p[1] * p[1] for p in pts)
        sxy = sum(p[0] * p[1] for p in pts)
        sxxyy = sum(p[0] * p[0] + p[1] * p[1] for p in pts)
        sx3 = sum(p[0] * (p[0] * p[0] + p[1] * p[1]) for p in pts)
        sy3 = sum(p[1] * (p[0] * p[0] + p[1] * p[1]) for p in pts)
        A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]]
        B = [-sx3, -sy3, -sxxyy]
        # gaussian elimination
        for i in range(3):
            p = max(range(i, 3), key=lambda k: abs(A[k][i]))
            A[i], A[p] = A[p], A[i]; B[i], B[p] = B[p], B[i]
            if abs(A[i][i]) < 1e-9:
                return None
            for k in range(i + 1, 3):
                f = A[k][i] / A[i][i]
                for j in range(i, 3):
                    A[k][j] -= f * A[i][j]
                B[k] -= f * B[i]
        z = [0.0] * 3
        for i in (2, 1, 0):
            s = B[i] - sum(A[i][j] * z[j] for j in range(i + 1, 3))
            z[i] = s / A[i][i]
        D, E, F = z
        ccx = -D / 2; ccy = -E / 2
        r = math.sqrt(max(0.0, ccx * ccx + ccy * ccy - F))
        return ccx, ccy, r

    fit = kasa(pts)
    for _ in range(3):
        if not fit:
            break
        ccx, ccy, r = fit
        keep = [(x, y) for (x, y) in pts if abs(math.hypot(x - ccx, y - ccy) - r) < 4.0]
        if len(keep) < 20:
            break
        fit = kasa(keep) or fit
    if fit:
        ccx, ccy, r = fit
        print('CIRCLE centre=(%.1f, %.1f)  radius=%.1f px   (kept %d pts)' % (ccx, ccy, r, len(keep)))
    else:
        ccx = ccy = r = 0
        print('CIRCLE fit failed')

    # --- orange blobs ---
    def blobs(mask, minpx=6):
        seen = bytearray(w * h)
        out = []
        for i in range(w * h):
            if mask[i] and not seen[i]:
                q = deque([i]); seen[i] = 1
                comp = []
                while q:
                    k = q.popleft(); comp.append(k)
                    x = k % w; y = k // w
                    for dx in (-1, 0, 1):
                        for dy in (-1, 0, 1):
                            nx, ny = x + dx, y + dy
                            if 0 <= nx < w and 0 <= ny < h:
                                j = ny * w + nx
                                if mask[j] and not seen[j]:
                                    seen[j] = 1; q.append(j)
                if len(comp) >= minpx:
                    xs = [k % w for k in comp]; ys = [k // w for k in comp]
                    out.append(dict(n=len(comp),
                                    cx=sum(xs) / len(xs), cy=sum(ys) / len(ys),
                                    x0=min(xs), x1=max(xs), y0=min(ys), y1=max(ys)))
        out.sort(key=lambda o: -o['n'])
        return out

    ob = blobs(orange)
    print('ORANGE components: %d' % len(ob))
    for o in ob[:6]:
        d = math.hypot(o['cx'] - ccx, o['cy'] - ccy) if fit else 0
        print('   n=%5d centre=(%6.1f,%6.1f) bbox=(%d..%d, %d..%d)  dist_to_ring_centre=%.1f'
              % (o['n'], o['cx'], o['cy'], o['x0'], o['x1'], o['y0'], o['y1'], d))

    db = blobs(dark, minpx=10)
    print('DARK components: %d' % len(db))
    for o in db[:4]:
        pts2 = []
        for i in range(w * h):
            if dark[i]:
                x = i % w; y = i // w
                if o['x0'] - 1 <= x <= o['x1'] + 1 and o['y0'] - 1 <= y <= o['y1'] + 1:
                    dx = x - o['cx']; dy = y - o['cy']
                    if abs(dx) <= (o['x1'] - o['x0']) and abs(dy) <= (o['y1'] - o['y0']):
                        pts2.append((x, y))
        # endpoints: farthest pair via double sweep
        def sweep(p0):
            bx, by, bd = p0[0], p0[1], -1.0
            for (x, y) in pts2:
                d = (x - p0[0]) ** 2 + (y - p0[1]) ** 2
                if d > bd:
                    bd, bx, by = d, x, y
            return (bx, by), math.sqrt(bd)
        if not pts2:
            continue
        a1, _ = sweep((o['cx'], o['cy']))
        a2, dist = sweep(a1)
        print('   n=%5d centre=(%6.1f,%6.1f) bbox=(%d..%d, %d..%d) endpoints=(%d,%d)-(%d,%d) len=%.1f'
              % (o['n'], o['cx'], o['cy'], o['x0'], o['x1'], o['y0'], o['y1'],
                 a1[0], a1[1], a2[0], a2[1], dist))
        if fit:
            for e in (a1, a2):
                print('        endpoint (%d,%d) dist_to_ring_centre=%.1f'
                      % (e[0], e[1], math.hypot(e[0] - ccx, e[1] - ccy)))
    return

for p in sys.argv[1:]:
    analyze(p)
