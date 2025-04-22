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
    }

    async componentDidMount() {
        if (!this || !this.handleSelectionChange) return;
        // 分别监听不同类型的选区变化
        await action.addNotificationListener(['set'], this.handleSelectionChange);
        document.addEventListener('mousemove', this.handleMouseMove);
        document.addEventListener('mouseup', this.handleMouseUp);
    }

    componentWillUnmount() {
        if (!this) return;
        // 移除所有监听器
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

    // 添加清除模式切换函数
    toggleClearMode() {
        this.setState(prevState => ({
            clearMode: !prevState.clearMode,
            createNewLayer: prevState.clearMode ? prevState.createNewLayer : false // 如果开启清除模式，关闭新建图层模式
        }));
    }

    handleFillModeChange(event: CustomEvent) {
        try {
            if (!this || !this.state || !event || !event.target) {
                console.error('Invalid context or event object');
                return;
            }
            const value = event.target.selected;
            this.setState({ fillMode: value });
        } catch (error) {
            console.error('Error in handleFillModeChange:', error);
        }
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
        this.setState({
            colorSettings: settings,
            isColorSettingsOpen: false
        });
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
                if (this.state.autoUpdateHistory) {
                    await this.setHistoryBrushSource();
                }
                
                await this.applyFeather();
                await this.fillSelection();
                
                // 只有普通选区操作且设置了取消选区才执行取消选区
                if (this.state.deselectAfterFill) {
                    await this.deselectSelection();
                }
            }, { commandName: '更新历史源&羽化选区&处理选区' });
        } catch (error) {
            console.error('❌ 处理失败:', error);
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
            const result = await action.batchPlay(
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

            // 原有的填充逻辑
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
            const fillOptions = {
                opacity: this.state.opacity,
                blendMode: this.state.blendMode
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
        this.setState({ blendMode: event.target.value });
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
                    <span className="title-text">选区笔1.1</span>
                    <span className="title-beta">beta</span>
                </h3>
                <div className="button-container">
                    <sp-action-button className="toggle-button" onClick={this.handleButtonClick}>
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
                    <select
                        value={this.state.blendMode}
                        onChange={this.handleBlendModeChange}
                        className="blend-mode-select"
                        disabled={this.state.clearMode}
                    >
                        {BLEND_MODE_OPTIONS.map((group, groupIndex) => (
                            <React.Fragment key={groupIndex}>
                                {group.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                                {groupIndex < BLEND_MODE_OPTIONS.length - 1 && (
                                    <option disabled className="blend-mode-option-divider" />
                                )}
                            </React.Fragment>
                        ))}
                    </select>
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
                            {this.state.isExpanded ? (
                                <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 0 18 18" width="18">
                                    <path className="fill" d="M4,7.01a1,1,0,0,1,1.7055-.7055l3.289,3.286,3.289-3.286a1,1,0,0,1,1.437,1.3865l-.0245.0245L9.7,11.7075a1,1,0,0,1-1.4125,0L4.293,7.716A.9945.9945,0,0,1,4,7.01Z" />
                                </svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 0 18 18" width="18">
                                    <path className="fill" d="M12,9a.994.994,0,0,1-.2925.7045l-3.9915,3.99a1,1,0,1,1-1.4355-1.386l.0245-.0245L9.5905,9,6.3045,5.715A1,1,0,0,1,7.691,4.28l.0245.0245,3.9915,3.99A.994.994,0,0,1,12,9Z" />
                                </svg>
                            )}
                        </div>
                        <span>更多选项</span>
                    </div>
                    <div className={`expand-content ${this.state.isExpanded ? 'expanded' : ''}`}>
                        {/* 新建图层模式开关 */}
                        <div className="switch-container">
                            <label className="switch-label">新建图层模式</label>
                            <sp-switch 
                                checked={this.state.createNewLayer}
                                onChange={this.toggleCreateNewLayer}
                                disabled={this.state.clearMode}
                            />
                        </div>

                        {/* 清除模式开关 */}
                        <div className="switch-container">
                            <label className="switch-label">清除模式</label>
                            <sp-switch 
                                checked={this.state.clearMode}
                                onChange={this.toggleClearMode}
                                disabled={this.state.createNewLayer}
                            />
                        </div>

                        {/* 填充模式选择 */}
                        <div className="fill-mode-group">
                            <div className="radio-group-label">填充模式</div>
                            <sp-radio-group 
                                selected={this.state.fillMode} 
                                name="fillMode"
                                vertical={true}
                                onChange={this.handleFillModeChange}
                            >
                                <sp-radio value="foreground" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px'}}>
                                    前景色
                                    <sp-action-button 
                                        quiet 
                                        class="settings-icon"
                                        onClick={this.toggleColorSettings}
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 0 18 18" width="18">
                                            <path className="settings-icon-path" d="M16.45,7.8965H14.8945a5.97644,5.97644,0,0,0-.921-2.2535L15.076,4.54a.55.55,0,0,0,.00219-.77781L15.076,3.76l-.8365-.836a.55.55,0,0,0-.77781-.00219L13.4595,2.924,12.357,4.0265a5.96235,5.96235,0,0,0-2.2535-.9205V1.55a.55.55,0,0,0-.55-.55H8.45a.55.55,0,0,0-.55.55V3.106a5.96235,5.96235,0,0,0-2.2535.9205l-1.1-1.1025a.55.55,0,0,0-.77781-.00219L3.7665,2.924,2.924,3.76a.55.55,0,0,0-.00219.77781L2.924,4.54,4.0265,5.643a5.97644,5.97644,0,0,0-.921,2.2535H1.55a.55.55,0,0,0-.55.55V9.55a.55.55,0,0,0,.55.55H3.1055a5.967,5.967,0,0,0,.921,2.2535L2.924,13.4595a.55.55,0,0,0-.00219.77782l.00219.00218.8365.8365a.55.55,0,0,0,.77781.00219L4.5405,15.076,5.643,13.9735a5.96235,5.96235,0,0,0,2.2535.9205V16.45a.55.55,0,0,0,.55.55H9.55a.55.55,0,0,0,.55-.55V14.894a5.96235,5.96235,0,0,0,2.2535-.9205L13.456,15.076a.55.55,0,0,0,.77782.00219L14.236,15.076l.8365-.8365a.55.55,0,0,0,.00219-.77781l-.00219-.00219L13.97,12.357a5.967,5.967,0,0,0,.921-2.2535H16.45a.55.55,0,0,0,.55-.55V8.45a.55.55,0,0,0-.54649-.55349ZM11.207,9A2.207,2.207,0,1,1,9,6.793H9A2.207,2.207,0,0,1,11.207,9Z" />
                                        </svg>
                                    </sp-action-button>
                                </sp-radio>
                                <sp-radio value="pattern" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px'}}>
                                    图案
                                    <sp-action-button 
                                        quiet 
                                        class="settings-icon"
                                        onClick={this.openPatternPicker}
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 0 18 18" width="18">
                                            <path class="settings-icon-path" d="M16.45,7.8965H14.8945a5.97644,5.97644,0,0,0-.921-2.2535L15.076,4.54a.55.55,0,0,0,.00219-.77781L15.076,3.76l-.8365-.836a.55.55,0,0,0-.77781-.00219L13.4595,2.924,12.357,4.0265a5.96235,5.96235,0,0,0-2.2535-.9205V1.55a.55.55,0,0,0-.55-.55H8.45a.55.55,0,0,0-.55.55V3.106a5.96235,5.96235,0,0,0-2.2535.9205l-1.1-1.1025a.55.55,0,0,0-.77781-.00219L3.7665,2.924,2.924,3.76a.55.55,0,0,0-.00219.77781L2.924,4.54,4.0265,5.643a5.97644,5.97644,0,0,0-.921,2.2535H1.55a.55.55,0,0,0-.55.55V9.55a.55.55,0,0,0,.55.55H3.1055a5.967,5.967,0,0,0,.921,2.2535L2.924,13.4595a.55.55,0,0,0-.00219.77782l.00219.00218.8365.8365a.55.55,0,0,0,.77781.00219L4.5405,15.076,5.643,13.9735a5.96235,5.96235,0,0,0,2.2535.9205V16.45a.55.55,0,0,0,.55.55H9.55a.55.55,0,0,0,.55-.55V14.894a5.96235,5.96235,0,0,0,2.2535-.9205L13.456,15.076a.55.55,0,0,0,.77782.00219L14.236,15.076l.8365-.8365a.55.55,0,0,0,.00219-.77781l-.00219-.00219L13.97,12.357a5.967,5.967,0,0,0,.921-2.2535H16.45a.55.55,0,0,0,.55-.55V8.45a.55.55,0,0,0-.54649-.55349ZM11.207,9A2.207,2.207,0,1,1,9,6.793H9A2.207,2.207,0,0,1,11.207,9Z" />
                                        </svg>
                                    </sp-action-button>
                                </sp-radio>
                                <sp-radio value="gradient" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                                    渐变
                                    <sp-action-button 
                                        quiet 
                                        class="settings-icon"
                                        onClick={this.openGradientPicker}
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 0 18 18" width="18">
                                            <path class="settings-icon-path" d="M16.45,7.8965H14.8945a5.97644,5.97644,0,0,0-.921-2.2535L15.076,4.54a.55.55,0,0,0,.00219-.77781L15.076,3.76l-.8365-.836a.55.55,0,0,0-.77781-.00219L13.4595,2.924,12.357,4.0265a5.96235,5.96235,0,0,0-2.2535-.9205V1.55a.55.55,0,0,0-.55-.55H8.45a.55.55,0,0,0-.55.55V3.106a5.96235,5.96235,0,0,0-2.2535.9205l-1.1-1.1025a.55.55,0,0,0-.77781-.00219L3.7665,2.924,2.924,3.76a.55.55,0,0,0-.00219.77781L2.924,4.54,4.0265,5.643a5.97644,5.97644,0,0,0-.921,2.2535H1.55a.55.55,0,0,0-.55.55V9.55a.55.55,0,0,0,.55.55H3.1055a5.967,5.967,0,0,0,.921,2.2535L2.924,13.4595a.55.55,0,0,0-.00219.77782l.00219.00218.8365.8365a.55.55,0,0,0,.77781.00219L4.5405,15.076,5.643,13.9735a5.96235,5.96235,0,0,0,2.2535.9205V16.45a.55.55,0,0,0,.55.55H9.55a.55.55,0,0,0,.55-.55V14.894a5.96235,5.96235,0,0,0,2.2535-.9205L13.456,15.076a.55.55,0,0,0,.77782.00219L14.236,15.076l.8365-.8365a.55.55,0,0,0,.00219-.77781l-.00219-.00219L13.97,12.357a5.967,5.967,0,0,0,.921-2.2535H16.45a.55.55,0,0,0,.55-.55V8.45a.55.55,0,0,0-.54649-.55349ZM11.207,9A2.207,2.207,0,1,1,9,6.793H9A2.207,2.207,0,0,1,11.207,9Z" />
                                        </svg>
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
                                <label htmlFor="deselectCheckbox" className="checkbox-label">
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
                                <label htmlFor="historyCheckbox" className="checkbox-label">
                                    自动更新历史源
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
            <div className="info-plane">
            <span className="copyright">Copyright © listen2me (JW)</span>
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
        </div>
        );
    }
}

export default App;
