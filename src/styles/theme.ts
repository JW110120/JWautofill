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
        --notify-ok-fg: rgb(74, 222, 128);
        --notify-ok-bg: rgba(46, 204, 113, 0.15);
        --notify-ok-border: rgba(74, 222, 128, 0.30);
        --notify-fail-fg: rgb(255, 107, 107);
        --notify-fail-bg: rgba(231, 76, 60, 0.16);
        --notify-fail-border: rgba(255, 107, 107, 0.30);
        --notify-warn-fg: rgb(255, 183, 77);
        --notify-warn-bg: rgba(243, 156, 18, 0.15);
        --notify-warn-border: rgba(255, 183, 77, 0.30);
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
        --notify-ok-fg: rgb(74, 222, 128);
        --notify-ok-bg: rgba(46, 204, 113, 0.14);
        --notify-ok-border: rgba(74, 222, 128, 0.28);
        --notify-fail-fg: rgb(255, 107, 107);
        --notify-fail-bg: rgba(231, 76, 60, 0.15);
        --notify-fail-border: rgba(255, 107, 107, 0.28);
        --notify-warn-fg: rgb(255, 183, 77);
        --notify-warn-bg: rgba(243, 156, 18, 0.14);
        --notify-warn-border: rgba(255, 183, 77, 0.28);
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
      --notify-ok-fg: rgb(21, 128, 61);
      --notify-ok-bg: rgba(21, 128, 61, 0.14);
      --notify-ok-border: rgba(21, 128, 61, 0.30);
      --notify-fail-fg: rgb(198, 40, 40);
      --notify-fail-bg: rgba(198, 40, 40, 0.12);
      --notify-fail-border: rgba(198, 40, 40, 0.30);
      --notify-warn-fg: rgb(180, 83, 9);
      --notify-warn-bg: rgba(180, 83, 9, 0.13);
      --notify-warn-border: rgba(180, 83, 9, 0.30);
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
      --notify-ok-fg: rgb(21, 128, 61);
      --notify-ok-bg: rgba(21, 128, 61, 0.12);
      --notify-ok-border: rgba(21, 128, 61, 0.28);
      --notify-fail-fg: rgb(198, 40, 40);
      --notify-fail-bg: rgba(198, 40, 40, 0.10);
      --notify-fail-border: rgba(198, 40, 40, 0.28);
      --notify-warn-fg: rgb(180, 83, 9);
      --notify-warn-bg: rgba(180, 83, 9, 0.11);
      --notify-warn-border: rgba(180, 83, 9, 0.28);
    }
    }
  `;
};

export const initializeTheme = () => {
  createThemeStyles();
};
