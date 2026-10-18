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
| 1 | 行号 | 测量式覆盖层，围栏行/幽灵行靠特判 | 真实行号，与源码逐行一致（CM6 口径：行数 = 换行数 + 1，**含文末空行**；Obsidian 实测对「段落+5\n」显示 1-6，见第 3 节附考证） |
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

### 附：Obsidian 实时预览架构考证（REA 一手证据 + 网络资料，2026-10-18）

起因：用户报「同一个文件，Obsidian 行号显示 1-6，Tracery 实时预览只显示 1-5，源码模式正常」。
借这个 bug 把 Obsidian 的做法挖了一遍，方法即本项目 ANALYSIS.md 的 REA 式取证（不读源码，从安装产物反推）。

**取证路径**：Obsidian 装在本机 `E:\02_software\02_tool\16_Obsidian\`（v1.x，2025-08 装）。
`resources/app.asar`（480KB）只是 Electron 主进程引导；**真正的渲染层 bundle 是 `resources/obsidian.asar`（25.8MB）**，
asar 解包后 `app.js`（3.9MB）+ `app.css`（637KB）。以下结论均出自 bundle 内的字符串与结构证据。

**证据 1：编辑器就是 CodeMirror 6，且是早期 CM6 血缘**

- bundle 导出表含 `@codemirror/state`、`@codemirror/view`、`@codemirror/tooltip`、`@codemirror/search`、`@lezer/common/highlight/lr`；
  同时保留 CM6 **beta 期**包名（`@codemirror/text`、`rangeset`、`stream-parser`、`rectangular-selection`）——
  Live Preview 是 2020 年随 CM5→CM6 迁移上线的，内部一直沿用早期 CM6 血缘（API 与 6.x 同宗，我们装的 6.43 更新）
- DOM 即 CM6 标准件：`.cm-editor > .cm-scroller > .cm-sizer > .cm-contentContainer > .cm-content`

**证据 2：行号 = CM6 原生 `lineNumbers()`，未自研**

- bundle 导出表 `lineNumbers:()=>ul`；CSS 只覆写 `.cm-lineNumbers .cm-gutterElement` 的 padding/对齐
- **行号口径 = CM6 `doc.lines` = 换行数 + 1，文末空行也编号**。用户报的 bug 根因正在此：
  Obsidian 对「段落 + 5 个 `\n`」显示 1-6；Tracery 块级实现（`_collectLineNumbers`）却跳过了文末空行
  （上一轮误以为「Obsidian 也不给它编号」）。**已修**：editor.js 不再跳过文末空行，
  polish-test 加回归断言，用户真实文件（`15_lawrag.md`）无头验证 1-11 与 Obsidian 一致
- Obsidian 设置项 `showLineNumber` 默认 **false**（用户是手动开的）

**证据 3：实时预览装饰 = StateField 托管装饰集 + StateEffect 增删（与 P0 探针结论互证）**

- bundle 内结构：`ZL = StateField`（实时预览状态，经 `cm6.state.field(ZL)` 读取）；
  `nO = StateField` 持有 DecorationSet，`provide: EditorView.decorations.from(nO)`；
  `JL` / `eO` 两个 StateEffect 分别 add / filter 装饰（`==高亮==` 也走这对效果）
- **块级装饰必须挂 StateField**——P0 探针在 ViewPlugin 里用 `Decoration.replace({ block: true })` 直接抛错
  （「Block decorations may not be specified via plugins」），Obsidian 的 bundle 结构给出同一答案；
  网络侧 Obsidian 插件开发资料同样明确：ViewPlugin 只适合视口内可推导的装饰，会改变高度/内容的必须 StateField
- 装饰词汇（app.css 实证）：`cm-formatting` / `cm-formatting-list`（语法标记显隐）、`cm-header-*`（标题行）、
  `cm-hmd-internal-link` / `cm-hashtag` / `cm-url` / `cm-underline` / `cm-inline-code`（行内）、
  块 widget：`cm-table-widget`（**表格整块 widget**）、`cm-html-embed`、`cm-image-reveal-tooltip`
- 「光标行显示语法、离开即隐藏」= 选区变化时 filter 掉当前行的 replace 装饰（eO filter 效果），
  与本文档第 2 节验收项 4 同机制

**证据 4：模式模型**——bundle 内默认设置 `defaultViewMode:"source"` + `livePreview:true`：
Obsidian 的「source」就是实时预览编辑视图，「preview」才是阅读视图；实时预览不是独立模式，
而是同一 CM6 view 的一套 extension 开关——与本文档 P4「源码模式 = 切换 extension 集合」的设计同构。

**对我们的三条结论**

1. 路线 A（CM6 + Decoration）与 Obsidian 同源同构，P0 五个内核能力已验证，继续走
2. 行号/文末空行/围栏行这类「测量式行号」边角，在 CM6 下天然正确（行号槽与渲染解耦）；
   块级模型的修补到此为止——本轮只修用户实际报障的文末行，围栏行跳号是块级模型既定限制，留给 CM6 根治
3. P1/P3 直接借鉴 Obsidian 的架构形状：**StateField 托管装饰集 + StateEffect 增删 + 光标行 filter**；
   表格在 Obsidian 里是整块 widget（`cm-table-widget`），可作 P3 表格方案的参考对照

---

## 4. 迁移分阶段（建议节奏）

### P0 探针（半天，先验证再动刀）
1. `npm i @codemirror/state @codemirror/view @codemirror/commands @codemirror/lang-markdown @lezer/markdown`
2. 新建 `public/cmlab.html` + `public/js/cmlab.js`（**独立页面，不碰现有编辑区**），放一个 3000 行的 md：
   - 验证：中文输入法组词不丢字、行号、滚动 60fps、`Decoration.widget` 高度变化时滚动不抖、`history()` 撤销能恢复选区
   - 结论写回本文件第 7 节
3. 探针页走 `http://localhost:9520/cmlab.html`（`npm run dev` 后）

