# Tracery 交接文档（Handoff）

> 用途：开新对话时，把这份文档贴/引用给 AI，配合 `README.md`、`docs/SYNC.md`、`docs/ROADMAP.md` 即可无缝继续。
> 最后更新：2026-10-17 20:10（对应代码状态：Tracery 重命名 + 侧栏折叠修复 + 附件管理 + 粘贴/拖拽入库 + Tab 栏搬入标题栏 + 笔记头行删除 + Markdown round-trip 属性测试 + 回车 bug 修复 + 图片直阅/行号/折叠图标）

---

## 1. 一句话现状

Tracery 是一个 **仓库型 Markdown 笔记软件**（Obsidian 兼容的学习复刻版）：Node 服务端负责文件/索引，前端是纯 ES Module + CSS 变量主题，Electron 壳可选。**核心差异化已落地：自托管同步 v2（自动合并 + 分块续传）+ 局域网六位通行码直连**，另有内置绘图、图片灯箱、PDF 应用内阅读器、图谱全屏、多标签页（Tab 栏即标题栏）、可拖拽栏宽、附件管理（可配置落点 + 粘贴/拖拽入库）、文件树图片直阅、源码模式行号、编辑区右键菜单（仿 Obsidian 文本/图片两套）、回收站（删除可恢复）。测试 248/248，打包版可发布。

## 2. 环境与常用命令

```bash
# 开发（浏览器）
npm start                    # http://localhost:9520，静态文件热更新；改 server/* 需重启

# 桌面窗口
npm run start:electron

# 测试（全部无头 Edge，用临时目录，不碰真实仓库）
npm run test:e2e             # 15  功能回归
npm run test:ui              # 10  窗口按钮/主题图标/仓库切换
npm run test:ux              # 16  布局/对话框/图片/图谱全屏
npm run test:sync            # 27  同步（双实例+真服务端：合并/冲突/分块/Range/删除）
npm run test:sync-ui         # 13  同步面板 + 部署说明 + 局域网区块
npm run test:merge           # 10  三方合并单测
npm run test:roundtrip       # 7   Markdown 双向引擎属性测试（恒等/不动点/内容不丢/渲染确定性，含 300 篇模糊 + demo-vault 全量）
npm run test:enter           # 10  编辑器回车行为回归（段尾/行中/连续回车、列表续行与退出、软换行段、段尾插空行）
npm run test:gap             # 12  实时预览空行/落点回归（空行占一行高、点它不位移、打字/回车光标不跑偏）
npm run test:polish          # 18  撤销/重做、实时预览行号 + 设置开关、右键菜单紧凑化与去 emoji
npm run test:menu            # 10  编辑区右键菜单（文字/图片）+ 文件树菜单 + PDF 阅读器 + 侧栏折叠
npm run test:trash           # 10  回收站（删除入站/恢复/彻底删除/清空）
npm run test:features        # 13  右栏切换/代码高亮/表格 Tab/星标/最近/导出/图片缩放/替换/历史
npm run test:draw            # 20  绘图（Excalidraw 风格白板）
npm run test:lan             # 10  局域网直连
npm run test:layout          # 12  侧栏折叠回归 / 紧凑头栏
npm run test:asset           # 15  附件落点 / 粘贴拖拽 / 路径穿越
npm run test:tabs            # 12  多标签/栏宽/绘图历史

# 同步服务端（可选，常驻机器）
npm run sync -- --data ./tracery-sync

# 打包（重要，见 §7）
npm run dist:dir             # electron-builder 产出 dist/win-unpacked
npm run repack               # 只重打 app.asar（改完前端/服务端后用这条，绕过 winCodeSign）
npm run release              # 一键：repack + 压 zip（先写 .new.zip 再改名，压缩失败不毁旧包）
npm run release -- --shortcut  # 同上，并生成桌面快捷方式（手写 .lnk，不用 COM）
```

无头浏览器是 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，测试用 `puppeteer-core`。

## 3. 架构与文件地图

