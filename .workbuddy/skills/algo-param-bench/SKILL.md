---
name: algo-param-bench
description: 用真实素材对拍图像算法的候选公式与参数，产出可复现脚本和定量结论，而不是"看起来还行"的主观判断。当需要给像素算法定参、比较候选映射函数、验证某个模式（如分块平均/加权模式/对比压缩）的真实效果、或用户提供截图要求验证算法行为时使用。
agent_created: true
---

# 图像算法参数对拍（真实素材 + 定量结论）

适用：为图像处理算法选公式、定默认参数、验证某个"模式"到底做了什么。
不适用：纯 UI/样式改动，或没有真实素材可测的纯理论讨论。

## 铁律（踩过的坑）

1. **bash 可用，但 `Edit` 不可信** — Git Bash 下 `ls`/`grep`/`head`/管道/`python - <<PY` 都正常
   （2026-09-18 复测；早期"缺 coreutils"的结论已过时）。真正的坑是 **Edit 工具在本仓库经常"报成功但没落盘"**
   （多点、多行修改尤其明显，本轮 3 次里中招 1 次）。**每次改完必须 `grep` 逐串复核**；
   改动多时直接 `Write` 整文件重写，或用 Python 读改写（`assert old in s` 后再 `replace`，
   写回统一 `newline='\n'`，本仓库行尾是 LF）。
2. **解码 PNG**：Python 侧用 PIL（`C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe`，
   已装 Pillow 12）；Node 侧直接复制下面的解码器，不要 `npm i pngjs`（这个仓库的 node_modules 是 UXP 用的，别污染）。
3. **素材路径**：用户粘贴的截图在 `C:\Users\Administrator\.workbuddy\clipboard-images\clipboard-<ISO>-<hash>.png`，
   用 Glob 取最新的那个；不要凭文件名猜。
4. ⚠️ **扫描网格上限必须等于实测数据最大值，不能外扩**。`max − end` 型指标（"是否单调""反转量"）
   在定义域两端不一致时会算出假值 —— 曾把真实的 0.00 报成 37.62，且看起来完全合理。
   **所有单调性/极值指标，先断言网格两端 == 数据两端。**
5. **度量必须分档**。只报全图平均会把"背景几乎不动、特征被重压"这类效果完全抹平。
   先按偏离量分档（背景带 / 过渡带 / 特征带），每档单独报"改动级数"和"改动百分比"。
6. **先解析推、再数值验，两者必须一致**。不一致就是脚本 bug，不要相信数值。
   例：`out = u·(1 − s·g(u))` 的单调条件是 `1 − s·(g + u·g') ≥ 0`，可解析求 s 的上界，再拿数值对照。
7. **脚本落盘到项目 `outputs/`** 并用 present_files 交付，用户要能自己重跑和对拍 before/after。
8. 度量口径要按源码原样复刻：容差、通道数（单通道 vs 四通道平方和）、`|0` 截断这些细节会改结论。
9. ⚠️ **JS 参数遮蔽会静默算错**：像素脚本里 `r,g,b` 是常用参数名，若同一个函数签名里还有 `a,b` 当阈值/端点，
   `b` 会覆盖蓝通道 —— 结果只是「数值温和地不对」，不报错、不崩。**阈值一律叫 `a0,b0,lam`**。
   本项目曾在一个脚本里连踩两次（函数形参一次、循环 lambda 的 `[a0,b0]` 解构一次），两次都表现为「效果似乎很小」。
10. **候选「方向」先由硬约束裁决，再讨论形态**。用户的质量条件（如「压缩后大小关系不能变」= 映射严格单调）
   常常直接砍掉一半方向：本项目「保护小偏离像素」的方向在斜率上必然逆序（a≥1.5 时实测 144~6253 个逆序点），
   根本不用看它好看不好看。
11. **否定一条实现路线时，要算出它对「目标之外」的影响**，别只讲道理。本项目否决 batchPlay 复制+合并路线时，
   除 alpha 通胀（可解析证明）外，还实测出「选区外灰值 100 会被抬亮 42–69 级」——比 alpha 更有说服力。

## 算法级对拍：绕开 PS，直接跑 TS 源

看截图只能看结果，定位不到"哪个像素被改成了什么"。算法类问题（斑驳 / 条纹 / 对齐不彻底 / 花屏）
走这条闭环，`outputs/` 下已有可复用脚本（已 gitignore，仅本机）：

