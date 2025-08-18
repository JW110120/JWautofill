import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';
import { initializeTheme } from './styles/theme.ts';
import './styles/styles.css';
import { defaultTheme, Provider } from '@adobe/react-spectrum';
import ColorSettingsPanel from './components/ColorSettingsPanel';
import PatternPicker from './components/PatternPicker';
import GradientPicker from './components/GradientPicker';
import AdjustmentPanel from './adjustments/AdjustmentPanel';
import { AdjustmentPanelFlyout } from './adjustments/AdjustmentPanelFlyout';

// 初始化主题
initializeTheme();

// 设置调整面板的浮动菜单
AdjustmentPanelFlyout.setup();





// 渲染主应用
const container = document.getElementById('app');
if (container) {
  const root = createRoot(container);
  
  // 创建根组件
  const Root = () => {
    return (
      <Provider theme={defaultTheme} colorScheme="dark">
        <div style={{ 
          width: '100%', 
          height: '100%', 
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-start',
          alignItems: 'center'
        }}>
          <App />
        </div>
      </Provider>
    );
  };

  root.render(<Root />);
}

// 渲染像素调整应用
const pixelAdjustmentContainer = document.getElementById('pixeladjustment');
if (pixelAdjustmentContainer) {
  const pixelAdjustmentRoot = createRoot(pixelAdjustmentContainer);
  
  // 创建像素调整根组件
  const PixelAdjustmentRoot = () => {
    return (
      <Provider theme={defaultTheme} colorScheme="dark">
        <div style={{ 
          width: '100%', 
          height: '100%', 
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-start',
          alignItems: 'center',
          backgroundColor: 'var(--bg-color)',
          color: 'var(--text-color)'
        }}>
          <AdjustmentPanel />
        </div>
      </Provider>
    );
  };

  pixelAdjustmentRoot.render(<PixelAdjustmentRoot />);
}
