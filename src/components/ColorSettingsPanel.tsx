import React, { useState, useEffect } from 'react';
import { app, action } from 'photoshop';
import { ColorSettings } from '../types/state';
import RangeSlider from './RangeSlider';
import { LayerInfoHandler } from '../utils/LayerInfoHandler';
import { setDragCursorActive } from '../utils/dragCursor';

interface ColorSettingsProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (settings: ColorSettings) => void;
    initialSettings?: ColorSettings;
    isQuickMaskMode?: boolean;
    isClearMode?: boolean; 
}

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
    isClearMode = false
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

    const handleSliderChange = (key: keyof ColorSettings) => (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = Number(event.target.value);
        if (!isNaN(value)) {
            setSettings(prev => ({
                ...prev,
                [key]: value
            }));
        }
    };

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
        // 拖拽开始：把全局光标锁成 ew-resize，避免鼠标移出容器后光标变回普通箭头。
        setDragCursorActive(true);
        setIsDragging(true);
        setDragTarget(key);
        setDragStartX(event.clientX);
        setDragStartValue(settings[key]);
    };

    const handleMouseMove = (event: MouseEvent) => {
        if (!isDragging || !dragTarget) return;

        const deltaX = event.clientX - dragStartX;
        const sensitivity = dragTarget === 'hueVariation' ? 1 : 0.5;
        const maxValue = dragTarget === 'hueVariation' ? 360 : 100;
        
        const newValue = Math.max(
            0,
            Math.min(maxValue, Math.round(dragStartValue + (deltaX * sensitivity)))
        );

        setSettings(prev => ({
            ...prev,
            [dragTarget]: newValue
        }));
    };

    const handleMouseUp = () => {
        setDragCursorActive(false);
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

        // 面板打开时检测一次
        if (isOpen) {
            checkMaskModes();
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
        const handleNotification = async () => {
            try {
                // 检测图层蒙版和快速蒙版状态
                await checkMaskModes();
            } catch (error) {
                // 静默处理错误，避免频繁的错误日志
            }
        };

        // 添加事件监听器
        action.addNotificationListener(['set', 'select', 'clearEvent', 'delete', 'make'], handleNotification);

        // 清理函数
        return () => {
            action.removeNotificationListener(['set', 'select', 'clearEvent', 'delete', 'make'], handleNotification);
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
        const isDraggingActive = isDragging && dragTarget === settingKey;
        const handleRangeChange = (v: number) => {
            handleNumberInputChange(settingKey, v);
        };

        return (
            <div className="subpanel-slider-item">
                <div className="slider-stack">
                    <div
                        className="row-between"
                        onMouseDown={(e) => handleLabelMouseDown(e, settingKey)}
                    >
                        <label
                            className={widthClass}
                        >
                            {label}
                        </label>

                        <div className="num-input-wrap">
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

                    <RangeSlider
                        min={min}
                        max={max}
                        step={1}
                        value={value || 0}
                        onChange={handleRangeChange}
                        className="slider-input"
                    />
                </div>
            </div>
        );
    };

    if (!isOpen) return null;

    // 判断是否应该显示灰度抖动：清除模式 || 快速蒙版 || 图层蒙版 || 单通道
    const shouldShowGrayVariation = isClearMode || internalQuickMaskMode || isInLayerMask || isInSingleColorChannel;


    return (
        <div className="subpanel-fill">
            <div className="subpanel-header">
                <h3>颜色动态设置</h3>
                <div className="close-button" role="button" tabIndex={0} onClick={onClose}>×</div>
            </div>
            
            <div className="subpanel-section subpanel-section--col">
                {shouldShowGrayVariation ? (
                    renderSlider('grayVariation', '灰度抖动', settings.grayVariation, 0, 100, '%', 'label-4')
                ) : (
                    <>
                        {renderSlider('hueVariation', '色相抖动', settings.hueVariation, 0, 360, '°', 'label-4')}
                        {renderSlider('saturationVariation', '饱和度抖动', settings.saturationVariation, 0, 100, '%', 'label-4')}
                        {renderSlider('brightnessVariation', '亮度抖动', settings.brightnessVariation, 0, 100, '%', 'label-4')}
                    </>
                )}

                {renderSlider('opacityVariation', '不透明度抖动', settings.opacityVariation, 0, 100, '%', 'label-5')}
            </div>

            {/* 计算模式选择器（原 colorsettings-calculation-mode 分区容器作废，统一收口为子面板分区容器） */}
            <div className="subpanel-section subpanel-section--col">
                <label className="subpanel-title-2">计算方法</label>
                <sp-radio-group 
                    selected={settings.calculationMode || 'absolute'}
                    name="calculationMode"
                    onChange={(e) => setSettings(prev => ({ ...prev, calculationMode: e.target.value as 'absolute' | 'relative' }))}
                >
                    <sp-radio value="absolute" className="radio-item">
                        <span className="radio-item-label">绝对</span>
                    </sp-radio>
                    <sp-radio value="relative" className="radio-item">
                        <span className="radio-item-label">相对</span>
                    </sp-radio>
                </sp-radio-group>
            </div>


        </div>
    );
};

export default ColorSettingsPanel;