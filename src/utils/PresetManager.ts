import { Pattern, Gradient } from '../types/state';

/**
 * 预设管理器，负责持久化存储图案和渐变预设
 */
export class PresetManager {
    private static readonly PATTERN_PRESETS_FILE = 'pattern-presets.json';
    private static readonly GRADIENT_PRESETS_FILE = 'gradient-presets.json';
    // 用于串行化渐变保存，避免并发写入导致竞争
    private static gradientSavePromise: Promise<void> | null = null;
    // 记录上次成功保存的渐变JSON，用于避免不必要的重复写入
    private static lastGradientJson: string | null = null;
    // 用于串行化图案保存，避免并发写入导致竞争
    private static patternSavePromise: Promise<void> | null = null;
    // 记录上次成功保存的图案JSON，用于避免不必要的重复写入
    private static lastPatternJson: string | null = null;
    // ⚡ 每图案序列化片段缓存：key = pattern 对象，值 = { sig 内容签名, frag JSON片段 }。
    // 保存时签名一致就直接复用上次编码好的 JSON 片段，跳过 4 块二进制数据的
    // base64 全量重编——拖拽排序等只改顺序的保存从"秒级"降到"毫秒级"。
    private static patternFragCache = new WeakMap<object, { sig: string; frag: string }>();

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
     * 把 entry 移动到 targetFolder 并改名为 newName（同名已存在时覆盖）。
     *
     * ⛔⛔ UXP 的 `Entry.moveTo(folder, options)` 第二个参数是**选项对象**
     *   `{ newName?: string; overwrite?: boolean }`，**不是**文件名字符串。
     *   传字符串时 UXP 的原生绑定会严格校验并抛错（Argument 2 has an invalid type），
     *   而调用点又普遍包在 `try { … } catch (_) {}` 里 ⇒ 错误被静默吞掉、移动从未发生。
     *
     *   2026-10-10「图案预设只剩 .tmp、正式文件消失」事故的根因就在此：
     *   ① 备份步 `existingFile.moveTo(folder, '…backup')` 抛错被外层 catch 吞掉
     *      ⇒ 原始数据没有被备份走；
     *   ② 替换步 `tempFile.moveTo(folder, '…json')` 抛错 → 兜底分支 `getEntry(正式文件)`
     *      取到**仍在原处**的正式文件并 `delete()` 掉 → 重试 moveTo 再次抛错
     *      ⇒ 正式文件已被删除、.backup 从未生成、只剩一个 .tmp，数据永久丢失。
     *   渐变面板同样写错签名，只是它有 `createFile+write` 兜底才「看起来正常」。
     *   统一走本方法（带 overwrite ⇒ 目标残留也能直接覆盖，无需「先删目标再重试」），
     *   杜绝再次写错签名。
     */
    private static async moveEntryTo(entry: any, targetFolder: any, newName: string): Promise<void> {
        await entry.moveTo(targetFolder, { newName, overwrite: true });
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
     * ⚡ 性能关键路径：直接从字节数组编码（省掉中间二进制串），输出端用
     * number[] 累积字符码 + 每 0x8000 一次 fromCharCode.apply——全程只有
     * 几百次大字符串追加，杜绝旧实现逐字符/逐 3 字节向大字符串 += 的
     * 百万次拼接（UXP 引擎下即分钟级卡顿）。
     */
    private static uint8ArrayToBase64(uint8Array: Uint8Array): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const len = uint8Array.length;
        const charCodes = new Array<number>(64);
        for (let k = 0; k < 64; k++) charCodes[k] = chars.charCodeAt(k);
        const PAD = 61; // '='

        let result = '';
        let acc: number[] = [];
        for (let i = 0; i < len; i += 3) {
            const a = uint8Array[i];
            const b = i + 1 < len ? uint8Array[i + 1] : 0;
            const c = i + 2 < len ? uint8Array[i + 2] : 0;
            const bitmap = (a << 16) | (b << 8) | c;
            acc.push(
                charCodes[(bitmap >> 18) & 63],
                charCodes[(bitmap >> 12) & 63],
                i + 1 < len ? charCodes[(bitmap >> 6) & 63] : PAD,
                i + 2 < len ? charCodes[bitmap & 63] : PAD
            );
            if (acc.length >= 0x8000) {
                result += String.fromCharCode.apply(null, acc as unknown as number[]);
                acc = [];
            }
        }
        if (acc.length > 0) {
            result += String.fromCharCode.apply(null, acc as unknown as number[]);
        }
        return result;
    }