1. `python outputs/aa_img.py dump <png> <out.raw> <meta.json>` —— PIL 解码成裸 RGBA。
2. `node outputs/aa_run.cjs <src.raw> <w> <h> <mode>` —— **用 `typescript.transpileModule`
   把 `src/adjustments/*.ts` 现场编译后 require 真函数**（保证与插件同源，不要手抄一份算法），
   跑完输出裸 RGBA + 指标 + 关键 console 日志。
3. `python outputs/aa_img.py comp <out.raw> <w> <h> <srcpng> <o.png> <scale>` —— 回合成垫纯白 PNG 肉眼看；
   `python outputs/aa_diag.py down up` —— 定位"斑驳"像素，并打印局部区块的 `源 alpha / 结果 alpha` 对照表
   （这是最有用的一步：能直接看出"相邻像素被拉到了不同层级"）。
4. `python outputs/aa_compare.py` —— 出多面板 before/after 对比图
   （PIL + `C:\Windows\Fonts\msyh.ttc` 可画中文标签）。

⚠️ **先用用户给的截图复现**：本轮复现图与用户截图逐点一致后才开始改 —— 否则所有结论都是猜的。

### 三个够用的度量（远好于"看起来还行"）
- **一阶差分粗糙度** = `mean(|a(x,y) − a(x±1,y)|)`（alpha>0 像素，横/纵分开）。斑驳与条纹的直接代理量。
- **3×3 中位数离群点占比** = `|a − median(3×3)| ≥ 20` 的比例。专抓棋盘格式斑驳。
- **直方图不同值数** + **输出均值 vs 选区众数**：一眼判断"对齐是否彻底、落到了哪一层"。

### 逐像素参照类算法的通病（本项目 alpha 对齐 v5 踩到）
逐像素**独立**估计参照 → 邻域内相邻像素选中不同层级（实测 73 / 157 交替）→ 斑驳；
沿笔触方向连成线就是条纹；大量像素判为"不改"→ 对齐不彻底。
**修法不是再调阈值，而是给参照场加一次"窗口共识"**：窗口内出现次数达标的参照取极值
（下对齐取最低、上对齐取下中位数），并对"没拿到参照"的像素按落差补判。
补判门槛取 `参照量程/2` 这类**有语义的锚点**，不要选扫描出来的数值最优 —— 那是在过拟合单张素材。

## 标准流程

1. Glob 找素材 → 解码 → 打印尺寸/均值/σ 与偏离分布直方图（先确认素材范围，比如是否含面板 UI）。
2. 定分档阈值（看直方图的谷底；天然可分才用单指标判据）。
3. 参数扫描：一维网格扫每个候选参数，对每个取值报**分档改动幅度 + 百分比 + 区分比**。
4. 传输曲线：`原始偏离 → 处理后的偏离`，把"背景带"和"特征带"标出来。这比任何指标都好读。
5. 单调性/伪影检查：扫定义域找极值点，报反转量；同时给出解析临界值互相印证。
6. 落盘脚本 + 输出 markdown 表格，给出"推荐值 + 为什么，以及不要选其他值的原因"。

## PNG 解码器（8bit、非隔行；复制即用）

```js
const fs = require('fs'), zlib = require('zlib');
function loadPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, bd = 0, ct = 0, il = 0, plte = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const d = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; il = d[12]; }
    else if (type === 'PLTE') plte = Buffer.from(d);
    else if (type === 'IDAT') idat.push(Buffer.from(d));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8 || il !== 0) throw new Error('只支持 8bit 非隔行');
  const chN = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * chN, px = new Uint8Array(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++], line = raw.subarray(p, p + stride); p += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= chN ? cur[i - chN] : 0, b = prev ? prev[i] : 0, c = (prev && i >= chN) ? prev[i - chN] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
  }
  const at = (x, y) => { const i = y * stride + x * chN;
    if (ct === 2 || ct === 6) return [px[i], px[i + 1], px[i + 2]];
    if (ct === 0 || ct === 4) return [px[i], px[i], px[i]];
    const q = px[i] * 3; return [plte[q], plte[q + 1], plte[q + 2]]; };
  return { w, h, at };
}
```

