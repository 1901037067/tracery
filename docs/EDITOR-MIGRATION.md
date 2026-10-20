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

### 7.9 P5 收尾交接（2026-10-18 · **只做调研盘点：未改代码 / 未跑测试 / 未提交产物**）

本节是「本轮会话结束时」的交接快照：把 7.8 遗留的两件事（① 套件口径改写 ② 打包发布）做成
**可直接执行的工单**，另外**新发现一个高风险缺口**（A）。下一轮照本节做即可，不必重新调研。

#### A. ⚠️ 新发现：cm 默认路径在真实 app 里**没有任何 CM 样式**（建议列为下一轮第 0 步）

**证据**（本轮只读，未改动任何文件）：

- `public/css/style.css`、`public/themes/apple.css`、`public/themes/obsidian.css` 里**没有一条 `.cm-` 规则**
  （`grep '\bcm-' public/**/*.css` 零命中）；全套 `.cm-lp-*` 的样式**只定义在 `public/cmlab.html`（第 38–74 行）**。
- `public/js/cm/{engine,decorations,widgets}.js` 里**没有 `EditorView.theme`，也没有 style-mod**——
  装饰与 widget 只产出 class 名（`decorations.js:232` `cm-lp-zero`、`widgets.js:75` `cm-lp-img`、
  `widgets.js:155` `cm-lp-note`、`widgets.js:233` `cm-lp-cb` …）。
- `public/index.html` 只加载 `themes/apple.css` + `css/style.css`，**没有引入 cmlab 的样式**。
- 唯一已经生效的是 `#editor-live` 自带的 `editor markdown-body` 两个类（`index.html:236`）：
  `.editor`（`style.css:669`）给了 CM 容器字号/行高/内边距，`.editor > *`（`style.css:679`）
  给了它 `max-width:720px` 居中——所以正文观感「还过得去」。
- **其余全无样式**：标题字号（`.cm-lp-h1/h2/h3`）、行内样式（粗/斜/删/高亮/行内代码/双链/标签颜色）、
  引用与 Callout 底色、表格边框、图片框 + 右下角拖宽手柄、复选框间距、**行号槽外观**。
  `test/screenshots/p4-cm-app.png` 里可以直接看到后果：行号槽是 CM 原生窄框、正文是默认小字号、
  复选框没有与 `.markdown-body` 对齐的间距。

**结论**：目前是「默认内核 = cm，但没有把 cmlab 的样式搬进 app」。这是 P5 里**优先级最高**的一项
（比改测试更高）——否则就算把「cm 口径」的渲染断言改对了，外观仍然不达标。

**建议做法**：

1. 把 `cmlab.html` 的样式段（`.cm-editor` 基础 + 全套 `.cm-lp-*` + `.cm-lp-img`/`grip`/`cb`/`tbl`/`callout`/`note`）
   抽成 `public/css/cm.css`（或并入 `style.css` 对应小节），**规则改用 app 的 CSS 变量**
   （`--editor-font-size` / `--text-primary` / `--text-tertiary` / `--accent` / `--hairline` / `--r-md` / `--font-mono` …）
   这样**明暗主题自动跟随**，不要再抄 cmlab 里那套写死的 `#fde68a` / `#7c3aed`。
2. 收敛滚动：`.editor { overflow-y:auto }`（`style.css:668`）与 CM 内部 `.cm-scroller` 会形成双滚动条，
   要改成一个（通常是外层不滚、交给 `.cm-scroller`，CM 才能做视口内渲染与滚动锚定）。
3. `index.html` 加一条 `<link rel="stylesheet" href="/css/cm.css">`（放在 `style.css` 之后）。
4. 验收：`npm run dev` 后**同一篇 demo-vault 笔记**在明/暗两主题下截图，与 `p4-cm-app.png` 对比，
   确认标题层级、链接颜色、表格边框、图片框、行号槽都正常。

#### B. `?engine=block` pin 清单（共 **17 处**，已定位到行）

```
asset-test.mjs:108   backspace-test.mjs:49   design-check.mjs:31   draw-test.mjs:61
e2e.mjs:109          enter-test.mjs:49       features-test.mjs:46  gap-test.mjs:52
img-probe.mjs:37     layout-test.mjs:49      menu-test.mjs:69      polish-test.mjs:46
roundtrip-test.mjs:55 tabs-test.mjs:58       trash-test.mjs:47     ui-ux-test.mjs:68
ui-vault-test.mjs:46
```

其余会开浏览器的套件：`engine-test.mjs:100` = `?engine=cm`（已是 cm）；
`cmlab-test.mjs:54` = `cmlab.html`（纯探针页）；`sync-ui-test.mjs:72` = 同步服务页（与编辑内核无关）；
`merge/sync/lan` 不开页面（纯 API）。→ **只有上面 17 个文件需要参数化**。

#### C. 5 个优先文件：哪些断言「块级专用」、哪些「可改 cm 口径」

cm 侧的可用断言面（先记牢，改写时只用这些）：

| 断言面 | 说明 |
|---|---|
| `window.__editor.getContent()` | **权威文本**（cm 的 doc），`app.js:1692` 注入，两内核都有 |
| `window.__editor.view` / `view.state` | 选区（`state.selection.main.head`）、`doc.lineAt`、`doc.lines` |
| `window.__tracery.editor.getContent()` | 同上（`app.js:66`，块级时代就有的老钩子，两内核都在，**polish 的撤销断言可直接复用**） |
| `.cm-line` | 每一行（`.md-blank` 的位置由「**文本为空的行**」取代） |
| `.cm-lp-h1/h2/h3/h4-h6` | 标题行装饰 |
| `.cm-lp-wikilink` / `.cm-lp-tag` | 双链 / 标签（**span，不是 `<a>`，没有 `dataset.target`**，点击走 `widgets.js` 的 `domEventHandlers`） |
| `.cm-lp-cb`（`input.cm-lp-cb`） | 复选框 widget |
| `.cm-lp-img`（+ `.embed-image` / `.embed-file` / `.cm-lp-img-grip`） | 图片 / 附件 widget |
| `.cm-lp-callout` / `.cm-lp-callout-title` / `.cm-lp-callout-body` | Callout |
| `.cm-lp-tr` / `.cm-lp-tr-head` / `.cm-lp-tbl` | 表格**行装饰**（不是 `<table>`/`<td>`） |
| `.cm-lp-note` | `![[笔记]]` 嵌入卡片 |
| `.cm-lineNumbers` / `.cm-gutterElement` | 行号槽（**过滤 CM 那个 `visibility:hidden` 的 `9999` 测量元素**，P0 发现 3） |

