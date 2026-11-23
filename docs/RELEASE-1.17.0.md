# Tracery v1.17.0

本次更新强化同步安全与大文件处理、统一前后端 Markdown 解析逻辑，并对工作区界面增加简洁科技感视觉与微动效优化。

- 同步客户端与同步服务端安全加固：`server/sync.js` 补齐推送/拉取路径越界校验并改用流式 SHA-256；`sync-server` 修复邀请页 HTML 转义并补齐安全响应头/CSP、增加请求体大小限制、改用流式哈希与原子化配置写入。
- 统一围栏、双链、标签与标题解析：整合 `reference-path.js`、`vault.js`、`sidebar.js` 与 `markdown.js` 间的重复扫描逻辑，清理 `markdown.js` 中废弃的 `contenteditable` 死代码并补全对应测试。
- 页面视觉与动效升级：新增 `tech-polish.css` 增强层，基于主题强调色自动适配 5 款皮肤与明暗模式；增加顶部镜面微高光、激活标签与导航光条、欢迎页精密微点阵与轻量有限动效，并完整支持 `prefers-reduced-motion`。

下载 `Tracery-1.17.0-win32-x64.zip`，解压完整文件夹并运行其中的 `Tracery.exe`，保留随包 DLL、`resources` 和许可文件。Windows x64 包自带运行时，无需安装 Node 或 Electron。`SHA256SUMS.txt` 可用于校验下载文件。

关闭旧程序后再运行新包。笔记与附件继续保存在原仓库，本机草稿、分组和工作区仍属于当前设备；手机访问仍需同网且电脑保持运行。
