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

### P2 行内编辑（1~2 天）—— ✅ **已完成（2026-10-18），结论见 7.3**
- 光标行显示语法标记（`Decoration.mark` 的 `inclusive` + `cursorLine` 判断）——P1 装饰侧已做
- Enter 续列表 / 任务列表、Tab 缩进、`Ctrl+B/I/S/K`、Backspace 行首合并（CM 默认有，验证即可）
  → 落在新模块 `public/js/cm/editing.js`（不碰 `editor.js`）

### P3 块级 widget（1~2 天，最容易丢功能的一段）—— ✅ **「无服务端依赖」子集完成（2026-10-18），结论见 7.4**
- 已做：图片嵌入 widget + 拖宽手柄、复选框 widget、Callout 行装饰、表格边框（行装饰）、双链/标签 hover+点击 → `public/js/cm/widgets.js`
- 未做（留 P4）：`![[笔记]]` 嵌入卡片（需 `Api.note`）
- 原计划（保留供参考）：
- `![[图片.png|640]]` → 图片 widget + 右下角拖宽手柄（复用 `editor.js` 里的 `_renderImageEmbed`、`setImageWidth` 逻辑）
- `![[笔记]]` → 嵌入卡片（复用 `Api.note` + `renderMarkdown`，注意 `tagOffsets:false`）
- `> [!tip]` → Callout 卡片（标题行可编辑，正文仍是 CM 行，用 `Decoration.line` 做左侧色条即可，别整块 replace，否则正文不可编辑）
- 表格 → 建议**不整块 replace**，用 `Decoration.line` + widget 补边框；整块 widget 会失去单元格编辑
- 双链/标签的 hover 预览、点击跳转（复用 `editor.js` 的 `_schedulePreview` / `_openWikilink`）
- 复选框：`Decoration.replace` + widget checkbox，pointerdown 时改 doc

### P4 接回 app.js（1 天）—— ✅ **P4-1 适配器 + P4-b1 接线 + P4-b2 默认切 cm 全部完成；结论见 7.5 / 7.6 / 7.7**
- **已做（P4-1）**：`public/js/cm/engine.js` 的 `CmEditor` 实现下方全部契约方法（探针 ⑧ 23 条全过），
  业务依赖全注入、零业务 import；`![[笔记]]` 嵌入卡片也已落地
- **待做（P4-b）**：
- `LiveEditor` 类**保留名字和全部方法**，内部换成 `CmEditor`（见第 5 节契约）
- `#editor-live` 只作为 CM 的挂载点（`new EditorView({ parent: liveEl })`）
- 源码模式 = 切换 extension（关掉所有装饰 + 开 `lineNumbers`），`#editor-source` / `.source-wrap` 可以删除，但要**同步改 app.js 与 test**（见 5.3）
- 设置项：行号开关直接映射 `lineNumbers` compartment；字号/宽度继续走 CSS 变量（CM 支持 `EditorView.theme`）
- 回退开关 `settings.editorEngine='block'|'cm'`

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
npm run test:cmlab          # CM6 探针（P0–P4：IME/行号/滚动/widget/history/装饰/行内编辑/块级widget/引擎适配器）
npm run test:engine         # CM 内核真实 app 冒烟（?engine=cm：挂载/渲染/输入落盘/切模式）
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

### 7.3 P2 结论（2026-10-18 · 已完成，探针第 ⑥ 项 21 条断言全过 + 全量探针绿）

**交付物**

| 文件 | 内容 |
|---|---|
| `public/js/cm/editing.js` | **新增**。P2 编辑内核：`continueMarkupOrTask`（Enter）、`indentMore`/`indentLess`（Tab/Shift+Tab）、`toggleBold`/`toggleItalic`/`toggleStrike`/`insertWikilink`（Ctrl+B/I/S/K）、`assetEventHandlers`（粘贴/拖入附件拦截）、`editingKeymap` + `editingExtensions()` |
| `public/js/cmlab.js` | `markdown({ base, addKeymap:false })` + 接入 `editingExtensions({ onAssetFile })`；新增第 ⑥ 项探针 `probeEditing()`（21 条断言）；`window.__probe.p2` |
| `test/cmlab-test.mjs` / `public/cmlab.html` | 文档串与页头说明更新（5 → 6 项探针）。**运行器逻辑不用改**：⑥ 与其余探针一样在 `runAll` 内跑、写进 `window.__probe.results`，`autoOk` 自动纳入 |

**没有动 `public/js/editor.js`**（P4 才接回）——P2 全部落在新模块里。

