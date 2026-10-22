# 图像笔尖的「浮雕感」：机制与 PS 复现边界

日期：2026-10-22 ｜ 状态：研究结论，待方向确认

---

## 一句话结论

**Krita 把笔尖的灰度当作「亮度」去重新映射颜色，PS 只把灰度当作「遮罩」。**
这不是参数没调对，是两套笔刷引擎的结构差异 —— 白前景在白底上画不出浮雕，是 PS 的结构性缺失。

---

## 1. 三个现象，一个根因

| 你观察到的 | 真正的机制 |
| --- | --- |
| Krita 里白前景 + 白底，仍画出带凹槽阴影的笔触 | 笔尖的**暗部**被映射成灰色输出，不是纯白；**亮部**才被推成纯白 |
| PS 里同图案、同前景，一片纯白 | PS 的输出颜色**恒等于前景色**，笔尖灰度只影响透明度 |
| PS 里图案整体偏半透明 | 深灰在 PS 里被读成「半透明」，而在 Krita 里是「暗部」 |

> 上一轮我判断「半透明是流量问题」，**错了**。流量 100% 时，深灰依然半透明 —— 因为灰度在 PS 里只有「透明度」这一个含义。

---

## 2. Krita 的实际计算路径（源码）

调用链：

```
KisBrush::generateMaskAndApplyMaskOrCreateDab()          libs/image/brushes/kis_brush.cpp
  ├─ preserveLightness == false → cs->fillGrayBrushWithColor()                     ← PS 的行为
  └─ preserveLightness == true  → cs->fillGrayBrushWithColorAndLightnessWithStrength()
                                     └─ fillGrayBrushWithColorPreserveLightnessRGB()
                                          libs/pigment/KoColorSpacePreserveLightnessUtils.h
```

核心函数（作者 Peter Schatz，GPL-2.0-or-later）：

```cpp
const float srcColorL = getLightness(srcColorR, srcColorG, srcColorB);  // 前景色亮度 z
const float lightnessB = 4 * srcColorL - 1;
const float lightnessA = 1 - lightnessB;                                // = 2 - 4z

for (每个像素) {
    float brushMaskL    = qRed(*brush) / 255.0f;                 // ★ 笔尖的 R 通道 = 亮度
    brushMaskL          = (brushMaskL - 0.5) * strength + 0.5;   // 强度调制
    const float finalAlpha = qMin(qAlpha(*brush)/255.0f, srcColorA);  // ★ alpha 通道 = 透明度

    float finalLightness = lightnessA * pow2(brushMaskL) + lightnessB * brushMaskL;
    finalLightness = qBound(0.0f, finalLightness, 1.0f);

    // 保持色相/饱和度不变，只替换亮度
    setLightness(pixelR, pixelG, pixelB, finalLightness);
}
```

**两个通道分工明确、互不干扰：**

| 笔尖通道 | 用途 |
| --- | --- |
| Alpha | 该像素的**不透明度** |
| R（灰度） | 该像素的**亮度**，经上方二次曲线重新映射后写进输出颜色 |

也就是说：一支笔尖是「**带光照的印章**」，不是一个「漏空模板」。

设计者的注释交代了这条曲线的来历 —— `f(0)=0, f(1)=1, f(0.5)=z`（z 为前景色亮度），
解出的二次式保证「中灰笔尖 → 输出正好等于前景色」，暗于中灰的偏暗、亮于中灰的偏亮。

---

## 3. 数值验证（与你的截图现象吻合）

`finalLightness = (2−4z)·L² + (4z−1)·L`，L = 笔尖灰度：

| 笔尖灰度 L | 白前景 (z=1) | 中灰 (z=0.5) | 黑前景 (z=0) |
| --- | --- | --- | --- |
| 0.0 | 0.000（纯黑） | 0.000 | 0.000 |
| 0.1 | **0.280（灰）** | 0.100 | 0.000 |
| 0.2 | **0.520（灰）** | 0.200 | 0.000 |
| 0.3 | **0.720（灰）** | 0.300 | 0.000 |
| 0.4 | **0.880（浅灰）** | 0.400 | 0.000 |
| 0.5 | 1.000（纯白） | 0.500 | 0.000 |
| 0.8 | 1.000 | 0.800 | 0.480 |
| 1.0 | 1.000 | 1.000 | 1.000 |

