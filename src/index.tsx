// ⚠️ 必须最先加载：修补 UXP 的 performance.mark/measure，否则 React 19 dev 构建
// 首次渲染即抛 NotFoundError 并进入 "Should not already be working" 死锁，面板停止渲染
import './uxpPerfPatch';
// ⚠️ 整体样式入口必须最先加载：common.css 承担全局基础（@font-face / html,body）
// 与通用组件（滑块/按钮/开关/radio/checkbox/图标按钮/拖拽光标锁）的视觉规则，
// 其后各面板 CSS（app.css = #app 主面板，adjustment.css = 工具箱）只保留面板独有布局。
// 改通用组件只需动 common.css 一处，所有面板同步生效，杜绝「某面板漏改导致漂移」。
import './styles/common.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';
import { initializeTheme } from './styles/theme.ts';
import './styles/app.css';
// 激活弹窗（LicenseDialog）独立样式：必须在 common.css / app.css 之后引入，
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
      /* ⚠️ height="100%" 不能省：Provider 会在 #app 与 .app-root 之间再插一层 div，
         这层 div 默认 height:auto，会截断「#app → … → .app-scroll-area」的百分比高度链，
         使滚动区高度退化为内容高 → 主面板永远不出现滚动条（内容被裁掉）。
         绘画工具箱的 Provider 一直带这个属性，所以它滚动正常，主面板没有——差异全在这里。 */
      <Provider theme={defaultTheme} colorScheme="dark" height="100%">
        {/* 布局样式见 app.css 的 .app-root */}
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
