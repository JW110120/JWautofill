// 功能快捷键清单：可在「功能快捷键」子面板里录制全局快捷键的非笔刷功能。
// id 同时是 hotkeys.json 里 runFunc 条目 brush 字段承载的功能标识，
// 也用于执行侧的映射，两侧必须保持一致：
//   - 常规功能按钮 → AdjustmentPanel 的 funcRunnerRef（执行权在绘画工具箱面板）；
//   - fillModeCycle → HotkeyBridge 直接路由到 FillModeCycleBus（执行权在 APP 面板）。
// section = 该功能实际所在的面板分区，子面板按它分组展示（同区分集中、异区分容器）。
// 注意：分区名须与面板分区标题一致（选区填充/快捷操作/细节调整/边缘处理）。
// ⛔ 2026-11-16：「选区填充」这一组**只在 APP 面板的「自定义快捷键」子面板里显示**
//    （FuncHotkeyPanel 的 scope='app'）；绘画工具箱的「功能快捷键」子面板只显示
//    快捷操作 / 细节调整 / 边缘处理三组。id 与执行侧不受影响，只是展示位置各自归位。
export interface FuncHotkeyDef {
  id: string;
  label: string;
  section: string;
}

export const FUNC_HOTKEY_DEFS: FuncHotkeyDef[] = [
  // 选区填充分区：填充模式轮换（纯色 → 图案 → 渐变 → 纯色…）。
  // 默认 Ctrl+滚轮：向下滚 = 下一个，向上滚 = 上一个（方向由 .8li 的鼠标钩子带在
  // 消息的 dir 字段里下发，见 HotkeyBridge 的 fillModeCycle 分支）。
  // ⛔ 2026-11-16：原来的三行「纯色 / 图案 / 渐变面板开关」已按用户要求删除 ——
  //    单独开关某个子面板没有意义（真正要的是「换一种填充方式」），三行还占满一屏。
  { id: 'fillModeCycle', label: '切换填充模式', section: '选区填充' },
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

/**
 * 「功能快捷键」子面板里的**分隔线位置**（2026-11-16 用户要求）：
 * 位置与折叠分区内功能按钮之间的分割线**一一对应**，样式也相同
 * （该实线的地方实线，该虚线的地方虚线）。
 *
 * key = 功能 id，value = 该行**下方**那条线的样式；未列出的行下方不画线。
 * ⚠️ 判据来自 AdjustmentPanel 里各分区内容函数的真实结构，改那边布局就要同步这里：
 *    · 快捷操作（renderQuickActionContent）：分块平均 ─实线─ 分块渐变 ─实线─
 *      浅线/深线同层补色（同一行）─**虚线**─ 分层补色 ─实线─ 特殊木刻 ─实线─
 *      扣除纯白/纯黑（同一行）─实线─ alpha 三联（下/上同一行、众单独一行，三联内部无线）。
 *    · 细节调整（renderDetailAdjustContent）：像素过渡 / 梯度修改 / 特殊锐化 / 高频增强
 *      两两之间各一条实线。
 *    · 边缘处理（renderEdgeProcessingContent）：边缘平滑 ─实线─ 消除锯齿+线条加黑（同一行）
 *      ─实线─ 极值微调（提升下极值/削弱上极值 同一行）。
 * ⛔ 同一行里的两颗按钮在子面板里是两行快捷键，**两者之间不画线** —— 否则会把
 *    「一个操作组」切碎，与真实面板的视觉分组对不上。
 */
export const FUNC_HOTKEY_DIVIDERS: Record<string, 'solid' | 'dashed'> = {
  // 快捷操作
  blockAverage: 'solid',
  blockGradient: 'solid',
  patchDarkLine: 'dashed',
  patchLayered: 'solid',
  woodcut: 'solid',
  knockoutBlack: 'solid',
  // 细节调整
  pixelTransition: 'solid',
  gradientModify: 'solid',
  specialSharpen: 'solid',
  // 边缘处理
  edgeSmooth: 'solid',
  lineEnhance: 'solid',
};

/** 功能 id → 显示名（未知 id 原样返回，避免提示里出现 undefined）。 */
export function getFuncHotkeyLabel(id: string): string {
  return FUNC_HOTKEY_DEFS.find(d => d.id === id)?.label || id;
}