**实测（Edge 150 headless）**：⑥ 项 21 条断言全过。覆盖：
Enter 续任务列表（自补 `- [ ] `）/ 无序 / 有序自增（`2.`→`3.`）/ 引用、空任务项回车退出列表；
Tab 缩进列表行（行首 +2 空格）/ Shift+Tab 反缩进 / Tab 普通行光标处插 2 空格；Backspace 行首合并到上一行；
Ctrl+B/I/S 包裹选区（`**…**`/`*…*`/`~~…~~`）、Ctrl+B 无选区插标记对；Ctrl+K 无选区插 `[[链接文字]]` 并选中、有选区包双链；
粘贴附件被拦（不落 `data:`/`blob:`、回插 `![[…]]`）、拖入附件被拦、`dragover(含文件)` 被拦、纯文本粘贴不误拦。

**P2 的 4 个关键结论（P3/P4 直接抄）：**

1. **keymap 要自持，并把 `markdown` 的 keymap 关掉**：`markdown()` 默认 `addKeymap:true` 会装一份
   `markdownKeymap`（**Prec.high**），与本模块的 Enter/Backspace 绑定抢顺序。配方是
   `markdown({ base: markdownLanguage, addKeymap: false })` + `Prec.high(keymap.of(editingKeymap))`。
   本模块把 `insertNewlineContinueMarkup` / `deleteMarkupBackward` **显式挪进自己的 keymap**，
   Enter/Backspace 只在一处定义、顺序确定。非 markdown 上下文（如代码块内）返回 false，
   由 `defaultKeymap` 的 `insertNewlineAndIndent` / `deleteCharBackward` 兜底，因此**不用自己再兜一层**。
2. **CM 内置的 `insertNewlineContinueMarkup` 不续任务项 `[ ]`**：GFM 的 Task marker 不在它的续行逻辑里，
   在 `- [ ] 甲` 上回车得到的是 `- `（丢了复选框）。所以 `continueMarkupOrTask` 单光标命中
   `^(\s*)([-*+]\s+)\[([ xX])\]\s?` 时自己续 `行首缩进 + 项目符号 + '[ ] '`（固定未勾选）；
   **空任务项**（`- [ ] ` 后无内容）则整行去标记（留在原行）= 退出任务列表——这一步也自己做了，
   因为内置对空任务项的去标记行为不保证与 `editor.js` 的 `_handleEnter` 口径一致。其余（有序/无序/引用/普通换行）
   全部交还内置命令。
3. **粘贴/拖入拦截的「谁先谁后」很关键**：CM6 在 `InputState` 里有一份**内置** `handlers.paste` / `handlers.drop`
   （drop 对文件走 `FileReader.readAsText` 把文件**文本**插进文档）。`computeHandlers` 的拼装顺序是
   **先插件的 `domEventHandlers`、后内置 handlers**，`runHandlers` 遇到第一个返回 true 的即 `preventDefault` 并 break——
   所以我们的 `assetEventHandlers` 只要在有文件时返回 true，就能抢在内置 drop 之前拦下。
   - 判断依据是 `clipboardData.items` 里有 `kind==='file'` / `dataTransfer.files` 非空；**纯文本粘贴必须返回 false**
     （否则误吞用户粘贴的文本），此时由内置 paste 正常插入。
   - **不能用 `event.defaultPrevented` 判断「是否被我们拦」**：内置 paste 自己也会 preventDefault（它插文本），
     断言要改成「附件记录（assetLog）有没有增 + 文档里有没有 `data:`/`blob:`」。
   - `dragover` 必须对含 `Files` 的拖拽 `preventDefault`，否则 drop 事件根本不触发。
4. **附件拦截只「拦 + 递文件」，不落盘**：内核不碰服务端，把 `File` 交给回调 `onAssetFile(file, view, event)`；
   P4 接 `editor.js._saveAssetFile`（`Api.saveAsset` → 回插 `![[path]]`）。探针页没有服务端，
   `onAssetFile` 只记录 File 并回插占位路径 `![[attachments/<name>]]`，用来断言拦截生效且文档干净。

**附带验证**：键盘断言走的是 CM 真实事件管线（`contentDOM.dispatchEvent(new KeyboardEvent(...))` →
`handleEvent` → `runHandlers` → `getKeymap`），不是直接调命令——所以能证明 keymap 装配（`Prec.high` + `addKeymap:false`）确实生效；
合成事件在 `ignoreDuringComposition` 里被放行（`event.synthetic` 分支返回 false），无需真实按键。

复跑：`npm run test:cmlab`（页内点「运行全部探针」亦可手看）。

### 7.4 P3 结论（2026-10-18 · 已完成「无服务端依赖」子集，探针第 ⑦ 项 17 条断言全过 + 全量探针绿）

**范围约定**：P3 全量含 6 项，其中 `![[笔记]]` 嵌入卡片依赖服务端 `Api.note`（探针页无 vault），
经确认本次只做「无服务端依赖子集」：① 图片嵌入 widget + 拖宽、② 复选框 widget、
③ Callout 行装饰、④ 表格边框、⑤ 双链/标签 hover+点击。**嵌入卡片留到 P4 接回 app.js 时做**。

**交付物**

