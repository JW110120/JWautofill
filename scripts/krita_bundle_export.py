#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
krita_bundle_export.py — 把 Krita 资源包（.bundle）里的画笔预设导出成本插件的
「特制笔刷」资源格式（brush.json + tip.png + preview.png + library.json）。

用法:
    python scripts/krita_bundle_export.py
    python scripts/krita_bundle_export.py --bundle "E:/.../RGBA_brushes.bundle" --out src/brushes

设计要点（与 docs/brush-panel-plan-2026-10-20.md §3 对齐）:
  1. 只导出**笔尖位图 + 参数**，不导出任何 Krita 专有格式，产物是可读 PNG + 明文 JSON。
  2. 笔尖统一转成 8bit 灰度遮罩（白=着墨），PS 画笔笔尖只认灰度，彩色的 RGBA 笔尖
     在这里被压成「形状 × 明度」，这是跨引擎的必然损失，不是 bug。
  3. 预览条 250×55，与现有面板列表等比。
  4. 依赖：仅标准库（本机无 PIL / numpy）。

格式说明:
  - .kpp = PNG 容器，参数放在 zTXt(preset) 里，内容是 zlib 压缩的 XML。
  - .gih = GIMP 动画笔尖：两行文本头 + 二进制头 + N 帧原始 RGBA（每帧 w*h*4）。
