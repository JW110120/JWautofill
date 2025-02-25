import React from "react";
const { app, action, core, UI } = require("photoshop");

class App extends React.Component {
    state = {
        isFeatureEnabled: false,
        opacity: 100,
        feather: 0,
    };

    async componentDidMount() {
        console.log("✅ 插件加载完成");
        await action.addNotificationListener(["select", "historyStateChanged"], this.handleSelectionChange);
    }

    componentWillUnmount() {
        action.removeNotificationListener(["select", "historyStateChanged"], this.handleSelectionChange);
    }

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
                    await app.activeDocument.selection.feather(featherAmount);
                }

                await action.batchPlay(
                    [
                        {
                            _obj: "fill",
                            using: { _enum: "fillContents", _value: "foregroundColor" },
                            opacity: this.state.opacity,
                            mode: { _enum: "blendMode", _value: "normal" },
                        },
                    ],
                    { synchronousExecution: true, dialogOptions: "dontDisplayDialogs" }
                );
            });

            console.log("✅ 填充完成");
        } catch (error) {
            console.error("❌ 填充失败:", error);
        }
    };

    handleOpacityChange = (event) => {
        this.setState({ opacity: parseInt(event.target.value, 10) });
    };

    handleFeatherChange = (event) => {
        this.setState({ feather: parseInt(event.target.value, 10) });
    };

    render() {
        return (
            <div style={{ padding: "15px", width: "220px", fontFamily: "思源黑体 CN" }}>
                {/* 标题 */}
                <h3
                    style={{
                        textAlign: "center",
                        fontWeight: "bold",
                        fontSize: "24px",
                        marginBottom: "10px",
                        paddingBottom: "5px",
                        borderBottom: "2px solid",
                    }}
                >
                    选区笔 1.0
                </h3>

                {/* 总开关按钮 */}
                <button
                    onClick={this.toggleFeature}
                    style={{
                        backgroundColor: this.state.isFeatureEnabled ? "green" : "red",
                        fontFamily: "思源黑体 CN",
						color: "white",
                        border: "none",
                        padding: "8px 15px",
                        width: "100%",
                        borderRadius: "8px", // 圆角矩形
                        fontSize: "14px",
                        cursor: "pointer",
                    }}
                >
                    {this.state.isFeatureEnabled ? "功能已开启 ✅" : "功能已关闭 ❌"}
                </button>

                <br />
                <br />

                {/* 不透明度 */}
                <label
                    style={{
                        fontSize: "16px",
                        fontWeight: "bold",
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
                    style={{ width: "100%" }}
                />

                <br />
                <br />

                {/* 羽化 */}
                <label
                    style={{
                        fontSize: "16px",
                        fontWeight: "bold",
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
                    style={{ width: "100%" }}
                />
            </div>
        );
    }
}

export default App;