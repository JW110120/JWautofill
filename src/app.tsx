import React from 'react';
import { interaction } from 'uxp';
import { app, action, core } from 'photoshop';
import { BLEND_MODES } from './constants/blendModes';
import { BLEND_MODE_OPTIONS } from './constants/blendModeOptions';
import { AppState, initialState } from './types/state';
import { DragHandler } from './utils/DragHandler';
import { FillHandler } from './utils/FillHandler';
import { LayerInfoHandler } from './utils/LayerInfoHandler';
import { ClearHandler } from './utils/ClearHandler';
import ColorSettingsPanel from './components/ColorSettingsPanel';
import PatternPicker from './components/PatternPicker';
import GradientPicker from './components/GradientPicker';
import StrokeSetting from './components/StrokeSetting';
import { ExpandIcon, SettingsIcon } from './styles/Icons';
import { calculateRandomColor, hsbToRgb, rgbToGray } from './utils/ColorUtils';
import { strokeSelection } from './utils/StrokeSelection';
import { PatternFill } from './utils/PatternFill';
import { GradientFill } from './utils/GradientFill';
import { SelectionHandler, SelectionOptions } from './utils/SelectionHandler';
import { ColorSettings } from './types/ColorSettings';
import { Pattern } from './types/Pattern';

const { executeAsModal } = core;
const { batchPlay } = action;

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
                await this.fillSelection();
                if (this.state.strokeEnabled) {
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
            if (this.state.clearMode) {
                const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                await ClearHandler.clearWithOpacity(this.state.opacity, this.state, layerInfo);
                return;
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
    
            const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
            if (!layerInfo) return;
    
            const { isBackground, hasTransparencyLocked, hasPixels } = layerInfo;
    
            if (this.state.fillMode === 'pattern') {
                if (this.state.selectedPattern) {
                    await PatternFill.fillPattern({
                        opacity: this.state.opacity,
                        blendMode: this.state.blendMode,
                        pattern: this.state.selectedPattern,
                        preserveTransparency: this.state.selectedPattern.preserveTransparency
                    }, layerInfo, this.state);
                } else {
                    // 缺少图案预设，显示警告并跳过填充
                    await core.showAlert({ message: '请先选择一个图案预设' });
                    return;
                }
            } else if (this.state.fillMode === 'gradient') {
                if (this.state.selectedGradient) {
                    await GradientFill.fillGradient({
                        opacity: this.state.opacity,
                        blendMode: this.state.blendMode,
                        gradient: this.state.selectedGradient,
                        preserveTransparency: this.state.selectedGradient.preserveTransparency
                    }, layerInfo, this.state);
                } else {
                    // 缺少渐变预设，显示警告并跳过填充
                    await core.showAlert({ message: '请先选择一个渐变预设' });
                    return; 
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
            }
        } catch (error) {
            console.error('填充选区失败:', error);
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

    render() {
        return (
            <div>
                <div className="container">
<h3 
className="title" 
title={`生成选区时，插件会自动根据用户选择的模式填充/删除内容，
选区模式只有作为【新选区】时，才会触发自动填充，
加选，减选，交叉选择不会自动填充。`
}>
                    <span className="title-text">选区笔1.2</span>
                    <span className="title-beta">beta</span>
                </h3>
                <div className="button-container">
<sp-action-button 
className="main-button" 
onClick={this.handleButtonClick}
title={`开启后，当PS工具栏羽化参数为0时，自动填充才能正常使用。
推荐由下方的插件面板设置想要的羽化值。
处于套索等工具时，依次按下【Enter → 数字1 → Enter】，
可以把工具栏的羽化值设为1，从而恢复正常的选区功能。`
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
                    <span className={`blend-mode-label ${this.state.clearMode ? 'disabled' : ''}`}>混合模式：</span>
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
title={`调整填充内容的不透明度，支持清除模式。可通过拖拽标签快速调整数值。
对于新建图层模式，影响的是新图层的不透明度，图层内部填充的内容的不透明度维持该模式本身的值。`}
>
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
                        title="改造选区使用的羽化值，可通过拖拽标签快速调整数值。"
                    >
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
                                        title="平滑选区边缘，减少锯齿效果，可通过拖拽标签快速调整数值。"
                                    >
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
                                        title="增强选区边缘的锐度，可通过拖拽标签快速调整数值。"
                                    >
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
                                        title="以喷溅方式扩展选区范围，可通过拖拽标签快速调整数值。"
                                    >
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
                            <span className="switch-label" title="开启后在新图层上进行填充，保持原图层不变。">新建图层</span>
                            <sp-switch 
                                checked={this.state.createNewLayer}
                                onChange={this.toggleCreateNewLayer}
                                disabled={this.state.clearMode || this.state.isInQuickMask}
                                title="开启后在新图层上进行填充，保持原图层不变。"
                            />
                        </div>

                       {/* 描边模式开关 */}
                       <div className="switch-container">
                            <label className="switch-label" title="开启描边模式，为选区添加边框描边效果。">描边模式</label>
                            {this.state.strokeEnabled && (
                                <div className="stroke-color-group">
                                <div 
                                    className="stroke-color-preview"
                                    style={this.getStrokeColorPreviewStyle()}
                                    title="点击选择描边颜色。"
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
                                title="开启描边模式，为选区添加边框描边效果。"
                            />
                        </div>

                        {/* 清除模式开关 */}
                        <div className="switch-container">
                            <label className="switch-label" title="开启清除模式，以下方选择的模式删除选区内容。">清除模式</label>
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
                                <sp-radio value="foreground" className="radio-item" title="使用纯色填充选区。">
                                    <span className="radio-item-label">纯色</span>
                                    <sp-action-button 
                                        quiet 
                                        className="settings-icon"
                                        onClick={this.toggleColorSettings}
                                        title="打开颜色设置面板，调整颜色变化参数。"
                                    >
                                        <SettingsIcon/>
                                    </sp-action-button>
                                </sp-radio>
                                <sp-radio value="pattern" className="radio-item" title="使用图案填充选区。">
                                    <span className="radio-item-label">图案</span>
                                    <sp-action-button 
                                        quiet 
                                        className="settings-icon"
                                        onClick={this.openPatternPicker}
                                        title="打开图案选择器，选择填充图案。"
                                    >
                                        <SettingsIcon/>
                                    </sp-action-button>
                                </sp-radio>
                                <sp-radio value="gradient" className="radio-item" title="使用渐变填充选区。">
                                    <span className="radio-item-label">渐变</span>
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
                                    title="填充完成后自动取消选区。"
                                >
                                    取消选区:
                                </label>
                                <input
                                    type='checkbox'
                                    id="deselectCheckbox"
                                    checked={this.state.deselectAfterFill}
                                    onChange={this.toggleDeselectAfterFill}
                                    className="checkbox-input"
                                    title="填充完成后自动取消选区。"
                                />
                                
                            </div>
                            <div className="checkbox-container">
                                <label 
                                    htmlFor="historyCheckbox" 
                                    className="checkbox-label"
                                    onClick={this.toggleAutoUpdateHistory} // 添加 onClick 事件处理程序
                                    title="自动更新历史记录画笔的源图像。"
                                >
                                    更新历史源:
                                </label>
                                <input
                                    type='checkbox'
                                    id="historyCheckbox"
                                    checked={this.state.autoUpdateHistory}
                                    onChange={this.toggleAutoUpdateHistory}
                                    className="checkbox-input"
                                    title="自动更新历史记录画笔的源图像。"
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