import { storage } from 'uxp';

export interface LicenseInfo {
    key: string;
    userId: string;
    expiryDate?: string;
    isValid: boolean;
    lastVerified: number;
}

/** 统一授权状态（getLicenseState 的返回结构） */
export interface LicenseState {
    isLicensed: boolean;
    isTrial: boolean;
    trialDaysRemaining: number;
    expired: boolean;
    needsReverification: boolean;
}

export class LicenseManager {
    private static readonly STORAGE_KEY = 'jwautofill_license';
    // 采用完全离线的本地白名单验证：不再使用任何在线验证地址
    // 为防君子不防小人，做轻度混淆：normalize -> reverse -> 插入盐
    private static readonly OFFLINE_SALT = 'JWAF_SALT_v1';

    /*
     * getLicenseState 的记忆化缓存：主面板与绘画工具箱同文档同 bundle、共享同一 JS 上下文，
     * 并发调用共享同一个 Promise —— 两面板在同一 tick 拿到同一份结果，
     * 激活弹窗与工具箱锁定遮罩因此能同刻出现（而不是各自读一遍文件、先后出现）。
     * 保存/清除许可证时必须置空缓存（见 saveLicenseInfo / clearLicense）。
     */
    private static stateCache: Promise<LicenseState> | null = null;

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
     * 统一的授权状态判定 —— 全局唯一事实来源（带记忆化，见 stateCache 注释）。
     *
     * 规则：
     * - key 以 `TRIAL_` 开头 → 一律视为「试用」，永不构成正式授权（试用过期则视为失效）
     * - 其它 key 且缓存 isValid === true → 正式授权
     *
     * 背景（2026-08-31 bug）：试用许可证落盘时同样写入 `isValid: true`，
     * 若调用方只取 `status.isValid` 就会把「试用」误判成「已激活」，
     * 表现就是重载后「注销激活状态」菜单项在试用态下仍可点击。
     * 因此 app.tsx（主面板）与 AdjustmentPanel.tsx（选区填充面板）
     * 必须共用此方法，禁止各自再写一遍判定逻辑。
     */
    static getLicenseState(): Promise<LicenseState> {
        if (!this.stateCache) {
            this.stateCache = this.computeLicenseState();
        }
        return this.stateCache;
    }

    private static async computeLicenseState(): Promise<LicenseState> {
        const fallback = { isLicensed: false, isTrial: false, trialDaysRemaining: 0, expired: false, needsReverification: false };
        try {
            /*
             * 仅一次文件读取：主面板与绘画工具箱共享此 Promise（见 stateCache），
             * 谁先发起谁付这次 I/O 的代价，另一方同 tick 拿到同一结果。
             * ⚠️ 早期实现里 compute 先 checkLicenseStatus() 读一遍、再 isTrialExpired()
             *    读第二遍（共两次本地文件读取），把异步延迟翻倍，导致工具箱遮罩比主面板
             *    弹窗明显晚出现。现改为只读一次，过期判断用本次读到的 cachedInfo 内联计算。
             */
            const cachedInfo: any = await this.getCachedLicense();
            const key = cachedInfo && cachedInfo.key ? String(cachedInfo.key) : '';
            const isTrialKey = key.startsWith('TRIAL_');

            // 只有 TRIAL_ 才带 expiryDate，故过期判断只对试用生效（用本次已读到的 cachedInfo 内联算）
            const expired = isTrialKey && !!cachedInfo && !!cachedInfo.expiryDate
                ? new Date() > new Date(cachedInfo.expiryDate)
                : false;

            let trialDaysRemaining = 0;
            if (isTrialKey && cachedInfo && cachedInfo.expiryDate) {
                const expire = new Date(cachedInfo.expiryDate).getTime();
                trialDaysRemaining = Math.max(0, Math.ceil((expire - Date.now()) / (24 * 60 * 60 * 1000)));
            }

            return {
                // 离线方案无需周期性在线复验：needsReverification 恒 false
                isLicensed: !!cachedInfo && cachedInfo.isValid === true && !isTrialKey && !expired,
                isTrial: isTrialKey && !expired,
                trialDaysRemaining,
                expired,
                needsReverification: false
            };
        } catch (error) {
            console.error('读取授权状态失败:', error);
            return fallback;
        }
    }

    /**
     * 保存许可证信息到本地存储
     *
     * ⚠️ 这里【不】广播 license-updated（2026-08-31 定稿）：
     * 激活/试用成功后主面板弹窗还要停留 800ms 展示「激活成功！」，
     * 若保存瞬间就广播，绘画工具箱会比弹窗关闭早 800ms 解锁——两遮罩不同步。
     * 广播时机统一改到主面板弹窗关闭那一刻（app.tsx handleLicenseVerified /
     * handleTrialStarted 里 dispatch）。这里只做缓存失效，保证下次读取拿到新状态。
     */
    private static async saveLicenseInfo(licenseInfo: LicenseInfo): Promise<void> {
        try {
            const localFileSystem = storage.localFileSystem;
            const dataFolder = await localFileSystem.getDataFolder();
            const licenseFile = await dataFolder.createFile('license.json', { overwrite: true });
            await licenseFile.write(JSON.stringify(licenseInfo), { append: false });
            this.stateCache = null;
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
     *
     * 注销时立即广播：主面板弹窗与工具箱锁定遮罩在同一 tick 出现，天然同步。
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
            this.stateCache = null;
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