    // base64 → 字节值查找表（懒初始化；避免旧实现每字符对 64 字符串做 indexOf 线性扫描）
    private static b64Lookup: Uint8Array | null = null;
    private static getB64Lookup(): Uint8Array {
        if (!this.b64Lookup) {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
            const table = new Uint8Array(128).fill(255);
            for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
            this.b64Lookup = table;
        }
        return this.b64Lookup;
    }

    /**
     * 将Base64字符串转换为Uint8Array（位缓冲单趟解码，替代旧版逐组 indexOf 扫描）
     */
    private static base64ToUint8Array(base64: string): Uint8Array {
        const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
        const table = this.getB64Lookup();
        const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4));
        let out = 0;
        let buffer = 0;
        let bits = 0;

        for (let i = 0; i < clean.length; i++) {
            const v = table[clean.charCodeAt(i) & 0x7f];
            if (v === 255) continue;
            buffer = (buffer << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                bytes[out++] = (buffer >> bits) & 0xff;
            }
        }

        return out === bytes.length ? bytes : bytes.subarray(0, out);
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
     * ⚡ 单图案内容签名：覆盖所有被序列化的字段（全部 O(1)，只读标量与 length）。
     * 保存与加载共用——加载时用文件里现成的 base64 字符串回填片段缓存并预热
     * 去重基线，避免重载后的首次自动保存把几 MB 二进制全部重编一遍。
     */
    private static patternSignature(pattern: Pattern): string {
        return [
            pattern.id, pattern.name, pattern.angle, pattern.scale,
            pattern.preserveTransparency, pattern.fillMode, pattern.rotateAll,
            pattern.originalFormat,
            pattern.width, pattern.height,
            pattern.originalWidth, pattern.originalHeight,
            pattern.currentScale, pattern.currentAngle,
            pattern.patternComponents, pattern.components, pattern.hasAlpha,
            pattern.preview ? pattern.preview.length : 0,
            pattern.data ? pattern.data.byteLength : 0,
            pattern.patternRgbData ? pattern.patternRgbData.length : 0,
            pattern.grayData ? pattern.grayData.length : 0,
            pattern.originalGrayData ? pattern.originalGrayData.length : 0,
        ].join('|');
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
        // 避免将空数组写入文件导致下次启动回退到默认预设
        if (patterns.length === 0) {
            console.warn('⚠️ 图案预设为空，跳过保存以避免覆盖默认预设');
            return;
        }

        // 串行化保存，确保前一次保存完成
        if (this.patternSavePromise) {
            try { await this.patternSavePromise; } catch (_) { /* 忽略前一次失败，仅确保顺序 */ }
        }

        let retryCount = 0;
        const maxRetries = 3;

        // 当前保存的Promise占位，便于后续调用等待
        let currentResolve: (() => void) | null = null;
        let currentReject: ((e: any) => void) | null = null;
        this.patternSavePromise = new Promise<void>((resolve, reject) => {
            currentResolve = resolve;
            currentReject = reject;
        });
        
        while (retryCount < maxRetries) {
            try {
                const presetFolder = await this.getPresetFolder();

                // 保存完整的图案数据，包括二进制数据（移除易变字段以便去重判断）。
                // ⚡ 先算内容签名（全部 O(1)，只读 length/标量），命中缓存即复用片段，
                // 不再重新 base64 编码几 MB 的二进制——拖拽排序只改顺序，理应零编码。
                // 签名覆盖所有被序列化的字段（含各缓冲区 length 与 preview 长度），
                // 对象被原地改写导致任一字段变化时签名失配，自动重新编码，不会存脏数据。
                const fragments = patterns.map(pattern => {
                    const sig = this.patternSignature(pattern);
                    const cached = this.patternFragCache.get(pattern);
                    if (cached && cached.sig === sig) return cached.frag;

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
                        hasAlpha: pattern.hasAlpha
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

                    const frag = JSON.stringify(serialized);
                    this.patternFragCache.set(pattern, { sig, frag });
                    return frag;
                });

                // 待写入的JSON（不 pretty-print；片段按序拼装，输出与整表 stringify 完全一致）
                const jsonData = '[' + fragments.join(',') + ']';

                // ⚡ 内容与上次成功写入一致 → 零 I/O 直接返回。
                // 30s 定时保存 / 多个 effect 重复触发时全部从这里短路，不再做任何文件读写。
                if (this.lastPatternJson === jsonData) {
                    currentResolve && currentResolve();
                    this.patternSavePromise = null;
                    return;
                }

                // ⛔⛔ 必须「先写临时文件、再原子替换」，禁止直接 createFile(overwrite) 写正式文件。
                //   2026-10-10 事故根因：createFile(final, {overwrite:true}) 会**先把正式文件截断成
                //   0 字节**，然后才写内容。而图案预设动辄几十 MB（单张图案的 patternRgbDataBase64
                //   实测可达 44MB），写入窗口长达数十秒；窗口内任何中断（最常见：UDT Reload
                //   直接杀死 UXP 宿主）都会让正式文件永久停在 0 字节 ⇒ 加载侧 JSON.parse('') 失败
                //   ⇒ 面板预设全部消失。而此时旧备份已在「替换前」被删除，数据再也回不来。
                //   渐变预设（1~2KB、毫秒级写完）一直用的就是原子写入 —— 本函数此前漏了这层保护，
                //   属实现不一致，现补齐。
                // 语义：内容先完整落进 .tmp；只有 .tmp 写成功后才 moveTo 替换正式文件。
                //   写 .tmp 失败 ⇒ 正式文件分毫未动，原始数据始终安全。
                const finalFileName = this.PATTERN_PRESETS_FILE;
                const backupFileName = `${this.PATTERN_PRESETS_FILE}.backup`;
                const tempFileName = `${this.PATTERN_PRESETS_FILE}.tmp`;
                const tempFile = await presetFolder.createFile(tempFileName, { overwrite: true });
                await (tempFile as any).write(jsonData, { format: require('uxp').storage.formats.utf8 });

                // 备份现有正式文件：**直接改名成 .backup 并带 overwrite** ——
                // 不必先 getEntry(旧备份)+delete()（少一次 I/O，也少一个中间失败点）。
                try {
                    const existingFile = await presetFolder.getEntry(finalFileName);
                    if (existingFile) {
                        await this.moveEntryTo(existingFile, presetFolder, backupFileName);
                    }
                } catch (e) { /* 目标文件不存在，无需备份 */ }

                // 原子替换：moveTo 带 overwrite ⇒ 目标残留也能直接覆盖，
                // 无需「先删目标再重试」那套（那套在签名写错时还会把正式文件删掉，见 moveEntryTo 注释）。
                // ⚠️ 此处绝不回退到 createFile(overwrite)+write（那正是清零事故的来源）；
                //    万一失败，正式文件可能在极短窗口内缺失，但加载侧的 .tmp/.backup 恢复链会兜住，
                //    外层重试也会再走一遍本流程。
                await this.moveEntryTo(tempFile, presetFolder, finalFileName);

                // 记录本次成功保存的内容
                this.lastPatternJson = jsonData;
                console.log('✅ 图案预设已保存', patterns.length, '个预设,', jsonData.length, '字符');
                currentResolve && currentResolve();
                this.patternSavePromise = null;
                return; // 成功保存，退出重试循环
                
            } catch (error) {
                retryCount++;
                console.error(`❌ 保存图案预设失败 (尝试 ${retryCount}/${maxRetries}):`, error);
                
                if (retryCount >= maxRetries) {
                    console.error('❌ 图案预设保存失败，已达到最大重试次数');
                    currentReject && currentReject(error);
                    this.patternSavePromise = null;
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
            let serializedPatterns: any[] | null = null;
            // 是否来自本地数据文件（非 bundle 兜底）——决定是否预热保存去重基线
            let loadedFromLocal = false;

            // 解析带恢复的辅助函数（与渐变一致）
            const parseWithRecovery = (content: string): any[] | null => {
                try {
                    const parsed = JSON.parse(content);
                    return Array.isArray(parsed) ? parsed : null;
                } catch (e) {
                    const start = content.indexOf('[');
                    const end = content.lastIndexOf(']');
                    if (start !== -1 && end !== -1 && end > start) {
                        try {
                            const repaired = content.slice(start, end + 1);
                            const parsed = JSON.parse(repaired);
                            return Array.isArray(parsed) ? parsed : null;
                        } catch (_) { /* ignore */ }
                    }
                    return null;
                }
            };

            const formats = require('uxp').storage.formats;

            // 先尝试从数据文件夹读取正式文件
            try {
                const presetsFile = await presetFolder.getEntry(this.PATTERN_PRESETS_FILE);
                if (presetsFile) {
                    const content = await (presetsFile as any).read({ format: formats.utf8 });
                    const parsed = parseWithRecovery(content);
                    if (parsed && parsed.length > 0) {
                        serializedPatterns = parsed;
                        loadedFromLocal = true;
                    }
                }
            } catch (_) { /* 数据文件不存在或解析失败时，走下方恢复链 */ }

            // ⚠️ 恢复链（2026-10-10 加固）：正式文件不可用 → `.tmp` → `.backup`。
            //   为什么必须处理「正式文件**不存在**」这种形态：
            //     原子替换由两步改名组成（正式文件 → .backup、.tmp → 正式文件）。
            //     进程在两步之间被打断（最常见：UDT Reload 直接杀 UXP 宿主）时，
            //     正式文件就不存在了。旧实现只在「正式文件存在但解析失败」时才去读 .backup，
            //     「文件不存在」会直接掉到 bundle ⇒ 用户的预设全部消失（用户报的正是这一形态）。
            //   ⚠️ `.tmp` 走**严格** JSON.parse：它可能来自被中途打断的写入，残缺内容绝不采信
            //      （parseWithRecovery 的「掐头去尾」修复会把半截数组救成短数组 = 脏数据）。
            //   ⚠️ 恢复即「把被打断的原子替换补完」：把该文件改名回正式文件名（带 overwrite），
            //      比 createFile+write 安全得多——后者对几十 MB 的预设正是「先清零再写」的老事故源。
            const restoreFrom = async (fileName: string, strict: boolean): Promise<boolean> => {
                try {
                    const entry = await presetFolder.getEntry(fileName);
                    if (!entry) return false;
                    const content = await (entry as any).read({ format: formats.utf8 });
                    let parsed: any[] | null = null;
                    if (strict) {
                        try {
                            const p = JSON.parse(content);
                            parsed = Array.isArray(p) ? p : null;
                        } catch (_) { parsed = null; }
                    } else {
                        parsed = parseWithRecovery(content);
                    }
                    if (!parsed || parsed.length === 0) return false;
                    serializedPatterns = parsed;
                    loadedFromLocal = true;
                    try {
                        await this.moveEntryTo(entry, presetFolder, this.PATTERN_PRESETS_FILE);
                        console.log('✅ 已用', fileName, '恢复图案预设并补完替换');
                    } catch (e) {
                        console.warn('⚠️ 图案预设已从', fileName, '读出，但补写回正式文件失败:', e);
                    }
                    return true;
                } catch (_) { /* 候选文件不存在 / 不可读，继续下一个 */ }
                return false;
            };

            if (!serializedPatterns || serializedPatterns.length === 0) {
                console.warn('⚠️ 图案预设正式文件缺失或不可解析，尝试 .tmp / .backup 恢复');
                await restoreFrom(`${this.PATTERN_PRESETS_FILE}.tmp`, true);
            }
            if (!serializedPatterns || serializedPatterns.length === 0) {
                await restoreFrom(`${this.PATTERN_PRESETS_FILE}.backup`, false);
            }

            // 若数据文件夹无有效数据，尝试从bundle读取默认预设
            if (!serializedPatterns || serializedPatterns.length === 0) {
                console.log('ℹ️ 图案预设本地文件缺失或空，尝试从bundle/dist读取默认预设');
                const bundleData = await this.tryReadFromBundle(this.PATTERN_PRESETS_FILE);
                if (bundleData && bundleData.length > 0) {
                    serializedPatterns = bundleData;
                    // 将bundle中的默认预设写回到数据文件夹，便于后续持久化
                    try {
                        await this.savePatternPresets(bundleData as any);
                    } catch (e) {
                        console.warn('⚠️ 将bundle默认图案预设写回数据文件夹失败:', e);
                    }
                }
            }
            
            if (!serializedPatterns) {
                console.log('📁 图案预设文件不存在或无有效数据，返回空数组');
                return [];
            }

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

                // ⚡ 回填每图案序列化片段缓存（仅本地文件路径）：serialized 里就有现成的
                // base64 字符串，直接 JSON.stringify 成片段入缓存，零编码。重载后的
                // 首次自动保存直接复用，不再重编几 MB 二进制。
                if (loadedFromLocal) {
                    this.patternFragCache.set(pattern, {
                        sig: this.patternSignature(pattern),
                        frag: JSON.stringify(serialized)
                    });
                }

                return pattern;
            });

            // ⚡ 预热保存去重基线（仅本地文件路径）：加载出的 patterns 重新序列化的结果
            // 与文件内容一一对应（片段就来自文件本身），使重载后的首次 500ms 防抖保存
            // 与 30s 定时保存命中"内容未变化"短路——否则每次 reload 打开面板都会
            // 全量重编所有图案的 base64 并重写文件，正是"开场一段时间点选卡顿"的元凶。
            if (loadedFromLocal && serializedPatterns) {
                this.lastPatternJson = JSON.stringify(serializedPatterns);
            }

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
        // 避免将空数组写入文件导致下次启动回退到默认预设
        if (gradients.length === 0) {
            console.warn('⚠️ 渐变预设为空，跳过保存以避免覆盖默认预设');
            return;
        }

        // 串行化保存，等待前一次保存完成，避免并发导致的“file already exists”等问题
        if (this.gradientSavePromise) {
            try { await this.gradientSavePromise; } catch (_) { /* 忽略前一次失败，仅确保顺序 */ }
        }

        let retryCount = 0;
        const maxRetries = 3;
        
        // 当前保存的Promise占位，便于后续调用等待
        let currentResolve: (() => void) | null = null;
        let currentReject: ((e: any) => void) | null = null;
        this.gradientSavePromise = new Promise<void>((resolve, reject) => {
            currentResolve = resolve;
            currentReject = reject;
        });

        while (retryCount < maxRetries) {
            try {
                console.log(`🔄 开始保存渐变预设 (尝试 ${retryCount + 1}/${maxRetries})，共 ${gradients.length} 个预设`);
                const presetFolder = await this.getPresetFolder();

                // 保存完整的渐变预设数据（去除易引起频繁变更的时间戳）
                const serializableGradients = gradients.map((gradient, index) => ({
                    id: gradient.id || `gradient_${Date.now()}_${index}`,
                    name: gradient.name || `渐变预设 ${index + 1}`,
                    preview: gradient.preview || '',
                    type: gradient.type,
                    angle: gradient.angle || 0,
                    reverse: gradient.reverse || false,
                    preserveTransparency: gradient.preserveTransparency || false,
                    stops: gradient.stops.map(stop => ({
                        color: stop.color,
                        position: stop.position,
                        colorPosition: stop.colorPosition,
                        opacityPosition: stop.opacityPosition,
                        midpoint: stop.midpoint,
                        opacityMidpoint: stop.opacityMidpoint
                    })),
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
                            midpoint: stop.midpoint,
                            opacityMidpoint: stop.opacityMidpoint
                        }))
                    })) : undefined
                }));

                // 待写入的稳定JSON字符串
                const jsonData = JSON.stringify(serializableGradients, null, 2);

                // 内容未变化则跳过写入（若最终文件已存在）
                try {
                    const existing = await presetFolder.getEntry(this.GRADIENT_PRESETS_FILE);
                    if (existing && this.lastGradientJson === jsonData) {
                        console.log('⏭️ 渐变预设内容未变化，跳过写入');
                        currentResolve && currentResolve();
                        this.gradientSavePromise = null;
                        return;
                    }
                } catch (_) { /* 文件不存在时继续写入 */ }

                // 创建临时文件名，确保原子性写入
                const tempFileName = `${this.GRADIENT_PRESETS_FILE}.tmp`;
                console.log('📝 创建临时文件:', tempFileName);
                const tempFile = await presetFolder.createFile(tempFileName, { overwrite: true });

                // 先验证JSON数据有效性
                try { JSON.parse(jsonData); } catch (jsonError) {
                    console.error('❌ JSON数据无效:', jsonError);
                    throw jsonError;
                }

                // 写入并验证临时文件
                await (tempFile as any).write(jsonData, { format: require('uxp').storage.formats.utf8 });
                const tempContent = await (tempFile as any).read({ format: require('uxp').storage.formats.utf8 });
                try { JSON.parse(tempContent); } catch (e) {
                    console.error('❌ 写入文件内容无效:', e);
                    throw e;
                }

                const finalFileName = this.GRADIENT_PRESETS_FILE;
                const backupFileName = `${this.GRADIENT_PRESETS_FILE}.backup`;

                // 若目标存在则先备份（moveTo 带 overwrite ⇒ 无需先删旧备份）
                try {
                    const existingFile = await presetFolder.getEntry(finalFileName);
                    if (existingFile) {
                        await this.moveEntryTo(existingFile, presetFolder, backupFileName);
                    }
                } catch (_) { }

                // 把临时文件改名为正式文件：moveTo 带 overwrite ⇒ 目标残留也能直接覆盖。
                // ⚠️ 渐变预设只有 1~2KB、毫秒级写完，所以失败时保留 createFile+write 兜底；
                //    图案预设几十 MB，绝不能这么兜（那正是清零事故的来源，见 savePatternPresets）。
                try {
                    await this.moveEntryTo(tempFile, presetFolder, finalFileName);
                } catch (_) {
                    const finalFile = await presetFolder.createFile(finalFileName, { overwrite: true });
                    await (finalFile as any).write(jsonData, { format: require('uxp').storage.formats.utf8 });
                    try { await (tempFile as any).delete(); } catch (_) { }
                }

                // 验证最终文件
                try {
                    const finalFile = await presetFolder.getEntry(this.GRADIENT_PRESETS_FILE);
                    const finalContent = await (finalFile as any).read({ format: require('uxp').storage.formats.utf8 });
                    JSON.parse(finalContent);
                } catch (verifyErr) {
                    console.error('❌ 最终文件内容验证失败:', verifyErr);
                    throw verifyErr;
                }

                // 记录本次成功保存的内容
                this.lastGradientJson = jsonData;
                console.log('✅ 渐变预设已保存，数量:', serializableGradients.length);
                currentResolve && currentResolve();
                this.gradientSavePromise = null;
                return;
            } catch (error) {
                retryCount++;
                console.error(`❌ 保存渐变预设失败 (尝试 ${retryCount}/${maxRetries}):`, error);
                if (retryCount >= maxRetries) {
                    console.error('❌ 渐变预设保存失败，已达到最大重试次数');
                    currentReject && currentReject(error);
                    this.gradientSavePromise = null;
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }
    }

    // 从插件包读取默认预设所需的辅助方法
    private static async getPluginFolder() {
        try {
            let localFileSystem;
            try {
                localFileSystem = require('uxp').storage.localFileSystem;
            } catch (_) {
                localFileSystem = (window as any).uxp?.storage?.localFileSystem;
            }
            if (!localFileSystem || !localFileSystem.getPluginFolder) {
                throw new Error('无法获取pluginFolder（localFileSystem.getPluginFolder 不可用）');
            }
            const pluginFolder = await localFileSystem.getPluginFolder();
            console.log('📦 插件包路径:', pluginFolder.nativePath);
            return pluginFolder;
        } catch (error) {
            console.error('❌ 获取插件包文件夹失败:', error);
            throw error;
        }
    }

    private static async tryReadFromBundle(fileName: string): Promise<any[] | null> {
        try {
            const pluginFolder = await this.getPluginFolder();
            const formats = require('uxp').storage.formats;
            const tryPaths = [fileName, `dist/${fileName}`, `./${fileName}`];

            for (const relPath of tryPaths) {
                try {
                    const entry = await pluginFolder.getEntry(relPath);
                    if (entry) {
                        const content = await (entry as any).read({ format: formats.utf8 });
                        const parsed = JSON.parse(content);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            console.log(`✅ 从bundle读取到默认预设: ${relPath} (${parsed.length} 条)`);
                            return parsed;
                        }
                    }
                } catch (e) {
                    // 尝试下一个路径
                }
            }
            console.warn(`⚠️ 未在插件包中找到默认预设文件: ${fileName}`);
            return null;
        } catch (error) {
            console.error('❌ 读取插件包默认预设失败:', error);
            return null;
        }
    }

    /**
     * 从本地存储加载渐变预设（恢复完整数据）
     */
    static async loadGradientPresets(): Promise<(Gradient & { id: string; name: string; preview?: string })[]> {
        try {
            const presetFolder = await this.getPresetFolder();
            let serializedGradients: any[] | null = null;

            // 解析带恢复的辅助函数
            const parseWithRecovery = (content: string): any[] | null => {
                try {
                    const parsed = JSON.parse(content);
                    return Array.isArray(parsed) ? parsed : null;
                } catch (e) {
                    // 尝试从首个'['到最后一个']'之间截取修复
                    const start = content.indexOf('[');
                    const end = content.lastIndexOf(']');
                    if (start !== -1 && end !== -1 && end > start) {
                        try {
                            const repaired = content.slice(start, end + 1);
                            const parsed = JSON.parse(repaired);
                            return Array.isArray(parsed) ? parsed : null;
                        } catch (_) { /* ignore */ }
                    }
                    return null;
                }
            };

            const formats = require('uxp').storage.formats;

            // 先尝试从数据文件夹读取正式文件
            try {
                const presetsFile = await presetFolder.getEntry(this.GRADIENT_PRESETS_FILE);
                if (presetsFile) {
                    const content = await (presetsFile as any).read({ format: formats.utf8 });
                    const parsed = parseWithRecovery(content);
                    if (parsed && parsed.length > 0) {
                        serializedGradients = parsed;
                    }
                }
            } catch (_) { /* 忽略，后续走恢复链 / bundle */ }

            // ⚠️ 恢复链（与图案预设同构）：正式文件缺失或不可解析 → `.tmp` → `.backup`。
            //    原子替换是两步改名（正式文件→.backup、.tmp→正式文件），进程在两步之间被打断
            //    （UDT Reload 杀宿主）会让正式文件直接消失；旧实现只在「正式文件存在但解析失败」
            //    时才读 .backup，「文件不存在」会掉到 bundle ⇒ 用户预设丢失。
            //    `.tmp` 走严格 JSON.parse（可能来自被打断的写入，残缺内容不采信）。
            const restoreFrom = async (fileName: string, strict: boolean): Promise<boolean> => {
                try {
                    const entry = await presetFolder.getEntry(fileName);
                    if (!entry) return false;
                    const content = await (entry as any).read({ format: formats.utf8 });
                    let parsed: any[] | null = null;
                    if (strict) {
                        try {
                            const p = JSON.parse(content);
                            parsed = Array.isArray(p) ? p : null;
                        } catch (_) { parsed = null; }
                    } else {
                        parsed = parseWithRecovery(content);
                    }
                    if (!parsed || parsed.length === 0) return false;
                    serializedGradients = parsed;
                    try {
                        await this.moveEntryTo(entry, presetFolder, this.GRADIENT_PRESETS_FILE);
                        console.log('✅ 已用', fileName, '恢复渐变预设并补完替换');
                    } catch (e) {
                        console.warn('⚠️ 渐变预设已从', fileName, '读出，但补写回正式文件失败:', e);
                    }
                    return true;
                } catch (_) { /* 候选文件不存在 / 不可读，继续下一个 */ }
                return false;
            };

            if (!serializedGradients || serializedGradients.length === 0) {
                console.warn('⚠️ 渐变预设正式文件缺失或不可解析，尝试 .tmp / .backup 恢复');
                await restoreFrom(`${this.GRADIENT_PRESETS_FILE}.tmp`, true);
            }
            if (!serializedGradients || serializedGradients.length === 0) {
                await restoreFrom(`${this.GRADIENT_PRESETS_FILE}.backup`, false);
            }

            // 若数据文件夹无有效数据，尝试从bundle读取默认预设并回写
            if (!serializedGradients || serializedGradients.length === 0) {
                console.log('ℹ️ 渐变预设本地文件缺失或空，尝试从bundle/dist读取默认预设');
                const bundleData = await this.tryReadFromBundle(this.GRADIENT_PRESETS_FILE);
                if (bundleData && bundleData.length > 0) {
                    serializedGradients = bundleData;
                    try {
                        await this.saveGradientPresets(bundleData as any);
                    } catch (e) {
                        console.warn('⚠️ 将bundle默认渐变预设写回数据文件夹失败:', e);
                    }
                }
            }

            if (!serializedGradients) {
                console.log('📁 渐变预设文件不存在或无有效数据，返回空数组');
                return [];
            }

            const normalizeColor = (c: any): string => {
                if (typeof c === 'string') {
                    // 若已是 rgb/rgba 则直接返回；若是十六进制，可在此扩展转换
                    if (/^rgba?\(/i.test(c)) return c;
                    // 简单将十六进制等非常规格式兜底为不透明黑
                    return 'rgba(0,0,0,1)';
                }
                if (c && typeof c === 'object' && 'r' in c && 'g' in c && 'b' in c) {
                    const a = (c as any).a != null ? (c as any).a : 1;
                    return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
                }
                return 'rgba(0,0,0,1)';
            };

            // 恢复完整的渐变数据
            const gradients = serializedGradients.map((serialized: any, index: number) => ({
                id: serialized.id || `gradient_${Date.now()}_${index}`,
                name: serialized.name || `渐变预设 ${index + 1}`,
                preview: serialized.preview || '',
                type: serialized.type || 'linear',
                angle: serialized.angle || 0,
                reverse: serialized.reverse || false,
                preserveTransparency: serialized.preserveTransparency || false,
                stops: (serialized.stops || []).map((stop: any) => ({
                    color: normalizeColor(stop.color),
                    position: stop.position || 0,
                    colorPosition: stop.colorPosition,
                    opacityPosition: stop.opacityPosition,
                    midpoint: stop.midpoint,
                    opacityMidpoint: stop.opacityMidpoint
                })),
                presets: serialized.presets ? serialized.presets.map((preset: any) => ({
                    preview: preset.preview || '',
                    type: preset.type || 'linear',
                    angle: preset.angle || 0,
                    reverse: preset.reverse || false,
                    stops: (preset.stops || []).map((stop: any) => ({
                        color: normalizeColor(stop.color),
                        position: stop.position || 0,
                        colorPosition: stop.colorPosition,
                        opacityPosition: stop.opacityPosition,
                        midpoint: stop.midpoint,
                        opacityMidpoint: stop.opacityMidpoint
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