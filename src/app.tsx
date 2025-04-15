import React from 'react';
import { interaction } from 'uxp';
import { app, action, core } from 'photoshop';
import { BLEND_MODES } from './constants/blendModes';
import { BLEND_MODE_OPTIONS } from './constants/blendModeOptions';
import { AppProps, AppState, initialState } from './types/app';
import { DragHandler } from './utils/DragHandler';
import { FillHandler } from './utils/FillHandler';
import { LayerInfoHandler } from './utils/LayerInfoHandler';

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
    }

    async componentDidMount() {
        // 分别监听不同类型的选区变化
        await action.addNotificationListener(['set'], this.handleSelectionChange);
        document.addEventListener('mousemove', this.handleMouseMove);
        document.addEventListener('mouseup', this.handleMouseUp);
    }

    componentWillUnmount() {
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

    toggleExpand = () => {
        this.setState(prevState => {
            const isExpanded = !prevState.isExpanded;
            return { isExpanded };
        });
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

    // 添加新的切换函数
    toggleCreateNewLayer() {
        this.setState({ createNewLayer: !this.state.createNewLayer });
    }

    async fillSelection() {
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            // 如果启用了新建图层选项，先创建新图层
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
        event.preventDefault();
        this.setState({
            isDragging: true,
            dragStartX: event.clientX,
            dragStartValue: this.state[target],
            dragTarget: target
        });
    }

    // 处理鼠标移动事件
    handleMouseMove = (event: MouseEvent): void => {
        if (!this.state.isDragging || !this.state.dragTarget) return;
        
        const newValue = DragHandler.calculateNewValue(
            this.state.dragTarget,
            this.state.dragStartValue,
            this.state.dragStartX,
            event.clientX
        );
        
        this.setState({ [this.state.dragTarget]: newValue });
    }

    // 处理鼠标释放事件
    handleMouseUp = (): void => {
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
            <div style={{ 
                display: 'flex', 
                flexDirection: 'column',
                height: '415px',
                justifyContent: 'space-between'
            }}>
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
                    <span className="blend-mode-label">混合模式：</span>
                    <select
                        value={this.state.blendMode}
                        onChange={this.handleBlendModeChange}
                        className="blend-mode-select"
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
                        onClick={this.toggleDeselectAfterFill}
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
                        onClick={this.toggleAutoUpdateHistory}
                    >
                        自动更新历史源
                    </label>
                </div>
                {/* 添加新的复选框 */}
                <div className="checkbox-container">
                    <input
                        type='checkbox'
                        id="newLayerCheckbox"
                        checked={this.state.createNewLayer}
                        onChange={this.toggleCreateNewLayer}
                        className="checkbox-input"
                    />
                    <label 
                        htmlFor="newLayerCheckbox"
                        className="checkbox-label"
                        onClick={this.toggleCreateNewLayer}
                    >
                        新建图层模式
                    </label>
                </div>
                </div>
            </div>
            </div>
            <div className="info-plane">
            <span className="copyright">Copyright © listen2me (JW)</span>
        </div>
    </div>
        );
    }
}

export default App;