```
渲染进程（public/js，纯 ESM，无框架）
  app.js        主控制器：状态/文件树/面板/命令面板/标签页/快捷键/WS
  editor.js     contenteditable 实时预览编辑器（md 坐标系 + _replaceRange/insertSnippet/flush）
  markdown.js   Markdown ↔ DOM 双向（图片 ![]()、嵌入 ![[..]]、序列化、光标映射）
  settings.js   设置面板（外观/编辑器/同步/通用），CSS 变量即时生效
  sync-ui.js    同步面板（表单/已连接/部署说明/局域网直连）
  draw.js       内置绘图白板（Excalidraw 风格：rough 手绘渲染 + 场景模型 + 选择/缩放/文字）
  lightbox.js   图片灯箱（滚轮缩放/拖动/双击复位）
  dialog.js     askText/askConfirm（替代 prompt/confirm，见 §6）
  api.js        API + WebSocket
  themes/*.css  apple / obsidian 两套皮肤，全是变量

Node 服务端（server）
  server.js     HTTP + WS + vault 监听 + 配置（≈ Obsidian 主进程）
  sync.js       同步引擎：三方比对(local/remote/base)、diff3 合并、分块传输
  merge.js      node-diff3 封装（CRLF 保留、只放行 .md/.markdown/.txt）
  lan.js        局域网直连：内嵌 sync-server + UDP 广播发现 + 本机引擎配对
sync-server/index.js   同步服务端（CLI 与 startSyncServer() 双形态）
electron/main.cjs       桌面壳：窗口按钮/拖拽区/选文件夹对话框/起服务端子进程
test/*.mjs              九个测试套件（见 §2）
```

约定：仓库根目录 `E:\08_project\ev_\evnote`（本地目录名未随产品名改，代码不依赖目录名）；演示仓库 `demo-vault/`；配置在 `TRACERY_HOME/tracery.config.json`（Electron 默认 `%APPDATA%/Tracery`）；每仓库同步配置 `<vault>/.tracery/sync.json`；同步删除进 `<vault>/.tracery/trash/`；绘图笔画存 `附件/<名>.draw.json`（文件树隐藏但参与同步）。

## 4. 已完成功能（截至 2026-10-17）

- 编辑器：实时预览、任务列表、Callout、表格、代码块、高亮、源码模式、自动保存 0.9s
- 双链/反链/标签/全文搜索/命令面板/力导向图谱（全屏+缩放+适应）/大纲
- 图片：`![[图]]` `![[目录/图]]` `![[图|400]]` `![](相对路径)` + 点击灯箱看大图
- **附件管理**：粘贴 / 拖入图片与文档自动落盘并插入 `![[路径]]`；落点三档可配
  （指定文件夹 / 跟随笔记目录 / 仓库根目录，设置 → 附件）；绘图也按此落盘
- 内置绘图：`Ctrl+Shift+D` 或左下角笔图标；工具 选择/抓手/矩形/椭圆/菱形/箭头/直线/画笔/文字/橡皮，快捷键 V H R O D A L P T E；保存 PNG 到附件目录并插入光标处
- 多标签页：树点击开新标签、`Ctrl+W`/`Ctrl+Tab`、持久化、外删自清理
- **Tab 栏即标题栏**：标签条在窗口最顶部，与最小化/最大化/关闭按钮同一行
  （VS Code / Obsidian「Tab 标题栏」模式），编辑区直接从笔记头开始
- 可拖拽栏宽：侧栏/右栏拖拽 + 双击复位 + 记忆（折叠已兼容内联栏宽，见 §5-9）
- 折叠/展开全部按钮图标双状态（⤡/⤢，随折叠状态切换，参考 Obsidian）
- 左侧功能区：文件/搜索/标签/绘图/图谱（绘图与面板同级）；**切换工作区唯一入口 = 左上角工作区名（带 ▾ 提示）**；左侧栏折叠按钮在工作区名右侧
- 紧凑头栏：标签行 + 笔记头压成一条（合计 < 70px，中间无分隔线，活动标签下圆角为 0）
- 主题：apple/obsidian × 亮暗，强调色/圆角/字号/行宽即时生效，可导出 CSS
- 同步：NAS/服务器方式 + **局域网六位通行码直连**；自动三方合并、冲突副本、删除回收站、
  内容寻址去重、1MB 分块上传、Range 断点下载、自动同步开关/间隔/自动合并开关
