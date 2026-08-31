const createThemeStyles = () => {
  const style = document.createElement('style');
  document.head.appendChild(style);
  
  style.textContent = `
    :root {
      --primary-color: rgb(38, 128, 235);
      --text-color: rgb(214, 214, 214);
      --black-text-: rgb(10, 10, 10);
      --bg-color: rgb(50, 50, 50);
      --dark-bg-color: rgb(30, 30, 30);
      /* 列表/卡片行背景：深主题比 --bg-color 稍浅，浅主题比 --bg-color 稍深，形成反差 */
      --entry-bg: rgb(64, 64, 64);
      --border-color: rgb(72, 72, 72);
      --disabled-color: rgb(132, 132, 132);
      --hover-bg: rgba(38, 128, 235, 0.1);
      --hover-icon: rgb(83, 69, 234);
      --button-bg: rgb(60, 60, 60);
      --button-down: rgb(40, 40, 40);
      --slider-bg: rgb(238, 238, 238);
      --scrollbar-thumb: rgb(192, 192, 192);
      --scrollbar-track: rgba(255, 255, 255, 0.1);
      /* 主按钮「功能开启」态文字色：深主题为白，浅主题在下方 override 为黑 */
      --enabled-text-color: rgb(255, 255, 255);
      /* 下拉菜单背景（统一设计语言，仅用 RGB 表示）：
         darkest rgb(32,32,32) / dark rgb(57,57,57) / light rgb(218,218,218) / lightest rgb(255,255,255) */
      --dropdown-bg-color: rgb(57, 57, 57);
      /* 超链接文字专用色（「联系作者」等，含下划线）。
         ⚠️ 不要复用 --primary-color：主色 rgb(38,128,235) 是中蓝，
         在 darkest/dark 深底上明度不足、看着发暗；这里按主题分别取
         「深底用亮蓝 / 浅底用深蓝」，保证四主题都清晰可辨。 */
      --link-color: rgb(122, 190, 255);
      /* 状态/文字通知配色：深主题用亮色、浅主题用深色，保证与背景反差（可读性） */
      --notify-ok-fg: rgb(74, 222, 128);
      --notify-ok-bg: rgba(46, 204, 113, 0.14);
      --notify-ok-border: rgba(74, 222, 128, 0.30);
      --notify-fail-fg: rgb(255, 107, 107);
      --notify-fail-bg: rgba(231, 76, 60, 0.16);
      --notify-fail-border: rgba(255, 107, 107, 0.30);
      --notify-warn-fg: rgb(255, 183, 77);
      --notify-warn-bg: rgba(243, 156, 18, 0.14);
      --notify-warn-border: rgba(255, 183, 77, 0.30);
      /* 模态/锁定遮罩：不透明度恒定 0.80（必须能挡住下方内容），按主题调「颜色深浅」而非透明度，
         使遮罩在各主题下都和谐、且始终可见。
         darkest 纯黑 → dark/light/lightest 逐级改用中性灰，避免浅色主题下骤降为近黑的刺眼感。 */
      --overlay-scrim: rgba(0, 0, 0, 0.80);
    }

    @media (prefers-color-scheme: darkest) {
      :root {
        --primary-color: rgb(38, 128, 235);
        --text-color: rgb(214, 214, 214);
        --black-text-: rgb(10, 10, 10);
        --bg-color: rgb(50, 50, 50);
        --dark-bg-color: rgb(30, 30, 30);
        --entry-bg: rgb(64, 64, 64);
        --border-color:rgb(95, 95, 95);
        --disabled-color:rgb(80, 80, 80);
        --hover-bg: rgba(38, 128, 235, 0.1);
        --hover-icon: rgb(38, 128, 235);
        --button-bg: rgb(60, 60, 60);
        --button-down: rgb(40, 40, 40);
        --slider-bg: rgb(238, 238, 238);
        --scrollbar-thumb: rgb(200, 200, 200);
        --scrollbar-track: rgba(255, 255, 255, 0.12);
        --dropdown-bg-color: rgb(32, 32, 32);
        --link-color: rgb(122, 190, 255);
        --notify-ok-fg: rgb(74, 222, 128);
        --notify-ok-bg: rgba(46, 204, 113, 0.15);
        --notify-ok-border: rgba(74, 222, 128, 0.30);
        --notify-fail-fg: rgb(255, 107, 107);
        --notify-fail-bg: rgba(231, 76, 60, 0.16);
        --notify-fail-border: rgba(255, 107, 107, 0.30);
        --notify-warn-fg: rgb(255, 183, 77);
        --notify-warn-bg: rgba(243, 156, 18, 0.15);
        --notify-warn-border: rgba(255, 183, 77, 0.30);
        --overlay-scrim: rgba(0, 0, 0, 0.80);
      }
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --primary-color: rgb(38, 128, 235);
        --text-color: rgb(215, 215, 215);
        --black-text-: rgb(10, 10, 10);
        --bg-color: rgb(83, 83, 83);
        --dark-bg-color: rgb(63, 63, 63);
        --entry-bg: rgb(97, 97, 97);
        --border-color:rgb(128, 128, 128);
        --disabled-color:rgb(100, 100, 100);
        --hover-bg: rgba(38, 128, 235, 0.2);
        --hover-icon:rgb(0, 115, 255); 
        --button-bg: rgb(93, 93, 93);
        --button-down: rgb(73, 73, 73);
        --slider-bg: rgb(238, 238, 238);
        --scrollbar-thumb: rgb(184, 184, 184);
        --scrollbar-track: rgba(255, 255, 255, 0.08);
        --dropdown-bg-color: rgb(57, 57, 57);
        --link-color: rgb(140, 200, 255);
        --notify-ok-fg: rgb(74, 222, 128);
        --notify-ok-bg: rgba(46, 204, 113, 0.14);
        --notify-ok-border: rgba(74, 222, 128, 0.28);
        --notify-fail-fg: rgb(255, 107, 107);
        --notify-fail-bg: rgba(231, 76, 60, 0.15);
        --notify-fail-border: rgba(255, 107, 107, 0.28);
        --notify-warn-fg: rgb(255, 183, 77);
        --notify-warn-bg: rgba(243, 156, 18, 0.14);
        --notify-warn-border: rgba(255, 183, 77, 0.28);
        --overlay-scrim: rgba(29, 29, 29, 0.80);
      }
    }

    @media (prefers-color-scheme: light) {
      :root {
        --primary-color: rgb(38, 128, 235);
        --text-color: rgb(37, 37, 37);
        --black-text-: rgb(10, 10, 10);
        --bg-color: rgb(184, 184, 184);
        --dark-bg-color: rgb(164, 164, 164);
        --entry-bg: rgb(168, 168, 168);
        --border-color:rgb(140, 140, 140);
        --disabled-color:rgb(151, 151, 151);
        --hover-bg: rgba(38, 128, 235, 0.3);
        --hover-icon:rgb(22, 127, 255);
        --button-bg: rgb(194, 194, 194);
        --button-down: rgb(174, 174, 174);
        --slider-bg: rgb(221, 221, 221);
        --scrollbar-thumb: rgb(96, 96, 96);
      --scrollbar-track: rgba(0, 0, 0, 0.1);
      /* light 主题默认 rgb(255, 255, 255) 偏亮，统一改为 rgb(225, 225, 225) */
      --enabled-text-color: rgb(10, 10, 10);
      --dropdown-bg-color: rgb(218, 218, 218);
      --link-color: rgb(0, 90, 200);
      --notify-ok-fg: rgb(21, 128, 61);
      --notify-ok-bg: rgba(21, 128, 61, 0.14);
      --notify-ok-border: rgba(21, 128, 61, 0.30);
      --notify-fail-fg: rgb(198, 40, 40);
      --notify-fail-bg: rgba(198, 40, 40, 0.12);
      --notify-fail-border: rgba(198, 40, 40, 0.30);
      --notify-warn-fg: rgb(180, 83, 9);
      --notify-warn-bg: rgba(180, 83, 9, 0.13);
      --notify-warn-border: rgba(180, 83, 9, 0.30);
      --overlay-scrim: rgba(92, 92, 92, 0.80);
    }
    }

    @media (prefers-color-scheme: lightest) {
      :root {
        --primary-color: rgb(38, 128, 235);
        --text-color: rgb(48, 48, 48);
        --black-text-: rgb(10, 10, 10);
        --bg-color: rgb(240, 240, 240);
        --dark-bg-color: rgb(220, 220, 220);
        --entry-bg: rgb(222, 222, 222);
        --border-color:rgb(196, 196, 196);
        --disabled-color:rgb(194, 194, 194);
        --hover-bg: rgba(38, 128, 235, 0.35);
        --hover-icon: rgb(38, 128, 235);
        --button-bg: rgb(250, 250, 250);
        --button-down: rgb(230, 230, 230);
        --slider-bg: rgb(221, 221, 221);
      --scrollbar-thumb: rgb(80, 80, 80);
      --scrollbar-track: rgba(0, 0, 0, 0.05);
      --enabled-text-color: rgb(10, 10, 10);
      --dropdown-bg-color: rgb(255, 255, 255);
      --link-color: rgb(0, 82, 190);
      --notify-ok-fg: rgb(21, 128, 61);
      --notify-ok-bg: rgba(21, 128, 61, 0.12);
      --notify-ok-border: rgba(21, 128, 61, 0.28);
      --notify-fail-fg: rgb(198, 40, 40);
      --notify-fail-bg: rgba(198, 40, 40, 0.10);
      --notify-fail-border: rgba(198, 40, 40, 0.28);
      --notify-warn-fg: rgb(180, 83, 9);
      --notify-warn-bg: rgba(180, 83, 9, 0.11);
      --notify-warn-border: rgba(180, 83, 9, 0.28);
      --overlay-scrim: rgba(128, 128, 128, 0.80);
    }
    }

    /*
     * 遮罩（激活弹窗 .license-dialog-overlay / 绘画工具箱锁定层 .adjustment-lock-overlay）实际配色。
     * 规则：不透明度恒定 0.80（必须挡住下方内容），主题差异体现在「颜色深浅」上
     *      （darkest 纯黑 → dark/light/lightest 逐级中性灰），浅色主题下不刺眼且始终可见。
     * 这里刻意用字面值而非 var(--overlay-scrim)：UXP 对动态注入的 var() 解析不稳定，
     * 纯 var() 写法曾出现「遮罩能拦截点击但背景完全不绘制（看不见）」的问题。
     * ⚠️ 改遮罩颜色只改这一处；上面的 --overlay-scrim 仅作文档/其它用途的同步记录。
     */
    .license-dialog-overlay,
    .adjustment-lock-overlay {
      background-color: rgba(0, 0, 0, 0.80);
    }
    @media (prefers-color-scheme: darkest) {
      .license-dialog-overlay,
      .adjustment-lock-overlay { background-color: rgba(0, 0, 0, 0.80); }
    }
    @media (prefers-color-scheme: dark) {
      .license-dialog-overlay,
      .adjustment-lock-overlay { background-color: rgba(29, 29, 29, 0.80); }
    }
    @media (prefers-color-scheme: light) {
      .license-dialog-overlay,
      .adjustment-lock-overlay { background-color: rgba(92, 92, 92, 0.80); }
    }
    @media (prefers-color-scheme: lightest) {
      .license-dialog-overlay,
      .adjustment-lock-overlay { background-color: rgba(128, 128, 128, 0.80); }
    }
  `;
};

export const initializeTheme = () => {
  createThemeStyles();
};
