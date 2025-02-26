import React from "react";
const { app, action, core } = require("photoshop");

// 辅助函数，用于从 CSS 变量中提取 RGB 值
function getRGBFromVar(cssVar: string): string {
    const tempElement = document.createElement('div');
    tempElement.style.color = cssVar;
    document.body.appendChild(tempElement);
    const rgbColor = window.getComputedStyle(tempElement).color;
    document.body.removeChild(tempElement);
    const match = rgbColor.match(/\d+/g);
    return match ? match.join(', ') : '0, 0, 0';
}

class App extends React.Component {
    state = {
        isFeatureEnabled: false,
        opacity: 100,
        feather: 0,
        blendMode: "正常", // 新增：色彩混合模式
        autoUpdateHistory: false, // 新增：自动更新历史记录
    };

    async componentDidMount() {
        console.log("✅ 插件加载完成");
        await action.addNotificationListener(["select", "historyStateChanged"], this.handleSelectionChange);

        // 新增：快捷键监听
        document.addEventListener("keydown", this.handleKeyDown);
    }

    componentWillUnmount() {
        action.removeNotificationListener(["select", "historyStateChanged"], this.handleSelectionChange);

        // 新增：移除快捷键监听
        document.removeEventListener("keydown", this.handleKeyDown);
    }

    // 新增：快捷键处理
    handleKeyDown = (event: KeyboardEvent) => {
        if (event.ctrlKey && event.shiftKey && event.altKey && event.key === "k") {
            this.toggleFeature();
        }
    };

    toggleFeature = () => {
        this.setState({ isFeatureEnabled: !this.state.isFeatureEnabled }, () => {
            console.log(`🔘 功能开关状态: ${this.state.isFeatureEnabled ? "开启 ✅" : "关闭 ❌"}`);
        });
    };

    handleSelectionChange = async () => {
        if (!this.state.isFeatureEnabled) return;

        try {
            const doc = app.activeDocument;
            if (!doc) {
                console.warn("⚠️ 没有打开的文档，跳过填充");
                return;
            }

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
            const hasSelection = selection && Object.keys(selection).length > 0;
            if (!hasSelection) {
                console.warn("⚠️ 选区为空，跳过填充");
                return;
            }

            console.log("🎯 选区发生变化，开始自动填充");

            await core.executeAsModal(async () => {
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

                // 新增：根据选择的混合模式进行填充
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

                await action.batchPlay(
                    [
                        {
                            _obj: "fill",
                            using: { _enum: "fillContents", _value: "foregroundColor" },
                            opacity: this.state.opacity,
                            mode: { _enum: "blendMode", _value: blendModeMap[this.state.blendMode] || "normal" },
                            _isCommand: true
                        },
                    ],
                    { synchronousExecution: true, dialogOptions: "dontDisplayDialogs" }
                );

                // 新增：自动更新历史记录画笔源
                if (this.state.autoUpdateHistory) {
                    await action.batchPlay(
                        [
                            {
                                _obj: "set",
                                _target: [
                                    { _property: "historyBrushSource" },
                                    { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
                                ],
                                to: { _enum: "historyState", _value: "current" },
                            },
                        ],
                        { synchronousExecution: true }
                    );
                    console.log("✅ 历史记录画笔源已更新");
                }
            }, { commandName: "Apply Feather and Fill" });

            console.log("✅ 填充完成");
        } catch (error) {
            console.error("❌ 填充失败:", error);
        }
    };

    handleOpacityChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ opacity: parseInt(event.target.value, 10) });
    };

    handleFeatherChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ feather: parseInt(event.target.value, 10) });
    };

    // 新增：处理混合模式变化
    handleBlendModeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
        this.setState({ blendMode: event.target.value });
    };

    // 新增：处理自动更新历史记录开关
    toggleAutoUpdateHistory = () => {
        this.setState({ autoUpdateHistory: !this.state.autoUpdateHistory });
    };

    render() {
        return (
            <div style={{ padding: "18px", width: "220px", fontFamily: "思源黑体 CN" }}>
                <h3
                    style={{
                        textAlign: 'center',
                        fontWeight: 'bold',
                        marginBottom: '20px',
                        paddingBottom: '18px',
                        borderBottom: `1px solid rgba(${getRGBFromVar('var(--uxp-host-text-color)')}, 0.5)`,
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
                        fontFamily: "思源黑体 CN",
                        color: "white",
                        border: "none",
                        padding: "8px 18px",
                        margin: "0 auto",
                        display: "block",
                         width: "80%",
                        height: "50px",
                        lineHeight: "41px",
                        borderRadius: "6px",
                        fontSize: "20px",
                        cursor: "pointer",
                    }}
                >
                    {this.state.isFeatureEnabled ? "功能已开启 ✅" : "功能已关闭 ❌"}
                </button>

                <br />
                <br />

                {/* 新增：色彩混合模式下拉菜单 */}
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
                            fontSize: "8px", // 字体减小 3px
                        }}
                    >
                        {/* 变暗组 */}
                        <option value="正常" style={{ padding: "8px 0" }}>正常</option>
                        <option value="溶解" style={{ padding: "8px 0" }}>溶解</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        <option value="变暗" style={{ padding: "8px 0" }}>变暗</option>
                        <option value="正片叠底" style={{ padding: "8px 0" }}>正片叠底</option>
                        <option value="颜色加深" style={{ padding: "8px 0" }}>颜色加深</option>
                        <option value="线性加深" style={{ padding: "8px 0" }}>线性加深</option>
                        <option value="深色" style={{ padding: "8px 0" }}>深色</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        {/* 变亮组 */}
                        <option value="变亮" style={{ padding: "8px 0" }}>变亮</option>
                        <option value="滤色" style={{ padding: "8px 0" }}>滤色</option>
                        <option value="颜色减淡" style={{ padding: "8px 0" }}>颜色减淡</option>
                        <option value="线性减淡" style={{ padding: "8px 0" }}>线性减淡</option>
                        <option value="浅色" style={{ padding: "8px 0" }}>浅色</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        {/* 叠加组 */}
                        <option value="叠加" style={{ padding: "8px 0" }}>叠加</option>
                        <option value="柔光" style={{ padding: "8px 0" }}>柔光</option>
                        <option value="强光" style={{ padding: "8px 0" }}>强光</option>
                        <option value="亮光" style={{ padding: "8px 0" }}>亮光</option>
                        <option value="线性光" style={{ padding: "8px 0" }}>线性光</option>
                        <option value="点光" style={{ padding: "8px 0" }}>点光</option>
                        <option value="实色混合" style={{ padding: "8px 0" }}>实色混合</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        {/* 差值组 */}
                        <option value="差值" style={{ padding: "8px 0" }}>差值</option>
                        <option value="排除" style={{ padding: "8px 0" }}>排除</option>
                        <option value="减去" style={{ padding: "8px 0" }}>减去</option>
                        <option value="划分" style={{ padding: "8px 0" }}>划分</option>
                        <option disabled style={{ borderBottom: "1px solid var(--uxp-host-border-color)", padding: "8px 0" }} />
                        {/* 颜色组 */}
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
                    style={{ width: "100%", marginBottom: '-18px' }}
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
                    style={{ width: "100%", marginBottom: '-18px' }}
                />

                <br />
                <br />

                {/* 新增：自动更新历史记录开关 */}
                <div style={{ display: "flex", alignItems: "center" }}>
                    <input
                        type="checkbox"
                        checked={this.state.autoUpdateHistory}
                        onChange={this.toggleAutoUpdateHistory}
                        style={{ marginRight: "10px", cursor: "pointer" }}
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