### P1 只读渲染（1~2 天）—— ✅ **已完成（2026-10-18），结论见 7.2**
把 `renderMarkdown` 的**块级解析结果**改造成装饰生成器：
- 新建 `public/js/cm/decorations.js`：输入 `EditorState.doc` + `syntaxTree`，输出 `DecorationSet`
- 先覆盖：标题、粗体/斜体/删除线/行内代码、列表、引用、代码块、表格、分割线
- 验收：同一篇 demo-vault 笔记，CM 渲染 vs 现有渲染截图对比，肉眼一致

**实际做法（与计划的三处偏差，下个阶段沿用）**：
- 先把 `markdown.js` 拆成 `parseMarkdown(md) → 块 AST`（带 lineStart/lineEnd/contentStart）
  + `renderMarkdown = render(parse)`——纯代码搬运、行为不变，用 roundtrip/gap/enter/polish 当护栏；
  装饰生成器与块级渲染**共用同一份解析**，不会出现「渲染一套、装饰另一套」
- 行内 span **没走 lezer 语法树**，用与 `inlineToHtml` 同款的正则在装饰侧独立扫描
  （装饰只要区间不要 HTML；`inlineToHtml` 的 stash 链保持不动）——文档说的「先用正则，稳」
- 「藏标记」用 `Decoration.replace({})`（无 widget = 内联空替换）；**整行收起**（围栏行、表格分隔行）
  用 `Decoration.replace({widget, block:true})` 挂 StateField（P0 结论）

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
| 新坑 5（2026-10-18 用户实测） | **视图/模型分裂**：行首 Backspace 跨块合并只发生在 DOM 层，序列化按 `data-md-line-*` 旧偏移做 gap 补换行、把被合并的结构原样重建 → md 不变 → `_onInput` 跳过重渲染 → 行号槽残留成死区、Ctrl+Z 无可撤销、源码模式内容却完好。块级模型的「序列化信任旧偏移」看不见浏览器原生块编辑，这是最危险的一类 | **消失**：doc 是唯一真源，任何删除都直接改 doc。过渡期已在 `editor.js` 做了两层止血：跨行删除（行首 Backspace / 行尾 Delete / 跨块选区）全部走模型层；外加「md 没变但 DOM 结构签名变了就强制重渲染」的安全网 |

