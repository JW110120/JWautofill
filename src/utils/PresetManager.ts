import { Pattern, Gradient } from '../types/state';

/**
 * 预设管理器，负责持久化存储图案和渐变预设
 */
export class PresetManager {
    private static readonly PATTERN_PRESETS_FILE = 'pattern-presets.json';
    private static readonly GRADIENT_PRESETS_FILE = 'gradient-presets.json';

    /**
     * 获取数据文件夹
     */
    private static async getDataFolder() {
        const localFileSystem = require('uxp').storage.localFileSystem;
        return await localFileSystem.getDataFolder();
    }

    /**
     * 保存图案预设到本地存储
     */
    static async savePatternPresets(patterns: Pattern[]): Promise<void> {
        try {
            const dataFolder = await this.getDataFolder();
            
            // 只保存需要持久化的字段，不保存大的二进制数据和文件引用
            const serializablePatterns = patterns.map(pattern => ({
                id: pattern.id,
                name: pattern.name,
                preview: pattern.preview,
                angle: pattern.angle || 0,
                scale: pattern.scale || 100,
                preserveTransparency: pattern.preserveTransparency || false,
                fillMode: pattern.fillMode || 'stamp',
                rotateAll: pattern.rotateAll || true,
                originalFormat: pattern.originalFormat,
                // 注意：不保存 file, patternRgbData, grayData 等大数据字段
                // 这些需要在用户重新选择文件时重新生成
            }));

            const presetsFile = await dataFolder.createFile(this.PATTERN_PRESETS_FILE, { overwrite: true });
            await presetsFile.write(JSON.stringify(serializablePatterns, null, 2));
            
            console.log('✅ 图案预设已保存', serializablePatterns.length, '个预设');
        } catch (error) {
            console.error('❌ 保存图案预设失败:', error);
        }
    }

    /**
     * 从本地存储加载图案预设
     */
    static async loadPatternPresets(): Promise<Pattern[]> {
        try {
            const dataFolder = await this.getDataFolder();
            const presetsFile = await dataFolder.getEntry(this.PATTERN_PRESETS_FILE);
            
            if (!presetsFile) {
                console.log('📁 图案预设文件不存在，返回空数组');
                return [];
            }

            const content = await presetsFile.read({ format: require('uxp').storage.formats.utf8 });
            const patterns = JSON.parse(content) as Pattern[];
            
            console.log('✅ 图案预设已加载', patterns.length, '个预设');
            return patterns;
        } catch (error) {
            console.error('❌ 加载图案预设失败:', error);
            return [];
        }
    }

    /**
     * 保存渐变预设到本地存储
     */
    static async saveGradientPresets(gradients: Gradient[]): Promise<void> {
        try {
            const dataFolder = await this.getDataFolder();
            
            // 渐变预设相对简单，可以完整保存
            const serializableGradients = gradients.map(gradient => ({
                type: gradient.type,
                angle: gradient.angle || 0,
                reverse: gradient.reverse || false,
                preserveTransparency: gradient.preserveTransparency || false,
                stops: gradient.stops.map(stop => ({
                    color: stop.color,
                    position: stop.position,
                    colorPosition: stop.colorPosition,
                    opacityPosition: stop.opacityPosition,
                    midpoint: stop.midpoint
                }))
            }));

            const presetsFile = await dataFolder.createFile(this.GRADIENT_PRESETS_FILE, { overwrite: true });
            await presetsFile.write(JSON.stringify(serializableGradients, null, 2));
            
            console.log('✅ 渐变预设已保存', serializableGradients.length, '个预设');
        } catch (error) {
            console.error('❌ 保存渐变预设失败:', error);
        }
    }

    /**
     * 从本地存储加载渐变预设
     */
    static async loadGradientPresets(): Promise<Gradient[]> {
        try {
            const dataFolder = await this.getDataFolder();
            const presetsFile = await dataFolder.getEntry(this.GRADIENT_PRESETS_FILE);
            
            if (!presetsFile) {
                console.log('📁 渐变预设文件不存在，返回空数组');
                return [];
            }

            const content = await presetsFile.read({ format: require('uxp').storage.formats.utf8 });
            const gradients = JSON.parse(content) as Gradient[];
            
            console.log('✅ 渐变预设已加载', gradients.length, '个预设');
            return gradients;
        } catch (error) {
            console.error('❌ 加载渐变预设失败:', error);
            return [];
        }
    }

    /**
     * 删除图案预设文件
     */
    static async clearPatternPresets(): Promise<void> {
        try {
            const dataFolder = await this.getDataFolder();
            const presetsFile = await dataFolder.getEntry(this.PATTERN_PRESETS_FILE);
            
            if (presetsFile) {
                await presetsFile.delete();
                console.log('✅ 图案预设文件已删除');
            }
        } catch (error) {
            console.error('❌ 删除图案预设文件失败:', error);
        }
    }

    /**
     * 删除渐变预设文件
     */
    static async clearGradientPresets(): Promise<void> {
        try {
            const dataFolder = await this.getDataFolder();
            const presetsFile = await dataFolder.getEntry(this.GRADIENT_PRESETS_FILE);
            
            if (presetsFile) {
                await presetsFile.delete();
                console.log('✅ 渐变预设文件已删除');
            }
        } catch (error) {
            console.error('❌ 删除渐变预设文件失败:', error);
        }
    }
}