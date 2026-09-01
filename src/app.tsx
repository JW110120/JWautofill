import React from 'react';
import { interaction, storage } from 'uxp';
import { app, action, core } from 'photoshop';
import { BLEND_MODES } from './constants/blendModes';
import { BLEND_MODE_OPTIONS } from './constants/blendModeOptions';
import { AppState, initialState, Gradient } from './types/state';
import { DragHandler } from './utils/DragHandler';
import { FillHandler } from './utils/FillHandler';
import { LayerInfoHandler } from './utils/LayerInfoHandler';
import { ClearHandler } from './utils/ClearHandler';
import ColorSettingsPanel from './components/ColorSettingsPanel';
import PatternPicker from './components/PatternPicker';
import GradientPicker from './components/GradientPicker';
import StrokeSetting from './components/StrokeSetting';
import Select from './components/Select';
import LicenseDialog from './components/LicenseDialog';
import RangeSlider from './components/RangeSlider';
import IconButton from './components/IconButton';
import { LicenseManager } from './utils/LicenseManager';
import { ExpandIcon, SettingsIcon } from './styles/Icons';
import { calculateRandomColor, hsbToRgb, rgbToGray } from './utils/ColorUtils';
import { strokeSelection } from './utils/StrokeSelection';
import { PatternFill } from './utils/PatternFill';
import { GradientFill } from './utils/GradientFill';
import { SingleChannelHandler } from './utils/SingleChannelHandler';
import { SelectionHandler, SelectionOptions } from './utils/SelectionHandler';
import { LayerInfo } from './utils/LayerInfoHandler';
import { ColorSettings, Pattern } from './types/state';
import { MenuManager } from './utils/MenuManager';
import { PresetManager } from './utils/PresetManager';
import { PanelStateManager } from './utils/PanelStateManager';
import {
  connectHotkeyDaemon,
  isDaemonConnected, getMainToggleCombo, setMainToggleCombo, requestHotkeyRecording
} from './hotkey/HotkeyBridge';
import { seedMainToggle, setMainToggle, subscribeMainToggle } from './utils/MainToggleBus';
import { helpTexts } from './constants/helpTexts';

const { executeAsModal } = core;
const { batchPlay } = action;

interface AppProps {}

class App extends React.Component<AppProps, AppState> {
    private unsubMainToggle: (() => void) | null = null;
    private isFilling = false;
    private pendingSelection = false;
    private isInLayerMask = false;
    private isInQuickMask = false;
    private isInSingleColorChannel = false;
    private selectionChangeListener: any = null;
    // 面板状态持久化门闩：componentDidMount 里 PanelStateManager.initialize 异步读取完成之前，
    // MainToggleBus 轮询（250ms）等来源就可能 setState isEnabled 触发 componentDidUpdate 的
    // 「有变更即保存」逻辑——用默认值整体覆盖 panel-state.json，把用户已保存的
    // 自动关开关/自动切套索等选项冲掉（表现为这些开关重启后不持久化）。加载完成前禁止保存。
    private panelStateLoaded = false;

    constructor(props: AppProps) {
        super(props);
        this.state = initialState;
        
        this.handleSelectionChange = this.handleSelectionChange.bind(this);
        this.handleOpacityChange = this.handleOpacityChange.bind(this);
        this.handleFeatherChange = this.handleFeatherChange.bind(this);
        this.handleBlendModeChange = this.handleBlendModeChange.bind(this);
        this.toggleAutoUpdateHistory = this.toggleAutoUpdateHistory.bind(this);
        this.handleButtonClick = this.handleButtonClick.bind(this);
        this.toggleDeselectAfterFill = this.toggleDeselectAfterFill.bind(this);
        this.toggleSwitchToLassoOnEnable = this.toggleSwitchToLassoOnEnable.bind(this);
        this.toggleAutoOffOnOtherTool = this.toggleAutoOffOnOtherTool.bind(this);
        this.handleLabelMouseDown = this.handleLabelMouseDown.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.toggleCreateNewLayer = this.toggleCreateNewLayer.bind(this);
        this.toggleClearMode = this.toggleClearMode.bind(this);
        this.toggleColorSettings = this.toggleColorSettings.bind(this);
        this.openPatternPicker = this.openPatternPicker.bind(this);
        this.openGradientPicker = this.openGradientPicker.bind(this);
        this.handleColorSettingsSave = this.handleColorSettingsSave.bind(this);
        this.handlePatternSelect = this.handlePatternSelect.bind(this);
        this.handleGradientSelect = this.handleGradientSelect.bind(this);
        this.handleFillModeChange = this.handleFillModeChange.bind(this);
        this.toggleExpand = this.toggleExpand.bind(this);
        this.closeColorSettings = this.closeColorSettings.bind(this);
        this.closePatternPicker = this.closePatternPicker.bind(this);
        this.closeGradientPicker = this.closeGradientPicker.bind(this);
        this.closeStrokeSetting = this.closeStrokeSetting.bind(this);
        this.toggleStrokeEnabled = this.toggleStrokeEnabled.bind(this);
        this.toggleStrokeSetting = this.toggleStrokeSetting.bind(this);
        // 新增绑定
        this.toggleSelectionOptions = this.toggleSelectionOptions.bind(this);
        this.handleSelectionSmoothChange = this.handleSelectionSmoothChange.bind(this);
        this.handleSelectionContrastChange = this.handleSelectionContrastChange.bind(this);
        this.handleSelectionExpandChange = this.handleSelectionExpandChange.bind(this);
        this.handleNotification = this.handleNotification.bind(this);
        // 许可证相关方法绑定
        this.handleLicenseVerified = this.handleLicenseVerified.bind(this);
        this.handleTrialStarted = this.handleTrialStarted.bind(this);
        this.closeLicenseDialog = this.closeLicenseDialog.bind(this);
        this.checkLicenseStatus = this.checkLicenseStatus.bind(this);
        this.openLicenseDialog = this.openLicenseDialog.bind(this);
        this.resetLicenseForTesting = this.resetLicenseForTesting.bind(this);
 
    }

