# 笔刷素材来源与许可（必读）

本目录（`src/brushes/`）是第三入口「特制笔刷」的笔刷库，一支笔一个子目录：
`brush.json`（明文参数）+ `tip.png`（8bit 灰度笔尖）+ `preview.png`（250×55 预览条）。

## 首批 6 支笔的来源

| 项 | 内容 |
| --- | --- |
| 上游资源 | Krita 自带资源包 `RGBA_brushes.bundle`（本机路径 `E:\Program Files\Krita (x64)\share\krita\bundles\`） |
| 原作者 | Ramon Miranda |
| 上游许可声明 | 该包 `meta.xml` 里写的是 `license = "Same as default brushes in Krita"`（**未**给出具体许可证名） |
| 我们对素材做了什么 | 见下「改动说明」 |

### ⚠️ 许可风险（需要你决策，不是代码问题）

- Krita 默认画笔资源的通行说法是 **CC-BY-SA 4.0**（也有部分为 CC0），但该包内**没有许可证文件**，
  只有一句"同 Krita 默认画笔"。
- 如果是 CC-BY-SA：**改编物（我们转出来的灰度笔尖）必须以同许可分发**，而本插件是闭源商业分发 ⇒ 冲突。
- 如果实际是 CC0：无义务。

**在拿到明确答复前，这里的三条处理原则：**

1. 面板底部已标注素材来源（署名义务的最低要求）；
2. 这 6 支笔**只作为链路验证素材**，不作为产品卖点；
3. 正式发布前二选一：
   - **A**：换成自制笔尖（推荐）——`brush.json` 结构不变，只换 `tip.png` 与参数；
   - **B**：把这 6 支笔的资源单独以 CC-BY-SA 4.0 发布（例如放在开源仓库/独立下载包），
     插件本体只引用参数、不含素材。

## 改动说明（相对上游）

1. `.kpp`（Krita 预设，PNG+zTXt 压缩 XML）→ 拆成 `brush.json` 明文参数 + `tip.png`；
2. 笔尖：原图 RGBA → 8bit 灰度遮罩，取 `alpha × 亮度` 后按最大值归一（RGBA 彩色笔尖在
   PS 画笔引擎里没有对应的"彩色笔尖"概念，必然降级为明度遮罩）；
3. `.gih`（GIMP 动画笔尖）只取**第 1 帧**——PS 画笔不支持动画笔尖；
4. 间距：取原 `spacing` 属性；Krita 的"自动间距"策略在 PS 无对应概念，已弃用；
5. 预览条由本仓库脚本重新渲染（`scripts/krita_bundle_export.py`），非上游素材。

## 重新生成

```bash
python scripts/krita_bundle_export.py
```

脚本只依赖 Python 标准库（无 PIL / numpy），产物会覆盖本目录下 6 个笔刷子目录与 `library.json`。
新增/替换笔刷时，保持「一个目录 + library.json 里一行」的结构即可，面板代码无需改动。
