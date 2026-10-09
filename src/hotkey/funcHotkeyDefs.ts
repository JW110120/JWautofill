// 功能快捷键清单：可在「功能快捷键」浮窗里录制全局快捷键的非笔刷功能。
// id 同时是 hotkeys.json 里 runFunc 条目 brush 字段承载的功能标识，
// 也用于执行侧的映射，两侧必须保持一致：
//   - 常规功能按钮 → AdjustmentPanel 的 funcRunnerRef（执行权在绘画工具箱面板）；
//   - fillPanel:* 前缀 → HotkeyBridge 直接路由到 FillPanelToggleBus（执行权在 APP 面板）。
// section = 该功能实际所在的面板分区，浮窗按它分组展示（同区分集中、异区分容器）。
// 注意：分区名须与面板分区标题一致（选区填充/快捷操作/细节调整/边缘处理）。
export interface FuncHotkeyDef {
  id: string;
  label: string;
  section: string;
}

export const FUNC_HOTKEY_DEFS: FuncHotkeyDef[] = [
  // 选区填充分区：除主开关外的三个子面板开关（执行权在 APP 面板，热键为真正的开/关切换）
  { id: 'fillPanel:color', label: '纯色面板开关', section: '选区填充' },
  { id: 'fillPanel:pattern', label: '图案面板开关', section: '选区填充' },
  { id: 'fillPanel:gradient', label: '渐变面板开关', section: '选区填充' },
  // 快捷操作分区
  { id: 'blockAverage', label: '分块平均', section: '快捷操作' },
  { id: 'blockGradient', label: '分块渐变', section: '快捷操作' },
  { id: 'patchLightLine', label: '浅线同层补色', section: '快捷操作' },
  { id: 'patchDarkLine', label: '深线同层补色', section: '快捷操作' },
  { id: 'patchLayered', label: '分层补色', section: '快捷操作' },
  { id: 'woodcut', label: '特殊木刻', section: '快捷操作' },
  { id: 'knockoutWhite', label: '扣除纯白', section: '快捷操作' },
  { id: 'knockoutBlack', label: '扣除纯黑', section: '快捷操作' },
  { id: 'alphaDown', label: 'alpha下对齐', section: '快捷操作' },
  { id: 'alphaUp', label: 'alpha上对齐', section: '快捷操作' },
  { id: 'alphaMode', label: 'alpha众对齐', section: '快捷操作' },
  // 细节调整分区
  { id: 'pixelTransition', label: '像素过渡', section: '细节调整' },
  { id: 'gradientModify', label: '梯度修改', section: '细节调整' },
  { id: 'specialSharpen', label: '特殊锐化', section: '细节调整' },
  { id: 'highFreq', label: '高频增强', section: '细节调整' },
  // 边缘处理分区
  { id: 'edgeSmooth', label: '边缘平滑', section: '边缘处理' },
  { id: 'aliasSmooth', label: '消除锯齿', section: '边缘处理' },
  { id: 'lineEnhance', label: '线条加黑', section: '边缘处理' },
  { id: 'extremeRaiseLow', label: '提升下极值', section: '边缘处理' },
  { id: 'extremeWeakenHigh', label: '削弱上极值', section: '边缘处理' },
];

/** 分组展示顺序（未列出的分区按 defs 出现顺序排在后面；主开关「选区填充」行固定在该组最上方）。 */
export const FUNC_HOTKEY_SECTION_ORDER = ['选区填充', '快捷操作', '细节调整', '边缘处理'];

/** 功能 id → 显示名（未知 id 原样返回，避免提示里出现 undefined）。 */
export function getFuncHotkeyLabel(id: string): string {
  return FUNC_HOTKEY_DEFS.find(d => d.id === id)?.label || id;
}
