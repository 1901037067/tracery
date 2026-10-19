# 新对话开场白（复制粘贴给下一个 AI）

> 用法：新建一个对话，把下面 **代码块里的整段** 发给 AI（可以只改最后一行需求）。
> 前提：AI 能读到本机仓库（路径见下）或能访问 GitHub / Gitee 仓库。

```text
我在继续开发一个桌面笔记应用 Tracery：Electron + Node 服务端，仓库型 Markdown 笔记
（一个文件夹就是仓库，.md 就是笔记，兼容 Obsidian），MIT 开源。

- 本机项目路径：E:\08_project\ev_\evnote
- Gitee：https://gitee.com/hey9826/tracery
- GitHub 镜像：https://github.com/1901037067/tracery
- 当前版本：v1.3.0（已发版；tag 已推，GitHub Releases 有包）

【开始前请先读这三份文档，不要凭猜测改代码】
1. docs/HANDOFF.md —— 交接文档，最重要。§1 现状、§2 命令、§3 架构、§4 功能清单、
   §4b 编辑器内核、§5 关键决策（60+ 条，含"为什么不能用另一种做法"）、§6 已知坑、§7 下一步优先级
2. docs/EDITOR-MIGRATION.md —— 编辑内核从块级迁到 CodeMirror 6 的全过程与 7.x 逐条结论
3. docs/SYNC.md —— 同步设计（v2 合并/分块，v3 端到端加密在第 10 节）

【这个项目的硬性约定，请遵守】
- 编辑器内核只有一套：**CodeMirror 6**（v1.4.0 起下线的旧块级 contenteditable 内核已删除，
  不要再把它加回来，也不要在设置里加「切换内核」）。改完直接跑：
    node test/<套件>-test.mjs
- 测试即契约：新功能必须补断言；旧断言如果因为设计变更不再成立，要**按新设计改写**并说明理由，
  同时在 docs/HANDOFF.md §5 追加一条决策（编号接着往下排）。
- 注释用中文，写"为什么这么做"，不要写"这里做了什么"。
- 绝不碰用户真实数据：测试一律用临时目录，靠 TRACERY_HOME 与 PORT 隔离；
  跑打包版验证时要 `env -u ELECTRON_RUN_AS_NODE`（本机 shell 默认带这个变量，会把 Electron 当 Node 跑）。
- 发布链路：npm run dist:dir:nosign → npm run release（产出 zip + 7z；Gitee 单附件上限 100MB）
  → node test/verify-exe.mjs 验证 14 项 → 提 tag 并推到 Gitee/GitHub 两个远端。
- 别删 .workbuddy/（项目记忆）与 docs/ 下的任何文档。

【本次需求】
<在这里写你要做什么>
```

---

## 一句话版本（赶时间时用）

```text
继续开发 Tracery（E:\08_project\ev_\evnote，Electron + Node 的 Markdown 笔记应用，
编辑器内核是 CodeMirror 6）。先读 docs/HANDOFF.md（尤其 §1/§2/§5/§6），
再跑一遍相关测试确认基线。本次需求：<需求>
```

## 为什么这样写

- **先读 HANDOFF**：里面有 60 多条带理由的决策，AI 不知道"为什么不能用某种做法"就会重复踩坑
  （例如：图片 hover 用 outline 而不是 border、表格列宽不能压缩、同步的 IV 必须确定性）。
- **写清单内核**：编辑器只有 CM6 一套；历史文档里出现的 block/cm 双口径是 v1.3.0 之前的事。
- **写清测试即契约**：避免 AI 为了让测试通过而删断言。
- **写清隔离**：避免测试写进真实笔记仓库。
