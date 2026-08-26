# JWautofill 项目长期记忆

## UXP / React 关键知识点（踩坑记录）

- **`action.addNotificationListener / removeNotificationListener` 第一个参数必须是字符串数组**（如 `['set','select','clearEvent','delete','make']`）。传单个字符串会抛 `Argument 1 has an invalid type. Expected type: array actual type: string`，监听完全注册失败。若要逐个注册容错，也必须包成 `[evt]` 数组。正确范例：src/app.tsx。
- **React 19 dev 构建在 UXP 中不能直接渲染**：其渲染流程调用 `performance.mark(name, {detail})` / `performance.measure(...)`，UXP 内置 Performance 不支持对象 options 且 measure 要求起点 mark 已注册 → 首次渲染抛 `NotFoundError: The mark [object Object] does not exist` → 渲染中断后 root 状态残留 → 之后全部渲染报 `Should not already be working.` 面板白屏。**解法**：入口最先 import `src/uxpPerfPatch.ts`（容错包装 mark/measure/clearMarks/clearMeasures）。Production 构建无此问题。
- **往 PS 里加载产物**：`yarn build`（production）最稳；`yarn watch`（dev）现在有 uxpPerfPatch 兜底可用，但 PS 端需手动重新加载插件才能拿到新 bundle。
- 仓库统一 LF（.gitattributes `* text=auto eol=lf` + `*.otf binary`）；改行符会引起 UXP 热重载竞态。

## 面板/入口结构

- 两个面板入口都在 src/index.tsx：`#app`（App 主面板）+ `#pixeladjustment`（AdjustmentPanel 像素调整）。菜单在 MenuManager.setup()。
- 蒙版同步引擎 src/utils/MaskSyncEngine.ts（单例，事件驱动+2s 兜底轮询，按文档名持久化到 mask-sync-state.json）。

## 分块补色（blockColorPatchProcessor.ts）

- v5 算法（2026-08-22）：同层/分层兼顾。cand = alpha>16 | 距填充≤1 | (线稿内部且联合掩码8邻域实体==9 尖角孔洞)；线稿内部 R 优先全提升；close(2)+holeFill 后 D≥2 提升 + D==1 尖角(实体≥7 或 alpha≥80)。
- **距离语义坑**：`distanceToBackground`（背景=0）≠ 到掩码距离。cand 约束必须用 `distanceToMask`（掩码内=0）。Python 原型验证时禁用 `if good==fill: continue`（ground truth 作弊）。
- **R 不能排除线稿描边**（尖角头部在描边内）；但"线稿内部 fill=0"只提升被完全包围（nbr==9）的孔洞，防描边边缘误填。
- 指标（TS 端到端）：分层 补全区 100%/背景 99.0%/尖角 100%；同层 补全区 100%/背景 98.99%/尖角 100%。
- UI：**同层补色/分层补色** 两按钮；线稿下拉复用 MaskSyncSelect（蒙版同步同款样式）；readLineLayerAlphaMask 用 imgData 实际尺寸算 comps。

## 线条平滑（lineSmoothProcessor.ts）

- **「保留原值」写回陷阱**：Phase E 里 `na==0 不写、保留原值` 是防主线被误删成孔洞的，但它也会把**原图游离杂点**（alpha>THR、被 binaryOpen 移除、cov≈0 已清空）原样写回 → 线外黑点残留。**任何"清除某类像素"的逻辑必须显式清零，不能依赖 strokeAlpha==0 就以为删掉了**。
- 游离杂点判定：对原 `lineMask` 做 8 连通域分析，面积 < `SPECK_MAX=10` 且与主线条不连通 → 杂点；写回时连 RGB 一起清零（Phase A.5 + Phase E）。
- 测试指标注意：`alpha[i] <= THR && outA[i] > THR` 只统计「新生成」像素，**检测不到原杂点存活**；要加「杂点像素集合输出仍>THR」的指标。

## 扣白/扣黑（knockoutBatchProcessor.ts，2026-08-26 重构为 batchPlay 版）

- **核心思路**（用户手动验证）：合并图 Ctrl+点击 RGB 复合通道载入亮度选区 → Delete 清除亮部（alpha *= 1−亮度）→ 复制 N 份合并（alpha 按 1−(1−a)^N 增强）。**像素级无法还原原图层（欠定）**，实质是"放回原背景视觉一致"。
- **扣黑偏暗根因**：黑底合成 `Z_rgb = X_rgb·a` 是预乘暗色（复制合并不改 RGB）；且 Z 上内容亮度低 → 单份 alpha 小 → 固定 7 份远不够收敛（黑底暗色对 alpha 误差敏感）。白底扣白因 RGB 接近白、对误差不敏感所以"看起来行"。
- **扣黑纠正 = 反色法**：Z --Invert--> Z'(=反色X的白底合成) → 扣白流程 → Invert 回来；**份数 N 动态** = ceil(ln0.005/ln(1−aMin))，aMin = 选区灰度(∈(0,255))对应 alpha 的 5% 分位，clamp [3,40]。案例红圆 N=23（用户 7 份视觉差 22.5/255 → 动态后 0.48/255）。
- **batchPlay 命令速查**：载入通道选区 `{_obj:'set',_target:[{_ref:'channel',_property:'selection'}],to:{_ref:'channel',_enum:'channel',_value:'RGB'}}`；Delete `{_obj:'clear'}`；反色 `{_obj:'invert'}`（只反 RGB 不动 alpha）；复制+向下合并用 UXP DOM `Layer.duplicate()`/`Layer.merge()`（官方 API 比 batchPlay mergeLayers 稳）。
- **适用性**：扣白适合深/中色内容，扣黑适合浅/中色内容（对比度决定可恢复性，信息论极限）。
- 验证脚本：analysis/knockout/{sim_knockout.py, sim_invert_fix.py, whole_image_sim.py}；对比图 analysis/knockout/knockout_verify.html。
