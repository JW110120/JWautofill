/**
 * 自绘下拉弹层（.mask-sync-select-pop）的挂载点。
 *
 * ⚠️ UXP 关键坑：插件文档里同时存在多个 <uxp-panel>（主面板里的 #app、
 * 像素调整面板里的 #pixeladjustment），而 UXP 只渲染「当前激活」的那一个
 * panel 子树。若把弹层 createPortal 到 document.body，它会落在所有
 * <uxp-panel> 之外，根本不会被绘制 —— 表现为「下拉菜单完全打不开」。
 *
 * 因此弹层必须挂到「所在面板的根容器」：
 *   - 仍在被渲染的子树内（能正常显示）；
 *   - 同时脱离面板内部各层叠上下文（.gradient-picker z-index:10、
 *     .pattern-picker z-index:9999 等），配合 .mask-sync-select-pop 的高
 *     z-index 才能真正盖在最上层，不再需要「展开时隐藏滑块数字」这类 hack。
 *
 * @param from 触发弹层的元素（下拉头部），用于定位它所属的面板；为空时回退到 #app。
 */
export function getPopRoot(from?: HTMLElement | null): HTMLElement {
  let node: HTMLElement | null = from ?? null;
  let panel: HTMLElement | null = null; // 兜底：所在面板元素本身
  while (node) {
    if (node.id === 'app' || node.id === 'pixeladjustment') return node;
    if (!panel && node.tagName && node.tagName.toLowerCase() === 'uxp-panel') panel = node;
    node = node.parentElement;
  }
  if (panel) return panel;
  const app = document.getElementById('app');
  if (app) return app;
  const adj = document.getElementById('pixeladjustment');
  if (adj) return adj;
  return document.body;
}