    async componentDidMount() {
        // ===== 全局快捷键链路：必须最先建立 =====
        // 这段绝不能放在任何 await 之后。componentDidMount 下面还有一连串 await
        // （文件系统探测、事件监听注册、蒙版模式检测…），任何一个抛错或卡住，
        // 后面的代码都不会执行——历史上正是因此出现「笔刷面板有热键提示、
        // 主面板开关纹丝不动」：面板看起来完全正常，实际上连守护进程都没连上。
        // 另外，UXP 各面板是独立 JS 上下文，热键可能只被绘画工具箱面板收到，
        // 所以主开关统一改由 MainToggleBus（共享文件）同步，不依赖本面板的 WebSocket。
        try {
            connectHotkeyDaemon();
            this.unsubMainToggle = subscribeMainToggle((st) => {
                if (typeof st?.enabled === 'boolean' && st.enabled !== this.state.isEnabled) {
                    const prev = this.state.isEnabled;
                    this.setState({ isEnabled: st.enabled });
                    void this.onMainToggleChanged(prev, st.enabled);
                }
            });
        } catch (e) {
            console.error('⚠️ 建立热键链路失败:', e);
        }

        // 测试文件系统访问权限（禁用自动写入测试以避免干扰首次加载）
        console.log('🔍 开始测试文件系统访问权限...');
        try {
            const hasFileAccess = await PresetManager.testFileSystemAccess();
            if (!hasFileAccess) {
                console.error('❌ 文件系统访问权限测试失败，预设功能可能无法正常工作');
            } else {
                // 🚫 暂时禁用：避免在启动阶段对预设文件进行写入测试，干扰加载顺序
                // console.log('🧪 文件系统访问正常，开始测试预设保存功能...');
                // await PresetManager.testPresetSaving();
            }
        } catch (error) {
            console.error('❌ 文件系统访问权限测试异常:', error);
        }
        
        // 注册主面板菜单回调
        MenuManager.registerAppCallbacks({
            onOpenLicenseDialog: this.openLicenseDialog,
            onResetLicense: this.resetLicenseForTesting,
            onResetParameters: () => {
                // 保留图案与渐变预设，仅复位其它参数
                const keepPattern = this.state.selectedPattern;
                const keepGradient = this.state.selectedGradient;
                // 使用 initialState 作为基准，保留需要保留的项
                this.setState({
                    ...initialState,
                    selectedPattern: keepPattern,
                    selectedGradient: keepGradient,
                    // 选项类开关不属于「参数」，复位时保持用户当前选择（含持久化语义，勿回默认值）
                    deselectAfterFill: this.state.deselectAfterFill,
                    autoUpdateHistory: this.state.autoUpdateHistory,
                    switchToLassoOnEnable: this.state.switchToLassoOnEnable,
                    autoOffOnOtherTool: this.state.autoOffOnOtherTool,
                    strokeEnabled: this.state.strokeEnabled,
                    createNewLayer: this.state.createNewLayer,
                    // UI 相关展开/面板开关保持为当前值以避免打断用户操作
                    isColorSettingsOpen: this.state.isColorSettingsOpen,
                    isPatternPickerOpen: this.state.isPatternPickerOpen,
                    isGradientPickerOpen: this.state.isGradientPickerOpen,
                    isStrokeSettingOpen: this.state.isStrokeSettingOpen,
                    isExpanded: this.state.isExpanded,
                    // 授权状态不应被参数复位影响
                    isLicensed: this.state.isLicensed,
                    isTrial: this.state.isTrial,
                    isLicenseDialogOpen: this.state.isLicenseDialogOpen,
                    trialDaysRemaining: this.state.trialDaysRemaining,
                });
            },
            onSetMainHotkey: () => { void this.setMainHotkey(); }
        });
        this.selectionChangeListener = (eventName, descriptor) => {
            // 检查是否是选区相关的set事件
            if (descriptor && descriptor._target && Array.isArray(descriptor._target)) {
                const isSelectionEvent = descriptor._target.some(target => 
                    target._ref === 'channel' && target._property === 'selection'
                );
                
                if (isSelectionEvent) {
                    this.handleSelectionChange(descriptor);
                } else {
                    console.log('🔍 非选区设置事件，跳过处理');
                }
            }
        };
        await action.addNotificationListener(['set'], this.selectionChangeListener);
        document.addEventListener('mousemove', this.handleMouseMove);
        document.addEventListener('mouseup', this.handleMouseUp);
        
        // 初始化状态检测
        await this.checkMaskModes();
        
        // 监听Photoshop事件来检查状态变化
        await action.addNotificationListener(['set', 'select', 'clearEvent', 'delete', 'make'], this.handleNotification);

        // 许可证：检查当前状态并尝试自动重新验证
        await this.checkLicenseStatus();

        // ========= 面板状态：加载并合并 =========
        try {
            const loaded = await PanelStateManager.initialize({
                appPanel: {
                    isEnabled: this.state.isEnabled,
                    isExpanded: this.state.isExpanded,
                    isSelectionOptionsExpanded: this.state.isSelectionOptionsExpanded,
                    autoUpdateHistory: this.state.autoUpdateHistory,
                    deselectAfterFill: this.state.deselectAfterFill,
                    switchToLassoOnEnable: this.state.switchToLassoOnEnable,
                    autoOffOnOtherTool: this.state.autoOffOnOtherTool,
                    strokeEnabled: this.state.strokeEnabled,
                    createNewLayer: this.state.createNewLayer,
                    clearMode: this.state.clearMode,
                    fillMode: this.state.fillMode,
                },
            });
            if (loaded && loaded.appPanel) {
                this.setState({
                    isEnabled: loaded.appPanel.isEnabled ?? this.state.isEnabled,
                    isExpanded: loaded.appPanel.isExpanded ?? this.state.isExpanded,
                    isSelectionOptionsExpanded: loaded.appPanel.isSelectionOptionsExpanded ?? this.state.isSelectionOptionsExpanded,
                    autoUpdateHistory: loaded.appPanel.autoUpdateHistory ?? this.state.autoUpdateHistory,
                    deselectAfterFill: loaded.appPanel.deselectAfterFill ?? this.state.deselectAfterFill,
                    switchToLassoOnEnable: loaded.appPanel.switchToLassoOnEnable ?? this.state.switchToLassoOnEnable,
                    autoOffOnOtherTool: loaded.appPanel.autoOffOnOtherTool ?? this.state.autoOffOnOtherTool,
                    strokeEnabled: loaded.appPanel.strokeEnabled ?? this.state.strokeEnabled,
                    createNewLayer: loaded.appPanel.createNewLayer ?? this.state.createNewLayer,
                    clearMode: loaded.appPanel.clearMode ?? this.state.clearMode,
                    fillMode: loaded.appPanel.fillMode ?? this.state.fillMode,
                });
            }
        } catch (e) {
            console.warn('⚠️ 面板状态加载失败，使用默认状态:', e);
        } finally {
            // 加载完成（无论成败）才允许后续的持久化保存，避免启动期默认值覆盖已存状态
            this.panelStateLoaded = true;
        }

        // ========= 主开关：与跨面板共享状态对齐 =========
        // 共享文件存在（上次会话留下来的真实状态）就以它为准；不存在才用本面板持久化的值播种。
        // 这样无论热键是被本面板还是被绘画工具箱面板接到的，两边的开关显示始终一致。
        try {
            const shared = await seedMainToggle(this.state.isEnabled);
            if (shared.enabled !== this.state.isEnabled) {
                this.setState({ isEnabled: shared.enabled });
            }
        } catch (e) {
            console.warn('⚠️ 主开关共享状态初始化失败，仅使用面板本地状态:', e);
        }
    }

    componentDidUpdate(prevProps, prevState) {
        // 检查次级面板状态变化，添加或移除CSS类
        const isAnySecondaryPanelOpen = this.state.isColorSettingsOpen || 
                                       this.state.isPatternPickerOpen || 
                                       this.state.isGradientPickerOpen || 
                                       this.state.isStrokeSettingOpen;
        
        const wasAnySecondaryPanelOpen = prevState.isColorSettingsOpen || 
                                        prevState.isPatternPickerOpen || 
                                        prevState.isGradientPickerOpen || 
                                        prevState.isStrokeSettingOpen;
        
        if (isAnySecondaryPanelOpen !== wasAnySecondaryPanelOpen) {
            if (isAnySecondaryPanelOpen) {
                document.body.classList.add('secondary-panel-open');
            } else {
                document.body.classList.remove('secondary-panel-open');
            }
        }

        // 检查授权对话框状态变化，添加或移除CSS类
        if (this.state.isLicenseDialogOpen !== prevState.isLicenseDialogOpen) {
            if (this.state.isLicenseDialogOpen) {
                document.body.classList.add('license-dialog-open');
            } else {
                document.body.classList.remove('license-dialog-open');
            }
        }

        // ========= 面板状态：有变更则保存 =========
        // 初始加载完成前不保存：此时 state 还是默认值，任何 setState（如 MainToggleBus
        // 轮询到的 isEnabled）都会以默认值覆盖 panel-state.json 里用户已保存的选项。
        if (!this.panelStateLoaded) return;
        const watchedKeys: Array<keyof typeof this.state> = [
            'isEnabled',
            'isExpanded',
            'isSelectionOptionsExpanded',
            'autoUpdateHistory',
            'deselectAfterFill',
            'switchToLassoOnEnable',
            'autoOffOnOtherTool',
            'strokeEnabled',
            'createNewLayer',
            'clearMode',
            'fillMode',
        ];
        const changed = watchedKeys.some(k => prevState[k] !== this.state[k]);
        if (changed) {
            PanelStateManager.update({
                appPanel: {
                    isEnabled: this.state.isEnabled,
                    isExpanded: this.state.isExpanded,
                    isSelectionOptionsExpanded: this.state.isSelectionOptionsExpanded,
                    autoUpdateHistory: this.state.autoUpdateHistory,
                    deselectAfterFill: this.state.deselectAfterFill,
                    switchToLassoOnEnable: this.state.switchToLassoOnEnable,
                    autoOffOnOtherTool: this.state.autoOffOnOtherTool,
                    strokeEnabled: this.state.strokeEnabled,
                    createNewLayer: this.state.createNewLayer,
                    clearMode: this.state.clearMode,
                    fillMode: this.state.fillMode,
                },
            }, { debounceMs: 400 }).catch(e => console.warn('⚠️ 保存面板状态失败:', e));
        }
    }

