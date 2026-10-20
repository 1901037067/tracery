# Tracery 交接文档（Handoff）

> 用途：开新对话时，把这份文档贴/引用给 AI，配合 `README.md`、`docs/SYNC.md`、`docs/ROADMAP.md` 即可无缝继续。
> **最省事的方式**：把 `docs/AI-START.md` 里的开场白整段复制给新对话的 AI（已经写好必读文档与硬性约定）。
> 最后更新：2026-10-19 21:00（对应代码状态：**v1.4.0** —— 编辑器只剩 CM6 一套内核；
> 测试套件单内核全量回归全绿；打包链路打通（`dist:dir:nosign`）；打包版验证 14/14）
>
> **2026-10-19 晚追加（第二轮，四条需求）**：标签条最右侧的**标签页下拉**（列出已开标签 / 关闭全部 /
> 收藏全部，§5-59）、编辑区**四周缝隙刷成侧栏色 + 拖拽热区压在纸张边缘**（§5-60）、
> **阅读模式**（只读 + 全量渲染 + 双链跳转 + 任务勾选，§5-61）、**无序列表标记渲染成圆点「•」**（§5-62）。
> 新增断言落在 `engine` / `tabs` / `layout` / `features` 四个套件；顺带发现「首行 BOM 让标题失效」（§6，未修）。
>
> **2026-10-19 晚追加（本轮）**：按用户五条需求做了修复 + 新功能 ——
> 编辑区双链/标签**鼠标点击**跳转（§5-54）、文件夹右键菜单补「删除/重命名/复制路径/资源管理器定位」+
> 目录级回收站（§5-55）、标签**铺满标题栏**（§5-53）、绘图**旋转**（§5-56）、绘图**草稿箱 / 多开画板**（§5-57）。
> 新增断言落在 `engine` / `tabs` / `menu` / `trash` / `draw` 五个套件，双引擎回归见 §7 开头。
>
> **✅ 编辑区内核：只有 CodeMirror 6**（v1.4.0 起下线了旧的块级 contenteditable 内核：
> `public/js/editor.js` 已删除，设置里的「编辑内核」开关也一并去掉——见 §5 #58）。
> 全过程与逐阶段结论在 **`docs/EDITOR-MIGRATION.md`**（P0~P5 + 7.1~7.12）。
> **cm 与块级的渲染断层已消除**（7.12）：行内 `![[图片]]`、`![](路径)` 都出图（带 `|宽` 与拖宽手柄），
> 未解析双链有 `.cm-lp-unresolved`；跑套件的测试门控已拆（ui-ux 4 条 + e2e #11）。
> **v1.2.1 已发布**：除渲染缺口外，还打磨了两处视觉 —— 图片的虚线框/拖宽手柄改成**悬停才出现**、
> 滚动条**贴编辑区右缘**（宽窗口下不再跑到纸张中间），见 §5 #44/#45。
> **v1.3.0 内容**：cm 表格单元格编辑（7.13）、**无缝标签栏** + 拖拽换序（#46/#50）、
> **绘图二次编辑**（右键图片 → 编辑绘图，覆盖原 PNG/JSON，#48）、
> **同步 v3 端到端加密**（scrypt+HKDF → AES-256-GCM；路径 HMAC + 加密索引，#49，`test:sync-enc` 20/20）、
> **工作区下拉**（最近仓库 + 管理仓库，#52）。
> **剩余**：features ② / layout ② 两条口径差异，见 §7。

---

## 1. 一句话现状

Tracery 是一个 **仓库型 Markdown 笔记软件**（Obsidian 兼容的学习复刻版）：Node 服务端负责文件/索引，前端是纯 ES Module + CSS 变量主题，Electron 壳可选。**核心差异化已落地：自托管同步 v2（自动合并 + 分块续传）+ 局域网六位通行码直连**，另有内置绘图、图片灯箱、PDF 应用内阅读器、图谱全屏、多标签页（Tab 栏即标题栏）、可拖拽栏宽、附件管理（可配置落点 + 粘贴/拖拽入库）、文件树图片直阅、源码模式行号、编辑区右键菜单（仿 Obsidian 文本/图片两套）、回收站（删除可恢复）。**编辑内核已是 CodeMirror 6（默认 cm，可一键回退块级）**；全量套件 **block / cm 双引擎各跑一遍全绿**（见 §2、§4b），打包版可发布（验证 14/14）。

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
npm run test:sync-enc        # 20  同步 v3 端到端加密（服务端只见密文/哈希名、换设备、错密码、解锁）
npm run test:merge           # 10  三方合并单测
npm run test:roundtrip       # 7   Markdown 双向引擎属性测试（恒等/不动点/内容不丢/渲染确定性，含 300 篇模糊 + demo-vault 全量）
npm run test:enter           # 10  编辑器回车行为回归（段尾/行中/连续回车、列表续行与退出、软换行段、段尾插空行）
npm run test:gap             # 13  实时预览空行/落点回归（空行一行一个、点它打字不多长空行、光标不跑偏）
npm run test:polish          # 18  撤销/重做、实时预览行号 + 设置开关、右键菜单紧凑化与去 emoji
npm run test:menu            # 10  编辑区右键菜单（文字/图片）+ 文件树菜单 + PDF 阅读器 + 侧栏折叠
npm run test:trash           # 10  回收站（删除入站/恢复/彻底删除/清空）
npm run test:features        # 13(block) / 14(cm)  右栏切换/代码高亮/表格网格+Tab+加行/星标/最近/导出/图片缩放/替换/历史
npm run test:draw            # 26  绘图（白板 + 二次编辑：右键「编辑绘图」→ 载入场景 → 覆盖保存）
npm run test:lan             # 10  局域网直连
npm run test:layout          # 12  侧栏折叠回归 / 紧凑头栏
npm run test:asset           # 15  附件落点 / 粘贴拖拽 / 路径穿越
npm run test:tabs            # 16  多标签/卡片样式+悬停换色/拖拽换序/栏宽/绘图历史
npm run test:engine          # 12  CM6 内核「真实 app」冒烟（撤销重做/行号开关/Enter 续任务/粘贴附件/双链跳转）
npm run test:cmlab           # 8 + IME  CM6 探针页（纯引擎单页，不依赖 app；P0~P4 的断言都在这）
npm run test:backspace       # 19  跨行删除/合并行回归

# 编辑器只有一套内核（CM6）；2026-10-19 v1.4.0 起不再有 block 口径
node test/design-check.mjs                            # 界面存档截图（同理会覆盖 design-*.png）
node test/img-probe.mjs                               # 图片嵌入探针（打印信息，无断言）

# 同步服务端（可选，常驻机器）
npm run sync -- --data ./tracery-sync

# 打包（重要，见 §7）
npm run dist:dir             # electron-builder 产出 dist/win-unpacked
npm run dist:dir:nosign      # 出包入口（跳过「签名 + 改 exe 资源」）：本机无权建符号链接 / 连不上 GitHub 时的唯一可行路
npm run repack               # 只重打 app.asar（改完前端/服务端后用这条，绕过 winCodeSign）
npm run release              # 一键：repack + 压 zip + 顺带压一份 .7z（Gitee 单附件上限 100MB）
npm run release -- --shortcut  # 同上，并生成桌面快捷方式（手写 .lnk，不用 COM）

# 打包版验证（先起包：$env:PORT='9540'; dist\win-unpacked\Tracery.exe --remote-debugging-port=9223）
node test/verify-exe.mjs     # 应 14/14（渲染断言按 cm 口径自动选 + 分段滚动累加）
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

## 4. 已完成功能（截至 2026-10-19）