**e2e.mjs（15 条）**——块级专用 4 处：

- `#3` 渲染断言：`h1` / `a.wikilink` / `li.task-list-item input[type=checkbox]` / `.callout` / `pre code` / `table`
  → 前 4 个换成 `.cm-lp-h1` / `.cm-lp-wikilink` / `input.cm-lp-cb` / `.cm-lp-callout`；
  **`pre code` 与 `table` 在 cm 下没有对应元素**（代码就是普通行、表格是行装饰），
  这两条改成「`.cm-lp-tr` 行数 ≥ 1」并把 `pre` 断言放宽/去掉。
- `#4` 输入：用 `live.lastElementChild` + DOM Range 落光标 → 改 `page.click('#editor-live .cm-content')` +
  `Ctrl+End` + `typeText`（`engine-test.mjs:147-149` 已是现成写法）。
- `#5` 点双链：`a.wikilink[data-target]` → 按文本找 `.cm-lp-wikilink` 再 click。
- `#11` 未解析双链 `.wikilink.unresolved` → **先确认 cm 侧有无对应的 unresolved 变体 class**
  （`decorations.js` 的 wikilink 装饰）；没有就补上，或本条按引擎门控。
- `#1/#2/#6–#10/#12` 与内核无关，原样保留。

**enter-test.mjs（9 条）**——断言本身是**内容级**的（`readNote()` 读盘比 md），**只有「驱动」要改**：

- 三个 helper `caretAtEndOf('p'|'li')` / `caretAtTextOffset()` 依赖 `#editor-live p/li` + DOM Range
  → cm 下换成「**按 md 偏移放光标**」：`view.dispatch({ selection: EditorSelection.cursor(离线算出的 offset) })`
  或 `Ctrl+End` + 方向键。
- `⑨`「点段落间空白 → 落在空行、输入留在那一行」是**块级专用**（`.md-blank` + 几何点击）
  → cm 下「空行就是一行」，改为点空的 `.cm-line`（或按偏移放光标），落盘断言不变。

**gap-test.mjs（8 条）**——整篇围绕「`.md-blank` 占位段」，cm 下**前提消失**：

- cm 等价物：`.md-blank` → **空的 `.cm-line`**；「点空行布局不跳」→ 可留作「行数/`scrollTop` 稳定」；
  「光标落在空行」→ 读 `state.selection.main.head` 所在 `doc.line` 的文本是否为空。
- 嫌成本高就**门控**：`if (ENGINE === 'block')` 做 ①③⑤⑦，cm 下只跑能成立的子集。

**polish-test.mjs（15 条）**——改动最小：

- ①③④⑤ 撤销/分步/redo 分支走 `window.__tracery.editor.getContent()`，**可直接复用**；
  仅 ② 的 **`Ctrl+Shift+Z` 在 cm 下不触发**（7.8 结论 1）→ 改 `Ctrl+Y`。
- ⑥ 行号：`.live-gutter .ln` → `.cm-lineNumbers .cm-gutterElement`（记得过滤 `9999` 测量元素）；
  「文末空行也编号」在 cm 下天然成立，断言可保留。
- ⑦ 行号开关：`.live-gutter.hidden` → `.cm-lineNumbers` 有无（`engine-test.mjs:190` 现成断言 off=0/on=1）。
- ⑧ 菜单：文件树菜单与本项无关；`textMenu` 段把 `ed.querySelectorAll('p')` 换 `.cm-line`，
  右键目标换 `.cm-content`。

**menu-test.mjs（7 条）**——菜单项本身是本套件主要断言对象（与内核无关），只要**右键目标与选区**改对：

- ① 文本菜单：`rightClickOn('#editor-live p:not(.md-blank)')` → `.cm-line`；「标题 1」「加粗」的执行体是
  editor 方法（`setLinePrefix` / `wrapSelection`），**cm 已实现**。
- ①b 加粗选区：现在用 `#editor-live h1:last-of-type` + DOM Range → 改成按 md 偏移设选区。
- ② 图片菜单：`rightClickOn('#editor-live img')` → `.cm-lp-img img`；「移除图片」走
  `editor.removeImageAt(el)`（`engine.js:261` 有 `closest('.cm-lp-img')`）——但**需先读 `app.js` 的
  contextmenu 分支，确认图片判定能命中 `.cm-lp-img`**（否则要补一个分支）。
- ③④⑤（侧栏折叠 / PDF 浮层 / 文件树菜单）与内核无关。

#### D. 参数化配方（17 个套件统一照抄）

