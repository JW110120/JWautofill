import { Pattern, Gradient } from '../types/state';

/**
 * 预设管理器，负责持久化存储图案和渐变预设
 */
export class PresetManager {
    private static readonly PATTERN_PRESETS_FILE = 'pattern-presets.json';
    private static readonly GRADIENT_PRESETS_FILE = 'gradient-presets.json';

    /**
     * 获取预设保存文件夹（使用UXP数据文件夹）
     */
    private static async getPresetFolder() {
        try {
            // 尝试多种UXP导入方式
            let localFileSystem;
            try {
                // 方式1：直接require
                localFileSystem = require('uxp').storage.localFileSystem;
                console.log('✅ 使用require方式获取localFileSystem');
            } catch (requireError) {
                console.log('⚠️ require方式失败，尝试其他方式:', requireError);
                try {
                    // 方式2：从全局uxp对象获取
                    localFileSystem = (window as any).uxp?.storage?.localFileSystem;
                    if (!localFileSystem) {
                        throw new Error('全局uxp对象中未找到localFileSystem');
                    }
                    console.log('✅ 使用全局uxp对象获取localFileSystem');
                } catch (globalError) {
                    console.log('⚠️ 全局uxp对象方式失败:', globalError);
                    throw new Error('无法获取localFileSystem对象');
                }
            }
            
            // 获取数据文件夹（可写入）
            const dataFolder = await localFileSystem.getDataFolder();
            console.log('📁 数据文件夹路径:', dataFolder.nativePath);
            
            // 在数据文件夹中创建presets子文件夹
            let presetsFolder;
            try {
                presetsFolder = await dataFolder.getEntry('presets');
                console.log('✅ 找到现有的presets文件夹');
            } catch (error) {
                console.log('📁 presets文件夹不存在，正在创建...');
                presetsFolder = await dataFolder.createFolder('presets');
                console.log('✅ 成功创建presets文件夹');
            }
            
            console.log('✅ 预设文件夹路径:', presetsFolder.nativePath);
            return presetsFolder;
        } catch (error) {
            console.error('❌ 获取预设文件夹失败:', error);
            throw error;
        }
    }

    /**
     * 测试文件系统访问权限
     */
    static async testFileSystemAccess(): Promise<boolean> {
        try {
            console.log('🔍 开始测试文件系统访问权限...');
            const presetFolder = await this.getPresetFolder();
            console.log('📁 预设文件夹路径:', presetFolder.nativePath);
            
            // 尝试创建测试文件
            const testFile = await presetFolder.createFile('test-access.txt', { overwrite: true });
            await testFile.write('测试文件系统访问权限');
            
            // 删除测试文件
            await testFile.delete();
            
            console.log('✅ 文件系统访问权限正常');
            return true;
        } catch (error) {
            console.error('❌ 文件系统访问权限测试失败:', error);
            return false;
        }
    }

    /**
     * 测试预设保存功能（用于调试）
     */
    static async testPresetSaving(): Promise<void> {
        console.log('🧪 开始测试预设保存功能...');
        
        // 创建测试图案预设
        const testPatterns = [{
            id: 'test-pattern-1',
            name: '测试图案',
            preview: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            angle: 0,
            scale: 100,
            preserveTransparency: false,
            fillMode: 'stamp' as const,
            rotateAll: true,
            width: 100,
            height: 100
        }];
        
        // 创建测试渐变预设
        const testGradients = [{
            id: 'test-gradient-1',
            name: '测试渐变',
            preview: '',
            type: 'linear' as const,
            angle: 0,
            reverse: false,
            preserveTransparency: false,
            stops: [
                {
                    color: { r: 255, g: 0, b: 0 },
                    position: 0,
                    colorPosition: 0,
                    opacityPosition: 0,
                    midpoint: 50
                },
                {
                    color: { r: 0, g: 0, b: 255 },
                    position: 100,
                    colorPosition: 100,
                    opacityPosition: 100,
                    midpoint: 50
                }
            ]
        }];
        
        try {
            // 测试保存图案预设
            console.log('🔄 测试保存图案预设...');
            await this.savePatternPresets(testPatterns);
            
            // 测试保存渐变预设
            console.log('🔄 测试保存渐变预设...');
            await this.saveGradientPresets(testGradients);
            
            // 测试加载预设
            console.log('🔄 测试加载预设...');
            const loadedPatterns = await this.loadPatternPresets();
            const loadedGradients = await this.loadGradientPresets();
            
            console.log('✅ 预设保存测试完成');
            console.log('📊 加载的图案预设数量:', loadedPatterns.length);
            console.log('📊 加载的渐变预设数量:', loadedGradients.length);
            
        } catch (error) {
            console.error('❌ 预设保存测试失败:', error);
        }
    }

