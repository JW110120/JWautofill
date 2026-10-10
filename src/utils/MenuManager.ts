/**
 * 通用菜单管理器 - 负责UXP入口点设置和主面板菜单功能
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { entrypoints } = require("uxp");

import { AdjustmentMenu } from './AdjustmentMenu';
import { LicenseManager } from './LicenseManager';
import { openPluginDoc } from './openDocs';

/** 菜单项定义（与 UXP entrypoints.setup 的 menuItems 元素同形） */
type MenuItemDef = { id: string; label: string; enabled?: boolean };

/**
 * 主面板（App / 选区填充）flyout 菜单项 —— **唯一来源**：
 * 既喂给 entrypoints.setup，也用于「注册面板打开期整菜单置灰」的 id 遍历，
 * 两处共用同一数组，杜绝 id 双写漂移。分隔符 id 以 "spacer" 开头，门控时跳过。
 */
const APP_MENU_ITEMS: MenuItemDef[] = [
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
    label: "-" // 分隔符（打开激活与试用面板 与 隐藏/显示分区 之间）
  },
  {
    // ⚠️ id 必须与绘画工具箱的同类菜单项区分开：UXP 的菜单项 id 全局唯一，
    //    两个面板用同一个 id 会在 entrypoints.setup 时抛
    //    「Can't add menu item ... as it already exists」，并且整个面板都起不来。
    id: "appShowVisibilityPanel",
    label: "隐藏/显示分区"
  },
  {
    id: "toggleCompactMode",
    // 初始文案；面板起来后由 MenuManager.setCompactModeLabel 按「当前面板 + 该面板状态」实时改写
    label: "紧凑模式：选区填充 - 关"
  },
  {
    id: "spacerApp1",
    label: "-" // 分隔符（紧凑模式 与「参数复位/填充设置/设置主开关快捷键」分区 之间）
  },
  {
    id: "resetAppParameters",
    label: "参数复位"
  },
  {
    id: "appFillSettings",
    label: "填充设置"
  },
  {
    // 「设置主开关快捷键」自成一组（2026-10-10 用户要求「单分一栏」）：
    // 它是「录制全局快捷键」这一独立动作，与上面的参数复位 / 填充设置不属于同类；
    // 混在一起容易被误点 ⇒ 前后各一条分隔符，独占一栏。
    id: "spacerApp3",
    label: "-" // 分隔符（填充设置 与 设置主开关快捷键 之间）
  },
  {
    id: "setMainHotkey",
    label: "设置主开关快捷键"
  },
  {
    id: "spacerApp2",
    label: "-" // 分隔符（设置主开关快捷键 与使用手册 之间）
  },
  {
    id: "openDocsFill",
    label: "使用手册"
  }
];

/**
 * 像素调整面板（绘画工具箱）flyout 菜单项 —— **唯一来源**（同 APP_MENU_ITEMS）。
 */
const ADJUSTMENT_MENU_ITEMS: MenuItemDef[] = [
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
    id: "spacer1",
    label: "-" // 分隔符（「布局类」折叠/显示/排序 与 后续功能项 之间）
  },
  {
    id: "alphaSample",
    label: "图层像素alpha采样"
  },
  {
    id: "spacer2",
    label: "-" // 分隔符（图层像素alpha采样 与 参数复位 之间）
  },
  {
    // 「参数复位」自成一组（2026-10-10 用户要求）：它是一次性重写全部参数的
    // 动作，与上面的「折叠 / 隐藏显示 / 复位分区顺序」这类布局操作不同类，
    // 混在一起容易被误点 ⇒ 前后各留一条分隔符，独占一栏。
    id: "resetParameters",
    label: "参数复位"
  },
  {
    id: "spacer6",
    label: "-" // 分隔符（参数复位 与 功能快捷键 之间）
  },
  {
    id: "funcHotkeys",
    label: "功能快捷键"
  },
  {
    id: "spacer5",
    label: "-" // 分隔符（功能快捷键 与 「键盘卡死一键修复 + 卸载快捷键服务」分组 之间）
  },
  {
    id: "repairKeyboard",
    label: "键盘卡死一键修复"
  },
  {
    id: "uninstallHotkeyDaemon",
    label: "卸载快捷键服务"
  },
  {
    id: "spacer4",
    label: "-" // 分隔符（卸载快捷键服务 与使用手册 之间）
  },
  {
    id: "openDocsToolbox",
    label: "使用手册"
  }
];

