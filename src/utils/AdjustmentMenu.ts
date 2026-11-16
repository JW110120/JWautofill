/**
 * 像素调整面板菜单管理器 - 仅负责像素调整面板的菜单功能
 */

import { openPluginDoc } from './openDocs';
import { updatePanelMenuItem } from './panelMenu';

export class AdjustmentMenu {
  private static visibilityPanelCallback: ((visible: boolean) => void) | null = null;
  private static collapseCallback: (() => void) | null = null;
  private static resetCallback: (() => void) | null = null;
  private static resetParametersCallback: (() => void) | null = null;
  private static alphaSampleCallback: (() => void) | null = null;
  private static repairKeyboardCallback: (() => void) | null = null;
  private static showFuncHotkeyPanelCallback: (() => void) | null = null;
  private static toggleHotkeyNotifyCallback: (() => void) | null = null;

  /** 本面板的 UXP 面板 id（动态改菜单文案要用；与 MenuManager.setup 里的一致）。 */
  private static readonly PANEL_ID = "com.listen2me.pixeladjustment";

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
    onResetParameters: () => void;
    onAlphaSample: () => void;
    onRepairKeyboard: () => void;
    onShowFuncHotkeyPanel?: () => void;
    onToggleHotkeyNotify?: () => void;
  }) {
    this.visibilityPanelCallback = callbacks.onToggleVisibilityPanel;
    this.collapseCallback = callbacks.onToggleAllCollapse;
    this.resetCallback = callbacks.onResetOrder;
    this.resetParametersCallback = callbacks.onResetParameters;
    this.alphaSampleCallback = callbacks.onAlphaSample;
    this.repairKeyboardCallback = callbacks.onRepairKeyboard;
    this.showFuncHotkeyPanelCallback = callbacks.onShowFuncHotkeyPanel ?? null;
    this.toggleHotkeyNotifyCallback = callbacks.onToggleHotkeyNotify ?? null;
  }

  /**
   * 同步「显示热键通知」菜单项文案（「显示热键通知 - 开 / 关」）。
   * 与 APP 面板同名项共用 HotkeyNotifyBus 里的同一个偏好，但**各写各自的菜单项**
   * （UXP 菜单项 id 全局唯一，两个面板不能共用一个 id）。
   */
  public static setHotkeyNotifyLabel(on: boolean): void {
    updatePanelMenuItem(this.PANEL_ID, "toolboxHotkeyNotify", {
      label: `显示热键通知 - ${on ? "开" : "关"}`
    });
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
      case "toolboxHotkeyNotify":
        if (this.toggleHotkeyNotifyCallback) {
          this.toggleHotkeyNotifyCallback();
        }
        break;
      case "showVisibilityPanel":
        if (this.visibilityPanelCallback) {
          this.visibilityPanelCallback(true);
        }
        break;
      case "resetParameters":
        if (this.resetParametersCallback) {
          this.resetParametersCallback();
        }
        break;
      case "alphaSample":
        if (this.alphaSampleCallback) {
          this.alphaSampleCallback();
        }
        break;
      case "funcHotkeys":
        if (this.showFuncHotkeyPanelCallback) {
          this.showFuncHotkeyPanelCallback();
        }
        break;
      case "repairKeyboard":
        if (this.repairKeyboardCallback) {
          this.repairKeyboardCallback();
        }
        break;
      case "openDocsToolbox":
        void openPluginDoc("docs/toolbox-guide.html");
        break;
      default:
        console.warn(`Unknown adjustment menu item: ${id}`);
    }
  }
}