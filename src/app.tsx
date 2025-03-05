import React from 'react';
import { interaction } from 'uxp';
import { app, action, core } from 'photoshop';
const { executeAsModal } = core;
const { batchPlay } = action;

class App extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            opacity: 100,
            feather: 0,
            blendMode: '正常',
            autoUpdateHistory: true,
            isEnabled: true,
            SelectionA: null,
			deselectAfterFill: true // 新增状态，控制填充后是否取消选区
        };
        this.handleSelectionChange = this.handleSelectionChange.bind(this);
        this.handleOpacityChange = this.handleOpacityChange.bind(this);
        this.handleFeatherChange = this.handleFeatherChange.bind(this);
        this.handleBlendModeChange = this.handleBlendModeChange.bind(this);
        this.toggleAutoUpdateHistory = this.toggleAutoUpdateHistory.bind(this);
        this.handleButtonClick = this.handleButtonClick.bind(this); 
        this.toggleDeselectAfterFill = this.toggleDeselectAfterFill.bind(this);
    }

    async componentDidMount() {
        await action.addNotificationListener(['select', 'historyStateChanged'], this.handleSelectionChange);
	}

    componentWillUnmount() {
        action.removeNotificationListener(['select', 'historyStateChanged'], this.handleSelectionChange);
    }

    handleButtonClick() {
        this.setState(prevState => ({
            isEnabled: !prevState.isEnabled
        }));
    }

    getButtonTextAndStyle() {
        let text = this.state.isEnabled ? '功能开启' : '功能关闭';
        let backgroundColor = this.state.isEnabled ? 'rgb(60,120,60)' : 'rgb(200,70,70)';
        return {
            text,
            style: {backgroundColor}
        };
    }

    areSelectionsEqual(selection1, selection2) {
        if (!selection1 || !selection2) return false;
        return JSON.stringify(selection1) === JSON.stringify(selection2);
        }

    async handleSelectionChange() {
        if (!this.state.isEnabled) return;

        try {
            const doc = app.activeDocument;
            if (!doc) {
                console.warn('⚠️ 没有打开的文档，跳过填充');
                return;
            }

    const currentTool = app.currentTool;
    const ignoredTools = [
        {_id: "moveTool"},
		{_id: "eraserTool"},
        {_id: "paintlbrushTool"},
		{_id: "typeCreateOrEditTool"},
        {_id: "eyedropperTool"},
        {_id: "blurTool"},
        {_id: "smudgeTool"},
        {_id: "historyBrushTool"},
        {_id: "gradientTool"},
        {_id: "wetBrushTool"},
		{_id: "pattenStampTool"},
		{_id: "pencilTool"},
		{_id: "penTool"},
		{_id: "rotateTool"},
		{_id: "sharpenTool"},
		{_id: "artBrushTool"},
		{_id: "cropTool"},
		{_id: "wetBrushTool"}
    ];
    if (ignoredTools.some(tool => tool._id === currentTool._id)) {
    console.log(`🛑 当前工具 (${currentTool._id}) 不触发填充`);
    return;
    } else {
    console.log(`当前工具 (${currentTool._id}) 不在忽略列表中`);
    }

        await new Promise(resolve => setTimeout(resolve, 50));
        const selection = await this.getSelection();
        if (!selection) {
            console.warn('⚠️ 选区为空，跳过填充');
            return;
        }
       
        if (this.areSelectionsEqual(selection, this.state.SelectionA)) {
            console.log('⚠️ 选区未发生变化，跳过填充');
            return;
        }

        console.log('🎯 选区发生变化，开始自动填充');

        await core.executeAsModal(async () => {
        if (this.state.autoUpdateHistory) 
		{await this.setHistoryBrushSource();}
        await this.applyFeather();
        await this.fillSelection();
		if (this.state.deselectAfterFill) { // 如果勾选了填充后取消选区
        await this.deselectSelection(); // 调用取消选区的方法
        }
        }, { commandName: '更新历史源&羽化选区&加工选区A&填充选区' });

        console.log('✅ 填充完成');
    } catch (error) {
        console.error('❌ 填充失败:', error);
    }
}

    async getSelection() {
	    try{
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
                            _ref: 'historyState',
                            _enum: 'ordinal',
                            _value: 'last'
                        },
                        _options: {
                            dialogOptions: 'dontDisplay'
                        }
                    }
                ],
                {}
            );
         }catch (error) {
         console.error(error);
         }  
    }

    async applyFeather() {
    const featherAmount = Number(this.state.feather) || 0;
    if (featherAmount <= 0) return;
    
	console.log(`🔧 正在应用羽化: ${featherAmount}px`);
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
    
    await new Promise(resolve => setTimeout(resolve, 100));
    const newSelection = await this.getSelection();
    this.setState({ SelectionA: newSelection });
}

    async fillSelection() {
        const blendModeMap = {
            '正常': 'normal',
            '溶解': 'dissolve',
            '变暗': 'darken',
            '正片叠底': 'multiply',
            '颜色加深': 'colorBurn',
            '线性加深': 'linearBurn',
            '深色': 'darkerColor',
            '变亮': 'lighten',
            '滤色': 'screen',
            '颜色减淡': 'colorDodge',
            '线性减淡': 'linearDodge',
            '浅色': 'lighterColor',
            '叠加': 'overlay',
            '柔光': 'softLight',
            '强光': 'hardLight',
            '亮光': 'vividLight',
            '线性光': 'linearLight',
            '点光': 'pinLight',
            '实色混合': 'hardMix',
            '差值': 'difference',
            '排除': 'exclusion',
            '减去': 'subtract',
            '划分': 'divide',
            '色相': 'hue',
            '饱和度': 'saturation',
            '颜色': 'color',
            '明度': 'luminosity',
        };

        new Promise(resolve => setTimeout(resolve, 50));
        await action.batchPlay([
            {
                _obj: 'fill',
                using: { _enum: 'fillContents', _value: 'foregroundColor' },
                opacity: this.state.opacity,
                mode: { _enum: 'blendMode', _value: blendModeMap[this.state.blendMode] || 'normal' },
                _isCommand: true
            },
        ], { synchronousExecution: true, dialogOptions: 'dontDisplayDialogs' });
    }

    async deselectSelection() { // 新增方法，用于取消选区
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
	
	toggleDeselectAfterFill() { // 新增方法，用于切换填充后取消选区的状态
        this.setState({ deselectAfterFill: !this.state.deselectAfterFill });
    }
	
    render() {
        const { text, style } = this.getButtonTextAndStyle();
        return (
            <div style={{ padding: '5px', width: '200px', fontFamily: 'Arial' }}>
                <h3
                    style={{
                        textAlign: 'center',
                        fontWeight: 'bold',
						marginBottom: '23px',
                        paddingBottom: '5px',
                        borderBottom: `1px solid rgba(128, 128, 128, 0.3)`,
                        color: 'var(--uxp-host-text-color)'
                    }}
                >
                    <span style={{ fontSize: '24px' }}>选区笔1.0</span>
                    <span style={{ fontSize: '13px' }}>beta</span>
                </h3>
                <div style={{ textAlign: 'center',marginBottom: '15px'}}> 
                    <sp-button
                        style={{
                            ...style,
                            borderRadius: '8px', // 添加圆角
                            cursor: 'pointer',
							height: '40px', 
							width: '70%' 
                        }}
                        onClick={this.handleButtonClick}
                    >
                        <div style={{ fontSize: '16px' }}>{text}</div>
                    </sp-button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '30px'}}>
                    <span style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--uxp-host-text-color)', marginBottom: '-18px', marginRight: '-8px' }}>模式：</span>
                    <select
                        value={this.state.blendMode}
                        onChange={this.handleBlendModeChange}
                        style={{
                            flex: 1,
                            padding: '0px',
                            marginBottom: '-12px',
                            borderRadius: '0px',
                            border: '0px solid var(--uxp-host-border-color)',
                            backgroundColor: 'var(--uxp-host-background-color)',
                            color: 'var(--uxp-host-text-color)',
                            cursor: 'pointer',
                            fontSize: '12px',
                        }}
                    >
                        <option value='正常'>正常</option>
                        <option value='溶解'>溶解</option>
                        <option disabled style={{ borderBottom: '1px solid var(--uxp-host-border-color)', padding: '8px 0' }} />
                        <option value='变暗'>变暗</option>
                        <option value='正片叠底'>正片叠底</option>
                        <option value='颜色加深'>颜色加深</option>
                        <option value='线性加深'>线性加深</option>
                        <option value='深色'>深色</option>
                        <option disabled style={{ borderBottom: '1px solid var(--uxp-host-border-color)', padding: '8px 0' }} />
                        <option value='变亮'>变亮</option>
                        <option value='滤色'>滤色</option>
                        <option value='颜色减淡'>颜色减淡</option>
                        <option value='线性减淡'>线性减淡</option>
                        <option value='浅色'>浅色</option>
                        <option disabled style={{ borderBottom: '1px solid var(--uxp-host-border-color)', padding: '8px 0' }} />
                        <option value='叠加'>叠加</option>
                        <option value='柔光'>柔光</option>
                        <option value='强光'>强光</option>
                        <option value='亮光'>亮光</option>
                        <option value='线性光'>线性光</option>
                        <option value='点光'>点光</option>
                        <option value='实色混合'>实色混合</option>
                        <option disabled style={{ borderBottom: '1px solid var(--uxp-host-border-color)', padding: '8px 0' }} />
                        <option value='差值'>差值</option>
                        <option value='排除'>排除</option>
                        <option value='减去'>减去</option>
                        <option value='划分'>划分</option>
                        <option disabled style={{ borderBottom: '1px solid var(--uxp-host-border-color)', padding: '8px 0' }} />
                        <option value='色相'>色相</option>
                        <option value='饱和度'>饱和度</option>
                        <option value='颜色'>颜色</option>
                        <option value='明度'>明度</option>
                    </select>
                </div>
                <label
                    style={{
                        fontSize: '16px',
                        fontWeight: 'bold',
                        color: 'var(--uxp-host-text-color)',
                        marginBottom: '-18px'
                    }}
                >
                    不透明度: {this.state.opacity}%
                </label>
                <input
                    type='range'
                    min='0'
                    max='100'
                    step='1'
                    value={this.state.opacity}
                    onChange={this.handleOpacityChange}
                    style={{ width: '100%', cursor: 'pointer', marginBottom: '-18px' }}
                />
                <br />
                <label
                    style={{
                        fontSize: '16px',
                        fontWeight: 'bold',
                        color: 'var(--uxp-host-text-color)',
                        marginBottom: '-18px'
                    }}
                >
                    羽化: {this.state.feather}px
                </label>
                <input
                    type='range'
                    min='0'
                    max='10'
                    step='0.5'
                    value={this.state.feather}
                    onChange={this.handleFeatherChange}
                    style={{ width: '100%', cursor: 'pointer', marginBottom: '-18px' }}
                />
                <br />
				<br />
				<div style={{ display: 'flex', alignItems: 'center' }}>
                    <input
                        type='checkbox'
                        checked={this.state.deselectAfterFill}
                        onChange={this.toggleDeselectAfterFill}
                        style={{ marginRight: '0px', cursor: 'pointer' }}
                    />
                    <label style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--uxp-host-text-color)', cursor: 'pointer' }}>
                        填充后取消选区
                    </label>
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                    <input
                        type='checkbox'
                        checked={this.state.autoUpdateHistory}
                        onChange={this.toggleAutoUpdateHistory}
                        style={{ marginRight: '0px', cursor: 'pointer' }}
                    />
                    <label style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--uxp-host-text-color)', cursor: 'pointer' }}>
                        自动更新历史源
                    </label>
                </div>
            </div>
        );
    }
}

export default App;
