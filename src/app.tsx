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
import LicenseDialog from './components/LicenseDialog';
import { LicenseManager } from './utils/LicenseManager';
import { ExpandIcon, SettingsIcon } from './styles/Icons';
import { calculateRandomColor, hsbToRgb, rgbToGray } from './utils/ColorUtils';
import { strokeSelection } from './utils/StrokeSelection';
import { PatternFill } from './utils/PatternFill';
import { GradientFill } from './utils/GradientFill';
import { SingleChannelHandler } from './utils/SingleChannelHandler';
import { SelectionHandler, SelectionOptions } from './utils/SelectionHandler';
import { ColorSettings, Pattern } from './types/state';

const { executeAsModal } = core;
const { batchPlay } = action;

interface AppProps {}

class App extends React.Component<AppProps, AppState> {
    private isListenerPaused = false;
    private isInLayerMask = false;
    private isInQuickMask = false;
    private isInSingleColorChannel = false;
    private selectionChangeListener: any = null;

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
    }

    componentWillUnmount() {
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
        this.setState(prevState => ({
            isEnabled: !prevState.isEnabled
        }));
    }


    // 新增方法
    toggleSelectionOptions() {
        this.setState(prevState => ({
            isSelectionOptionsExpanded: !prevState.isSelectionOptionsExpanded
        }));
    }

    handleSelectionSmoothChange(event) {
        this.setState({ selectionSmooth: parseInt(event.target.value, 10) });
    }

    handleSelectionContrastChange(event) {
        this.setState({ selectionContrast: parseInt(event.target.value, 10) });
    }

    handleSelectionExpandChange(event) {
        this.setState({ selectionExpand: parseInt(event.target.value, 10) });
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
        if (!this.state.isEnabled || this.isListenerPaused) return;
        // 检查事件中是否包含feather项，如果包含则直接返回
        if (event && event.feather) {
            return;
        }    

        try {
            const doc = app.activeDocument;
            if (!doc) {
                return;
            }

            // 检测快速蒙版状态
            const isInQuickMask = doc.quickMaskMode;
            if (this.state.isInQuickMask !== isInQuickMask) {
                this.setState({ isInQuickMask });
            }
   
            await new Promise(resolve => setTimeout(resolve, 50));
            const selection = await this.getSelection();
            if (!selection) {
                console.warn('⚠️ 选区为空，跳过填充');
                return;
            }

            // 暂停监听
            this.isListenerPaused = true;

            await core.executeAsModal(async () => {
                if (this.state.autoUpdateHistory) { await this.setHistoryBrushSource(); }
                // 只有当选区选项值不为初始值时才执行选择并遮住
                const options: SelectionOptions = {
                    selectionSmooth: this.state.selectionSmooth,
                    selectionContrast: this.state.selectionContrast,
                    selectionExpand: this.state.selectionExpand
                };
                
                if (SelectionHandler.shouldApplySelectionModification(options)) {
                    await this.applySelectionModification();
                }
                await this.applyFeather();
                const fillSuccess = await this.fillSelection();
                if (this.state.strokeEnabled && fillSuccess) {
                    // 获取图层信息
                    const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                    await strokeSelection(this.state, layerInfo);
                }
                if (this.state.deselectAfterFill) {
                    await this.deselectSelection();
                }
            }, { commandName: '正在处理选区中......' });

            // 恢复监听
            this.isListenerPaused = false;
        } catch (error) {
            console.error('❌ 处理失败:', error);
            // 确保在错误情况下也恢复监听
            this.isListenerPaused = false;
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

    async applyFeather() {
        const featherAmount = Number(this.state.feather);
        if (featherAmount < 0) return;
        
        // 当羽化值为0时，跳过羽化操作
        if (featherAmount === 0) {
            // 直接更新选区状态，不执行羽化
            const newSelection = await this.getSelection();
            this.setState({ SelectionA: newSelection });
            return;
        }
        
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
        
        await new Promise(resolve => setTimeout(resolve, 50));
        const newSelection = await this.getSelection();
        this.setState({ SelectionA: newSelection });
    }

     // 修改新建图层模式切换函数
     toggleCreateNewLayer() {
        this.setState(prevState => ({
            createNewLayer: !prevState.createNewLayer,
            clearMode: prevState.createNewLayer ? prevState.clearMode : false 
        }));
    }

    async fillSelection() {
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            // 授权门控：未授权且非试用，打开授权窗口并阻止功能
            if (!this.state.isLicensed && !this.state.isTrial) {
                this.setState({ isLicenseDialogOpen: true });
                return false;
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

            const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
            if (!layerInfo) return false;

            if (this.state.clearMode) {
                const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                await ClearHandler.clearWithOpacity(this.state.opacity, this.state, layerInfo);
                return true;
            }
    
            if (this.state.createNewLayer) {
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
                    }, layerInfo, this.state);
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
                else {
                    await FillHandler.fillBackground(fillOptions);
                }
                return true;
            }
        } catch (error) {
            console.error('填充选区失败:', error);
            return false;
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

    handleOpacityChange(event) {
        this.setState({ opacity: parseInt(event.target.value, 10) });
    }

    handleFeatherChange(event) {
        this.setState({ feather: parseInt(event.target.value, 10) });
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
    async handleNotification() {
        try {
            // 检测图层蒙版和快速蒙版状态
            await this.checkMaskModes();
            // 强制重新渲染以更新颜色预览
            this.forceUpdate();
        } catch (error) {
            // 静默处理错误，避免频繁的错误日志
        }
    }

    // 获取描边颜色预览样式
    getStrokeColorPreviewStyle() {
        const { strokeColor, clearMode } = this.state;
        const shouldShowGray = clearMode || this.isInLayerMask || this.isInQuickMask || this.isInSingleColorChannel;
        
        if (!strokeColor) {
            return { backgroundColor: '#000000' };
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
            // 先查看本地缓存
            const status = await LicenseManager.checkLicenseStatus();
            let isLicensed = status.isValid;
            let isTrial = false;
            let trialDaysRemaining = 0;

            // 如果不是正式许可证，检查是否处于试用并是否过期
            if (!isLicensed) {
                const expired = await LicenseManager.isTrialExpired();
                // 读取缓存看看是否是试用
                const cachedInfo: any = (status && status.info) || await (LicenseManager as any).getCachedLicense?.();
                const isTrialKey = cachedInfo && cachedInfo.key && String(cachedInfo.key).startsWith('TRIAL_');
                isTrial = !!isTrialKey && !expired;

                if (isTrialKey && cachedInfo && cachedInfo.expiryDate) {
                    const expire = new Date(cachedInfo.expiryDate).getTime();
                    const diffDays = Math.max(0, Math.ceil((expire - Date.now()) / (24 * 60 * 60 * 1000)));
                    trialDaysRemaining = diffDays;
                }
            }

            // 自动重新验证（宽松：失败不阻止）
            if (status.needsReverification) {
                try { await LicenseManager.autoReverifyIfNeeded(); } catch {}
            }

            // 控制对话框打开逻辑：首次启动若未授权则打开
            this.setState({
                isLicensed,
                isTrial,
                trialDaysRemaining,
                isLicenseDialogOpen: !(isLicensed || isTrial)
            });
        } catch (e) {
            console.warn('检查许可证状态失败:', e);
            this.setState({ isLicensed: false, isTrial: false, isLicenseDialogOpen: true });
        }
    }

    handleLicenseVerified() {
        this.setState({ isLicensed: true, isTrial: false, isLicenseDialogOpen: false });
        // 对话框关闭，移除类名恢复输入框
        document.body.classList.remove('license-dialog-open');
    }

    handleTrialStarted() {
        // 试用7天
        this.setState({ isLicensed: false, isTrial: true, isLicenseDialogOpen: false, trialDaysRemaining: 7 });
        // 对话框关闭，移除类名恢复输入框
        document.body.classList.remove('license-dialog-open');
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
                <div className="container">
                <h3 className="title" 
title={`● 生成选区时，插件会自动根据选择的模式填充/删除内容。

● 选区模式只有作为【新选区】时，才会触发自动填充，加选，减选，交叉选择不会自动填充。

● 由于核心功能使用了imageAPI，所有和渐变与图案相关的功能需要至少PS版本24.2（PS2023第二个版本）才能使用。

● 由于每次生成选区后，插件会立刻执行若干个步骤。因此想要撤销本次的自动填充，建议回溯历史记录。`
}>
                    <span className="title-text">选区笔1.2</span>
                    {/* 临时调试：重置许可证按钮 */}
                    <button
                        onClick={() => this.resetLicenseForTesting()}
                        title="重置许可证状态（仅调试用）"
                        style={{
                            position: 'absolute',
                            right: 32,
                            top: 2,
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-color)',
                            color: 'red',
                            cursor: 'pointer',
                            lineHeight: '18px',
                            fontSize: '10px',
                            padding: 0,
                            zIndex: 10
                        }}
                    >
                        R
                    </button>
                    {/* 新增：帮助按钮（右上角问号），用于重新打开授权窗口 */}
                    <button
                        onClick={this.openLicenseDialog}
                        title="打开许可证与试用面板"
                        style={{
                            position: 'absolute',
                            right: 8,
                            top: 2,
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-color)',
                            color: 'var(--text-color)',
                            cursor: 'pointer',
                            lineHeight: '18px',
                            fontSize: '12px',
                            padding: 0,
                            zIndex: 10
                        }}
                    >
                        ?
                    </button>
                </h3>
                <div className="button-container">
                    <sp-action-button 
                    className="main-button" 
                    onClick={this.handleButtonClick}
title={`● 功能开启后，PS工具栏羽化参数设为0时，自动填充才可正常使用。

● 推荐由下方的插件面板设置想要的羽化值。

● 处于套索等工具时，依次按下【Enter → 数字1 → Enter】，可以把工具栏的羽化值设为1，暂停自动填充。

● 依次按下【Enter → 数字0 → Enter】，可以把羽化值改回0，恢复自动填充。`
}>
                        <div className="button-content">
                            <span className={`button-text ${!this.state.isEnabled ? 'disabled' : ''}`}>
                                {this.state.isEnabled ? '功能开启' : '功能关闭'}
                            </span>
                            <div className={`button-indicator ${this.state.isEnabled ? 'enabled' : 'disabled'}`}></div>
                        </div>
                    </sp-action-button>
                </div>

                <div className="blend-mode-container">
                    <span className={`blend-mode-label ${this.state.clearMode ? 'disabled' : ''}`} 
title={`● 混合模式支持纯色，图案和渐变三种模式。描边的混合模式需要在描边的面板中独立设置。
  
● 在新建图层模式下：该混合模式下拉菜单修改的是新建图层的混合模式。至于本次在新图层中填充的内容，采取的混合模式是【正常】。
    
● 在清除模式下：开启后默认设为【清除】，混合模式不支持修改。`
}>
                    混合模式：
                    </span>

                    <sp-picker
                        size="s"
                        selects="single"
                        selected={this.state.blendMode || "正常"}
                        onChange={this.handleBlendModeChange}
                        disabled={this.state.clearMode}
                        title="选择填充时使用的混合模式，计算方式与PS原生一致。"
                    >
                        <sp-menu>
                            {BLEND_MODE_OPTIONS.map((group, groupIndex) => (
                                <React.Fragment key={groupIndex}>
                                    {group.map((option) => (
                                        <sp-menu-item 
                                            key={option.value} 
                                            value={option.value}
                                            selected={option.value === (this.state.blendMode || "正常")}
                                        >
                                            {option.label}
                                        </sp-menu-item>
                                    ))}
                                    {groupIndex < BLEND_MODE_OPTIONS.length - 1 && (
                                        <sp-menu-divider />
                                    )}
                                </React.Fragment>
                            ))}
                        </sp-menu>
                    </sp-picker>
                </div> 

                <div className="slider-container">
                    <label
                        className={`slider-label ${
                            this.state.isDragging && this.state.dragTarget === 'opacity' 
                            ? 'dragging' 
                            : 'not-dragging'
                        }`}
                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'opacity')}
