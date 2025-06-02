const createThemeStyles = () => {
  const style = document.createElement('style');
  document.head.appendChild(style);
  
  style.textContent = `
    :root {
      --primary-color: #2680eb;
      --text-color: #d6d6d6;
      --black-text-: rgb(10, 10, 10);
      --bg-color: rgb(50, 50, 50);
      --dark-bg-color: rgb(30, 30, 30);
      --border-color: #484848;
      --disabled-color: #848484;
      --hover-bg: rgba(38, 128, 235, 0.1);
      --hover-icon: rgb(83, 69, 234);
      --button-bg: rgb(60, 60, 60);
      --button-down: rgb(40, 40, 40);
      --slider-bg: #eee;
    }

    @media (prefers-color-scheme: darkest) {
      :root {
        --primary-color: #2680eb;
        --text-color: #d6d6d6;
        --black-text-: rgb(10, 10, 10);
        --bg-color: rgb(50, 50, 50);
        --dark-bg-color: rgb(30, 30, 30);
        --border-color:rgb(95, 95, 95);
        --disabled-color: #848484;
        --hover-bg: rgba(38, 128, 235, 0.1);
        --hover-icon: rgb(38, 128, 235);
        --button-bg: rgb(60, 60, 60);
        --button-down: rgb(40, 40, 40);
        --slider-bg: #eee;
      }
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --primary-color: #2680eb;
        --text-color: rgb(215, 215, 215);
        --black-text-: rgb(10, 10, 10);
        --bg-color: rgb(83, 83, 83);
        --dark-bg-color: rgb(63, 63, 63);
        --border-color:rgb(128, 128, 128);
        --disabled-color: #999999;
        --hover-bg: rgba(38, 128, 235, 0.2);
        --hover-icon:rgb(0, 115, 255); 
        --button-bg: rgb(93, 93, 93);
        --button-down: rgb(73, 73, 73);
        --slider-bg: #eee;
      }
    }

    @media (prefers-color-scheme: light) {
      :root {
        --primary-color: #2680eb;
        --text-color: rgb(37, 37, 37);
        --black-text-: rgb(10, 10, 10);
        --bg-color: rgb(184, 184, 184);
        --dark-bg-color: rgb(164, 164, 164);
        --border-color:rgb(140, 140, 140);
        --disabled-color: #666666;
        --hover-bg: rgba(38, 128, 235, 0.3);
        --hover-icon:rgb(22, 127, 255);
        --button-bg: rgb(194, 194, 194);
        --button-down: rgb(174, 174, 174);
        --slider-bg: #ddd;
      }
    }

    @media (prefers-color-scheme: lightest) {
      :root {
        --primary-color: #2680eb;
        --text-color: rgb(48, 48, 48);
        --black-text-: rgb(10, 10, 10);
        --bg-color: rgb(240, 240, 240);
        --dark-bg-color: rgb(220, 220, 220);
        --border-color:rgb(196, 196, 196);
        --disabled-color: #909090;
        --hover-bg: rgba(38, 128, 235, 0.35);
        --hover-icon: rgb(38, 128, 235);
        --button-bg: rgb(250, 250, 250);
        --button-down: rgb(230, 230, 230);
        --slider-bg: #ddd;
      }
    }
  `;
};

export const initializeTheme = () => {
  createThemeStyles();
};