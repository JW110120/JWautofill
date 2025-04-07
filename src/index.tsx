import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import './styles.css';  
import App from './app';

const rootElement = document.getElementById('app');
if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App />);
} else {
    console.error('❌ 未找到 #app 元素，插件可能未正确加载');
}
