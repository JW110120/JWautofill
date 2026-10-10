import React, { useState, useEffect, useRef } from 'react';
import { ColorSettings } from '../types/state';
import RangeSlider from './RangeSlider';
import { LayerInfoHandler } from '../utils/LayerInfoHandler';
import { debouncePsProbe, markPsBusyForEvent, runWhenIdle } from '../utils/psProbe';
import { addPsNotificationListeners, removePsNotificationListeners } from '../utils/psAccess';
import { calcDragValue } from '../utils/dragSensitivity';
import RadioGroup, { RadioOption } from './RadioGroup';

/** 「计算方法」两列选项：模块级常量，保持引用稳定（RadioGroup 已 React.memo）。 */
const CALCULATION_MODE_OPTIONS: RadioOption[] = [
    { value: 'absolute', label: '绝对' },
    { value: 'relative', label: '相对' },
];

interface ColorSettingsProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (settings: ColorSettings) => void;
    initialSettings?: ColorSettings;
    isQuickMaskMode?: boolean;
    isClearMode?: boolean;
    /**
     * 父面板「参数复位」信号（自增计数）。
     * 本面板参数活在自己的 state 里，父面板复位管不到 ⇒ 靠它回到默认值。
     * 首次挂载为 0，用 prevTokenRef 跳过第一次，避免打开面板就被清空。
     */
    resetToken?: number;
}

/** 复位目标值：与 types/state.ts 的 initialState.colorSettings 保持一致。 */
const DEFAULT_COLOR_SETTINGS: ColorSettings = {
    hueVariation: 0,
    saturationVariation: 0,
    brightnessVariation: 0,
    opacityVariation: 0,
    grayVariation: 0,
    calculationMode: 'absolute'
};