- 编辑器：实时预览、任务列表、Callout、表格、代码块、高亮、源码模式、自动保存 0.9s
- 双链/反链/标签/全文搜索/命令面板/力导向图谱（全屏+缩放+适应）/大纲
- 图片：`![[图]]` `![[目录/图]]` `![[图|400]]` `![](相对路径)` + 点击灯箱看大图
- **附件管理**：粘贴 / 拖入图片与文档自动落盘并插入 `![[路径]]`；落点三档可配
  （指定文件夹 / 跟随笔记目录 / 仓库根目录，设置 → 附件）；绘图也按此落盘
- 内置绘图：`Ctrl+Shift+D` 或左下角笔图标；工具 选择/抓手/矩形/椭圆/菱形/箭头/直线/画笔/文字/橡皮，快捷键 V H R O D A L P T E；保存 PNG 到附件目录并插入光标处；
  **旋转**（选中图形后顶边出现旋转柄，Shift 吸附 15°）、**草稿箱**（暂存 / 重开多块画板，存本机 localStorage）
- 多标签页：树点击开新标签、`Ctrl+W`/`Ctrl+Tab`、持久化、外删自清理；**无缝标签条**
  （gap 0 + 1px 分隔线 + 整条两端圆角；活跃标签强调色 + 底部 2px 线；悬停只换文字色），**可拖拽换序**
- **Tab 栏即标题栏**：标签条在窗口最顶部，与最小化/最大化/关闭按钮同一行
  （VS Code / Obsidian「Tab 标题栏」模式），编辑区直接从笔记头开始；
  标签卡片**铺满标题栏高度**（顶边贴到窗口最上方，见 §5-53）
- 可拖拽栏宽：侧栏/右栏拖拽 + 双击复位 + 记忆（折叠已兼容内联栏宽，见 §5-9）
- 折叠/展开全部按钮图标双状态（⤡/⤢，随折叠状态切换，参考 Obsidian）
- 左侧功能区：文件/搜索/标签/绘图/图谱（绘图与面板同级）；**切换工作区 = 左上角工作区名（带 ▾ 提示）**：
  点开是最近仓库下拉（当前 ✓）+「管理仓库…」，不再直接跳管理页；左侧栏折叠按钮在工作区名右侧
- 紧凑头栏：标签行 + 笔记头压成一条（合计 < 70px，中间无分隔线，活动标签下圆角为 0）
- 主题：apple/obsidian × 亮暗，强调色/圆角/字号/行宽即时生效，可导出 CSS
- 同步：NAS/服务器方式 + **局域网六位通行码直连**；自动三方合并、冲突副本、删除回收站、
  内容寻址去重、1MB 分块上传、Range 断点下载、自动同步开关/间隔/自动合并开关；
  **端到端加密（v3）**：服务端只存密文 + HMAC 路径，换设备输同一密码即可解密