    /**
     * 强制保存所有预设（用于应用关闭前的紧急保存）
     */
    static async forceSaveAllPresets(patterns: Pattern[], gradients: Gradient[]): Promise<void> {
        console.log('🚨 强制保存所有预设...');
        
        const savePromises: Promise<void>[] = [];
        
        // 并行保存图案和渐变预设
        if (patterns && patterns.length > 0) {
            savePromises.push(this.savePatternPresets(patterns));
        }
        
        if (gradients && gradients.length > 0) {
            savePromises.push(this.saveGradientPresets(gradients));
        }
        
        try {
            // 等待所有保存操作完成，设置超时时间
            await Promise.race([
                Promise.all(savePromises),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('保存超时')), 10000)
                )
            ]);
            console.log('✅ 强制保存完成');
        } catch (error) {
            console.error('❌ 强制保存失败:', error);
            // 即使失败也不抛出异常，避免阻塞应用关闭
        }
    }

    /**
     * 检查预设文件完整性
     */
    static async verifyPresetFiles(): Promise<{ patterns: boolean; gradients: boolean }> {
        try {
            const presetFolder = await this.getPresetFolder();
            const result = { patterns: false, gradients: false };
            
            // 检查图案预设文件
            try {
                const patternFile = await presetFolder.getEntry(this.PATTERN_PRESETS_FILE);
                if (patternFile) {
                    const content = await patternFile.read({ format: require('uxp').storage.formats.utf8 });
                    const data = JSON.parse(content);
                    result.patterns = Array.isArray(data);
                }
            } catch (error) {
                console.warn('⚠️ 图案预设文件检查失败:', error);
            }
            
            // 检查渐变预设文件
            try {
                const gradientFile = await presetFolder.getEntry(this.GRADIENT_PRESETS_FILE);
                if (gradientFile) {
                    const content = await gradientFile.read({ format: require('uxp').storage.formats.utf8 });
                    const data = JSON.parse(content);
                    result.gradients = Array.isArray(data);
                }
            } catch (error) {
                console.warn('⚠️ 渐变预设文件检查失败:', error);
            }
            
            return result;
        } catch (error) {
            console.error('❌ 预设文件完整性检查失败:', error);
            return { patterns: false, gradients: false };
        }
    }

    /**
     * 将Uint8Array转换为Base64字符串
     */
    private static uint8ArrayToBase64(uint8Array: Uint8Array): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let result = '';
        let i = 0;
        const len = uint8Array.length;
        
        while (i < len) {
            const a = uint8Array[i++];
            const b = i < len ? uint8Array[i++] : 0;
            const c = i < len ? uint8Array[i++] : 0;
            
            const bitmap = (a << 16) | (b << 8) | c;
            
            result += chars.charAt((bitmap >> 18) & 63);
            result += chars.charAt((bitmap >> 12) & 63);
            result += i - 2 < len ? chars.charAt((bitmap >> 6) & 63) : '=';
            result += i - 1 < len ? chars.charAt(bitmap & 63) : '=';
        }
        
        return result;
    }

    /**
     * 将Base64字符串转换为Uint8Array
     */
    private static base64ToUint8Array(base64: string): Uint8Array {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let result = '';
        let i = 0;
        
        base64 = base64.replace(/[^A-Za-z0-9+/]/g, '');
        
        while (i < base64.length) {
            const encoded1 = chars.indexOf(base64.charAt(i++));
            const encoded2 = chars.indexOf(base64.charAt(i++));
            const encoded3 = chars.indexOf(base64.charAt(i++));
            const encoded4 = chars.indexOf(base64.charAt(i++));
            
            const bitmap = (encoded1 << 18) | (encoded2 << 12) | (encoded3 << 6) | encoded4;
            
            result += String.fromCharCode((bitmap >> 16) & 255);
            if (encoded3 !== 64) result += String.fromCharCode((bitmap >> 8) & 255);
            if (encoded4 !== 64) result += String.fromCharCode(bitmap & 255);
        }
        
        const bytes = new Uint8Array(result.length);
        for (let j = 0; j < result.length; j++) {
            bytes[j] = result.charCodeAt(j);
        }
        
        return bytes;
    }

    /**
     * 将ArrayBuffer转换为Base64字符串
     */
    private static arrayBufferToBase64(buffer: ArrayBuffer): string {
        return this.uint8ArrayToBase64(new Uint8Array(buffer));
    }

    /**
     * 将Base64字符串转换为ArrayBuffer
     */
    private static base64ToArrayBuffer(base64: string): ArrayBuffer {
        const uint8Array = this.base64ToUint8Array(base64);
        return uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength);
    }

    /**
     * 保存图案预设到本地存储（包含完整数据）
     */
    static async savePatternPresets(patterns: Pattern[]): Promise<void> {
        // 防止空数组或无效数据的保存
        if (!Array.isArray(patterns)) {
            console.warn('⚠️ 图案预设数据无效，跳过保存');
            return;
        }

        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                console.log(`🔄 开始保存图案预设 (尝试 ${retryCount + 1}/${maxRetries})，共 ${patterns.length} 个预设`);
                const presetFolder = await this.getPresetFolder();
                console.log('📁 预设文件夹获取成功，路径:', presetFolder.nativePath);
                
                // 保存完整的图案数据，包括二进制数据
                const serializablePatterns = patterns.map(pattern => {
                    const serialized: any = {
                        id: pattern.id,
                        name: pattern.name,
                        preview: pattern.preview,
                        angle: pattern.angle || 0,
                        scale: pattern.scale || 100,
                        preserveTransparency: pattern.preserveTransparency || false,
                        fillMode: pattern.fillMode || 'stamp',
                        rotateAll: pattern.rotateAll || true,
                        originalFormat: pattern.originalFormat,
                        // 保存尺寸信息
                        width: pattern.width,
                        height: pattern.height,
                        originalWidth: pattern.originalWidth,
                        originalHeight: pattern.originalHeight,
                        currentScale: pattern.currentScale,
                        currentAngle: pattern.currentAngle,
                        // 保存组件信息
                        patternComponents: pattern.patternComponents,
                        components: pattern.components,
                        hasAlpha: pattern.hasAlpha,
                        // 添加保存时间戳
                        savedAt: new Date().toISOString()
                    };

                    // 保存二进制数据（Base64编码）
                    try {
                        if (pattern.data) {
                            serialized.dataBase64 = this.arrayBufferToBase64(pattern.data);
                        }
                        if (pattern.patternRgbData) {
                            serialized.patternRgbDataBase64 = this.uint8ArrayToBase64(pattern.patternRgbData);
                        }
                        if (pattern.grayData) {
                            serialized.grayDataBase64 = this.uint8ArrayToBase64(pattern.grayData);
                        }
                        if (pattern.originalGrayData) {
                            serialized.originalGrayDataBase64 = this.uint8ArrayToBase64(pattern.originalGrayData);
                        }
                    } catch (encodeError) {
                        console.error('❌ 编码图案二进制数据失败:', pattern.name, encodeError);
                        // 即使二进制数据编码失败，也保存其他数据
                    }

                    return serialized;
                });

                // 创建临时文件名，确保原子性写入
                const tempFileName = `${this.PATTERN_PRESETS_FILE}.tmp`;
                console.log('📝 创建临时文件:', tempFileName);
                const tempFile = await presetFolder.createFile(tempFileName, { overwrite: true });
                console.log('✅ 临时文件创建成功:', tempFile.nativePath);
                
                // 验证JSON数据有效性
                const jsonData = JSON.stringify(serializablePatterns, null, 2);
                console.log('🔍 验证JSON数据有效性...');
                try {
                    JSON.parse(jsonData);
                    console.log('✅ JSON数据验证通过');
                } catch (jsonError) {
                    console.error('❌ JSON数据无效:', jsonError);
                    throw new Error(`JSON数据格式错误: ${jsonError.message}`);
                }
                
                // 写入数据到临时文件
                console.log('💾 开始写入数据，大小:', jsonData.length, '字符');
                await tempFile.write(jsonData);
                console.log('✅ 数据写入完成');
                
                // 验证写入的文件内容
                console.log('🔍 验证写入的文件内容...');
                const writtenContent = await tempFile.read({ format: require('uxp').storage.formats.utf8 });
                try {
                    JSON.parse(writtenContent);
                    console.log('✅ 写入文件内容验证通过');
                } catch (verifyError) {
                    console.error('❌ 写入文件内容验证失败:', verifyError);
                    throw new Error(`写入文件内容无效: ${verifyError.message}`);
                }
                
                // 验证写入的数据
                const verifyContent = await tempFile.read({ format: require('uxp').storage.formats.utf8 });
                const verifyData = JSON.parse(verifyContent);
                
                if (verifyData.length !== serializablePatterns.length) {
                    throw new Error('数据验证失败：保存的预设数量不匹配');
                }
                
                // 使用更安全的文件替换策略
                const finalFileName = this.PATTERN_PRESETS_FILE;
                const backupFileName = `${this.PATTERN_PRESETS_FILE}.backup`;
                
                // 如果目标文件存在，先备份
                try {
                    const existingFile = await presetFolder.getEntry(finalFileName);
                    if (existingFile) {
                        console.log('📋 备份现有文件...');
                        // 删除旧备份（如果存在）
                        try {
                            const oldBackup = await presetFolder.getEntry(backupFileName);
                            await oldBackup.delete();
                        } catch (e) { /* 忽略备份文件不存在的错误 */ }
                        
                        // 创建备份
                        await existingFile.moveTo(presetFolder, backupFileName);
                        console.log('✅ 现有文件已备份');
                    }
                } catch (e) {
                    console.log('ℹ️ 目标文件不存在，无需备份');
                }
                
                // 重命名临时文件为正式文件
                console.log('🔄 重命名临时文件为正式文件:', finalFileName);
                await tempFile.moveTo(presetFolder, finalFileName);
                console.log('✅ 文件重命名成功');
                
                // 验证最终文件是否存在
                const finalFile = await presetFolder.getEntry(this.PATTERN_PRESETS_FILE);
                console.log('🔍 验证最终文件:', finalFile.nativePath);
                
                console.log('✅ 图案预设已保存（完整数据）', serializablePatterns.length, '个预设');
                return; // 成功保存，退出重试循环
                
            } catch (error) {
                retryCount++;
                console.error(`❌ 保存图案预设失败 (尝试 ${retryCount}/${maxRetries}):`, error);
                
                if (retryCount >= maxRetries) {
                    console.error('❌ 图案预设保存失败，已达到最大重试次数');
                    throw error;
                }
                
                // 等待一段时间后重试
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }
    }

    /**
     * 从本地存储加载图案预设（恢复完整数据）
     */
    static async loadPatternPresets(): Promise<Pattern[]> {
        try {
            const presetFolder = await this.getPresetFolder();
            const presetsFile = await presetFolder.getEntry(this.PATTERN_PRESETS_FILE);
            
            if (!presetsFile) {
                console.log('📁 图案预设文件不存在，返回空数组');
                return [];
            }

            const content = await presetsFile.read({ format: require('uxp').storage.formats.utf8 });
            const serializedPatterns = JSON.parse(content);
            
            // 恢复完整的图案数据，包括二进制数据
            const patterns: Pattern[] = serializedPatterns.map((serialized: any) => {
                const pattern: Pattern = {
                    id: serialized.id,
                    name: serialized.name,
                    preview: serialized.preview,
                    angle: serialized.angle || 0,
                    scale: serialized.scale || 100,
                    preserveTransparency: serialized.preserveTransparency || false,
                    fillMode: serialized.fillMode || 'stamp',
                    rotateAll: serialized.rotateAll !== undefined ? serialized.rotateAll : true,
                    originalFormat: serialized.originalFormat,
                    // 恢复尺寸信息
                    width: serialized.width,
                    height: serialized.height,
                    originalWidth: serialized.originalWidth,
                    originalHeight: serialized.originalHeight,
                    currentScale: serialized.currentScale,
                    currentAngle: serialized.currentAngle,
                    // 恢复组件信息
                    patternComponents: serialized.patternComponents,
                    components: serialized.components,
                    hasAlpha: serialized.hasAlpha
                };

                // 恢复二进制数据
                try {
                    if (serialized.dataBase64) {
                        pattern.data = this.base64ToArrayBuffer(serialized.dataBase64);
                    }
                    if (serialized.patternRgbDataBase64) {
                        pattern.patternRgbData = this.base64ToUint8Array(serialized.patternRgbDataBase64);
                    }
                    if (serialized.grayDataBase64) {
                        pattern.grayData = this.base64ToUint8Array(serialized.grayDataBase64);
                    }
                    if (serialized.originalGrayDataBase64) {
                        pattern.originalGrayData = this.base64ToUint8Array(serialized.originalGrayDataBase64);
                    }
                } catch (error) {
                    console.error('恢复图案二进制数据失败:', pattern.name, error);
                }

                return pattern;
            });
            
            console.log('✅ 图案预设已加载（完整数据）', patterns.length, '个预设');
            return patterns;
        } catch (error) {
            console.error('❌ 加载图案预设失败:', error);
            return [];
        }
    }

    /**
     * 保存渐变预设到本地存储（完整保存所有字段）
     */
    static async saveGradientPresets(gradients: (Gradient & { id?: string; name?: string; preview?: string })[]): Promise<void> {
        // 防止空数组或无效数据的保存
        if (!Array.isArray(gradients)) {
            console.warn('⚠️ 渐变预设数据无效，跳过保存');
            return;
        }

        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                console.log(`🔄 开始保存渐变预设 (尝试 ${retryCount + 1}/${maxRetries})，共 ${gradients.length} 个预设`);
                const presetFolder = await this.getPresetFolder();
                console.log('📁 预设文件夹获取成功，路径:', presetFolder.nativePath);
                
                // 保存完整的渐变预设数据，包括id、name和preview
                const serializableGradients = gradients.map((gradient, index) => ({
                    // 添加唯一标识和名称字段
                    id: gradient.id || `gradient_${Date.now()}_${index}`,
                    name: gradient.name || `渐变预设 ${index + 1}`,
                    preview: gradient.preview || '', // 预览图标识
                    // 原有渐变数据
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
                    })),
                    // 保存预设列表（如果存在）
                    presets: gradient.presets ? gradient.presets.map(preset => ({
                        preview: preset.preview,
                        type: preset.type,
                        angle: preset.angle,
                        reverse: preset.reverse,
                        stops: preset.stops.map(stop => ({
                            color: stop.color,
                            position: stop.position,
                            colorPosition: stop.colorPosition,
                            opacityPosition: stop.opacityPosition,
                            midpoint: stop.midpoint
                        }))
                    })) : undefined,
                    // 添加保存时间戳
                    savedAt: new Date().toISOString()
                }));

                // 创建临时文件名，确保原子性写入
                const tempFileName = `${this.GRADIENT_PRESETS_FILE}.tmp`;
                console.log('📝 创建临时文件:', tempFileName);
                const tempFile = await presetFolder.createFile(tempFileName, { overwrite: true });
                console.log('✅ 临时文件创建成功:', tempFile.nativePath);
                
                // 验证JSON数据有效性
                const jsonData = JSON.stringify(serializableGradients, null, 2);
                console.log('🔍 验证JSON数据有效性...');
                try {
                    JSON.parse(jsonData);
                    console.log('✅ JSON数据验证通过');
                } catch (jsonError) {
                    console.error('❌ JSON数据无效:', jsonError);
                    throw new Error(`JSON数据格式错误: ${jsonError.message}`);
                }
                
                // 写入数据到临时文件
                console.log('💾 开始写入数据，大小:', jsonData.length, '字符');
                await tempFile.write(jsonData);
                console.log('✅ 数据写入完成');
                
                // 验证写入的文件内容
                console.log('🔍 验证写入的文件内容...');
                const writtenContent = await tempFile.read({ format: require('uxp').storage.formats.utf8 });
                try {
                    JSON.parse(writtenContent);
                    console.log('✅ 写入文件内容验证通过');
                } catch (verifyError) {
                    console.error('❌ 写入文件内容验证失败:', verifyError);
                    throw new Error(`写入文件内容无效: ${verifyError.message}`);
                }
                
                // 验证写入的数据
                const verifyContent = await tempFile.read({ format: require('uxp').storage.formats.utf8 });
                const verifyData = JSON.parse(verifyContent);
                
                if (verifyData.length !== serializableGradients.length) {
                    throw new Error('数据验证失败：保存的渐变预设数量不匹配');
                }
                
                // 使用更安全的文件替换策略
                const finalFileName = this.GRADIENT_PRESETS_FILE;
                const backupFileName = `${this.GRADIENT_PRESETS_FILE}.backup`;
                
                // 如果目标文件存在，先备份
                try {
                    const existingFile = await presetFolder.getEntry(finalFileName);
                    if (existingFile) {
                        console.log('📋 备份现有文件...');
                        // 删除旧备份（如果存在）
                        try {
                            const oldBackup = await presetFolder.getEntry(backupFileName);
                            await oldBackup.delete();
                        } catch (e) { /* 忽略备份文件不存在的错误 */ }
                        
                        // 创建备份
                        await existingFile.moveTo(presetFolder, backupFileName);
                        console.log('✅ 现有文件已备份');
                    }
                } catch (e) {
                    console.log('ℹ️ 目标文件不存在，无需备份');
                }
                
                // 重命名临时文件为正式文件
                console.log('🔄 重命名临时文件为正式文件:', finalFileName);
                await tempFile.moveTo(presetFolder, finalFileName);
                console.log('✅ 文件重命名成功');
                
                // 验证最终文件是否存在
                const finalFile = await presetFolder.getEntry(this.GRADIENT_PRESETS_FILE);
                console.log('🔍 验证最终文件:', finalFile.nativePath);
                
                console.log('✅ 渐变预设已保存（完整数据）', serializableGradients.length, '个预设');
                return; // 成功保存，退出重试循环
                
            } catch (error) {
                retryCount++;
                console.error(`❌ 保存渐变预设失败 (尝试 ${retryCount}/${maxRetries}):`, error);
                
                if (retryCount >= maxRetries) {
                    console.error('❌ 渐变预设保存失败，已达到最大重试次数');
                    throw error;
                }
                
                // 等待一段时间后重试
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }
    }

    /**
     * 从本地存储加载渐变预设（恢复完整数据）
     */
    static async loadGradientPresets(): Promise<(Gradient & { id: string; name: string; preview?: string })[]> {
        try {
            const presetFolder = await this.getPresetFolder();
            const presetsFile = await presetFolder.getEntry(this.GRADIENT_PRESETS_FILE);
            
            if (!presetsFile) {
                console.log('📁 渐变预设文件不存在，返回空数组');
                return [];
            }

            const content = await presetsFile.read({ format: require('uxp').storage.formats.utf8 });
            const serializedGradients = JSON.parse(content);
            
            // 恢复完整的渐变数据，确保包含所有必要字段
            const gradients = serializedGradients.map((serialized: any, index: number) => ({
                // 恢复标识和名称字段
                id: serialized.id || `gradient_${Date.now()}_${index}`,
                name: serialized.name || `渐变预设 ${index + 1}`,
                preview: serialized.preview || '',
                // 恢复渐变数据
                type: serialized.type || 'linear',
                angle: serialized.angle || 0,
                reverse: serialized.reverse || false,
                preserveTransparency: serialized.preserveTransparency || false,
                stops: (serialized.stops || []).map((stop: any) => ({
                    color: stop.color || '#000000',
                    position: stop.position || 0,
                    colorPosition: stop.colorPosition,
                    opacityPosition: stop.opacityPosition,
                    midpoint: stop.midpoint
                })),
                // 恢复预设列表（如果存在）
                presets: serialized.presets ? serialized.presets.map((preset: any) => ({
                    preview: preset.preview || '',
                    type: preset.type || 'linear',
                    angle: preset.angle || 0,
                    reverse: preset.reverse || false,
                    stops: (preset.stops || []).map((stop: any) => ({
                        color: stop.color || '#000000',
                        position: stop.position || 0,
                        colorPosition: stop.colorPosition,
                        opacityPosition: stop.opacityPosition,
                        midpoint: stop.midpoint
                    }))
                })) : undefined
            }));
            
            console.log('✅ 渐变预设已加载（完整数据）', gradients.length, '个预设');
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
            const presetFolder = await this.getPresetFolder();
            const presetsFile = await presetFolder.getEntry(this.PATTERN_PRESETS_FILE);
            
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
            const presetFolder = await this.getPresetFolder();
            const presetsFile = await presetFolder.getEntry(this.GRADIENT_PRESETS_FILE);
            
            if (presetsFile) {
                await presetsFile.delete();
                console.log('✅ 渐变预设文件已删除');
            }
        } catch (error) {
            console.error('❌ 删除渐变预设文件失败:', error);
        }
    }
}