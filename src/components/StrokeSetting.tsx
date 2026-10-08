import React from 'react';
import { BlendMode } from '../constants/blendModes';
import { BLEND_MODE_OPTIONS } from '../constants/blendModeOptions';
import RangeSlider from './RangeSlider';
import Select from './Select';
import RadioGroup, { RadioOption } from './RadioGroup';
import { calcDragValue } from '../utils/dragSensitivity';

/** 描边位置三列选项：模块级常量，保持引用稳定（RadioGroup 已 React.memo）。 */
const STROKE_POSITION_OPTIONS: RadioOption[] = [
  { value: 'inside', label: '内部' },
  { value: 'center', label: '居中' },
  { value: 'outside', label: '外部' },
];

interface StrokeSettingProps {
  isOpen: boolean;
  width: number;
  position: 'inside' | 'center' | 'outside';
  blendMode: BlendMode;
  opacity: number;
  clearMode: boolean; // 新增清除模式状态
  onWidthChange: (width: number) => void;
  onPositionChange: (position: 'inside' | 'center' | 'outside') => void;
  onBlendModeChange: (blendMode: BlendMode) => void;
  onOpacityChange: (opacity: number) => void;
  onClose: () => void; 
}

const StrokeSetting: React.FC<StrokeSettingProps> = ({
  isOpen,
  width,
  position,
  blendMode,
  opacity,
  clearMode,
  onWidthChange,
  onPositionChange,
  onBlendModeChange,
  onOpacityChange,
  onClose
}) => {
  const [isDragging, setIsDragging] = React.useState(false);
  const [dragTarget, setDragTarget] = React.useState<string | null>(null);
  // 拖拽起点存 ref：mousemove 回调只读 ref，effect 不必随值变化反复解绑/重绑监听
  const dragRef = React.useRef({ startX: 0, startValue: 0, target: '' as string });
  const valueRef = React.useRef({ width, opacity });
  valueRef.current = { width, opacity };
  const cbRef = React.useRef({ onWidthChange, onOpacityChange });
  cbRef.current = { onWidthChange, onOpacityChange };

  // 拖拽灵敏度不在此手写：只声明量程与步长，由 calcDragValue 按量程归一化（与其它面板同一手感）
  const STROKE_DRAG_CONFIG: Record<string, { min: number; max: number; step: number }> = {
    width: { min: 0, max: 20, step: 0.5 },
    opacity: { min: 0, max: 100, step: 1 }
  };

  const handleLabelMouseDown = (event: React.MouseEvent, target: string) => {
    event.preventDefault();
    dragRef.current = {
      startX: event.clientX,
      startValue: target === 'width' ? valueRef.current.width : valueRef.current.opacity,
      target
    };
    // 拖拽开始：把全局光标锁成 ew-resize，避免鼠标移出容器后光标变回普通箭头。
    setIsDragging(true);
    setDragTarget(target);
  };

  React.useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (event: MouseEvent) => {
      const { startX, startValue, target } = dragRef.current;
      const config = STROKE_DRAG_CONFIG[target];
      if (!config) return;

      const deltaX = event.clientX - startX;
      const newValue = calcDragValue(startValue, deltaX, config.min, config.max, config.step);

      if (target === 'width') cbRef.current.onWidthChange(newValue);
      else if (target === 'opacity') cbRef.current.onOpacityChange(newValue);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setDragTarget(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  if (!isOpen) return null;

  return (
    <div className="panel subpanel-stroke">
        <div className="subpanel-title-1">
          <div>描边设置</div>
          <div className="close-button" role="button" tabIndex={0} onClick={() => {
                    // 触发所有回调以确保状态更新
                    onWidthChange(width);
                    onPositionChange(position);
                    onBlendModeChange(blendMode);
                    onOpacityChange(opacity);
                    // 关闭面板
                    onClose();
                }}>×</div>
        </div>
        
        <div className="panel-section">
          <div className="row-between">
          <label
            className="label-drag label-2"
            onMouseDown={(e) => handleLabelMouseDown(e, 'width')}
          >
            宽度
          </label>
          <RangeSlider 
            min={0} 
            max={20} 
            step={0.5}
            value={width}
            className="slider-track"
            onChange={(v) => onWidthChange(v)}
          />
          <div className="row-start">
            <div className="num-input-row">
            <input
              type="number"
              min="0"
              max="20"
              step="0.5"
              value={width}
              onChange={(e) => onWidthChange(Number(e.target.value))}
            />
            </div>
            <span className="num-unit">px</span>
          </div>
          </div>
        </div>
        
        <div className="divider"></div>

          <div className="panel-section">
            {/* 🔴 2026-10-07 移除 .radio-trio 包裹层（本轮换方法的修复）。
                原结构是 `<div className="radio-trio"><RadioGroup className="radio-trio-group"/></div>`
                —— 两层嵌套 div。.radio-trio 唯一职责是提供纵向 margin，
                但它同时是 .panel-section（flex 列容器）的子项，
                **而 margin 会干扰 stretch**：实测三列在该结构下始终竖排，
                且内容右缘只到 52.5px（容器本应 230px），加 `margin:0`、`flex:0 0 auto`
                均无效 —— 说明 UXP 在「flex 列容器 > 带 margin 的 div > flex 行容器」
                这层嵌套上算不出正确宽度。
                ⇒ 直接让 .radio-trio-group 成为 .panel-section 的子项，少一层就少一个风险点。
                ⚠️ 纵向行距改由本文件 CSS 给 .radio-trio-group 补 padding 承担（见 stroke.css），
                   不再依赖被删掉的包裹层。 */}
            <RadioGroup
                value={position}
                onChange={(e) => onPositionChange(e.target.value as 'inside' | 'center' | 'outside')}
                options={STROKE_POSITION_OPTIONS}
                className="radio-trio-group"
            />
          </div>
        
        <div className="divider"></div>

        {/* 混合模式：清除模式下该值不起作用（清除描边固定走 clearEnum / 减去，
            见 StrokeSelection.ts 的清除分支），但**不再整行隐藏** ——
            改为「标签 + 下拉」都进入禁用态，保持面板版式稳定，
            也让用户能看到「混合模式在这里不可用」这一信息（2026-10-08 用户要求）。
            与主面板 `.app-blendmode-container` 的处理方式一致。 */}
        <div className="panel-section">
          <div className="row-between">
          <label className={clearMode ? 'label-4 label-disabled' : 'label-4'}>混合模式</label>
          <Select
            value={blendMode}
            groups={BLEND_MODE_OPTIONS}
            disabled={clearMode}
            onChange={(v) => onBlendModeChange(v as BlendMode)}
          />
          </div>
        </div>

        <div className="divider"></div>
        
        <div className="panel-section">
          <div className="row-between">
          <label
            className="label-drag label-4"
            onMouseDown={(e) => handleLabelMouseDown(e, 'opacity')}
          >
            不透明度
          </label>
          <RangeSlider 
            min={0} 
            max={100} 
            step={1}
            value={opacity}
            className="slider-track"
            onChange={(v) => onOpacityChange(v)}
          />
          <div className="row-start">
            <div className="num-input-row">
            <input
              type="number"
              min="0"
              max="100"
              value={opacity}
              onChange={(e) => onOpacityChange(Number(e.target.value))}
            />
            </div>
            <span className="num-unit">%</span>
          </div>
          </div>
        </div>
        

      </div>
  );
};

export default StrokeSetting;
