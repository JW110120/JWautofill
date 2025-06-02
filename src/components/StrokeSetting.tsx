import React from 'react';
import { BlendMode } from '../constants/blendModes';
import { BLEND_MODE_OPTIONS } from '../constants/blendModeOptions';

interface StrokeSettingProps {
  isOpen: boolean;
  width: number;
  position: 'inside' | 'center' | 'outside';
  blendMode: BlendMode;
  opacity: number;
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
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        
        <div className="stroke-wide-container">
          <label 
            className={`stroke-label ${isDragging && dragTarget === 'width' ? 'dragging' : 'not-dragging'}`}
            onMouseDown={(e) => handleLabelMouseDown(e, 'width')}
          >
            宽度
          </label>
          <input 
            type="range" 
            min="0" 
            max="10" 
            step="0.5"
            value={width}
            onChange={(e) => onWidthChange(Number(e.target.value))}
          />
          <div>
            <input
              type="number"
              min="0"
              max="10"
              step="0.5"
              value={width}
              onChange={(e) => onWidthChange(Number(e.target.value))}
              style={{ marginLeft:'-5px', width: '24px', textAlign: 'center' }}
            />
           <span>px</span>
          </div>
        </div>
        

        <div className="stroke-subtitle">
          <h3>位置</h3>
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
        
        <div className="stroke-blende-mode">
          <label>混合模式：</label>
          <sp-picker
            size="m"
            selects="single"
            selected={blendMode}
            onChange={(e) => onBlendModeChange(e.target.value as BlendMode)}
          >
            <sp-menu>
              {BLEND_MODE_OPTIONS.map((group, groupIndex) => (
                <React.Fragment key={groupIndex}>
                  {group.map((option) => (
                    <sp-menu-item 
                      key={option.value} 
                      value={option.value}
                      selected={option.value === blendMode}
                    >
                      {option.label}
                    </sp-menu-item>
                  ))}
                  {groupIndex < BLEND_MODE_OPTIONS.length - 1 && (
                    <sp-menu-divider />
                  )}
                </React.Fragment>
              ))}
            </sp-menu>
          </sp-picker>
        </div> 
        
        <div className="stroke-opacity-control">
          <label 
            className={`stroke-label ${isDragging && dragTarget === 'opacity' ? 'dragging' : 'not-dragging'}`}
            onMouseDown={(e) => handleLabelMouseDown(e, 'opacity')}
            style={{ cursor: 'ew-resize', marginRight:'5px', userSelect: 'none' }}
          >
            不透明度
          </label>
          <input 
            type="range" 
            min="0" 
            max="100" 
            step="1"
            value={opacity}
            style={{ width: '100px'}}
            onChange={(e) => onOpacityChange(Number(e.target.value))}
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
        
        <div className="panel-footer">
          <button 
            className="save-button"
            onClick={() => {
              // 触发所有回调以确保状态更新
              onWidthChange(width);
              onPositionChange(position);
              onBlendModeChange(blendMode);
              onOpacityChange(opacity);
              // 关闭面板
              onClose();
            }}
          >
            保存设置
          </button>
        </div>
      </div>
  );
};

export default StrokeSetting;
