import React, { useState, useEffect } from 'react';
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

    const handleOverlayClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    const handleDialogClick = (e: React.MouseEvent) => {
        e.stopPropagation();
    };

    const getDialogContent = () => {
        if (isLicensed) {
            return (
                <div className="license-content">
                    <h3>✅ 已授权</h3>
                    <p>感谢购买选区笔插件！</p>
                    <div className="button-group">
                        <sp-action-button onClick={onClose}>关闭</sp-action-button>
                    </div>
                </div>
            );
        }

        if (isTrial) {
            return (
                <div className="license-content">
                    <h3>🔶 试用版</h3>
                    <p>剩余：{trialDaysRemaining} 天</p>
                    <p>试用结束后请购买正式激活码。</p>
                    
                    <div className="license-input-group">
                        <label>已购买？输入激活码：</label>
                        <input
                            type="text"
                            value={licenseKey}
                            onChange={(e) => setLicenseKey(e.target.value)}
                            placeholder="激活码"
                            disabled={isVerifying}
                        />
                    </div>

                    <div className="button-group">
                        <sp-action-button 
                            onClick={handleVerifyLicense}
                            disabled={isVerifying}
                        >
                            {isVerifying ? '验证...' : '激活'}
                        </sp-action-button>
                        <sp-action-button variant="secondary" onClick={onClose}>
                            稍后
                        </sp-action-button>
                    </div>
                </div>
            );
        }

        return (
            <div className="license-content">
                <h3>🔒 欢迎使用选区笔</h3>
                <p>需要有效激活码才能使用。</p>
                
                <div className="license-input-group">
                    <label>已购买？输入激活码：</label>
                    <input
                        type="text"
                        value={licenseKey}
                        onChange={(e) => setLicenseKey(e.target.value)}
                        placeholder="激活码"
                        disabled={isVerifying}
                    />
                </div>

                <div className="trial-section">
                    <p>或免费试用7天：</p>
                </div>

                <div className="button-group">
                    <sp-action-button 
                        onClick={handleVerifyLicense}
                        disabled={isVerifying}
                    >
                        {isVerifying ? '验证...' : '激活'}
                    </sp-action-button>
                    <sp-action-button 
                        variant="secondary" 
                        onClick={handleStartTrial}
                    >
                        试用
                    </sp-action-button>
                </div>

                <div className="purchase-info">
                    <p>无激活码？请联系作者购买</p>
                </div>
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
                .license-dialog-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.8);
                    display: flex;
                    align-items: flex-start;
                    justify-content: center;
                    z-index: 99999 !important;
                    padding-top: 20px;
                }

                .license-dialog {
                    background: var(--spectrum-global-color-gray-100);
                    border-radius: 6px;
                    padding: 16px;
                    width: 220px;
                    max-width: 220px;
                    max-height: 800px;
                    overflow-y: auto;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
                    position: relative;
                }

                .license-content h3 {
                    margin: 0 0 10px 0;
                    font-size: 14px;
                    color: var(--spectrum-global-color-gray-900);
                }

                .license-content p {
                    margin: 0 0 8px 0;
                    line-height: 1.4;
                    font-size: 12px;
                    color: var(--spectrum-global-color-gray-700);
                }

                .license-input-group {
                    margin: 10px 0;
                }

                .license-input-group label {
                    display: block;
                    margin-bottom: 6px;
                    font-weight: 500;
                    font-size: 12px;
                    color: var(--spectrum-global-color-gray-800);
                }

                .license-input-group input {
                    width: 100%;
                    height: 26px;
                    padding: 4px 8px;
                    border: 1px solid var(--spectrum-global-color-gray-400);
                    border-radius: 4px;
                    font-size: 12px;
                    box-sizing: border-box;
                    background: var(--spectrum-global-color-gray-100);
                }

                .license-input-group input:focus {
                    outline: none;
                    border-color: var(--spectrum-global-color-blue-500);
                    box-shadow: 0 0 0 2px rgba(56, 146, 251, 0.15);
                }

                .trial-section {
                    margin: 12px 0 8px 0;
                    padding-top: 8px;
                    border-top: 1px solid var(--spectrum-global-color-gray-300);
                }

                .button-group {
                    display: flex;
                    gap: 8px;
                    margin-top: 12px;
                    justify-content: flex-end;
                }

                .button-group sp-action-button {
                    --spectrum-actionbutton-m-min-width: 0;
                }

                .purchase-info {
                    margin-top: 10px;
                    padding-top: 10px;
                    border-top: 1px solid var(--spectrum-global-color-gray-300);
                    text-align: center;
                }

                .purchase-info a {
                    color: var(--spectrum-global-color-blue-600);
                    text-decoration: none;
                    font-size: 12px;
                }

                .purchase-info a:hover {
                    text-decoration: underline;
                }

                .license-message {
                    margin-top: 10px;
                    padding: 8px;
                    border-radius: 4px;
                    font-size: 12px;
                    text-align: center;
                }

                .license-message.success {
                    background: var(--spectrum-global-color-green-100);
                    color: var(--spectrum-global-color-green-700);
                    border: 1px solid var(--spectrum-global-color-green-300);
                }

                .license-message.error {
                    background: var(--spectrum-global-color-red-100);
                    color: var(--spectrum-global-color-red-700);
                    border: 1px solid var(--spectrum-global-color-red-300);
                }

                .license-message.info {
                    background: var(--spectrum-global-color-blue-100);
                    color: var(--spectrum-global-color-blue-700);
                    border: 1px solid var(--spectrum-global-color-blue-300);
                }
            `}</style>
        </div>
    );
};

export default LicenseDialog;