"""

import argparse
import json
import math
import os
import re
import struct
import sys
import zipfile
import zlib

# ---------------------------------------------------------------- PNG 编解码

def png_decode(data):
    """返回 (width, height, channels, pixels)。只支持 8bit 非隔行（本包的实际情况）。"""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a png"
    pos = 8
    w = h = bit = ctype = None
    idat = bytearray()
    while pos < len(data):
        (ln,) = struct.unpack(">I", data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bit, ctype, _comp, _filt, inter = struct.unpack(">IIBBBBB", chunk)
            if bit != 8 or inter != 0:
                raise ValueError("unsupported png: bit=%d interlace=%d" % (bit, inter))
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln

    channels = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(bytes(idat))
    stride = w * channels
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:      # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif f == 2:    # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:    # Average
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:    # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, channels, out


def png_encode_gray(w, h, pix):
    """8bit 灰度 PNG（filter 0）。pix 为 bytes/bytearray，长度 w*h。"""
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += pix[y * w:(y + 1) * w]

    def chunk(typ, payload):
        return (struct.pack(">I", len(payload)) + typ + payload
                + struct.pack(">I", zlib.crc32(typ + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def png_encode_rgba(w, h, pix):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += pix[y * w * 4:(y + 1) * w * 4]

    def chunk(typ, payload):
        return (struct.pack(">I", len(payload)) + typ + payload
                + struct.pack(">I", zlib.crc32(typ + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


# ---------------------------------------------------------------- 资源包读取

def kpp_preset_xml(blob):
    pos = 8
    while pos < len(blob):
        (ln,) = struct.unpack(">I", blob[pos:pos + 4])
        typ = blob[pos + 4:pos + 8]
        data = blob[pos + 8:pos + 8 + ln]
        if typ == b"zTXt":
            _key, _, rest = data.partition(b"\x00")
            return zlib.decompress(rest[1:]).decode("utf-8")
        pos += 12 + ln
    raise ValueError("no zTXt preset chunk")


def parse_params(xml):
    params = {}
    for m in re.finditer(r'<param type="([^"]*)" name="([^"]*)">(.*?)</param>', xml, re.S):
        _t, name, val = m.groups()
        val = val.strip()
        if val.startswith("<![CDATA["):
            val = val[9:-3].strip()
        params[name] = val
    return params


def parse_brush_definition(xml_text):
    """<Brush filename=".." scale=".." spacing=".." angle=".." .../> → dict"""
    m = re.search(r"<Brush\b([^>]*)/?>", xml_text)
    if not m:
        return {}
    body = m.group(1)
    out = {}
    for k, v in re.findall(r'([A-Za-z_][\w]*)\s*=\s*"([^"]*)"', body):
        out[k] = v
    return out


def gih_first_frame(blob):
    """GIMP 动画笔尖：取第 1 帧。返回 (w,dh,rgba_bytes)。

    ⛔⛔ 2026-10-21 真机修正：旧实现用 `data_start = len(blob) - cells*frame`
       「各帧紧密排在文件末尾」来定位第 1 帧。实际 **每帧前面还有一段 29 字节帧头**
       （hdr_size / ver / w / h / bpp / "GIMP" + 5 字节参数），
       于是起点整体后移 116 字节 = 4bpp 下 **29 像素**：
       impasto / impasto-detail 的笔尖在 PS 里**水平错位**，右侧还混进下一帧的内容，
       用户只能手工缩放对位（2026-10-21 已手工补救，见 src/brushes/impasto*）。
       正确做法：逐帧读帧头、按 `hdr_size + w*h*bpp` 前进；解析结束位置应恰好等于文件长度。
    """
    nl = blob.find(b"\n")
    nl2 = blob.find(b"\n", nl + 1)
    header_text = blob[:nl2].decode("latin1")
    cells = 1
    m = re.search(r"ncells:(\d+)", header_text)
    if m:
        cells = int(m.group(1))

    p = nl2 + 1
    for idx in range(cells):
        if p + 24 > len(blob):
            raise ValueError("gih: truncated header at frame %d" % idx)
        hdr_size, _ver, w, h, bpp = struct.unpack(">IIIII", blob[p:p + 20])
        if blob[p + 20:p + 24] != b"GIMP":
            raise ValueError("gih: no GIMP magic at frame %d (offset %d)" % (idx, p))
        if hdr_size < 24 or hdr_size > 4096:
            raise ValueError("gih: implausible header size %d" % hdr_size)
        data_start = p + hdr_size
        frame = w * h * bpp
        if data_start + frame > len(blob):
            raise ValueError("gih: frame %d overruns file" % idx)
        if idx == 0:
            cell = blob[data_start:data_start + frame]
            break
        p = data_start + frame
    else:
        raise ValueError("gih: no frames")

    if bpp == 4:
        rgba = bytearray(cell)
    elif bpp == 3:
        rgba = bytearray(w * h * 4)
        for i in range(w * h):
            rgba[i * 4:i * 4 + 3] = cell[i * 3:i * 3 + 3]
            rgba[i * 4 + 3] = 255
    elif bpp == 1:
        rgba = bytearray(w * h * 4)
        for i in range(w * h):
            v = cell[i]
            rgba[i * 4:i * 4 + 4] = bytes((v, v, v, 255))
    else:
        raise ValueError("gih: unsupported bpp %d" % bpp)
    return w, h, rgba


# ---------------------------------------------------------------- 参数映射

def curve_first_y(curve):
    """Krita 曲线串 '0,0.27;1,1;' → x=0 处的 y（=最小比例）。"""
    if not curve:
        return 1.0
    try:
        first = curve.split(";")[0]
        return float(first.split(",")[1])
    except Exception:
        return 1.0


def sensor_is_pressure(params, name):
    s = params.get(name + "Sensor", "")
    return (not params.get(name + "UseCurve") == "false") and ("pressure" in s)


def build_brush(preset_name, params, tip_name, tip_w, tip_h, tip_rel, preview_rel, idx):
    bd = parse_brush_definition(params.get("brush_definition", ""))
    scale = float(bd.get("scale", "1") or 1)
    angle_rad = float(bd.get("angle", "0") or 0)
    # 间距：一律取 spacing 属性。useAutoSpacing / autoSpacingCoeff 是 Krita 的「自动间距」
    # 策略（运行期按笔尖密度自适应），在 PS 里没有对应概念；直接用 coeff 会得到 100%
    # 间距（impasto 系的 coeff=1），笔触会断成一串点，故不采用。
    spacing = float(bd.get("spacing", "0.1") or 0.1)

    size = max(1, int(round(max(tip_w, tip_h) * scale)))
    min_size = curve_first_y(params.get("SizecommonCurve", ""))
    min_opacity = curve_first_y(params.get("OpacitycommonCurve", ""))
    min_flow = curve_first_y(params.get("FlowcommonCurve", ""))

    texture_on = params.get("Texture/Pattern/Enabled") == "true"
    pattern_name = ""
    if texture_on:
        pn = params.get("Texture/Pattern/Name", "")
        pattern_name = pn.rsplit("patterns/", 1)[-1] if "patterns/" in pn else ""

    return {
        "id": preset_name,
        "index": idx,
        "name": DISPLAY_NAMES.get(preset_name, preset_name),
        "category": "厚涂",
        "tip": tip_rel,
        "tipSize": size,
        # ---- 与 PS 画笔描述符一一对应的参数 ----
        "params": {
            "diameter": {"base": size, "pressure": params.get("PressureSize") == "true", "min": round(min_size, 4)},
            "spacing": round(max(0.01, min(1.0, spacing)), 4),
            "angle": round(math.degrees(angle_rad) % 360, 2),
            "roundness": round(float(params.get("RatioValue", "1") or 1), 4),
            "angleFollowsDirection": params.get("PressureRotation") == "true",
            "opacity": {"base": round(float(params.get("OpacityValue", "1") or 1), 4),
                        "pressure": sensor_is_pressure(params, "Opacity"), "min": round(min_opacity, 4)},
            "flow": {"base": round(float(params.get("FlowValue", "1") or 1), 4),
                     "pressure": sensor_is_pressure(params, "Flow"), "min": round(min_flow, 4)},
            "scatter": {"on": float(params.get("ScatterValue", "0") or 0) > 0,
                        "amount": round(float(params.get("ScatterValue", "0") or 0) / 100.0, 4),
                        "bothAxes": params.get("Scattering/AxisX") == "true" and params.get("Scattering/AxisY") == "true",
                        "pressure": params.get("PressureScatter") == "true"},
            # 纹理：键名待真机校准后再启用（见 docs/brush-panel-plan §4.2），先只记录不应用
            "texture": {"apply": False, "src": "pattern.png" if texture_on else "",
                        "patternName": pattern_name,
                        "brightness": float(params.get("Texture/Pattern/Brightness", "0") or 0),
                        "contrast": float(params.get("Texture/Pattern/Contrast", "1") or 1)},
        },
        "source": {"preset": preset_name, "tipFile": tip_name},
        "engineVersion": 1,
    }


# 中文显示名（自拟，不沿用任何他人的命名）
DISPLAY_NAMES = {
    "m)_RGBA_01_Thick-dry": "干厚涂",
    "m)_RGBA_02_Thickpaint": "湿厚涂",
    "m)_RGBA_03_Rake": "耙笔",
    "m)_RGBA_04_Impasto": "堆叠",
    "m)_RGBA_05_Impasto-details": "堆叠细描",
    "m)_RGBA_06_Rock": "石纹",
}
FILE_IDS = {
    "m)_RGBA_01_Thick-dry": "thick-dry",
    "m)_RGBA_02_Thickpaint": "thick-paint",
    "m)_RGBA_03_Rake": "rake",
    "m)_RGBA_04_Impasto": "impasto",
    "m)_RGBA_05_Impasto-details": "impasto-detail",
    "m)_RGBA_06_Rock": "rock",
}


# ---------------------------------------------------------------- 像素处理

def rgba_to_mask(w, h, rgba):
    """RGBA → 8bit 灰度遮罩，返回 **alpha 语义**（255 = 实心，0 = 完全透明）。

    再做一次「按最大值归一」：Krita 的 RGBA 笔尖常常整体偏暗（彩色 ≈ 中灰），
    直接当遮罩用会变成一支半透明、按不出色的笔；归一后最亮处=不着墨区的 255，
    纹理对比保留，这才是「这支笔的形状」。

    ⛔⛔ **本函数不负责极性**。PS 的画笔遮罩与 alpha 语义**相反**：
      黑(0) = 100% 不透明，白(255) = 100% 透明。
        ⇒ 写 PNG 前必须整体反相（见 main() 里的 `255 - v`）。
        ⇒ 而 render_preview / stamp_mask 按 alpha 语义工作，**不能反相**，
          否则预览会变成"透明底上几乎看不见的浅痕"。
       2026-10-21 真机：漏了写文件端的反相，6 支笔的图案全反了（该实心的透明、
       该透明的地方被涂黑），用户在 PS 里手动反相才救回来。
    """
    mask = bytearray(w * h)
    top = 1
    for i in range(w * h):
        r, g, b, a = rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]
        lum = (r * 299 + g * 587 + b * 114) // 1000
        v = (lum * a) // 255
        mask[i] = v
        if v > top:
            top = v
    if top < 250:
        k = 255.0 / top
        for i in range(w * h):
            mask[i] = min(255, int(mask[i] * k))
    return mask


def stamp_mask(dst, dw, dh, mask, mw, mh, cx, cy, size, alpha):
    """把遮罩按 size（最长边像素）贴到 dst 的 (cx, cy)，双线性采样。"""
    s = size / float(max(mw, mh))
    tw, th = max(1, int(mw * s)), max(1, int(mh * s))
    x0, y0 = cx - tw // 2, cy - th // 2
    for y in range(th):
        py = y0 + y
        if py < 0 or py >= dh:
            continue
        sy = min(mh - 1, int(y / s))
        row = sy * mw
        for x in range(tw):
            px = x0 + x
            if px < 0 or px >= dw:
                continue
            sx = min(mw - 1, int(x / s))
            v = mask[row + sx] * alpha // 255
            if v:
                o = (py * dw + px) * 4
                cur = dst[o + 3]
                if v > cur:
                    dst[o] = dst[o + 1] = dst[o + 2] = 122
                    dst[o + 3] = v


def render_preview(mask, mw, mh, W=250, H=55):
    """沿一条弧线连续压印，生成一条「笔触」预览（透明底 + 中性灰）。"""
    buf = bytearray(W * H * 4)
    n = 46
    for i in range(n):
        t = i / float(n - 1)
        x = 8 + t * (W - 16)
        y = H * 0.62 - math.sin(t * math.pi) * H * 0.28
        # 两端略细、中段最粗，像一次真实运笔
        size = (0.55 + 0.45 * math.sin(t * math.pi)) * H * 0.92
        stamp_mask(buf, W, H, mask, mw, mh, int(x), int(y), size, 255)
    return buf


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=r"E:\Program Files\Krita (x64)\share\krita\bundles\RGBA_brushes.bundle")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "brushes"))
    args = ap.parse_args()

    z = zipfile.ZipFile(args.bundle)
    presets = sorted(n for n in z.namelist()
                     if n.startswith("paintoppresets/") and n.endswith(".kpp"))
    os.makedirs(args.out, exist_ok=True)

    library = {"version": 1, "categories": ["厚涂"], "brushes": []}
    for idx, path in enumerate(presets, 1):
        pname = path.split("/")[-1][:-4]
        params = parse_params(kpp_preset_xml(z.read(path)))
        tip_file = params.get("requiredBrushFile", "")
        tip_blob = z.read("brushes/" + tip_file)

        if tip_file.lower().endswith(".gih"):
            tw, th, rgba = gih_first_frame(tip_blob)
        else:
            tw, th, ch, raw = png_decode(tip_blob)
            if ch == 4:
                rgba = bytearray(raw)
            elif ch == 1:
                rgba = bytearray(tw * th * 4)
                for i in range(tw * th):
                    v = raw[i]
                    rgba[i * 4:i * 4 + 4] = bytes((v, v, v, 255))
            elif ch == 3:
                rgba = bytearray(tw * th * 4)
                for i in range(tw * th):
                    rgba[i * 4:i * 4 + 3] = raw[i * 3:i * 3 + 3]
                    rgba[i * 4 + 3] = 255
            else:
                raise ValueError("unsupported channels %d" % ch)

        mask = rgba_to_mask(tw, th, rgba)
        fid = FILE_IDS.get(pname, "brush-%d" % idx)
        outdir = os.path.join(args.out, fid)
        os.makedirs(outdir, exist_ok=True)

        # 笔尖文件名必须**全局唯一且带 BRS- 前缀**。
        # 原因：PS 的 defineBrush 在交互路径下会用**文档名**当预设名（不是 name 参数），
        # 而文档名 = 打开的文件名。全叫 tip.png 时，6 支笔只会得到 6 个同名 tip.png，
        # 既无法按名选中，也无法用「前后清单差集」判断这次到底新建了哪一支。
        tip_out = "BRS-%s.png" % fid
        # ⛔⛔ 极性在这里翻转：mask 是 alpha 语义（255=实心），
        #    PS 画笔遮罩是**反的**（0=黑=不透明，255=白=透明）⇒ 写文件时 255-v。
        #    只翻写文件这一处；preview 继续用 mask 原值，视觉不会被带歪。
        tip_gray = bytes(255 - v for v in mask)
        with open(os.path.join(outdir, tip_out), "wb") as f:
            f.write(png_encode_gray(tw, th, tip_gray))
        with open(os.path.join(outdir, "preview.png"), "wb") as f:
            f.write(png_encode_rgba(250, 55, render_preview(mask, tw, th)))

        brush = build_brush(pname, params, tip_file, tw, th, tip_out, "preview.png", idx)
        brush["id"] = fid
        with open(os.path.join(outdir, "brush.json"), "w", encoding="utf-8") as f:
            json.dump(brush, f, ensure_ascii=False, indent=2)

        library["brushes"].append({"id": fid, "name": brush["name"], "category": brush["category"]})
        print("ok  %-26s %3dx%-3d -> %-16s size=%dpx spacing=%s" %
              (pname, tw, th, fid, brush["params"]["diameter"]["base"], brush["params"]["spacing"]))

    with open(os.path.join(args.out, "library.json"), "w", encoding="utf-8") as f:
        json.dump(library, f, ensure_ascii=False, indent=2)
    print("\nlibrary written:", os.path.join(args.out, "library.json"))


if __name__ == "__main__":
    main()
