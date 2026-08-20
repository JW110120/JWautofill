// 铅笔去锯齿 v2 算法验证（幂等性 + 对称过渡 + 半透明线 + 宽度守恒）
const INF = 0x3fffffff;
function edt8SSEDT(seeds, width, height, feature, outDist2, outFeature) {
  const n = width * height;
  outDist2.fill(INF);
  for (let i = 0; i < n; i++) { if (seeds[i] !== 0) { outDist2[i] = 0; outFeature[i] = feature[i]; } }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (outDist2[i] === 0) continue;
      if (x > 0) { const j = i - 1; const nd = outDist2[j] + 1; if (nd < outDist2[i]) { outDist2[i] = nd; outFeature[i] = outFeature[j]; } }
      if (x > 0 && y > 0) { const j = i - width - 1; const nd = outDist2[j] + 2; if (nd < outDist2[i]) { outDist2[i] = nd; outFeature[i] = outFeature[j]; } }
      if (y > 0) { const j = i - width; const nd = outDist2[j] + 1; if (nd < outDist2[i]) { outDist2[i] = nd; outFeature[i] = outFeature[j]; } }
      if (x + 1 < width && y > 0) { const j = i - width + 1; const nd = outDist2[j] + 2; if (nd < outDist2[i]) { outDist2[i] = nd; outFeature[i] = outFeature[j]; } }
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const i = row + x;
      if (x + 1 < width) { const j = i + 1; const nd = outDist2[j] + 1; if (nd < outDist2[i]) { outDist2[i] = nd; outFeature[i] = outFeature[j]; } }
      if (y + 1 < height) { const j = i + width; const nd = outDist2[j] + 1; if (nd < outDist2[i]) { outDist2[i] = nd; outFeature[i] = outFeature[j]; } }
      if (x > 0 && y + 1 < height) { const j = i + width - 1; const nd = outDist2[j] + 2; if (nd < outDist2[i]) { outDist2[i] = nd; outFeature[i] = outFeature[j]; } }
      if (x + 1 < width && y + 1 < height) { const j = i + width + 1; const nd = outDist2[j] + 2; if (nd < outDist2[i]) { outDist2[i] = nd; outFeature[i] = outFeature[j]; } }
    }
  }
}
function labelComponents(mask, distOut2, srcAlpha, width, height) {
  const n = width * height;
  const label = new Int32Array(n); label.fill(-1);
  const thinFlag = new Uint8Array(n);
  const q = new Int32Array(n);
  const THIN_MAXD2 = 2.25;
  const domainMax = [];
  let nextLabel = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i] === 0 || label[i] >= 0) continue;
    let head = 0, tail = 0, maxD2 = 0, maxA = 0;
    q[tail++] = i; label[i] = nextLabel;
    while (head < tail) {
      const cur = q[head++];
      if (distOut2[cur] > maxD2) maxD2 = distOut2[cur];
      const a = srcAlpha[cur]; if (a > maxA) maxA = a;
      const x = cur % width, y = (cur - x) / width;
      if (x > 0) { const j = cur - 1; if (mask[j] && label[j] < 0) { label[j] = nextLabel; q[tail++] = j; } }
      if (x + 1 < width) { const j = cur + 1; if (mask[j] && label[j] < 0) { label[j] = nextLabel; q[tail++] = j; } }
      if (y > 0) { const j = cur - width; if (mask[j] && label[j] < 0) { label[j] = nextLabel; q[tail++] = j; } }
      if (y + 1 < height) { const j = cur + width; if (mask[j] && label[j] < 0) { label[j] = nextLabel; q[tail++] = j; } }
    }
    domainMax.push(maxA);
    if (maxD2 <= THIN_MAXD2) for (let k = 0; k < tail; k++) thinFlag[q[k]] = 1;
    nextLabel++;
  }
  return { label, thinFlag, domainMax: new Float32Array(domainMax) };
}
function process(pixels, sel, W, H, opt = {}) {
  const softWidth = Math.max(1, Math.min(4, opt.softWidth ?? 2));
  const strength = opt.strength ?? 1;
  const alphaThreshold = opt.alphaThreshold ?? 128;
  const thinLineProtect = opt.thinLineProtect ?? true;
  const thinLineSmooth = opt.thinLineSmooth ?? 0.6;
  const N = W * H;
  const out = new Uint8Array(pixels);
  let minX = W, minY = H, maxX = -1, maxY = -1;
  const selValid = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!sel[i]) continue;
    selValid[i] = 1;
    const x = i % W, y = (i - x) / W;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return out;
  const alpha = new Uint8Array(N);
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const a = pixels[i * 4 + 3];
    alpha[i] = a;
    if (a >= alphaThreshold) mask[i] = 1;
  }
  const pad = Math.ceil(softWidth / 2) + 2;
  const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
  const x1 = Math.min(W - 1, maxX + pad), y1 = Math.min(H - 1, maxY + pad);
  const rw = x1 - x0 + 1, rh = y1 - y0 + 1, rn = rw * rh;
  const rMask = new Uint8Array(rn), rSel = new Uint8Array(rn), rAlpha = new Uint8Array(rn);
  for (let ry = 0; ry < rh; ry++) for (let rx = 0; rx < rw; rx++) {
    const di = (y0 + ry) * W + (x0 + rx), ri = ry * rw + rx;
    rMask[ri] = mask[di]; rSel[ri] = selValid[di]; rAlpha[ri] = alpha[di];
  }
  const seedIn = new Uint8Array(rn);
  for (let i = 0; i < rn; i++) if (rMask[i] === 1) seedIn[i] = 1;
  const distIn2 = new Int32Array(rn), packedInColor = new Int32Array(rn);
  const tmpPacked = new Int32Array(rn);
  for (let ry = 0; ry < rh; ry++) for (let rx = 0; rx < rw; rx++) {
    const ri = ry * rw + rx;
    if (rMask[ri] === 0) continue;
    const p = ((y0 + ry) * W + (x0 + rx)) * 4;
    tmpPacked[ri] = (pixels[p] << 16) | (pixels[p + 1] << 8) | pixels[p + 2];
  }
  edt8SSEDT(seedIn, rw, rh, tmpPacked, distIn2, packedInColor);
  const seedOut = new Uint8Array(rn);
  for (let i = 0; i < rn; i++) if (rMask[i] === 0 && distIn2[i] >= 3) seedOut[i] = 1;
  const distOut2 = new Int32Array(rn), bgAlpha = new Uint8Array(rn);
  edt8SSEDT(seedOut, rw, rh, rAlpha, distOut2, bgAlpha);
  let thinFlag = null, labelArr = null, domainMax = null;
  if (thinLineProtect) {
    const comp = labelComponents(rMask, distOut2, rAlpha, rw, rh);
    thinFlag = comp.thinFlag; labelArr = comp.label; domainMax = comp.domainMax;
  }
  const wEffMax = Math.max(softWidth, 1.5);
  const maxD2Screen = (0.5 + wEffMax + 1.5) * (0.5 + wEffMax + 1.5);
  const EDGE_ALPHA = 127.5;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  for (let ry = 0; ry < rh; ry++) for (let rx = 0; rx < rw; rx++) {
    const ri = ry * rw + rx;
    if (!rSel[ri]) continue;
    const inMask = rMask[ri] === 1;
    const d2 = inMask ? distOut2[ri] : distIn2[ri];
    if (d2 > maxD2Screen) continue;
    const dB = d2 === 1 ? 0.5 : (d2 === 2 ? 0.707 : Math.sqrt(d2) - 0.5);
    let aRecon;
    if (inMask) {
      if (thinFlag && thinFlag[ri] === 1) continue;
      const wEff = softWidth;
      if (dB > 0.5 + wEff) continue;
      const s = clamp01((dB - 0.5) / wEff);
      const aBody = domainMax ? domainMax[labelArr[ri]] : 255;
      aRecon = EDGE_ALPHA + (aBody - EDGE_ALPHA) * s;
    } else {
      if (dB > 1.5) continue;
      const s = clamp01(dB - 0.5);
      const bgA = bgAlpha[ri];
      aRecon = bgA + (EDGE_ALPHA - bgA) * (1 - s);
    }
    const di = (y0 + ry) * W + (x0 + rx), p = di * 4;
    const a0 = pixels[p + 3];
    const aTarget = Math.round(a0 + (aRecon - a0) * strength);
    const aF = Math.max(0, Math.min(255, aTarget));
    if (aF === a0) continue;
    let sr, sg, sb;
    if (inMask || a0 > 0) { sr = pixels[p]; sg = pixels[p + 1]; sb = pixels[p + 2]; }
    else { const pk = packedInColor[ri] | 0; sr = (pk >> 16) & 255; sg = (pk >> 8) & 255; sb = pk & 255; }
    if (aF <= 0) { out[p] = 0; out[p+1] = 0; out[p+2] = 0; out[p+3] = 0; continue; }
    out[p] = sr; out[p + 1] = sg; out[p + 2] = sb; out[p + 3] = aF;
  }
  return out;
}
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function grid(pixels, W, H, label) {
  console.log('  ' + label);
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) {
      const a = pixels[(y * W + x) * 4 + 3];
      row += (a === 0 ? '.' : a >= 250 ? '█' : a >= 150 ? '▓' : a >= 60 ? '▒' : '░');
    }
    console.log('  ' + row);
  }
}
function makeSlant(W, H, color, a, halfW) {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (Math.abs(x - (y + 3)) <= halfW) { const p = (y * W + x) * 4; px[p]=color[0]; px[p+1]=color[1]; px[p+2]=color[2]; px[p+3]=a; }
  return px;
}


