import React from 'react';
import { BlendMode } from '../constants/blendModes';
import { BLEND_MODE_OPTIONS } from '../constants/blendModeOptions';

interface StrokeSettingProps {
  width: number;
  position: 'inside' | 'center' | 'outside';
  blendMode: BlendMode;
  opacity: number;
  onWidthChange: (width: number) => void;
  onPositionChange: (position: 'inside' | 'center' | 'outside') => void;
  onBlendModeChange: (blendMode: BlendMode) => void;
  onOpacityChange: (opacity: number) => void;
}

export default function StrokeSetting({
  width,
  position,
  blendMode,
  opacity,
  onWidthChange,
  onPositionChange,
  onBlendModeChange,
  onOpacityChange,
  onClose // 新增关闭回调
}: StrokeSettingProps) {
  
  return (
    <div className="strokesetting">
        <div className="panel-header">
          <h3>描边设置</h3>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        
        <div className="stroke-wide-container">
          <label>描边宽度</label>
          <input 
            type="range" 
            min="1" 
            max="5" 
            step="0.5"
            value={width}
            onChange={(e) => onWidthChange(Number(e.target.value))}
          />
          <span>{width}px</span>
        </div>
        

        <div className="subtitle">
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
            size="s"
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
          <label>不透明度</label>
          <input 
            type="range" 
            min="0" 
            max="100" 
            step="1"
            value={opacity}
            onChange={(e) => onOpacityChange(Number(e.target.value))}
          />
          <span>{opacity}%</span>
        </div>
        
        <div className="panel-footer">
          <button 
            className="save-button"
            onClick={() => {
              // 保存当前设置
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