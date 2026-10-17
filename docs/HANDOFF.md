# Tracery 交接文档（Handoff）

> 用途：开新对话时，把这份文档贴/引用给 AI，配合 `README.md`、`docs/SYNC.md`、`docs/ROADMAP.md` 即可无缝继续。
> 最后更新：2026-10-17 19:30（对应代码状态：Tracery 重命名 + 侧栏折叠修复 + 附件管理 + 粘贴/拖拽入库 + Tab 栏搬入标题栏 + 笔记头行删除 + Markdown round-trip 属性测试）

---

## 1. 一句话现状

Tracery 是一个 **仓库型 Markdown 笔记软件**（Obsidian 兼容的学习复刻版）：Node 服务端负责文件/索引，前端是纯 ES Module + CSS 变量主题，Electron 壳可选。**核心差异化已落地：自托管同步 v2（自动合并 + 分块续传）+ 局域网六位通行码直连**，另有内置绘图、图片灯箱、图谱全屏、多标签页（Tab 栏即标题栏）、可拖拽栏宽、附件管理（可配置落点 + 粘贴/拖拽入库）。测试 159/159，打包版可发布。

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
npm run test:draw            # 12  绘图
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
  draw.js       内置绘图（快照历史、笔/荧光/橡皮、导出 PNG）
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
- 内置绘图：`Ctrl+Shift+D` 或左下角笔图标；保存 PNG 到附件目录并插入光标处
- 多标签页：树点击开新标签、`Ctrl+W`/`Ctrl+Tab`、持久化、外删自清理
- **Tab 栏即标题栏**：标签条在窗口最顶部，与最小化/最大化/关闭按钮同一行
  （VS Code / Obsidian「Tab 标题栏」模式），编辑区直接从笔记头开始
- 可拖拽栏宽：侧栏/右栏拖拽 + 双击复位 + 记忆（折叠已兼容内联栏宽，见 §5-9）
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
2. **绘图二次编辑**：笔画 JSON 已存 `附件/*.draw.json`，做「右键图片 → 编辑绘图」回填 draw.js 即可；跨设备时 JSON 也参与同步。
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