| 文件 | 内容 |
|---|---|
| `public/js/cm/widgets.js` | **新增**。`ImageEmbedWidget` + `imageEmbeds`（StateField：整行 `![[..]]` → 图片/文件 widget + 右下角拖宽手柄，拖完改写 doc 宽度）、`CheckboxWidget`（行内 replace，点击改 doc）、`widgetsPlugin`（ViewPlugin：Callout 行装饰+藏 `>`/`[!type]`、表格行装饰边框、列表复选框）、`linkEvents`（双链/标签 hover+点击）、`setEmbedWidth`、`widgetExtensions()` |
| `public/js/cm/decorations.js` | 两处小改：① 整行嵌入的段落不再走行内装饰（让位给 P3 块级 widget，避免重叠）；② 修 `#标签` 行内 mark 的 off-by-one（见结论 6） |
| `public/js/cmlab.js` + `public/cmlab.html` | 接入 `widgetExtensions({ resolveImage 桩, 三个事件回调 })`；新增第 ⑦ 项探针 `probeWidgets()`（17 条断言）+ `cm-lp-img/cb/callout/tbl` 样式；`window.__probe.p3` |
| `test/cmlab-test.mjs` | 文档串更新（6 → 7 项探针）。运行器逻辑不用改 |

**没有动 `public/js/editor.js`**（P4 才接回）。

**实测（Edge 150 headless）**：⑦ 项 17 条断言全过——图片嵌入（src/宽 320px）、原语法收起、拖宽手柄、
非图片附件→文件条、复选框勾选态与点击改 doc、Callout 标题藏标记+行装饰、Callout 正文仍是真实可编辑行、
表格边框（2px）+ 单元格文字未被 replace、双链/标签 span 的 hover/click 回调、块级图片恒定显示、
拖动写回宽度（320→440）。链接事件记录：`[["hover","双链A"],["open","双链A"],["tag","#标签B"]]`。

**P3 的 7 个关键结论（P4 直接抄）：**

1. **块级 widget 的选区重建在 CM6 里不即时反映到 DOM → 块级嵌入别套「光标行显示原始语法」**。
   实测踩坑：`EditorState.create({doc})` 的默认光标在第 1 行，若对整行嵌入套用「光标行露源码」，
   第 1 行的图片会被跳过；且此后 `goTo()` 的 selection-only dispatch **不会刷新**该块级 widget
   （反复 3 帧仍看不到，只是 doc 变更后的重建才生效）。结论：块级嵌入**恒定显示**；
   只有 ViewPlugin 里的 mark/hide 才适合做光标行规则。→ 代价：暂时不能直接编辑 `![[...]]` 原始行（见下方边界）。
2. **两个相邻的 `![[..]]` 行会被解析成同一个段落**（parser 行为，与 `editor.js` 块级渲染一致），
   于是不会被识别成「整行嵌入」。块级图片要求**段落恰好是单行且整行就是一个嵌入**；
   相邻嵌入之间必须空行分隔。`widgets.js` 用 `blk.type==='paragraph' && blk.line===blk.endLine` 卡这个条件。
3. **装饰分两档：块级 replace 走 StateField，行内 replace/行装饰走 ViewPlugin**——
   图片嵌入 = 块级 → StateField；复选框 = 行内 replace、Callout/表格 = 行装饰 → ViewPlugin（视口作用域、便宜）。
   **表格不整块 replace**，只用 `Decoration.line` 补边框：单元格文字仍是真实源码行（实测 `lineText` 仍 `| 1 | 2 |`），可编辑。
4. **图片拖宽：拖动期只改本地 DOM，pointerup 才走事务写 doc**（P0 结论 2 的直接应用）。
   拖完 `setEmbedWidth` dispatch 一个 doc 变更持久化 `![[name|宽]]`，由 CM 重新测量并锚定滚动。
   widget 用 `estimatedHeight`（按宽度估算）做测量前占位。
5. **拖宽基准用 `img.style.width`（逻辑宽度）而非 `getBoundingClientRect().width`**——
   探针里图片 src 是桩（404，图未加载时 rect 宽度可能是 0），用逻辑宽度才能让拖动可复现（320→440 精确）。
6. **顺手修了 P1 遗留的 off-by-one**：`INLINE_PATTERNS` 里 `#标签` 那条 `inner:2` 从分隔符后起算
   （起点落在 `#`），但长度只加了「名字」的长度 → mark 覆盖 `#标签`、**丢掉最后一个字**（`#标签B` 渲染成 `#标签`）。
   已改为分组 2 把 `#` 一起括进来（`(#[\p{L}…]*)`）。是 P3 的「标签点击」断言把它逼出来的；P1 的探针只查了 span 存在，没查文本，故漏网。
7. **双链/标签事件走 `domEventHandlers`，复用 P1 的行内 span**（`.cm-lp-wikilink` / `.cm-lp-tag`）：
   `click` 命中即 `preventDefault` 并回调（返回 true，阻止 CM 后续处理）；`mouseover` 回调但返回 false（不拦，避免影响 CM 自身）。

