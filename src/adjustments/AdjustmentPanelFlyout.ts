/**
 * Flyout菜单配置 - 用于像素调整面板
 * 提供折叠/展开、复位、隐藏/显示分区功能
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { entrypoints } = require("uxp");

export class AdjustmentPanelFlyout {
  private static visibilityPanelCallback: ((visible: boolean) => void) | null = null;
  private static collapseCallback: (() => void) | null = null;
  private static resetCallback: (() => void) | null = null;

  // 主面板 APP 的回调
  private static appOpenLicenseCallback: (() => void) | null = null;
  private static appResetLicenseCallback: (() => void) | null = null;

  constructor() {
    // Constructor
  }

  /**
   * 注册事件回调函数（像素调整面板）
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
   * 注册主面板（App）菜单回调
   */
  public static registerAppCallbacks(callbacks: {
    onOpenLicenseDialog: () => void;
    onResetLicense: () => void;
  }) {
    this.appOpenLicenseCallback = callbacks.onOpenLicenseDialog;
    this.appResetLicenseCallback = callbacks.onResetLicense;
  }

  /**
   * 处理像素调整面板菜单项点击事件
   */
  private static handleFlyout(id: string) {
    console.log(`AdjustmentPanel Flyout: ${id}`);
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
        console.warn(`Unknown flyout menu item: ${id}`);
    }
  }

  /**
   * 处理主面板（App）菜单项点击事件
   */
  private static handleAppFlyout(id: string) {
    console.log(`App Flyout: ${id}`);
    switch (id) {
      case "resetLicense":
        if (this.appResetLicenseCallback) {
          this.appResetLicenseCallback();
        }
        break;
      case "openLicenseDialog":
        if (this.appOpenLicenseCallback) {
          this.appOpenLicenseCallback();
        }
        break;
      default:
        console.warn(`Unknown app flyout menu item: ${id}`);
    }
  }

  /**
   * 设置UXP入口点和菜单项
   */
  public static setup(): void {
    entrypoints.setup({
      panels: {
        // 主面板（App）的flyout菜单配置
        "com.listen2me.jwautofill": {
          show() {
            console.log("JW AutoFill Panel shown");
          },
          menuItems: [
            {
              id: "resetLicense",
              label: "重置激活状态（仅调试）"
            },
            {
              id: "openLicenseDialog",
              label: "打开激活与试用面板"
            }
          ],
          invokeMenu(id: string) {
            AdjustmentPanelFlyout.handleAppFlyout(id);
          }
        },
        // 像素调整面板的flyout菜单配置
        "com.listen2me.pixeladjustment": {
          show() {
            // 面板显示时的初始化代码
            console.log("Adjustment Panel shown");
          },
          menuItems: [
            {
              id: "toggleCollapseAll",
              label: "折叠/展开所有分区"
            },
            {
              id: "resetOrder", 
              label: "复位分区顺序"
            },
            {
              id: "spacer1",
              label: "-" // 分隔符
            },
            {
              id: "showVisibilityPanel",
              label: "隐藏/显示分区"
            }
          ],
          invokeMenu(id: string) {
            AdjustmentPanelFlyout.handleFlyout(id);
          }
        }
      }
    });
  }
}