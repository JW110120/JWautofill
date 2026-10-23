/**
 * 主题变量的唯一注入点（运行时 <style>）。
 *
 * ⛔⛔ 注释**一律写在块外**（规则/at-rule 之前），绝不能写在 `{ }` 里。
 *    理由是 UXP 的 devtools 会把「声明块内的注释」当成一条声明去解析
 *    （`parseCSSDeclaration`），随即抛 `CssSyntaxError: Unknown word` /
 *    `Missed semicolon`，在控制台里每个注释一条、把日志刷满（真机复现：
 *    `console-*.log` 里 10 余条 `Error while parsing 'inline' CSS style sheet`，
 *    source 字段就是这些注释原文）。语法本身没错（浏览器语义下注释合法），
 *    但 UXP 的解析器会报未捕获异常，且 Styles 面板对应规则显示不全。
 *    `src/styles/*.css` 一直是「注释在规则外」的写法，所以只有本文件报错 ——
 *    本次把本文件的注释也全部上提到块外，与 CSS 文件保持同一种结构。
 *    下面按 `:root` 里的出现顺序逐项说明，改动数值时同步改这里的文字。
 *
 * 变量说明（基础 :root / 深色主题）：
 *   --entry-bg              列表/卡片行背景：深主题比 --bg-color 稍浅，浅主题比 --bg-color 稍深，形成反差
 *   --active-icon           图标按钮「按下」态图标色：比 --hover-icon 稍暗的同色相蓝。
 *                           按下前基本已处于 hover，故需一个可辨识的更暗档才看得出变化；
 *                           深色主题上 hover-icon 本就偏紫，按下统一回到主色蓝的暗档。
 *   --latched-bg             ⚠️ 只在基础 :root 定义一次 —— 这是一对**自洽**配色（图标压在胶囊上，
 *   --latched-icon          而非压在主题底色上），四个主题共用同一组值即可；各 @media 块不重定义
 *                           时会自然继承本处，无需逐块复制。
 *                           ⚠️ 为什么不复用 --text-color / --hover-icon 当图标色：主色蓝在 lightest
 *                           主题的 240 灰底上仅 2.9:1，达不到 WCAG 非文本 3:1（用户既定阈值）。
 *                           ✅ 实测对比度：rgb(255,255,255) 对 rgb(38,128,235) = 3.9:1。
 *   --enabled-text-color    主按钮「功能开启」态文字色：深主题为白，浅主题在下方 override 为黑。
 *   --control-handle-off-color  自绘开关**关闭态手柄**的灰色（2026-10-23，取代已退役的
 *                           --control-handle-color）：随主题变灰且与轨道灰有反差 ——
 *                           轨道是 --border-color@0.8（深主题暗灰 / 亮主题浅灰），
 *                           故手柄取反向档：**深主题亮灰、亮主题深灰**。
 *                           ⚠️ 用户明确要求关闭态不再是白/黑；滑块手柄与 radio 选中点
 *                           已一并改为 --primary-color，故旧手柄令牌全线退役。
 *                           ⛔ 2026-10-23 二次调档（用户：「手柄与背景反差偏大，暗主题压暗一点、
 *                           亮主题提亮一点」）：四档统一收敛到**约 2:1**（手柄 vs 轨道合成色），
 *                           此前 darkest 4.30 / dark 2.62 / light 2.03 / lightest 3.83 —— 严重不齐。
 *                           现在 darkest 136(≈2.06) / dark 176(≈2.05) / light 112(≈1.66) /
 *                           lightest 138(≈2.16)。亮主题刻意再松一档：浅底上的深色点天生更「跳」。
 *                           改值前先算对比度：(L_knob+0.05)/(L_track+0.05)，轨道 L 由
 *                           border@0.8 压在 bg 上合成（darkest 86 / dark 119 / light 149 / lightest 205）。
 *   --switch-track-on-color     自绘开关**开启态轨道**的半透明蓝（2026-10-23）：
 *                           四主题同值（--primary-color 本就在四主题恒定），效果类似
 *                           notify-bar-ok（通透蓝底 + 实心蓝点）。只在 :root 定义一次。
 *   --dropdown-bg-color     下拉菜单背景（统一设计语言，仅用 RGB 表示）：
 *                           darkest rgb(32,32,32) / dark rgb(57,57,57) / light rgb(218,218,218) / lightest rgb(255,255,255)
 *   --link-color            超链接文字专用色（「联系作者」等，含下划线）。
 *                           ⚠️ 不要复用 --primary-color：主色 rgb(38,128,235) 是中蓝，
 *                           在 darkest/dark 深底上明度不足、看着发暗；这里按主题分别取
 *                           「深底用亮蓝 / 浅底用深蓝」，保证四主题都清晰可辨。
 *   --notify-*              状态/文字通知配色：warn/fail 深主题用亮色、浅主题用深色，保证与背景反差（可读性）。
 *                           ⚠️ 2026-10-23 起 ok 档（--notify-ok-fg/bg/border）**四主题统一主色蓝**
 *                           （= --primary-color 恒值 rgb(38,128,235)，不再有各档深浅绿）：用户要求
 *                           「成功态与状态灯统一为 primary-color」，与滑块填充 / 开关胶囊同一视觉语言；
 *                           bg/border 仍按主题保留不同透明度（底色深浅不同，同一透明度观感不同）。
 *   --overlay-scrim         模态/锁定遮罩：不透明度恒定 0.80（必须能挡住下方内容），按主题调「颜色深浅」而非透明度，
 *                           使遮罩在各主题下都和谐、且始终可见。
 *                           darkest 纯黑 → dark/light/lightest 逐级改用中性灰，避免浅色主题下骤降为近黑的刺眼感。
 */
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
      --entry-bg: rgb(64, 64, 64);
      --border-color: rgb(72, 72, 72);
      --disabled-color: rgb(132, 132, 132);
      --hover-bg: rgba(38, 128, 235, 0.1);
      --hover-icon: rgb(83, 69, 234);
      --active-icon: rgb(17, 103, 205);
      --latched-bg: rgb(38, 128, 235);
      --latched-icon: rgb(255, 255, 255);
      --button-bg: rgb(60, 60, 60);
      --button-down: rgb(40, 40, 40);
      --slider-bg: rgb(238, 238, 238);
      --scrollbar-thumb: rgb(192, 192, 192);
      --scrollbar-track: rgba(255, 255, 255, 0.1);
      --enabled-text-color: rgb(255, 255, 255);
      /* 2026-10-23：--control-handle-color / --radio-checked-color 退役（滑块手柄、
         radio 选中点改 --primary-color，开关关闭态手柄改 --control-handle-off-color）。 */
      /* 关闭态手柄：darkest 专用档（轨道合成色 ≈86，对比 ≈2.06:1）。 */
      --control-handle-off-color: rgb(136, 136, 136);
      --switch-track-on-color: rgba(38, 128, 235, 0.28);
      --dropdown-bg-color: rgb(57, 57, 57);
      --link-color: rgb(122, 190, 255);
      --notify-ok-fg: rgb(38, 128, 235);
      --notify-ok-bg: rgba(38, 128, 235, 0.14);
      --notify-ok-border: rgba(38, 128, 235, 0.30);
      --notify-fail-fg: rgb(255, 107, 107);
      --notify-fail-bg: rgba(231, 76, 60, 0.16);
      --notify-fail-border: rgba(255, 107, 107, 0.30);
      --notify-warn-fg: rgb(255, 183, 77);
      --notify-warn-bg: rgba(243, 156, 18, 0.14);
      --notify-warn-border: rgba(255, 183, 77, 0.30);
      --overlay-scrim: rgba(0, 0, 0, 0.80);
    }

    /* darkest：与上面的基础 :root 同值（该主题即项目默认的「深色」档）。 */
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
        --active-icon: rgb(17, 103, 205);
        --button-bg: rgb(60, 60, 60);
        --button-down: rgb(40, 40, 40);
        --slider-bg: rgb(238, 238, 238);
        --scrollbar-thumb: rgb(200, 200, 200);
        --scrollbar-track: rgba(255, 255, 255, 0.12);
        --dropdown-bg-color: rgb(32, 32, 32);
        --link-color: rgb(122, 190, 255);
        --notify-ok-fg: rgb(38, 128, 235);
        --notify-ok-bg: rgba(38, 128, 235, 0.15);
        --notify-ok-border: rgba(38, 128, 235, 0.30);
        --notify-fail-fg: rgb(255, 107, 107);
        --notify-fail-bg: rgba(231, 76, 60, 0.16);
        --notify-fail-border: rgba(255, 107, 107, 0.30);
        --notify-warn-fg: rgb(255, 183, 77);
        --notify-warn-bg: rgba(243, 156, 18, 0.15);
        --notify-warn-border: rgba(255, 183, 77, 0.30);
        --overlay-scrim: rgba(0, 0, 0, 0.80);
      }
    }

    /* dark（中灰档）。本块内 --active-icon 的说明：浅色主题背景更亮，按下态需比 hover 明显更暗才看得出变化。 */
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
        --active-icon: rgb(0, 82, 184);
        --button-bg: rgb(93, 93, 93);
        --button-down: rgb(73, 73, 73);
        --slider-bg: rgb(238, 238, 238);
        --scrollbar-thumb: rgb(184, 184, 184);
        --scrollbar-track: rgba(255, 255, 255, 0.08);
        --dropdown-bg-color: rgb(57, 57, 57);
        --link-color: rgb(140, 200, 255);
        /* 关闭态手柄：dark 专用档（轨道合成色 ≈119，对比 ≈2.05:1）。
           ⚠️ 必须在本块显式写：不写会继承基础 :root 的 darkest 档 136，
           在更亮的 119 轨道上反差会掉到 1.2 左右（几乎看不见）。 */
        --control-handle-off-color: rgb(176, 176, 176);
        --notify-ok-fg: rgb(38, 128, 235);
        --notify-ok-bg: rgba(38, 128, 235, 0.14);
        --notify-ok-border: rgba(38, 128, 235, 0.28);
        --notify-fail-fg: rgb(255, 107, 107);
        --notify-fail-bg: rgba(231, 76, 60, 0.15);
        --notify-fail-border: rgba(255, 107, 107, 0.28);
        --notify-warn-fg: rgb(255, 183, 77);
        --notify-warn-bg: rgba(243, 156, 18, 0.14);
        --notify-warn-border: rgba(255, 183, 77, 0.28);
        --overlay-scrim: rgba(29, 29, 29, 0.80);
      }
    }

    /* light（浅灰档）。本块内说明：
       · --scrollbar-track：light 主题默认 rgb(255,255,255) 偏亮，统一改为 rgba(0,0,0,0.1)。
       · 2026-10-23：notify-ok 档统一主色蓝（见文件头 --notify-* 说明），
         亮主题不再需要「加深绿」特例；bg/border 透明度沿用既有档位。
       · 2026-10-23：--control-handle-off-color 取中深灰（浅灰轨道 ≈149 上的反差档，
         对比 ≈1.66:1 —— 用户要求「亮主题下提亮一点」，比旧的 98 更松一档）。 */
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
        --active-icon: rgb(0, 82, 184);
        --button-bg: rgb(194, 194, 194);
        --button-down: rgb(174, 174, 174);
        --slider-bg: rgb(221, 221, 221);
        --scrollbar-thumb: rgb(96, 96, 96);
      --scrollbar-track: rgba(0, 0, 0, 0.1);
      --enabled-text-color: rgb(10, 10, 10);
      --dropdown-bg-color: rgb(218, 218, 218);
      --link-color: rgb(0, 90, 200);
      --control-handle-off-color: rgb(112, 112, 112);
      --notify-ok-fg: rgb(38, 128, 235);
      --notify-ok-bg: rgba(38, 128, 235, 0.14);
      --notify-ok-border: rgba(38, 128, 235, 0.30);
      --notify-fail-fg: rgb(198, 40, 40);
      --notify-fail-bg: rgba(198, 40, 40, 0.12);
      --notify-fail-border: rgba(198, 40, 40, 0.30);
      --notify-warn-fg: rgb(180, 83, 9);
      --notify-warn-bg: rgba(180, 83, 9, 0.13);
      --notify-warn-border: rgba(180, 83, 9, 0.30);
      --overlay-scrim: rgba(92, 92, 92, 0.80);
    }
    }

    /* lightest（近白档）。本块内说明：notify-ok 档 2026-10-23 起统一主色蓝（四主题同值，
       见文件头 --notify-* 说明），bg/border 透明度按既有档位（0.12 / 0.28）。
       2026-10-23：滑块手柄/radio 选中点统一 --primary-color（纯黑手柄档退役），本块只需给
       开关关闭态手柄一个中灰（--control-handle-off-color 138）—— 近白底上的浅灰轨道
       （--border-color rgb(196)@0.8，合成 ≈205）用 138 得 ≈2.16:1，与其它三档对齐。 */
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
        --active-icon: rgb(17, 103, 205);
        --button-bg: rgb(250, 250, 250);
        --button-down: rgb(230, 230, 230);
        --slider-bg: rgb(221, 221, 221);
      --scrollbar-thumb: rgb(80, 80, 80);
      --scrollbar-track: rgba(0, 0, 0, 0.05);
      --enabled-text-color: rgb(10, 10, 10);
      --dropdown-bg-color: rgb(255, 255, 255);
      --link-color: rgb(0, 82, 190);
      --control-handle-off-color: rgb(138, 138, 138);
      --notify-ok-fg: rgb(38, 128, 235);
      --notify-ok-bg: rgba(38, 128, 235, 0.12);
      --notify-ok-border: rgba(38, 128, 235, 0.28);
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
     * 遮罩（通用悬浮窗口遮罩 .float-overlay / 绘画工具箱锁定层 .adjustment-lock-overlay）实际配色。
     * 规则：不透明度恒定 0.80（必须挡住下方内容），主题差异体现在「颜色深浅」上
     *      （darkest 纯黑 → dark/light/lightest 逐级中性灰），浅色主题下不刺眼且始终可见。
     * 这里刻意用字面值而非 var(--overlay-scrim)：UXP 对动态注入的 var() 解析不稳定，
     * 纯 var() 写法曾出现「遮罩能拦截点击但背景完全不绘制（看不见）」的问题。
     * ⚠️ 改遮罩颜色只改这一处；上面的 --overlay-scrim 仅作文档/其它用途的同步记录。
     */
    .float-overlay,
    .adjustment-lock-overlay {
      background-color: rgba(0, 0, 0, 0.80);
    }
    @media (prefers-color-scheme: darkest) {
      .float-overlay,
      .adjustment-lock-overlay { background-color: rgba(0, 0, 0, 0.80); }
    }
    @media (prefers-color-scheme: dark) {
      .float-overlay,
      .adjustment-lock-overlay { background-color: rgba(29, 29, 29, 0.80); }
    }
    @media (prefers-color-scheme: light) {
      .float-overlay,
      .adjustment-lock-overlay { background-color: rgba(92, 92, 92, 0.80); }
    }
    @media (prefers-color-scheme: lightest) {
      .float-overlay,
      .adjustment-lock-overlay { background-color: rgba(128, 128, 128, 0.80); }
    }
  `;
};

export const initializeTheme = () => {
  createThemeStyles();
};