**P3 子集的两条已知边界（留给后续）：**

- **`![[笔记]]` 嵌入卡片**：需 `Api.note` + `renderMarkdown(tagOffsets:false)`，随 P4 接回 app.js 时做；
  架构上就是再加一个 StateField（异步解析走 state effect）。
- **块级图片恒显 → 不能直接编辑 `![[...]]` 原始行**：要修得让 StateField 的选区重建能即时刷新
  （可能要配合 `view.requestMeasure()` 或改成 ViewPlugin 视口内 + 命中行单独处理），或等 P4 用 CM 的
  `EditorView.updateListener` 做一次显式 `requestMeasure`。另外 Callout **正文内**的行内装饰
  偏移是 P1 侧的旧问题（子文档 base 未按 `>` 位移），本次只在 Callout 做行装饰+藏标记，没动行内；正文含 `**粗体**` 会错位。

复跑：`npm run test:cmlab`（7 项探针 + IME 全绿）。

### 7.5 P4 第一步结论（2026-10-18 · 已完成「CM 引擎适配器 + 探针⑧」，**未接线**）

**范围约定**：P4 全量 = 把 `LiveEditor` 内部换成 CM + 同步改 app.js DOM 契约 + 回退开关（会动生产文件）。
经确认先做**独立适配器**（不动 `editor.js`/`app.js`，18 套件基线不受影响），并把 P3 遗留的
`![[笔记]]` 嵌入卡片一并做完。接线（P4-b）留到下一轮。

**交付物**

| 文件 | 内容 |
|---|---|
| `public/js/cm/engine.js` | **新增**。`CmEditor` 类：实现第 5.2 节 `LiveEditor` 的全部方法契约（`load/getContent/flush/setMode/toggleMode/focus/insertSnippet/insertText/wrapSelection/setLinePrefix/selectAll/removeImageAt/setImageWidth/scrollToHeading/setAutosave/setLineNumbers/undo/redo/canUndo/canRedo/dirty`）。**不 import `editor.js`/`api.js`/`settings.js`**，业务依赖全部注入（`saveAsset/fileUrl/loadNote/resolveLink/resolveFile` + 各回调） |
| `public/js/cm/widgets.js` | 嵌入装饰由「图片单件」升级为 `embedWidgets` **三合一**（图片 widget / 附件文件条 / **笔记嵌入卡片**）：新增 `noteLoaded` StateEffect + `noteCache` StateField + `NoteEmbedWidget`（异步解析、`renderMarkdown(tagOffsets:false)` 渲染正文）；`ImageEmbedWidget` 补 `onImageClick`（灯箱）与 `dataset.from`（供 `setImageWidth`/`removeImageAt` 定位） |
| `public/js/cmlab.js` + `public/cmlab.html` | 第二个挂载点 `#cm2` + 第 ⑧ 项探针 `probeEngine()`（**23 条断言**）+ `.cm-lp-note` 样式；`window.__probe.engine` |
| `test/cmlab-test.mjs` | 文档串更新（7 → 8 项探针） |

**没有动 `public/js/editor.js` / `public/js/app.js`**。

**实测（Edge 150 headless）**：⑧ 项 23 条断言全过。覆盖：`load/getContent` 一致、编辑同步与
`dirty/onChange`、`insertSnippet` 首尾补换行、`wrapSelection`（有/无选区）、`setLinePrefix`、
`selectAll`、`undo/redo/canUndo/canRedo`、行号 compartment 开关（10→0→10）、`setMode` 切扩展集（装饰 live=true/src=false/back=true）、
图片 widget + `onImageClick` + `setImageWidth` 写回 doc + `removeImageAt`、**`![[笔记]]` 卡片异步渲染**、
双链点击→`onNavigate`、标签点击→`onTagClick`、附件拦截→`saveAsset`→回插 `![[附件/probe-paste.png]]`、
`flush` 落盘并清 dirty、`scrollToHeading` 命中标题。全程 **8 探针 + IME 全绿，无页面错误**。

**P4 的 6 个关键结论（接线时直接抄）：**

1. **源码模式 = 同一份 doc 切扩展集**，不再需要第二个 textarea：`decoComp.reconfigure(live ? liveExt : [])`
   （关掉实时预览装饰就算源码视图）；行号独立走 `lineNumComp`（`reconfigure` 返回 effect，**必须 dispatch**）。
   两个 compartment 都是实例字段，`_extensions()` 每次重建 state 时复用同一份 compartment。
2. **撤销交给 CM `history()`，换笔记用 `view.setState(新 state)`** —— 等价于块级模型的 `_resetHistory`
   （撤销栈按笔记隔离，不会跨文件回滚）；`canUndo/canRedo` 直接读 `undoDepth/redoDepth`，源码模式一样可用
   （比块级模型的「源码模式无撤销栈」更好）。
