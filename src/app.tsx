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
import { calculateRandomColor } from './utils/ColorUtils';
import { strokeSelection } from './utils/StrokeSelection';
import { PatternFill } from './utils/PatternFill';

const { executeAsModal } = core;
const { batchPlay } = action;

class App extends React.Component<AppProps, AppState> {
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
 
    }

    async componentDidMount() {
        await action.addNotificationListener(['set'], this.handleSelectionChange);
        document.addEventListener('mousemove', this.handleMouseMove);
        document.addEventListener('mouseup', this.handleMouseUp);
    }

    componentWillUnmount() {
        action.removeNotificationListener(['set'], this.handleSelectionChange);
        document.removeEventListener('mousemove', this.handleMouseMove);
        document.removeEventListener('mouseup', this.handleMouseUp);
    }

    handleButtonClick() {
        this.setState(prevState => ({
            isEnabled: !prevState.isEnabled
        }));
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
                pressureVariation: Math.min(100, Math.max(0, settings.pressureVariation))
            };

            this.setState({
                colorSettings: validatedSettings,
                isColorSettingsOpen: false
            });
        } catch (error) {
            console.error('保存颜色设置失败:', error);
            // 可以添加错误提示UI
        }
    }

    handlePatternSelect(pattern: Pattern) {
        this.setState({
            selectedPattern: pattern,
            isPatternPickerOpen: false
        });
    }

    handleGradientSelect(gradient: Gradient) {
        this.setState({
            selectedGradient: gradient,
            isGradientPickerOpen: false
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

    async handleSelectionChange() {
        if (!this.state.isEnabled) return;

        try {
            const doc = app.activeDocument;
            if (!doc) {
                return;
            }
   
            await new Promise(resolve => setTimeout(resolve, 50));
            const selection = await this.getSelection();
            if (!selection) {
                console.warn('⚠️ 选区为空，跳过填充');
                return;
            }

            await core.executeAsModal(async () => {
                if (this.state.autoUpdateHistory) { await this.setHistoryBrushSource(); }
                await this.applyFeather();
                await this.fillSelection();
                if (this.state.strokeEnabled) {
                    await strokeSelection(this.state);
                }
                if (this.state.deselectAfterFill) {
                    await this.deselectSelection();
                }
            }, { commandName: '更新历史源&羽化选区&处理选区' });
        } catch (error) {console.error('❌ 处理失败:', error);}
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
            clearMode: prevState.createNewLayer ? prevState.clearMode : false // 如果开启新建图层模式，关闭清除模式
        }));
    }

    async fillSelection() {
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            if (this.state.clearMode) {
                await ClearHandler.clearWithOpacity(this.state.opacity);
                return;
            }

            if (this.state.createNewLayer) {
                await action.batchPlay(
                    [{
                        _obj: "make",
                        _target: [{ _ref: "layer" }],
                        _options: { dialogOptions: "dontDisplay" }
                    }],
                    { synchronousExecution: true }
                );
            }

            const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
            if (!layerInfo) return;

            const { isBackground, hasTransparencyLocked, hasPixels } = layerInfo;

            if (this.state.fillMode === 'pattern' && this.state.selectedPattern) {
                await PatternFill.fillPattern({
                    opacity: this.state.opacity,
                    blendMode: this.state.blendMode,
                    pattern: this.state.selectedPattern
                }, layerInfo);
            } else {
                const randomColor = calculateRandomColor(this.state.colorSettings, this.state.opacity);
                const fillOptions = {
                    opacity: randomColor.opacity,
                    blendMode: this.state.blendMode,
                    color: randomColor
                };

                // 更新填充命令以使用随机颜色
                const command = {
                    ...FillHandler.createBasicFillCommand(fillOptions),
                    using: { _enum: 'fillContents', _value: 'color' }, 
                    color: fillOptions.color,
                    _isCommand: true
                };

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

    render() {
        return (
            <div>
                <div className="container">
                <h3 className="title">
                    <span className="title-text">选区笔1.2</span>
                    <span className="title-beta">beta</span>
                </h3>
                <div className="button-container">
                    <sp-action-button className="main-button" onClick={this.handleButtonClick}>
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
                    >
                        不透明度
                        <span className="slider-value">{this.state.opacity}%</span>
                    </label>
                    <input
                        type='range'
                        min='0'
                        max='100'
                        step='1'
                        value={this.state.opacity}
                        onChange={this.handleOpacityChange}
                        className="slider-input"
                    />
                    <label
                        className={`slider-label ${
                            this.state.isDragging && this.state.dragTarget === 'feather' 
                            ? 'dragging' 
                            : 'not-dragging'
                        }`}
                        onMouseDown={(e) => this.handleLabelMouseDown(e, 'feather')}
                    >
                        羽化
                        <span className="slider-value">{this.state.feather}px</span>
                    </label>
                    <input
                        type='range'
                        min='0'
                        max='10'
                        step='0.5'
                        value={this.state.feather}
                        onChange={this.handleFeatherChange}
                        className="slider-input"
                    />
                </div>
            </div>
            <div className="expand-section">
                    <div className="expand-header" onClick={this.toggleExpand}>
                        <div className={`expand-icon ${this.state.isExpanded ? 'expanded' : ''}`}>
                            <ExpandIcon expanded={this.state.isExpanded} />
                        </div>
                        <span>更多选项</span>
                    </div>
                    <div className={`expand-content ${this.state.isExpanded ? 'expanded' : ''}`}>
                       {/* 描边模式开关 */}
                       <div className="switch-container">
                            <label className="switch-label">描边模式</label>
                            {this.state.strokeEnabled && (
                                <div className="stroke-color-group">
                                <div 
                                    className="stroke-color-preview"
                                    style={{
                                        backgroundColor: this.state.strokeColor 
                                            ? `rgb(${this.state.strokeColor.red}, ${this.state.strokeColor.green}, ${this.state.strokeColor.blue})`
                                            : '#000000'
                                    }}
                                    onClick={async () => {
                                        try {
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
                                        } catch (error) {
                                            console.error('Error showing color picker:', error);
                                        }
                                    }}/>
                                <sp-action-button 
                                    quiet 
                                    className="stroke-settings-icon"
                                    onClick={this.toggleStrokeSetting}
                                >
                                    <SettingsIcon/>
                                </sp-action-button>
                                </div>
                            )}
                            <sp-switch 
                                checked={this.state.strokeEnabled}
                                onChange={this.toggleStrokeEnabled}
                                disabled={this.state.clearMode || this.state.createNewLayer}
                            />
                        </div>
                        <div className="switch-container">
                            <span className="switch-label">新建图层</span>
                            <sp-switch 
                                checked={this.state.createNewLayer}
                                onChange={this.toggleCreateNewLayer}
                                disabled={this.state.clearMode || this.state.strokeEnabled}
                            />
                        </div>

                        {/* 清除模式开关 */}
                        <div className="switch-container">
                            <label className="switch-label">清除模式</label>
                            <sp-switch 
                                checked={this.state.clearMode}
                                onChange={this.toggleClearMode}
                                disabled={this.state.strokeEnabled || this.state.createNewLayer}
                            />
                        </div>

                        {/* 填充模式选择 */}
                        <div className="fill-mode-group">
                            <div className="radio-group-label">填充模式</div>
                            <sp-radio-group 
                                selected={this.state.fillMode} 
                                name="fillMode"
                                onChange={this.handleFillModeChange}
                            >
                                <sp-radio value="foreground" className="radio-item">
                                    <span className="radio-item-label">纯色</span>
                                    <sp-action-button 
                                        quiet 
                                        className="settings-icon"
                                        onClick={this.toggleColorSettings}
                                    >
                                        <SettingsIcon/>
                                    </sp-action-button>
                                </sp-radio>
                                <sp-radio value="pattern" className="radio-item">
                                    <span className="radio-item-label">图案</span>
                                    <sp-action-button 
                                        quiet 
                                        className="settings-icon"
                                        onClick={this.openPatternPicker}
                                    >
                                        <SettingsIcon/>
                                    </sp-action-button>
                                </sp-radio>
                                <sp-radio value="gradient" className="radio-item">
                                    <span className="radio-item-label">渐变</span>
                                    <sp-action-button 
                                        quiet 
                                        className="settings-icon"
                                        onClick={this.openGradientPicker}
                                    >
                                        <SettingsIcon/>
                                    </sp-action-button>
                                </sp-radio>
                            </sp-radio-group>
                        </div>

                        {/* 底部选项 */}
                        <div className="bottom-options">
                            <div className="checkbox-container">
                                <input
                                    type='checkbox'
                                    id="deselectCheckbox"
                                    checked={this.state.deselectAfterFill}
                                    onChange={this.toggleDeselectAfterFill}
                                    className="checkbox-input"
                                />
                                <label 
                                    htmlFor="deselectCheckbox" 
                                    className="checkbox-label"
                                    onClick={this.toggleDeselectAfterFill} // 添加 onClick 事件处理程序
                                >
                                    填充后取消选区
                                </label>
                            </div>
                            <div className="checkbox-container">
                                <input
                                    type='checkbox'
                                    id="historyCheckbox"
                                    checked={this.state.autoUpdateHistory}
                                    onChange={this.toggleAutoUpdateHistory}
                                    className="checkbox-input"
                                />
                                <label 
                                    htmlFor="historyCheckbox" 
                                    className="checkbox-label"
                                    onClick={this.toggleAutoUpdateHistory} // 添加 onClick 事件处理程序
                                >
                                    自动更新历史源
                                </label>
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
                    pressureVariation: 0
                }} 
            />

            {/* 图案选择器 */}
            <PatternPicker 
                isOpen={this.state?.isPatternPickerOpen ?? false} 
                onClose={this.closePatternPicker} 
                onSelect={this.handlePatternSelect} 
            />

            {/* 渐变选择器 */}
            <GradientPicker 
                isOpen={this.state?.isGradientPickerOpen ?? false}    
                onClose={this.closeGradientPicker} 
                onSelect={this.handleGradientSelect} 
            />

                {/* 描边设置面板 */}
            <StrokeSetting
              isOpen={this.state.isStrokeSettingOpen ?? false}
              width={this.state.strokeWidth}
              position={this.state.strokePosition}
              blendMode={this.state.strokeBlendMode}
              opacity={this.state.strokeOpacity}
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