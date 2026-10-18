# 编辑区内核迁移交接：块级实时预览 → 行级（Obsidian 同款）

> 写于 2026-10-18，v1.1.0 之后。目标读者：下一个会话的 AI / 未来的我。
> 现状代码：`public/js/editor.js`（1184 行）、`public/js/markdown.js`（973 行）。
> 这份文档只讲**编辑区内核**，绘图 / 同步 / 附件 / 搜索 / 回收站不受影响，不要动。

---

## 0. 一句话结论

现在的编辑区是「**Markdown 文本是唯一真源 + DOM 是渲染产物 + 每次输入整篇重建**」的块级模型；
Obsidian 是「**每一行就是一个真实 DOM 行**」的 CodeMirror 6 行级模型。
用户明确要求**往 Obsidian 靠**，所以要做的是**换内核**，不是继续修 块级模型的边角。
推荐路线：**引入 CodeMirror 6 + Decoration 装饰**（Obsidian 同源方案），保留 `markdown.js` 的解析/序列化能力作为装饰与导出的基础。

---

## 1. 当前实现（先理解再改）

### 1.1 数据流

```
按键 → contenteditable 的 DOM 变化
     → _onInput()：serializeHtml(整个编辑区) → this.md（权威文本，立刻更新）
     → 防抖 220ms → _renderLive()：清空 #editor-live，用 this.md 整篇重渲染
     → 光标：重建前存 md 字符偏移，重建后 mdOffsetToDom() 放回
```

三件事都发生在 `public/js/editor.js`：`_onInput` / `_renderLive` / `_saveCaret` + `_restoreCaretMd`。

### 1.2 三条不变量（今天所有 bug 都源于此）

| 不变量 | 实现位置 | 破了会怎样 |
|---|---|---|
| 块 ↔ 源码行可逆 | `markdown.js` 的 `tagLeaf()`：每块打 `data-md-line-start` / `data-md-line-end`（**块的最后一行**）/ `data-md-content-start` | 光标跑偏、行号错位 |
| 序列化能原样还原 | `markdown.js` 的 `serializeBlocks()`：块间补几个换行 = `本块 lineStart − 上块 lineEnd`（gap=1 → `\n`，gap=2 → `\n\n`） | **凭空多出/吃掉空行** |
| 光标只有一套坐标系 | `domPointToMd()` / `mdOffsetToDom()`，全部用 md 字符偏移 | 打字打错地方、行号跳 |

### 1.3 现状里的「补丁」，都是块级模型的代价

- **空行占位段**：源码每一行空行渲染一个 `<p class="md-blank">`（恒一行高、可点、可打字）。行级模型下这是天然的行，不需要占位段。
- **空行上打字落点**：靠 `beforeinput`/mousedown 显式放光标，再靠 gap 拼接保证「字留在原行」。
- **行号**：`_collectLineNumbers()` 用 `data-md-line-start` + `<br>` 切分**测量**出来，再用覆盖层 `.live-gutter` 画（滚动只位移）。代码块围栏行不编号、文末幽灵行不编号，都是手工兜的。
- **撤销**：`history = [{md, caret}]` 快照栈 + 520ms 合并（因为浏览器原生 undo 在整篇重建下失效）。
- **源码模式**：另一个 `textarea#editor-source` + `.source-gutter` 行号槽，和实时预览是两套 DOM。

### 1.4 块级模型的硬边界（正是用户不满意的地方）

1. 每次输入都整篇重建 → 长文档（>2000 行）有可感延迟，输入法组词期间不能序列化。
2. 光标是「第几个字符」，不是「第几行第几列」→ 上下移动/Home/End/跨行选择全靠浏览器默认行为在块内兜，块间行为不稳。
3. 块内编辑：列表项、表格单元格、Callout 内文都是「富文本块」，没有「行」的概念，语法标记（`**`、`#`）无法按行显隐。
4. 原生撤销不可用，需要自己维护快照栈。

---

## 2. 「像 Obsidian」到底指什么（验收标准）

下个会话先按这张表验收，别凭感觉：

