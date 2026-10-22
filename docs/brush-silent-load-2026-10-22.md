# 静默装笔：样本机制拆解与我们的落地选择（2026-10-22）

> 目标：点一下画笔 = 直接可用。**不弹「新建画笔」框、不在画笔预设里留东西。**

---

## 一、样本插件到底怎么做的（已从二进制确认）

样本是 CEP 扩展，共 3 层。每一条都有文件与字节级证据，不是推测。

### 1. 界面层（`js/app.js`）

```js
// 每支笔对应一个同名 jsx 脚本，点一下就是 eval 它
$scope.selectBrush = function(brush, type) {
    var name = (type == 1) ? brush.normal.name : brush.extra.name;
    ui.evalScript("$._ext.evalFile('" + name + "')").then(function() {
        ui.evalScript("$._ext.evalFile('zhushou')");   // 再跑一遍「助手」
    });
};
```

- 笔刷清单是 `readDir()` 扫出来的，凡文件名匹配 `^\d+` 的都算一支笔。
- 每支笔除了主脚本 `<n>-<m>.jsx`，还可能有一份 `<n>-<m>e.jsx`（变体）和 `S…/R…`（保存/复位）。
- 实际目录在整个磁盘上只有两处：

| 内容 | 路径 | 数量 |
|---|---|---|
| 笔刷脚本 `.jsx` | `C:\Windows\security\database\gast\` | 2217 |
| 笔刷数据 `.tpl` | `C:\Windows\Performance\WinSAT\DataStore2\` | 1085 |
| 笔刷库 `.abr` | 同上 | 22 |

（这两个目录名是刻意伪装成系统目录的，跟功能无关。）

### 2. 单笔脚本（`1-1.jsx`，JSXBIN 编码）

解码规律：**每两个字符为一组，第二字符 +0x1F 就是原文**
（`jTjFjMjFjDjU` → `select`，`jEjFjMjFjUjF` → `delete`，`jUjPjPjMiQjSjFjTjFjU` → `toolPreset`）。

解出来的动作序列：

```jsx
ref.putName(charIDToTypeID("toolPreset"), "1-1");
desc.putReference(charIDToTypeID("null"), ref);
executeAction(stringIDToTypeID("select"), desc, DialogModes.NO);   // ① 选中同名工具预设
executeAction(stringIDToTypeID("delete"), desc, DialogModes.NO);   // ② 删掉它（清上次残留）
app.load(new File(".../1-1.tpl"));                                 // ③ 静默载入
```

**关键结论：它加载的是「工具预设」（tool preset），不是画笔预设（brush preset）。**

这就是用户观察到的那三件事的真正原因：

| 用户观察 | 真实原因 |
|---|---|
| 从不弹「新建画笔」框 | 它根本不调 `defineBrush`，`app.load` 载入预设不弹框 |
| 画笔预设里一个都不多 | 装的是**工具预设**，进的是工具预设面板 |
| 感觉"作为工具加载、选择即用" | 工具预设一载入，当前工具（含笔尖+全部参数）立刻变成那支笔 |

为什么"用到混合器的笔不能正常生效"也解释了：`.tpl` 绑定具体工具类型
（画笔 / 混合器画笔），样本里的 `zhushou.jsx` 走的是 `putClass(hardTool)` 那条路，
工具类型没跟着切过去时，混合器类笔刷就只有形没有实。

### 3. 助手脚本（`zhushou.jsx`，8053 字节）

它干的是另一件事：内联了一整块 **`toolRecording` 二进制**，然后

```jsx
desc.putData(charIDToTypeID("toolRecording"), <binary>);
executeAction(stringIDToTypeID("toolRecording"), desc, DialogModes.NO);
```

`toolRecording` 是 PS 的「工具录制」通道，能把一整份工具状态直接灌进当前工具。
**这是比载入文件更彻底的无痕形态**（连预设都不存在），但二进制格式私有、
与大版本绑定，且样本自己也是把字节硬编码在脚本里的。

---

## 二、为什么不能直接照抄

样本是 **CEP** 扩展，能用 ExtendScript 的 `app.load(File)`。
我们是 **UXP**（`manifestVersion 4`，无 CSXS），**没有 `app.load`**。

UXP 里能做的只有 `batchPlay`，而载入预设文件（`.tpl` / `.abr`）的命令名与参数
形态没有公开文档。硬试的代价是又一次让用户当测试员 —— 前三轮已经这样烧掉太多次。

另外两点也不允许照抄：

- `.tpl` 里的笔尖像素走的是 `8BIM/tpbd` 私有资源 + `sampledData` 的 **UUID 引用**，
  自造等于复刻 PS 私有格式；
- 样本 `.abr` 用的是新版块结构（`00 0a 00 02` + `8BIM`/`samp`），
  PS 2026 自带的 `Legacy Brushes.abr` 也是同一形态 —— 都不是公开文档里的老 `8BAM` v6。

---

## 三、我们采用的方案：把「工具状态」缓存下来

### 依据（用户真机验证过的两句话）

1. 「删掉预设后，画笔工具**不会**自动切成别的笔刷，还停在那支笔上。」
2. 「三个步骤都没黄点」——即 `set` 整份 `currentToolOptions` 到 `paintbrushTool` 是通的。

第 1 句说明：**采样笔尖的数据活在工具运行时状态里，不靠画笔预设续命。**
第 2 句说明：**这份状态可以整份灌回去。**

### 于是

```
首次点击某支笔：
    define（PS 会弹一次「新建画笔」框，这是 PS 27 的固有行为，绕不过）
    → 选中 → 下发参数 → 【get currentToolOptions 存盘】 → 删掉预设

之后每次点击：
    【set currentToolOptions 回来】 → 回读校验 → 重新下发参数
    = 不调 defineBrush ⇒ 不弹框
    = 不建预设 ⇒ 面板零痕迹
```

缓存位置：`getDataFolder()/brushstate/<id>.json`，只存 `brush / opacity / flow`。

### 三层校验（少一层就会"名字对、笔尖是空心圆"）

| 层 | 判据 | 不通过的含义 |
|---|---|---|
| ① | `set` 不抛错 | 整份状态被 PS 拒绝 |
| ② | 回读 `brush.name` = 期望名 | 工具没切到这支笔 |
| ③ | 回读 `sampledBrush.sampledData` = 缓存值 | **笔尖数据没了**（跨会话 UUID 失效） |

任何一层不过就 `dropState()` 并老实退回 define 流程 —— fallback 安全，只是会弹一次框。

### 参数不缓存

缓存**只负责把笔尖恢复出来**。直径/间距/不透明度等每次点击都按 `brush.json` 重新下发，
所以改了参数立刻生效，不会被旧缓存盖住。

---

## 四、当前差距与后续

| 诉求 | 现状 |
|---|---|
| 画笔预设里不留东西 | ✅ 快路径下压根不建预设；慢路径建完立刻删 |
| 点完就能画、笔尖对得上 | ✅ 缓存里含采样笔尖，整份灌回 |
| 参数与 `brush.json` 一致 | ✅ 每次重新下发 |
| **完全不弹框** | ⚠️ 首次使用某支笔仍会弹一次（每会话每支笔最多一次） |

要彻底消除那一次，只有一条路：**让 PS 从文件载入**（`.abr` 或 `.tpl`），
这需要先在 UXP 里确认 `batchPlay` 能发出载入预设文件的命令。
那是一次独立的技术验证，不该和本轮修复混在一起做。
