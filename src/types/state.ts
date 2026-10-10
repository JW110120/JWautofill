export interface ColorSettings {
    hueVariation: number;
    saturationVariation: number;
    brightnessVariation: number;
    opacityVariation: number;
    grayVariation?: number; // 灰度抖动，用于快速蒙版模式
    /**
     * 计算方法：'absolute' 绝对 / 'relative' 相对。
     * ⚠️ 该字段此前只存在于 initialState 与各处字面量里、**未声明在接口上**，
     *    于是 ColorSettingsPanel 的 settings.calculationMode、
     *    handleColorSettingsSave 的 settings.calculationMode 等读取全部报
     *    TS2339「Property 'calculationMode' does not exist on type 'ColorSettings'」。
     *    ts-loader 是 transpileOnly ⇒ 这些报错从不阻塞构建，直到跑 tsc 才暴露。
     *    声明为可选：老存档 / 调用方不传时回落到 'absolute'（各处读取处已如此兜底）。
     */
    calculationMode?: 'absolute' | 'relative';
}

export interface Pattern {
    id: string;
    name: string;
    preview: string;
    data?: ArrayBuffer;
    angle?: number;
    scale?: number;
    preserveTransparency?: boolean;
    fillMode?: 'stamp' | 'tile';     // 填充模式：盖图章或贴墙纸
    rotateAll?: boolean; // 全部旋转选项，仅在重复模式下有效
    // RGB/RGBA数据相关属性
    patternRgbData?: Uint8Array;     // 原始RGB/RGBA像素数据
    patternComponents?: number;      // 组件数（3=RGB, 4=RGBA）
    components?: number;             // 组件数（兼容性字段）
    hasAlpha?: boolean;              // 是否包含透明度信息
    // 灰度数据相关属性
    grayData?: Uint8Array;           // 当前变换后的灰度数据
    originalGrayData?: Uint8Array;   // 原始灰度数据（用于重新计算变换）
    width?: number;                  // 当前图案宽度
    height?: number;                 // 当前图案高度
    originalWidth?: number;          // 原始图案宽度
    originalHeight?: number;         // 原始图案高度
    currentScale?: number;           // 当前缩放比例
    currentAngle?: number;           // 当前旋转角度
    file?: any;                      // UXP文件引用
}

export interface GradientStop {
    color: string;
    position: number;
    // 扩展属性，用于支持独立的颜色和透明度位置以及中点
    colorPosition?: number;
    opacityPosition?: number;
    midpoint?: number;
}

export interface Gradient {
    type: 'linear' | 'radial';
    angle?: number;
    reverse?: boolean;
    stops: GradientStop[];
    preserveTransparency?: boolean; // 添加新的属性
    presets?: {
        preview: string;
        type: 'linear' | 'radial';
        angle?: number;
        reverse?: boolean;
        stops: GradientStop[];
    }[];
}

export interface Stroke {
    strokeWidth: number;
    strokePosition: 'inside' | 'center' | 'outside';
    strokeBlendMode: string;
    strokeOpacity: number;
  }


/**
 * 紧凑模式作用域：选区填充父面板 + 5 个子面板（纯色/图案/渐变/描边/清除）。
 * 6 个作用域各自一个开关、互不干扰——父面板开启不会连带隐藏子面板的 divider，反之亦然。
 * 菜单项文案随「当前面板 + 该面板自身状态」变化，见 app.tsx 的 currentCompactScope。
 */
export type CompactScope = 'app' | 'color' | 'pattern' | 'gradient' | 'stroke' | 'clear';
export type CompactModes = Record<CompactScope, boolean>;

export const initialCompactModes: CompactModes = {
    app: false,
    color: false,
    pattern: false,
    gradient: false,
    stroke: false,
    clear: false,
};

/**
 * 清除算法的三类目标（与 utils/ClearAlgorithms.ts 的 ClearTargetKind 对应）。
 *
 * 为什么分成三组而不是一个总开关：三类目标的**物理载体不同**，
 * 用户对它们的期望也不同，因此选项集合也不同：
 *   background —— 无透明度，只能改颜色 ⇒ 多一个「趋白」（模拟白背景橡皮擦）
 *   channel    —— 黑白灰度蒙版 ⇒ 减法 / 乘法
 *   layer      —— 有透明度 ⇒ 降低不透明度，减法 / 乘法
 * 详见 utils/ClearAlgorithms.ts 顶部的公式表。
 */
export type ClearBackgroundAlgorithm = 'whiten' | 'subtract' | 'multiply';
export type ClearBinaryAlgorithm = 'subtract' | 'multiply';

