# REA 逆向方法

> [!info] REA 是什么
> REA（Reverse Engineer Anything）是一个给 AI Agent 用的逆向分析 MCP 工具。
> 它的理念是：**看到喜欢的功能，不用源码，也能理解它怎么工作，并复刻到自己的项目里。**

## 本次分析对象

本机安装的 Obsidian：

```
E:\02_software\02_tool\16_Obsidian\
├── Obsidian.exe              # Electron 运行时（225MB）
└── resources\
    ├── app.asar              # 480KB —— 主进程引导壳
    └── obsidian.asar         # 25MB —— 应用本体（主进程 + 渲染进程打包）
```

这是标准的 Electron 分发结构：`app.asar` 是 Electron 官方模板的主进程入口，
真正的业务代码全在 `obsidian.asar` 里。

## 分析方法

用 REA 的 `analyze-javascript-application` 命令做静态分析：

```bash
rea analyze-javascript-application obsidian.asar --format json
```

它会：

1. 解开 ASAR 归档，列出全部模块
2. 做静态 import/require 分析，重建模块依赖图
3. 识别 **Electron 边界**：哪些模块跑在主进程（Node API）、哪些跑在渲染进程（DOM API）
4. 给出每个结论的**证据**（文件路径 + 行号），而不是猜测

## 逆向结论如何指导复刻

关键发现（详见 `docs/OBSIDIAN_ANALYSIS.md`）：

- 主进程职责 = vault 文件访问 + 索引 + 监听 → Tracery 的 `server/server.js`
- 渲染进程职责 = 编辑器 + 图谱 + 面板 UI → Tracery 的 `public/`
- 链接解析规则（路径优先、文件名唯一匹配）→ Tracery 服务端 `Vault.resolve()`
- `.obsidian/` 配置目录约定 → Tracery 的 `.tracery/`

## 学到的

**Electron 应用 = 主进程（Node 能力）+ 渲染进程（Web UI）**。
复刻它不一定需要 Electron——只要把主进程的职责拆到一个本地服务上，
浏览器客户端一样能拿到完整体验，还顺带获得跨平台。

#REA #逆向 #方法论 #项目
