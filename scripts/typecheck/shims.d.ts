/* 类型检查专用垫片（**不参与打包**，只在 `npx tsc -p tsconfig.check.json` 时生效）。
 *
 * 为什么需要它：项目里 `import { app } from 'photoshop'` 与 `from 'uxp'` 这两个模块
 * 在 node_modules 里**没有任何类型声明**，于是 `tsc` 一上来就报一堆 TS2307。
 * 而 `node_modules/@types/node` 里用了 `<const T>`（TS 5.0 语法），当前 TS 版本解析不了，
 * 整个编译单元先报语法错 —— **语义检查就被静默跳过了**。
 * 结果是：`tsc --noEmit` 常年"src 零错"，其实连未定义的变量都查不出来
 * （2026-10-22 就因为把 `DEGRADE_MIN_SIDE` 连带删掉而毫无提示）。
 *
 * ⇒ 用最宽松的 ambient 声明把这两个模块垫成 any，语义检查就能跑起来：
 *    未定义标识符、拼错的成员名、类型不匹配 —— 这些真错都在这一层被抓到。
 */
declare module 'photoshop';
declare module 'uxp';
