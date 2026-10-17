# EVNote 复刻计划

> [!note] 项目背景
> 本项目是一次 **REA（Reverse Engineer Anything）式逆向学习实践**：
> 先用 [[REA 逆向方法]] 分析本机安装的 Obsidian（Electron 应用，无源码），
> 再按分析出的架构用 Web 技术栈复刻。分析报告见 `docs/OBSIDIAN_ANALYSIS.md`。

## 架构对照

| 环节 | Obsidian（逆向结论） | EVNote（复刻） |
|---|---|---|
| 运行时 | Electron（主进程 + 渲染进程） | Node 服务端 + 浏览器客户端 |
| 文件访问 | 主进程通过 vault adapter 读写 | `server/server.js` 独占文件系统 |
| 索引 | 主进程 metadataCache | 服务端内存索引（链接/标签/标题） |
| 文件监听 | 主进程监听 vault 变化 | `fs.watch` 递归监听 + WebSocket 推送 |
| 编辑器 | CodeMirror（Live Preview） | contenteditable + 自研 Markdown 引擎 |
| 配置 | `.obsidian/` 目录 | `.evnote/` 目录 + `evnote.config.json` |

## 已实现

- [x] 仓库管理（打开/切换/最近列表）
- [x] 文件树（新建/重命名/删除，重命名自动更新双链）
- [x] 实时预览编辑器（标题/列表/任务/引用/Callout/代码块/表格/高亮）
- [x] 双链解析（路径优先 → 文件名唯一匹配）+ 未解析链接点击创建
- [x] 反向链接面板（带上下文）
- [x] 标签面板 + 笔记级标签
- [x] 全局搜索 + 命令面板（Ctrl+P）
- [x] 力导向图谱视图
- [x] 亮/暗主题、自动保存、外部修改实时同步

## 未实现（已知限制）

- [ ] 插件系统（Obsidian 有 2000+ 社区插件，API 完全不同）
- [ ] 云同步 / 端到端加密（Obsidian Sync 是付费服务）
- [ ] Canvas 白板、Daily Notes 模板、日记日历视图
- [ ] 附件管理面板、回收站
- [ ] 移动端 App
- [ ] 数学公式渲染（当前为等宽展示）

## 技术栈

- **服务端**：Node.js 原生 `http` + `ws`，零框架
- **前端**：原生 ES Modules，零框架
- **编辑器**：自研 Markdown 解析/序列化引擎（`public/js/markdown.js`）
- **图谱**：Canvas 手写力导向布局（`public/js/graph.js`）

#项目 #复刻 #REA #逆向
