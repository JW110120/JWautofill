const HtmlWebpackPlugin = require('html-webpack-plugin');
const copyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
const path = require("path");

const panelName = `com.listen2me.jwautofill`;

const dist = path.join(__dirname, 'dist');

function createConfig(mode, entry, output, plugins) {
    return {
        entry,
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    exclude: /node_modules/,
                    use: [ { loader: 'ts-loader', options: { transpileOnly: true, configFile: "tsconfig.json" } }],
                },
                { test: /\.css$/, use: ['style-loader', 'css-loader'] },
                { 
                    test: /\.(png|jpg|gif|webp|svg|zip|otf)$/,
                    type: 'asset/resource',
                    generator: {
                        filename: '[name][ext]'
                    }
                }
            ],
        },

        resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js', '.json'] },
        externals: {
            _require: "require",
            photoshop: 'commonjs2 photoshop',
            uxp: 'commonjs2 uxp',
            os: 'commonjs2 os',
        },
        output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'bundle.js',
        publicPath: './' // 手动设置 publicPath
        },

        plugins,
    }
}

module.exports = (env, argv) => {
    const panelOutput = path.join(dist, `${panelName}.unsigned`);
    const uxpPanelConfig = createConfig(argv.mode, { uxp: "./src/index.tsx" }, path.join(dist, panelName), [
        new webpack.ProvidePlugin({
            _require: "_require"
        }),
        new HtmlWebpackPlugin({
            template: './src/index.html',
            filename: 'index.html',
            chunks: ['uxp'],
        }),
        new copyWebpackPlugin({
            patterns: [
                { from: "./manifest.json", to: "." },
                { from: "./src/assets/icons", to: "./icons" },
                { from: "./src/assets/SourceHanSansCN-Normal.otf", to: "." },
                { from: "./src/styles/common.css", to: "." },
                { from: "./README.md", to: "." },
                // 守护进程安装/卸载脚本 + 预编译 exe（面板通过 getPluginFolder 在插件目录
                // 内定位 native/HotkeyDaemon/uninstall.bat 等；不拷贝的话从 dist 加载时
                // 找不到文件，卸载按钮会静默失败）
                { from: "./native/HotkeyDaemon/*.bat", to: "./native/HotkeyDaemon/[name][ext]" },
                { from: "./native/HotkeyDaemon/*.ps1", to: "./native/HotkeyDaemon/[name][ext]" },
                { from: "./native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe", to: "./native/HotkeyDaemon/publish" },
                // 套索实时平滑的**独立守护进程**（native/SmoothDaemon 编译，同一份源码 + ROLE_SMOOTH）。
                // 与热键守护进程是两个完全独立的产物：各自的端口（18924 / 18923）、安装目录
                // （%LOCALAPPDATA%\JWautofill\smooth | daemon）、开机自启项与卸载入口。
                // 面板「平滑选项」里的服务开关经 shell.openPath 唤起它；停掉或卸载任意一侧
                // 都不会影响另一侧 —— 这正是把它们拆成两个进程的目的。
                { from: "./native/SmoothDaemon/publish/JWautofillSmoothDaemon.exe", to: "./native/SmoothDaemon/publish" },
                // 键盘卡死一键修复启动器（独立子项目 FixKeyboard/ 编译，发布到 FixKeyboard/publish/）。
                // 面板「键盘卡死一键修复」经 shell.openPath 唤起 native/HotkeyDaemon/FixKeyboard.exe；
                // 该 exe 运行时会按自身 BaseDirectory 读取同目录的 fix-keyboard.ps1，
                // 故必须与上面的 *.ps1 落在同一层（不能放进 publish/ 子目录）。
                { from: "./native/HotkeyDaemon/FixKeyboard/publish/FixKeyboard.exe", to: "./native/HotkeyDaemon/[name][ext]" },
                // 用户文档（右上角菜单「功能文档」按钮经 shell.openPath 在默认浏览器中打开）
                { from: "./docs", to: "./docs" }
            ]
        }),
    ]);
    return [uxpPanelConfig];
}