---

## 7. 测试与命令

```bash
npm run dev                 # 启动服务（默认 9520）
npm run test:e2e            # 功能回归
npm run test:cmlab          # CM6 探针（P0：IME/行号/3000行滚动/widget高度×滚动/history）
npm run test:roundtrip      # Markdown 往返（换内核后要改成「text ↔ 装饰」等价性）
npm run test:enter          # 回车行为（换内核后重写）
npm run test:gap            # 空行/落点（换内核后大部分断言作废）
npm run test:polish         # 撤销/行号/菜单
npm run test:menu  test:draw  test:tabs  test:layout  test:asset  test:trash  test:merge
npm run dist:dir && npm run release   # 打包（release 会 repack asar + 压 zip）
```

当前基线（v1.1.0）：**18 个套件、249 项全绿**。换内核期间保持「每个 P 阶段结束跑一遍全量」，别攒到最后。

### 7.1 P0 探针结论（2026-10-18 · 已完成，5/5 通过）

探针资产（全部为新增文件，**未动 `public/js/editor.js`**）：

- `public/cmlab.html` + `public/js/cmlab.js`：独立探针页。3000 行确定性中文 md（种子固定），
  自带最小 live preview 装饰集（标题/粗体/双链/引用 + 两个 block widget：state 驱动的可折叠卡、原地增高的 grow 卡）。
- `public/vendor/cm/`：CM6 依赖树离线副本，**22 个包 / 1416 KB**。
  `scripts/build-cmvendor.mjs` 一键重建：走完整依赖树 → 平铺复制 ESM 入口 → 注入 importmap →
  校验「所有裸导入均有 vendor 副本」（漏一个即报错）。第 3 节「离线打进 `public/vendor/`」方案验证可行。
- `test/cmlab-test.mjs`（`npm run test:cmlab`）：起服务（端口 9598，不占 dev 的 9520）→
  puppeteer-core + Edge 无头开页 → 等页内 4 个自动探针 → CDP `Input.imeSetComposition`
  驱动中文组词 → 汇总 `window.__probe.results`。全绿退出码 0。
- 截图：`test/screenshots/cmlab-probe.png`。

实测结果（Edge 150 headless，视口 1280×860，编辑器高 520px）：

| # | 验证点 | 结果 |
|---|---|---|
| 1 | 中文输入法组词 | ✅ 两轮（行尾 `ni→你好→提交`、行中 `中文输入法→提交`）：插入偏移精确、不重不漏、光标紧随其后、compositionstart/end 齐全。组词期 `view.composing` 保持 true（CM 把组词文本同步进 doc 但推迟解析）——旧模型「220ms 重建打断组词」的问题消失 |
| 2 | 行号 | ✅ 顶部从 1 连续递增、一行一号、中部行号与视口首行 doc 行号一致、超长行折 3 个视觉行仍只占 1 个行号（旧 bug「折行重复编号」消失）、compartment 开关可切 |
| 3 | 3000 行滚动 | ✅ DOM 行元素 ~44 个（视口外不渲染，全文 3001 行）；150 帧匀速滚动 avg 6.3ms / p95 8.6ms / max ~36ms，掉帧 1/150；单次 dispatch（含 3000 行 fence 扫描）avg ~3ms / p95 ~4.5ms |
| 4 | widget 高度变化 × 滚动稳定性 | ✅⚠️ 两种机制结论相反，见发现 2 |
| 5 | history 撤销 | ✅ doc 双向还原；undo 恢复改动前选区，redo 选中被重做的变更区间 |

**对 P1–P4 有直接影响的五个发现：**

1. **块级 widget 装饰必须挂 StateField**（`provide: (f) => EditorView.decorations.from(f)`）。
   在 ViewPlugin 里用 `Decoration.replace({ block: true })` 直接抛
   `Block decorations may not be specified via plugins`（探针第一版就撞了）。P1/P3 的装饰生成器
   要按这个边界拆：**行内 mark / 行装饰走 ViewPlugin**（视口作用域、便宜），
   **块 widget 走 StateField**（全文作用域、参与高度测量）。