- 仓库管理：欢迎页浮层（Esc/✕/点空白关闭）、最近列表、原生选文件夹、标题栏仓库名可点

## 5. 技术决策（别推翻，先读理由）

1. **同步配置按仓库存 `.tracery/sync.json`**（不是全局 settings）：不同仓库绝不能共用一个同步目标，否则切仓库会把 A 灌进 B。
2. **局域网直连 = 内嵌 sync-server + 本机引擎也连它**：主机自己也是客户端，零新协议，合并/冲突/回收站全部复用。
3. **UDP 广播发现**（端口 47891-47893），码只用于配对换 token；探测地址时逐个 IP `GET /api/health` 选通的。
4. **合并只对文本**（`.md/.markdown/.txt`），同段冲突一律退化为冲突副本——宁可多一份文件，不猜内容。
5. **附件合并基准取服务端历史 blob**：服务端不删旧 blob，正好当 base。
6. **`dialog.js` 替代 prompt/confirm**：Electron 渲染进程不支持 `prompt()`（静默失效）。
7. **主题是一套 CSS 变量**：改皮肤不动布局；按钮图标显隐要写 `#btn-theme .ic-moon`（0,2,0 才能压过 `.ribbon-btn svg`）。
8. **图谱 fit() 按节点包围盒算 scale+pan**，不是 reset 到 1x（否则全屏后缩成一坨）。
9. **侧栏折叠必须 `width: 0 !important`**：拖拽过栏宽后内联 `style.width` 会压过普通规则，折叠 silently 失效（layout-test 锁死这个场景）。
10. **附件落点三层可配 + 服务端独立清洗**：客户端算目录只是「意图」，`/api/asset` 的 `dir` 与设置的 `attachment.folder` 都过 `sanitizeAssetDir`——含 `..`/空段/非法字符**整条拒绝**（400 或忽略补丁），不静默改写，把 bug 和恶意调用暴露出来。
11. **粘贴/拖拽必须拦下来自己存**：不拦的话浏览器默认把图片塞进 contenteditable（data/blob URL，刷新即丢），拖文件甚至直接导航打开。
12. **Tab 栏即标题栏**（VS Code / Obsidian「Tab 标题栏」模式）：标签搬进标题栏与窗口按钮同一行；标题栏永远可见（它是 Electron 拖拽区 + 窗口按钮的家），无标签时只隐藏 tablist。三个坑：① `.tablist{display:flex}` 会压过 `[hidden]` 的 UA 规则，必须显式 `.tablist[hidden]{display:none}`；② 标题栏是 `app-region:drag`，标签和控件必须显式 `no-drag` 否则点不动；③ 切仓库必须重置标签（按 vault root 存 localStorage）——UI 流程走 `enterApp`，WS `vault-opened` 也必须走同一条 `restoreTabsAfterVaultSwitch`，且要先 await 树刷新再 `loadTabsState`（`hasNotePath` 用旧树过滤会把上个仓库的标签带过来）。
13. **round-trip 测试分两级契约**（`test/roundtrip-test.mjs`）：规范格式语料要求**恒等**（serialize(render(md))===md，对应「打开不编辑就保存不能动文件一个字节」）；任意怪格式只要求**不动点**（第二次 round-trip 起稳定，对应「正常化只许发生一次」）。已知的正常化（不动点容忍、恒等语料刻意避开）：`_em_`→`*em*`、`***`→`---`、`|---|---|`→`| --- |`、`*`/`+`列表符→`-`、有序列表重新从 1 编号、行首行尾空白、连续空行折叠、链接 title 丢弃、`[[x#y]]` 补显式别名。改 markdown.js 前后都必须跑这个套件。
14. **编辑器回车三件套**（2026-10-17 修，`test/enter-test.mjs` 锁死）：① 渲染器必须给「行尾空行」补一个 `<p><br></p>`（带源码偏移标记）——否则段尾回车插入的 `\n` 在 DOM 里不存在，下次输入序列化就被吃掉；② 序列化器必须把空段落产出空块——否则那个空行活不过一轮；③ `domPointToMd` 的 DOM 偏移必须与 `inlineMapOffset` 同口径（`<br>` 计 1，见 `domOffsetBrAware`）——否则含软换行的段落光标映射整体偏移，回车从字中间拆行。另：**`_placeCaret` 必须同步恢复光标**，包 `requestAnimationFrame` 会让下一个按键打进旧位置。
15. **源码模式行号**：textarea 外层包 `.source-wrap`（行号槽 + wrap="off" 的 textarea），切模式隐藏的是 **wrap 不是 textarea**；槽与 textarea 的字号/行高/上 padding 必须严格同参才对得齐；实时预览模式不显示行号。
16. **文件树点图片走灯箱**：图片扩展名（png/jpg/gif/webp/svg/bmp/avif）直接 `openLightbox(Api.fileUrl(path))`，不能再走 `openNote`（API 只认 .md，会报「笔记不存在」）。
17. **标签多了不许挤压**：`.tab` 的 `min-width: 120px` 是底线（低于它标题变「00...」不可读），超出部分横向滚动 + 滚轮横滚 + 溢出侧 `mask-image` 渐隐（`data-overflow` 由 `updateTabOverflow()` 维护）。标签条空白区必须留在拖拽区里（no-drag 只挂 `.tab`）。
18. **覆盖式滚动条与圆角**：Electron/Chromium 用覆盖式滚动条（不占布局、浮在滚动区边缘），`::-webkit-scrollbar-track{margin}` 对它无效——滚到顶部会和纸的圆角边框交叉。正确解法是给滚动容器（`.editor` / `.source-wrap`）让出 `margin: 10px 8px 10px 0`，把滚动区缩进直边里；padding 相应减 10px 保持正文位置不变。
19. **编辑区右键菜单**：文本/图片两套（`showTextMenu` / `showImageMenu`）。两个关键坑：① 点菜单项会让 contenteditable 失焦、选区丢失——右键时把 Range 克隆下来（`editorSavedRange`），每个动作前 `restoreEditorSelection()` 再执行；② 在已选中的文字上右键，浏览器会先折叠选区——`mousedown` 里判断右键点是否落在选区 rect 内，是则 `preventDefault` 保住选区（Obsidian 同行为）。图片相关的路径解析走 `resolveVaultFile`，桌面能力（资源管理器定位/默认应用打开）走 `electronAPI.reveal/openPath`（main.cjs 校验绝对路径）。
20. **编辑区容器贴底**：`.editor-area` 只留上/左右边距，`border-radius` 只圆上半部，底边与窗口相连——状态栏在纸内最底部。
21. **中间空段落必须能渲染**：段尾回车（后面还有内容时）插入的 `\n` 会让段落之间出现 2 个空行；渲染器若继续跳过所有空行，用户按回车「毫无反应」且光标跳走（2026-10-17 用户报的第二个回车 bug）。规则：**连续空行 ≥2 且前后都有内容 → 渲染一个 `<p><br></p>`**；序列化时中间空段落占 `\n\n\n`（段落分隔 2 个 + 空行自己 1 个），直接 `join('\n\n')` 会让它占 2 个换行、每轮 round-trip 长一行、破坏不动点。单个空行（正常段落分隔）不补空段落，恒等语料因此不受影响。
22. **PDF 阅读器**：`.pdf-viewer` 浮层 + iframe 指向 `/api/file?path=...pdf`，靠 Chromium 自带 PDF 渲染；Electron 必须 `webPreferences.plugins = true`，否则是空白页。兜底按钮「用默认应用打开」。
23. **文件树右键菜单**（Obsidian 式）：在新标签页中打开 / 创建副本 / 复制路径（绝对+相对）/ 默认应用打开 / 资源管理器定位 / 重命名 / 删除。`renameNote` 已泛化：非 .md 文件保留原扩展名（原来会把 pdf 改成 .md）。
24. **面板切换必须按栏隔离**：`switchPanel` 原来用 `.sidebar .panel`，会连右栏（大纲/反链/标签）一起命中——切到「文件」时它们 id 不匹配、`active` 被摘掉，表现就是「右侧大纲莫名消失」。必须写 `#sidebar .panel`。右栏三块现在是常驻同屏，空块自动 `.hidden`（反链为空 / 笔记无标签时收起）。
25. **回收站**：删除不再 `unlink`，文件移到 `TRACERY_HOME/trash/<仓库路径 sha1 前 12 位>/<id>__原名` + `index.json` 记原始相对路径。放数据目录而非仓库：不污染笔记目录、不进同步、文件树看不见。**跨盘要兜底**：仓库在 D:/E:、数据目录在 C:，`rename` 会抛 `EXDEV`，必须 `copyFile + unlink`。上限 200 项，超出自动清最旧的。恢复时重名自动加 ` (n)`。
26. **单空行恒占一行高**（2026-10-18 重写）：单个空行 = 段落分隔符，渲染成 `<p class="md-blank">`（序列化跳过、文件不变）。它**必须恒定占一行高**（`min-height: 1.78em`），不能再是「零高 + 点中时 `.is-active` 撑开」：零高时那一行根本点不到，光标只能靠「点空隙上半/下半」的启发式去猜；点中又瞬间撑开会把下面的内容整体推一下（用户 2026-10-18 报的「点一下就变了、字还打错地方」）。相邻块的外边距用 `#editor-live > *:has(+ .md-blank)` 与 `.md-blank + *` 让位，净间距仍约等于一行，不会明显变松。**不要**退回零高，也不要把占位段做成「有内容的真段落」——序列化仍要跳过空的占位段（否则每点一次空隙就多一行，幽灵编辑）。`test/gap-test.mjs` 锁死这套行为。
27. **代码高亮是渲染层的事**：`highlightCode()` 只在渲染时把代码切成 `tok-*` span，序列化仍走 `code.textContent`，所以 md 字节不受影响。改高亮规则只需动 `CODE_KEYWORDS` / 分支正则。
28. **表格键位要抢在编辑器前面**：编辑器自己的 Tab 是「缩进」，表格 Tab 跳格必须用**捕获阶段**监听并 `stopPropagation()`，否则缩进逻辑先命中。回车加行是直接改 DOM 再 `dispatchEvent(new InputEvent('input'))`，让正常序列化流程接住。
29. **右栏是三按钮切换**（大纲/反链/标签），`switchRightPanel()` 维护 `.rs-tab.active` + 面板 `.active`，选择记在 `tracery.rsTab`。别再改回常驻同屏——用户明确要求三按钮切换。
30. **导出**：`buildExportHtml()` 内联全站 CSS + 图片转 data URL → 自包含 HTML；PDF 走 Electron `tracery:export-pdf`（隐藏 BrowserWindow → printToPDF → 保存对话框）。入口在命令面板。
31. **图片拖拽调宽**：`![[img|宽]]` 的右下角手柄拖拽 → `setImageWidth()` 改写 token 里的数字（0 = 去掉尺寸，双击手柄还原）。手柄 pointerdown 必须 stopPropagation，否则会触发灯箱。
32. **全文替换会留快照**：`/api/replace` 逐篇 `split/join`（纯文本、非正则），写之前调用 `snapshotHistory()`——所以替换错了可以用版本历史回滚。遍历用 `vault.notes.keys()`（Map，只含 .md）。
33. **版本历史**：保存前把旧内容写到 `TRACERY_HOME/history/<仓库哈希>/<相对路径>/<时间戳>.md`，每个文件留 20 个；`/api/history*` 提供列表/内容/恢复；UI 在命令面板「查看历史版本」，点行展开预览、点恢复先给当前内容再存一份快照。
34. **光标坐标只准用一套（Markdown 偏移）**（2026-10-18 修）：`_saveCaret()` 必须返回 `domPointToMd()` 的 md 偏移，`_renderLive()` 重建 DOM 后用 `_restoreCaretMd()`（即 `mdOffsetToDom()`）还原。旧实现用「纯文本第几个字符」，当光标停在一个空块上（锚点是元素而不是文本节点）时 `textOffsetOf` 会返回整篇文本长度 → 重建后光标被甩到全文末尾（用户看到的「在空行打字，打完光标跑到下一段行尾，再输的字全进那一行」）。配套两条：① `domOffsetBrAware` 必须特判「锚点 === 块本身」（只累加前 offset 个子节点），否则空块里的 `<br>` 被算成 +1，回车/输入整体错位一格；② 在空行上刚打的字序列化后会往下挪一行（段落之间要补空行），`_saveCaret` 要跟着 +1，否则光标少走一格、字插进中间。`load()` 换文件前先清选区，别把上一篇的光标带过来。
35. **撤销必须自己实现快照栈**（2026-10-18）：contenteditable 每次输入都 `innerHTML` 重建 DOM，浏览器原生 undo 栈跟着节点一起没了。`editor.history = [{md, caret}]` + `hIndex`：连续输入 520ms 静默合并成一步，结构操作（回车/缩进/加粗/插入片段）走 `_scheduleHistory(0)` 单独成一步；`undo()/redo()` 直接换 `md` 再 `_renderLive()` + `_restoreCaretMd()`，**不经过** `_replaceRange`（否则会再入历史）。快捷键 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y，右键菜单和命令面板也能进。三条容易踩的：① `load()` 里「内容一模一样」必须直接 return——自动保存后 WS 会把文件变更广播回来，再 `load()` 一次就会清空撤销栈（表现为「刚撤完就跳走」）；② 源码模式用 textarea 原生撤销，切回实时模式时 `_resetHistory()` 重新起栈；③ 撤销后再输入要砍掉 redo 尾巴（`history.length = hIndex + 1`）。
36. **实时预览行号是测量出来的**：`_collectLineNumbers()` 遍历编辑区顶层块，用 `data-md-line-start`（源码字符偏移）换行号，块内用 `Range.getClientRects()` 拿每个视觉行（软换行段落、代码块逐行、表格按 tr、列表按 li）。数字画在 `.live-gutter` 覆盖层里，滚动只改 `translateY`。代码块首行是 ``` 围栏、预览里看不见，所以行号会从 `start+1` 开始（7 → 9 这种跳号是正常的）。开关：设置「编辑器 → 行号」（`lineNumbers`），源码槽与实时槽共用；**新增设置项记得同步 `server/server.js` 的 `DEFAULT_SETTINGS` 与 `mergeSettings` 白名单**，否则保存后被服务端丢掉、WS 再广播回来又把开关弹回默认（这个坑当场踩过一次）。
37. **右键菜单不用 emoji**：图标统一走 `ICON`（16 格线性 SVG，`S()` 包一层），排版类选项用 `.mi-txt` 字型（H1/B/I/¶）。行高 24px、`gap: 8px`、分隔线 `--hairline-strong`——emoji 会把行撑到 44px，菜单长得离谱（22 项直接占满一屏）。

38. **绘图白板（Excalidraw 风格，2026-10-18 重写）**：`draw.js` 是 canvas 2D 的场景图，不是「一堆笔画」。要点：
   ① **rough 渲染**用 `mulberry32(seed)` 生成确定性抖动折线（同 seed 重绘画面不会「呼吸」），每条线描两遍；椭圆按角度抖动半径；填充用「裁剪到形状 + 45° 扫线」做排线（solid 直接填精确路径）。
   ② **坐标系**：元素存世界坐标（`x,y,w,h,points`），`view{x,y,zoom}` 负责平移缩放，绘制时 `setTransform`，命中检测时临时切回单位矩阵再 `isPointInPath`（否则路径会跟着变换跑偏）。
   ③ **交互**：pointerdown 分派到 pan / select（缩放柄→resize、命中→move、空白→marquee）/ erase / text / create 五种 drag 模式；形状画完自动切回选择工具并选中它（Excalidraw 默认 lock=off 的手感）。选中时改样式 = 直接改选中元素（`styleForSelected`），并 `adoptSelectionStyle()` 让面板回显。
   ④ **撤销**用整个 `elements` 数组快照，`snapshot()` 里做了 JSON 去重；**文字元素必须在 commitText 时才入历史**——创建时入历史会把「空文本」存进去，撤销时刚打的字全没（踩过）。
   ⑤ 保存：`exportPng()` 只截内容包围盒 + 28px 留白、白底、2 倍超采样；场景存 `{v:2, elements}`。代码块 ```` ``` ```` 围栏这种「源码有、预览没有」的行同理适用于行号跳号。