| # | 行为 | 现在 | 目标 |
|---|---|---|---|
| 1 | 行号 | 测量式覆盖层，围栏行/幽灵行靠特判 | 真实行号，与源码逐行一致 |
| 2 | 上下箭头 / Home / End | 块内可用，块间不稳 | 严格按行移动 |
| 3 | Shift+方向键 / 三击选行 | 浏览器默认，跨块不稳 | 按行列选择 |
| 4 | 语法标记显隐 | 整篇渲染，标记全隐藏 | **光标所在行**显示 `#`/`**`/`-`，离开即隐藏 |
| 5 | 空行 | 占位段（可点、恒一行） | 就是一行（原生） |
| 6 | 回车 | 插一个换行（已对齐） | 同上 |
| 7 | Backspace 在行首 | 块内可删，跨块不合并 | 合并到上一行 |
| 8 | IME 组词 | 组词期间不序列化（可能抖） | 组词零干扰 |
| 9 | 撤销/重做 | 自建快照栈 | CM 原生历史（带选区/滚动还原） |
| 10 | 3000 行输入 | 整篇重建，有延迟 | 无可感延迟（CM 只重排视口） |
| 11 | Callout / 表格 / 任务列表 / 图片嵌入 / 双链 hover / 复选框点击 | 已支持 | **全部保留** |
| 12 | 图片拖宽手柄、灯箱、粘贴入库 | 已支持 | **全部保留** |

1–10 是内核能力，11–12 是块级渲染的产物；**换内核时最容易丢的是 11–12**。

---

## 3. 两条路线

### 路线 A（推荐）：CodeMirror 6 + Decoration

和 Obsidian 同源（Obsidian 就是 CM6 + 自己的 `@codemirror/lang-markdown` 扩展 + Live Preview 装饰层）。

- 依赖：`@codemirror/state`、`@codemirror/view`、`@codemirror/commands`、`@codemirror/lang-markdown`、`@lezer/markdown`（约 250–350 KB，可离线打进 `public/vendor/`）
- 做法：
  - `EditorState` 的 doc = 就是笔记全文（`this.md`），**不再是渲染结果**
  - 用 `ViewPlugin` + `Decoration.mark/widget/line` 做实时预览：
    - `Decoration.mark`：`**粗体**` 去掉星号只留 bold 样式（光标行除外）
    - `Decoration.replace`：隐藏 `#`、`` ` ``、`-`、`![[..]]` 语法
    - `Decoration.widget`：图片嵌入、Callout 卡片、复选框、表格（表格可用 `Decoration.replace` 整块替换成 widget）
    - `Decoration.line`：标题字号、引用底色
  - 行号：`lineNumbers()` 扩展直接开（对应设置里的「行号」开关）
  - 撤销：`history()`（含选区/滚动恢复）
  - 源码模式：同一份 doc，切换 extension 集合（raw ↔ live preview），**不需要第二个 textarea**
- 关键自定义点（Obsidian 也是自己写的）：
  - `[[双链]]` / `![[嵌入]]` / `#标签` / `==高亮==` / `> [!callout]` 不在标准 markdown 内 → 需要自定义 lezer 语法或 `ViewPlugin` 里用正则做装饰（先用正则，稳）
  - 粘贴/拖入附件：接 `domEventHandlers` 的 `paste`/`drop`
  - 自定义 keymap：Enter 续列表（`insertNewlineContinueMarkup` 已有，但任务列表 `- [ ]` 要自己补）、Tab 缩进、Ctrl+B/I/S

### 路线 B（不推荐）：自研行级 contenteditable

每行一个 `<div contenteditable="false">`（或单一 contenteditable 容器里每行一个 div），行内用 Range 操作。

- 优点：不引依赖，能复用现有 `renderMarkdown` 的块级解析结果
- 缺点：**跨行选区、拖拽选择、撤销栈、IME 组词、滚动性能全部要自己实现**——这四件正是 CM 花了十年做的。今天在块级模型里踩的坑，换个地方会重踩一遍。

> 结论：走 A。B 只在「完全不能引第三方依赖」时才考虑。

---

## 4. 迁移分阶段（建议节奏）