2. **widget 高度变化的滚动稳定性取决于「是否走事务」**（第 6 节新坑 1 的实测答案）：
   - 事务驱动（dispatch state effect → 装饰重建 → CM 重新测量）：锚点漂移 **0px**
     （挂件在视口内、在视口上方 3 行两种情形都测了）——CM6 内部滚动锚定自动生效；
   - 原地改 DOM + `view.requestMeasure()`（无事务）：锚点漂移 **270~456px**（≈widget 高度增量）——
     不经事务，CM 滚动锚定不参与；
   - 缓解：变化后按锚点手动补偿 `scrollTop`，残余 ≤2px（实测 -1.1px）。
   → **P3 结论：挂件展开/收起一律走 state effect 事务**；图片拖宽手柄这类必须原地改 DOM 的，
     变化后必须做 anchor 补偿。widget 上设置 `estimatedHeight`（收起 48 / 展开 340）用于测量前占位。
3. **CM6 行号槽里有一个 `visibility:hidden` 的 "9999" 宽度测量元素**——写测试或查询 DOM 时要过滤，
   否则行号计数和序列断言全错。
4. **`compartment.reconfigure()` 返回的是 effect，必须 dispatch** 才生效
   （`view.dispatch({ effects: comp.reconfigure(...) })`）。P4 行号开关直接这么接。
5. **滚动活跃期 CM 会延迟清理视口外 DOM**（防抖机制），自动化测试采样 DOM 前必须等滚动稳定
   （探针里的 `waitScrollSettle()`：scrollTop 连续 4 帧不变），否则会采到过渡态旧元素、
   行号/行数断言随机失败。

**结论：P0 全绿，内核能力（行号/IME/滚动/撤销）达到 Obsidian 同款 CM6 水准，可以进 P1。**
唯一需要写进 P3 工单的约束是发现 2：widget 高度变化走事务驱动，别原地改 DOM。

复跑：`npm run test:cmlab`；也可 `npm run dev` 后手开 `http://localhost:9520/cmlab.html`，
页内点「运行全部探针」（IME 组词在页内手动触发也可观察，自动断言需 CDP 驱动）。

### 7.2 P1 结论（2026-10-18 · 已完成，探针 5/5 全过 + 全量回归绿）

**交付物**

| 文件 | 内容 |
|---|---|
| `public/js/markdown.js` | 拆出 `parseMarkdown(md) → { blocks, lines, lineStarts, lineEnd }`；`renderMarkdown` 改为 render(parse)，DOM 输出逐字不变（roundtrip 22 篇不动点 + 300 篇模糊 + gap/enter/polish 全绿） |
| `public/js/cm/decorations.js` | `livePreviewPlugin`（ViewPlugin：标题行装饰、行内样式+标记隐藏、列表标记 muted、引用/分割线/表格行装饰、光标行规则）+ `fenceHiding`（StateField：围栏行、表格分隔行整行收起） |
| `public/cmlab.html` + `public/js/cmlab.js` | 探针页接入真装饰器（替掉手写装饰）；新增第 ⑤ 项「装饰渲染(P1)」10 条断言 |
| `public/cmlab.html` 样式 | `cm-lp-*` 装饰类（标题字号/粗斜体/高亮/代码/双链/标签/行装饰） |

**P1 踩的 9 个坑（都已修，P2/P3 直接抄结论）**

1. **装饰生成器里一个非法 range 会让整个插件被 CM6 禁用**——报错是 `CodeMirror plugin crashed`，
   表现是「全部装饰消失」（不是局部失效）。防御：`build()` 整体 try/catch + 逐条校验
   `Number.isFinite(from/to)`、`0 ≤ from < to ≤ doc.length`。今天的肇事者是 hr 描述符漏了偏移。
2. **`Decoration.replace({})` 的零宽/反向区间直接抛 `RangeError: Invalid range for replacement decoration`**
   ——无 widget 的 point replace 要求 `from < to`。
