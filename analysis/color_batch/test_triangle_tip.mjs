import { processBlockColorPatch } from '../../src/adjustments/blockColorPatchProcessor.ts';

// 针对性验证 v6.4：三角舌尖（与填充仅对角相邻）能被补满。
// 画布 30x30，全透明背景。
// 红填充 L 形，尖端在 (15,15)，一侧为线稿 (14,15)；
// 舌尖目标 T=(14,14) 仅与红对角相邻，其正交邻居 (14,15)=线、(15,14)=透明 →
// 4 邻域洪泛过不去（会留尖），8 邻域（墙角护栏允许单侧线）才补得上。
const W = 30, H = 30, N = W * H;
const rgba = new Uint8Array(N * 4);
const sel = new Uint8Array(N).fill(1);
const setPx = (x, y, r, g, b, a) => { const i = y * W + x; rgba[i*4]=r; rgba[i*4+1]=g; rgba[i*4+2]=b; rgba[i*4+3]=a; };

setPx(15, 15, 230, 14, 14, 255);
setPx(15, 16, 230, 14, 14, 255);
setPx(16, 16, 230, 14, 14, 255);
setPx(14, 15, 10, 10, 10, 255); // 线稿（舌尖一侧）
const T = 14 * W + 14;

const out = await processBlockColorPatch(rgba.buffer, sel.buffer, { width: W, height: H }, { lineColorMode: 'darker' });

const isRed = (i) => out[i*4+3] === 255 && Math.abs(out[i*4]-230) <= 6 && out[i*4+1] < 40 && out[i*4+2] < 40;
const tipFilled = isRed(T);

console.log('三角舌尖 T(对角相邻) 被填红 = ' + tipFilled + (tipFilled ? '  PASS(8邻域补舌尖，v6.3的4邻域会漏)' : '  FAIL(舌尖仍漏)'));
console.log('注：凹尖角/凹角"不泄漏"由 test_darkline_v2.mjs（3px厚线稿围死的口袋）验证，本测试不重复。');
