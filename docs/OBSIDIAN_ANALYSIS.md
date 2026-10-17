# Obsidian 逆向分析报告（REA 式）

> 方法：REA（Reverse Engineer Anything）`analyze-javascript-application` —— 不解包执行、不读源码，从 **ASAR 归档清单、静态模块图、Electron 边界推断、字符串证据** 四个维度取证，指导复刻。
> 分析对象：本机已安装副本 `E:\02_software\02_tool\16_Obsidian\`（v1.x，2025-08 安装）
> 原始证据：`test/rea-obsidian-raw.json`（231MB 部分结果）、`test/rea-app-asar.json`（12.5MB）、`test/rea-evidence.json`（提取摘要）

---

## 1. 技术栈判定（安装目录 + ASAR 清单证据）

| 证据 | 推断 |
|---|---|
| `Obsidian.exe` 225MB + `resources/app.asar` + `resources/obsidian.asar` | 标准 **Electron** 分发结构（Chromium 渲染 + Node 主进程） |
| `app.asar` 内 `package.json` main = `main.js`（13KB） | 主进程入口壳，仅含引导逻辑 |
| `obsidian.asar` 内 `main.js`（199KB） | **真正的主进程业务代码**（vault 管理、窗口、更新等） |
| `obsidian.asar` 内 `app.js`（3.8MB，webpack 196 个模块） | **渲染进程主 bundle**——整个编辑器 UI 都在这里 |
| `lib/codemirror/*`（7 个文件，1.3MB） | 编辑器引擎 = **CodeMirror 5**（含 markdown mode、vim 键位、foldcode 折叠） |
| `lib/prism.min.js` | 代码块语法高亮 = **Prism** |
| `lib/pixi.min.js` | 图谱渲染 = **PixiJS**（WebGL 2D） |
| `lib/mathjax/tex-chtml-full.js`（1.3MB） | LaTeX 公式 = **MathJax** |
| `lib/mermaid.min.js`（2.9MB） | Mermaid 图表 |
| `lib/pdfjs/*`（3 个文件 + wasm） | PDF 预览 = **PDF.js** |
| `lib/readability.js` + `lib/defuddle.full.js` + `lib/turndown.js` | 网页剪藏：readability 提取正文 → turndown 转 Markdown |
| `lib/scrypt.js` | 加密（同步/加密笔记相关） |
| `lib/moment.min.js` / `lib/i18next.min.js` / `lib/reveal/reveal.js` | 日期 / 国际化 / 幻灯片 |
| `node_modules/get-fonts` + `node_modules/btime`（原生 .node） | 主进程原生依赖：字体枚举、启动计时 |

## 2. Electron 进程边界（静态推断，置信度 high）

REA 从 ASAR 中识别出的角色节点：

| 角色 | 目标 | 证据 |
|---|---|---|
| **electron-main** | `main.js`（package entrypoint） | `package.json` main 字段 |
| **electron-renderer** | `index.html` / `help.html` | html-script-entrypoint 机制 |
| **electron-preload** | 模块 `metadata` | `webPreferences.preload` 属性引用 |

通信机制证据（`app.asar` 分析，`@electron/remote` 模块）：

- IPC 通道：`REMOTE_RENDERER_CALLBACK`、`REMOTE_BROWSER_GET_CURRENT_WINDOW`、`REMOTE_BROWSER_DEREFERENCE`、`REMOTE_BROWSER_WRONG_CONTEXT_ERROR`、动态通道 `command`（send-sync）
- 主进程 require 的 Node 内置模块：**fs / path / zlib / child_process / util / events**
- 渲染进程侧 `ipcRenderer` 出现 88 次，`preload` 相关 32 次

**结论：主进程（`obsidian.asar/main.js`）独占文件系统与窗口管理；渲染进程（`app.js` + `index.html`）负责全部 UI；两者经 IPC 通信。**

## 3. 核心机制字符串证据（obsidian.asar 全文计数）

| 字符串 | 次数 | 说明 |
|---|---|---|
| `CodeMirror` | 584 | 编辑器引擎确认为 CodeMirror |
| `mermaid` | 309 | 图表渲染 |
| `ipcRenderer` | 88 | 渲染进程 IPC 调用 |
| `readability` | 60 | 网页剪藏提取 |
| `scrypt` | 34 | 加密相关 |
| `pixi` | 31 | 图谱 WebGL 渲染 |
| `preload` | 32 | 预加载脚本机制 |
| `metadataCache` / `MetadataCache` | 154 / 6 | **索引服务命名确认为 metadataCache** |
| `turndown` | 32 | HTML→Markdown |
| `prism` | 29 | 代码高亮 |
| `indexedDB` | 7 | 索引/缓存持久化 |

## 4. 存储键证据（localStorage / IndexedDB）

REA 从静态分析中提取到的存储键：

```
localStorage:  "vim" | "most-recently-installed-version" | "spellcheck-languages"
               | "site-theme" | "communityPluginSortOrder"
IndexedDB:     indexedDB.open(...)
```

- `vim` → 存在 Vim 键位模式（与 `lib/codemirror/vim.js` 互相印证）
- `communityPluginSortOrder` → **社区插件排序状态存在 localStorage**
- 配置目录 `.obsidian/`（文件系统约定，Obsidian 公开文档亦确认）

## 5. Worker 证据

```
worker.js（239KB，asar 内独立文件）
sim.js（176KB）
new Worker(URL.createObjectURL(new Blob([...])))  → 动态 Blob Worker
new Worker(t, {type:"module"})                    → ESM Worker
```

→ 主进程/渲染进程均有后台 Worker（搜索索引、大型计算卸载）。

## 6. 架构推断（指导复刻的结论）

```
┌──────────────────────── 主进程 obsidian.asar/main.js (199KB) ─────────────────────┐
│  vault 文件读写(fs/path) · 窗口管理(BrowserWindow) · 索引 metadataCache · 更新检查   │
└──────────────┬────────────────────────────────────────────────┬───────────────────┘
               │ IPC（@electron/remote / ipcMain）               │ preload: metadata
┌──────────────▼────────────────────────────────────────────────▼───────────────────┐
│ 渲染进程 app.js (webpack, 3.8MB) + index.html                                     │
│  CodeMirror 编辑器 · PixiJS 图谱 · Prism 高亮 · MathJax/Mermaid/pdfjs · 剪藏管道    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

| 复刻决策 | 依据 |
|---|---|
| 用「本地服务端 = 主进程」分工，而不是再糊一个 Electron | 主进程职责=文件系统+索引+监听，用 Node HTTP 服务即可等价承载；浏览器作渲染进程 |
| 链接解析：路径优先 → 全局文件名唯一匹配 | Obsidian 官方行为 + metadataCache 命名佐证其「按名索引」 |
| 配置目录 `.tracery/`（仿 `.obsidian/`） | 文件系统约定 |
| 编辑器自研（contenteditable）而非接 CodeMirror | CM5 是渲染进程内的实现细节，属可替换层；复刻目标是行为而非实现 |
| 图谱用力导向 Canvas 布局 | PixiJS 只是渲染器，布局算法才是可复刻的知识 |

## 7. 分析局限（诚实记录）

1. **obsidian.asar 分析超时**（600s）：MathJax/pdfjs 等巨型库的语义图超出预算，REA 返回了部分证据（231MB）后中止；结论均来自已完成的静态观测。
2. **静态推断 ≠ 运行时行为**：REA 明确标注"JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed"——上述 IPC 通道、存储键等为静态恢复，未经运行时验证。
3. webpack 模块仅恢复到 AST 字面量层（196 个 app.js 模块的 id/导出名），未执行 push handler。
4. 网络端点提取噪声较大（压缩代码误报），已剔除；未发现稳定的可疑外联端点（仅 `/i18n/mapping.txt` 一类资源请求）。
5. 分析仅针对本机副本，用于技术学习。

## 8. 对 Tracery 的指导结果

复刻分工（详见项目 README「架构说明」）：

| Obsidian | Tracery |
|---|---|
| 主进程 main.js（fs/path/zlib） | `server/server.js`（Vault 类：读写/索引/监听） |
| IPC | HTTP API + WebSocket |
| 渲染进程 app.js | `public/`（原生 ES Modules） |
| metadataCache | 服务端内存索引（links/tags/headings 三张表） |
| CodeMirror Live Preview | contenteditable + 自研 Markdown 双向引擎 |
| PixiJS 图谱 | Canvas 手写力导向布局 |
| `.obsidian/` | `.tracery/` + `tracery.config.json` |