export class MenuManager {
  // 主面板 APP 的回调
  private static appOpenLicenseCallback: (() => void) | null = null;
  private static appResetLicenseCallback: (() => void) | null = null;
  private static appResetParametersCallback: (() => void) | null = null;
  private static appToggleCompactModeCallback: (() => void) | null = null;
  private static appSetMainHotkeyCallback: (() => void) | null = null;
  private static appShowVisibilityPanelCallback: (() => void) | null = null;
  private static appFillSettingsCallback: (() => void) | null = null;
  // 是否已正式激活（试用不算）：决定「注销激活状态」菜单项能否点击
  private static appLicenseActive: boolean = false;

  // 两个 UXP 面板 id（与 setup() 里一致）
  private static readonly APP_PANEL_ID = "com.listen2me.jwautofill";
  private static readonly ADJUSTMENT_PANEL_ID = "com.listen2me.pixeladjustment";

  // 各面板菜单项 id 清单（**不含分隔符**）：直接从菜单源数组派生，
  // 供「注册面板打开期整菜单置灰」遍历。与 setup() 共用同一来源，杜绝 id 漂移。
  private static appMenuIds: string[] =
    APP_MENU_ITEMS.map((it) => it.id).filter((id) => id.indexOf("spacer") !== 0);
  private static adjustmentMenuIds: string[] =
    ADJUSTMENT_MENU_ITEMS.map((it) => it.id).filter((id) => id.indexOf("spacer") !== 0);

  // 「注册（激活）面板打开」态上一次应用到宿主菜单的值（null = 尚未应用过）。
  // 用于让 setLicenseDialogOpen 幂等：态未变则不重复写宿主菜单。
  private static licenseMenuGated: boolean | null = null;

