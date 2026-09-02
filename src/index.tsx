// ⚠️ 必须最先加载：修补 UXP 的 performance.mark/measure，否则 React 19 dev 构建
// 首次渲染即抛 NotFoundError 并进入 "Should not already be working" 死锁，面板停止渲染
import './uxpPerfPatch';
// ⚠️ 通用组件样式「单一来源」必须最先加载：common.css 定义滑块/按钮/开关/radio/
// checkbox/图标按钮/拖拽光标锁的视觉规则，其后各面板 CSS 只保留面板独有布局。
// 改通用组件只需动 common.css 一处，所有面板同步生效，杜绝「某面板漏改导致漂移」。
import './styles/common.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';
import { initializeTheme } from './styles/theme.ts';
import './styles/styles.css';
// 激活弹窗（LicenseDialog）独立样式：必须在 styles.css 之后引入，
// 让弹窗规则排在面板规则之后（原先是组件内 <style>，注入时机最晚）。
import './styles/license.css';
import { defaultTheme, Provider } from '@adobe/react-spectrum';
import ColorSettingsPanel from './components/ColorSettingsPanel';
import PatternPicker from './components/PatternPicker';
import GradientPicker from './components/GradientPicker';
import AdjustmentPanel from './adjustments/AdjustmentPanel';
import { MenuManager } from './utils/MenuManager';

// 初始化主题
initializeTheme();

// 设置所有面板的菜单
MenuManager.setup();





// 渲染主应用
const container = document.getElementById('app');
if (container) {
  const root = createRoot(container);
  
  // 创建根组件
  const Root = () => {
    return (
      <Provider theme={defaultTheme} colorScheme="dark">
        {/* 布局样式见 styles.css 的 .app-root */}
        <div className="app-root">
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
      <Provider theme={defaultTheme} colorScheme="dark" height="100%">
        {/* 布局样式见 adjustment.css 的 .pixeladjustment-root */}
        <div className="pixeladjustment-root">
          <AdjustmentPanel />
        </div>
      </Provider>
    );
  };

  pixelAdjustmentRoot.render(<PixelAdjustmentRoot />);
}