### P0 探针（半天，先验证再动刀）
1. `npm i @codemirror/state @codemirror/view @codemirror/commands @codemirror/lang-markdown @lezer/markdown`
2. 新建 `public/cmlab.html` + `public/js/cmlab.js`（**独立页面，不碰现有编辑区**），放一个 3000 行的 md：
   - 验证：中文输入法组词不丢字、行号、滚动 60fps、`Decoration.widget` 高度变化时滚动不抖、`history()` 撤销能恢复选区
   - 结论写回本文件第 7 节
3. 探针页走 `http://localhost:9520/cmlab.html`（`npm run dev` 后）

### P1 只读渲染（1~2 天）
把 `renderMarkdown` 的**块级解析结果**改造成装饰生成器：
- 新建 `public/js/cm/decorations.js`：输入 `EditorState.doc` + `syntaxTree`，输出 `DecorationSet`
- 先覆盖：标题、粗体/斜体/删除线/行内代码、列表、引用、代码块、表格、分割线
- 验收：同一篇 demo-vault 笔记，CM 渲染 vs 现有渲染截图对比，肉眼一致

### P2 行内编辑（1~2 天）
- 光标行显示语法标记（`Decoration.mark` 的 `inclusive` + `cursorLine` 判断）
- Enter 续列表 / 任务列表、Tab 缩进、`Ctrl+B/I/S/K`、Backspace 行首合并（CM 默认有，验证即可）

### P3 块级 widget（1~2 天，最容易丢功能的一段）
- `![[图片.png|640]]` → 图片 widget + 右下角拖宽手柄（复用 `editor.js` 里的 `_renderImageEmbed`、`setImageWidth` 逻辑）
- `![[笔记]]` → 嵌入卡片（复用 `Api.note` + `renderMarkdown`，注意 `tagOffsets:false`）
- `> [!tip]` → Callout 卡片（标题行可编辑，正文仍是 CM 行，用 `Decoration.line` 做左侧色条即可，别整块 replace，否则正文不可编辑）
- 表格 → 建议**不整块 replace**，用 `Decoration.line` + widget 补边框；整块 widget 会失去单元格编辑
- 双链/标签的 hover 预览、点击跳转（复用 `editor.js` 的 `_schedulePreview` / `_openWikilink`）
- 复选框：`Decoration.replace` + widget checkbox，pointerdown 时改 doc

### P4 接回 app.js（1 天）
- `LiveEditor` 类**保留名字和全部方法**，内部实现换成 CM（见第 5 节契约）
- `#editor-live` 只作为 CM 的挂载点（`new EditorView({ parent: liveEl })`）
- 源码模式 = 切换 extension（关掉所有装饰 + 开 `lineNumbers`），`#editor-source` / `.source-wrap` 可以删除，但要**同步改 app.js 与 test**（见 5.3）
- 设置项：行号开关直接映射 `lineNumbers` compartment；字号/宽度继续走 CSS 变量（CM 支持 `EditorView.theme`）

### P5 测试迁移与发布（1 天）
- 重写 `test/enter`、`test/gap`、`test/polish` 中依赖块级 DOM 的断言（见第 6 节）
- 全量 18 套件回归 → `npm run dist:dir` + `npm run release`
- **保留一个版本的回退开关**：`settings.editorEngine = 'block' | 'cm'`，默认 `cm`，出问题能一键切回

---

## 5. 必须保留的契约

### 5.1 构造参数（`app.js` 的 `new LiveEditor({...})`）
```
liveEl, sourceEl, gutterEl, sourceWrap,
resolveLink(target), resolveFile(name),
onImageClick(src, alt), onAssetSaved(path),
confirmCreate(name), onNavigate(path, heading), onCreateNote(name),
onSave(path, content), onChange(content), onDirtyChange(bool), onModeChange(mode)
```

### 5.2 方法（`app.js` 与右键菜单在用，一个都不能少）
```
load(path, content, {keepMode})   getContent()      flush()
setMode('live'|'source')          toggleMode()      focus()
insertSnippet(text)               insertText(text)  wrapSelection(open, close)
setLinePrefix(prefix)             selectAll()       removeImageAt(imgEl)
setImageWidth(fig, width)         scrollToHeading(t) setAutosave(ms)  setLineNumbers(bool)
undo()  redo()  canUndo()  canRedo()   dirty(属性)
```