    async componentWillUnmount() {
        // 在应用关闭前强制保存所有预设
        try {
            await PresetManager.forceSaveAllPresets();
            console.log('✅ 应用关闭前预设保存完成');
        } catch (error) {
            console.error('❌ 应用关闭前预设保存失败:', error);
        }
        
        if (this.unsubMainToggle) {
            try { this.unsubMainToggle(); } catch { /* ignore */ }
            this.unsubMainToggle = null;
        }
        if (this.selectionChangeListener) {
            action.removeNotificationListener(['set'], this.selectionChangeListener);
        }
        action.removeNotificationListener(['set', 'select', 'clearEvent', 'delete', 'make'], this.handleNotification);
        document.removeEventListener('mousemove', this.handleMouseMove);
        document.removeEventListener('mouseup', this.handleMouseUp);
        // 清理CSS类
        document.body.classList.remove('secondary-panel-open');
        document.body.classList.remove('license-dialog-open');
    }

    handleButtonClick() {
        const prevEnabled = this.state.isEnabled;
        const nextEnabled = !prevEnabled;
        this.setState({ isEnabled: nextEnabled }, () => {
            PanelStateManager.update({
                appPanel: { isEnabled: this.state.isEnabled }
            }, { debounceMs: 0 }).catch(e => console.warn('⚠️ 主开关状态持久化失败:', e));
            // 同步到跨面板共享状态：不写的话，下次热键翻转是基于旧值算的，
            // 手动点开关之后按 Ctrl+Q 会得到「反直觉」的结果。
            setMainToggle(nextEnabled).catch(e => console.warn('⚠️ 主开关共享状态写入失败:', e));
        });
        // 主开关关闭→开启：按选项自动切换为套索工具
        void this.onMainToggleChanged(prevEnabled, nextEnabled);
    }

    /**
     * 重新指定「选区填充」主开关的全局快捷键（默认 Ctrl+Q）。
     * 录制由本地守护进程的全局键盘钩子完成：UXP 面板拿不到全局按键，
     * 这里只负责弹提示、发指令、把结果写回共享配置。
     */
    async setMainHotkey() {
        try {
            if (!isDaemonConnected()) {
                await core.showAlert({
                    message: '快捷键服务未连接，无法录制快捷键。\n请到「像素调整」面板的「笔刷热键」分区点一下「启动快捷键服务」。'
                });
                return;
            }
            const current = getMainToggleCombo();
            await core.showAlert({
                message: `点「确定」后，请直接按下要绑定的组合键（按 Esc 取消）。\n\n` +
                    `当前主开关快捷键：${current || '未绑定'}`
            });
            const res = await requestHotkeyRecording('选区填充主开关');
            if (!res) {
                await core.showAlert({ message: '已取消，主开关快捷键保持不变。' });
                return;
            }
            const ok = setMainToggleCombo(res.combo);
            await core.showAlert({
                message: ok
                    ? `主开关快捷键已设为：${res.combo}`
                    : '设置失败：快捷键服务未响应，请重新启动快捷键服务后重试。'
            });
        } catch (e) {
            console.error('❌ 设置主开关快捷键失败:', e);
            try { await core.showAlert({ message: '设置主开关快捷键时出错，详见控制台日志。' }); } catch { /* ignore */ }
        }
    }


    // 新增方法
    toggleSelectionOptions() {
        this.setState(prevState => ({
            isSelectionOptionsExpanded: !prevState.isSelectionOptionsExpanded
        }));
    }

    handleSelectionSmoothChange(value: number) {
        this.setState({ selectionSmooth: value });
    }

    handleSelectionContrastChange(value: number) {
        this.setState({ selectionContrast: value });
    }

    handleSelectionExpandChange(value: number) {
        this.setState({ selectionExpand: value });
    }

    // 应用选区修改
    async applySelectionModification() {
        const options: SelectionOptions = {
            selectionSmooth: this.state.selectionSmooth,
            selectionContrast: this.state.selectionContrast,
            selectionExpand: this.state.selectionExpand
        };
        
        try {
            await SelectionHandler.applySelectionModification(options);
        } catch (error) {
            console.error('选区修改失败:', error);
        }
    }

    toggleExpand() {
        this.setState(prevState => {
            const isExpanded = !prevState.isExpanded;
            return { isExpanded };
        });
    }

    toggleStrokeEnabled() {
        this.setState({ strokeEnabled: !this.state.strokeEnabled });
    }
    
    toggleClearMode() {
        this.setState(prevState => ({
            clearMode: !prevState.clearMode,
            createNewLayer: prevState.clearMode ? prevState.createNewLayer : false // 如果开启清除模式，关闭新建图层模式
        }));
    }

    handleFillModeChange(event: CustomEvent) {
        try {
            if (!this || !this.state || !event || !event.target) {
                return;
            }
            const value = event.target.selected;
            this.setState({ fillMode: value });
        } catch (error) {
        }
    }

    toggleStrokeSetting() {
        this.setState({ isStrokeSettingOpen: true });
    }

    toggleColorSettings() {
        this.setState(prev => ({ isColorSettingsOpen: !prev.isColorSettingsOpen }));
    }

    openPatternPicker() {
        this.setState({ isPatternPickerOpen: true });
    }

    openGradientPicker() {
        this.setState({ isGradientPickerOpen: true });
    }

    handleColorSettingsSave(settings: ColorSettings) {
        try {
            // 验证设置值是否在有效范围内
            const validatedSettings = {
                hueVariation: Math.min(360, Math.max(0, settings.hueVariation)),
                saturationVariation: Math.min(100, Math.max(0, settings.saturationVariation)),
                brightnessVariation: Math.min(100, Math.max(0, settings.brightnessVariation)),
                opacityVariation: Math.min(100, Math.max(0, settings.opacityVariation)),
                pressureVariation: Math.min(100, Math.max(0, settings.pressureVariation)),
                grayVariation: Math.min(100, Math.max(0, settings.grayVariation || 0)),
                calculationMode: settings.calculationMode || 'absolute'
            };

            // 只保存设置，不关闭面板
            this.setState({
                colorSettings: validatedSettings
            });
        } catch (error) {
            console.error('保存颜色设置失败:', error);
            // 可以添加错误提示UI
        }
    }

    handlePatternSelect(pattern: Pattern) {
        this.setState({
            selectedPattern: pattern
        });
    }

    handleGradientSelect(gradient: Gradient | null) {
        this.setState({
            selectedGradient: gradient
        });
        PanelStateManager.update(
            { appPanel: { selectedGradient: gradient } },
            { debounceMs: 200 }
        ).catch(e => console.warn('⚠️ 保存当前渐变设置失败:', e));
    }

    closeColorSettings() {
        this.setState({ isColorSettingsOpen: false });
    }

    closePatternPicker() {
        this.setState({ isPatternPickerOpen: false });
    }

    closeGradientPicker() {
        this.setState({ isGradientPickerOpen: false });
    }

    closeStrokeSetting() {
        this.setState({ isStrokeSettingOpen: false });
    }