title={`● 调整填充内容的不透明度，不透明度间采用【乘算】。
    
● 在填充模式下：假设原本填充的图案中有一个自带50%的不透明度的区域，插件面板中不透明度设为50%，则最终填充该区域的不透明度为50%*50%*（受羽化影响产生的不透明度）。

● 在清除模式下：不透明度计算方式与填充模式相同。

● 在新建图层模式下：影响的是新图层的不透明度，假设填充的图案或者渐变原先带有不透明度，填充的内容仍保持原来的不透明度。`
}>
                    不透明度
                    
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                    <input
                        type="number"
                        min="0"
                        max="100"
                        value={this.state.opacity}
                        onChange={(e) => this.setState({ opacity: Number(e.target.value) })}
                        style={{ width: '30px', zIndex: 1 }}
                        title="输入填充内容的不透明度（0-100）。"
                    />
                    <span style={{ fontSize: '13px' }}>%</span>
                    </div>

                    </label>
                    <input
                        type='range'
                        min='0'
                        max='100'
                        step='1'
                        value={this.state.opacity}
                        onChange={this.handleOpacityChange}
                        className="slider-input"
                        title="调整填充的不透明度，0%为完全透明，100%为完全不透明。"
                    />
                    
                    <label
                        className={`slider-label ${
                            this.state.isDragging && this.state.dragTarget === 'feather' 
                            ? 'dragging' 
                            : 'not-dragging'
                        }`}
                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'feather')}
