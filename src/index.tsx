import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './app';

console.log('✅ index.tsx 加载完成');

const rootElement = document.getElementById('app');
if (rootElement) {
    console.log('✅ 找到 rootElement，开始渲染 App');
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App />);
} else {
    console.error('❌ 未找到 #app 元素，插件可能未正确加载');
}
