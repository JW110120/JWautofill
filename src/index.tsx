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

// 初始化主题
initializeTheme();





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

// 渲染新入口点应用
const newContainer = document.getElementById('newapp');
if (newContainer) {
  const newRoot = createRoot(newContainer);
  newRoot.render(<AdjustmentPanel />);
}