3. **异步 widget（笔记卡片）的刷新坑**：装饰集内容变了但**装饰集本身没变**时，CM 会复用旧 DOM → 卡片停在「加载中…」。
   配方：`noteLoaded` **StateEffect** 触发嵌入 StateField 重建 + `NoteEmbedWidget.eq()` **把缓存的 md 一起比**
   （数据变 → eq 变 false → 重新 `toDOM`）。只加 effect 不改 eq 是不行的。
4. **业务依赖全注入，引擎零业务 import**：`saveAsset`（附件落盘）、`fileUrl`、`loadNote`（笔记解析）、
   `resolveLink/resolveFile` 全由构造参数给。这样引擎能在探针页端到端跑，接线时 `editor.js` 只需把
   `Api.saveAsset`/`Api.note`/`Api.fileUrl` 包一层传进去，逻辑零改动。
5. **`#editor-live` 变挂载点后，源码模式的显隐归属 app.js**：CM 的 view 在两种模式下都不该被 `hidden`
   （源码只是「关装饰」）。接线时要把 app.js 里「切源码 → 隐藏 liveEl、显示 source-wrap」的逻辑
   改成「不隐藏 CM、只把 source-wrap 彻底移除」，并同步 5.3 的选择器/测试。—— 这是 P4-b 的主要工作量。
6. **块级嵌入仍旧恒定显示**（P3 结论 1 的延续）：引擎里图片/附件/笔记卡片都不套「光标行露源码」，
   所以 `![[..]]` 原始行暂不能直接编辑；要修得让块级 widget 的选区重建能即时刷新（P4-b 候选：
   `EditorView.updateListener` 里在选区变化时显式 `requestMeasure()`，或把「命中行」的块装饰改走 ViewPlugin）。

**P4-b 待办（下一轮）**：① `editor.js` 的 `LiveEditor` 内部换成 `CmEditor`（或让 `LiveEditor` 继承/包装）；
② app.js DOM 契约改造（5.3）；③ `settings.editorEngine='block'|'cm'` 回退开关；④ P5 测试迁移（重写
`test/enter`、`test/gap`、`test/polish` 里依赖块级 DOM 的断言）。

复跑：`npm run test:cmlab`（8 项探针 + IME 全绿）。

### 7.6 P4-b1 结论（2026-10-18 · 引擎开关接线，**默认仍 block**，基线未动）

**范围约定**：P4-b 全量 = 默认切 cm + 改 DOM 契约 + 重写块级测试。本轮先做「**可切换**」这一层：
接线 + 真实 app 冒烟测试通过，但**默认仍是 `block`**，所以 18 套件基线（`test:e2e` 15/15）原样绿。
把默认切到 `cm` 与测试迁移（P5 的一部分）留到 P4-b2。

**交付物**

| 文件 | 内容 |
|---|---|
| `public/js/settings.js` | 新增 `editorEngine: 'block'`（默认块级）+ 设置面板「编辑器 → 编辑内核」分段开关（块级 / CM6），一键切回 |
| `public/js/app.js` | 编辑器改**工厂**：`?engine=cm\|block` 覆盖 → 设置 `editorEngine` → 默认 block；opts 补 `fileUrl/loadNote/saveAsset`（cm 用，块级忽略）；cm 模式收尾（`#editor-live` 置 `contentEditable=false`、隐藏 `#source-wrap`） |
| `public/index.html` | 补 `<!-- IMPORTMAP -->` 标记并注入 CM vendor importmap（**接线第一坑**，见结论 1） |
| `test/engine-test.mjs` + `package.json` | 新增 `npm run test:engine`：真实 app 冒烟（`?engine=cm` → 挂载 CM、开笔记、真实键盘输入、自动保存校验、切模式、无页面错误） |

**实测**：`npm run test:engine` **7/7 全过、无页面错误**（CM 挂载、块级 DOM 不出现、标题行装饰 7 条、
键盘输入落盘、源码模式装饰 0→切回 5、切模式 doc 不变）；`npm run test:e2e` **15/15 仍绿**（默认 block 未回归）。

**P4-b 的 6 个关键结论：**

1. **主页面缺 importmap 是接线的第一坑**：`app.js` 一旦 `import CmEditor`，就会连带 import
   `@codemirror/*` 等**裸导入名**；`public/index.html` 之前没有 importmap → 模块解析失败 →
   **整个 app 不启动（白屏，`#app` 一直 hidden）**。修法：给 index.html 加 `IMPORTMAP:BEGIN/END` 标记，
   跑 `node scripts/build-cmvendor.mjs --html public/index.html` 注入（cmlab 早就有，主页面漏了）。
   —— 这是「换内核」最容易在地一步就挂掉的地方。
2. **双内核用「工厂 + 同一套 opts」共存**：`LiveEditor` 与 `CmEditor` 方法契约一致（第 5 节），
   所以 app.js 的回调与后文所有 `editor.xxx()` 调用**零改动**即可对二者通用；
   cm 额外需要的 `fileUrl/loadNote/saveAsset` 直接多传几个 key，块级内核忽略未知 opts。