## 6. 已知坑（踩过的，直接抄结论）

| 坑 | 结论 |
|---|---|
| 渲染进程 `prompt()` 无效 | 全部走 `dialog.js` 的 `askText/askConfirm` |
| asar 内 `fs.cpSync` 报 ENOENT opendir | 复制演示仓库用 `readdirSync`+`copyFileSync`（`copyDirSafe`），并用 `DEFAULT_VAULT.includes('.asar')` 判定 |
| electron-builder 解 winCodeSign 要符号链接权限（普通 Windows 账户失败） | 用 `npm run dist:dir` 产出目录 + `npm run repack` 只重打 asar + 7za 压 zip |
| repack staging 漏带 `sync-server/` → asar 内 import 失败 | staging 固定包含 `electron server public demo-vault sync-server` + `node_modules/{ws,node-diff3}` |
| WScript.Shell COM 被安全策略拦截 | 桌面快捷方式用 `scripts/make-shortcut.mjs` 手写 .lnk 二进制 |
| 用 `bash -e "…"` 写 JS，模板字符串/`$()` 被 shell 吃掉 | **改代码一律用 Edit/Write 工具**，不要用 bash -e 生成代码 |
| `body.electron` 右侧要留窗口按钮位置 | `body.electron { padding-right: 0 }` + `.titlebar-right { align-self: stretch }` |
| Windows 文件/目录名不能含 `:*?"<>\|` | 冲突副本/绘图文件名统一 `.replace(/[\\/:*?"<>|]/g,'-')` |
| puppeteer 这个版本 `keyboard.press('Control+X')` 不解析组合串 | 修饰键单独 `down('Control')` / `press('X')` / `up('Control')` |
| `new URL('..', import.meta.url).pathname` 在 Windows 是 `/E:/...` | 给 spawn 当 cwd 会 ENOENT，用 `fileURLToPath(new URL('..', import.meta.url))` |

