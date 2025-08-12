import { storage } from 'uxp';

export interface LicenseInfo {
    key: string;
    userId: string;
    expiryDate?: string;
    isValid: boolean;
    lastVerified: number;
}

export class LicenseManager {
    private static readonly STORAGE_KEY = 'jwautofill_license';
    private static readonly VERIFICATION_URL = 'https://api.gumroad.com/v2/licenses/verify';
    private static readonly PRODUCT_ID = 'your_product_id'; // 你需要在Gumroad设置中获取
    private static readonly VERIFICATION_INTERVAL = 24 * 60 * 60 * 1000; // 24小时验证一次

    /**
     * 验证许可证密钥
     */
    static async verifyLicense(licenseKey: string): Promise<{ isValid: boolean; message: string; userInfo?: any }> {
        try {
            // 基本格式验证
            if (!licenseKey || licenseKey.length < 10) {
                return { isValid: false, message: '许可证密钥格式不正确' };
            }

            // 在线验证（如果有网络连接）
            try {
                const response = await fetch(this.VERIFICATION_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        'product_id': this.PRODUCT_ID,
                        'license_key': licenseKey,
                        'increment_uses_count': 'false'
                    })
                });

                const result = await response.json();
                
                if (result.success) {
                    const licenseInfo: LicenseInfo = {
                        key: licenseKey,
                        userId: result.purchase?.buyer_id || 'unknown',
                        isValid: true,
                        lastVerified: Date.now()
                    };

                    // 保存到本地存储
                    await this.saveLicenseInfo(licenseInfo);
                    
                    return { 
                        isValid: true, 
                        message: '许可证验证成功', 
                        userInfo: result.purchase 
                    };
                } else {
                    return { 
                        isValid: false, 
                        message: result.message || '许可证验证失败，请检查密钥是否正确' 
                    };
                }
            } catch (networkError) {
                console.warn('网络验证失败，尝试离线验证:', networkError);
                
                // 网络失败时，检查本地缓存的许可证
                const cachedLicense = await this.getCachedLicense();
                if (cachedLicense && cachedLicense.key === licenseKey) {
                    // 如果距离上次验证不超过7天，允许离线使用
                    const daysSinceLastVerification = (Date.now() - cachedLicense.lastVerified) / (24 * 60 * 60 * 1000);
                    if (daysSinceLastVerification <= 7) {
                        return { 
                            isValid: true, 
                            message: '离线模式下许可证有效（请在有网络时重新验证）' 
                        };
                    }
                }
                
                return { 
                    isValid: false, 
                    message: '无法连接到验证服务器，且没有有效的离线许可证' 
                };
            }
        } catch (error) {
            console.error('许可证验证错误:', error);
            return { 
                isValid: false, 
                message: '许可证验证过程中发生错误' 
            };
        }
    }

    /**
     * 检查当前许可证状态
     */
    static async checkLicenseStatus(): Promise<{ isValid: boolean; needsReverification: boolean; info?: LicenseInfo }> {
        const cachedLicense = await this.getCachedLicense();
        
        if (!cachedLicense) {
            return { isValid: false, needsReverification: false };
        }

        const timeSinceLastVerification = Date.now() - cachedLicense.lastVerified;
        const needsReverification = timeSinceLastVerification > this.VERIFICATION_INTERVAL;

        return {
            isValid: cachedLicense.isValid,
            needsReverification,
            info: cachedLicense
        };
    }

    /**
     * 自动重新验证许可证
     */
    static async autoReverifyIfNeeded(): Promise<boolean> {
        const status = await this.checkLicenseStatus();
        
        if (status.isValid && status.needsReverification && status.info) {
            try {
                const result = await this.verifyLicense(status.info.key);
                return result.isValid;
            } catch (error) {
                console.warn('自动重新验证失败:', error);
                // 验证失败但仍允许使用（宽松策略）
                return true;
            }
        }
        
        return status.isValid;
    }

    /**
     * 保存许可证信息到本地存储
     */
    private static async saveLicenseInfo(licenseInfo: LicenseInfo): Promise<void> {
        try {
            const localFileSystem = storage.localFileSystem;
            const dataFolder = await localFileSystem.getDataFolder();
            const licenseFile = await dataFolder.createFile('license.json', { overwrite: true });
            
            await licenseFile.write(JSON.stringify(licenseInfo), { append: false });
        } catch (error) {
            console.error('保存许可证信息失败:', error);
        }
    }

    /**
     * 从本地存储获取许可证信息
     */
    private static async getCachedLicense(): Promise<LicenseInfo | null> {
        try {
            const localFileSystem = storage.localFileSystem;
            const dataFolder = await localFileSystem.getDataFolder();
            
            try {
                const licenseFile = await dataFolder.getEntry('license.json');
                const content = await licenseFile.read();
                return JSON.parse(content) as LicenseInfo;
            } catch (fileError) {
                // 文件不存在
                return null;
            }
        } catch (error) {
            console.error('读取许可证信息失败:', error);
            return null;
        }
    }

    /**
     * 清除许可证信息
     */
    static async clearLicense(): Promise<void> {
        try {
            const localFileSystem = storage.localFileSystem;
            const dataFolder = await localFileSystem.getDataFolder();
            
            try {
                const licenseFile = await dataFolder.getEntry('license.json');
                await licenseFile.delete();
            } catch (fileError) {
                // 文件不存在，忽略错误
            }
        } catch (error) {
            console.error('清除许可证信息失败:', error);
        }
    }

    /**
     * 生成试用许可证（7天试用）
     */
    static async generateTrialLicense(): Promise<boolean> {
        try {
            // 检查是否已经使用过试用
            const existingTrial = await this.getTrialInfo();
            if (existingTrial) {
                return false; // 已经使用过试用
            }

            const trialInfo = {
                key: 'TRIAL_' + Date.now(),
                userId: 'trial_user',
                expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                isValid: true,
                lastVerified: Date.now()
            };

            await this.saveLicenseInfo(trialInfo);
            await this.saveTrialInfo();
            
            return true;
        } catch (error) {
            console.error('生成试用许可证失败:', error);
            return false;
        }
    }

    /**
     * 检查试用许可证是否过期
     */
    static async isTrialExpired(): Promise<boolean> {
        const license = await this.getCachedLicense();
        if (!license || !license.key.startsWith('TRIAL_')) {
            return false;
        }

        if (license.expiryDate) {
            return new Date() > new Date(license.expiryDate);
        }

        return false;
    }

    /**
     * 保存试用使用记录
     */
    private static async saveTrialInfo(): Promise<void> {
        try {
            const localFileSystem = storage.localFileSystem;
            const dataFolder = await localFileSystem.getDataFolder();
            const trialFile = await dataFolder.createFile('trial.json', { overwrite: true });
            
            await trialFile.write(JSON.stringify({ used: true, date: Date.now() }), { append: false });
        } catch (error) {
            console.error('保存试用信息失败:', error);
        }
    }

    /**
     * 获取试用使用记录
     */
    private static async getTrialInfo(): Promise<any> {
        try {
            const localFileSystem = storage.localFileSystem;
            const dataFolder = await localFileSystem.getDataFolder();
            
            try {
                const trialFile = await dataFolder.getEntry('trial.json');
                const content = await trialFile.read();
                return JSON.parse(content);
            } catch (fileError) {
                return null;
            }
        } catch (error) {
            console.error('读取试用信息失败:', error);
            return null;
        }
    }
}