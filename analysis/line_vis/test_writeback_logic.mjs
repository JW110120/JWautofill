// 验证 lineSmoothProcessor 新写回逻辑的三种关键情形（独立于 SDF，直接复刻分支判断）
// 复刻 src/adjustments/lineSmoothProcessor.ts 的 Phase E.5 + 写回 na==0 分支。

const THR = 16;

function decideClear({ na, isSpeck, compCovered, hasEmptyNbr }) {
  if (na > 0) return false; // 输出>0 不会进入清除分支
  if (!(isSpeck || compCovered)) return false; // 未被 SDF 覆盖的大分量（极细线）→ 保留
  if (!hasEmptyNbr) return false;              // 被输出>0 完全包围（线条内部孔洞）→ 保留
  return true;                                  // 近外部残留 / 杂点 → 清除
}

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got=${got} want=${want}`); }
}

// 情形 1：线条变细后，原线残留在「近外部」—— na==0, 属已覆盖大分量, 有背景空位 → 应清除
check('近外部游离残留(已覆盖大分量+空位)', decideClear({ na: 0, isSpeck: false, compCovered: true, hasEmptyNbr: true }), true);

// 情形 2：SDF 平滑后线条内部留下的 1px 孔洞 —— na==0, 已覆盖, 但被输出>0 完全包围(无空位) → 保留
check('线条内部孔洞(已覆盖+无空位)', decideClear({ na: 0, isSpeck: false, compCovered: true, hasEmptyNbr: false }), false);

// 情形 3：小杂点分量（铅笔屑）—— na==0, isSpeck
//   背景中的杂点有空位 → 清除；被粗线覆盖完全包裹(无空位)的杂点隐藏在线下，无害 → 保留（与代码一致）
check('小杂点(背景,有空位→清除)', decideClear({ na: 0, isSpeck: true, compCovered: false, hasEmptyNbr: true }), true);
check('小杂点(被粗线包裹,无空位→保留,无害)', decideClear({ na: 0, isSpeck: true, compCovered: false, hasEmptyNbr: false }), false);

// 情形 4：极细线，SDF 完全未覆盖（compCovered=false, 非杂点）—— na==0 → 保留，避免误删真实细线
check('极细线(SDF未覆盖,非杂点)', decideClear({ na: 0, isSpeck: false, compCovered: false, hasEmptyNbr: true }), false);

// 情形 5：正常原线像素被平滑保留 na>0 —— 不清除（主分支）
check('正常输出像素(na>0)', decideClear({ na: 100, isSpeck: false, compCovered: true, hasEmptyNbr: true }), false);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