title={`● 改造选区使用的羽化值，也就是对选区的灰度通道使用了高斯模糊。

● 羽化值越大，选区边缘越柔和，填充内容的不透明度也会相应降低。

● 羽化值也会直接影响描边的羽化程度与不透明度。`
}>
                        羽化

                    <div style={{ display: 'flex', alignItems: 'center' }}>
                    <input
                        type="number"
                        min="0"
                        max="20"
                        value={this.state.feather}
                        onChange={(e) => this.setState({ feather: Number(e.target.value) })}
                        style={{ width: '30px', zIndex: 1 }}
                        title="输入改造选区使用的羽化值（0-20像素）。"
                        />
                    <span style={{ fontSize: '13px' }}>px</span>
                    </div>

                    </label>
                    <input
                        type='range'
                        min='0'
                        max='20'
                        step='0.5'
                        value={this.state.feather}
                        onChange={this.handleFeatherChange}
                        className="slider-input"
                        title="调整选区边缘的羽化程度，数值越大边缘越柔和。"
                    />
                </div>
            </div>

 {/* 新增选区选项区域 */}
            <div className="expand-section">
                            <div className="expand-header" onClick={this.toggleSelectionOptions} title="点击展开/折叠选区选项设置。">

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
title={`● 在填充前，以降低选区灰度通道中的高频信息的方式修改选区。
    
● 具体实现是直接挪用【选择并遮住】中的平滑选区边缘功能，减小选区边缘的锯齿与起伏。
    
● 当该值设为0时，不会修改选区，可以显著提高连续自动填充的流畅度。`
}>
                                        平滑
                                    </label>
                                    <input
                                        type='range'
                                        min='0'
                                        max='100'
                                        step='1'
                                        value={this.state.selectionSmooth}
                                        onChange={this.handleSelectionSmoothChange}
                                        className="selection-slider-input"
                                        title="平滑选区边缘，减少凹凸起伏，数值越大平滑效果越明显。"
                                    />
                                    <div style={{ display: 'flex', alignItems: 'center'}}>
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={this.state.selectionSmooth}
                                            onChange={(e) => this.setState({ selectionSmooth: Number(e.target.value) })}
                                            style={{ marginLeft: '-10px', width: '30px', zIndex: 1 }}
                                            title="直接输入平滑数值（0-100%）。"
                                        />
                                        <span style={{ fontSize: '13px' }}>%</span>
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
title={`● 在填充前，以锐化选区灰度通道方式修改选区。

● 具体实现是直接挪用【选择并遮住】中的锐化选区边缘功能，增强选区边缘的锐度。

● 当该值设为0时，不会修改选区，可以显著提高连续自动填充的流畅度。`
}>
                                        锐度

                                    </label>
                                    <input
                                        type='range'
                                        min='0'
                                        max='100'
                                        step='1'
                                        value={this.state.selectionContrast}
                                        onChange={this.handleSelectionContrastChange}
                                        className="selection-slider-input"
                                        title="增强选区边缘的锐度，使边缘更加清晰明确。"
                                    />
                                    <div style={{ display: 'flex', alignItems: 'center'}}>
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={this.state.selectionContrast}
                                            onChange={(e) => this.setState({ selectionContrast: Number(e.target.value) })}
                                            style={{ marginLeft: '-10px', width: '30px', zIndex: 1 }}
                                            title="直接输入锐度数值（0-100%）。"
                                        />
                                        <span style={{ fontSize: '13px' }}>%</span>
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
title={`● 参考PS滤镜库中数次叠加喷溅的算法，以喷溅的方式扩展选区范围。

● 未来打算扩展更多的参数，以对选区进行更丰富的改造。`
}>
                                        扩散
                                    </label>
                                    <input
                                        type='range'
                                        min='0'
                                        max='100'
                                        step='1'
                                        value={this.state.selectionExpand}
                                        onChange={this.handleSelectionExpandChange}
                                        className="selection-slider-input"
                                        title="以喷溅的方式改造选区，数值越大选区向外喷溅的强度越高。"
                                    />
                                    <div style={{ display: 'flex', alignItems: 'center'}}>
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={this.state.selectionExpand}
                                            onChange={(e) => this.setState({ selectionExpand: Number(e.target.value) })}
                                            style={{ marginLeft: '-10px', width: '30px', zIndex: 1 }}
                                            title="直接输入扩散数值（0-100%）。"
                                        />
                                       <span style={{ fontSize: '13px' }}>%</span>
                                    </div>
                                    </div>
                                </div>
                            </div>
                        </div>


            <div className="expand-section">
                    <div className="expand-header" onClick={this.toggleExpand} title="点击展开/折叠填充选项设置。">
                        <div className={`expand-icon ${this.state.isExpanded ? 'expanded' : ''}`}>
                            <ExpandIcon expanded={this.state.isExpanded} />
                        </div>
                        <span>填充选项</span>
                    </div>
                    <div className={`expand-content ${this.state.isExpanded ? 'expanded' : ''}`}>


                        {/* 新建图层开关 */}
                        <div className="switch-container">
                            <span className="switch-label" 
