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
                { from: "./src/styles/styles.css", to: "." },
                { from: "./README.md", to: "." }
            ]
        }),
    ]);
    return [uxpPanelConfig];
}