    async handleSelectionChange(event?: any) {
        if (!this.state.isEnabled) return;
        // 检查事件中是否包含feather项，如果包含则直接返回
        if (event && event.feather) {
            return;
        }

        // 【同步锁】检查是否正在处理；必须在任何 await 之前完成，避免竞态
        if (this.isFilling) {
            // 已有正在进行的填充，把"需要再处理一次"标记上，
            // 等当前这一轮结束后由 finally 重新触发一次（而非并发覆盖）
            this.pendingSelection = true;
            return;
        }

        try {
            const doc = app.activeDocument;
            if (!doc) {
                return;
            }

            // 检测快速蒙版状态（廉价读取，不阻塞）
            const isInQuickMask = doc.quickMaskMode;
            if (this.state.isInQuickMask !== isInQuickMask) {
                this.setState({ isInQuickMask });
            }

            // 上锁（在任何 await 之前同步置位，让后续事件被 pendingSelection 捕获）
            this.isFilling = true;

            const selection = await this.getSelection();
            if (!selection) {
                // 选区为空，跳过填充
                return;
            }

            const featherAmount = Number(this.state.feather);
            const needsFeather = featherAmount > 0;
            const options: SelectionOptions = {
                selectionSmooth: this.state.selectionSmooth,
                selectionContrast: this.state.selectionContrast,
                selectionExpand: this.state.selectionExpand
            };
            const needsSelectionMod = SelectionHandler.shouldApplySelectionModification(options);
            const needsStroke = this.state.strokeEnabled;
            const needsDeselect = this.state.deselectAfterFill;
            const needsHistory = this.state.autoUpdateHistory;

            await core.executeAsModal(async () => {
                // 【关键防御】重新校验选区——前一次填充若开了 deselectAfterFill，
                // 这里的 selection 可能已经在排队期间被清空；空选区下 fill 整个图层
                // 表现为"填充整个文档"。直接放弃本轮，避免误伤整张画布。
                const innerSelection = await this.getSelection();
                if (!innerSelection) {
                    console.warn('⚠️ 选区已为空，跳过本次填充（避免填充整个图层）');
                    return;
                }

                // 把整次填充（历史画笔源 / 选区修改 / 羽化 / 填充 / 描边 / 取消选区）
                // 合并成【一条】历史记录，方便整体撤回。suspendHistory 本身是
                // executeAsModal 的封装，可直接嵌套在当前 executeAsModal 作用域内使用。
                const modeLabel =
                    this.state.fillMode === 'pattern' ? '选区图案填充'
                    : this.state.fillMode === 'gradient' ? '选区渐变填充' : '选区纯色填充';
                await doc.suspendHistory(async () => {
                    if (needsHistory) {
                        await this.setHistoryBrushSource();
                    }
                    // 只有当选区选项值不为初始值时才执行选区修改
                    if (needsSelectionMod) {
                        await this.applySelectionModification();
                    }
                    // feather=0 时整段 applyFeather 都是无效工作，直接跳过
                    if (needsFeather) {
                        await this.applyFeather(featherAmount);
                    }
                    const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                    const fillSuccess = await this.fillSelection(layerInfo);
                    if (needsStroke && fillSuccess) {
                        await strokeSelection(this.state, layerInfo);
                    }
                    if (needsDeselect) {
                        await this.deselectSelection();
                    }
                }, modeLabel);
            }, { commandName: '正在处理选区中......' });
        } catch (error) {
            console.error('❌ 处理失败:', error);
        } finally {
            this.isFilling = false;
            // 若填充期间又有新的选区事件进来，再处理一次，
            // 这样套索连点也不会丢选区
            if (this.pendingSelection) {
                this.pendingSelection = false;
                // 用 setTimeout(0) 把递归触发推到下一个事件循环，
                // 避免在 finally 里直接重入导致栈过深
                setTimeout(() => {
                    if (this.state.isEnabled) {
                        this.handleSelectionChange();
                    }
                }, 0);
            }
        }
    }