title={`● 每次填充前都会以设置的参数新建一个图层，在该新图层上填充内容。

● 新建图层模式与清除模式互斥，不能同时开启。`
}>
                            新建图层
                            </span>
                            <sp-switch 
                                checked={this.state.createNewLayer}
                                onChange={this.toggleCreateNewLayer}
                                disabled={this.state.clearMode || this.state.isInQuickMask}
                                title="开启后在新图层上进行填充，保持下方图层不受影响。"
                            />
                        </div>

                       {/* 描边模式开关 */}
                       <div className="switch-container">
                            <label className="switch-label" title="在填充后自动为选区边缘增加描边效果。开启右侧开关后，将会显示设置描边颜色和设置具体描边的参数的区域。">描边模式</label>
                            {this.state.strokeEnabled && (
                                <div className="stroke-color-group">
                                <div 
                                    className="stroke-color-preview"
                                    style={this.getStrokeColorPreviewStyle()}
                                    title="点击选择描边颜色，在编辑蒙版等灰度通道时，这里将会显示选中颜色的灰度。"
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
                                <sp-action-button 
                                    quiet 
                                    className="stroke-settings-icon"
                                    onClick={this.toggleStrokeSetting}
                                    title="打开描边设置面板，调整描边宽度、位置等参数。"
                                >
                                    <SettingsIcon/>
                                </sp-action-button>
                                </div>
                            )}
                            <sp-switch 
                                checked={this.state.strokeEnabled}
                                onChange={this.toggleStrokeEnabled}
                                title="开启描边模式，在填充后自动为选区边缘增加描边效果。"
                            />
                        </div>

                        {/* 清除模式开关 */}
                        <div className="switch-container">
                            <label className="switch-label" 
