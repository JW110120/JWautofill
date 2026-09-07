# JWautofill 长期记忆

## 设计规范
- 禁 HEX，一律 rgb()/rgba() 走 theme.ts 主题变量（--bg-color/--text-color/--entry-bg/--border-color/--primary-color/--hover-bg/--notify-*）。遮罩 0.80 字面写，禁 var(--overlay-scrim)。
- 术语：APP(src/app.tsx) 与 AdjustmentPanel 均「父面板」；描边/渐变/纯色/图案=「子面板」(APP 内 absolute)。UXP 不支持 flex gap→一律 margin。

## 面板高度链（滚动命脉）
- APP：uxp-panel→#app→Provider(100%)→.app-root→.app-root>.panel（最外层滚动容器）→.panel-section（flex:0 0 auto；纵向须挂 panel-section--col，否则继承 flex-row）。内层滚动 .panel 已删；common.css 对 .panel>* 统一 flex-shrink:0 兜底。
- 4 子面板=同层 .panel，靠 input-fix.css `#app .panel-section ~ .panel`(absolute+z9999) 识别；子面板开时 body.secondary-panel-open 只锁 .app-root>.panel。工具箱：#pixeladjustment→.pixeladjustment-root(flex列)→.panel(min-height:0;overflow-y:auto)。
- 新增包裹层必须带高度，不可裸 height:auto 夹定高链；每层铺 --bg-color。

## UXP 避坑
- 原生 input 画最上层、overflow 裁不住→折叠分区条件渲染；数字输入 32×24、单位在容器外(.num-unit)。
- JS 测量尺寸不可靠→铺满背景用整数 px 格子过量渲染+overflow:hidden；% 小数坐标必出亚像素缝；棋盘格方块+1px 重叠盖缝、底板 inset:0+OVERSCAN。
- imaging.getPixels 把 sourceBounds 裁到图层 bounds 再重采样到 targetSize（小图层按大区域请求=拉伸）。正确：滤镜后取 layer.bounds→只请求「需要区∩bounds」→source 与 targetSize 严格 1:1；解析用 imageData.width/height 并守卫 raw.length。
- 历史压缩：batchPlay+putPixels 包 doc.suspendHistory；内部已有则传 {skipHistorySuspend:true}。
- storage.formats 只有 binary/utf8 无 base64；file.read({format:undefined}) 静默乱码，读图 binary→btoa。
- 弹窗用 core.showAlert（dialogs.alert 在 PS 只进控制台）；跨分区回调折叠即 null，bridge 层兜底。
- sp-radio 影子布局把 slot 排行右侧：radio 行内自绘元素走文档流，勿绝对定位 pin 边缘。

## common.css 单一来源
- index.tsx 顺序 uxpPerfPatch→common→app→license；严禁 @import。滑块/数字输入/按钮/radio/checkbox/折叠/通知/滚动条均已收口。.panel=外壳(padding10+overflow)、.panel-section=区块(row，列加 --col)。
- 状态样式统一放 common.css 最底部「集中管理区」；状态类只写修饰差异，盒模型与基础类共享。选中/落点视觉一律 border 变色（基础类挂 transparent 占位），禁 outline。
- 通知：.status-banner=通用横幅(min-height:30px 不定高)、.notify-bar=单行状态条、.notify-text 唯一定义。hover title 收口 helpTexts.ts。

- 布局：标签 W(n)=20+(n-2)×13.33(2..6字)；按钮宽=字数×字号+20；数字输入 32×24。两列 radio margin 下限 40px、三列 20px。

## 像素算法
- lineSmoothProcessor(SDF)：全局量绝不被选区截断，选区只定写回范围；跨选区邻居判定用 effAlpha（选区内=平滑结果、外=原值）。任一环截断→选区边缘透明环。binaryOpen 全范围+越界跳过。
- edge 模式参数=mode/edgeMedianRadius/lineSmoothStrength/lineSmoothRadius 四字段。toggles.preserveDetail 与 highFrequencyEnhancer.intensity 是别的功能同名物，勿误删。

## 守护进程与键盘冻结
- C#/.NET8 daemon（native/HotkeyDaemon/Program.cs）：WH_KEYBOARD_LL 独立线程；钩子线程严禁阻塞 I/O（日志 QueueTextWriter、SendToClient 走 Task.Run）；焦点闸门 IsPhotoshopForeground 否则放行。WS 127.0.0.1:18923；日志 %LOCALAPPDATA%\JWautofill\daemon\daemon.log。
- 冻结三形态与 ps1 七步详见技能 windows-keyboard-device-reset。③「按键不停重复」=设备层键卡按下态，应急先按同一键；改 ps1 后同步 dist/（exe 无哈希校验即生效）。
- shell.openPath 受 manifest 扩展名白名单管控。前端改完须 UDT Reload。
- daemon 重编：SDK 8.0.424 在 C:\Users\Administrator\.dotnet-sdk（永不删）；坑见技能 dotnet-publish-windows。

## Git/环境
- ⚠️ .git/refs/remotes/origin/ 曾缺失→fetch 报成功但 origin/main 不更新（假成功），status 恒显 ahead；修法 mkdir 后 git update-ref。推送用 `git -c credential.helper=wincred push`（凭据在管理器 JW110120）。
- dist/、analysis/、outputs/ 均 gitignore；入库大文件 FixKeyboard.exe(73MB)、daemon publish exe(64MB)，<100MB 上限。