    async getSelection() {
        try {
            const result = await action.batchPlay(
                [
                    {
                        _obj: 'get',
                        _target: [
                            { _property: 'selection' },
                            { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' },
                        ],
                    },
                ],
                { synchronousExecution: true }
            );
            if (result && result.length > 0 && result[0].selection) {
                return result[0].selection;
            } else {
                return null;
            }
        } catch (error) {
            console.error('❌ 获取选区失败:', error);
            return null;
        }
    }

    async setHistoryBrushSource() {
        const doc = app.activeDocument;
        if (!doc) {
            console.warn('⚠️ 没有打开的文档，跳过更新历史记录画笔源');
            return;
        }

        const historyStates = doc.historyStates;
        if (historyStates.length === 0) {
            console.warn('⚠️ 历史记录堆栈为空，跳过更新历史记录画笔源');
            return;
        }

        try {
            await action.batchPlay(
                [
                    {
                        _obj: 'set',
                        _target: [
                            {
                                _ref: 'historyState',
                                _property: 'historyBrushSource'
                            }
                        ],
                        to: {
                             _ref: "historyState",
                            _property: "currentHistoryState"
                        },
                        _options: {
                            dialogOptions: 'dontDisplay'
                        }
                    }
                ],
                {}
            );
        } catch (error) {
            console.error(error);
        }  
    }

    async applyFeather(featherAmount: number) {
        // 调用方已保证 featherAmount > 0；负值/0 不应进入此函数
        if (featherAmount <= 0) return;
        await action.batchPlay(
            [
                {
                    _obj: 'feather',
                    radius: featherAmount,
                    _isCommand: true
                },
            ],
            { synchronousExecution: true, modalBehavior: 'execute' }
        );
    }

     // 修改新建图层模式切换函数
     toggleCreateNewLayer() {
        this.setState(prevState => ({
            createNewLayer: !prevState.createNewLayer,
            clearMode: prevState.createNewLayer ? prevState.clearMode : false 
        }));
    }

    async fillSelection(layerInfo?: LayerInfo | null) {
        // 统一处理：若当前目标图层被隐藏，在操作前临时显示，操作后恢复隐藏
        // 注意：当选择"新建图层"时，目标会变为新图层（可见），无需临时显示原图层
        let needToggleVisibility = false;
        const showTargetLayer = {
            _obj: "show",
            null: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            _isCommand: false
        };
        const hideTargetLayer = {
            _obj: "hide",
            null: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            _isCommand: false
        };
        try {
            // 授权门控：未授权且非试用，打开授权窗口并阻止功能
            if (!this.state.isLicensed && !this.state.isTrial) {
                this.setState({ isLicenseDialogOpen: true });
                return false;
            }

            // 记录原始活动图层的可见性（当不新建图层时需要临时显示隐藏图层以避免合并/删除警告）
            try {
                const activeDoc = app.activeDocument;
                const originalLayer = activeDoc.activeLayers && activeDoc.activeLayers.length > 0 ? activeDoc.activeLayers[0] : null;
                const originalWasHidden = originalLayer ? (originalLayer.visible === false) : false;
                needToggleVisibility = !!(originalWasHidden && !this.state.createNewLayer);
                if (needToggleVisibility) {
                    await action.batchPlay([showTargetLayer], {});
                }
            } catch (e) {
                console.warn('读取/切换图层可见性失败，继续执行填充流程:', e);
            }

            // 检查是否在单通道模式
            const isInSingleChannel = await LayerInfoHandler.checkSingleColorChannelMode();
            if (isInSingleChannel) {

                const fillOptions = {
                    opacity: this.state.opacity,
                    blendMode: this.state.blendMode,
                    pattern: this.state.selectedPattern,
                    gradient: this.state.selectedGradient
                };

                if (this.state.clearMode) {
                    const ok = await SingleChannelHandler.clearSingleChannel(fillOptions, this.state.fillMode, this.state);
                    return ok === undefined ? true : !!ok; // 若内部未显式返回，视为成功
                } else {
                    const ok = await SingleChannelHandler.fillSingleChannel(fillOptions, this.state.fillMode, this.state);
                    return ok === undefined ? true : !!ok;
                }
            }

            // 复用调用方已查询的 layerInfo，避免在一次填充中重复 3 次 batchPlay
            if (!layerInfo) {
                layerInfo = await LayerInfoHandler.getActiveLayerInfo();
            }
            if (!layerInfo) return false;

            if (this.state.clearMode) {
                await ClearHandler.clearWithOpacity(this.state.opacity, this.state, layerInfo);
                return true;
            }

            if (this.state.createNewLayer && this.state.fillMode !== 'gradient') {
                await action.batchPlay(
                    [{
                        _obj: "make",
                        _target: [{ _ref: "layer" }],
                        using: {
                            _obj: "layer",
                            mode: {
                                _enum: "blendMode",
                                _value: BLEND_MODES[this.state.blendMode] || "normal"
                            }
                        },
                        _options: { dialogOptions: "dontDisplay" }
                    }],
                    { synchronousExecution: true }
                );
            }

            const { isBackground, hasTransparencyLocked, hasPixels } = layerInfo;
    
            if (this.state.fillMode === 'pattern') {
                if (this.state.selectedPattern) {
                    await PatternFill.fillPattern({
                        opacity: this.state.opacity,
                        blendMode: this.state.blendMode,
                        pattern: this.state.selectedPattern,
                        preserveTransparency: this.state.selectedPattern.preserveTransparency
                    }, layerInfo, this.state);
                    return true;
                } else {
                    // 缺少图案预设，显示警告并跳过填充
                    await core.showAlert({ message: '请先选择一个图案预设' });
                    return false;
                }
            } else if (this.state.fillMode === 'gradient') {
                if (this.state.selectedGradient) {
                    await GradientFill.fillGradient({
                        opacity: this.state.opacity,
                        blendMode: this.state.blendMode,
                        gradient: this.state.selectedGradient,
                        preserveTransparency: this.state.selectedGradient.preserveTransparency
                    }, layerInfo, this.state, this.state.createNewLayer);
                    return true;
                } else {
                    // 缺少渐变预设，显示警告并跳过填充
                    await core.showAlert({ message: '请先选择一个渐变预设' });
                    return false; 
                } 
            } else {
                // 检测是否在快速蒙版状态
                const isInQuickMask = layerInfo.isInQuickMask;
                const randomColor = calculateRandomColor(this.state.colorSettings, this.state.opacity, undefined, isInQuickMask);
                
                // 只有在快速蒙版状态且为selectedAreas模式时，才反转灰度值
                let finalColor = randomColor;
                if (isInQuickMask) {
                    // 获取快速蒙版的isSelectedAreas属性
                    try {
                        const channelResult = await action.batchPlay([
                            {
                                _obj: "get",
                                _target: [
                                    {
                                        _ref: "channel",
                                        _name: "快速蒙版"
                                    }
                                ]
                            }
                        ], { synchronousExecution: true });
                        
                        let isSelectedAreas = false;
                        if (channelResult[0] && 
                            channelResult[0].alphaChannelOptions && 
                            channelResult[0].alphaChannelOptions.colorIndicates) {
                            isSelectedAreas = channelResult[0].alphaChannelOptions.colorIndicates._value === "selectedAreas";
                        }
                        
                        // 只有在selectedAreas模式下才反转灰度值
                        if (isSelectedAreas) {
                            // 将HSB转换为RGB，计算灰度值，然后反转
                            const rgb = hsbToRgb(randomColor.hsb.hue, randomColor.hsb.saturation, randomColor.hsb.brightness);
                            const originalGrayValue = rgbToGray(rgb.red, rgb.green, rgb.blue);
                            const invertedGrayValue = 255 - originalGrayValue;
                            
                            // 将反转后的灰度值转换回HSB（亮度值）
                            const invertedBrightness = (invertedGrayValue / 255) * 100;
                            
                            finalColor = {
                                ...randomColor,
                                hsb: {
                                    ...randomColor.hsb,
                                    brightness: invertedBrightness
                                }
                            };
                        }
                    } catch (error) {
                        console.error('获取快速蒙版属性失败:', error);
                    }
                }
                
                const fillOptions = {
                    opacity: finalColor.opacity,
                    blendMode: this.state.blendMode,
                    color: finalColor
                };

                // 更新填充命令以使用随机颜色
                const command = FillHandler.createColorFillCommand(fillOptions);
    
                if (isBackground) {
                    await FillHandler.fillBackground(fillOptions);
                } 
                else if (hasTransparencyLocked && hasPixels) {
                    await FillHandler.fillLockedWithPixels(fillOptions);
                } 
                else if (hasTransparencyLocked && !hasPixels) {
                    await FillHandler.fillLockedWithoutPixels(
                        fillOptions,
                        () => this.unlockLayerTransparency(),
                        () => this.lockLayerTransparency()
                    );
                } 
                else if (!hasTransparencyLocked && !isBackground) {
                    await FillHandler.fillUnlocked(fillOptions);
                }
                return true;
            }
        } catch (error) {
            console.error('填充选区失败:', error);
            return false;
        } finally {
            try {
                if (needToggleVisibility) {
                    await action.batchPlay([hideTargetLayer], {});
                }
            } catch (e) {
                console.warn('恢复图层隐藏状态失败:', e);
            }
        }
    }

    // 设置图层透明度锁定
    async lockLayerTransparency() {
        try {
            await action.batchPlay([
                {
                    _obj: "applyLocking",
                    _target: [
                        { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
                    ],
                    layerLocking: {
                        _obj: "layerLocking",
                        protectTransparency: true
                    },
                    _options: { dialogOptions: "dontDisplay" }
                }
            ], { synchronousExecution: true });
        } catch (error) {}
    }

    // 设置图层透明度不锁定
    async unlockLayerTransparency() {
        try {
            await action.batchPlay([
                {
                    _obj: "applyLocking",
                    _target: [
                        { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
                    ],
                    layerLocking: {
                        _obj: "layerLocking",
                        protectNone: true
                    },
                    _options: { dialogOptions: "dontDisplay" }
                }
            ], { synchronousExecution: true });
        } catch (error) {}
    }

    async deselectSelection() {
        await action.batchPlay([
           {
            _obj: "set",
            _target: [
               {
                  _ref: "channel",
                  _property: "selection"
               }
            ],
            to: {
               _enum: "ordinal",
               _value: "none"
            },
            _options: {
               dialogOptions: "dontDisplay"
            }
         }
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
    }

    // 处理标签鼠标按下事件
    handleLabelMouseDown(event, target) {
        if (!this || !this.state) return;
        event.preventDefault();
        this.setState({
            isDragging: true,
            dragStartX: event.clientX,
            dragStartValue: this.state[target],
            dragTarget: target
        });
    }

    // 处理鼠标移动事件
    handleMouseMove(event: MouseEvent): void {
        if (!this.state || !this.state.isDragging || !this.state.dragTarget) return;
        
        const newValue = DragHandler.calculateNewValue(
            this.state.dragTarget,
            this.state.dragStartValue,
            this.state.dragStartX,
            event.clientX
        );
        
        this.setState({ [this.state.dragTarget]: newValue });
    }

    // 处理鼠标释放事件
    handleMouseUp(): void {
        if (!this || !this.state) return;
        this.setState({ isDragging: false });
    }

    handleOpacityChange(value: number) {
        this.setState({ opacity: value });
    }

    handleFeatherChange(value: number) {
        this.setState({ feather: value });
    }

    handleBlendModeChange(event) {
        const newBlendMode = event.target.value;
        this.setState({ blendMode: newBlendMode });
    }

    toggleAutoUpdateHistory() {
        this.setState({ autoUpdateHistory: !this.state.autoUpdateHistory });
    }
    
    toggleDeselectAfterFill() {
        this.setState({ deselectAfterFill: !this.state.deselectAfterFill });
    }

    // ===== 新增：主开关的两个联动选项 =====
    // 开启主开关时，若用户把当前工具切到这些「其它工具」，则自动关闭主开关
    private static readonly AUTO_OFF_TOOLS = [
        'paintbrushTool',  // 画笔
        'pencilTool',      // 铅笔
        'eraserTool',      // 橡皮
        'wetBrushTool',    // 混合器画笔
        'bucketTool',      // 油漆桶
        'gradientTool',    // 渐变
        'moveTool',        // 移动
        'smudgeTool',      // 涂抹
    ];

    toggleSwitchToLassoOnEnable() {
        this.setState({ switchToLassoOnEnable: !this.state.switchToLassoOnEnable });
    }

    toggleAutoOffOnOtherTool() {
        this.setState({ autoOffOnOtherTool: !this.state.autoOffOnOtherTool });
    }

    /**
     * 主开关状态发生「实际翻转」时的副作用。
     * 只在 关闭→开启 的瞬间按选项自动切换为套索工具。
     * 注意：本方法既被 handleButtonClick（点开关）调用，也被
     * subscribeMainToggle 的回调（热键/其它面板翻转）调用——两条路径都会收敛到这里，
     * 但开关已经是新值（已 setState），所以不会因为重复触发而重复切工具。
     */
    private async onMainToggleChanged(prevEnabled: boolean, nextEnabled: boolean) {
        if (nextEnabled && !prevEnabled && this.state.switchToLassoOnEnable) {
            await this.selectLassoTool();
        }
    }

    // 自动切换为套索工具（主开关关闭→开启时）
    // 复用 HotkeyBridge.applyBrush 已验证的切工具写法：先直连 batchPlay，
    // 失败（某些 PS 版本/状态下要求模态作用域）再回退 executeAsModal。
    private async selectLassoTool() {
        const descriptor: any = {
            _obj: 'select',
            _target: [{ _ref: 'lassoTool' }],
            dontRecord: true,
            forceNotify: true,
            _isCommand: false
        };
        try {
            await action.batchPlay([descriptor], { synchronousExecution: true });
        } catch (directErr) {
            // 直连失败 → 回退模态作用域（与 applyBrush 一致）
            try {
                await core.executeAsModal(async () => {
                    await action.batchPlay([descriptor], { synchronousExecution: true });
                }, { commandName: '切换套索工具' });
            } catch (e) {
                console.warn('⚠️ 自动切换套索工具失败（主开关开启时）:', e);
            }
        }
    }

    // 从 select 通知的 descriptor 解析被选中的工具 key；非工具选择返回 null
    private resolveSelectedTool(descriptor: any): string | null {
        const target = descriptor?._target;
        if (Array.isArray(target)) {
            for (const t of target) {
                if (!t) continue;
                if (t._ref === 'tool' && typeof t._value === 'string') return t._value;
                if (typeof t._ref === 'string' && /Tool$/.test(t._ref)) return t._ref;
            }
        }
        return null;
    }

    // 自动关闭主开关（切到其它工具时）
    private async autoTurnOffMain() {
        this.setState({ isEnabled: false }, () => {
            PanelStateManager.update({
                appPanel: { isEnabled: false }
            }, { debounceMs: 0 }).catch(e => console.warn('⚠️ 主开关状态持久化失败:', e));
            setMainToggle(false).catch(e => console.warn('⚠️ 主开关共享状态写入失败:', e));
        });
    }

    // 检测蒙版模式状态
    async checkMaskModes() {
        try {
            const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
            this.isInLayerMask = layerInfo?.isInLayerMask || false;
            this.isInQuickMask = layerInfo?.isInQuickMask || false;
            this.isInSingleColorChannel = layerInfo?.isInSingleColorChannel || false;
        } catch (error) {
            console.error('检测蒙版模式失败:', error);
            this.isInLayerMask = false;
            this.isInQuickMask = false;
            this.isInSingleColorChannel = false;
        }
    }

    // 处理Photoshop通知事件
    async handleNotification(eventName?: string, descriptor?: any) {
        try {
            // 检测图层蒙版和快速蒙版状态
            await this.checkMaskModes();
            // 强制重新渲染以更新颜色预览
            this.forceUpdate();
        } catch (error) {
            // 静默处理错误，避免频繁的错误日志
        }

        // 主开关处于开启状态，且开启了「切到其它工具即关」选项时，
        // 若本次 select 事件确实是切换到了画笔/铅笔/橡皮等其它工具，则自动关闭主开关。
        try {
            if (this.state.isEnabled && this.state.autoOffOnOtherTool && eventName === 'select') {
                const tool = this.resolveSelectedTool(descriptor);
                if (tool && App.AUTO_OFF_TOOLS.indexOf(tool) !== -1) {
                    await this.autoTurnOffMain();
                }
            }
        } catch (e) {
            console.warn('⚠️ 工具切换自动关闭主开关判断失败:', e);
        }
    }

    // 获取描边颜色预览样式
    getStrokeColorPreviewStyle() {
        const { strokeColor, clearMode } = this.state;
        const shouldShowGray = clearMode || this.isInLayerMask || this.isInQuickMask || this.isInSingleColorChannel;
        
        if (!strokeColor) {
            return { backgroundColor: 'rgb(0, 0, 0)' };
        }
        
        if (shouldShowGray) {
            // 使用灰度显示：将RGB转换为灰度值
            const grayValue = Math.round(strokeColor.red * 0.299 + strokeColor.green * 0.587 + strokeColor.blue * 0.114);
            return { backgroundColor: `rgb(${grayValue}, ${grayValue}, ${grayValue})` };
        } else {
            // 正常彩色显示
            return { backgroundColor: `rgb(${strokeColor.red}, ${strokeColor.green}, ${strokeColor.blue})` };
        }
    }  

    // ===== 许可证相关方法 =====
    async checkLicenseStatus() {
        try {
            // 统一判定（唯一事实来源）：TRIAL_ 密钥只算试用，永不计入正式授权。
            // 早期版本这里直接取 status.isValid，导致试用态被误判为「已激活」，
            // 重载后「注销激活状态」菜单项在试用态下依然可点。
            const { isLicensed, isTrial, trialDaysRemaining } = await LicenseManager.getLicenseState();

            // 控制对话框打开逻辑：首次启动若未授权则打开
            this.setState({
                isLicensed,
                isTrial,
                trialDaysRemaining,
                isLicenseDialogOpen: !(isLicensed || isTrial)
            });
            // 「注销激活状态」只有正式激活（非试用）才可点击
            MenuManager.setLicenseLogoutEnabled(isLicensed && !isTrial);
            // 检查完成后广播一次：绘画工具箱监听此事件、经 getLicenseState 的
            // 记忆化缓存立即拿到同一份结果 —— 两面板的锁定遮罩/弹窗同刻出现。
            document.dispatchEvent(new Event('license-updated'));
        } catch (e) {
            console.warn('检查许可证状态失败:', e);
            this.setState({ isLicensed: false, isTrial: false, isLicenseDialogOpen: true });
            MenuManager.setLicenseLogoutEnabled(false);
        }
    }

    handleLicenseVerified() {
        this.setState({ isLicensed: true, isTrial: false, isLicenseDialogOpen: false });
        // 对话框关闭，移除类名恢复输入框
        document.body.classList.remove('license-dialog-open');
        // 在弹窗关闭的同刻广播：绘画工具箱的锁定遮罩随之解除，两遮罩同步消失。
        // （广播不能更早 —— LicenseDialog 验证成功后还要停留 800ms 展示「激活成功！」）
        document.dispatchEvent(new Event('license-updated'));
        // 正式激活后可注销
        MenuManager.setLicenseLogoutEnabled(true);
    }

    handleTrialStarted() {
        // 试用7天
        this.setState({ isLicensed: false, isTrial: true, isLicenseDialogOpen: false, trialDaysRemaining: 7 });
        // 对话框关闭，移除类名恢复输入框
        document.body.classList.remove('license-dialog-open');
        // 同上：弹窗关闭同刻广播，工具箱同步切换到试用态（横幅变绿、不锁定）
        document.dispatchEvent(new Event('license-updated'));
        // 试用状态不允许注销
        MenuManager.setLicenseLogoutEnabled(false);
    }

    closeLicenseDialog() {
        this.setState({ isLicenseDialogOpen: false });
        // 移除body类名，恢复输入框显示
        document.body.classList.remove('license-dialog-open');
    }

    // 新增：手动打开授权对话框
    openLicenseDialog() {
        this.setState({ isLicenseDialogOpen: true });
        // 添加body类名，隐藏输入框
        document.body.classList.add('license-dialog-open');
    }

    // 临时调试方法：重置许可证状态
    async resetLicenseForTesting() {
        try {
            await LicenseManager.clearLicense();
            // 也清除试用记录
            try {
                const localFileSystem = storage.localFileSystem;
                const dataFolder = await localFileSystem.getDataFolder();
                const trialFile = await dataFolder.getEntry('trial.json');
                await trialFile.delete();
            } catch (e) {
                // 试用文件可能不存在，忽略错误
            }
            
            // 重置状态并显示对话框
            this.setState({
                isLicensed: false,
                isTrial: false,
                isLicenseDialogOpen: true,
                trialDaysRemaining: 0
            });
            // 注销后回到未激活态，菜单项重新禁用
            MenuManager.setLicenseLogoutEnabled(false);
            
            console.log('许可证状态已重置，可重新测试授权流程');
        } catch (error) {
            console.error('重置许可证状态失败:', error);
        }
    }

    render() {
        return (
            <div>
                {/* 授权对话框 */}
                <LicenseDialog
                    isOpen={this.state.isLicenseDialogOpen}
                    isLicensed={this.state.isLicensed}
                    isTrial={this.state.isTrial}
                    trialDaysRemaining={this.state.trialDaysRemaining}
                    onLicenseVerified={this.handleLicenseVerified}
                    onTrialStarted={this.handleTrialStarted}
                    onClose={this.closeLicenseDialog}
                />
                <div className="selection-fill-container">
                <h3 className="selection-fill-title" title={helpTexts.selectionFill.panelTitle}>
                    <span className="selection-fill-title-text">选区填充2.0</span>                    
                </h3>
                <div className="main-button-container">
                    <div 
                    role="button"
                    tabIndex={0}
                    className={`main-button ${this.state.isEnabled ? 'enabled' : ''}`} 
                    onClick={this.handleButtonClick}
title={helpTexts.selectionFill.mainButton}>
                        <div className="main-button-content">
                            <div className={`main-button-indicator ${this.state.isEnabled ? 'enabled' : 'disabled'}`}></div>
                            <span className={`main-button-text ${!this.state.isEnabled ? 'disabled' : ''}`}>
                                {this.state.isEnabled ? '功能开启' : '功能关闭'}
                            </span>
                        </div>
                    </div>
                </div>

                <div className="selection-fill-blend-mode-container">
                    <span className={`selection-fill-blend-mode-label ${this.state.clearMode ? 'disabled' : ''}`} 
title={helpTexts.selectionFill.blendMode}>
                    混合模式：
                    </span>

                    <Select
                        value={this.state.blendMode || "正常"}
                        groups={BLEND_MODE_OPTIONS}
                        disabled={this.state.clearMode}
                        onChange={(v) => this.handleBlendModeChange({ target: { value: v } } as React.ChangeEvent<HTMLSelectElement>)}
                        title={helpTexts.selectionFill.blendModeSelect}
                    />
                </div>

                <div className="slider-container">
                    <div className="entire-slider">
                    <div className={`slider-parameter-collection ${
                            this.state.isDragging && this.state.dragTarget === 'opacity'
                            ? 'dragging'
                            : 'not-dragging'
                        }`}>
                    <label
                        className="slider-text slider-text-4"
                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'opacity')}
title={helpTexts.selectionFill.opacity}>
                    不透明度
                    </label>

                    <div className="num-input-wrap">
                    <div className="num-input-row">
                    <input
                        type="number"
                        min="0"
                        max="100"
                        value={this.state.opacity}
                        onChange={(e) => this.setState({ opacity: Number(e.target.value) })}
                        title={helpTexts.selectionFill.opacityInput}
                    />
                    </div>
                    <span className="num-unit">%</span>
                    </div>

                    </div>
                    <RangeSlider
                        min={0}
                        max={100}
                        step={1}
                        value={this.state.opacity}
                        onChange={this.handleOpacityChange}
                        className="slider-input"
                        title={helpTexts.selectionFill.opacitySlider}
                    />
                    </div>

                    <div className="entire-slider">
                    <div className={`slider-parameter-collection ${
                            this.state.isDragging && this.state.dragTarget === 'feather'
                            ? 'dragging'
                            : 'not-dragging'
                        }`}>
                    <label
                        className="slider-text slider-text-2"
                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'feather')}
title={helpTexts.selectionFill.feather}>
                        羽化
                    </label>

                    <div className="num-input-wrap">
                    <div className="num-input-row">
                    <input
                        type="number"
                        min="0"
                        max="20"
                        value={this.state.feather}
                        onChange={(e) => this.setState({ feather: Number(e.target.value) })}
                        title={helpTexts.selectionFill.featherInput}
                        />
                    </div>
                    <span className="num-unit">px</span>
                    </div>

                    </div>
                    <RangeSlider
                        min={0}
                        max={20}
                        step={0.5}
                        value={this.state.feather}
                        onChange={this.handleFeatherChange}
                        className="slider-input"
                        title={helpTexts.selectionFill.featherSlider}
                    />
                    </div>
                </div>
                </div>

 {/* 新增选区选项区域 */}
            <div className="expand-section">
                            <div className="expand-header" onClick={this.toggleSelectionOptions} title={helpTexts.selectionFill.selectionOptionsToggle}>

                                <div className={`expand-icon ${this.state.isSelectionOptionsExpanded ? 'expanded' : ''}`}>
                                    <ExpandIcon expanded={this.state.isSelectionOptionsExpanded} />
                                </div>
                                <span>选区选项</span>
                            </div>
                            <div className={`expand-content ${this.state.isSelectionOptionsExpanded ? 'expanded' : ''}`}>
                                <div className="selection-slider-container">
                                    <div className="selection-slider-item">
                                    <label
                                        className={`selection-slider-label ${
                                            this.state.isDragging && this.state.dragTarget === 'selectionSmooth' 
                                            ? 'dragging' 
                                            : 'not-dragging'
                                        }`}
                                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'selectionSmooth')}
title={helpTexts.selectionFill.selectionSmooth}>
                                        平滑
                                    </label>
                                    <RangeSlider
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={this.state.selectionSmooth}
                                        onChange={this.handleSelectionSmoothChange}
                                        className="selection-slider-input"
                                        title={helpTexts.selectionFill.selectionSmoothSlider}
                                    />
                                    <div className="num-input-wrap">
                                        <div className="num-input-row">
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={this.state.selectionSmooth}
                                            onChange={(e) => this.setState({ selectionSmooth: Number(e.target.value) })}
                                                                title={helpTexts.selectionFill.selectionSmoothInput}
                                        />
                                        </div>
                                        <span className="num-unit">%</span>
                                    </div>
                                    </div>
                            
                                    <div className="selection-slider-item">
                                    <label
                                        className={`selection-slider-label ${
                                            this.state.isDragging && this.state.dragTarget === 'selectionContrast' 
                                            ? 'dragging' 
                                            : 'not-dragging'
                                        }`}
                                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'selectionContrast')}