  /**
   * 「注册（激活）面板打开期间」各父面板菜单里**保留可点**的白名单：
   *   APP（选区填充） → 打开激活与试用面板 + 使用手册
   *   工具箱（adjustment） → 使用手册
   *   （工具箱本身没有激活入口：设计上激活只在选区填充面板做，锁定横幅也提示「需要在选区填充面板激活」）
   * 白名单以外的项（含分隔符之外的普通项）一律置灰。分隔符不参与 enabled 变更。
   */
  private static readonly LICENSE_DIALOG_ALLOW: Record<string, string[]> = {
    [MenuManager.APP_PANEL_ID]: ["openLicenseDialog", "openDocsFill"],
    [MenuManager.ADJUSTMENT_PANEL_ID]: ["openDocsToolbox"]
  };

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
    onToggleCompactMode?: () => void;
    onSetMainHotkey?: () => void;
    onShowVisibilityPanel?: () => void;
    onOpenFillSettings?: () => void;
  }) {
    this.appOpenLicenseCallback = callbacks.onOpenLicenseDialog;
    this.appResetLicenseCallback = callbacks.onResetLicense;
    this.appResetParametersCallback = callbacks.onResetParameters;
    this.appToggleCompactModeCallback = callbacks.onToggleCompactMode ?? null;
    this.appSetMainHotkeyCallback = callbacks.onSetMainHotkey ?? null;
    this.appShowVisibilityPanelCallback = callbacks.onShowVisibilityPanel ?? null;
    this.appFillSettingsCallback = callbacks.onOpenFillSettings ?? null;
  }

  /**
   * 底层：按面板 id + 菜单项 id 更新指定菜单项属性（enabled / label）。
   * UXP 动态更新菜单项走 getPanel(id).menuItems.getItem(id) 后直接改属性；
   * 不同版本 API 名称不统一，故依次尝试 getItem → updateItem → 直接改数组项，
   * 全部失败也只是菜单项保持旧状态（handler 里还有一层拦截）。
   */
  private static updateMenuItem(
    panelId: string,
    id: string,
    patch: { enabled?: boolean; label?: string }
  ): void {
    try {
      const ep: any = (require("uxp") as any).entrypoints;
      const panel: any = ep && typeof ep.getPanel === "function"
        ? ep.getPanel(panelId)
        : null;
      const menuItems: any = panel && (panel as any).menuItems;
      if (!menuItems) return;

      const applyTo = (item: any): boolean => {
        if (!item) return false;
        if (patch.enabled !== undefined) item.enabled = patch.enabled;
        if (patch.label !== undefined) item.label = patch.label;
        return true;
      };

      // 官方动态更新方式：getItem(id) 取到菜单项后直接改属性
      if (typeof (menuItems as any).getItem === "function") {
        if (applyTo((menuItems as any).getItem(id))) return;
      }
      if (typeof (menuItems as any).updateItem === "function") {
        (menuItems as any).updateItem(id, patch);
        return;
      }
      const list: any[] = Array.isArray(menuItems) ? menuItems : ((menuItems as any).items || []);
      const item = list.find((it: any) => it && it.id === id);
      applyTo(item);
    } catch (err) {
      console.warn(`更新菜单项 ${id} 状态失败:`, err);
    }
  }

  /**
   * 菜单项的「默认可用态」（非注册面板门控期）：
   * 除「注销激活状态」依正式激活态外，其余一律可用。
   */
  private static defaultMenuItemEnabled(id: string): boolean {
    return id === "resetLicense" ? this.appLicenseActive : true;
  }

  /**
   * 把一个面板的全部菜单项按当前「注册面板门控态」写成 enabled。
   * gated=true  → 仅白名单可点，其余置灰；
   * gated=false → 还原各面板默认可用态。
   */
  private static applyPanelMenuGating(panelId: string, ids: string[], gated: boolean): void {
    const allow = this.LICENSE_DIALOG_ALLOW[panelId] || [];
    for (const id of ids) {
      const enabled = gated ? allow.indexOf(id) >= 0 : this.defaultMenuItemEnabled(id);
      this.updateMenuItem(panelId, id, { enabled });
    }
  }

  /**
   * 注册（激活）面板打开期间：两个父面板菜单只保留白名单项可点，其余全部置灰；
   * 关闭后按各面板「默认可用态」还原（仅「注销激活状态」例外，依正式激活态）。
   * 幂等：门控态未变则直接返回，不重复写宿主菜单。
   * 由 app.tsx 的 syncLicenseDialogClass()（唯一 body 类派生点）在每次渲染时调用。
   */
  public static setLicenseDialogOpen(open: boolean): void {
    const next = !!open;
    if (this.licenseMenuGated === next) return;
    this.licenseMenuGated = next;
    this.applyPanelMenuGating(this.APP_PANEL_ID, this.appMenuIds, next);
    this.applyPanelMenuGating(this.ADJUSTMENT_PANEL_ID, this.adjustmentMenuIds, next);
  }

  /**
   * 同步「注销激活状态」菜单项的可用状态。
   * 规则：仅正式激活后可点击；未激活与试用状态下均为禁用。
   */
  public static setLicenseLogoutEnabled(active: boolean): void {
    this.appLicenseActive = !!active;
    // 注册面板门控期：该项属白名单外，保持置灰（避免本调用越过门控把它点亮）。
    // 门控解除时 applyPanelMenuGating(false) 会按 appLicenseActive 重新还原。
    const enabled = this.licenseMenuGated ? false : !!active;
    this.updateMenuItem(this.APP_PANEL_ID, "resetLicense", { enabled });
  }

  /**
   * 同步「紧凑模式」菜单项文案（随当前面板与它自身开关状态变化）。
   * 文案形如「紧凑模式：图案·关」/「紧凑模式：选区填充·开」：
   * 5 个作用域（选区填充父面板 + 纯色/图案/渐变/描边 4 个子面板）各自独立开关，
   * 菜单项只作用于「当前面板」，所以文案里必须写明是哪个面板、以及它此刻是开还是关。
   */
  public static setCompactModeLabel(label: string): void {
    this.updateMenuItem(this.APP_PANEL_ID, "toggleCompactMode", { label });
  }

  /**
   * 去掉动态菜单项 id 上的 `#轮次` 后缀，使分派逻辑与轮次无关。
   * ⚠️ 这是 2026-10-07 那版 removeAt/insertAt 方案留下的兼容处理：
   *   若用户在跑过旧版本后重载插件，宿主侧可能仍残留带 `#` 后缀的项，
   *   保留此方法让它们也能被正确识别与分派（属无害冗余，不再新增带后缀的 id）。
   */
  private static normalizeMenuId(id: string): string {
    if (typeof id !== "string") return "";
    const hash = id.indexOf("#");
    return hash >= 0 ? id.slice(0, hash) : id;
  }

  /**
   * 处理主面板（App）菜单项点击事件
   */
  private static handleAppFlyout(rawId: string) {
    const id = this.normalizeMenuId(rawId);
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
      case "toggleCompactMode":
        if (this.appToggleCompactModeCallback) {
          this.appToggleCompactModeCallback();
        }
        break;
      case "setMainHotkey":
        if (this.appSetMainHotkeyCallback) {
          this.appSetMainHotkeyCallback();
        }
        break;
      case "appShowVisibilityPanel":
        if (this.appShowVisibilityPanelCallback) {
          this.appShowVisibilityPanelCallback();
        }
        break;
      case "appFillSettings":
        if (this.appFillSettingsCallback) {
          this.appFillSettingsCallback();
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
          menuItems: APP_MENU_ITEMS,
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
          menuItems: ADJUSTMENT_MENU_ITEMS,
          invokeMenu(id: string) {
            MenuManager.handleAdjustmentFlyout(id);
          }
        }
      }
    });

    g.__JW_MENU_SETUP_DONE__ = true;
  }
}