{
  const W = 16, H = 16;
  const sel = new Uint8Array(W * H).fill(255);
  const px = makeSlant(W, H, [30,30,30], 255, 4);
  // 打印 y=0 行的原始与处理后 alpha，以及中心像素（x=3）的诊断
  const out = process(px, sel, W, H, {});
  console.log('y=0 原始 alpha: ', Array.from({length:12},(_,x)=>px[(0*W+x)*4+3]).join(' '));
  console.log('y=0 处理后 alpha:', Array.from({length:12},(_,x)=>out[(0*W+x)*4+3]).join(' '));
  // 手动计算中心像素 (x=3,y=0) 的 distOut2
  const N = W*H;
  const alpha = new Uint8Array(N), mask = new Uint8Array(N);
  for (let i=0;i<N;i++){ const a=px[i*4+3]; alpha[i]=a; if(a>=128) mask[i]=1; }
  // 统计 mask 内像素的 distOut2（简化：直接对 bbox 全图）
  const rw=16, rh=16, rn=256;
  const rMask = new Uint8Array(rn), rAlpha = new Uint8Array(rn);
  for (let i=0;i<N;i++){ rMask[i]=mask[i]; rAlpha[i]=alpha[i]; }
  const seedIn = new Uint8Array(rn);
  for (let i=0;i<rn;i++) if (rMask[i]===1) seedIn[i]=1;
  const distIn2 = new Int32Array(rn), packedInColor = new Int32Array(rn);
  const tmpPacked = new Int32Array(rn);
  for (let ry=0;ry<rh;ry++) for (let rx=0;rx<rw;rx++) {
    const ri = ry*rw+rx;
    if (rMask[ri]===0) continue;
    const p = (ry*W+rx)*4;
    tmpPacked[ri] = (px[p]<<16)|(px[p+1]<<8)|px[p+2];
  }
  edt8SSEDT(seedIn, rw, rh, tmpPacked, distIn2, packedInColor);
  const seedOut = new Uint8Array(rn);
  for (let i=0;i<rn;i++) if (rMask[i]===0 && distIn2[i]>=3) seedOut[i]=1;
  const distOut2 = new Int32Array(rn), bgAlpha = new Uint8Array(rn);
  edt8SSEDT(seedOut, rw, rh, rAlpha, distOut2, bgAlpha);
  const ri = 0*16+3; // x=3,y=0 中心
  const d2 = distOut2[ri];
  console.log('中心(x=3,y=0): mask=' + rMask[ri] + ' distOut2=' + d2 + ' dB=' + (Math.sqrt(d2)-0.5));
  console.log('mask 行 y=0..2 (x 0..11):');
  for (let yy=0;yy<3;yy++){ let row=''; for(let xx=0;xx<12;xx++) row += rMask[yy*16+xx]?'█':'.'; console.log('  y='+yy+' '+row); }
  // 检查 distIn2 网格
  console.log('distIn2 网格 (y=0..2, x=0..11):');
  for (let yy=0;yy<3;yy++){ let row=''; for(let xx=0;xx<12;xx++) row += String(distIn2[yy*16+xx]).padStart(3); console.log('  y='+yy+' '+row); }
}
