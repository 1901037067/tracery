# 开发与质量检查

开发和 CI 使用 Node.js 22.13 或更新的 22.x 版本；安装依赖使用 `npm ci`，工具版本由锁文件固定。

提交前运行：

```sh
npm run check
npm run test:ci
```

`check` 依次检查自有 JavaScript 语法、渐进类型和 lint。`test:ci` 在临时副本中运行安全与编辑回归，包含真正执行的 CSP 攻击样例及故意错误的静态检查样例；原始笔记不会被用作测试仓库。浏览器路径可通过 `TRACERY_BROWSER` 指定。

## 检查范围

- 语法：`server`、`sync-server`、`electron`、`public/js`、`scripts`、`test`，递归检查，跳过供应商资源。
- `no-undef`、`no-unused-vars`：`server`、`electron`、`public/js`、`scripts`。服务端与前端使用各自的运行环境全局变量；未使用形参和异常参数不强制报错。
- `checkJs` 与 `no-floating-promises`：路径、请求来源、用户文件边界、历史、笔记存储、CSP、目录监听、子进程启动、双链路径、快捷键、重连按钮，以及 CodeMirror 补全入口。实际清单在 `tsconfig.json`、`tsconfig.cm.json` 和 `eslint.config.mjs`。

这是分阶段检查，不是全项目严格类型检查。CodeMirror 补全文件通过 `@ts-check` 显式加入，其他编辑器依赖仍保持原有 JavaScript；新增模块或修改相关异步流程时应逐步扩大清单，不能为通过检查随意加 `@ts-nocheck` 或关闭规则。

## CI

GitHub Actions 在推送 main/master、PR 和手动触发时运行两项检查：

- `Static checks and browser regressions`：Ubuntu、Node 22、静态检查及安全/编辑回归。
- `Windows startup and save lifecycle`：Windows 原生单实例、启动错误、PDF、保存退出及端到端流程。

工作流使用只读仓库权限、完整提交 SHA 固定官方 Actions，不持久化 Git 凭据。检查失败会让工作流失败，报告和日志保留 7 天；不构建、不上传安装包、不发布 Release。合并前是否强制通过检查由仓库分支保护决定，本次未更改强制 PR 或管理员绕过策略。

完整本机回归仍可运行 `npm run test:all`。长文性能探针有独立的 16ms 目标，受机器和浏览器调度影响，不纳入跨机器 CI 门禁；性能目标未达标必须如实记录，不能把功能回归通过写成性能已达标。

## CSP 边界

应用页面只加载同源脚本，importmap 按实际 HTML 的内容哈希允许；内联事件、普通内联脚本和 eval 均被阻止。同源 WebSocket 使用当前页面的实际主机和端口。样式保留内联支持，以兼容编辑器、绘图和现有自定义外观；笔记中的外链图片仍可加载。

仓库 JS、HTML 等活动附件按下载返回，并使用 `nosniff`，不能当作同源应用脚本。SVG 保留图片能力但禁止脚本执行。CSP 是额外防线，不能代替文本转义、路径检查或手机会话授权；手机 HTTP 仍仅适用于可信局域网。

规则依据：[W3C CSP](https://www.w3.org/TR/CSP/)、[TypeScript checkJs](https://www.typescriptlang.org/tsconfig/checkJs.html)、[未处理 Promise 检查](https://typescript-eslint.io/rules/no-floating-promises/)、[GitHub Actions 安全建议](https://docs.github.com/en/actions/reference/security/secure-use)。