## 7. 新对话怎么继续（按优先级）

1. **同步 v3：端到端加密**。路线：scrypt(密码) 派生 masterKey → 内容 AES-GCM 加密后再上传 → manifest 路径用 HMAC 存。服务端接口不用改（本来就只认 blob+sha）。注意：合并会失效（服务端看不到明文），需改成「客户端持有 base 明文」策略。
2. **绘图二次编辑**：场景 JSON 已存 `附件/*.draw.json`（v2：`{v:2, elements:[...]}`），做「右键图片 → 编辑绘图」把它回填进 draw.js 的 `elements` 即可；跨设备时 JSON 也参与同步。
3. **PWA + 响应式**（ROADMAP P0 最后一项）：manifest + service worker + 移动三栏。
4. **大仓库性能**：文件树虚拟滚动 + 增量索引落盘。
5. **mDNS 精细发现**（替代当前 UDP 广播启发式）。

## 8. 协作方式约定

- 回复用中文；用户习惯**截图 + 一句话需求**驱动迭代，先定位根因再动手，别猜。
- 测试必须真实驱动（puppeteer-core + 无头 Edge），截图落 `test/screenshots/`，改完跑相关套件再打包。
- 所有 UI 文案保持中文，代码注释中文；新文件头写清「为什么这样做」。
- 提交信息用中文，颗粒度按功能（未接入远端仓库则本地 commit 即可）。
- 项目记忆在 `E:\08_project\ev_\.workbuddy\memory/2026-10-17.md`（当天日志）+ `MEMORY.md`，新对话可读。

## 9. 快速自检清单（接手后 5 分钟）

```bash
npm start                 # 起服务，浏览器开 http://localhost:9520
npm run test:e2e          # 应 15/15
npm run test:lan          # 应 10/10（验证局域网直连没坏）
npm run test:sync         # 应 27/27
```

如果全绿，说明环境和代码状态与本文档一致，可以按 §7 挑一项开工。