```js
const ENGINE_PARAM = process.env.TRACERY_TEST_ENGINE || 'block';   // 默认仍是 block（= 块级回归网）
const IS_CM = ENGINE_PARAM === 'cm';
await page.goto(`http://localhost:${PORT}/?engine=${ENGINE_PARAM}`, { waitUntil: 'networkidle0' });
```

- 建议新增 `test/_engine-helpers.mjs`，提供 5 个原子操作，避免 5 个套件各写一份：
  `getMd(page)` / `setCaretAtOffset(page, offset)` / `setSelection(page, anchor, head)` /
  `lineText(page, n)` / `clickLine(page, n)`；块级分支用 DOM + Range，cm 分支用 `view.dispatch`。
- **跑法**（两条都要绿才算完成）：
  `npm run test:enter`（默认 block）+ `$env:TRACERY_TEST_ENGINE='cm'; npm run test:enter`（cm）。
- 跑 cm 口径时**注意 git 污染**：`test/screenshots/*.png` 会被重写、`demo-vault` 可能被写坏
  （7.7 结论 6 的块级序列化 bug）——跑完 `git checkout -- <被改的文件>` 复原，别提交。

#### E. 打包发布（沿用 7.8 结论 5，未解决）

`npm run dist:dir` 在本机失败：electron-builder 解压 `winCodeSign` 缓存需要**创建符号链接的权限**
（`Cannot create symbolic link … : 客户端没有所需的特权`）。**既有环境问题，非本次改动引入**。
可按顺序试：① `$env:CSC_IDENTITY_AUTO_DISCOVERY='false'` 后重跑；② 让用户开启 Windows 开发者模式后重跑；
③ 换了能建符号链接的环境再跑 `npm run dist:dir && npm run release`。仍失败就如实记录，别卡住。

#### F. 建议执行顺序

1. **A**：把 cmlab 的 CM 样式搬进 app（新建 `public/css/cm.css` + `index.html` 引一行 + 收敛滚动），
   明暗主题各截一张图验收。
2. 新建 `test/_engine-helpers.mjs`（D 的 5 个原子操作）。
3. 改 **polish → menu → enter → gap → e2e**（由易到难），每改一个就跑**双引擎**两遍。
4. 把剩余 12 个套件按 D 参数化（大多只改 goto 那一行 + 少量选择器）。
5. 全量回归：`test:cmlab` / `test:engine` / `test:e2e` + 其余套件（默认 block 一遍、`TRACERY_TEST_ENGINE=cm` 一遍）。
6. **E**：打包发布（具备权限的环境）。
7. 结论写回本文件（7.10），并按第 8 节收尾。

### 7.10 P5 收尾 · 第一轮（2026-10-18 · **cm 样式补全 + 双内核测试基建 + 3 个真缺陷修复**）

**范围约定**：本轮按 7.9-F 的顺序做，但只做到「样式 + 前 4 个套件」为止（用户到点收工，
其余留到下一轮）。7.9-B 说的 17 个 pin 里，本轮只参数化了 polish/menu/enter/gap 四个，
其余 12 个 + e2e 下一轮继续（见下面「剩余待办」）。

**交付物**

| 文件 | 内容 |
|---|---|
| `public/css/cm.css`（新增） | 从 `cmlab.html` 抽出整套 CM 样式：`.cm-editor/.cm-scroller/.cm-content/.cm-gutters` 基础 + 全套 `.cm-lp-*`（标题/行内/表格/Callout/图片框/复选框/笔记卡片）。**全部改用 app 的 CSS 变量**（`--text-*` / `--accent` / `--link` / `--tag` / `--mark` / `--bg-code` / `--hairline` / `--r-*` / `--font-*`），明暗主题自动跟随 |
| `public/index.html` | `style.css` 之后加一行 `<link rel="stylesheet" href="/css/cm.css">` |
| `test/_engine-helpers.mjs`（新增） | 双内核测试助手：`ENGINE` / `IS_CM` / `engineUrl` + 10 个原子操作（`getMd` / `setCaretAtOffset` / `setSelection` / `lineText` / `clickLine` / `caretAtEndOfText` / `gutterNumbers` / `gutterVisible` …） |
| `test/polish-test.mjs`、`menu-test.mjs`、`enter-test.mjs`、`gap-test.mjs` | 按 7.9-D 参数化（`engineUrl`），块级专用断言按 7.9-C 逐条改写成 cm 口径或门控 |
| `public/js/cm/engine.js` | 右键保选区（缺陷 ①） |
| `public/js/cm/editing.js` | 空列表项/空引用回车退出（缺陷 ②） |
| `test/screenshots/p5-cm-light.png` / `p5-cm-dark.png`（新增） | 7.9-A 的验收截图：同一篇 demo-vault 笔记（Markdown 语法）明/暗各一张 |

**样式（7.9-A）的 3 个技术点**

1. **滚动收敛**：`#editor-live:has(> .cm-editor) { overflow: hidden; padding: 0 }`——cm 模式下外层
   不滚、不 padding，滚动全交 `.cm-scroller`（`:has()` 精确命中，块级内核不受影响）。
   原 `.editor` 的 `padding: 26px 48px 40vh` 挪到 `.cm-content`，`40vh` 仍保留「滚过文末」的手感。
2. **行号槽不能自己加 padding-top**：CM 的 gutter **会跟随** content 的 padding 定位
   （实测：`.cm-content { padding-top: 26px }` 后，第 1 行的 gutter 元素 top 已经等于标题行 top）。
   若再给 `.cm-gutters` 加 `padding-top: 26px`，行号会整体下移 26px（Δ=26 实测抓到的）。
3. **`.cm-widgetBuffer` 会撑高行盒**（见缺陷 ③）。

**实测**：`test:engine` 12/12 全过、无页面错误；`test:polish` / `test:menu` / `test:enter` / `test:gap`
**双引擎各跑一遍全绿**（默认 block + `TRACERY_TEST_ENGINE=cm`）。

**本轮抓到并修掉的 3 个真缺陷（都是 cm 与块级/Obsidian 的行为差）**

1. **右键点在选区内会把 CM 选区收拢成光标**（`cm/engine.js`）：浏览器默认的 `mousedown` 会把
   contenteditable 的插入点挪到点击处，CM 的 observer 随即把 `state` 选区降到点击点 → 右键菜单里
   「加粗/斜体」这类 `wrapSelection` **全部落空**（实测加粗变成在光标处插了一对空 `****`）。
   修法：`contentDOM` 上加 `mousedown`，`button===2` 且 `posAtCoords` 落在当前选区内 → `preventDefault`。
   **注意**：判据要落在**选区内**才拦；点在选区的视觉起点（隐藏标记那一侧）会退回边界外，
   测试里的点击坐标要用 `coordsAtPos` 取（`r.left + 12` 这种估算会命中边界外、拦不住）。
2. **空列表项/空引用回车在 cm 里不退出列表**（`cm/editing.js`）：CM 内置
   `insertNewlineContinueMarkup` 只在「列表首项」或「前一行是空行」时才去标记；像 `- 甲` 下面续出来的
   空 `- ` 项它会**插一条空行把列表变成 loose list**，并不退出。已补与 `editor.js._handleEnter`
   一致的分支：整行就是标记（`^\s*([-*+]|\d+\.)\s*$` / `^\s*>\s*$`）→ 清空该行。
3. **`.cm-widgetBuffer` 撑高行盒**（`cm.css`）：CM 用 `.cm-widgetBuffer`（一个 `height: 1em` 的
   inline `<img>`）标记「被 replace 掉的隐藏区间」的替换位。在 2em 的标题行上，1em=32px 的 img
   把行高从 **57px 撑到 80px** → 光标进出标题时**整篇内容跳一下**（gap 套件 ② 抓到的就是这个）。
   修法：`#editor-live .cm-widgetBuffer { height: 0 }`（这些区间视觉上就是零宽零高）。

**并行记录的一条已知差异（不修，按引擎分别断言）**：块级内核在「续列表项」时会**多留一条文末空行**
（`- 甲\n- 乙\n\n`，cm 是 `- 甲\n- 乙\n`）——按一次回车本该只多一行，块级多出的是序列化副作用。
`test/enter` 第 ④ 条已按引擎分别给期望值。

**剩余待办（下一轮）**

1. **e2e + 其余 12 个套件**按 7.9-D 参数化：`asset / backspace / design-check / draw / features /
   img-probe / layout / roundtrip / tabs / trash / ui-ux / ui-vault`。**注意 7.9-B 的「大多只改 goto」
   偏乐观**：`backspace`（`.live-gutter` + `#editor-source` 的 value）、`features`（`.tok-*` + `pre code` +
   `td`）、`layout`（源码模式的 `#editor-source`）、`ui-vault`（`#editor-live h1/h2/p`）、
   `ui-ux`（`img.md-image`）这几条**硬依赖块级 DOM**，cm 下需要门控或等价改写；
   其余（asset/design-check/draw/roundtrip/tabs/trash）与内核无关，改 goto 即可。
2. e2e 的 4 处（7.9-C 已列）：渲染断言换 `.cm-lp-*`；输入驱动换 `page.click('.cm-content') + Ctrl+End`；
   点双链换 `.cm-lp-wikilink`；#11 未解析双链**cm 侧没有 unresolved 变体类**（`decorations.js` 的
   wikilink 装饰不带解析信息）→ 本轮未动，下一轮二选一：给 cm 补 unresolved 类，或该条按引擎门控。
3. 全量双引擎回归；`npm run dist:dir` + `npm run release`（需符号链接权限，见 7.9-E）。
4. 收尾后按第 8 节更新。

复跑：`npm run test:engine` + `npm run test:polish` / `test:menu` / `test:enter` / `test:gap`
（+ `$env:TRACERY_TEST_ENGINE='cm'` 各一遍）。

### 7.11 P5 收尾 · 第二轮（2026-10-19 · **17 个 pin 全部参数化 + 全量双引擎回归 + 1 个真缺陷**）

**范围约定**：把 7.10 的「剩余待办」1~3 做完（① e2e + 其余 12 个套件参数化；② 块级专用断言的
逐条改写/门控；③ 全量双引擎回归；④ 试打包）。**7.10 说的「大多只改 goto」确实偏乐观**，
实测有 6 个套件带硬依赖块级 DOM 的断言，需要逐条门控或改写（清单见下）。

**交付物**

| 文件 | 内容 |
|---|---|
| `test/*.mjs`（17 个 pin 套件） | 全部按 7.9-D 参数化（`TRACERY_TEST_ENGINE`，**默认仍 block**；cm 用 `$env:TRACERY_TEST_ENGINE='cm'`） |
| `test/e2e.mjs` | 4 处按 7.9-C 改写：渲染断言换 `.cm-lp-*`（**并且按视口分段滚动累加**，理由见结论 1）；输入驱动换「点 `.cm-content` + Ctrl+End」；点双链换按文本找 `.cm-lp-wikilink`；#11 未解析双链**按引擎门控**（cm 无 unresolved 类） |
| `test/ui-ux-test.mjs` | 图片断言按引擎改写：cm 侧验证「**整行嵌入**」的 widget 出图 + 灯箱；夹具加了一条整行 `![[..]]`；行内嵌入 3 条门控（结论 4） |
| `test/features-test.mjs` | ② `.tok-*` 高亮、③ 表格 Tab/回车 **门控**（cm 无 `.tok-*` / `td`） |
| `test/layout-test.mjs` | ② 「源码模式独立行号槽」**门控**（cm 源码模式共用同一视图） |
| `test/backspace-test.mjs` | 行号槽体检/光标偏移/选区/源码模式按引擎分支；undo 步进拉开到 620ms（结论 2）；列表 outdent 按引擎分别断言（结论 3） |
| `test/asset-test.mjs` | 粘贴事件目标改 `.cm-content`；合成粘贴改用**普通 Event + defineProperty**（结论 5） |
| `test/verify-exe.mjs` | 打包版验证脚本：渲染断言改 cm 口径（按「编辑区里有没有 `.cm-editor`」**自动选口径**，cm 侧分段滚动累加） |
| `public/js/app.js` | ① cm 的 `saveAsset` 补「粘贴图片改名」；② 右栏面板扫描前**归一化换行**（CRLF 笔记的大纲/标签，见缺陷 ②） |
| `package.json` | 加 `dist:dir:nosign`（本机无权建符号链接时的打包入口，见「打包结论」） |

**实测**

- **block**：22 个套件全绿（asset / backspace / draw / e2e / enter / features / gap / layout / menu /
  polish / roundtrip / tabs / trash / ui / ux / engine / cmlab / lan / merge / sync / sync-ui + design-check / img-probe）。
- **cm**：16 个套件全绿（asset / backspace / draw / e2e / enter / features / gap / layout / menu /
  polish / roundtrip / tabs / trash / ui / ux / engine；cmlab 是纯探针页、lan/merge/sync/sync-ui 不开编辑页，与内核无关）。
- `npm run dist:dir` **仍失败**（`Cannot create symbolic link ... 客户端没有所需的特权`，electron-builder 解压
  winCodeSign 缓存）——与 7.8 结论 5 完全一致，**既有环境问题**，`CSC_IDENTITY_AUTO_DISCOVERY=false` 也绕不过。
  发布需在管理员/开启开发者模式的环境执行。

**本轮抓到的 2 个真缺陷（产品行为差，已修）**

1. **cm 侧粘贴的图片不做改名**（`public/js/app.js` 的注入式 `saveAsset`）：块级 `editor.js._saveAssetFile`
   会把截图/复制的 `image.png` 换成 `粘贴的图片 <YYYYMMDD-HHMMSS>.png`，cm 侧只把 `file.name` 原样上传 →
   连粘两张截图就是同一个 `image.png`（互相覆盖），而且 asset 套件整片红。
   修法：在 app.js 的 cm `saveAsset` 里复刻同一段改名逻辑（`/^image\.(png|jpe?g|gif|webp)$/i` → 时间戳名）。
2. **CRLF 换行的笔记「大纲」是空的**（`refreshRightPanels`，与内核无关的既有 bug，本轮跑打包版验证时抓到）：
   逐行扫标题用的是 `^(#{1,6})\s+(.*)$`，而 **JS 正则里 `.` 不匹配 `\r`、`$` 也不会落在 `\r` 之前** →
   整篇 CRLF（Windows 上 git 检出的 demo-vault 就是 CRLF）的标题**一条都扫不到**，右栏大纲显示
   「当前笔记没有标题」。修法：扫之前统一 `String(content||'').replace(/\r\n?/g, '\n')`（标签/围栏判断同收益）。
   **教训**：凡是「逐行正则 + `$` 锚点」的扫描都要先归一化换行；这类 bug 只在 Windows 检出/CRLF 笔记上现形，
   Mac/Linux 上跑多少遍都不会红。

**其余 4 条：cm 与块级/CM 原生的既有差异（按引擎分别断言或门控，不修/留待下一轮）**

1. **cm 的装饰是「视口作用域」的**：视口外不建 DOM。所以 e2e 的「标题/双链/任务/Callout/表格」渲染断言
   不能一次数完——改成在 0/0.2/…/1 六个滚动位置**分别计数再累加**（对 `>=` 断言足够）。
   **这是写 cm 断言时要牢记的第一条**：任何「全文找 N 个 X」的断言都得先滚一遍。
2. **cm 的 history 会把相邻操作并成一个撤销组**（`newGroupDelay` 默认 500ms）：backspace 套件原来
   350ms 一步地连按 6 次 Backspace，cm 下 Ctrl+Z 一次退到底；把步进拉到 620ms 后每步独立，与块级口径一致。
   **不是缺陷**（CM 的合并是设计），但写「连续操作 → 分步撤销」的测试时必须留意。
3. **列表内容起点 Backspace 的语义不同**：块级 = 去掉标记、留成同级一行（`乙`）；cm 的
   `deleteMarkupBackward` = 变成上一项的**缩进续行**（`  乙`）。两者都算合理，按引擎分别断言。
4. **cm 的图片嵌入只认「整行 🡒 `![[..]]`」**（`widgets.js` 的 `EMBED_LINE_RE` + `blk.line === blk.endLine`）：
   行内的 `前缀 ![[图片]]` 只渲染成 `.cm-lp-embed` 文字标记、**不出图**；同理 `![](path)` 的 Markdown 图片
   在 cm 实时预览里也不渲染。**这是 cm 相对块级的真实功能缺口，下一轮要补行内 widget**（外加
   「未解析双链没有 unresolved 变体类」这条，一起算 cm 的三处渲染缺口）。

**打包（7.9-E）结论 —— 本机已经能出包了**

- `npm run dist:dir`（标准入口）在本机仍失败：electron-builder 解压 `winCodeSign` 缓存（内含 macOS 的
  `.dylib` 符号链接）需要**创建符号链接的特权**，普通账户报 `Cannot create symbolic link ... 客户端没有所需的特权`；
  `CSC_IDENTITY_AUTO_DISCOVERY=false` 绕不过。**既有环境问题，非本次改动引入。**
- **但本机有一条可用的低权限入口**（新增 `npm run dist:dir:nosign`，等价于
  `electron-builder --dir --config.win.signAndEditExecutable=false`）：跳过「签名 + 改 exe 资源」这一步，
  就不再需要 winCodeSign。代价只有一个：**`Tracery.exe` 文件本身没有自定义图标/版本信息**（资源管理器里是
  Electron 默认图标、右键属性没有版本）；**窗口/任务栏图标不受影响**，因为 `electron/main.cjs` 显式设了
  `icon: build/icon.png`。
- 本轮流程（已实测跑通）：`npm run dist:dir:nosign` → `npm run release`（= `repack` 重打 app.asar + 压 zip）
  → `dist/Tracery-1.1.1-win32-x64.zip`（110.2 MB）→ Gitee → 仓库 → Releases → 基于 tag 上传该 zip。
- **要「完整包」（exe 带图标+版本信息）**：在管理员终端跑 `npm run dist:dir` + `npm run release`，
  或先开 设置 → 隐私和安全性 → 开发者选项 → 开发人员模式（本机现在是关的），再用普通终端跑同样两条。
- **打包版验证**（`test/verify-exe.mjs`，跑法：`$env:PORT='9540'; dist\win-unpacked\Tracery.exe --remote-debugging-port=9223`，
  另开终端 `node test/verify-exe.mjs`）：本轮改成 cm 口径后 **14/14 全过**（含「分段滚动累加的渲染断言」与修好后的
  「大纲面板 12 项」）——即**打包产物本身是好的**。

**剩余待办（下一轮，按优先级）**

1. cm 的行内 `![[图片]]` 渲染成 widget（结论 4）；顺带给 wikilink 补 unresolved 变体类，让 e2e #11 在 cm 侧也能断言。
2. 全量回归里的两个「非断言」项：`design-check` / `img-probe` 是截图/探针脚本，已分别在 block 下跑过；
   若要 cm 版界面存档，用 `$env:TRACERY_TEST_ENGINE='cm'` 重跑 `node test/design-check.mjs`（会覆盖 `design-*.png`）。
3. ~~打包发布（需权限）~~ ✅ **本轮已解决**：用 `npm run dist:dir:nosign` + `npm run release` 出包，
   并用 `test/verify-exe.mjs` 验证 14/14（见「打包结论」）；只剩「想要 exe 带自定义图标/版本信息的完整包」
   才需要管理员终端 / 开发者模式。
4. **注意 git 污染**：跑套件会重写 `test/screenshots/*.png` 与 `demo-vault/Markdown 语法.md`
   （block 运行的序列化 bug，见 7.7 结论 6——本轮实测又复现：`- 嵌入笔记：![[常用代码]]` 被拆成三行）。
   跑完一律 `git checkout -- test/screenshots "demo-vault/Markdown 语法.md"` 复原，别提交。

---

### 7.12 cm 渲染缺口补齐（2026-10-19 · **行内 `![[图]]` 出图 + `![](路径)` 出图 + 双链 unresolved**；连带修 3 个缺陷）

**范围**：7.11「剩余待办 1」列的三处渲染缺口，外加把因此能回收的测试门控拆掉。

**交付物**

| 文件 | 内容 |
|---|---|
| `public/js/cm/widgets.js` | **新增 `InlineImageWidget` + `inlineImageDecos`**：逐源码行扫视口内的 `![[..]]`（图片）与 `![alt](路径)`，产出**行内 replace** widget（出图、`|宽` 生效、右下角拖宽手柄、点图进灯箱）。跳过围栏内行、整行嵌入行、行内代码里的假 token。`setEmbedWidth` 改为**按 token 起点原地改写**；`widgetsPlugin(opts)` 接收注入；块级 `ImageEmbedWidget` 补 `dataset.target`（右键菜单「复制路径」同口径） |
| `public/js/cm/decorations.js` | `livePreviewPlugin` 改为工厂 **`createLivePreview(opts)`**（`isImage` 命中时行内图让位给 widget、`resolveLink` 命中不了补 `cm-lp-unresolved`）；`![[..]]` 行内标记改用 `head/tail`（修老吃字 bug）；导出 `refreshLivePreview` 注解，供「索引变了 → 装饰重建」 |
| `public/js/cm/engine.js` | 用 `createLivePreview` 注入 `isImage` / `resolveLink`；新增 `resolveMdImage(url)`（相对路径走 `resolveFile` + `fileUrl`，外链原样）；`removeImageAt` 改按 `dataset.from` 精确删（行内嵌入不能按名字删第一个）；新增 `refreshDecorations()` |
| `public/js/app.js` | `editor` 改 `let`（辅助函数可安全通知）+ `refreshTree()` / `refreshGraph()` 完成后调 `editor?.refreshDecorations?.()` |
| `public/css/cm.css` | `.cm-lp-img-inline`（inline-block、`max-height: 420px`）、`.cm-lp-wikilink.cm-lp-unresolved`（与块级 `.wikilink.unresolved` 同视觉） |
| `test/ui-ux-test.mjs` | 图片 4 条断言**拆掉门控**（行内裸名 / 带目录 / `\|200` / `![](路径)`），block + cm 同一套断言 |
| `test/e2e.mjs` | #11 未解析双链**拆掉门控**（cm 查 `.cm-lp-wikilink.cm-lp-unresolved`） |

**实测**：`test:ux` block **16/16**、cm **16/16**；`test:e2e` block **15/15**、cm **15/15**；
其余 12 个应用套件（enter/gap/polish/menu/features/layout/backspace/asset/tabs/trash/draw/roundtrip）
block + cm 各一遍全绿；`test:engine` 12/12、`test:cmlab` 8 探针 + IME 全绿、无页面错误。

**6 个关键结论**

1. **行内图必须走行内 replace（ViewPlugin），不能借用块级 StateField 那条路**：块级 replace 的 range 是
   `[line.from, line.to)`（整行），拿去替换行内 token 会把整行包括邻居文字一起吃掉。行内 replace 只改
   行内内容、不改「块级高度语义」，在 ViewPlugin 里下发是合法的（P0 只禁止 ViewPlugin 下发 **block** replace）。
2. **`setEmbedWidth` 原来按「整行 trim 后整段替换」**，行内用会把前后文字一起写掉
   （`前缀 ![[图]] 后缀` → 整行变成 `![[图|400]]`）。改成从 token 起点 `^\s*!\[\[..\]\]` 只替换 token；
   块级调用点的 `dataset.from` 仍是行首，行为不变（`|200` 尺寸断言两个内核都过）。
3. **行内 widget 没有 `estimatedHeight`，图加载完行高会变**（26px → 300px+）→ CM 不会自动重算行号槽，
   截图实证：行号 4~11 全挤在图片中间。修法 `img.onload → view.requestMeasure()`（块级 widget 靠
   `estimatedHeight` 占位，没这个毛病——所以这是**行内特有**的坑）。
4. **装饰的依赖不止 doc / 视口 / 选区**：`unresolved` 类取决于 app 的 `nameIndex`、图片 URL 取决于文件树，
   两者都是 **150ms 防抖异步**到达 → 笔记开得早时装饰按「索引还空着」建好，之后再没人重建（实测
   `nameIndex` 里明明有「图」，`[[图]]` 仍一直是未解析）。配方：`refreshLivePreview` 注解 + 空事务，
   `refreshTree` / `refreshGraph` 完成后 `editor.refreshDecorations()`。同一条也顺手修了
   **刚粘贴的附件不出图**（插入时立刻重建，但那时文件树还没刷新）。
5. **`![[..]]` 的老标记长度写错了**：开闭标记是 `![[`(3) + `]]`(2) 不对称，P1 却给了单一 `marker:4` →
   首尾各多藏一个字，`![[常用代码]]` 只显示中间一个字。改为 `head:3 / tail:2`。这条一直没被发现，
   是因为整行嵌入都被块级 widget 覆盖、行内非图片嵌入平时没人细看。
6. **行内图只扫视口内的行**（`visibleRanges` 覆盖到的源码行，与块级 widget 的 StateField 全文扫描不同），
   所以「全文数图片」的断言依旧要**分段滚动累加**（7.11 结论 1 同样适用）。

**门控清单变化**

- ✅ 已回收：`ui-ux` 的 3 条行内图 + 1 条 md 图；`e2e` #11 未解析双链。
- ⏳ 仍按引擎门控（**与这三处缺口无关**，不是本轮欠账）：`features` ② `.tok-*` 高亮（cm 走 CM 自己的
  syntaxHighlighting，类名是 CM 内部的）、`features` ③ 表格 Tab/换行（cm 表格是行装饰，没有 `td`，
  改键位需要先做「表格单元格编辑」）、`layout` ② 源码模式独立行号槽（cm 源码模式共用同一视图）、
  `backspace` ④ 列表内容起点 Backspace 的 outdent 语义（块级「去标记」vs cm `deleteMarkupBackward`
  「缩进续行」，两边都合理，按引擎分别断言）。

---

### 7.13 cm 表格单元格编辑（2026-10-19 · **网格渲染 + Tab 跳格 + Enter 加行**）

**范围**：7.12「门控清单变化」里剩下最实的一条 —— cm 的表格只有行装饰，Tab 是缩进、回车拆行，
块级内核的 `td/th` 编辑器在 cm 下完全不参与。

**交付物**

| 文件 | 内容 |
|---|---|
| `public/js/cm/widgets.js` | 表格块新增 `tableCellDecos()`：**藏掉每个 `|`** + 给单元格内容挂 `.cm-lp-cell`（`Decoration.mark`，带 `attributes.style.width`）；`tableColWidths()` 按整列最长内容估算列宽；`.cm-lp-img-grip` 那套样式一并恢复 |
| `public/js/cm/editing.js` | `tableTabNext/Prev`（Tab / Shift+Tab 跳格，末行末格 Tab = 加一行）、`tableEnter`（回车加同列数空行，表头/分隔行上回车插在分隔行之后）；判定走 `parseMarkdown` 的 `table` 块，不靠文本猜 |
| `public/js/cm/decorations.js` | 表格分隔行（`| --- |`）从「光标在表格里才露出」改成**永远整行收起** |
| `public/css/cm.css` | 单元格网格样式（`inline-block` + 固定宽 + 右边线/底边线 + 表头底色）；行级类不再画底色/边线（见结论 3） |
| `test/features-test.mjs` | 表格 3 条断言**解除 cm 门控**：网格渲染（管道隐藏）、Tab 跳格、回车加行 |

**实测**：`test:features` block / cm 全绿（cm 新增 3 条）；`test:tabs` block / cm 16/16（新增 4 条）；
其余 13 个应用套件双引擎全绿。

**5 个关键结论**

1. **表格不做成 widget，而是「真实文本行 + 单元格 mark」**：一旦整块 replace 成 `<table>`，
   光标就进不了单元格，还得自己实现「点哪一个格子 → 映射回源码偏移」。现在每行仍是 CM 的真实行，
   点哪写哪、选区/撤销/IME 全部原生，Tab 只是把光标挪到下一个单元格内容起点。
2. **藏 `|` 用 `Decoration.replace({})`（零宽）而不是 widget**：管道不占位，格子之间靠单元格的
   padding + 右边线分隔；分隔行直接整行收起（`fenceHiding`），不再随光标进表格闪出来。
3. **底色/边线必须画在单元格上，不能画在行上**：`.cm-line` 是整宽的，行背景会拖出一条贯穿全文的
   色带、行 `border-bottom` 会拖出一根长横线（改版时踩过，截图很难看）。单元格是 inline-block，
   宽度 = 列宽之和，表格边界自然收口。
4. **列宽要自己算**：文本行没有 `<table>` 的自动列宽，各行内容长短不一时竖线会左右错位。
   按「CJK 15px / 拉丁 8.2px / 其他 6px」逐字累加取整列最大值 +30px padding，写到
   `Decoration.mark({ attributes: { style: width } })` 上；单元格必须 `display:inline-block`
   才吃 width。
5. **Tab/Enter 的判定必须走 AST**：`parseCached(state)` 里找 `table` 块，再判断当前行是表头/分隔行/
   数据行。用文本正则猜的话，代码块和正文里的 `|` 会被误判成表格。
   末行末格 Tab = 加一行（Obsidian 手感），Shift+Tab 在表头第一格退回默认缩进。

**边界（已知）**：表格比正文列宽时，`inline-block` 单元格会整格换行（不是横向滚动）；
需要改对齐方式（`:---:`）时进源码模式。

---

### 7.14 表格渲染对齐 Obsidian（2026-10-19 · 列宽实测 + 不折行 + 横向滚动）

**问题**：用户拿同一份带长数字的 5 列表格对比 Obsidian —— 我们的表格里表头单元格折成两行、
后面几行的列跟着错位，看着像"表格塌了"。

**三个根因与修法**

1. **表头按常规字重量宽**：表头是 `font-weight:600`，比正文宽一截，按常规字重量出来的列宽装不下，
   于是表头折行。→ `textWidthPx(text, bold)`，canvas 用 `600 <font-size> <font-family>` 单独量。
2. **按可用宽度强行压缩**：表格宽过正文列时按比例压缩，压完单元格内部重新折行（更糟）。
   → **不压缩**：宽度只按内容量，超宽时让行自己溢出。
3. **行会换行**：`.cm-content` 是 `line-wrapping`，超宽会把 inline-block 单元格挤到下一视觉行。
   → 表格行与单元格都 `white-space: pre`，超宽交给 `.cm-scroller` 的横向滚动
   （与 Obsidian 行为一致：表格可以比正文宽，横向滚）。

**结果**：同款表格在 cm 下与 Obsidian 逐列对齐，表头单行、空单元格保留边框，宽表横向滚动。

---

### 7.15 双链/标签「鼠标点击」失效的根因（2026-10-19 · 已修）

**现象**：编辑区里用鼠标点 `[[双链]]` 毫无反应；但测试里合成 `span.click()` 却能正常跳转。

**根因（实测取证）**：`.cm-lp-wikilink` / `.cm-lp-tag` 是「光标行不挂牌」的装饰（P1 的验收项 4）。
真实鼠标点击时，浏览器的 `mousedown` 先把光标落到该行 → 本行变「光标行」→ ViewPlugin 因 `selectionSet`
重建装饰 → 该行的 mark/hide 全部撤掉（露出原始 `[[ ]]` 语法），span 从 DOM 里消失；
紧接着派发的 `click` 事件 `closest('.cm-lp-wikilink')` 已经找不到任何东西 → 静默什么都不做。
**只有真实鼠标事件会触发这条链**，所以「合成 click」式的断言永远看不出这个缺陷。

**修法**：`cm/widgets.js` 的 `linkEvents` 增加 `mousedown` 处理——左键落在 wikilink/tag 上时
`preventDefault()` 并 `return true`（顺带阻止 CM 把选区设到点击处）。选区不动 → span 保留 → 随后的 click 正常跳转。

**连带代价**：渲染态的链接上单击不再能放光标（Obsidian 实时预览同样是「点链接 = 跳转」）；
想编辑这一行就把光标移到该行（点行首/行尾一侧，或方向键进去），语法标记会自动露出来。

**回归**：`test/engine-test.mjs` 新增一条**真实鼠标点击**断言（`page.mouse.click` 打 span 的 rect 中心），
今后凡涉及「点击 DOM 装饰」的行为，别只用合成 click 断言。

---

### 7.16 块级内核下线（2026-10-19 · v1.4.0）

7.12~7.14 之后，cm 已经覆盖了块级的全部能力（含表格单元格编辑、图片拖宽、源码行号）。
继续保留块级只剩两个用途：**回退路** 与 **回归网**。但两者都不成立：用户从不切回块级（默认 cm），
而"回归网"也只能证明块级自己没坏，证明不了 cm 没坏。于是整体删除：

| 删除物 | 说明 |
|---|---|
| `public/js/editor.js` | 1310 行，块级 contenteditable 内核 |
| `settings.editorEngine` + 设置里的「编辑内核」行 | 不再有内核选择 |
| `?engine=block` 与 `TRACERY_TEST_ENGINE=block` | 参数仍可传但无效（兼容旧脚本） |
| 各套件的 block 分支 | 保留 `IS_CM = true` 常量，历史分支暂未逐行清理（不影响执行） |

**验证**：15 个套件在单内核下全绿（e2e 15、ux 16、layout/polish/gap/menu/features/asset/trash/roundtrip/enter/ui-vault 全 PASS、
tabs 16、draw 37、sync 27、sync-enc 20）。回退方式：`git checkout v1.3.0`。

---

### 7.16 第三种模式「阅读」与模式切换的契约变化（2026-10-19 · 已实现）

块级内核下线后，编辑器模式从「两态」（实时预览 / 源码）扩成**三态循环**：实时预览 → 源码 → **阅读** → 实时预览。

**实现取舍：不另写一套渲染**。阅读模式 = 同一个 `createLivePreview` / `createFenceHiding` / `widgetExtensions`
传 `readOnly: true`，**它只做一件事：把「光标行」集合换成空集** —— 于是所有标记一律隐藏、widget 一律显示，
正好等于「剥离源码后的成品」；再叠加 `EditorView.editable.of(false)` + `EditorState.readOnly.of(true)`
（`contenteditable=false` → 键鼠都进不来）+ 不装行号 + 不装附件拦截。
好处是三条渲染规则只有一份实现，不存在「实时预览和阅读视图渲染不一致」这种经典分叉。

**四个容易漏的点**（都已在代码里堵住，见 HANDOFF §5-61）：
① 引擎里**所有 mutation 方法**都要 `isRead` 提前返回（键盘进不来不等于改不了：右键菜单 / 命令面板 /
   绘图「插入笔记」都在暗中调它们）；② 阅读模式要**隐藏图片拖宽手柄**（否则会出现「拖了没反应」）；
③ 换笔记要**保留模式**（`loadTab` 的 `keepMode`）；④ 右键菜单「改内容」的项要置灰而不是静默失败。

**契约变化（写用例时必须知道）**：`Ctrl+E` / `#btn-mode` 不再是「按两次回原位」——
按两次会停在**阅读模式**。旧用例里凡是数按键次数的都要改成显式 `setMode('source' | 'live' | 'read')`。
2026-10-19 实测：`backspace-test` 因为这两下 Ctrl+E，一次性挂了 19 条（症状是「打字进不去 + 行号槽为空」，
很容易误判成编辑器坏了——排查过程与结论记在 HANDOFF §6）。

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
4. **P5 收尾（已完成）—— 工单见 7.9，结论见 7.10 / 7.11**：
   ✅ ① **样式已补**（7.9-A）：`public/css/cm.css` + `index.html` 引入 + 滚动收敛，
   明暗验收截图 `test/screenshots/p5-cm-{light,dark}.png`（结论见 7.10）；
   ✅ ② `test/_engine-helpers.mjs` 落地；**17 个 pin 套件全部参数化，双引擎各跑一遍全绿**
   （block 22 个套件 / cm 16 个套件，见 7.11「实测」）；
   ✅ ③ **cm 的 3 处渲染缺口已补齐**（7.12）：行内 `![[图片]]` 与 `![](路径)` 出图、双链 unresolved 类，
   对应测试门控已拆（ui-ux 4 条 + e2e #11）。**打包已解决**（`npm run dist:dir:nosign` + `npm run release`，
   打包版验证 14/14，见 7.11）。**跑套件后记得复原 `test/screenshots/*.png` 与 `demo-vault/Markdown 语法.md`**（7.11 结论 4）
5. 发布后保留 `settings.editorEngine` 一键回退；后续可选方向：
   ① 发版（渲染修复值得一个 1.2.1，流程见 7.11「打包结论」+ `docs/RELEASE-1.1.1.md` 格式）；
   ② **cm 表格单元格编辑**（现在是行装饰 + 源码编辑，做完能回收 features ③ 的门控）；
   ③ 源码模式的 `.tok-*` 等价断言（回收 features ②）；
   ④ 块级内核遗留（块级嵌入露源码、Callout 正文行内偏移、块级序列化 bug）——只在维护回退路时才值得动

### 给用户的开场提示词（可直接粘贴）

```
读 docs/HANDOFF.md（当前状态 / 已知坑 / 下一步优先级），再看 docs/EDITOR-MIGRATION.md 的 7.11、7.12
（CM6 迁移收尾三轮的结论）。迁移主体 + cm 渲染缺口都已收口，不用重新调研。

现状（v1.2.0 已发布；本地代码 = v1.2.0 + 渲染缺口修复，未发版）：
- 默认编辑内核 = cm（CodeMirror 6）：设置 → 编辑器 可一键回退块级，`?engine=block|cm` 可按页覆盖；
  旧块级内核不删（回归网 + 回退路）。
- cm 实时预览现在与块级对齐：**行内 `![[图片]]`、`![](路径)` 都出图**（带 `|宽` 与拖宽手柄），
  未解析双链有 `.cm-lp-unresolved`。装饰在「笔记索引/文件树」刷新后会显式重建（`refreshDecorations`）。
- 测试：17 个套件已参数化为 TRACERY_TEST_ENGINE（默认 block），block / cm 各跑一遍全绿；
  test:engine（12 条）与 test:cmlab（8 探针）只跑 cm。
- 打包：`npm run dist:dir:nosign` + `npm run release`；打包版验证 `node test/verify-exe.mjs` 应 14/14。

本轮目标（按优先级，先做 1）：
1. 发版 v1.2.1：渲染缺口修复是用户可见变化——`package.json` bump 到 1.2.1，
   照 docs/RELEASE-1.1.1.md 的格式写 docs/RELEASE-1.2.1.md，`npm run dist:dir:nosign` + `npm run release`，
   跑 `node test/verify-exe.mjs` 确认 14/14，zip 传 Gitee Releases。
2. **cm 表格单元格编辑**：现在表格只有行装饰（`.cm-lp-tr`），Tab 跳格/回车加行仍是块级专用
   （features ③ 门控）。做完可以把 features 里 table 那条门控拆掉。
3. 顺带核一遍 7.12「门控清单变化」里仍未回收的 3 条（features ②、layout ②、backspace ④），
   能等价改写就改，纯语义差异就保留并写明理由。

硬约束：
- **不要改 public/js/editor.js**（旧块级内核只读：它是回归网，也是用户回退路）；
- 跑完套件记得 `git checkout -- test/screenshots "demo-vault/Markdown 语法.md"` 复原污染，别提交；
- 提交信息用中文；UI 文案与代码注释也是中文。

硬约束：
- **不要改 public/js/editor.js**（旧块级内核只读：它是回归网，也是用户回退路）；
- 跑完套件记得 `git checkout -- test/screenshots "demo-vault/Markdown 语法.md"` 复原污染，别提交；
- 提交信息用中文；UI 文案与代码注释也是中文。
```