title={helpTexts.selectionFill.selectionContrast}>
                                        锐度

                                    </label>
                                    <RangeSlider
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={this.state.selectionContrast}
                                        onChange={this.handleSelectionContrastChange}
                                        className="selection-slider-input"
                                        title={helpTexts.selectionFill.selectionContrastSlider}
                                    />
                                    <div className="num-input-wrap">
                                        <div className="num-input-row">
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={this.state.selectionContrast}
                                            onChange={(e) => this.setState({ selectionContrast: Number(e.target.value) })}
                                                                title={helpTexts.selectionFill.selectionContrastInput}
                                        />
                                        </div>
                                        <span className="num-unit">%</span>
                                    </div>
                                    </div>

                                    <div className="selection-slider-item">
                                    <label
                                        className={`selection-slider-label ${
                                            this.state.isDragging && this.state.dragTarget === 'selectionExpand' 
                                            ? 'dragging' 
                                            : 'not-dragging'
                                        }`}
                                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'selectionExpand')}
title={helpTexts.selectionFill.selectionExpand}>
                                        扩散
                                    </label>
                                    <RangeSlider
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={this.state.selectionExpand}
                                        onChange={this.handleSelectionExpandChange}
                                        className="selection-slider-input"
                                        title={helpTexts.selectionFill.selectionExpandSlider}
                                    />
                                    <div className="num-input-wrap">
                                        <div className="num-input-row">
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={this.state.selectionExpand}
                                            onChange={(e) => this.setState({ selectionExpand: Number(e.target.value) })}
                                                                title={helpTexts.selectionFill.selectionExpandInput}
                                        />
                                        </div>
                                        <span className="num-unit">%</span>
                                    </div>
                                    </div>
                                </div>
                            </div>
                        </div>


            <div className="expand-section">
                    <div className="expand-header" onClick={this.toggleExpand} title={helpTexts.selectionFill.fillOptionsToggle}>
                        <div className={`expand-icon ${this.state.isExpanded ? 'expanded' : ''}`}>
                            <ExpandIcon expanded={this.state.isExpanded} />
                        </div>
                        <span>填充选项</span>
                    </div>
                    <div className={`expand-content ${this.state.isExpanded ? 'expanded' : ''}`}>


                        {/* 新建图层开关 */}
                        <div className="switch-container">
                            <span className="switch-label" 