export interface AppState {
    opacity: number;
    feather: number;
    blendMode: string;
    autoUpdateHistory: boolean;
    isEnabled: boolean;
    deselectAfterFill: boolean;
    switchToLassoOnEnable: boolean;  // 主开关：关闭→开启时自动切换为套索工具
    autoOffOnOtherTool: boolean;     // 主开关：开启时切到其它工具则自动关闭
    isDragging: boolean;
    dragStartX: number;
    dragStartValue: number;
    dragTarget: string | null;
    selectionType: string;
    isExpanded: boolean;
    createNewLayer: boolean;  // 添加新状态
    clearMode: boolean;  // 添加清除模式状态
    /**
     * 清除算法的用户选择（三组，见 utils/ClearAlgorithms.ts）。
     * ⚠️ 必须进 state（而非组件内部 state）：算法在清除发生时由 ClearHandler /
     *    SingleChannelHandler / StrokeSelection 三处读取，是**跨模块共享字段**——
     *    与 isInQuickMask 那次历史 bug 同理，只写实例字段不会触发重渲染。
     * ⚠️ 必须同步声明在 AppState 上：ts-loader 是 transpileOnly，漏声明不会被构建拦住，
     *    只会在读取处静默变成 undefined（详见本文件 ColorSettings.calculationMode 的批注）。
     */
    clearBackgroundAlgorithm: ClearBackgroundAlgorithm;
    clearChannelAlgorithm: ClearBinaryAlgorithm;
    clearLayerAlgorithm: ClearBinaryAlgorithm;
    isClearSettingOpen: boolean;  // 清除设置子面板开关
    compactModes: CompactModes;  // 紧凑模式：按面板作用域分别记录（app=选区填充父面板，其余=5 个子面板）
    isInQuickMask: boolean;  // 添加快速蒙版状态
    // 图层蒙版编辑状态。
    // ⚠️ 与 isInQuickMask / isInSingleColorChannel 同理：必须进 state —— 「新建图层」开关的禁用态
    //    读它来决定是否置灰，只写实例字段再 forceUpdate 会让界面停在旧值。
    isInLayerMask: boolean;
    // 单通道（红/绿/蓝 或 自建 Alpha 通道）编辑状态。
    // ⚠️ 必须进 state（而非仅实例字段）：描边色板的灰度显示、以及「新建图层」开关的禁用态
    //    都依赖它触发重渲染；只写实例字段再 forceUpdate 会让界面停在旧值（同 isInQuickMask 的历史 bug）。
    isInSingleColorChannel: boolean;
    fillMode: 'foreground' | 'pattern' | 'gradient';
    colorSettings: ColorSettings;
    selectedPattern: Pattern | null;
    selectedGradient: Gradient | null;
    isColorSettingsOpen: boolean;
    isPatternPickerOpen: boolean;
    isGradientPickerOpen: boolean;
    isStrokeSettingOpen: boolean;
    strokeEnabled: boolean;
    strokeColor: {
        red: number;
        green: number;
        blue: number;
    };
     // 新增选区改造状态
     isSelectionOptionsExpanded: boolean;
     selectionSmooth: number;
     selectionContrast: number;
     selectionExpand: number; // 改名为扩散
     // 分区可见性（隐藏/显示分区浮窗控制，默认皆可见）：选区改造 / 填充选项
     selectionOptionsVisible: boolean;
     fillOptionsVisible: boolean;
     showVisibilityPanel: boolean;  // 隐藏/显示分区浮窗是否打开
    isFillSettingsOpen: boolean;  // 填充设置浮窗是否打开（承载原面板底部的四个 checkbox）
    // 参数复位信号（自增计数）：描边子面板的参数由父面板 state 直接驱动，
    // 而纯色/图案/渐变三个子面板的参数活在各自的组件内部 state 里，
    // 父面板复位时它们无从得知 ⇒ 用这个自增信号通知它们「复位了，请回到默认值」。
    // 首次挂载为 0，三个子面板各自跳过第一次即可。
    resetToken: number;
     // 许可证相关状态
     isLicensed: boolean;
     isTrial: boolean;
     isLicenseDialogOpen: boolean;
     trialDaysRemaining: number;
}

export const initialState: AppState = {
    opacity: 100,
    feather: 0,
    blendMode: '正常',
    autoUpdateHistory: true,
    isEnabled: true,
    deselectAfterFill: true,
    switchToLassoOnEnable: false,
    autoOffOnOtherTool: false,
    isDragging: false,
    dragStartX: 0,
    dragStartValue: 0,
    dragTarget: null,
    selectionType: 'normal',
    isExpanded: true,
    createNewLayer: false,    // 添加初始值
    clearMode: false,    // 添加初始值
    // 清除算法默认值 = 重构前的既有行为，保证老用户升级后手感不变：
    //   背景图层 → whiten    （原 levels 提亮，白背景橡皮擦）
    //   黑白通道 → subtract  （原快速蒙版 / 图层蒙版的减去式）
    //   普通像素图层 → multiply（原 clearEnum「清除」= 按比例降低不透明度）
    clearBackgroundAlgorithm: 'whiten',
    clearChannelAlgorithm: 'subtract',
    clearLayerAlgorithm: 'multiply',
    isClearSettingOpen: false,
    compactModes: { ...initialCompactModes },    // 紧凑模式默认全部关闭
    isInQuickMask: false,    // 添加快速蒙版初始值
    isInLayerMask: false,    // 图层蒙版编辑默认关闭（由 checkMaskModes / 选区事件探测回写）
    isInSingleColorChannel: false,    // 单通道编辑默认关闭（由 checkMaskModes / 选区事件探测回写）
    fillMode: 'foreground',
    colorSettings: {
        hueVariation: 0,
        saturationVariation: 0,
        brightnessVariation: 0,
        opacityVariation: 0,
        grayVariation: 0,
        calculationMode: 'absolute'
    },
    selectedPattern: null,
    selectedGradient: null,
    isColorSettingsOpen: false,
    isPatternPickerOpen: false,
    isGradientPickerOpen: false,
    isStrokeSettingOpen: false, 
    strokeEnabled: false,
    strokeWidth: 2,
    strokePosition: 'center',
    strokeBlendMode: '正常',
    strokeOpacity: 100,
    strokeColor: {
        red: 0,
        green: 0,
        blue: 0
    },
    isSelectionOptionsExpanded: true,
    selectionSmooth: 0, 
    selectionContrast: 0,
    selectionExpand: 0, // 改名为扩散
    // 分区可见性（默认皆可见）
    selectionOptionsVisible: true,
    fillOptionsVisible: true,
    showVisibilityPanel: false,
    isFillSettingsOpen: false,
    resetToken: 0,
    // 新增：许可证默认状态
    isLicensed: false,
    isTrial: false,
    isLicenseDialogOpen: true,
    trialDaysRemaining: 0,
};
