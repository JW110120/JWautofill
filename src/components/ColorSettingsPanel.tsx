import React, { useState, useEffect } from 'react';
import { app } from 'photoshop';
import { ColorSettings } from '../types/state';
import SliderControl from './SliderControl';

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

    const handleLabelMouseDown = (event: React.MouseEvent, key: keyof ColorSettings) => {
        event.preventDefault();
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

    useEffect(() => {
        if (isOpen) {
            try {
                const currentDocument = app.activeDocument;
                if (currentDocument) {
                    const currentQuickMaskState = currentDocument.quickMaskMode;
                    setInternalQuickMaskMode(currentQuickMaskState);
                    console.log('获取到的内部快速蒙版模式:', currentQuickMaskState);
                } else {
                    console.log('没有活动文档可以获取快速蒙版模式。');
                }
            } catch (e) {
                console.error('获取快速蒙版模式时出错:', e);
                setInternalQuickMaskMode(propIsQuickMaskMode);
            }
        }
    }, [isOpen, propIsQuickMaskMode]); 

    if (!isOpen) return null;

    console.log('颜色设置面板状态/属性:', { isClearMode, propIsQuickMaskMode, internalQuickMaskMode });


    return (
        <div className="color-settings-panel">
            <div className="panel-header">
                <h3>颜色动态设置</h3>
                <button className="close-button" onClick={onClose}>×</button>
            </div>
            
            <div className="colorsettings-slider-group">
                {console.log('渲染条件: isClearMode && internalQuickMaskMode', isClearMode && internalQuickMaskMode)}
                {isClearMode && internalQuickMaskMode ? (
                    <>
                        <SliderControl
                            settingKey="grayVariation"
                            label="灰度抖动"
                            value={settings.grayVariation}
                            min={0}
                            max={100}
                            unit="%"
                            isDraggingActive={isDragging && dragTarget === 'grayVariation'}
                            onValueChange={handleNumberInputChange}
                            onLabelMouseDown={handleLabelMouseDown}
                        />
                    </>
                ) : (
                    <>
                        <SliderControl
                            settingKey="hueVariation"
                            label="色相抖动"
                            value={settings.hueVariation}
                            min={0}
                            max={360}
                            unit="°"
                            isDraggingActive={isDragging && dragTarget === 'hueVariation'}
                            onValueChange={handleNumberInputChange}
                            onLabelMouseDown={handleLabelMouseDown}
                        />
                        <SliderControl
                            settingKey="saturationVariation"
                            label="饱和度抖动"
                            value={settings.saturationVariation}
                            min={0}
                            max={100}
                            unit="%"
                            isDraggingActive={isDragging && dragTarget === 'saturationVariation'}
                            onValueChange={handleNumberInputChange}
                            onLabelMouseDown={handleLabelMouseDown}
                        />
                        <SliderControl
                            settingKey="brightnessVariation"
                            label="亮度抖动"
                            value={settings.brightnessVariation}
                            min={0}
                            max={100}
                            unit="%"
                            isDraggingActive={isDragging && dragTarget === 'brightnessVariation'}
                            onValueChange={handleNumberInputChange}
                            onLabelMouseDown={handleLabelMouseDown}
                        />
                    </>
                )}

                <SliderControl
                    settingKey="opacityVariation"
                    label="不透明度抖动"
                    value={settings.opacityVariation}
                    min={0}
                    max={100}
                    unit="%"
                    isDraggingActive={isDragging && dragTarget === 'opacityVariation'}
                    onValueChange={handleNumberInputChange}
                    onLabelMouseDown={handleLabelMouseDown}
                />
                
                {/* 计算模式选择器 */}
                <div className="colorsettings-calculation-mode">
                    <label>计算方法</label>
                    <sp-radio-group 
                        selected={settings.calculationMode || 'absolute'}
                        name="calculationMode"
                        onChange={(e) => setSettings(prev => ({ ...prev, calculationMode: e.target.value as 'absolute' | 'relative' }))}
                    >
                        <sp-radio value="absolute" className="calculation-mode-radio">
                            <span className="radio-item-label">绝对</span>
                        </sp-radio>
                        <sp-radio value="relative" className="calculation-mode-radio">
                            <span className="radio-item-label">相对</span>
                        </sp-radio>
                    </sp-radio-group>
                </div>
            </div>


        </div>
    );
};

export default ColorSettingsPanel;