3. **cm 模式的 DOM 收尾**：`#editor-live` 必须置 `contentEditable=false`（CM 自带 contenteditable，
   外层容器再可编辑会出现嵌套 contenteditable）；`#source-wrap` 直接隐藏（不再有独立 textarea）。
4. **默认留 `block`**：切默认会让 `test:enter`/`test:gap`/`test:polish` 里依赖块级 DOM 的断言全红，
   与「不破坏基线」冲突。所以开关默认 block，cm 通过设置项或 `?engine=cm` 开启（重载笔记生效）。
5. **app.js 里监听 `#editor-live` 的块级专用 handler 在 cm 下基本无害**：表格 Tab/Enter（找 `td/th`）、
   点空行落光标（找 `.md-blank`）、右键保住选区——在 cm 的 DOM 下选择器命中不到，**都早退**，不报错。
   实测冒烟无 pageerror。唯一功能回归：**「编辑器滚动关闭链接预览」会失效**（cm 的滚动发生在内部
   `.cm-scroller`，`#editor-live` 收不到 scroll）——记入 P4-b2 待办。
6. **`loadNote`/`saveAsset` 与 editor.js 同口径复刻**（note 截 3000 字；附件 30MB 上限 +
   FileReader → `Api.saveAsset({data,name,dir})`）。这段逻辑目前两处各一份，P5 可提到 editor.js 共用。

**P4-b2 待办（下一轮）**：① 默认切 `cm`；② 重写 `test/enter`、`test/gap`、`test/polish` 里依赖块级 DOM 的断言；
③ 修 cm 下的小回归（`#editor-live` 滚动关预览 → 改挂 `.cm-scroller`；右键菜单「移除图片」的图片判定 →
识别 `.cm-lp-img`）；④ 可选：把 app.js 里块级专用 handler 用 `ENGINE` 判定显式包起来（现在靠选择器早退，够用但不显式）。

复跑：`npm run test:cmlab` + `npm run test:engine` + `npm run test:e2e`。

### 7.7 P4-b2 结论（2026-10-18 · **默认切 cm 完成**；块级套件改 pin；cm 小回归修复）

**范围约定**：把默认内核切到 `cm`（用户可见迁移完成），并保住全量套件绿。为不破坏基线，块级断言套件
**显式 pin `?engine=block`**（成为块级内核回归网）；cm 默认路径由 `npm run test:engine` + cmlab 探针覆盖。
把块级套件重写成 cm 口径留到 P5。

**交付物**

| 文件 | 内容 |
|---|---|
| `public/js/settings.js` | `editorEngine` 默认由 `block` 改为 **`cm`**（设置面板一键回退到块级） |
| `public/js/app.js` | ① `#editor-live` 滚动关链接预览改**捕获阶段**（cm 的滚动在内部 `.cm-scroller`，scroll 不冒泡）；② 修 **`resolveAssetDir` 未导入**的 bug（见结论 4） |
| `test/*.mjs`（15 个） | 块级断言套件统一 pin `http://localhost:PORT/?engine=block`（e2e/enter/gap/polish/menu/features/tabs/layout/asset/trash/draw/roundtrip/backspace/ui/ux + design-check/img-probe） |
| `test/engine-test.mjs` | 重写为**自带临时仓库**（mkdtemp 自建两篇笔记 + `/api/vault/open`，**不碰仓库 demo-vault**），断言扩到 **9 条**（含附件落盘+回插、双链跳转） |

**实测**：`test:engine` **9/9 全过、无页面错误**（含「粘贴附件只插一次」）；`test:cmlab` 8 探针 + IME 全绿；
`test:e2e` **15/15**；其余块级套件（enter/gap/polish/menu/features/tabs/layout/asset/trash/draw/roundtrip/
backspace/ui/ux/sync/sync-ui/lan/merge）全绿。

**P4-b2 的 6 个关键结论：**

1. **「默认切 cm」会打掉所有块级 DOM 断言的套件**（实测：e2e 11/15；enter/gap/polish/menu 直接报
   「找不到 `#editor-live p`」类错误）。切法：这些套件**显式 pin `?engine=block`**，一改全绿，
   它们从此是「块级内核回归网」。**注意覆盖缺口**：这些套件不再覆盖默认(cm)路径，
   cm 由 `test:engine` + cmlab 探针兜底；把块级套件改写成 cm 口径是 P5 的事。
2. **`?engine=cm|block` 查询参数覆盖**是好东西：测试/手工验证一页一引擎，不动持久化设置。
   P4-b1 加的这条此时成为「双内核共存」的关键开关。
3. **cm 下「编辑器滚动关闭链接预览」必须用捕获阶段**：cm 的滚动发生在内部 `.cm-scroller`，
   `scroll` 事件不冒泡，外层 `#editor-live` 默认收不到 → `addEventListener('scroll', fn, true)`
   （捕获阶段会经过祖先，兼容两种内核）。这是 P4-b1 遗留的小回归，已修。
