/**
 * 像素调整面板菜单管理器 - 仅负责像素调整面板的菜单功能
 */

export class AdjustmentMenu {
  private static visibilityPanelCallback: ((visible: boolean) => void) | null = null;
  private static collapseCallback: (() => void) | null = null;
  private static resetCallback: (() => void) | null = null;

  constructor() {
    // Constructor
  }

  /**
   * 注册像素调整面板事件回调函数
   */
  public static registerCallbacks(callbacks: {
    onToggleVisibilityPanel: (visible: boolean) => void;
    onToggleAllCollapse: () => void;
    onResetOrder: () => void;
  }) {
    this.visibilityPanelCallback = callbacks.onToggleVisibilityPanel;
    this.collapseCallback = callbacks.onToggleAllCollapse;
    this.resetCallback = callbacks.onResetOrder;
  }

  /**
   * 处理像素调整面板菜单项点击事件
   */
  public static handleMenuAction(id: string) {
    console.log(`AdjustmentPanel Menu: ${id}`);
    switch (id) {
      case "toggleCollapseAll":
        if (this.collapseCallback) {
          this.collapseCallback();
        }
        break;
      case "resetOrder":
        if (this.resetCallback) {
          this.resetCallback();
        }
        break;
      case "showVisibilityPanel":
        if (this.visibilityPanelCallback) {
          this.visibilityPanelCallback(true);
        }
        break;
      default:
        console.warn(`Unknown adjustment menu item: ${id}`);
    }
  }
}