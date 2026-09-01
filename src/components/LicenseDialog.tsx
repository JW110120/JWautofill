import React, { useState, useEffect } from 'react';
import { shell } from 'uxp';
import { LicenseManager } from '../utils/LicenseManager';
// 弹窗样式已抽到 src/styles/license.css，由 index.tsx 在 styles.css 之后引入，
// 保持「弹窗样式排在主面板样式之后」的层叠顺序；遮罩背景色仍由 theme.ts 统一给出。

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
            <div
                className="license-btn"
                role="button"
                tabIndex={isVerifying ? -1 : 0}
                aria-disabled={isVerifying}
                onClick={() => { if (!isVerifying) void handleVerifyLicense(); }}
                onKeyDown={(e) => {
                    if (!isVerifying && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        void handleVerifyLicense();
                    }
                }}
            >
                {isVerifying ? '验证中…' : '激活'}
            </div>
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
                    <div
                        className="license-btn"
                        role="button"
                        tabIndex={0}
                        onClick={() => onClose()}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onClose();
                            }
                        }}
                    >
                        关闭
                    </div>
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
                    <div
                        className="license-btn"
                        role="button"
                        tabIndex={0}
                        onClick={() => void handleStartTrial()}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                void handleStartTrial();
                            }
                        }}
                    >
                        免费试用
                    </div>
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
        </div>
    );
};

export default LicenseDialog;
