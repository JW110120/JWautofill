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
                // 卸载启动器（独立子项目 UninstallLauncher/ 编译）：把 uninstall.ps1 放进
                // **可见的控制台窗口**里跑。
                // ⛔ 为什么不再直接唤起 .bat（2026-10-13 用户实测）：shell.openPath 对 .bat
                //    的行为不稳定 —— 热键卸载什么都不出现，平滑卸载只有一个窗口一闪而过。
                //    对 .exe 才是稳定的 ShellExecute + 带出控制台（FixKeyboard.exe 已验证）。
                // ⚠️ 必须落在角色目录**同层**（不能放 publish/ 子目录）：启动器按自身
                //    BaseDirectory 查找同目录的 uninstall.ps1。同一个 exe 两个角色各放一份。
                { from: "./native/UninstallLauncher/publish/JWUninstall.exe", to: "./native/HotkeyDaemon/[name][ext]" },
                { from: "./native/HotkeyDaemon/publish/JWautofillHotkeyDaemon.exe", to: "./native/HotkeyDaemon/publish" },
                // 套索实时平滑的**独立守护进程**（native/SmoothDaemon 编译，同一份源码 + ROLE_SMOOTH）。
                // 与热键守护进程是两个完全独立的产物：各自的端口（18924 / 18923）、安装目录
                // （%LOCALAPPDATA%\JWautofill\smooth | daemon）、开机自启项与卸载入口。
                // 面板「平滑选项」里的服务开关经 shell.openPath 唤起它；停掉或卸载任意一侧
                // 都不会影响另一侧 —— 这正是把它们拆成两个进程的目的。
                { from: "./native/SmoothDaemon/publish/JWautofillSmoothDaemon.exe", to: "./native/SmoothDaemon/publish" },
                // 平滑服务的**卸载脚本**（与热键侧 uninstall.bat / uninstall.ps1 同款）。
                // ⛔ 2026-10-13 用户要求「卸载表现与笔刷热键对齐」：
                //    已卸载后再点一次「卸载套索平滑服务」，不再弹一个信息框，
                //    而是弹出与笔刷完全同款的 cmd 窗口（把实际动作与结果摆出来）。
                //    面板经 getPluginFolder 在插件目录里定位它，不打进 dist 就会静默失败。
                { from: "./native/SmoothDaemon/*.bat", to: "./native/SmoothDaemon/[name][ext]" },
                { from: "./native/SmoothDaemon/*.ps1", to: "./native/SmoothDaemon/[name][ext]" },
                // 平滑侧的卸载启动器（与热键侧同一个 exe，各自跑同目录的 uninstall.ps1）。
                { from: "./native/UninstallLauncher/publish/JWUninstall.exe", to: "./native/SmoothDaemon/[name][ext]" },
                // 笔输入层平滑（P3）的**注入 DLL**（native/WintabHook 用便携 zig 构建）。
                // 平滑守护进程运行时会把它注入 Photoshop 进程，注入时给的是**绝对路径**，
                // 因此这里必须把它带进 dist 的同层布局（daemon 按 BaseDirectory 相对查找）。
                { from: "./native/WintabHook/publish/JWautofillWintabHook.dll", to: "./native/WintabHook/publish" },
                // 键盘卡死一键修复启动器（独立子项目 FixKeyboard/ 编译，发布到 FixKeyboard/publish/）。
                // 面板「键盘卡死一键修复」经 shell.openPath 唤起 native/HotkeyDaemon/FixKeyboard.exe；
                // 该 exe 运行时会按自身 BaseDirectory 读取同目录的 fix-keyboard.ps1，
                // 故必须与上面的 *.ps1 落在同一层（不能放进 publish/ 子目录）。
                { from: "./native/HotkeyDaemon/FixKeyboard/publish/FixKeyboard.exe", to: "./native/HotkeyDaemon/[name][ext]" },
                // 用户文档（右上角菜单「功能文档」按钮经 shell.openPath 在默认浏览器中打开）
                // ⛔ 项目**实现计划/设计文档**严禁进 dist（用户 2026-10-12 明确要求，已入项目铁律）：
                //    它们是内部设计与验收记录，不是给最终用户看的文档。
                //    用 globOptions.ignore 而不是逐个列文件：以后新增用户文档会自动带上，
                //    而任何 *plan*.md 一律被挡在 dist 之外。
                { from: "./docs", to: "./docs", globOptions: { ignore: ["**/*plan*.md"] } }
            ]
        }),
    ]);
    return [uxpPanelConfig];
}
