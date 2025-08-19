/**
 * 通用菜单管理器 - 负责UXP入口点设置和主面板菜单功能
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { entrypoints } = require("uxp");

import { AdjustmentMenu } from './AdjustmentMenu';

export class MenuManager {
  // 主面板 APP 的回调
  private static appOpenLicenseCallback: (() => void) | null = null;
  private static appResetLicenseCallback: (() => void) | null = null;
  private static appResetParametersCallback: (() => void) | null = null;

  constructor() {
    // Constructor
  }

  /**
   * 注册主面板（App）菜单回调
   */
  public static registerAppCallbacks(callbacks: {
    onOpenLicenseDialog: () => void;
    onResetLicense: () => void;
    onResetParameters: () => void;
  }) {
    this.appOpenLicenseCallback = callbacks.onOpenLicenseDialog;
    this.appResetLicenseCallback = callbacks.onResetLicense;
    this.appResetParametersCallback = callbacks.onResetParameters;
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
      case "resetAppParameters":
        if (this.appResetParametersCallback) {
          this.appResetParametersCallback();
        }
        break;
      default:
        console.warn(`Unknown app flyout menu item: ${id}`);
    }
  }

  /**
   * 处理像素调整面板菜单项点击事件 - 委托给 AdjustmentMenu
   */
  private static handleAdjustmentFlyout(id: string) {
    try {
      if (!id) {
        console.warn("Adjustment Flyout: missing menu id");
        return;
      }
      console.log(`Adjustment Flyout: ${id}`);
      // 委托给专门的 AdjustmentMenu 处理
      AdjustmentMenu.handleMenuAction(id);
    } catch (err) {
      console.error("Error handling adjustment flyout menu:", err);
    }
  }

  /**
   * 设置UXP入口点和菜单项
   */
  public static setup(): void {
    // 防止在热更新或多次执行时重复注册菜单
    const g: any = globalThis as any;
    if (g.__JW_MENU_SETUP_DONE__) {
      console.log("MenuManager.setup skipped (already done)");
      return;
    }

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
            },
            {
              id: "resetAppParameters",
              label: "参数复位（保留已加载图案与新建渐变预设）"
            }
          ],
          invokeMenu(id: string) {
            MenuManager.handleAppFlyout(id);
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
            },
            {
              id: "resetParameters",
              label: "参数复位（还原所有像素调整参数）"
            }
          ],
          invokeMenu(id: string) {
            MenuManager.handleAdjustmentFlyout(id);
          }
        }
      }
    });

    g.__JW_MENU_SETUP_DONE__ = true;
  }
}