title={helpTexts.selectionFill.createNewLayer}>
                            新建图层
                            </span>
                            <sp-switch 
                                checked={this.state.createNewLayer}
                                onChange={this.toggleCreateNewLayer}
                                disabled={this.state.clearMode || this.state.isInQuickMask}
                                title={helpTexts.selectionFill.createNewLayerSwitch}
                            />
                        </div>

                       {/* 描边模式开关 */}
                       <div className="switch-container">
                            <label className="switch-label" title={helpTexts.selectionFill.strokeModeLabel}>描边模式</label>
                            {this.state.strokeEnabled && (
                                <div className="stroke-color-group">
                                <div 
                                    className="stroke-color-preview"
                                    style={this.getStrokeColorPreviewStyle()}
                                    title={helpTexts.selectionFill.strokeColorPreview}
                                    onClick={async () => {
                                        try {
                                            // 1. 保存当前前景色
                                            let savedForegroundColor;
                                            await executeAsModal(async () => {
                                                const foregroundColor = app.foregroundColor;
                                                savedForegroundColor = {
                                                    hue: {
                                                        _unit: "angleUnit",
                                                        _value: foregroundColor.hsb.hue
                                                    },
                                                    saturation: foregroundColor.hsb.saturation,
                                                    brightness: foregroundColor.hsb.brightness
                                                };
                                            });

                                            // 2. 显示颜色选择器
                                            const result = await require("photoshop").core.executeAsModal(async (executionControl, descriptor) => {
                                                return await batchPlay(
                                                    [{
                                                        _obj: "showColorPicker",
                                                        _target: [{
                                                            _ref: "application"
                                                        }]
                                                    }],
                                                    {}
                                                );
                                            });
                                        
                                            // 3. 处理颜色选择结果
                                            if (result && result[0] && result[0].RGBFloatColor) {
                                                const { red, grain, blue } = result[0].RGBFloatColor;
                                                this.setState({
                                                    strokeColor: {
                                                        red: Math.round(red),
                                                        green: Math.round(grain),
                                                        blue: Math.round(blue)
                                                    }
                                                });
                                            }

                                            // 4. 恢复前景色
                                            if (savedForegroundColor) {
                                                await executeAsModal(async () => {
                                                    await batchPlay(
                                                        [{
                                                            _obj: "set",
                                                            _target: [{
                                                                _ref: "color",
                                                                _property: "foregroundColor"
                                                            }],
                                                            to: {
                                                                _obj: "HSBColorClass",
                                                                hue: savedForegroundColor.hue,
                                                                saturation: savedForegroundColor.saturation,
                                                                brightness: savedForegroundColor.brightness
                                                            },
                                                            source: "photoshopPicker",
                                                            _options: {
                                                                dialogOptions: "dontDisplay"
                                                            }
                                                        }],
                                                        { synchronousExecution: true }
                                                    );
                                                }, { commandName: "恢复前景色" });
                                            }
                                        } catch (error) {
                                            console.error('颜色选择器错误:', error);
                                        }
                                    }}/>
                                <IconButton
                                    onClick={this.toggleStrokeSetting}
                                    title={helpTexts.selectionFill.strokeSettingsButton}
                                >
                                    <SettingsIcon/>
                                </IconButton>
                                </div>
                            )}
                            <sp-switch 
                                checked={this.state.strokeEnabled}
                                onChange={this.toggleStrokeEnabled}
                                title={helpTexts.selectionFill.strokeEnabledSwitch}
                            />
                        </div>

                        {/* 清除模式开关 */}
                        <div className="switch-container">
                            <label className="switch-label" 