4. **接线真 bug：`resolveAssetDir` 未导入，被 try/catch 吞掉**。`app.js` 新加的注入式 `saveAsset` 引用了
   `resolveAssetDir`，但没从 `settings.js` import → 运行时 `ReferenceError` → 被 `catch { toast('附件保存失败') }`
   吞成「静默失败」：**cm 下粘贴/拖入附件时拦截生效（`defaultPrevented=true`），但文件不落盘、不插链**。
   教训：注入式回调里引用漏导入的符号，错误会被业务 catch 掩盖；**测试必须断言「文件真的落盘 / 链真的插入」，
   不能只看 UI 无报错**。已修（补 import）。
5. **真实 app 测试必须自带临时仓库**：engine-test 第一版直接用默认仓库 → 而服务端在全新 TRACERY_HOME 下把
   **仓库里的 `demo-vault` 当默认仓库**（不是副本），于是测试把附件和测试行写进了仓库（实测污染后已清理）。
   正确姿势：`mkdtemp` 自建仓库 + `POST /api/vault/open {path}` + 重载（与 features/menu/trash 套件同款）。
   写真实 app 的套件一律如此，别依赖默认仓库。
6. **发现一个块级内核的既有问题（非本次引入）**：跑 e2e 后，「Markdown 语法.md」里列表项内的
   `![[常用代码]]` 被序列化拆成了 `!` + 空行 + `[[常用代码]]`。已复原仓库产物（未提交这处污染）。
   这是块级引擎对「列表项内联 `![[..]]` 嵌入」的序列化 bug，值得单独排查——也是切到 cm 的又一条理由
   （cm 的 doc 就是权威文本，不存在这种序列化漂移）。

**P5 待办**：① 把块级套件改写成 cm 口径（或做「双引擎各跑一遍」）以覆盖默认路径；② 全量 18 套件回归 →
`npm run dist:dir` + `npm run release`；③（可选）若仍要维护 block 回退，先修结论 6 的序列化 bug。

复跑：`npm run test:cmlab` + `npm run test:engine` + `npm run test:e2e`（+ 其余块级套件）。

### 7.8 P5 结论（2026-10-18 · **cm 默认路径功能覆盖已补齐**；套件口径改写与打包待续）

**范围约定**：P5 含「把块级套件改写成 cm 口径 + 全量回归 + 打包发布」。本轮先做**最要紧的一步**：
给**默认（cm）路径**补上真实 app 的功能覆盖（此前只有 `test:engine` 的 9 条冒烟），并试打包。
块级套件仍 pin `?engine=block`（作为块级回归网）；把它们逐条改写成 cm 口径仍待做。

**交付物**

| 文件 | 内容 |
|---|---|
| `public/js/app.js` | 加 `window.__editor` **测试/调试钩子**（暴露当前内核实例，供断言 `getContent()/view`，不再依赖块级 DOM） |
| `test/engine-test.mjs` | 断言由 9 → **12 条**：新增 **Ctrl+Z / Ctrl+Y 撤销重做**、**设置面板行号开关**（compartment）、**Enter 续任务列表**（`- [ ] `）；仓库再自建 `任务.md` |

**实测**：`test:engine` **12/12 全过、无页面错误**；`test:cmlab` 8 探针 + IME 全绿；`test:e2e` 15/15；
其余块级套件全绿；`demo-vault` 无污染。

**P5 的 5 个关键结论：**

1. **cm 侧撤销/重做在真实 app 生效**：`Ctrl+Z` 可用，**重做请用 `Ctrl+Y`**——`Ctrl+Shift+Z` 在自动化里
   因为按住 Shift 会让 `key` 变成大写 `Z`，与 CM keymap 的 `Mod-Shift-z`（小写 z）**不匹配**，
   键不触发。这是「真键盘测试」的坑，记下来省得下回再踩。
2. **行号开关（设置面板 → `lineNumComp.reconfigure`）在真实 app 实测 off=0 / on=1**，
   与 P0 结论 4「reconfigure 返回 effect 必须 dispatch」闭环。
3. **cm 下 Enter 续任务列表在真实 app 生效**（`- [ ] 甲任务` + 回车 → 新行 `- [ ] `），
   P2 的 `continueMarkupOrTask` 不只是探针页能过。
4. **`window.__editor` 是把块级套件改写成 cm 口径的关键工具**：块级套件断言的是
   `#editor-live p/h1/li/.md-blank` 这类渲染产物；cm 下这些不再存在，但**文档文本**（`getContent()`）
   是权威且稳定的断言面。后续改写套件时，把「查 DOM」换成「查 `getContent()` / `view.state`」即可，
   只有真正关于渲染的断言（如标题字号、复选框控件）才需要查 `.cm-line` / `.cm-lp-*`。