- 仓库管理：欢迎页浮层（Esc/✕/点空白关闭）、最近列表、原生选文件夹、标题栏仓库名可点
- 文件树右键菜单：文件 = 在新标签页打开/创建副本/星标/复制路径（绝对+相对）/重命名/删除；
  **文件夹** = 在此新建笔记/在此新建文件夹/复制相对路径/在系统资源管理器中显示/重命名/**删除**
  （整棵树进回收站，可整体恢复）；编辑区双链/标签**鼠标点击**即可跳转/搜索（see §5-54）
- **标签页下拉**（标签条最右侧）：列出已打开标签页（当前项 ✓）/ 关闭所有标签页 / 收藏所有标签页（加星标）见 §5-59
- **三种编辑模式**（状态栏右下按钮，Ctrl+E 循环）：实时预览 / 源码 / **阅读**
  （阅读 = 只读 + 全量渲染 + 双链跳转 + 任务勾选，见 §5-61）
- 列表标记渲染对齐 Obsidian：无序列表出圆点「•」、任务列表只剩复选框（§5-62）；有序列表保留真实编号

## 4b. 编辑内核现状（v1.4.0：只有 CodeMirror 6）

- **内核只有一个 = cm（CodeMirror 6）**：旧的块级 contenteditable 内核（`public/js/editor.js`）已删除，
  设置里的「编辑内核」开关也一并去掉；`?engine=...` 参数不再影响内核。下面几条是迁移期的形态说明与结论索引。
- 三个模式同契约切扩展集：**实时预览 / 源码 / 阅读**（见 §5-61），同一份 `EditorState.doc`。
- 文件地图：`public/js/cm/{engine,decorations,editing,widgets}.js` + `public/css/cm.css`
  （CM 样式，**全部用 app 的 CSS 变量** → 明暗主题自动跟随）+ `public/cmlab.html`（探针页）。
  `public/vendor/cm/**` 是离线 vendor 包（`npm run build:cmvendor` 生成；`index.html` / `cmlab.html`
  里的 importmap 也是它注入的 —— **主页面曾经漏了 importmap 导致白屏，见 7.6 结论 1**）。
- **cm 侧 3 处渲染缺口已补齐**（7.12，2026-10-19）：
  1. 行内 `![[图片]]`（前面有文字那种）由 `inlineImageDecos` 产出**行内 replace widget**，
     出图 + `|宽` + 拖宽手柄 + 点图灯箱（`widgets.js`）。
  2. `![](路径)` 的 Markdown 图片同样走行内 widget（`engine.resolveMdImage` 负责相对路径 → `/api/file`）。
  3. 未解析双链补 `.cm-lp-unresolved`（`createLivePreview({resolveLink})`，与块级 `.wikilink.unresolved` 同视觉）。
  两个连带修复：**装饰在笔记索引/文件树刷新后显式重建**（`refreshDecorations`，修「开得太早链接一直未解析」
  与「刚粘贴的附件不出图」）；**`![[..]]` 行内标记的吃字 bug**（`marker:4` → `head:3/tail:2`）。
- **cm 表格已能「编辑单元格」**（7.13）：管道字符隐藏、按列宽渲染成网格，Tab/Shift+Tab 跳格、
  回车加同列数空行（末行末格 Tab 也加行）；文本仍是真实 markdown 行，点哪写哪。
- **写 cm 断言的三条铁律**（实测踩出来的，详见 `EDITOR-MIGRATION.md` 7.11）：
  1. cm 装饰是**视口作用域**的（视口外不建 DOM）→ 任何「全文找 N 个 X」的断言必须**先分段滚动再累加**；
  2. cm 的 history 有 ~500ms 的**合并窗口**（`newGroupDelay`）→「连续操作 → 分步撤销」的测试
     要把步进拉开到 620ms，否则一次 Ctrl+Z 退到底；
  3. 右键在 cm 里**不会移动光标**（只在 state 里），而浏览器默认 `mousedown` 会把选区收拢成光标 →
     引擎在 `contentDOM` 上拦了 `mousedown`（`button===2` 且点落在选区内 → `preventDefault`）。
- 测试口径：**单内核（CM6）**。v1.4.0 起块级内核已删除，`TRACERY_TEST_ENGINE` 不再生效；
  `test/engine-test.mjs`（12 条）与 `test/cmlab-test.mjs` 只跑 cm / 探针页。

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
14. **编辑器回车 / 空行（2026-10-18 二次修正，按 Obsidian 语义）**：回车**只插一个换行**（列表/引用才带前缀），不再自动补空行——想真正分段就回车两次。曾经为了让「回车后接着打」有可见空行，回车会插 `\n\n`，结果用户在空行上打字时凭空多出两行（用户连报两次）。配套的三条：
    ① 渲染器**一行空行一个占位段**（`.md-blank`，可点、可放光标、可打字），不再把连续空行合成一个——合成的话光标分不清自己在第几个空行上，回车后打字会并进上一段。
    ② 序列化**按源码行号差补换行**：`gap = 本块 data-md-line-start − 上一块 data-md-line-end`，gap=1 补 `\n`、gap=2 补 `\n\n`，其余类推。所以空行上打的字留在原行（3 行还是 3 行），标题紧跟正文这种写法也能原样存回。
    ③ 因此 `data-md-line-end` 必须记**块的最后一行**（多行段落 / 代码块 / callout 传 `endLineIdx`）——只记第一行行尾会把块内其余行算成空隙，一次输入能补出十几个空行。
    `test:enter` + `test:gap` 锁死这套行为；改 markdown.js 的拼接逻辑必须两个都跑。
15. **源码模式行号**：textarea 外层包 `.source-wrap`（行号槽 + wrap="off" 的 textarea），切模式隐藏的是 **wrap 不是 textarea**；槽与 textarea 的字号/行高/上 padding 必须严格同参才对得齐；实时预览模式不显示行号。
16. **文件树点图片走灯箱**：图片扩展名（png/jpg/gif/webp/svg/bmp/avif）直接 `openLightbox(Api.fileUrl(path))`，不能再走 `openNote`（API 只认 .md，会报「笔记不存在」）。
17. **标签多了不许挤压**：`.tab` 的 `min-width: 120px` 是底线（低于它标题变「00...」不可读），超出部分横向滚动 + 滚轮横滚 + 溢出侧 `mask-image` 渐隐（`data-overflow` 由 `updateTabOverflow()` 维护）。标签条空白区必须留在拖拽区里（no-drag 只挂 `.tab`）。
18. **覆盖式滚动条与圆角**：Electron/Chromium 用覆盖式滚动条（不占布局、浮在滚动区边缘），`::-webkit-scrollbar-track{margin}` 对它无效——滚到顶部会和纸的圆角边框交叉。正确解法是给滚动容器（`.editor` / `.source-wrap`）让出 `margin: 10px 8px 10px 0`，把滚动区缩进直边里；padding 相应减 10px 保持正文位置不变。
19. **编辑区右键菜单**：文本/图片两套（`showTextMenu` / `showImageMenu`）。两个关键坑：① 点菜单项会让 contenteditable 失焦、选区丢失——右键时把 Range 克隆下来（`editorSavedRange`），每个动作前 `restoreEditorSelection()` 再执行；② 在已选中的文字上右键，浏览器会先折叠选区——`mousedown` 里判断右键点是否落在选区 rect 内，是则 `preventDefault` 保住选区（Obsidian 同行为）。图片相关的路径解析走 `resolveVaultFile`，桌面能力（资源管理器定位/默认应用打开）走 `electronAPI.reveal/openPath`（main.cjs 校验绝对路径）。
20. **编辑区容器贴底**：`.editor-area` 只留上/左右边距，`border-radius` 只圆上半部，底边与窗口相连——状态栏在纸内最底部。
21. **空行是一等公民**：源码里每一行空行都渲染成一行 `.md-blank`（恒占一行高、可点击、可输入）。`serializeBlocks` 里空的占位段直接跳过，行数靠相邻块的 `data-md-line-start/end` 差值补回来（见 #14）。文末「换行之后的那一行」也要占位（不能带 md-blank），否则文件结尾的换行会被吃掉；但它**不参与行号编号**（否则末尾多一个幽灵数字）。
22. **PDF 阅读器**：`.pdf-viewer` 浮层 + iframe 指向 `/api/file?path=...pdf`，靠 Chromium 自带 PDF 渲染；Electron 必须 `webPreferences.plugins = true`，否则是空白页。兜底按钮「用默认应用打开」。
23. **文件树右键菜单**（Obsidian 式）：在新标签页中打开 / 创建副本 / 复制路径（绝对+相对）/ 默认应用打开 / 资源管理器定位 / 重命名 / 删除。`renameNote` 已泛化：非 .md 文件保留原扩展名（原来会把 pdf 改成 .md）。
24. **面板切换必须按栏隔离**：`switchPanel` 原来用 `.sidebar .panel`，会连右栏（大纲/反链/标签）一起命中——切到「文件」时它们 id 不匹配、`active` 被摘掉，表现就是「右侧大纲莫名消失」。必须写 `#sidebar .panel`。右栏三块现在是常驻同屏，空块自动 `.hidden`（反链为空 / 笔记无标签时收起）。
25. **回收站**：删除不再 `unlink`，文件移到 `TRACERY_HOME/trash/<仓库路径 sha1 前 12 位>/<id>__原名` + `index.json` 记原始相对路径。放数据目录而非仓库：不污染笔记目录、不进同步、文件树看不见。**跨盘要兜底**：仓库在 D:/E:、数据目录在 C:，`rename` 会抛 `EXDEV`，必须 `copyFile + unlink`。上限 200 项，超出自动清最旧的。恢复时重名自动加 ` (n)`。
26. **空行恒占一行高、一行一个**（2026-10-18 第二次重写）：一行空行 = 一个 `<p class="md-blank">`（序列化跳过、文件不变），必须恒占一行高（`min-height: 1.78em`），不能是「零高 + 点中时撑开」。**连续空行也一行一个**——合成一个占位段的话，光标在 DOM 里分不清是第几个空行，回车后在空行上打字会落到上一行、并进上一段（用户 2026-10-18 报的「点第二行输入 123，莫名其妙多出两行」）。相邻块外边距用 `#editor-live > *:has(+ .md-blank)` / `.md-blank + *` 让位，视觉间距仍≈一行。`test/gap-test.mjs` 锁死。
27. **代码高亮是渲染层的事**：`highlightCode()` 只在渲染时把代码切成 `tok-*` span，序列化仍走 `code.textContent`，所以 md 字节不受影响。改高亮规则只需动 `CODE_KEYWORDS` / 分支正则。
28. **表格键位要抢在编辑器前面**：编辑器自己的 Tab 是「缩进」，表格 Tab 跳格必须用**捕获阶段**监听并 `stopPropagation()`，否则缩进逻辑先命中。回车加行是直接改 DOM 再 `dispatchEvent(new InputEvent('input'))`，让正常序列化流程接住。
29. **右栏是三按钮切换**（大纲/反链/标签），`switchRightPanel()` 维护 `.rs-tab.active` + 面板 `.active`，选择记在 `tracery.rsTab`。别再改回常驻同屏——用户明确要求三按钮切换。
30. **导出**：`buildExportHtml()` 内联全站 CSS + 图片转 data URL → 自包含 HTML；PDF 走 Electron `tracery:export-pdf`（隐藏 BrowserWindow → printToPDF → 保存对话框）。入口在命令面板。
31. **图片拖拽调宽**：`![[img|宽]]` 的右下角手柄拖拽 → `setImageWidth()` 改写 token 里的数字（0 = 去掉尺寸，双击手柄还原）。手柄 pointerdown 必须 stopPropagation，否则会触发灯箱。
32. **全文替换会留快照**：`/api/replace` 逐篇 `split/join`（纯文本、非正则），写之前调用 `snapshotHistory()`——所以替换错了可以用版本历史回滚。遍历用 `vault.notes.keys()`（Map，只含 .md）。
33. **版本历史**：保存前把旧内容写到 `TRACERY_HOME/history/<仓库哈希>/<相对路径>/<时间戳>.md`，每个文件留 20 个；`/api/history*` 提供列表/内容/恢复；UI 在命令面板「查看历史版本」，点行展开预览、点恢复先给当前内容再存一份快照。
34. **光标坐标只准用一套（Markdown 偏移）**（2026-10-18 修）：`_saveCaret()` 必须返回 `domPointToMd()` 的 md 偏移，`_renderLive()` 重建 DOM 后用 `_restoreCaretMd()`（即 `mdOffsetToDom()`）还原。旧实现用「纯文本第几个字符」，当光标停在一个空块上（锚点是元素而不是文本节点）时 `textOffsetOf` 会返回整篇文本长度 → 重建后光标被甩到全文末尾（用户看到的「在空行打字，打完光标跑到下一段行尾，再输的字全进那一行」）。配套两条：① `domOffsetBrAware` 必须特判「锚点 === 块本身」（只累加前 offset 个子节点），否则空块里的 `<br>` 被算成 +1，回车/输入整体错位一格；② 在空行上刚打的字序列化后会往下挪一行（段落之间要补空行），`_saveCaret` 要跟着 +1，否则光标少走一格、字插进中间。`load()` 换文件前先清选区，别把上一篇的光标带过来。
35. **撤销必须自己实现快照栈**（2026-10-18）：contenteditable 每次输入都 `innerHTML` 重建 DOM，浏览器原生 undo 栈跟着节点一起没了。`editor.history = [{md, caret}]` + `hIndex`：连续输入 520ms 静默合并成一步，结构操作（回车/缩进/加粗/插入片段）走 `_scheduleHistory(0)` 单独成一步；`undo()/redo()` 直接换 `md` 再 `_renderLive()` + `_restoreCaretMd()`，**不经过** `_replaceRange`（否则会再入历史）。快捷键 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y，右键菜单和命令面板也能进。三条容易踩的：① `load()` 里「内容一模一样」必须直接 return——自动保存后 WS 会把文件变更广播回来，再 `load()` 一次就会清空撤销栈（表现为「刚撤完就跳走」）；② 源码模式用 textarea 原生撤销，切回实时模式时 `_resetHistory()` 重新起栈；③ 撤销后再输入要砍掉 redo 尾巴（`history.length = hIndex + 1`）。
36. **实时预览行号是测量出来的**：`_collectLineNumbers()` 遍历编辑区顶层块，用 `data-md-line-start`（源码字符偏移）换行号，块内**按 `<br>` 切分源码行**（`sourceLineTops`）——长句自动折行仍是同一行，只编一个号（按视觉行编号会让标题折成两行后全局串位）。代码块按行高逐行算，表格按 tr、列表按 li。数字画在 `.live-gutter` 覆盖层里，滚动只改 `translateY`。代码块首行是 ``` 围栏、预览里看不见，所以行号会从 `start+1` 开始（7 → 9 这种跳号是正常的）。开关：设置「编辑器 → 行号」（`lineNumbers`），源码槽与实时槽共用；**新增设置项记得同步 `server/server.js` 的 `DEFAULT_SETTINGS` 与 `mergeSettings` 白名单**，否则保存后被服务端丢掉、WS 再广播回来又把开关弹回默认（这个坑当场踩过一次）。
37. **右键菜单不用 emoji**：图标统一走 `ICON`（16 格线性 SVG，`S()` 包一层），排版类选项用 `.mi-txt` 字型（H1/B/I/¶）。行高 24px、`gap: 8px`、分隔线 `--hairline-strong`——emoji 会把行撑到 44px，菜单长得离谱（22 项直接占满一屏）。

38. **绘图白板（Excalidraw 风格，2026-10-18 重写）**：`draw.js` 是 canvas 2D 的场景图，不是「一堆笔画」。要点：
   ① **rough 渲染**用 `mulberry32(seed)` 生成确定性抖动折线（同 seed 重绘画面不会「呼吸」），每条线描两遍；椭圆按角度抖动半径；填充用「裁剪到形状 + 45° 扫线」做排线（solid 直接填精确路径）。
   ② **坐标系**：元素存世界坐标（`x,y,w,h,points`），`view{x,y,zoom}` 负责平移缩放，绘制时 `setTransform`，命中检测时临时切回单位矩阵再 `isPointInPath`（否则路径会跟着变换跑偏）。
   ③ **交互**：pointerdown 分派到 pan / select（缩放柄→resize、命中→move、空白→marquee）/ erase / text / create 五种 drag 模式；形状画完自动切回选择工具并选中它（Excalidraw 默认 lock=off 的手感）。选中时改样式 = 直接改选中元素（`styleForSelected`），并 `adoptSelectionStyle()` 让面板回显。
   ④ **撤销**用整个 `elements` 数组快照，`snapshot()` 里做了 JSON 去重；**文字元素必须在 commitText 时才入历史**——创建时入历史会把「空文本」存进去，撤销时刚打的字全没（踩过）。
   ⑤ 保存：`exportPng()` 只截内容包围盒 + 28px 留白、白底、2 倍超采样；场景存 `{v:2, elements}`。代码块 ```` ``` ```` 围栏这种「源码有、预览没有」的行同理适用于行号跳号。

39. **编辑区内核要换（下一步，别在旧内核上继续堆补丁）**：现在的「块级实时预览」是 `md 唯一真源 + 整篇重建 DOM + 字符偏移光标`，用户已明确要求往 Obsidian 的**行级模型**靠。迁移方案、验收表、分阶段计划、以及「换内核时必须原样保留的 API / DOM / 测试契约」都写在 **`docs/EDITOR-MIGRATION.md`**。一句话：引 CodeMirror 6 做 doc+装饰，`markdown.js` 的 `renderMarkdown/serializeHtml` 保留给导出/嵌入/预览用，`editor.js` 只换内部实现、对外 API 不变。**开工先做 P0 探针页**（`public/cmlab.html`），验证 IME / 行号 / 3000 行性能 / widget 高度变化，再决定全量迁移。


---

## 5b. 2026-10-18 晚补充决策（接 #39）

40. **文末空行也编号**（更正 #21 的旧结论）：#21 说「文末换行之后那一行不参与行号编号，否则多一个幽灵数字」——**错了**。Obsidian（CM6）口径：行数 = 换行数 + 1，文末空行有号。用户实测「段落 + 5 个 \n」Obsidian 显示 1-6、Tracery 只显示 1-5。已修：`_collectLineNumbers` 不再跳过文末空行，polish-test 有回归。同源考证：Obsidian 用 CM6 原生 `lineNumbers()`（见 EDITOR-MIGRATION.md 第 3 节附考证）。
41. **跨行删除必须走模型层 + DOM 结构安全网**（2026-10-18 用户实测的严重 bug）：行首连续 Backspace 会把 1-7 行在**视觉上**合并，但行号槽 2-8 残留成死区、Ctrl+Z 无可撤销、切源码模式内容完好——删除只发生在 DOM 层没进模型。根因：序列化按 `data-md-line-*` 旧 offset 做 gap 补换行，会把浏览器原生块合并的结构原样重建 → md 不变 → `_onInput` 跳过重渲染。修法两层：① 键盘层拦截——行首 Backspace（删上一个 \n + 本行标记前缀）、行尾 Delete（删下一个 \n + 下一行前缀）、跨块选区删除（按 md 范围删）、列表/标题内容起点 Backspace（outdent 去标记），全部 `_replaceRange` 走模型；② `_onInput` 安全网——「md 没变但 `_domSig()`（所有带 offset 标记元素的签名）变了」就强制重渲染，DOM 永远恢复成模型的样子。回归：`npm run test:backspace`（19 项）。已知边界：引用块行首、代码块/表格内的行合并在块级模型里位置不可表示，不拦，靠安全网兜底（CM6 迁移后天然解决）。
42. **P1 只读渲染完成：CM6 装饰层与块级渲染共用一份解析**（2026-10-18 晚）：`markdown.js` 拆出 `parseMarkdown(md) → 块 AST`（带 lineStart/lineEnd/contentStart 与各类型数据），`renderMarkdown = render(parse)` 行为逐字不变（roundtrip 22 篇不动点 + 300 篇模糊 + gap/enter/polish 全绿）；新建 `public/js/cm/decorations.js`——`livePreviewPlugin`（ViewPlugin：标题行装饰、行内样式+标记隐藏、列表标记、引用/分割线/表格行、光标行规则）+ `fenceHiding`（StateField：围栏行与表格分隔行整行收起）。cmlab 探针页接入真装饰器，新增第 ⑤ 项 10 条断言（全过）。**9 个坑**写在 `EDITOR-MIGRATION.md` 7.2 节，最要命的三个：装饰生成器里一个非法 range 会让 CM6 **整体禁用**该插件（全部装饰消失，需 build 层 try/catch + 逐条校验 from/to）；AST 行号 0-based 与 `doc.line()` 1-based 混用会整体挂歪一行；正则扫描器拒绝重叠匹配后必须回退 `lastIndex`，否则 `**粗**` 内部的假匹配会吃掉后面的真匹配。下一阶段 P2 的开工提示词见迁移文档第 8 节。

43. **CM6 迁移主体完成：默认内核已切 cm（2026-10-19）**：P2 行内编辑（`cm/editing.js`：Enter 续列表/任务列表、Tab 缩进、Ctrl+B/I/S/K、粘贴拖入拦截）、P3 块级 widget（`cm/widgets.js`：图片嵌入+拖宽、复选框、Callout、表格行、双链/标签事件）、P4 引擎适配器（`cm/engine.js` + app.js 工厂 + `settings.editorEngine`）、P5 收尾（`public/css/cm.css` 补齐 CM 样式并用 app 的 CSS 变量、17 个套件参数化为 `TRACERY_TEST_ENGINE`、全量双引擎回归、打包链路打通）全部完成，逐阶段结论在 `docs/EDITOR-MIGRATION.md` **7.3~7.11**。**顺带修掉 6 个真 bug**：cm 附件回调漏 import（7.7 结论 4）；`#editor-live` 滚动关链接预览在 cm 失效（7.7 结论 3）；右键把 CM 选区收拢成光标（7.10）；空列表项/空引用回车在 cm 里不退出列表（7.10）；`.cm-widgetBuffer` 把 2em 标题行撑高 23px（7.10）；cm 粘贴图片不改名 + **CRLF 笔记大纲为空**（7.11）。~~默认保留 `settings.editorEngine` 一键回退，旧块级内核不删~~ —— **v1.4.0 已改为只保留 CM6，见 #58**。

58. **下线块级内核：编辑器只留 CodeMirror 6**（2026-10-19，v1.4.0）：
    块级内核是「整篇 markdown → 重建 DOM」，光标、空行、图片宽度、表格对齐这些问题**全都出在重建上**；
    两套渲染规则并行维护，等于每个渲染类改动都要写两遍、测两遍，bug 也会在两边来回搬。
    这次把它整体删掉：`public/js/editor.js`（1310 行）删除、`settings.editorEngine` 开关删除、
    `?engine=block` 失效、测试的 `TRACERY_TEST_ENGINE` 口径失效（默认与唯一都是 cm）。
    **安全网**：v1.3.0 的 tag 完整保留了双内核版本，真要回退 `git checkout v1.3.0` 即可。
    **代价**：少了一个"万一 cm 挂了"的备选——但那个备选本身没人用、也没人测，等于没有。

50. **标签栏「无缝」的正确解法：整条 strip 两端圆角 + 标签只留右侧分隔线**（2026-10-19）：
    给每个标签单独的圆角上沿 + gap，会在大屏上留下明显的缝；**直接贴死**又会在两个圆角之间
    露出标题栏底色（一个 9px 宽的小三角缺口）；**负边距重叠 8px** 也会让下层标签的圆角边线
    从上层透出来（试过，像重影）。最终：`gap:0`、标签 `border:none; border-right:1px solid hairline`、
    整条 `border-radius` 只落在 `.tab:first-child` / `.tab:last-child` 上，活跃标签用
    「纸色底 + 底部 2px 强调线」区分。视觉上是一条连续的标签条，而不是一排卡片。
51. **表格列宽只量不压，超宽就横向滚动**（2026-10-19 用户拿 Obsidian 同款表格对比后改）：
    ① 表头是 600 粗体，必须单独量（否则表头比正文宽一点点就折行，整行看着像错位）；
    ② **不做按可用宽度压缩**——压过之后单元格内部重新折行，「表格塌了」比横向滚动难看得多；
    ③ 表格行加 `.cm-lp-tbl { white-space: pre }`，单元格也 `pre`，超宽时由 `.cm-scroller`
    出横向滚动条（Obsidian 同款行为）。
52. **工作区名 = 下拉，不是跳转**（2026-10-19 用户要求）：点工作区名用 `showMenu` 弹出
    「最近仓库（当前 ✓）+ 管理仓库…」，只有点最后一项才进仓库管理浮层。
    `showMenu` 顺带支持了 `title`（悬停看完整路径），别在菜单里塞路径文本（太宽）。

48. **绘图二次编辑 = 场景 JSON 回填 + 原地覆盖**（2026-10-19）：
    每张绘图保存时都会在 PNG 旁边写 `<同名>.draw.json`（v2 场景）。右键图片 →「编辑绘图」读这个 JSON
    回填白板（`fitViewToContent()` 把内容缩到可见范围），保存走 `/api/asset` 的 `overwrite`：
    **覆盖原 PNG + 原 JSON**，笔记里的 `![[路径]]` 一个字都不用改。
    两个配套点：① 覆盖后浏览器会拿旧图，`/api/file` 加 `Cache-Control: no-cache` +
    前端 `reloadImagesFor()` 给 `<img>` 加 `?v=时间戳`；② `overwrite` 只允许仓库内**已存在**的文件，
    与其它接口同一套路径校验口径。
49. **同步 v3 端到端加密的四个关键取舍**（详见 `docs/SYNC.md` 第 10 节）：
    ① 密钥：`scrypt(密码,salt)` → HKDF 分 `encKey` / `nameKey`；密码不落盘，`encKey/nameKey` 存
       `.tracery/sync.json`（不参与同步）。服务端只放 `{salt, check}`，新设备靠它验密码。
    ② 路径：manifest key = `HMAC(nameKey, 路径)`；路径→hmac 的反向映射放在**加密索引 blob**
       （manifest 固定 key `tracery-v3-index`），随文件变更同一次 commit 提交。
    ③ 内容：AES-256-GCM，blob = `TRC1|iv|tag|ct`；**IV 由明文确定性派生**，所以「同内容=同密文」，
       服务端去重与 sha 比较照旧成立，解锁后也不会把两边相同的文件误判成冲突。
    ④ base：本地/远端各存一种 sha（`{l,r}`），比较语义才不串味；下载=先解密再落地。

46. **标签栏 = 卡片式标签 + pointer 拖拽换序**（2026-10-19 按用户给的参考图改）：
    非活跃 = 浅底 + 发丝边 + 圆角上沿；活跃 = 纸色底 + 强调色文字 + 底部 2px 强调线；
    **悬停只换文字色**（不铺底色，整条栏不闪）；关闭按钮常显但压到 0.45 透明度。
    拖拽**不用 HTML5 DnD**（标题栏是 `-webkit-app-region: drag`，Electron 里时灵时不灵），
    改用 pointer：移动 >5px 才进入拖拽，按指针相对目标标签中线判定插前/插后，
    `elementFromPoint` 找落点、`pointerup` 时重排 `state.tabs`；**活跃标签跟着「那篇笔记」走**
    （重排后按路径重新取下标，不能沿下标）。拖完会补一个 click，用 `suppressTabClick` 吞掉。
47. **cm 表格：真实行 + 单元格装饰，不做 `<table>` widget**（7.13）：整块 replace 会让光标进不去；
    现在只藏 `|`、给单元格挂 `Decoration.mark(.cm-lp-cell)`，`inline-block` + 估算列宽（写进
    `attributes.style.width`）才有表格的样子。**底色/边线只画在单元格上**——画在 `.cm-line` 上会拖出
    整宽色带和长横线。Tab/Enter 的判定走 `parseMarkdown` 的 table 块（避免误判代码块里的 `|`）。

44. **图片的虚线框与拖宽手柄只在悬停时出现**（2026-10-19 用户反馈「常驻虚线框 + 橘色方块太丑」）：
    默认态只剩图片本身（圆角 + 阴影）；悬停时用 **outline** 画虚线框（**不能用 border**——border 会改盒尺寸，
    行内图片一 hover 就重排、还要惊动 CM 重新测量）；拖宽手柄平时 `opacity:0 + pointer-events:none`，
    悬停浮现，外观对齐块级 `.img-grip`（纸色小方块 + 发丝描边 + 右下角折线，**不再是 accent 色方块**）。
    实现上 `.embed-image:hover` 写在 `style.css`，两个内核共用（cm 的 widget 也带 `.embed-image`）。
45. **滚动条必须贴着编辑区右缘**（同一天用户截图反馈「宽窗口下滚动条跑到纸张中间」）：cm 的 `.cm-editor`
    **不能吃** `.editor > * { max-width: 720px; margin:auto }` 那条居中规则——滚动条属于它内部的 `.cm-scroller`，
    `.cm-editor` 只剩 720 宽时滚动条就停在纸中间。正确配方：`.cm-editor` 整宽（`max-width:none`），
    正文列宽由 `.cm-content` 的左右 padding 居中：
    `max(48px, calc((100% - var(--cm-gutter-w) - var(--editor-width))/2))`（gutter 45px，实测文本列 721px）。
    同时 `.editor` / `.source-wrap` 去掉右侧那 8px 内缩——`::-webkit-scrollbar-track{margin:14px 0}` 已经足够
    避开纸张圆角，不需要再挤进来。**副作用**：块级内核的正文列其实一直是左对齐（`.markdown-body p/h*`
    的 `margin` 简写盖掉了 `.editor > *` 的 auto 左右边距），与 cm 的居中不一致；属历史遗留，暂未动。

53. **标签页要「铺满标题栏」（容器到顶）**（2026-10-19 用户截图反馈）：`.tablist` 的 `align-items`
    由 `flex-end` 改 `stretch`、`.tab` 高度由固定 `33px` 改 `100%`。原来标签是「33px 卡片贴底坐」，
    顶边离窗口最上方留了 12px 空条，活跃标签的纸色底接不到窗口顶；改完全高 45px（= 标题栏 46px − 1px 底边线）。
    **测试契约同步改**：`test/tabs-test.mjs` 原来断言 `height <= 40`，现在断言「顶边 top ≤ 1 且高度 ≈ 标题栏高」。
56. **绘图旋转：角度绕「未旋转包围盒中心」，不做逐形状的旋转几何**（2026-10-19 用户报「画了直线不能转」）：
    元素加 `angle`（弧度，缺省 0 = 老场景兼容）。绘制在 `drawElement` 里最外层 `translate/rotate`，
    命中检测把指针**反向转回本地**再走原判定，导出 PNG 的裁剪框改用 `elementExtent`（旋转后外接框，
    否则转出头的部分会被裁掉）。旋转柄画在「顶边中点 + 本地朝上方向外推 26px」，Shift 吸附 15°。
    **缩放要补偿**：绕中心转的时候，改包围盒会让「被钉住的锚点」在世界里漂移——
    算法是先把指针逆旋转到本地做轴对齐缩放，再把新中心相对旧中心的漂移一次性平移回去
    （中心与点同时平移 s ⇒ 旋转结果也平移 s，所以一次补偿即精确，不用迭代）。
57. **绘图「暂存 / 多开画板」= 草稿箱 + 场景 JSON 存 localStorage**（2026-10-19 用户需求）：
    一个画板 = 一条草稿（`tracery.drawDrafts`，只存场景 JSON，不存 PNG）；「暂存」命名入库、
    「草稿箱」列出并重开、「新建画板」清空画布去开第二块。**为什么不用仓库/服务端**：草稿是
    「还没决定要不要插进笔记」的半成品，落进仓库会污染文件树、还会进同步（每台设备再合并一遍）。
    从草稿箱重开的画板再点「暂存」= 覆盖那份草稿（继续画的手感），要另起一块走「新建画板」。
    顺带把 `.dialog-backdrop` 的 z-index 由 600 提到 **760**（> 灯箱 700 > 绘图浮层 680）——
    否则在绘图浮层里调 `askText` 会被 680 的浮层盖住（askText 在 body 上，层级比浮层低）。
54. **「编辑区双链点击不跳转」的根因 = 光标行规则把 span 拆了**（2026-10-19 用户报障）：
    cm 的实时预览里 `.cm-lp-wikilink` 是「光标行不挂牌」的——真实鼠标点击时，浏览器的 `mousedown`
    先把光标落到该行 → 本行变光标行 → 装饰重建时 mark/hide 全撤 → span 消失；紧接着派发的 `click`
    就 `closest` 不到它，于是**用鼠标点双链毫无反应**（实测确认：合成 `span.click()` 能过、真实点击必挂）。
    修法：`cm/widgets.js` 的 `linkEvents` 加 `mousedown` 处理——左键落在 wikilink/tag 上时
    `preventDefault()` 并返回 `true`（顺带阻止 CM 把选区设到点击处），选区不动 → span 还在 → click 正常跳转。
    回归断言在 `test/engine-test.mjs` 新增一条**真实鼠标点击**（`page.mouse.click`），不要只用合成 click。
55. **文件夹右键菜单补齐 + 目录级回收站**（2026-10-19 用户报「右键文件夹没有删除」，参考 Obsidian 菜单）：
    菜单补 复制相对路径 / 在系统资源管理器中显示（桌面版）/ 重命名 / 删除。
    两个连带要点：① **树节点只带 basename**（服务端 `tree()` 按层级拼），所以 `renderDir` 递归时要把
    父级相对路径拼进来（`rel = parent + '/' + d.name`），否则删除/重命名拿不到完整路径；
    ② **目录删除是「整棵树进回收站」**：`/api/delete` 对目录走 `vault.open()` 整仓重扫
    （`applyChange` 只删它自己那一条，子笔记的索引/反链/图谱会残留），回收站里就是「一条目录项」，
    恢复时整棵树回来。服务端配套：`moveToTrash`/`restoreFromTrash` 的 EXDEV 兜底对目录改用
    `fsp.cp(recursive)` + `fsp.rm(recursive)`（原来 `copyFile` 对目录会抛 EISDIR）、清理淘汰用
    `fsp.rm(recursive, force)`、`/api/rename` **目录不参与双链自动改写**（否则「日记」目录会把指向
    `日记.md` 的双链一起改掉）。

59. **标签条最右侧的「标签页列表」下拉**（2026-10-19 用户需求，参考 Obsidian 的标签下拉，但功能按用户说的来）：
    按钮 `#btn-tab-more` 放在 `.tablist` **之后**（紧贴标签条右端）、铺满标题栏高度；标题栏是拖拽区，
    必须显式 `-webkit-app-region: no-drag`。菜单三项：① 列出当前打开的标签页（当前项带 ✓，点一项即切过去，
    完整路径放 `title` 悬停看）② 关闭所有标签页 ③ 收藏所有标签页（= 把每个标签都加进文件树顶部「星标」，
    §5-23 那套 `state.pinned`，已加过的跳过）。`showMenu` 为此新增 `checked` 支持（`.mi-check` 靠右对勾）。
60. **编辑区四周缝隙刷成侧栏底色 + 拖拽热区压在纸张边缘**（2026-10-19 用户要求「缝隙和侧栏同色，编辑区
    像浮在页面上；调整侧栏位置的地方要和编辑区左右位置重合」）：
    ① 底色统一由 `.layout` 承担（`background: var(--bg-sidebar)`），`.sidebar` 改成**透明**——
       否则侧栏上会再叠一层半透明色、比缝隙深一档，「同色」就不成立（明暗主题都是半透明变量）。
    ② 拖拽热区要**压在纸张边缘**上（视觉边界既然变成纸张边缘，拖拽点也得跟着挪）：热区宽 10px，
       用不对称负 margin 把它整体挪过去 —— 左 `margin: 0 -15px 0 6px`、右 `margin: 0 6px 0 -15px`，
       使**热区中心 = 纸张边缘**，同时「热区 + 两侧 margin」净宽仍是 1px，纸张位置逐像素不变。
    `test/layout-test.mjs` 新增两条锁死（缝隙色 == `--bg-sidebar`；热区中心与纸张左右边缘 ±2px）。
61. **阅读模式 = 第三种模式（只读 + 全量渲染）**（2026-10-19 用户需求，参考 Obsidian 阅读视图）：
    **同一份 doc 换扩展集**，不是第二个视图（与源码模式同构）。六个要点：
    ① 只读：`EditorView.editable.of(false)` + `EditorState.readOnly.of(true)` → `contenteditable=false`，
       元素不可聚焦 → 键鼠都进不来，键盘快捷键（含 Ctrl+B/Z）自然失效；
    ② 全量渲染：装饰换「阅读变体」= 同一个 `createLivePreview` / `createFenceHiding` / `widgetExtensions`
       传 `readOnly: true`，**它只做一件事：把「光标行」集合变成空集**——所有标记一律隐藏、widget 一律显示
       （= 剥离源码后的成品）。不再另写一套装饰（这是「不重复两套渲染」的关键取舍）；
    ③ 阅读模式不装 `editingExtensions`：既然不可编辑，粘贴/拖入文件也不该往正文里插东西；
    ④ 隐藏行号（Obsidian 阅读视图也没有）；⑤ 保留轻量交互：双链/标签点击跳转、任务框 pointerdown 勾选
       （`editable:false` 只挡用户输入、不挡 dispatch）、图片点开灯箱（但拖宽手柄在阅读模式隐藏）；
    ⑥ **引擎里所有 mutation 方法都加了 `isRead` 提前返回**：编辑器无焦点时键盘进不来，但右键菜单 /
       命令面板 / 绘图「插入笔记」这些非键盘入口仍会调它们——漏一个就会在阅读模式下偷偷改掉笔记。
       右键菜单在阅读模式下把「改内容」的项置灰（改不了的项如复制/查看大图照常可用）。
    **模式按钮改成三态循环**（实时预览 → 源码 → 阅读），标签/图标/标题同步；阅读模式下换笔记**保留模式**
    （`loadTab` 传 `keepMode: editor.isRead`）。**旧断言按新设计改写**：engine-test 里「点两次按钮回实时预览」
    （原 2 态语义）改成走完整三态循环；**backspace-test 里「Ctrl+E 按两次 = 源码再切回」也改写成
    显式 `setMode('source')` / `setMode('live')`** ——按两次 Ctrl+E 现在会落到阅读模式，是把后面十几条用例
    一起带成「打不了字 + 没有行号槽」的根因（排查见 §6）。今后凡涉及模式的用例一律用 `setMode`，
    不要数按键次数。
62. **无序列表标记渲染成圆点 `•`**（2026-10-19 用户报「这个 `-` 没渲染成 `·`」，问还有没有同类情况）：
    `decorations.js` 的 `collectItemDecos` 先把「缩进 + 标记字符 + 空格（+ 可选任务方括号）」整段识别出来
    （`LIST_MARKER_RE`，只认 `-*+`）——普通无序项把**标记字符**换成 `BulletWidget`（后面的空格留着当间隔，
    嵌套缩进保持不动）；**任务项**把「标记 + 空格」整段藏掉（复选框就是它的标记）。有序列表**不动**
    （`1.` 是真实编号，要给用户看见）。光标行照旧露源码（`build` 里的光标行规则会跳过这两条装饰）。
    `createLivePreview.build` 为此新增「带 widget 的 replace」分支。
    **体检结论**：`#`/`>`/`**`/`==`/`` ` ``/`|`/围栏/`---`/`[ ]`/`[[ ]]` 本来都已正确隐藏或渲染，
    只有列表标记这一处漏了。另发现一个同类相邻问题（**首行 UTF-8 BOM 让标题不被识别**，见 §6，本次未修）。

63. **首行 UTF-8 BOM 让标题失效 → 在「读入口」剥掉**（2026-10-20 用户报障，修的是 §6 记过的那条）：
    症状是「`#` 不隐藏、没有标题样式、右栏大纲漏」，搜索/标签/反链索引同样漏。
    根因：全文解析是**逐行正则** `/^(#{1,6})\s+(.*)$/`，匹配不上 `\uFEFF#`。
    修法：**只在 `vault.indexNote()` 这一个读入口**把首行 BOM 剥掉（`text = '\uFEFF' ? slice(1) : content`），
    后面所有 `content` 的引用改用 `text`。为什么选这一个点 —— `indexNote` 同时喂两处：
    ① `contentCache` → `/api/note` → 编辑器 + 右栏大纲（客户端拿 `refreshRightPanels(note.content)` 现扫）；
    ② 笔记索引 → 搜索 / 标签 / 反链 / 图谱。**一处剥掉，六处全对**，不用去每个扫描器里各写一遍
    「`\uFEFF?` 可选匹配」（那样还得逐处补偏移补偿，极易漏一个）。
    为什么不在写回时也统一改文件：**磁盘字节不动** —— 用户不改这篇笔记就不会动到文件；
    一旦保存（doc 里已经没有 BOM），文件顺手被规范化。同步来的笔记走 `fs-change` → `Api.note()` 也过这条漏斗 ✓。
    `test/features-test.mjs` 新增两条断言（带 BOM 笔记的首行 `#` 隐藏 + 标题样式、大纲列出首行标题）。
    ⚠️ 写这类断言时注意**光标行规则**：刚打开时光标在第 1 行、按设计会露出源码 `#`，
    所以断言前要先把光标挪走（否则会误判成没修好）。

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
| 打包时 electron-builder 解 winCodeSign 报「客户端没有所需的特权」（创建符号链接） | 那条路需要管理员 / 开启 Windows 开发者模式；**本机更稳的是 `npm run dist:dir:nosign`**（= `electron-builder --dir --config.win.signAndEditExecutable=false`，跳过签名 + 改 exe 资源，于是不需要 winCodeSign）。代价：**exe 文件本身**没有自定义图标/版本信息（窗口/任务栏图标正常，`main.cjs` 显式设了 `icon: build/icon.png`） |
| 打包时 winCodeSign 从 GitHub 下载超时（`connect ETIMEDOUT 20.205.243.166:443`） | 这台机器上 GitHub 连不上（`git push github` 同样超时）→ 标准 `dist:dir` 是**网络 + 权限双重卡死**；`dist:dir:nosign` 完全离线可跑。补推 GitHub：网络好了跑 `git push github main` |
| 右栏「大纲」对 CRLF 笔记显示「当前笔记没有标题」 | `refreshRightPanels` 用 `^(#{1,6})\s+(.*)$` 逐行扫标题，而 **JS 正则里 `.` 不匹配 `\r`、`$` 也不会落在 `\r` 之前** → Windows 上 git 检出的 CRLF 笔记一条标题都扫不到。修法：扫之前统一 `replace(/\r\n?/g, '\n')`。**凡「逐行正则 + `$` 锚点」都要先归一化换行**（Mac/Linux 上永远跑不出来） |
| Gitee 发行版上传附件报 `Something went really wrong, and we can't process that file` | Gitee 发行版**单附件上限 100MB**（GVP 项目 200MB）。Electron 包 zip 约 110MB 必挂 → 上传 `npm run release` 自动产出的 `.7z`（约 71MB）；只想要 zip 时可以切成 `part1/part2` 让用户 `copy /b` 合并 |
| 打包报 `remove dist\win-unpacked\d3dcompiler_47.dll: Access is denied` | 有打包版正在运行（句柄锁），先关掉应用再打包；或在另一个输出目录出包（`--config.directories.output=dist-x`）。`tasklist \| grep -i tracery` 能确认 |
| 跑套件会重写 `test/screenshots/*.png` 与 `demo-vault/Markdown 语法.md` | 前者是截图存档的副作用，后者是**块级内核的序列化 bug**（`- 嵌入笔记：![[常用代码]]` 被拆成三行，见 #41 / 7.7 结论 6）。跑完一律 `git checkout -- test/screenshots "demo-vault/Markdown 语法.md"` 复原，别提交 |
| 笔记首行带 UTF-8 BOM（记事本「UTF-8 带 BOM」另存）时，首行 `# 标题` 不被识别为标题 | 实测确认（2026-10-19）：`#` 不隐藏、没有 `.cm-lp-h1` 样式，右栏大纲也漏这一条。根因：解析走逐行正则 `^(#{1,6})\s+`，匹配不到 `\uFEFF#`。**2026-10-20 已修**：在服务端读入口 `vault.indexNote()` 剥掉首行 BOM（一处修、编辑器/大纲/索引全对），见 §5-63。写断言时记得光标行会露 `#`，先挪光标 |
| 改了三态模式后，`backspace-test` 一次性挂了 19 条（症状：打字进不去 + 行号槽为空） | 不是编辑器坏了，是**用例里那两下 Ctrl+E**：旧语义「按两次 = 源码再切回实时预览」，三态循环后按两次落在**阅读模式**（只读 → 键鼠全废、无行号），后面所有用例跟着废。排查手法：先另起一个干净实例量 `editor.mode / showLineNumbers / contenteditable / .cm-lineNumbers` 全正常 → 说明是套件自身的假设过期，再去套件里找模式相关的按键。**结论：涉及模式的用例一律 `setMode(...)`，别数按键次数**（同类排查见 §5-61） |

## 7. 新对话怎么继续（按优先级）

**最近一轮（2026-10-19 晚 · 第二轮）已完成**：标签条最右侧的标签页下拉（§5-59）、缝隙刷侧栏色 +
拖拽热区压在纸张边缘（§5-60）、阅读模式（§5-61）、无序列表标记渲染成「•」（§5-62）。
新增断言落在 `engine`（阅读模式 4 条 + 三态循环改写）、`tabs`（标签页下拉 4 条）、
`layout`（缝隙配色 + 热区位置 2 条）、`features`（列表圆点 2 条）。
**两处按新设计改写的旧断言**：`engine-test` 的「模式点两次」、`backspace-test` 的「Ctrl+E 两次」
（都是两态 → 三态的后果，见 §5-61 / §6）；`cmlab` 探针页的「列表标记常显」改成「渲染成圆点」。
单内核（cm）全量套件回归：**22 个套件全绿**（含 cmlab 自动探针 + IME、backspace 20/20、sync 27/27）。
另有两条相邻问题只登记未修：首行 BOM 让标题失效（§6）、块级内核已删除故 §6 里块级相关条目仅供追溯。

**再上一轮（2026-10-19 晚 · 第一轮）已完成**：编辑区双链/标签鼠标点击跳转（§5-54）、文件夹右键菜单补删除/重命名等 +
目录级回收站（§5-55）、标签铺满标题栏（§5-53）、绘图旋转（§5-56）、绘图草稿箱 / 多开画板（§5-57）。
新增断言落在 `test/engine-test.mjs`（真实鼠标点击双链）、`tabs-test.mjs`（标签顶边到顶）、
`menu-test.mjs`（文件夹菜单）、`trash-test.mjs`（目录删除/恢复）、`draw-test.mjs`（旋转 + 草稿箱），
**block / cm 双引擎各跑一遍全绿**（结论见下表）。

1. ~~cm 侧 3 处渲染缺口~~ ✅ **已完成（7.12）**：行内 `![[图片]]`/`![](路径)` 出图、双链 `unresolved` 类；
   e2e #11 与 `ui-ux` 的 4 条图片断言已拆掉门控。仍未回收的 3 条门控（features ②③、layout ②、backspace ④）
   与渲染无关，理由写在 7.12「门控清单变化」。
2. ~~发版 v1.2.1~~ ✅ **已完成（2026-10-19）**；**v1.3.0 已打包并发布**（zip + 7z，verify-exe 14/14）：
   GitHub Releases 已带 `Tracery-1.3.0-win32-x64.7z`（71MB，API 上传，见 `npm run upload:github`）；
   Gitee 发行版仍需在网页传同一个 7z（单附件上限 100MB，**别传 zip**）。v1.2.1 的说明保留在这里：`package.json` → 1.2.1，发布说明 `docs/RELEASE-1.2.1.md`，
   `npm run dist:dir:nosign` + `npm run release` 出包，打包版 `verify-exe` **14/14**；
   还剩「zip 上传到 Gitee Releases」这一步（需要在网页上手动传，见 §2 末尾）。
   **踩坑**：打包时若 `dist/win-unpacked` 里还有旧包在跑，electron-builder 会报
   `remove ...d3dcompiler_47.dll: Access is denied`——先关掉应用；急的话用
   `npx electron-builder --dir --config.win.signAndEditExecutable=false --config.directories.output=dist-x`
   出到另一个目录，验证/压包完再删。
3. ~~cm 表格单元格编辑~~ ✅ **已完成（7.13）**：网格渲染 + Tab 跳格 + 回车加行，`features` 的表格门控已拆。
4. ~~同步 v3：端到端加密~~ ✅ **已完成（2026-10-19）**：见 `docs/SYNC.md` 第 10 节与 `test:sync-enc`（20/20）。
   服务端接口**一行没改**（本来就只认 blob+sha）；合并也没有失效——引擎跑在设备端，
   取到 base/remote 的密文后先解密再 diff3，合并结果再加密上传。
5. ~~绘图二次编辑~~ ✅ **已完成（2026-10-19）**：右键图片 →「编辑绘图」，保存覆盖原 PNG/JSON（#48）。
6. **PWA + 响应式**（ROADMAP P0 最后一项）：manifest + service worker + 移动三栏。
7. **大仓库性能**：文件树虚拟滚动 + 增量索引落盘。
8. **mDNS 精细发现**（替代当前 UDP 广播启发式）。

## 8. 协作方式约定

- 回复用中文；用户习惯**截图 + 一句话需求**驱动迭代，先定位根因再动手，别猜。
- 测试必须真实驱动（puppeteer-core + 无头 Edge），截图落 `test/screenshots/`，改完跑相关套件再打包。
- 所有 UI 文案保持中文，代码注释中文；新文件头写清「为什么这样做」。
- 提交信息用中文，颗粒度按功能（未接入远端仓库则本地 commit 即可）。
- 项目记忆在 `E:\08_project\ev_\.workbuddy\memory/2026-10-17.md`（当天日志）+ `MEMORY.md`，新对话可读。

## 9. 快速自检清单（接手后 5 分钟）

```bash
npm start                 # 起服务，浏览器开 http://localhost:9520（默认内核已是 cm）
npm run test:engine       # 应 12/12（CM6 内核「真实 app」冒烟）
npm run test:e2e          # 应 15/15
npm run test:cmlab        # 应 8/8 + IME（纯引擎探针页）
npm run test:lan          # 应 10/10（验证局域网直连没坏）
npm run test:sync         # 应 27/27

# 双口径抽查：同一个套件在 cm 下也应全绿（默认 block 是回归网）
node test/polish-test.mjs            # 单内核（CM6）
```

如果全绿，说明环境和代码状态与本文档一致，可以按 §7 挑一项开工（内核现状看 §4b）。
