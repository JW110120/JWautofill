import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';
import { initializeTheme } from './styles/theme.ts';
import './styles/styles.css';
import { defaultTheme, Provider } from '@adobe/react-spectrum';

// 初始化主题
initializeTheme();

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
