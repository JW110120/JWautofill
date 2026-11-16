/**
 * 面板动态菜单项的**唯一写入口**（label / enabled）。
 *
 * 为什么单独抽出来：UXP 的动态菜单更新要按「面板 id + 菜单项 id」去
 * `entrypoints.getPanel(id).menuItems` 上取到那一项再改属性，而不同宿主版本上
 * 取项的 API 名字并不统一（getItem / updateItem / 直接改数组），这套兼容写法
 * 现在被 **两个** 菜单分发器共用：
 *   · `MenuManager`（选区填充 #app 的 flyout）；
 *   · `AdjustmentMenu`（绘画工具箱 #pixeladjustment 的 flyout）。
 * 各写一份必然漂移（改了一处兼容逻辑忘了另一处），故收成一处。
 *
 * ⚠️ 全部失败也只是「菜单项保持旧文案/旧可用态」，调用方无需处理返回值。
 */
export type PanelMenuPatch = { enabled?: boolean; label?: string };

export function updatePanelMenuItem(panelId: string, id: string, patch: PanelMenuPatch): void {
  try {
    const ep: any = (require('uxp') as any).entrypoints;
    const panel: any = ep && typeof ep.getPanel === 'function' ? ep.getPanel(panelId) : null;
    const menuItems: any = panel && (panel as any).menuItems;
    if (!menuItems) return;

    const applyTo = (item: any): boolean => {
      if (!item) return false;
      if (patch.enabled !== undefined) item.enabled = patch.enabled;
      if (patch.label !== undefined) item.label = patch.label;
      return true;
    };

    // 官方动态更新方式：getItem(id) 取到菜单项后直接改属性
    if (typeof (menuItems as any).getItem === 'function') {
      if (applyTo((menuItems as any).getItem(id))) return;
    }
    if (typeof (menuItems as any).updateItem === 'function') {
      (menuItems as any).updateItem(id, patch);
      return;
    }
    const list: any[] = Array.isArray(menuItems) ? menuItems : ((menuItems as any).items || []);
    applyTo(list.find((it: any) => it && it.id === id));
  } catch (err) {
    console.warn(`更新菜单项 ${id} 状态失败:`, err);
  }
}
