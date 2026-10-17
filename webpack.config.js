const HtmlWebpackPlugin = require('html-webpack-plugin');
const copyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
const path = require("path");

const panelName = `com.listen2me.jwautofill`;

const dist = path.join(__dirname, 'dist');

function createConfig(mode, entry, output, plugins) {
    return {
        // ⛔⛔ 2026-10-14（用户终端报 `Watchpack Error (stats): EINVAL: invalid argument,
        //    lstat 'C:\pagefile.sys'`）：把构建上下文**钉死**在本目录。
        //    不设时 context = process.cwd()：若 watch 是从 C: 盘上的目录启动的
        //    （例如 home 目录），enhanced-resolve 的 node_modules 祖先链会从那里
        //    一路走到**驱动器根 C:\**，Watchpack 随即对根目录 readdir + lstat，
        //    Administrator 令牌下 lstat pagefile.sys 直接抛 EINVAL（Node 22.17+/24
        //    仍存在的上游问题；本项目目录 F:\Coding\JWautofill 内实测 15 分钟 0 复现，
        //    触发点就在启动时的 cwd）。钉死后祖先链只在本仓库所在盘上行走。
        context: __dirname,
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

        // watch 排除：双保险（即使将来有人从别的 cwd 启动，也不让 watch 范围越过
        // 项目边界去 stat 驱动器根的特殊文件）。
        // ⚠️ webpack schema 的 watchOptions.ignored 只接受「单个 RegExp」或「glob 字符串
        //    数组」（RegExp 数组会被 schema 拒收），而 Watchpack 测试前会把路径里的
        //    反斜杠统一成正斜杠 ⇒ 用**一个组合 RegExp**、按正斜杠书写。
        //    覆盖面：① 驱动器根（C:/ F:/ /）—— 根目录 readdir 会列出 pagefile.sys 等
        //    特殊文件，Administrator 令牌下 lstat 它们直接抛 EINVAL；② 已知会在 lstat
        //    时抛 EINVAL 的根级特殊文件（按文件名兜底，无论落在哪盘）。
        watchOptions: {
            // ⚠️ 第一个分支的 `$` 不能丢：少了它，`^(?:[A-Za-z]:)?\/` 会匹配**每一个**
            //    Windows 绝对路径（都以 `X:/` 开头）⇒ 整个 watch 被静默关掉。
            ignored: /^(?:[A-Za-z]:)?\/$|[\/](?:pagefile|hiberfil|swapfile)\.sys$|[\/]DumpStack\.log\.tmp$|[\/]System Volume Information[\/]/i,
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
                // 键盘卡死一键修复的设备层脚本（.8li 以 runas 提权唤起它完成设备层两步
                // 修复，见 native/JWautofillHost/keyhook.c 的 kh_repair_launch_script；
                // .8li 装在 PS Plug-ins 目录推导不出插件根 ⇒ 路径由面板解析后随
                // repairKeyboard 消息传参，故必须随包分发到插件目录内）。
                // ⚠️ M3/M4 迁移（2026-10-17）：HotkeyDaemon/FixKeyboard 两个 exe 及其
                //    安装/卸载脚本已随 daemon 项目整体退役删除（键盘钩子改由 .8li 在 PS
                //    进程内承载，dist 立省约 140M）——整个 native/HotkeyDaemon/ 目录
                //    已不存在，只剩这个仍被引用的修复脚本（随 .8li 项目同放）。
                { from: "./native/JWautofillHost/fix-keyboard.ps1", to: "./native/JWautofillHost/[name][ext]" },
                // 用户文档（右上角菜单「功能文档」按钮经 shell.openPath 在默认浏览器中打开）。
                // ⛔⛔ **白名单拷贝**（用户 2026-10-15 明确要求，此前已入铁律）：只带两份使用手册
                //    及其 img/；计划书 / 分析报告（*plan*.md、modal-scope-audit.md 等内部设计
                //    与验收记录）一概不进 dist。
                //    历史教训：原来用 globOptions.ignore 挡 `*plan*.md`，结果
                //    modal-scope-audit.md 不匹配该模式，静默漏进 dist ⇒ 黑名单永远追不上
                //    新文件。改为逐个列的白名单：以后新增用户文档必须显式加进这里。
                { from: "./docs/fill-guide.html", to: "./docs/[name][ext]" },
                { from: "./docs/toolbox-guide.html", to: "./docs/[name][ext]" },
                { from: "./docs/img", to: "./docs/img" },
            ]
        }),
    ]);
    return [uxpPanelConfig];
}