### 5.3 DOM 契约（换内核后**必须同步修改**）
- `app.js`：`$('editor-live').addEventListener('keydown'/'contextmenu'/'mousedown'/'scroll')`、`document.querySelector('#editor-live p')`、`.embed-image`、`[data-path]`
- `markdown.js`：`renderMarkdown` 仍被导出 HTML、链接预览、嵌入内容复用 → **不要删**
- 测试：`test/gap`（`.md-blank`）、`test/enter`（`#editor-live p` / `li`）、`test/polish`（`.live-gutter .ln`、`#draw-canvas` 无关）、`test/menu`（`#editor-live p:not(.md-blank)` 右键）
- 结论：**换内核 = 这些测试里的选择器全要改**，改之前先跑一遍 `npm run test:e2e` 确认基线

---

## 6. 今天踩过的坑，在新架构下怎么处置

| 坑 | 块级模型下的原因 | 行级模型下 |
|---|---|---|
| 空行上打字凭空多两行 | 序列化按「块」拼接，不知道两块在源码里挨着 | **消失**：行就是行 |
| 光标在空行上跑偏 | 光标是字符偏移，空块没有「第几行」 | **消失**：行列坐标 |
| 连续空行合成一个占位段 → 分不清第几个空行 | 渲染层合并 | **消失** |
| 输入法组词被重建打断 | 220ms 整篇重画 | **消失**（CM 增量更新） |
| 原生 undo 不可用 | DOM 重建销毁栈 | **消失**（CM history） |
| 行号错位（折行重复编号） | 测量式行号 | **消失**（行号来自 doc 行） |
| 新坑 1 | — | widget 高度变化导致滚动跳动（要用 `Decoration` 的 `block: true` + `estimatedHeight` 或测量缓存） |
| 新坑 2 | — | `[[双链]]`/`![[..]]`/`==高亮==` 不在标准 markdown 语法树里，lezer 需要自定义或走正则装饰 |
| 新坑 3 | — | 粘贴/拖入附件的默认行为会插入图片 data URL（现在 `editor.js` 里拦掉了，CM 要在 `domEventHandlers` 里同样拦） |
| 新坑 4 | — | 表格/Callout 若整块 `replace` 成 widget，块内文字**不可编辑**；要么用行装饰，要么 widget 里再嵌一个小 CM（Obsidian 的做法） |

---

## 7. 测试与命令

```bash
npm run dev                 # 启动服务（默认 9520）
npm run test:e2e            # 功能回归
npm run test:roundtrip      # Markdown 往返（换内核后要改成「text ↔ 装饰」等价性）
npm run test:enter          # 回车行为（换内核后重写）
npm run test:gap            # 空行/落点（换内核后大部分断言作废）
npm run test:polish         # 撤销/行号/菜单
npm run test:menu  test:draw  test:tabs  test:layout  test:asset  test:trash  test:merge
npm run dist:dir && npm run release   # 打包（release 会 repack asar + 压 zip）
```

当前基线（v1.1.0）：**18 个套件、249 项全绿**。换内核期间保持「每个 P 阶段结束跑一遍全量」，别攒到最后。

---

## 8. 下个会话从这里开始

1. 读这份文档 + `docs/HANDOFF.md` 的 #14 / #21 / #26 / #34 / #36（空行/光标/行号的既有结论，**换内核后它们会作废，但要知道为什么**）
2. 跑一次 `npm run test:e2e` + `test:gap` 确认基线是绿的
3. 做 **P0 探针**：`public/cmlab.html`，验证 IME / 行号 / 3000 行性能 / widget 高度变化
4. 探针结论写回本文件第 7 节，再决定是否全量迁移

### 给用户的开场提示词（可直接粘贴）

```
读 docs/EDITOR-MIGRATION.md（编辑区内核迁移交接），按里面的 P0 阶段开始：
先安装 CodeMirror 6 依赖，做一个独立的 public/cmlab.html 探针页，
验证中文输入法、行号、3000 行滚动、Decoration.widget 高度变化的滚动稳定性，
把结论写回文档第 7 节，不要动现有的 public/js/editor.js。
```