5. **打包（`npm run dist:dir`）在本机失败**：electron-builder 解压 `winCodeSign` 缓存需要**创建符号链接的权限**
   （普通 Windows 账户失败：`Cannot create symbolic link ... : 客户端没有所需的特权`）——这是既有环境问题
   （见 `docs/HANDOFF.md` 已知坑），**非本次改动引入**，本轮未产出安装包。发布（`dist:dir` + `release`）需在
   具备权限/开启了开发者模式的环境执行。

**P5 剩余待办**：① 用 `window.__editor` 把 `test/enter`、`test/gap`、`test/polish`、`test/menu`、`test/e2e`
的块级 DOM 断言改写成 cm 口径（或做「双引擎各跑一遍」），让默认路径不再是「只有 engine-test 覆盖」；
② 在具备符号链接权限的环境跑 `npm run dist:dir` + `npm run release`。

复跑：`npm run test:cmlab` + `npm run test:engine` + `npm run test:e2e`。

---

## 8. 下个会话从这里开始

1. 读这份文档 + `docs/HANDOFF.md` 的 #14 / #21 / #26 / #34 / #36 / #40 / #41 / #42（空行/光标/行号/跨行删除的既有结论）
2. 跑一次 `npm run test:e2e` + `test:gap` + `test:backspace` + `test:cmlab` 确认基线是绿的
3. **P0 ✅ 完成**（探针 5 项全过，结论 7.1）；**P1 ✅ 完成**（parse/render 拆分 + `cm/decorations.js`，
   探针第 ⑤ 项 10 条断言全过，结论 7.2，含 9 个坑）；**P2 ✅ 完成**（`cm/editing.js`：Enter 续列表/任务列表、
   Tab 缩进、Ctrl+B/I/S/K、粘贴拖入拦截，探针第 ⑥ 项 21 条断言全过，结论 7.3，含 4 个关键结论）；
   **P3 ✅ 完成（无服务端依赖子集）**（`cm/widgets.js`：图片嵌入+拖宽、复选框、Callout、表格边框、
   双链/标签事件，探针第 ⑦ 项 17 条断言全过，结论 7.4，含 7 个关键结论）；
   **P4-1 ✅ 完成（CM 引擎适配器，未接线）**（`cm/engine.js`：`CmEditor` 实现第 5.2 节全部方法契约 +
   `![[笔记]]` 嵌入卡片，探针第 ⑧ 项 23 条断言全过，结论 7.5，含 6 个关键结论）；
   **P4-b1 ✅ 完成（引擎开关接线，默认仍 block）**（settings `editorEngine` + app.js 工厂 + index.html
   importmap；新增 `npm run test:engine` 真实 app 冒烟 7/7 全过，`test:e2e` 15/15 未回归，结论 7.6）；
   **P4-b2 ✅ 完成（默认切 cm）**（settings 默认 `cm`；块级断言套件改 pin `?engine=block`；
   修 cm 滚动关预览 + `resolveAssetDir` 未导入 bug；engine-test 重写为自带临时仓库、扩到 9 条断言全过，
   全量套件绿，结论 7.7 含 6 个关键结论）；
   **P5（部分）✅ 完成（cm 默认路径功能覆盖补齐）**（app.js 加 `window.__editor` 钩子；engine-test 扩到 12 条：
   撤销重做/行号开关/Enter 续任务，全过；`dist:dir` 因本机符号链接权限受阻，见结论 5）
4. **剩余（P5 收尾）**——① 用 `window.__editor` 把 `test/enter`、`test/gap`、`test/polish`、`test/menu`、`test/e2e`
   的块级 DOM 断言改写成 cm 口径（或「双引擎各跑一遍」），让默认路径不再是「只有 engine-test 覆盖」；
   ② 在具备符号链接权限（或开启 Windows 开发者模式）的环境跑 `npm run dist:dir` + `npm run release`
5. 发布后保留 `settings.editorEngine` 一键回退；后续小迭代（块级嵌入露源码、Callout 正文行内偏移、
   块级序列化 bug）见 7.4/7.5/7.7 边界

### 给用户的开场提示词（可直接粘贴）

```
读 docs/EDITOR-MIGRATION.md（编辑区内核迁移交接），收尾 P5：把套件口径改写到 cm + 打包发布。
现状：默认内核已是 cm（7.7）；engine-test 已覆盖 cm 默认路径 12 条断言（7.8，含 window.__editor 钩子）；
块级套件仍 pin ?engine=block；dist:dir 在本机因符号链接权限失败。
本轮：
① 用 window.__editor（getContent()/view）把 test/enter / test/gap / test/polish / test/menu / test/e2e 的
   块级 DOM 断言改写成 cm 口径，或让这些套件对两个引擎各跑一遍（TRACERY_TEST_ENGINE 环境变量切换）；
② 全量套件回归（test:cmlab / test:engine / test:e2e + 其余 15 套）；
③ 在具备符号链接权限的环境跑 npm run dist:dir + npm run release；
④ 结论写回文档第 7 节（7.9）。
```