内缩 6px 避开截图外框；亮度用 `0.299R + 0.587G + 0.114B`。
**判据用亮度、RGB 欧氏 RMS ≈ √3×σ_L 说明偏离全在明度轴上时才成立**（先验证这条再简化）。

## 分档度量的写法

```js
const mAbs = (arr, f) => arr.reduce((s, d) => s + Math.abs(f(d)), 0) / arr.length;
// 每档同时报：绝对改动级数 与 改动百分比 —— 百分比暴露"选择比"，级数暴露"是否看得见"
console.log(`背景 ${mAbs(bg, f).toFixed(2)}级/${(mAbs(bg,f)/mAbs(bg,d=>d)*100).toFixed(0)}%`);
```

**"选择比" = 特征带压缩率 / 背景带压缩率**，是判断"只压特征、不动背景"是否达成的核心指标；
不要用"剩余偏离之比"，那个方向相反，容易读反。

## 已知结论（本项目）

分块平均的「对比减弱」：`k = coeff/255 × s × t/(1+t)`，`t = u/τ`，`u = |亮度 − 所在连通块均值亮度|`，`τ = max(σ_L, 6)`。
**p 固定 = 1（不暴露给用户）**，**`s = 强度 × 0.07`**（强度 1–10 → k 上限 7%–70%）。
p=1 时严格单调（`1 + (1−s)(2t + t²) > 0` 对 `s ≤ 1` 恒成立），压缩后偏离大小关系不变 —— 这是用户的硬条件。
（p=1.5 / p=2 在 s 接近 1 时会让深像素反转，已弃用。）详见 `.workbuddy/memory/MEMORY.md` 与当日日志。

混合颜色带柔化：`phi = 1 − λ·clamp((u − 1.5σ)/4.5σ, 0, 1)`，`λ = 柔化级/10`，
RGB 用 `1 − w·k·phi`，alpha 用 `1 − w·k`（不乘 phi）。功能上等价于「把减弱结果与原始按 phi 混合」。
两条已证实的取舍：
- **必须有平台段**（`u ≤ 1.5σ` 时 phi=1）。照 PS 原参数把四个手柄收到均值（平台宽 0、端点 0/255）会让
  背景压缩从 24% 掉到 5%，且强度随选区均值在色阶中的位置漂移 —— 端点固定的斜坡不能照搬进「偏离归一化」的公式。
- **柔化与选择比是对冲的**：把「偏离大的像素」保留回来，正是差值驱动机制的产出，二者不可兼得。
  本图实测线条带保留率从 51%（无柔化）→ 61%（λ=1），选择比 2.04 → 1.62。

## 已知结论（本项目 · alpha 对齐）

`src/adjustments/alphaAlignProcessor.ts` v5：局部多尺度环带参照 + **参照场窗口共识**
（`REF_CONSENSUS_RADIUS=6`、`REF_CONSENSUS_SUPPORT=3`、补判门槛 `REF_FILL_PROTECTED_DELTA=BRIGHT_GAP/2`）
+ 新增**众对齐**（选区内 alpha>0 直方图众数，全部对齐到它）。
两处"串层"修复值得记住：①平坦判据必须用**绝对数**（`nearCount ≥ 4`），占比判据会被远处另一层的高值带飞；
②上对齐必须加"本层邻域"护栏（`bandMax > a + BRIGHT_GAP` 的尺度跳过），下对齐不能加（它往低处找"周围水平"）。
实测（实验.png 全文档选区）：下对齐粗糙度 10.56/8.89 → 7.23/5.16、离群点 284 → 171；
上对齐（12.44/9.79 → 12.01/9.09）不再恶化；众对齐粗糙度 0.000、不同值数 2。

## 三条标定铁律

1. **滑块上限用解析锚点定，不要用某个分档百分比去凑**。换曲线形状（p）之后，
   「k 上限相等」和「各分档压缩百分比相等」不可能同时成立，只能守恒一个；守恒 k 上限语义才稳定。
2. **大数组不要用 spread 求极值**：`Math.max(...arr)` 在 20 万元素时抛
   `RangeError: Maximum call stack size exceeded`，改用循环累计。
3. **先问清「有没有质量约束」**（如"顺序/大小关系不能变"）。这类约束往往直接排除掉一半候选公式，
   比事后调参便宜得多 —— 本项目就是靠它把 p 从 1.5 定到 1。
