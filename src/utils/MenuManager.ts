/**
 * 通用菜单管理器 - 负责UXP入口点设置和主面板菜单功能
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { entrypoints } = require("uxp");

import { AdjustmentMenu } from './AdjustmentMenu';
import { LicenseManager } from './LicenseManager';
import { openPluginDoc } from './openDocs';

export class MenuManager {
  // 主面板 APP 的回调
  private static appOpenLicenseCallback: (() => void) | null = null;
  private static appResetLicenseCallback: (() => void) | null = null;
  private static appResetParametersCallback: (() => void) | null = null;
  private static appSetMainHotkeyCallback: (() => void) | null = null;
  // 是否已正式激活（试用不算）：决定「注销激活状态」菜单项能否点击
  private static appLicenseActive: boolean = false;

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
    onSetMainHotkey?: () => void;
  }) {
    this.appOpenLicenseCallback = callbacks.onOpenLicenseDialog;
    this.appResetLicenseCallback = callbacks.onResetLicense;
    this.appResetParametersCallback = callbacks.onResetParameters;
    this.appSetMainHotkeyCallback = callbacks.onSetMainHotkey ?? null;
  }

  /**
   * 同步「注销激活状态」菜单项的可用状态。
   * 规则：仅正式激活后可点击；未激活与试用状态下均为禁用。
   * 说明：UXP 动态更新菜单项走 getPanel(id).menuItems.getItem(id) 后直接改属性；
   *       不同版本 API 名称不统一，故依次尝试 getItem → updateItem → 直接改数组项，
   *       全部失败也只是菜单项保持旧状态（handler 里还有一层拦截）。
   */
  public static setLicenseLogoutEnabled(active: boolean): void {
    this.appLicenseActive = !!active;
    try {
      const ep: any = (require("uxp") as any).entrypoints;
      const panel: any = ep && typeof ep.getPanel === "function"
        ? ep.getPanel("com.listen2me.jwautofill")
        : null;
      const menuItems: any = panel && (panel as any).menuItems;
      if (!menuItems) return;

      // 官方动态更新方式：getItem(id) 取到菜单项后直接改属性
      if (typeof (menuItems as any).getItem === "function") {
        const item = (menuItems as any).getItem("resetLicense");
        if (item) {
          item.enabled = !!active;
          return;
        }
      }
      if (typeof (menuItems as any).updateItem === "function") {
        (menuItems as any).updateItem("resetLicense", { enabled: !!active });
        return;
      }
      const list: any[] = Array.isArray(menuItems) ? menuItems : ((menuItems as any).items || []);
      const item = list.find((it: any) => it && it.id === "resetLicense");
      if (item) {
        item.enabled = !!active;
      }
    } catch (err) {
      console.warn("更新「注销激活状态」菜单项状态失败:", err);
    }
  }

  /**
   * 处理主面板（App）菜单项点击事件
   */
  private static handleAppFlyout(id: string) {
    console.log(`App Flyout: ${id}`);
    switch (id) {
      case "resetLicense":
        // 双保险：菜单项本身在未激活/试用时为 disabled，此处再拦一次
        if (!this.appLicenseActive) {
          // 极端情况下（UXP 菜单项 enabled 未同步成功）异步复核一次真实授权：
          // 只有确认是「正式激活且非试用」才放行，避免试用态被注销。
          LicenseManager.getLicenseState()
            .then((s) => {
              if (s.isLicensed && !s.isTrial) {
                this.appLicenseActive = true;
                this.appResetLicenseCallback?.();
              } else {
                console.warn("注销激活状态：当前未正式激活，忽略操作");
              }
            })
            .catch(() => {
              console.warn("注销激活状态：状态复核失败，忽略操作");
            });
          break;
        }
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
      case "setMainHotkey":
        if (this.appSetMainHotkeyCallback) {
          this.appSetMainHotkeyCallback();
        }
        break;
      case "openDocsFill":
        void openPluginDoc("docs/fill-guide.html");
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
              label: "注销激活状态",
              // 默认禁用：仅在正式激活（非试用）后由 setLicenseLogoutEnabled(true) 放开
              enabled: false
            },
            {
              id: "openLicenseDialog",
              label: "打开激活与试用面板"
            },
            {
              id: "spacerApp0",
              label: "-" // 分隔符（打开激活与试用面板 与 参数复位 之间）
            },
            {
              id: "resetAppParameters",
              label: "参数复位（保留已加载图案与新建渐变预设）"
            },
            {
              id: "spacerApp1",
              label: "-" // 分隔符（参数复位 与 设置主开关快捷键 之间）
            },
            {
              id: "setMainHotkey",
              label: "设置选区填充主开关快捷键"
            },
            {
              id: "spacerApp2",
              label: "-" // 分隔符（设置主开关快捷键 与 功能文档 之间）
            },
            {
              id: "openDocsFill",
              label: "功能文档"
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
              id: "showVisibilityPanel",
              label: "隐藏/显示分区"
            },
            {
              id: "resetOrder", 
              label: "复位分区顺序"
            },
            {
              id: "resetParameters",
              label: "参数复位"
            },
            {
              id: "spacer1",
              label: "-" // 分隔符（参数复位 与 图层像素alpha采样 之间）
            },
            {
              id: "alphaSample",
              label: "图层像素alpha采样"
            },
            {
              id: "spacer2",
              label: "-" // 分隔符（图层像素alpha采样 与 卸载守护进程 之间）
            },
            {
              id: "uninstallHotkeyDaemon",
              label: "卸载快捷键服务"
            },
            {
              id: "spacer3",
              label: "-" // 分隔符（卸载快捷键服务 与 功能文档 之间）
            },
            {
              id: "openDocsToolbox",
              label: "功能文档"
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