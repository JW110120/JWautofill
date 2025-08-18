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
    // 采用完全离线的本地白名单验证：不再使用任何在线验证地址
    // 为防君子不防小人，做轻度混淆：normalize -> reverse -> 插入盐
    private static readonly OFFLINE_SALT = 'JWAF_SALT_v1';

    // TODO: 将下方示例替换为你实际发放的100个激活码，经 obfuscate 处理后的结果
    // 示例原始激活码（便于你理解和测试）：
    //   JW-AAAA-BBBB-0001
    //   JW-AAAA-BBBB-0002
    //   JW-AAAA-BBBB-0003
    // 你实际发布时，务必将原始码删除，仅保留 OBFUSCATED_CODES 中的混淆结果
    private static readonly OBFUSCATED_CODES: string[] = [
        'GN3R-UMZ9-QK7T-WJ|JWAF_SALT_v1',
        'TQ2M-BHV7-4XPC-WJ|JWAF_SALT_v1',
        'EPD4-SK7Q-R8MZ-WJ|JWAF_SALT_v1',
        'CQK7-UT8X-N5RG-WJ|JWAF_SALT_v1',
        'XQV6-94RT-DM7B-WJ|JWAF_SALT_v1',
        'UM7Z-DRK6-T9QX-WJ|JWAF_SALT_v1',
        'KRT3-XC8P-ZH5V-WJ|JWAF_SALT_v1',
        'DPZ9-VM4K-Q7SN-WJ|JWAF_SALT_v1',
        'CK5M-THV2-X8RQ-WJ|JWAF_SALT_v1',
        'VTQ3-MR8Z-KP7L-WJ|JWAF_SALT_v1',
        'RHZ5-CQ7M-XT9D-WJ|JWAF_SALT_v1',
        'XPZ7-MTQ9-VN4K-WJ|JWAF_SALT_v1',
        'TQ6X-VHK3-RZ8P-WJ|JWAF_SALT_v1',
        'KRP4-MXV9-Q6ST-WJ|JWAF_SALT_v1',
        'TKZ9-DHQ7-XV3M-WJ|JWAF_SALT_v1',
        'VT8X-MHZ5-CQ7R-WJ|JWAF_SALT_v1',
        'RHV7-MXQ2-PK9F-WJ|JWAF_SALT_v1',
        'XPK4-QRM9-ZT6U-WJ|JWAF_SALT_v1',
        'RT7M-VHZ3-KQ8Y-WJ|JWAF_SALT_v1',
        'PKV6-XTQ9-MR5W-WJ|JWAF_SALT_v1',
        'RPV9-MTQ4-XZ7H-WJ|JWAF_SALT_v1',
        'XTV5-RKZ7-DM8Q-WJ|JWAF_SALT_v1',
        'VPK7-MQ8X-RT5Z-WJ|JWAF_SALT_v1',
        'MTZ3-RHV6-XQ9N-WJ|JWAF_SALT_v1',
        'ZRT5-XPQ9-VM7C-WJ|JWAF_SALT_v1',
        'PTM7-ZQV3-RK8X-WJ|JWAF_SALT_v1',
        'XRT4-KMZ6-PQ9V-WJ|JWAF_SALT_v1',
        'XPK7-MVQ8-ZT5R-WJ|JWAF_SALT_v1',
        'MKZ4-RTV9-QX7P-WJ|JWAF_SALT_v1',
        'PXV9-TZK5-QR8M-WJ|JWAF_SALT_v1',
        'VRP5-MXQ7-ZT9K-WJ|JWAF_SALT_v1',
        'KZQ3-PRM9-XV6T-WJ|JWAF_SALT_v1',
        'MVK9-XTZ5-PQ8G-WJ|JWAF_SALT_v1',
        'TKV7-PZQ8-MR6L-WJ|JWAF_SALT_v1',
        'RTV5-MQX9-KP7D-WJ|JWAF_SALT_v1',
        'PRV8-MTZ6-QK9Y-WJ|JWAF_SALT_v1',
        'VTZ5-XPQ9-RM7U-WJ|JWAF_SALT_v1',
        'RVT9-MQK6-XZ8F-WJ|JWAF_SALT_v1',
        'KPZ6-TMR9-QV5H-WJ|JWAF_SALT_v1',
        'KRT9-XVM5-PQ7Z-WJ|JWAF_SALT_v1',
        'MVK7-RPZ8-XT6Q-WJ|JWAF_SALT_v1',
        'PKZ8-VTQ5-MR9X-WJ|JWAF_SALT_v1',
        'XRT6-PMQ9-ZK7V-WJ|JWAF_SALT_v1',
        'XTR5-VKZ7-PQ8N-WJ|JWAF_SALT_v1',
        'VKZ6-MXQ9-RT5P-WJ|JWAF_SALT_v1',
        'XPK8-RTZ5-VQ7M-WJ|JWAF_SALT_v1',
        'TZV9-MRQ6-XP8K-WJ|JWAF_SALT_v1',
        'HVK8-ZXQ5-MR9T-WJ|JWAF_SALT_v1',
        'TPK5-XRM9-QZ7G-WJ|JWAF_SALT_v1',
        'MRT8-PKZ6-VQ9L-WJ|JWAF_SALT_v1',
        'VPK5-XZQ7-RM8D-WJ|JWAF_SALT_v1',
        'MKZ5-RTQ9-XP6Y-WJ|JWAF_SALT_v1',
        'PTK8-ZRM6-VQ9U-WJ|JWAF_SALT_v1',
        'RTZ6-MXQ9-PK7F-WJ|JWAF_SALT_v1',
        'XTK9-VZQ5-MR8H-WJ|JWAF_SALT_v1',
        'XRM5-KVQ9-PT6Z-WJ|JWAF_SALT_v1',
        'PTK9-MRZ5-XV7Q-WJ|JWAF_SALT_v1',
        'RTZ5-VMQ9-PK6X-WJ|JWAF_SALT_v1',
        'PKZ9-TXQ5-MR8V-WJ|JWAF_SALT_v1',
        'MVK5-RTQ8-QZ6N-WJ|JWAF_SALT_v1',
        'TRM8-XZQ6-VK9P-WJ|JWAF_SALT_v1',
        'XTK5-RVZ9-PQ6M-WJ|JWAF_SALT_v1',
        'PTV9-ZXQ5-MR7K-WJ|JWAF_SALT_v1',
        'XVK9-PRM6-ZQ8T-WJ|JWAF_SALT_v1',
        'VTZ8-MRQ5-XP9G-WJ|JWAF_SALT_v1',
        'XRT5-PKZ9-VQ7L-WJ|JWAF_SALT_v1',
        'RVK8-MXQ9-PT6D-WJ|JWAF_SALT_v1',
        'PTZ9-KVQ5-MR7Y-WJ|JWAF_SALT_v1',
        'VTK5-MRZ8-XQ6U-WJ|JWAF_SALT_v1',
        'VKZ8-PTQ6-MR9F-WJ|JWAF_SALT_v1',
        'XTR5-VMZ9-PQ7H-WJ|JWAF_SALT_v1',
        'XTP9-VKQ6-MR8Z-WJ|JWAF_SALT_v1',
        'VKZ6-XRM9-PT5Q-WJ|JWAF_SALT_v1',
        'MRK9-PTZ5-VQ7X-WJ|JWAF_SALT_v1',
        'PKZ5-TXQ9-MR6V-WJ|JWAF_SALT_v1',
        'XTV9-MRZ5-KQ7N-WJ|JWAF_SALT_v1',
        'XVT9-KZQ8-MR6P-WJ|JWAF_SALT_v1',
        'PRT8-VKZ5-XQ9M-WJ|JWAF_SALT_v1',
        'XRZ5-MVQ9-PT6K-WJ|JWAF_SALT_v1',
        'PXV9-ZKQ5-MR7T-WJ|JWAF_SALT_v1',
        'XTR5-PMZ9-VQ6G-WJ|JWAF_SALT_v1',
        'PTK9-VXQ5-MR8L-WJ|JWAF_SALT_v1',
        'VTK8-MRZ6-PQ9D-WJ|JWAF_SALT_v1',
        'VKZ9-MRQ5-PT8Y-WJ|JWAF_SALT_v1',
        'XVT6-KZQ9-MR5U-WJ|JWAF_SALT_v1',
        'MVK5-RTZ9-PQ6F-WJ|JWAF_SALT_v1',
        'PTZ8-VKQ5-MR9H-WJ|JWAF_SALT_v1',
        'XTK8-VRM6-PQ9Z-WJ|JWAF_SALT_v1',
        'VTK5-PZQ8-MR6Q-WJ|JWAF_SALT_v1',
        'RKZ6-MVQ9-PT5X-WJ|JWAF_SALT_v1',
        'XPZ8-KTQ5-MR9V-WJ|JWAF_SALT_v1',
        'VTK6-MRZ9-XQ5N-WJ|JWAF_SALT_v1',
        'XVT9-KZQ6-MR8P-WJ|JWAF_SALT_v1',
        'XTK6-PRZ9-VQ5M-WJ|JWAF_SALT_v1',
        'VTZ8-PXQ6-MR9K-WJ|JWAF_SALT_v1',
        'XRV6-MKZ9-PQ5T-WJ|JWAF_SALT_v1',
        'VKZ9-PTQ6-MR7G-WJ|JWAF_SALT_v1',
        'PTK6-MRZ9-XQ5L-WJ|JWAF_SALT_v1',
        'PTZ9-VKQ6-MR8D-WJ|JWAF_SALT_v1',
        'MVK6-RTZ9-PQ5Y-WJ|JWAF_SALT_v1'
    ];

    // 规范化用户输入：去空格、统一大写
    private static normalize(code: string): string {
        return (code || '').replace(/\s+/g, '').toUpperCase();
    }

    // 轻度混淆：反转 + 附加盐（可替换为你喜欢的简单规则）
    private static obfuscate(code: string): string {
        const normalized = this.normalize(code);
        return normalized.split('').reverse().join('') + '|' + this.OFFLINE_SALT;
    }

    // 广播许可证状态变化，便于跨入口同步
    private static broadcastStatusChanged(): void {
        try {
            document.dispatchEvent(new Event('license-updated'));
        } catch (e) {
            // 在非浏览器环境下忽略
        }
    }

    /**
     * 验证激活码（完全离线，本地白名单）
     */
    static async verifyLicense(licenseKey: string): Promise<{ isValid: boolean; message: string; userInfo?: any }> {
        try {
            const normalized = this.normalize(licenseKey);
            if (!normalized || normalized.length < 6) {
                return { isValid: false, message: '激活码格式不正确' };
            }

            const ob = this.obfuscate(normalized);
            const hit = this.OBFUSCATED_CODES.includes(ob);
            if (!hit) {
                return { isValid: false, message: '激活码无效，请检查输入是否正确' };
            }

            const licenseInfo: LicenseInfo = {
                key: normalized,
                userId: 'offline_user',
                isValid: true,
                lastVerified: Date.now()
            };

            await this.saveLicenseInfo(licenseInfo);
            return { isValid: true, message: '激活成功' };
        } catch (error) {
            console.error('离线激活码验证错误:', error);
            return { isValid: false, message: '验证过程中发生错误，请重试' };
        }
    }

    /**
     * 检查当前许可证状态（离线缓存）
     */
    static async checkLicenseStatus(): Promise<{ isValid: boolean; needsReverification: boolean; info?: LicenseInfo }> {
        const cachedLicense = await this.getCachedLicense();
        if (!cachedLicense) {
            return { isValid: false, needsReverification: false };
        }
        return {
            isValid: cachedLicense.isValid,
            needsReverification: false, // 离线方案无需周期性在线复验
            info: cachedLicense
        };
    }

    /**
     * 自动重新验证（离线模式下直接返回当前缓存状态）
     */
    static async autoReverifyIfNeeded(): Promise<boolean> {
        const status = await this.checkLicenseStatus();
        return !!status.isValid;
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
            this.broadcastStatusChanged();
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
                // 文件不存在，忽略
            }
            this.broadcastStatusChanged();
        } catch (error) {
            console.error('清除许可证信息失败:', error);
        }
    }

    /**
     * 生成试用许可证（7天试用）
     */
    static async generateTrialLicense(): Promise<boolean> {
        try {
            const existingTrial = await this.getTrialInfo();
            if (existingTrial) {
                return false; // 已使用过试用
            }

            const trialInfo: LicenseInfo = {
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

    /** 保存试用使用记录 */
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

    /** 获取试用使用记录 */
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