3. **AST 行号 0-based、CM `doc.line(n)` 1-based**——混用会让装饰整体挂歪一行（实测：藏掉了段落和代码行、
   围栏行反而留着）。统一走 `docLine(state, idx0)` 转换。
4. **块级 replace 的 range 必须逐行 `[line.from, line.to)`**——图省事写「开围栏→闭围栏」一个大 range，
   会把代码正文一起替换成零高 widget（行号 8-11 全丢）。
5. **CM 原生行号槽不给零高行编号**——围栏行收起后序号有断差（7→9），Obsidian 同一个槽同源行为；
   探针 ① 的断言已按「严格递增 + 可见行一一对应」写。
6. **正则扫描器的 lastIndex 陷阱**——拒绝重叠匹配后必须 `p.re.lastIndex = m.index + 1` 回退继续，
   否则假匹配（`**粗**` 内部的 `*加粗*`）会把后面的真匹配（`*斜体*`）跳过去。
   `inlineToHtml` 用 stash 把匹配文本替换掉，所以没这个问题；装饰侧不能照抄「只 continue」。
7. **行内标记要「藏标记 + 只给内容上样式」**——mark 覆盖整个 `**...**` 会让星号可见；
   正确做法是首尾标记各一个 hide、内容一个 mark（与块级渲染的 stash 语义对齐）。
8. **表格分隔行必须走块级收起**（StateField）——内联 replace 只删文字、行高还在，视觉上留一条空行。
9. **手写 scrollTop 锚点补偿不可靠**——与 CM 自己的测量周期互抢滚动位置（实测过冲 60px+）。
   P0 时「补偿 ≤2px」的结论作废：**挂件高度变化一律走 state effect 事务**（A/B 变体实测 0 漂移）。

**肉眼一致验收**：`test/screenshots/p1-compare-block.png`（块级渲染）vs `p1-compare-cm.png` / `p1-final-cm.png`（CM + 装饰）。
已对齐：标题层级/加粗/斜体/删除线/高亮/行内代码/双链/标签、列表标记、引用、代码块围栏收起、
分割线、表格行背景；**未对齐（留给 P3）**：表格整块样式（边框/对齐/单元格）、Callout 卡片、图片/嵌入 widget、复选框。

---

## 8. 下个会话从这里开始

1. 读这份文档 + `docs/HANDOFF.md` 的 #14 / #21 / #26 / #34 / #36 / #40 / #41 / #42（空行/光标/行号/跨行删除的既有结论）
2. 跑一次 `npm run test:e2e` + `test:gap` + `test:backspace` + `test:cmlab` 确认基线是绿的
3. **P0 ✅ 完成**（探针 5 项全过，结论 7.1）；**P1 ✅ 完成**（parse/render 拆分 + `cm/decorations.js`，
   探针第 ⑤ 项 10 条断言全过，结论 7.2，含 9 个坑）
4. **下一步：P2 行内编辑**——光标行规则已经在 P1 做了（装饰侧 `cursor.has()`），P2 要补的是：
   Enter 续列表/任务列表（`insertNewlineContinueMarkup` + 自定义 `- [ ]`）、Tab 缩进、
   `Ctrl+B/I/S/K`、Backspace 行首合并（CM 原生有，但要注意与块级模型的 `_mergeLineBackward` 逻辑对齐）、
   粘贴/拖入附件拦截（`domEventHandlers`）
5. P2 完成后再动 P3（块级 widget，最容易丢功能）→ P4 接回 app.js → P5 测试迁移

### 给用户的开场提示词（可直接粘贴）

```
读 docs/EDITOR-MIGRATION.md（编辑区内核迁移交接），继续 P2 行内编辑：
在 public/js/cm/ 下补 keymap（Enter 续列表/任务列表、Tab 缩进、Ctrl+B/I/S/K），
粘贴/拖入附件在 domEventHandlers 里拦掉，用 cmlab 探针页加第 ⑥ 项断言，
结论写回文档第 7 节；不要动现有的 public/js/editor.js（P4 才接回）。
```
