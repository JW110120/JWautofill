import React from 'react';
import { BlendMode } from '../constants/blendModes';
import { BLEND_MODE_OPTIONS } from '../constants/blendModeOptions';
import RangeSlider from './RangeSlider';
import Select from './Select';

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
  const [dragStartX, setDragStartX] = React.useState(0);
  const [dragStartValue, setDragStartValue] = React.useState(0);

  // 实时更新功能：当参数变化时自动调用回调函数
  React.useEffect(() => {
    // 这里不需要额外的逻辑，因为StrokeSetting的参数变化已经通过onChange回调实时传递给父组件
    // 父组件会处理实时更新逻辑
  }, [width, position, blendMode, opacity]);

  const handleLabelMouseDown = (event: React.MouseEvent, target: string) => {
    event.preventDefault();
    setIsDragging(true);
    setDragTarget(target);
    setDragStartX(event.clientX);
    setDragStartValue(target === 'width' ? width : opacity);
  };

  React.useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isDragging || !dragTarget) return;
      
      const deltaX = event.clientX - dragStartX;
      const sensitivity = dragTarget === 'width' ? 0.5 : 1;
      const maxValue = dragTarget === 'width' ? 10 : 100;
      const minValue = 0;
      
      let newValue = dragStartValue + deltaX * (sensitivity / 100);
      
      // 根据步长进行舍入
      if (dragTarget === 'width') {
        newValue = Math.round(newValue / 0.5) * 0.5;
      } else {
        newValue = Math.round(newValue);
      }
      
      newValue = Math.min(maxValue, Math.max(minValue, newValue));
      
      if (dragTarget === 'width') {
        onWidthChange(newValue);
      } else if (dragTarget === 'opacity') {
        onOpacityChange(newValue);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setDragTarget(null);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, dragTarget, dragStartX, dragStartValue, width, opacity, onWidthChange, onOpacityChange]);

  if (!isOpen) return null;

  return (
    <div className="strokesetting">
        <div className="panel-header">
          <h3>描边设置</h3>
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
        
        <div className="stroke-wide-container">
          <label 
            className={`stroke-label ${isDragging && dragTarget === 'width' ? 'dragging' : 'not-dragging'}`}
            onMouseDown={(e) => handleLabelMouseDown(e, 'width')}
          >
            宽度
          </label>
          <RangeSlider 
            min={0} 
            max={20} 
            step={0.5}
            value={width}
            onChange={(v) => onWidthChange(v)}
          />
          <div>
            <input
              type="number"
              min="0"
              max="20"
              step="0.5"
              value={width}
              onChange={(e) => onWidthChange(Number(e.target.value))}
              style={{ marginLeft:'-5px', width: '24px', textAlign: 'center' }}
            />
           <span>px</span>
          </div>
        </div>
        

          <div className="position-radio-group">
            <sp-radio-group 
              selected={position}
              name="strokePosition"
              onChange={(e) => onPositionChange(e.target.value as any)}
            >
              <sp-radio value="inside" className="position-radio-item">
                <span className="radio-item-label">内部</span>
              </sp-radio>
              <sp-radio value="center" className="position-radio-item">
                <span className="radio-item-label">居中</span>
              </sp-radio>
              <sp-radio value="outside" className="position-radio-item">
                <span className="radio-item-label">外部</span>
              </sp-radio>
            </sp-radio-group>
          </div>
        
        {!clearMode && (
          <div className="stroke-blende-mode">
            <label>混合模式：</label>
            <Select
              value={blendMode}
              groups={BLEND_MODE_OPTIONS}
              onChange={(v) => onBlendModeChange(v as BlendMode)}
            />
          </div>
        )} 
        
        <div className="stroke-opacity-control">
          <label 
            className={`stroke-label ${isDragging && dragTarget === 'opacity' ? 'dragging' : 'not-dragging'}`}
            onMouseDown={(e) => handleLabelMouseDown(e, 'opacity')}
            style={{ cursor: 'ew-resize', marginRight:'5px', userSelect: 'none' }}
          >
            不透明度
          </label>
          <RangeSlider 
            min={0} 
            max={100} 
            step={1}
            value={opacity}
            className="stroke-opacity-range"
            onChange={(v) => onOpacityChange(v)}
          />
          <div style={{ display: 'flex', alignItems: 'center'}}>
            <input
              type="number"
              min="0"
              max="100"
              value={opacity}
              onChange={(e) => onOpacityChange(Number(e.target.value))}
              style={{ width: '30px', textAlign: 'center' }}
            />
          <span style={{ marginLeft:'-20px', fontSize: '13px' }}>%</span>
          </div>
        </div>
        

      </div>
  );
};

export default StrokeSetting;