const ColorSettingsPanel: React.FC<ColorSettingsProps> = ({
    isOpen,
    onClose,
    onSave,
    initialSettings = {
        hueVariation: 0,
        saturationVariation: 0,
        brightnessVariation: 0,
        opacityVariation: 0,
        grayVariation: 0
    },
    isQuickMaskMode: propIsQuickMaskMode = false,
    isClearMode = false,
    resetToken = 0
}) => {
    const [internalQuickMaskMode, setInternalQuickMaskMode] = useState(propIsQuickMaskMode);
    const [isInLayerMask, setIsInLayerMask] = useState(false);
    const [isInSingleColorChannel, setIsInSingleColorChannel] = useState(false);
    const [settings, setSettings] = useState<ColorSettings>({
        ...initialSettings,
        calculationMode: initialSettings?.calculationMode || 'absolute'
    });
    const [isDragging, setIsDragging] = useState(false);
    const [dragTarget, setDragTarget] = useState<keyof ColorSettings | null>(null);
    const [dragStartX, setDragStartX] = useState(0);
    const [dragStartValue, setDragStartValue] = useState(0);


    // 实时更新功能：使用防抖机制避免频繁调用
    useEffect(() => {
        // 使用防抖机制，延迟300ms后再调用onSave，避免频繁更新导致PS崩溃
        const debounceTimeoutId = setTimeout(() => {
            onSave(settings);
        }, 300);
        
        return () => clearTimeout(debounceTimeoutId);
    }, [settings]); // 移除onSave依赖，避免不必要的重新执行

    const handleNumberInputChange = (key: keyof ColorSettings, value: number) => {
        const maxValue = key === 'hueVariation' ? 360 : 100;
        const clampedValue = Math.max(0, Math.min(maxValue, value));
        if (!isNaN(clampedValue)) {
            setSettings(prev => ({
                ...prev,
                [key]: clampedValue
            }));
        }
    };

    // 事件挂在「参数集合行容器」上（双行滑块的第一行整行可拖，含标签与中间空白），
    // 因此必须排除落在数字输入框上的按下，否则输入框无法聚焦/编辑。
    const handleLabelMouseDown = (event: React.MouseEvent, key: keyof ColorSettings) => {
        const el = event.target as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        event.preventDefault();
        setIsDragging(true);
        setDragTarget(key);
        setDragStartX(event.clientX);
        setDragStartValue(settings[key]);
    };

    const handleMouseMove = (event: MouseEvent) => {
        if (!isDragging || !dragTarget) return;

        const maxValue = dragTarget === 'hueVariation' ? 360 : 100;
        const newValue = calcDragValue(
            dragStartValue,
            event.clientX - dragStartX,
            0,
            maxValue,
            1
        );

        setSettings(prev => ({
            ...prev,
            [dragTarget]: newValue
        }));
    };

    const handleMouseUp = () => {
        setIsDragging(false);
        setDragTarget(null);
    };

    React.useEffect(() => {
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, dragTarget, dragStartX, dragStartValue]);

    // 参数复位：把五个抖动值与计算方法一起回到默认。
    // ⚠️ setSettings 会触发下面那条 300ms 防抖的 onSave ⇒ 父面板的 colorSettings
    //    同步回到默认，不需要额外回传。
    // ⚠️ 跳过首次（prevTokenRef 初始就是 resetToken ⇒ 首次比较相等、不复位），
    //    否则每次打开面板都会被清空一次。
    const prevResetTokenRef = useRef(resetToken);
    useEffect(() => {
        if (prevResetTokenRef.current === resetToken) return;
        prevResetTokenRef.current = resetToken;
        setSettings({ ...DEFAULT_COLOR_SETTINGS });
    }, [resetToken]);

    // 检测图层蒙版和快速蒙版模式
    useEffect(() => {
        const checkMaskModes = async () => {
            try {
                const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                if (layerInfo) {
                    setInternalQuickMaskMode(layerInfo.isInQuickMask);
                    setIsInLayerMask(layerInfo.isInLayerMask);
                    setIsInSingleColorChannel(layerInfo.isInSingleColorChannel);
                } else {
                    console.log('无法获取图层信息');
                    setInternalQuickMaskMode(propIsQuickMaskMode);
                    setIsInLayerMask(false);
                    setIsInSingleColorChannel(false);
                }
            } catch (error) {
                console.error('检测蒙版模式失败:', error);
                setInternalQuickMaskMode(propIsQuickMaskMode);
                setIsInLayerMask(false);
                setIsInSingleColorChannel(false);
            }
        };

        // 面板打开时检测一次。
        // ⚠️ 必须走 runWhenIdle：本 effect 的依赖里含 propIsQuickMaskMode，
        // 而父面板正是在「文档切换探测完成」后回写该值 ⇒ 切文档后这里会被连带触发，
        // 若直接 get 就又撞回忙碌窗口。runWhenIdle 会顺延到空闲后再读。
        if (isOpen) {
            const probe = runWhenIdle(() => { checkMaskModes(); }, 300, 12);
            probe();
        }
    }, [isOpen, propIsQuickMaskMode]);

    // 监听通道切换和快速蒙版切换事件
    useEffect(() => {
        if (!isOpen) return;

        const checkMaskModes = async () => {
            try {
                const layerInfo = await LayerInfoHandler.getActiveLayerInfo();
                setInternalQuickMaskMode(layerInfo?.isInQuickMask || false);
                setIsInLayerMask(layerInfo?.isInLayerMask || false);
                setIsInSingleColorChannel(layerInfo?.isInSingleColorChannel || false);
            } catch (error) {
                console.error('检测蒙版模式失败:', error);
                setInternalQuickMaskMode(false);
                setIsInLayerMask(false);
                setIsInSingleColorChannel(false);
            }
        };

        // 监听Photoshop事件来检查状态变化
        // 探测防抖：PS 命令（如合并图层）执行中途派发的事件立刻 get 会撞忙碌窗口，
        // 弹出宿主报错框「命令"获取"当前不可用」，延迟到事件风暴平息后再探测
        const maskProbe = debouncePsProbe(() => { checkMaskModes(); });
        const handleNotification = (eventName?: any, descriptor?: any) => {
            // ⚠️ 事件到达瞬间打忙碌标记（回调内唯一允许做的事）：checkMaskModes 会读
            // app.activeDocument / doc.activeLayers并发多次 batchPlay get。
            // 切文档的忙碌窗口比普通事件长得多，由 markPsBusyForEvent 按事件类型裁定。
            markPsBusyForEvent(typeof eventName === 'string' ? eventName : '', descriptor);
            maskProbe();
        };

        // 添加事件监听器
        addPsNotificationListeners(handleNotification);

        // 清理函数
        return () => {
            maskProbe.cancel();
            removePsNotificationListeners(handleNotification);
        };
    }, [isOpen]);

    // 单个滑块渲染：结构与其他面板的滑块一致（行容器装 文字标签 + 数字输入 + 单位符号）。
    // widthClass 显式指定文字标签宽度修饰类（沿用工具箱标签算法：2/3/4/5/6字 = 20/33/47/60/73px），
    // 不再用 label.length 动态拼类名，避免不同长度标签算错宽度。
    const renderSlider = (
        settingKey: keyof ColorSettings,
        label: string,
        value: number,
        min: number,
        max: number,
        unit: string,
        widthClass: string
    ) => {
        const handleRangeChange = (v: number) => {
            handleNumberInputChange(settingKey, v);
        };

        return (
            <div className="row-between">
                <label
                    className={"label-drag " + widthClass}
                    onMouseDown={(e) => handleLabelMouseDown(e, settingKey)}
                >
                    {label}
                </label>
                <RangeSlider
                    min={min}
                    max={max}
                    step={1}
                    value={value || 0}
                    onChange={handleRangeChange}
                    className="slider-track"
                />
                <div className="row-start">
                    <div className="num-input-row">
                        <input
                            type="number"
                            min={min}
                            max={max}
                            value={value || 0}
                            onChange={(e) => handleNumberInputChange(settingKey, Number(e.target.value))}
                        />
                    </div>
                    <span className="num-unit">{unit}</span>
                </div>
            </div>
        );
    };

    if (!isOpen) return null;

    // 判断是否应该显示灰度抖动：清除模式 || 快速蒙版 || 图层蒙版 || 单通道
    const shouldShowGrayVariation = isClearMode || internalQuickMaskMode || isInLayerMask || isInSingleColorChannel;


    return (
        <div className="panel subpanel-color">
            <div className="subpanel-title-1">
                <div>颜色动态设置</div>
                <div className="close-button" role="button" tabIndex={0} onClick={onClose}>×</div>
            </div>
            
            <div className="panel-section">
                {shouldShowGrayVariation ? (
                    renderSlider('grayVariation', '灰度抖动', settings.grayVariation, 0, 100, '%', 'label-4')
                ) : (
                    <>
                        {renderSlider('hueVariation', '色相抖动', settings.hueVariation, 0, 360, '°', 'label-4')}
                        {renderSlider('saturationVariation', '饱和度抖动', settings.saturationVariation, 0, 100, '%', 'label-5')}
                        {renderSlider('brightnessVariation', '亮度抖动', settings.brightnessVariation, 0, 100, '%', 'label-4')}
                    </>
                )}

                {renderSlider('opacityVariation', '不透明度抖动', settings.opacityVariation, 0, 100, '%', 'label-6')}
            </div>

            <div className="divider"></div>

            {/* 计算模式选择器（原 colorsettings-calculation-mode 分区容器作废，统一收口为子面板分区容器） */}
            <div className="panel-section">
                <label className="subpanel-title-2">计算方法</label>
                <RadioGroup
                    value={settings.calculationMode || 'absolute'}
                    onChange={(e) => setSettings(prev => ({ ...prev, calculationMode: e.target.value as 'absolute' | 'relative' }))}
                    options={CALCULATION_MODE_OPTIONS}
                    className="radio-pair-group"
                />
            </div>


        </div>
    );
};

export default ColorSettingsPanel;