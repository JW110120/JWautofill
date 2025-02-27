import React from "react";
const { app, action, core } = require("photoshop");
const { executeAsModal } = core;
const { batchPlay } = action;

class App extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            isFeatureEnabled: true,
            opacity: 50,
            feather: 5,
            blendMode: "正常",
            autoUpdateHistory: true,
        };
        
		this.handleKeyDown = this.handleKeyDown.bind(this);
        this.toggleFeature = this.toggleFeature.bind(this);
		this.handleSelectionChange = this.handleSelectionChange.bind(this);
		this.handleOpacityChange = this.handleOpacityChange.bind(this);
        this.handleFeatherChange = this.handleFeatherChange.bind(this);
        this.handleBlendModeChange = this.handleBlendModeChange.bind(this);
        this.toggleAutoUpdateHistory = this.toggleAutoUpdateHistory.bind(this);
		
    }

    async componentDidMount() {
        console.log("✅ 插件加载完成");
        await action.addNotificationListener(["select", "historyStateChanged"], this.handleSelectionChange);
        document.addEventListener("keydown", this.handleKeyDown, true); // 使用捕获阶段
    }

    componentWillUnmount() {
        action.removeNotificationListener(["select", "historyStateChanged"], this.handleSelectionChange);
        document.removeEventListener("keydown", this.handleKeyDown);
    }

   handleKeyDown(event) {
    console.log("事件对象:", event);  // 打印键盘事件对象
    if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        this.toggleFeature();
    }
}

    toggleFeature() {
        this.setState({ isFeatureEnabled: !this.state.isFeatureEnabled }, () => {
            console.log(`🔘 功能开关状态: ${this.state.isFeatureEnabled ? "开启 ✅" : "关闭 ❌"}`);
        });
    }

    async handleSelectionChange() {
        if (!this.state.isFeatureEnabled) return;

        try {
            const doc = app.activeDocument;
            if (!doc) {
                console.warn("⚠️ 没有打开的文档，跳过填充");
                return;
            }

            const selection = await this.getSelection();
            if (!selection) {
                console.warn("⚠️ 选区为空，跳过填充");
                return;
            }

            console.log("🎯 选区发生变化，开始自动填充");

        await core.executeAsModal(async () => {

            if (this.state.autoUpdateHistory) {
            await this.setHistoryBrushSource();
            }
            await this.applyFeather();
            await this.fillSelection();
        }, { commandName: "更新历史源&羽化&填充选区" });

            console.log("✅ 填充完成");
        } 
		
		catch (error) {console.error("❌ 填充失败:", error);}
    	}

    async getSelection() {
        const result = await action.batchPlay(
            [
                {
                    _obj: "get",
                    _target: [
                        { _property: "selection" },
                        { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
                    ],
                },
            ],
            { synchronousExecution: true }
        );
        const selection = result?.[0]?.selection;
        return selection && Object.keys(selection).length > 0 ? selection : null;
    }

    async setHistoryBrushSource() {
	    const doc = app.activeDocument;
    if (!doc) {
        console.warn("⚠️ 没有打开的文档，跳过更新历史记录画笔源");
        return;
    }

    // 检查历史记录状态
    const historyStates = doc.historyStates;
    if (historyStates.length === 0) {
        console.warn("⚠️ 历史记录堆栈为空，跳过更新历史记录画笔源");
        return;
    }

        try {
        const result = await batchPlay(
            [
                {
                    _obj: "set",
                    _target: [
                        {
                            _ref: "historyState",
                            _property: "historyBrushSource"
                        }
                    ],
                    to: [
                        {
                            _ref: "historyState",
                            _property: "currentHistoryState"
						}
                    ],
                  
                }
            ],
            {}
        );

            console.log("batchPlay 返回结果:", JSON.stringify(result, null, 2));

        if (Array.isArray(result) && result.length > 0) {
            const firstResult = result[0];
            if (firstResult._obj === "error") {
                console.error("❌ 更新历史记录画笔源失败，错误信息:", firstResult.message);
                console.error("错误代码:", firstResult.result);
            } else {
                const status = firstResult.status;
                if (status === "success") {
                    console.log("✅ 历史记录画笔源已更新");
                } else {
                    console.error("❌ 更新历史记录画笔源失败，返回状态:", status);
                    if (firstResult.error) {
                        console.error("错误详情:", firstResult.error);
                    }
                }
            }
        } else {
            console.error("❌ 更新历史记录画笔源失败，返回结果为空或格式不正确");
        }
    } catch (error) {
        console.error("❌ 更新历史记录画笔源失败:", error);
		}
    }  

    async applyFeather() {
        const featherAmount = Number(this.state.feather) || 0;
        if (featherAmount > 0) {
            console.log(`🔧 正在应用羽化: ${featherAmount}px`);
            await action.batchPlay(
                [
                    {
                        _obj: "feather",
                        radius: featherAmount,
                        _isCommand: true
                    },
                ],
                { synchronousExecution: true, modalBehavior: "execute" }
            );
        }
    }

    async fillSelection() {
        const blendModeMap = {
            "正常": "normal",
            "溶解": "dissolve",
            "变暗": "darken",
            "正片叠底": "multiply",
            "颜色加深": "colorBurn",
            "线性加深": "linearBurn",
            "深色": "darkerColor",
            "变亮": "lighten",
            "滤色": "screen",
            "颜色减淡": "colorDodge",
            "线性减淡": "linearDodge",
            "浅色": "lighterColor",
            "叠加": "overlay",
            "柔光": "softLight",
            "强光": "hardLight",
            "亮光": "vividLight",
            "线性光": "linearLight",
            "点光": "pinLight",
            "实色混合": "hardMix",
            "差值": "difference",
            "排除": "exclusion",
            "减去": "subtract",
            "划分": "divide",
            "色相": "hue",
            "饱和度": "saturation",
            "颜色": "color",
            "明度": "luminosity",
        };

        await new Promise((resolve) => setTimeout(resolve, 50));
        await action.batchPlay([
            {
                _obj: "fill",
                using: { _enum: "fillContents", _value: "foregroundColor" },
                opacity: this.state.opacity,
                mode: { _enum: "blendMode", _value: blendModeMap[this.state.blendMode] || "normal" },
                _isCommand: true
            },
        ], { synchronousExecution: true, dialogOptions: "dontDisplayDialogs" });
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

    render() {
        return (
            <div style={{ padding: "18px", width: "220px", fontFamily: "思源黑体 CN" }}>
                <h3
                    style={{
                        textAlign: 'center',
                        fontWeight: 'bold',
                        marginBottom: '20px',
                        paddingBottom: '18px',
                        borderBottom: `1px solid rgba(128, 128, 128, 0.3)`,
                        color: 'var(--uxp-host-text-color)'
                    }}
                >
                    <span style={{ fontSize: '24px' }}>选区笔1.0</span>
                    <span style={{ fontSize: '13px' }}>beta</span>
                </h3>
                <button
                    onClick={this.toggleFeature}
                    style={{
                        backgroundColor: this.state.isFeatureEnabled ? "green" : "red",
                        color: "white",
                        margin: "0 auto",
                        width: "100%",
                        minHeight: "100px",
                        borderRadius: "15px",
                        fontSize: "30px",
                        cursor: "pointer",
                        textAlign: "center",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        alignItems: "center",
                        whiteSpace: "normal",
                        padding: "10px",
                        transition: "background-color 0.3s, transform 0.1s",
                        boxShadow: "0 4px 8px rgba(0, 0, 0, 0.2)",
                    }}
                    onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.95)")}
                    onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
                >
                    <div style={{ fontSize: "20px", fontWeight: "bold" }}>
                        {this.state.isFeatureEnabled ? "功能已开启 ✅" : "功能已关闭 ❌"}
                    </div>
                    <div style={{ fontSize: "12px", color: "rgba(255, 255, 255, 0.7)" }}>
                        （快捷键：Ctrl+K）
                    </div>
                </button>
                <br />
                <div style={{ display: "flex", alignItems: "center", marginBottom: "30px" }}>
                    <span style={{ fontSize: "16px", fontWeight: "bold", color: "var(--uxp-host-text-color)", marginBottom: '-18px', marginRight: "-12px" }}>模式：</span>
                    <select
                        value={this.state.blendMode}
                        onChange={this.handleBlendModeChange}
                        style={{
                            flex: 1,
                            padding: "8px",
                            marginBottom: '-25px',
                            borderRadius: "0px",
                            border: "0px solid var(--uxp-host-border-color)",
                            backgroundColor: "var(--uxp-host-background-color)",
                            color: "var(--uxp-host-text-color)",
                            cursor: "pointer",
                            fontSize: "8px",
                        }}
                    >
                        <option value="正常" style={{ padding: "8px 0" }}>正常</option>
                        <option value="溶解" style={{ padding: "8px 0" }}>溶解</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        <option value="变暗" style={{ padding: "8px 0" }}>变暗</option>
                        <option value="正片叠底" style={{ padding: "8px 0" }}>正片叠底</option>
                        <option value="颜色加深" style={{ padding: "8px 0" }}>颜色加深</option>
                        <option value="线性加深" style={{ padding: "8px 0" }}>线性加深</option>
                        <option value="深色" style={{ padding: "8px 0" }}>深色</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        <option value="变亮" style={{ padding: "8px 0" }}>变亮</option>
                        <option value="滤色" style={{ padding: "8px 0" }}>滤色</option>
                        <option value="颜色减淡" style={{ padding: "8px 0" }}>颜色减淡</option>
                        <option value="线性减淡" style={{ padding: "8px 0" }}>线性减淡</option>
                        <option value="浅色" style={{ padding: "8px 0" }}>浅色</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        <option value="叠加" style={{ padding: "8px 0" }}>叠加</option>
                        <option value="柔光" style={{ padding: "8px 0" }}>柔光</option>
                        <option value="强光" style={{ padding: "8px 0" }}>强光</option>
                        <option value="亮光" style={{ padding: "8px 0" }}>亮光</option>
                        <option value="线性光" style={{ padding: "8px 0" }}>线性光</option>
                        <option value="点光" style={{ padding: "8px 0" }}>点光</option>
                        <option value="实色混合" style={{ padding: "8px 0" }}>实色混合</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        <option value="差值" style={{ padding: "8px 0" }}>差值</option>
                        <option value="排除" style={{ padding: "8px 0" }}>排除</option>
                        <option value="减去" style={{ padding: "8px 0" }}>减去</option>
                        <option value="划分" style={{ padding: "8px 0" }}>划分</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        <option value="色相" style={{ padding: "8px 0" }}>色相</option>
                        <option value="饱和度" style={{ padding: "8px 0" }}>饱和度</option>
                        <option value="颜色" style={{ padding: "8px 0" }}>颜色</option>
                        <option value="明度" style={{ padding: "8px 0" }}>明度</option>
                    </select>
                </div>
                <label
                    style={{
                        fontSize: "16px",
                        fontWeight: "bold",
                        color: "var(--uxp-host-text-color)",
                        marginBottom: '-18px'
                    }}
                >
                    不透明度: {this.state.opacity}%
                </label>
                <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={this.state.opacity}
                    onChange={this.handleOpacityChange}
                    style={{ width: "100%", cursor: "pointer", marginBottom: '-18px' }}
                />
                <br />
                <br />
                <label
                    style={{
                        fontSize: "16px",
                        fontWeight: "bold",
                        color: "var(--uxp-host-text-color)",
                        marginBottom: '-18px'
                    }}
                >
                    羽化: {this.state.feather}px
                </label>
                <input
                    type="range"
                    min="0"
                    max="5"
                    step="1"
                    value={this.state.feather}
                    onChange={this.handleFeatherChange}
                    style={{ width: "100%", cursor: "pointer", marginBottom: '-18px' }}
                />
                <br />
                <br />
                <div style={{ display: "flex", alignItems: "center" }}>
                    <input
                        type="checkbox"
                        checked={this.state.autoUpdateHistory}
                        onChange={this.toggleAutoUpdateHistory}
                        style={{ marginRight: "0px", cursor: "pointer" }}
                    />
                    <label style={{ fontSize: "16px", fontWeight: "bold", color: "var(--uxp-host-text-color)", cursor: "pointer" }}>
                        自动更新历史记录
                    </label>
                </div>
            </div>
        );
    }
}

export default App;
