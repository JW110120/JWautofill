import React, { useState, useEffect } from 'react';
import { shell } from 'uxp';
import { LicenseManager } from '../utils/LicenseManager';

interface LicenseDialogProps {
    isOpen: boolean;
    isLicensed: boolean;
    isTrial: boolean;
    trialDaysRemaining: number;
    onLicenseVerified: () => void;
    onTrialStarted: () => void;
    onClose: () => void;
}

const BILIBILI_AUTHOR_URL = 'https://space.bilibili.com/43980258';

const LicenseDialog: React.FC<LicenseDialogProps> = ({
    isOpen,
    isLicensed,
    isTrial,
    trialDaysRemaining,
    onLicenseVerified,
    onTrialStarted,
    onClose
}) => {
    const [licenseKey, setLicenseKey] = useState('');
    const [isVerifying, setIsVerifying] = useState(false);
    // 输入框聚焦态：用于给外层圆角矩形加聚焦描边（UXP 下不依赖 :focus-within）
    const [inputFocused, setInputFocused] = useState(false);
    const [message, setMessage] = useState('');
    const [messageType, setMessageType] = useState<'success' | 'error' | 'info'>('info');

    // 打开时添加遮罩类，关闭/卸载时移除，解决 number input 层级问题
    useEffect(() => {
        if (isOpen) {
            document.body.classList.add('license-dialog-open');
        } else {
            document.body.classList.remove('license-dialog-open');
        }
        return () => {
            document.body.classList.remove('license-dialog-open');
        };
    }, [isOpen]);

    /**
     * 每次开关都清空面板内部状态。
     * 场景：激活成功 → 点「注销激活状态」→ 面板重新打开时，
     * 若不清空会残留上一次输入的激活码与「激活成功」提示。
     * 注意依赖数组只放 isOpen：若把 isLicensed/isTrial 也放进来，
     * 激活成功时状态变化会把「激活成功」提示立刻清掉，看不到反馈。
     */
    useEffect(() => {
        setLicenseKey('');
        setMessage('');
        setMessageType('info');
        setIsVerifying(false);
        setInputFocused(false);
    }, [isOpen]);

    if (!isOpen) return null;

    const handleVerifyLicense = async () => {
        if (!licenseKey.trim()) {
            setMessage('请输入激活码');
            setMessageType('error');
            return;
        }

        setIsVerifying(true);
        setMessage('正在验证激活码...');
        setMessageType('info');

        try {
            const result = await LicenseManager.verifyLicense(licenseKey);

            if (result.isValid) {
                setMessage('激活成功！');
                setMessageType('success');
                setTimeout(() => {
                    onLicenseVerified();
                    onClose();
                }, 800);
            } else {
                setMessage(result.message);
                setMessageType('error');
            }
        } catch (error) {
            setMessage('验证失败，请重试');
            setMessageType('error');
        } finally {
            setIsVerifying(false);
        }
    };

    const handleStartTrial = async () => {
        setMessage('启动试用中...');
        setMessageType('info');

        try {
            const success = await LicenseManager.generateTrialLicense();

            if (success) {
                setMessage('试用已启动！7天免费期。');
                setMessageType('success');
                setTimeout(() => {
                    onTrialStarted();
                    onClose();
                }, 800);
            } else {
                setMessage('已使用过试用，请购买后获取激活码');
                setMessageType('error');
            }
        } catch (error) {
            setMessage('启动失败，请重试');
            setMessageType('error');
        }
    };

    /**
     * 打开作者 B 站主页。UXP 面板内 <a href> 不会触发系统浏览器，
     * 必须走 shell.openExternal —— 所以链接本身也不用 <a>：
     * UXP 会强制用自带的链接色渲染 <a> 文字（作者 color 被忽略、深色主题下
     * 回退成默认暗蓝，比下划线深一截，实测即如此），
     * 改用可点击的 <span> 后文字颜色完全由 CSS 控制，与下划线同色稳定渲染。
     */
    const handleOpenAuthorPage = () => {
        const sh: any = shell as any;
        if (sh && typeof sh.openExternal === 'function') {
            try {
                sh.openExternal(BILIBILI_AUTHOR_URL);
            } catch (err) {
                console.warn('打开作者主页失败:', err);
            }
        }
    };

    const handleOverlayClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    const handleDialogClick = (e: React.MouseEvent) => {
        e.stopPropagation();
    };

    /**
     * 激活区块：
     * 「输入激活码」标签 + 输入框 在上，「激活」按钮在下（二者同组、标签与按钮左缘对齐）
     */
    const renderActivateBlock = () => (
        <div className="license-block">
            <div className="license-field">
                <label className="license-label">输入激活码</label>
                {/*
                 * 外层 wrap 负责「圆角矩形」的外观（边框 + --dropdown-bg-color 底色 + 圆角），
                 * 内层 input 与 wrap 同色、无边框，并故意比 wrap 矮 8px 居中放置：
                 * UXP 原生 input 的绘制区会高于 CSS 盒且裁不掉，留出上下缓冲才不会越界。
                 */}
                <div className={`license-input-wrap${inputFocused ? ' is-focused' : ''}`}>
                    <input
                        className="license-input"
                        type="text"
                        value={licenseKey}
                        onChange={(e) => setLicenseKey(e.target.value)}
                        onFocus={() => setInputFocused(true)}
                        onBlur={() => setInputFocused(false)}
                        placeholder="请输入激活码"
                        disabled={isVerifying}
                    />
                </div>
            </div>
            <button
                className="license-btn"
                onClick={handleVerifyLicense}
                disabled={isVerifying}
            >
                {isVerifying ? '验证中…' : '激活'}
            </button>
        </div>
    );

    /**
     * 联系行：整句居中。
     * ⚠️ 容器不能带 opacity —— opacity 会连同链接的 border-bottom 一起变暗，
     * 深主题下「联系作者」的下划线会明显比 --primary-color 暗。
     * 改由 .license-contact-dim 只给普通文字降透明度，链接保持纯 --primary-color。
     */
    const renderContact = () => (
        <div className="license-contact">
            <span className="license-contact-dim">无激活码？</span><span
                className="license-link"
                role="button"
                tabIndex={0}
                onClick={handleOpenAuthorPage}
            >联系作者</span><span className="license-contact-dim">{'\u00A0'}购买</span>
        </div>
    );

    const getDialogContent = () => {
        if (isLicensed) {
            return (
                <div className="license-content">
                    <div className="license-head">
                        <span className="license-title">已授权</span>
                        <span className="license-sub">感谢购买选区填充插件！</span>
                    </div>
                    <button className="license-btn" onClick={onClose}>
                        关闭
                    </button>
                </div>
            );
        }

        if (isTrial) {
            return (
                <div className="license-content">
                    <div className="license-head">
                        <span className="license-title">试用版</span>
                        <span className="license-sub">
                            剩余 {trialDaysRemaining} 天 · 试用结束后请购买激活码
                        </span>
                    </div>

                    {renderActivateBlock()}

                    {renderContact()}
                </div>
            );
        }

        return (
            <div className="license-content">
                <div className="license-head">
                    <span className="license-title">欢迎使用易修</span>
                </div>

                {/* 激活区：输入在上、按钮在下 */}
                {renderActivateBlock()}

                <div className="license-divider" />

                {/* 试用区：说明文字后紧接试用按钮 */}
                <div className="license-block">
                    <p className="license-trial-text">免费试用 7 天，完整体验全部功能</p>
                    <button
                        className="license-btn"
                        onClick={handleStartTrial}
                    >
                        免费试用
                    </button>
                </div>

                {renderContact()}
            </div>
        );
    };

    return (
        <div className="license-dialog-overlay" onClick={handleOverlayClick}>
            <div className="license-dialog" onClick={handleDialogClick}>
                {getDialogContent()}

                {message && (
                    <div className={`license-message ${messageType}`}>
                        {message}
                    </div>
                )}
            </div>

            <style>{`
                /*
                 * 排版四原则落点：
                 * - 亲密性：标签与输入框 gap 8px 成组；输入框与按钮 12px（组间更松）；组与组之间 14px
                 * - 对齐：块内统一左缘对齐（文字与按钮左边缘对齐）、按钮整体与卡片水平居中对齐
                 * - 重复：按钮复用面板全局 button 样式（--button-bg/--border-color/圆角4），
                 *         卡片圆角沿用绘画工具箱容器圆角 3px，间距节奏统一 4/8/14px
                 * - 对比：标题 14px/600 加粗 vs 正文 12px 常规；分割线区分激活区与试用区
                 */
                /*
                 * 遮罩只负责布局，背景色统一由 theme.ts 定义（不透明度恒定 0.80、按主题调颜色深浅）。
                 * 不要在组件样式里再写 background-color：组件 <style> 注入晚于 theme.ts，
                 * 同特异性会覆盖掉主题配色；且 UXP 对 var() 解析不稳定，
                 * 曾出现「遮罩能拦截点击但背景不绘制（完全看不见）」的情况。
                 */
                .license-dialog-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    /* 显式宽高兜底：仅靠 top/left/right/bottom 拉伸时，
                       个别 UXP 版本下背景绘制区域会异常 */
                    width: 100%;
                    height: 100%;
                    right: 0;
                    bottom: 0;
                    display: flex;
                    align-items: flex-start;
                    justify-content: center;
                    /* 四周 10px 内边距 → 卡片与面板上/左/右边缘边距恒为 10px */
                    padding: 10px;
                    box-sizing: border-box;
                    z-index: 99999 !important;
                }

                .license-dialog {
                    width: 100%;
                    background: var(--bg-color);
                    border: 1px solid var(--border-color);
                    /* 与绘画工具箱容器（.slider-container）圆角一致：3px */
                    border-radius: 3px;
                    padding: 14px;
                    box-sizing: border-box;
                    overflow-y: auto;
                    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
                    position: relative;
                }

                .license-content {
                    display: flex;
                    flex-direction: column;
                    align-items: stretch;
                    width: 100%;
                    box-sizing: border-box;
                }

                /* 纵向间距一律用 margin 而非 flex gap：
                   UXP 的 CSS 引擎对 flex gap 支持不稳定，实测标签/输入框/按钮会紧贴在一起。 */
                .license-head {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    width: 100%;
                    box-sizing: border-box;
                    /* 标题区 与 下方内容 之间 14px */
                    margin-bottom: 14px;
                }

                .license-head > .license-sub {
                    margin-top: 4px;
                }

                .license-title {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--text-color);
                    line-height: 1.3;
                    text-align: left;
                }

                .license-sub {
                    font-size: 12px;
                    color: var(--text-color);
                    opacity: 0.7;
                    line-height: 1.4;
                    text-align: left;
                }

                .license-block {
                    display: flex;
                    flex-direction: column;
                    align-items: stretch;
                    justify-content: flex-start;
                    width: 100%;
                    box-sizing: border-box;
                }

                /* 与面板按钮同款：走全局 button 规则（--button-bg + --border-color + 圆角4）。
                   居中要点：block + width:100% + 左右 margin auto + text-align:center，
                   使按钮盒与按钮文字都在卡片水平中线上。 */
                .license-btn {
                    display: block;
                    width: 100%;
                    max-width: 100%;
                    height: 32px;
                    margin: 0 auto;
                    padding: 0 10px;
                    box-sizing: border-box;
                    font-size: 12px;
                    color: var(--text-color);
                    background-color: var(--button-bg);
                    border: 1px solid var(--border-color);
                    border-radius: 4px;
                    text-align: center;
                    cursor: pointer;
                    appearance: none;
                    -webkit-appearance: none;
                }

                .license-btn:hover {
                    background-color: var(--hover-bg);
                }

                .license-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .license-field {
                    display: flex;
                    flex-direction: column;
                    align-items: stretch;
                    width: 100%;
                    box-sizing: border-box;
                    /* 输入框 与 下方「激活」按钮 之间 12px（比组内 8px 更松，体现亲密性层次） */
                    margin-bottom: 12px;
                }

                /* 按钮上方的专属文字：与按钮左边缘左对齐 */
                .license-label {
                    display: block;
                    width: 100%;
                    /* 标签 与 输入框 之间 8px */
                    margin: 0 0 8px 0;
                    padding: 0;
                    font-size: 12px;
                    color: var(--text-color);
                    opacity: 0.85;
                    text-align: left;
                    line-height: 1.4;
                }

                /*
                 * 圆角矩形由 wrap 承载（边框 + --dropdown-bg-color 底色 + 圆角 + overflow:hidden）。
                 *
                 * UXP 原生 input 的实际绘制区会高于它的 CSS 盒（表现为「输入区超出圆角矩形下边界」），
                 * 且不响应 overflow:hidden 裁剪（与官方 Known Issues「text field 永远画在最上层」同源），
                 * 所以不能再让 input 撑满 wrap —— 必须留缓冲：
                 *   wrap 34px 固定高 + flex 垂直居中，input 26px，上下各余 4px。
                 * 无论原生绘制区高到 34px 都能被包住，不再越界。
                 */
                .license-input-wrap {
                    display: flex;
                    align-items: center;
                    width: 100%;
                    height: 34px;
                    padding: 0;
                    box-sizing: border-box;
                    border: 1px solid var(--border-color);
                    border-radius: 4px;
                    background-color: var(--dropdown-bg-color);
                    background-image: none;
                    overflow: hidden;
                }

                /* 聚焦态由 React 的 onFocus/onBlur 切换类名，不依赖 :focus-within */
                .license-input-wrap.is-focused {
                    border-color: var(--primary-color);
                    box-shadow: 0 0 0 2px var(--hover-bg);
                }

                .license-input {
                    display: block;
                    /* 26px 居中放进 34px 的 wrap：上下各留 4px 缓冲容纳原生绘制区 */
                    flex: 0 0 auto;
                    width: 100%;
                    height: 26px;
                    line-height: 26px;
                    margin: 0;
                    padding: 0 8px;
                    box-sizing: border-box;
                    border: none;
                    /*
                     * ⚠️ 绝不能写 transparent / background:transparent：
                     * UXP 下 input 的 transparent 会被绘制成纯黑 rgb(0,0,0)，四个主题都一样。
                     * 必须与外层 wrap 同色（--dropdown-bg-color）：
                     * 既消除色差，也避免露黑底。
                     */
                    background-color: var(--dropdown-bg-color);
                    background-image: none;
                    background-clip: border-box;
                    color: var(--text-color);
                    font-size: 12px;
                    text-align: left;
                    outline: none;
                    appearance: none;
                    -webkit-appearance: none;
                }

                .license-input::placeholder {
                    color: var(--disabled-color);
                    opacity: 0.8;
                }

                .license-input:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .license-divider {
                    width: 100%;
                    height: 1px;
                    background: var(--border-color);
                    margin: 14px 0;
                    box-sizing: border-box;
                }

                /* 按钮上方的专属文字：与按钮左边缘左对齐。
                   下方 12px 间距给「免费试用」按钮（UXP 下 flex gap 不可靠，一律用 margin） */
                .license-trial-text {
                    display: block;
                    width: 100%;
                    margin: 0 0 12px 0;
                    padding: 0;
                    font-size: 12px;
                    color: var(--text-color);
                    opacity: 0.85;
                    line-height: 1.4;
                    text-align: left;
                }

                /* 联系行整句居中收尾。
                   ⚠️ 这里不要写 opacity：opacity 会作用于整棵子树，
                   把链接的 color 与 border-bottom 一起压暗，
                   深主题（darkest/dark）下「联系作者」会明显比 --primary-color 暗。 */
                .license-contact {
                    width: 100%;
                    margin-top: 14px;
                    font-size: 12px;
                    color: var(--text-color);
                    text-align: center;
                    /* 行高放宽，给链接的下划线留出空间，避免被裁 */
                    line-height: 1.6;
                }

                /* 只给普通文字降透明度，链接保持 100% 不透明 */
                .license-contact-dim {
                    opacity: 0.7;
                }

                /*
                 * 「联系作者」样式。
                 * 根因（2026-08-31 实测）：UXP 会强制用自带链接色渲染 <a> 文字，
                 * 作者 color 被忽略、深色主题下文字回退成默认暗蓝、比下划线深一截。
                 * 故链接用可点击 <span>（UXP 内 <a href> 本也不唤起浏览器，走 shell.openExternal），
                 * 文字颜色完全由 CSS 控制、与下划线同色稳定渲染。
                 * 颜色取 --primary-color 的恒定值 rgb(38,128,235)：
                 * 不写 var(--primary-color) 是因为项目硬规则禁止在动态注入的组件 <style> 里用 var()
                 * （UXP 对动态子树 var() 解析不稳、整条声明会被丢弃）；字面量等价且零风险。
                 */
                .license-link {
                    color: rgb(38, 128, 235);
                    text-decoration: none;
                    /* UXP 下 text-decoration:underline 不保证渲染，改用 border-bottom 画下划线 */
                    border-bottom: 1px solid rgb(38, 128, 235);
                    display: inline-block;
                    line-height: 1.25;
                    cursor: pointer;
                    /* 绝不能被父级 opacity 连带压暗 */
                    opacity: 1;
                }

                .license-message {
                    width: 100%;
                    margin-top: 12px;
                    padding: 8px 10px;
                    border-radius: 4px;
                    font-size: 12px;
                    text-align: center;
                    line-height: 1.4;
                    box-sizing: border-box;
                }

                .license-message.success {
                    background: var(--notify-ok-bg);
                    color: var(--notify-ok-fg);
                    border: 1px solid var(--notify-ok-border);
                }

                .license-message.error {
                    background: var(--notify-fail-bg);
                    color: var(--notify-fail-fg);
                    border: 1px solid var(--notify-fail-border);
                }

                .license-message.info {
                    background: var(--entry-bg);
                    color: var(--text-color);
                    border: 1px solid var(--border-color);
                }
            `}</style>
        </div>
    );
};

export default LicenseDialog;