title={`● 开启清除模式，以下方选择的模式删除选区内容。

● 关闭清除模式的情况下称作填充模式，填充模式与清除模式支持修改像素图层、红、绿、蓝通道、快速蒙版，图层蒙版、用户保存的选区的自定义alpha通道。

● 清除模式的计算方法采取绝对计算，对纯色、图案与渐变在保留不透明度的基础上采用统一的逻辑：先转化为灰度，白色代表100%删除，黑色代表完全不删除。
（因此删除纯色，需要先把前景色设为白色）

● 未来考虑增加相对计算模式，即考虑一个删除系数，当被删除对象的颜色的灰度越高（或不透明度越高），它被删除的百分比越高。

● 清除模式与新建图层模式互斥，不能同时开启。`
}>
                            清除模式
                            </label>
                            <sp-switch 
                                checked={this.state.clearMode}
                                onChange={this.toggleClearMode}
                                disabled={this.state.createNewLayer}
                                title="开启清除模式，以下方选择的模式删除选区内容。"
                            />
                        </div>

                        {/* 填充模式选择 */}
                        <div className="fill-mode-group">
                            <div className="radio-group-label" title="选择填充类型：纯色、图案或渐变。">填充模式</div>
                            <sp-radio-group 
                                selected={this.state.fillMode} 
                                name="fillMode"
                                onChange={this.handleFillModeChange}
                            >
                                <sp-radio value="foreground" className="radio-item" title="使用【纯色】改写选区中的内容。">
                                    <span className="radio-item-label" 