title={helpTexts.selectionFill.clearMode}>
                            清除模式
                            </label>
                            <sp-switch 
                                checked={this.state.clearMode}
                                onChange={this.toggleClearMode}
                                disabled={this.state.createNewLayer}
                                title={helpTexts.selectionFill.clearModeSwitch}
                            />
                        </div>

                        {/* 填充模式选择 */}
                        <div className="fill-mode-group">
                            <div className="radio-group-label" title={helpTexts.selectionFill.fillModeLabel}>填充模式</div>
                            <sp-radio-group 
                                selected={this.state.fillMode} 
                                name="fillMode"
                                onChange={this.handleFillModeChange}
                            >
                                <sp-radio value="foreground" className="radio-item" title={helpTexts.selectionFill.fgRadio}>
                                    <span className="radio-item-label" 
title={helpTexts.selectionFill.fgDetail}>
                                    纯色
                                    </span>
                                    <IconButton
                                        onClick={this.toggleColorSettings}
                                        title={helpTexts.selectionFill.fgSettings}
                                    >
                                        <SettingsIcon/>
                                    </IconButton>
                                </sp-radio>
                                <sp-radio value="pattern" className="radio-item" title={helpTexts.selectionFill.patternRadio}>
                                    <span className="radio-item-label" 
title={helpTexts.selectionFill.patternDetail}>
                                    图案
                                    </span>
                                    <IconButton
                                        onClick={this.openPatternPicker}
                                        title={helpTexts.selectionFill.patternSettings}
                                    >
                                        <SettingsIcon/>
                                    </IconButton>
                                </sp-radio>
                                <sp-radio value="gradient" className="radio-item" title={helpTexts.selectionFill.gradientRadio}>
                                    <span className="radio-item-label" 
title={helpTexts.selectionFill.gradientDetail}>
                                    渐变
                                    </span>
                                    <IconButton
                                        onClick={this.openGradientPicker}
                                        title={helpTexts.selectionFill.gradientSettings}
                                    >
                                        <SettingsIcon/>
                                    </IconButton>
                                </sp-radio>
                            </sp-radio-group>
                        </div>
                        {/* 底部checkbox选项外部容器 */}
                        <div className="bottom-checkbox-options">
                                {/* 左列：取消选区 / 更新历史源 */}
                                <div className="checkbox-column-left">
                                    <div className="checkbox-group-left">
                                        <label
                                            htmlFor="deselectCheckbox"
                                            className="checkbox-label"
                                            onClick={this.toggleDeselectAfterFill}
                                            title={helpTexts.selectionFill.deselectLabel}
                                        >
                                            自动删选区:
                                        </label>
                                        <input
                                            type='checkbox'
                                            id="deselectCheckbox"
                                            checked={this.state.deselectAfterFill}
                                            onChange={this.toggleDeselectAfterFill}
                                            className="checkbox-input"
                                            title={helpTexts.selectionFill.deselectInput}
                                        />
                                    </div>
                                    <div className="checkbox-group-left">
                                        <label
                                            htmlFor="historyCheckbox"
                                            className="checkbox-label"
                                            onClick={this.toggleAutoUpdateHistory}
                                            title={helpTexts.selectionFill.historyLabel}
                                        >
                                            更新历史源:
                                        </label>
                                        <input
                                            type='checkbox'
                                            id="historyCheckbox"
                                            checked={this.state.autoUpdateHistory}
                                            onChange={this.toggleAutoUpdateHistory}
                                            className="checkbox-input"
                                            title={helpTexts.selectionFill.historyInput}
                                        />
                                    </div>
                                </div>
                                {/* 右列：开启后切套索 / 切其它工具即关 */}
                                <div className="checkbox-column-right">
                                    <div className="checkbox-group-right">
                                        <label
                                            htmlFor="autoOffOnToolCheckbox"
                                            className="checkbox-label"
                                            onClick={this.toggleAutoOffOnOtherTool}
                                            title={helpTexts.selectionFill.autoOffLabel}
                                        >
                                            自动关开关:
                                        </label>
                                        <input
                                            type='checkbox'
                                            id="autoOffOnToolCheckbox"
                                            checked={this.state.autoOffOnOtherTool}
                                            onChange={this.toggleAutoOffOnOtherTool}
                                            className="checkbox-input"
                                            title={helpTexts.selectionFill.autoOffInput}
                                        />
                                    </div>
                                    <div className="checkbox-group-right">
                                        <label
                                            htmlFor="lassoOnEnableCheckbox"
                                            className="checkbox-label"
                                            onClick={this.toggleSwitchToLassoOnEnable}
                                            title={helpTexts.selectionFill.lassoLabel}
                                        >
                                            自动切套索:
                                        </label>
                                        <input
                                            type='checkbox'
                                            id="lassoOnEnableCheckbox"
                                            checked={this.state.switchToLassoOnEnable}
                                            onChange={this.toggleSwitchToLassoOnEnable}
                                            className="checkbox-input"
                                            title={helpTexts.selectionFill.lassoInput}
                                        />
                                    </div>
                                </div>
                        </div>
                    </div>
                </div>
                


                        
<div className="info-plane">
            <span className="copyright">Copyright © listen2me (JW)</span>
        </div>

            {/* 颜色设置面板 */}
            <ColorSettingsPanel 
                isOpen={this.state?.isColorSettingsOpen ?? false} 
                onClose={this.closeColorSettings} 
                onSave={this.handleColorSettingsSave} 
                initialSettings={this.state?.colorSettings ?? {
                    hueVariation: 0,
                    saturationVariation: 0,
                    brightnessVariation: 0,
                    opacityVariation: 0,
                    grayVariation: 0,
                    calculationMode: 'absolute'
                }}
                isClearMode={this.state.clearMode}
                isQuickMaskMode={false}
            />

            {/* 图案选择器 */}
            <PatternPicker 
                isOpen={this.state?.isPatternPickerOpen ?? false} 
                onClose={this.closePatternPicker} 
                onSelect={this.handlePatternSelect} 
                isClearMode={this.state.clearMode}
            />

            {/* 渐变选择器 */}
            <GradientPicker 
                isOpen={this.state?.isGradientPickerOpen ?? false}    
                onClose={this.closeGradientPicker} 
                onSelect={this.handleGradientSelect} 
                isClearMode={this.state.clearMode}
            />

                {/* 描边设置面板 */}
            <StrokeSetting
              isOpen={this.state.isStrokeSettingOpen ?? false}
              width={this.state.strokeWidth}
              position={this.state.strokePosition}
              blendMode={this.state.strokeBlendMode}
              opacity={this.state.strokeOpacity}
              clearMode={this.state.clearMode}
              onWidthChange={(width) => this.setState({ strokeWidth: width })}
              onPositionChange={(position) => this.setState({ strokePosition: position })}
              onBlendModeChange={(blendMode) => this.setState({ strokeBlendMode: blendMode })}
              onOpacityChange={(opacity) => this.setState({ strokeOpacity: opacity })}
              onClose={this.closeStrokeSetting}
            />
        </div>
        );
    }
}

export default App;
