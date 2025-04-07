const createThemeStyles = () => {
  const style = document.createElement('style');
  document.head.appendChild(style);
  
  style.textContent = `
    :root {
      --primary-color: #2680eb;
      --text-color: #d6d6d6;
      --bg-color:rgb(50, 50, 50);
      --border-color: #484848;
      --disabled-color: #848484;
      --hover-bg: rgba(38, 128, 235, 0.1);
      --button-bg: rgb(50, 50, 50);
      --slider-bg: #eee;
      --slider-thumb: #2680eb;
    }

    @media (prefers-color-scheme: darkest) {
      :root {
        --primary-color: #2680eb;
        --text-color: #d6d6d6;
        --bg-color:rgb(50, 50, 50);
        --border-color: #484848;
        --disabled-color: #848484;
        --hover-bg: rgba(38, 128, 235, 0.1);
        --button-bg: rgb(50, 50, 50);
        --slider-bg: #eee;
        --slider-thumb: #2680eb;
      }
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --primary-color: #2680eb;
        --text-color: rgb(215, 215, 215);
        --bg-color: rgb(83, 83, 83);
        --border-color: #555555;
        --disabled-color: #999999;
        --hover-bg: rgba(38, 128, 235, 0.1);
        --button-bg: rgb(80, 80, 80);
        --slider-bg: #eee;
        --slider-thumb: #2680eb;
      }
    }

    @media (prefers-color-scheme: light) {
      :root {
        --primary-color: #2680eb;
        --text-color: rgb(37, 37, 37);
        --bg-color: rgb(184, 184, 184);
        --border-color: #a0a0a0;
        --disabled-color: #666666;
        --hover-bg: rgba(38, 128, 235, 0.05);
        --button-bg: rgb(184, 184, 184);
        --slider-bg: #ddd;
        --slider-thumb: #2680eb;
      }
    }

    @media (prefers-color-scheme: lightest) {
      :root {
        --primary-color: #2680eb;
        --text-color: rgb(48, 48, 48);
        --bg-color: rgb(240, 240, 240);
        --border-color: #c4c4c4;
        --disabled-color: #909090;
        --hover-bg: rgba(38, 128, 235, 0.03);
        --button-bg: rgb(240, 240, 240);
        --slider-bg: #ddd;
        --slider-thumb: #2680eb;
      }
    }
  `;
};

export const initializeTheme = () => {
  createThemeStyles();
};