title={`● 基础的纯色填充模式，当监测到生成选区后，立刻填充前景色。

● 右侧的纯色参数面板，通过算法使得每次自动填充会以当前前景色作为原点，在参数设定的颜色区间内随机选择颜色填充。

● 编辑RGB通道时，会提供4个可编辑选项。在编辑蒙版等灰度通道时，只提供2个可编辑选项。`
}>
                                    纯色
                                    </span>
                                    <sp-action-button 
                                        quiet 
                                        className="settings-icon"
                                        onClick={this.toggleColorSettings}
                                        title="打开纯色设置面板，调整纯色变化参数。"
                                    >
                                        <SettingsIcon/>
                                    </sp-action-button>
                                </sp-radio>
                                <sp-radio value="pattern" className="radio-item" title="使用【图案】改写选区中的内容。">
                                    <span className="radio-item-label" 
title={`● 图案填充模式，需要用户用系统中加载jpg、png等图片文件，作为图案的预设。
    
● 由于图案接口未开放，当前版本不支持PS内部的图案。
    
● 支持Shift，Ctrl等修改键多选管理预设。

● 提供两种不同的填充方案，支持旋转与缩放；支持PNG的不透明度通道。

● 当前PS没有开放预览旋转图案的接口，当开放后会跟进。`
}>
                                    图案
                                    </span>
                                    <sp-action-button 
                                        quiet 
                                        className="settings-icon"
                                        onClick={this.openPatternPicker}
                                        title="打开图案面板，管理图案预设，设置相关的参数。"
                                    >
                                        <SettingsIcon/>
                                    </sp-action-button>
                                </sp-radio>
                                <sp-radio value="gradient" className="radio-item" title="使用【渐变】改写选区中的内容。">
                                    <span className="radio-item-label" 
title={`● 渐变填充模式，需要用户自行设置渐变的起始颜色、结束颜色、角度等参数，以制作渐变的预设。

● 已经存在的渐变预设，可以点击选中后，修改面板中的参数以修改预设。   

● 可以点击渐变条增加滑块，不透明度与颜色滑块一一对应，由于需要统一逻辑，插件中不透明度滑块白色代表100%不透明，黑色代表完全透明。
    
● 点击渐变预设区的空白可以取消选择。支持Shift，Ctrl等修改键多选管理预设。

● 由于渐变接口未开放，当前版本不支持PS内部的渐变预设；由于浏览器的问题，渐变的种类暂时只支持线性与径向两种，未来可能会补充其他类型的渐变。`
}>
                                    渐变
                                    </span>
                                    <sp-action-button 
                                        quiet 
                                        className="settings-icon"
                                        onClick={this.openGradientPicker}
                                        title="打开渐变选择器，设置渐变预设与角度等参数。"
                                    >
                                        <SettingsIcon/>
                                    </sp-action-button>
                                </sp-radio>
                            </sp-radio-group>
                        </div>

                        {/* 底部选项 */}
                        <div className="bottom-options">
                            <div className="checkbox-container">
                                 <label 
                                    htmlFor="deselectCheckbox" 
                                    className="checkbox-label"
                                    onClick={this.toggleDeselectAfterFill} // 添加 onClick 事件处理程序
                                      title="填充完成后自动取消选区。
取消勾选后会保留已经修改后的选区，而不是最初生成的选区。"
                                >
                                    取消选区:
                                </label>
                                <input
                                    type='checkbox'
                                    id="deselectCheckbox"
                                    checked={this.state.deselectAfterFill}
                                    onChange={this.toggleDeselectAfterFill}
                                    className="checkbox-input"
                                    title="切换自动取消选区的状态。"
                                />
                                
                            </div>
                            <div className="checkbox-container">
                                <label 
                                    htmlFor="historyCheckbox" 
                                    className="checkbox-label"
                                    onClick={this.toggleAutoUpdateHistory} // 添加 onClick 事件处理程序
                                    title="自动把历史记录画笔的源图像设置为每次生成选区的那一刻，
从而可以结合历史记录画笔增强或者削弱本次填充的效果。"
                                >
                                    更新历史源:
                                </label>
                                <input
                                    type='checkbox'
                                    id="historyCheckbox"
                                    checked={this.state.autoUpdateHistory}
                                    onChange={this.toggleAutoUpdateHistory}
                                    className="checkbox-input"
                                    title="切换自动更新历史记录画笔的源图像的状态。"

                                />
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