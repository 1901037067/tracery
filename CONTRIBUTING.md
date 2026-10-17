# 贡献指南

感谢你有兴趣参与 EVNote！这是一个学习向的开源项目，欢迎任何规模的贡献：报告 bug、改进文档、修一行注释、加一个功能。

## 开发环境

```bash
git clone <your-fork>
cd evnote
npm install
npm start              # 浏览器模式：http://localhost:9520
npm run start:electron # 桌面模式（与打包版一致）
npm run test:e2e       # 端到端测试（需要 Edge 浏览器）
```

国内网络建议设置镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 代码结构

| 路径 | 职责 |
|---|---|
| `server/server.js` | 服务端：vault 读写、链接/标签索引、fs.watch、HTTP/WS API |
| `public/js/markdown.js` | Markdown ↔ DOM 双向引擎（渲染 + 序列化 + 光标偏移映射） |
| `public/js/editor.js` | 实时预览编辑器（输入防抖、光标恢复、快捷键） |
| `public/js/app.js` | 主控制器：文件树、面板、搜索、命令面板、快捷键 |
| `public/js/graph.js` | Canvas 力导向图谱 |
| `electron/main.cjs` | 桌面壳：起服务端子进程 + 开窗口 |

架构原则（对应 Obsidian）：**服务端独占文件系统与索引，前端只通过 API/WS 交互**。
新增功能时请保持这条边界，不要把文件系统操作塞进前端。

## 提交前

1. `npm run test:e2e` 必须全绿（这是本项目唯一的回归防线，改动编辑器/解析器时尤其重要）
2. 修改 `public/js/*.js` 后确认浏览器控制台无报错
3. 演示仓库 `demo-vault/` 里放了功能展示笔记，加功能时顺手更新它

## 提交信息

用朴素的中文或英文都行，说清「改了什么、为什么」。例如：

```
修复：标签内输入文字后序列化丢失（dataset 用了渲染时的旧值）

标签 span 序列化读的是 dataset.tag，用户编辑过的文本会被丢弃。
改为读 textContent。
```

## 常见坑（血泪教训，帮你省时间）

1. **CSS `[hidden]` 会被类规则覆盖**：给元素加 `display:flex` 之类的规则后，`hidden` 属性就失效了
   （作者样式 > UA 样式）。本项目全局加了 `[hidden] { display: none !important }`，不要删。
2. **contenteditable 的光标偏移是 DOM 文本空间，不是 Markdown 源码空间**：两者差着语法字符量，
   直接互相使用会让 Enter/Tab/加粗全部插错位置。用 `markdown.js` 里的
   `domPointToMd` / `mdOffsetToDom` 做映射（依赖渲染时打的 `data-md-content-start` 标记）。
3. **嵌入内容渲染要传 `tagOffsets: false`**：嵌入块的偏移标记属于另一份 md，混进主文档会污染光标映射。
4. **无头浏览器测试不要用 `keyboard.type`**：它的 insertText 路径会触发 `compositionstart`，
   把编辑器的 composing 标志卡住。用 `test/e2e.mjs` 里的 `typeText`（逐键 press）。
5. **调试时注意自动保存**：调试编辑器 bug 时，错误的编辑结果会被自动保存写进演示仓库，
   建议先在临时仓库里试。

## 路线图

功能规划与优先级见 [docs/ROADMAP.md](docs/ROADMAP.md)。想做大功能（比如 P0 的自托管同步），
请先开 Issue 讨论设计，避免白做。