**白前景**：L < 0.5 的部分输出灰色 → 笔尖的凹槽变成阴影；L ≥ 0.5 全部推满成纯白 → 凸起变成高光。**这就是浮雕感的全部来源。**

**中灰前景**：曲线退化为恒等映射 `f(L)=L`，笔尖明暗被原样搬运。

---

## 4. 笔尖文件里对应的开关

`m)_RGBA_05_Impasto-details.kpp` 的 `brush_definition`：

```xml
<Brush type="gbr_brush" filename="RGBA anim 01.gih"
       ColorAsMask="1"            <!-- 用图像当遮罩，而不是直接贴原色 -->
       preserveLightness="1"      <!-- ★ 保留亮度：走上面那条二次曲线 -->
       BrightnessAdjustment="0.05"
       ContrastAdjustment="-0.29"
       AdjustmentMidPoint="109" /> <!-- 灰度重映射的中性点 -->
```

`preserveLightness="0"` 时，行为与 PS 完全一致（纯前景色 + alpha 遮罩）。

---

## 5. PS 侧的机制对照

PS 的画笔只有一个「遮罩」概念：

```
输出颜色 = 前景色（恒定，逐像素不变）
输出 alpha = 笔尖灰度值
```

没有第二个通道去承载亮度。因此：

- **纯白前景 + 白底**：所有像素都是 `(255,255,255)`，alpha 再低也还是白 → **物理上看不见**。这不是参数问题。
- **深灰笔尖**：在 PS 里等价于「70% 不透明度」，所以印章颗颗半透明。

---

## 6. 复现边界：三条路，代价递增

| 路线 | 做法 | 保真度 | 代价 / 限制 |
| --- | --- | --- | --- |
| **A. 纹理通道近似** | 笔尖图另存为图案 → 画笔「纹理」→ 模式=正片叠底/叠加 → **勾选「纹理每个笔尖」** → 深度 100% | 约 60~70% | 需要额外装图案预设；混合模式是固定公式，对某些前景色会偏（Krita 是随前景色自适应曲线）；纹理平铺可能引入重复感 |
| **B. 拆两层（阴影 + 高光）** | 同一笔尖出两个版本：暗部版配深色、正片叠底；亮部版配浅色、滤色/叠加。两次描边 | 约 85~90% | **不再是「一支笔」**；两次描边 = 两倍开销，且要保证对齐 |
| **C. 图层样式浮雕** | 画完后给图层加「斜面和浮雕」 | 效果最"真" | 不是笔刷行为；不随运笔实时；改动不可逆（除非智能对象） |
| **D. 只修半透明** | 笔尖导出时做 gamma 提亮（把深灰推向纯黑），alpha 更实 | 只解决"半透明" | 丢纹理层次；白底浮雕依然没有 |

**结论：PS 单支画笔无法完整复现**，因为缺的是一条颜色通道，不是某个开关。

---

## 7. 建议

1. **先做 D 的轻量版**：给 6 支笔加可选的「不透明度补偿」，把 alpha 曲线抬到接近实心 —— 立刻缓解「颗颗半透明」，且不依赖任何未校准的键名。
2. **再做 A 的实验支**：挑 1 支笔（impasto-detail）做纹理叠加版，与现有版并排放，你直接对比手感。参数键名需要真机校准（`texture` / `textureBlendMode` / `textureDepth` / `textureEachTip` 这一组）。
3. **B 留作对照**：如果 A 的观感仍达不到，用 B 做一支「双通道样板」，用来给 A 定标。
4. **不要指望在 PS 里还原 Krita 的 100%**。这不是能力问题，是引擎少一条通道。产品上更合理的定位是「在 PS 的画布上给出最接近的厚涂手感」，而不是「复刻 Krita」。

---

## 8. 相关踩坑（本轮已修，与本文独立）

- 灰度极性反了：PS 画笔遮罩 **黑=不透明、白=透明**，与 alpha 语义相反。
- `.gih` 每帧前有 29 字节帧头，漏算导致图像错位 116 字节（= 29px）。
- 详见 `refs/pixel-algorithms.md`。
