/**
 * public/js/cm/engine.js — CM6 版编辑器引擎（P4 适配器）
 * ------------------------------------------------------------------
 * 目标（EDITOR-MIGRATION.md 第 5 节契约）：**保留 `LiveEditor` 的名字/构造参数/全部方法**，
 * 内部实现从「块级 contenteditable 整篇重建」换成「CM6 行级 + 装饰」。
 * 本文件是**独立适配器**：不 import `editor.js` / `api.js` / `settings.js`，
 * 所有业务依赖（附件落盘、图片 URL、笔记嵌入解析、链接跳转）都由构造参数注入——
 * 这样它可以在 cmlab 探针页里端到端验证，且**接线时 `editor.js` 只需换实现、app.js 不用改逻辑**。
 *
 * 与块级模型的差异（P4 接线时要留意的 DOM 契约，见文档 5.3）：
 *   - `#editor-live` 只作为 CM 挂载点；源码模式不再有独立 textarea，而是**同一份 doc 切换扩展集**
 *     （关掉实时预览装饰 = 源码视图），行号走 compartment。
 *   - 撤销/重做交给 CM `history()`（带选区/滚动还原），不再自建快照栈。
 *   - `dirty` 仍是字段（app.js 直接读 `editor.dirty`），语义不变。
 *
 * P0–P3 的模块在这里装配：`cm/decorations.js`（P1 装饰）+ `cm/editing.js`（P2 keymap/粘贴拦截）
 * + `cm/widgets.js`（P3 块级 widget + 笔记嵌入卡片）。
 */
import { Compartment, EditorState, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { history, undo, redo, undoDepth, redoDepth, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { createLivePreview, createFenceHiding, refreshLivePreview } from './decorations.js';
import { editingExtensions, editingKeymap } from './editing.js';
import { widgetExtensions, setEmbedWidth } from './widgets.js';

/** 极简防抖（与 api.js 同语义，避免引擎依赖 api） */
function debounce(fn, ms) {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

const LINE_MARKUP_RE = /^(\s*)(#{1,6}\s+|[-*+]\s+(?:\[[ x]\]\s+)?|>\s?|\d+\.\s+)/;

export class CmEditor {
  /**
   * @param opts 与 LiveEditor 一致，另加 CM 需要的注入点：
   *   liveEl（CM 挂载点）, [sourceEl/gutterEl/sourceWrap 仅保留字段],
   *   resolveLink(t), resolveFile(name), fileUrl(path),
   *   loadNote(name)->md|Promise,        // ![[笔记]] 嵌入解析
   *   saveAsset(file)->{ok,path},        // 附件落盘（缺省则只回调 onAssetUnhandled）
   *   onImageClick(src,alt), onAssetSaved(path), onAssetUnhandled(file),
   *   onNavigate(path), onPreviewWikilink(target,el), onTagClick(tag),
   *   onSave(path,content), onChange(content), onDirtyChange(bool), onModeChange(mode)
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.liveEl = opts.liveEl;
    this.sourceEl = opts.sourceEl || null;
    this.gutterEl = opts.gutterEl || null;
    this.sourceWrap = opts.sourceWrap || null;

    this.path = null;
    this.mode = 'live';            // live | source | read（同一份 doc，切扩展集）
    this.md = '';                  // 与 view.state.doc 同步的权威文本
    this.dirty = false;
    this.showLineNumbers = true;
    this.autosaveMs = 900;
    this.autosave = debounce(() => this._doSave(), this.autosaveMs);

    this._loading = false;         // setState 期间抑制 updateListener 的副作用
    this._liveExt = null;          // 实时预览扩展集（缓存，reconfigure 复用）
    this._readExt = null;          // 阅读模式扩展集（同上）
    this.decoComp = new Compartment();     // 实时预览/阅读装饰（源码模式关掉）
    this.lineNumComp = new Compartment();  // 行号开关（阅读模式强制关）
    this.editableComp = new Compartment(); // 只读开关（阅读模式 EditorView.editable=false）

    this.view = new EditorView({
      parent: this.liveEl,
      state: EditorState.create({ doc: '', extensions: this._extensions() }),
    });

    // 右键落在「已有选区」内时保住选区（块级内核同款诉求）：
    // 浏览器默认的 mousedown 会把 contenteditable 的插入点挪到点击处，CM 的 observer
    // 随即把 state 选区收拢成光标 → 右键菜单里的「加粗/斜体」等 wrapSelection 全部落空。
    // 这里在右键且点中选区内时阻止默认，让 CM 的选区原样留给菜单动作。
    this.view.contentDOM.addEventListener('mousedown', (e) => {
      if (e.button !== 2) return;
      const sel = this.view.state.selection.main;
      if (sel.empty) return;
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null && pos >= sel.from && pos <= sel.to) e.preventDefault();
    });
  }

  /* ---------- 扩展装配 ---------- */
  _extensions() {
    // 阅读模式的两条硬约束：① 不可编辑（没有光标）② 不显示行号（Obsidian 阅读视图也没有）
    const read = this.mode === 'read';
    return [
      this.editableComp.of(read ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
      this.lineNumComp.of(!read && this.showLineNumbers ? lineNumbers() : []),
      history(),
      Prec.high(keymap.of(editingKeymap)),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      markdown({ base: markdownLanguage, addKeymap: false }),
      syntaxHighlighting(defaultHighlightStyle),
      this.decoComp.of(this._decoExtensions()),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => this._onUpdate(u)),
    ];
  }

  /** 装饰集按模式取：live = 实时预览；read = 全量渲染（无光标行概念）；source = 不挂装饰 */
  _decoExtensions() {
    if (this.mode === 'read') return this._readExtensions();
    return this.mode === 'live' ? this._liveExtensions() : [];
  }

  /** 实时预览 / 阅读共用的装饰装配（差别只在 readOnly 一个开关，见 decorations.js 的注释） */
  _previewExtensions(readOnly) {
    return [
      // 装饰层需要两个业务判定：图片嵌入让位给行内 widget、双链补 unresolved 类
      createLivePreview({
        isImage: this.opts.isImage,
        resolveLink: (target) => this.opts.resolveLink?.(target) || null,
        readOnly,
      }),
      createFenceHiding({ readOnly }),
      ...widgetExtensions({
        resolveImage: (name) => {
          const p = this.opts.resolveFile?.(name);
          return p ? (this.opts.fileUrl?.(p) ?? p) : null;
        },
        // `![](路径)`：相对路径先按仓库文件解析，再由 fileUrl 编码成 /api/file?path=…；
        // 外链/data/blob 原样用（与 markdown.js inlineToHtml 的判定顺序一致）
        resolveMdImage: (url, plain) => {
          if (/^(https?:|data:|blob:)/i.test(url)) return url;
          const p = this.opts.resolveFile?.(plain) || plain;
          return this.opts.fileUrl?.(p) ?? p ?? null;
        },
        isImage: this.opts.isImage,
        isAsset: this.opts.isAsset,
        loadNote: this.opts.loadNote,
        onImageClick: this.opts.onImageClick,
        onOpenWikilink: (target) => this.opts.onNavigate?.(this.opts.resolveLink?.(target) || target),
        onHoverWikilink: (target, el) => this.opts.onPreviewWikilink?.(target, el),
        onTagClick: (tag) => this.opts.onTagClick?.(tag),
        readOnly,
      }),
      // 阅读模式不装附件拦截：既然不可编辑，粘贴/拖入文件也不该往正文里插东西
      ...(readOnly ? [] : editingExtensions({ onAssetFile: (file) => this._onAssetFile(file) })),
    ];
  }

  _liveExtensions() {
    if (this._liveExt) return this._liveExt;
    this._liveExt = this._previewExtensions(false);
    return this._liveExt;
  }

  _readExtensions() {
    if (this._readExt) return this._readExt;
    this._readExt = this._previewExtensions(true);
    return this._readExt;
  }

  _onUpdate(u) {
    if (this._loading || !u.docChanged) return;
    this.md = u.state.doc.toString();
    this.dirty = true;
    this.opts.onDirtyChange?.(true);
    this.opts.onChange?.(this.md);
    this.autosave();
  }

  /* ---------- 附件拦截回调（P2 domEventHandlers 递出来的 File） ---------- */
  async _onAssetFile(file) {
    try {
      const res = this.opts.saveAsset ? await this.opts.saveAsset(file) : null;
      if (res?.ok && res.path) {
        this.insertSnippet(`![[${res.path}]]`);
        this.opts.onAssetSaved?.(res.path);
      } else {
        this.opts.onAssetUnhandled?.(file);
      }
    } catch (e) {
      this.opts.onAssetUnhandled?.(file, e);
    }
  }

  /* ---------- 契约方法（与 LiveEditor 5.2 一一对应） ---------- */

  setAutosave(ms) {
    this.autosaveMs = Math.max(0, Number(ms) || 0);
    this.autosave = debounce(() => this._doSave(), this.autosaveMs);
  }

  load(path, content, { keepMode = false } = {}) {
    if (path === this.path && content === this.md) return;
    this._flushSave();
    this._loading = true;
    this.path = path;
    this.md = content;
    this.dirty = false;
    if (!keepMode) this.mode = 'live';
    // 换文件 = 全新 state（撤销栈按笔记隔离，与 LiveEditor 一致）
    this.view.setState(EditorState.create({ doc: content, extensions: this._extensions() }));
    this._loading = false;
    this.opts.onDirtyChange?.(false);
    this.opts.onChange?.(this.md);
  }

  getContent() { return this.md; }

  _doSave() {
    if (!this.path || !this.dirty) return;
    this.opts.onSave?.(this.path, this.md);
    this.dirty = false;
    this.opts.onDirtyChange?.(false);
  }

  _flushSave() { if (this.dirty) this._doSave(); }

  async flush() { this._flushSave(); await new Promise((r) => setTimeout(r, 40)); }

  /* ---------- 模式 ---------- */
  get isRead() { return this.mode === 'read'; }

  setMode(mode) {
    if (mode !== 'live' && mode !== 'source' && mode !== 'read') return;
    if (mode === this.mode) return;
    this._flushSave();
    this.mode = mode;
    const read = mode === 'read';
    // 三种模式 = 同一份 doc 换扩展集（不再有独立 textarea）：
    //   live/source：装饰开/关；read：装饰换「全量渲染」那套 + 只读 + 收行号
    this.view.dispatch({
      effects: [
        this.decoComp.reconfigure(this._decoExtensions()),
        this.editableComp.reconfigure(read ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
        this.lineNumComp.reconfigure(!read && this.showLineNumbers ? lineNumbers() : []),
      ],
    });
    if (this.sourceWrap) this.sourceWrap.hidden = true;   // 不再使用独立 textarea
    this.opts.onModeChange?.(mode);
  }

  /** 三态循环：实时预览 → 源码 → 阅读 → 实时预览（按钮与 Ctrl+E 都走这里） */
  toggleMode() {
    const order = ['live', 'source', 'read'];
    this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
  }

  focus() { this.view.focus(); }

  /** 业务索引（笔记名 / 文件树）刷新后调用：装饰的重建条件里没有「索引版本」，
   *  这里 dispatch 一个只带注解的空事务，让 livePreviewPlugin / widgetsPlugin 重扫一遍。 */
  refreshDecorations() {
    try { this.view.dispatch({ annotations: refreshLivePreview.of(true) }); } catch { /* view 已销毁 */ }
  }

  setLineNumbers(on) {
    this.showLineNumbers = !!on;
    // compartment.reconfigure 返回 effect，必须 dispatch 才生效（P0 结论 4）
    this.view.dispatch({ effects: this.lineNumComp.reconfigure(this.showLineNumbers ? lineNumbers() : []) });
  }

  /* ---------- 编辑动作 ----------
   * 阅读模式没有任何编辑入口：这里的 mutation 方法统一提前返回。
   * 为什么还要兜一层：编辑器不可编辑（无焦点）时键盘进不来，但右键菜单 / 命令面板 /
   * 绘图的「插入笔记」仍会调用这些方法——漏一个就会在阅读模式下偷偷改掉笔记。 */
  /** 在光标处插入一段 Markdown（绘图、模板等用）：首尾补空行，与 LiveEditor 同口径 */
  insertSnippet(text) {
    if (this.isRead) return;
    const view = this.view;
    const pos = view.state.selection.main.head;
    const prev = pos > 0 ? view.state.doc.sliceString(pos - 1, pos) : '';
    const lead = pos === 0 ? '' : (prev === '\n' ? '\n' : '\n\n');
    const insert = lead + text + '\n';
    view.dispatch({ changes: { from: pos, insert }, selection: EditorSelection.cursor(pos + insert.length), userEvent: 'input' });
  }

  /** 在光标处插入纯文本（替换选区） */
  insertText(text) {
    if (this.isRead) return;
    const r = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from: r.from, to: r.to, insert: text },
      selection: EditorSelection.cursor(r.from + text.length),
      userEvent: 'input',
    });
  }

  /** 用标记包裹选区（无选区时插入成对标记，光标居中） */
  wrapSelection(open, close) {
    if (this.isRead) return;
    const view = this.view;
    const r = view.state.selection.main;
    const text = view.state.sliceDoc(r.from, r.to);
    if (!text) {
      view.dispatch({
        changes: { from: r.from, insert: open + close },
        selection: EditorSelection.cursor(r.from + open.length),
        userEvent: 'input',
      });
      return;
    }
    view.dispatch({
      changes: { from: r.from, to: r.to, insert: open + text + close },
      selection: EditorSelection.range(r.from + open.length, r.from + open.length + text.length),
      userEvent: 'input',
    });
  }

  /** 当前行替换成指定前缀（'## ' / '- ' / '> ' / '' = 正文），保留缩进 */
  setLinePrefix(prefix) {
    if (this.isRead) return;
    const view = this.view;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const indent = (/^\s*/.exec(line.text))[0];
    const next = indent + prefix + line.text.replace(LINE_MARKUP_RE, '$1').slice(indent.length);
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: next },
      selection: EditorSelection.cursor(line.from + next.length),
      userEvent: 'input',
    });
  }

  selectAll() {
    const view = this.view;
    view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });
    view.focus();
  }

  /* ---------- 图片 ---------- */
  setImageWidth(fig, width) {
    if (this.isRead) return false;
    const pos = Number(fig?.dataset?.from);
    if (!Number.isFinite(pos)) return false;
    return setEmbedWidth(this.view, pos, width);
  }

  /** 从正文里移除某张图片/附件的嵌入标记（右键菜单「移除图片」）
   *  优先按 widget 记的 `data-from` 精确删（行内嵌入前后还有文字，不能按名字删第一个）；
   *  老路径（块级遗留的 .embed-image / 没有 from）退回「按名字找第一个 ![[..]]」。 */
  removeImageAt(el) {
    if (this.isRead) return false;
    const fig = el?.closest?.('.cm-lp-img') || el?.closest?.('.embed-image');
    if (!fig) return false;
    const pos = Number(fig.dataset?.from);
    if (Number.isFinite(pos)) {
      const doc = this.view.state.doc;
      const line = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
      const m = /^\s*(?:!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\))/.exec(doc.sliceString(pos, line.to));
      if (m) {
        const lead = m[0].length - m[0].trimStart().length;
        const from = pos + lead;
        // 连同后面的空格一起收掉，避免留下「文字  文字」双空格
        const after = doc.sliceString(from + m[0].length - lead, from + m[0].length - lead + 1);
        const to = from + m[0].length - lead + (after === ' ' ? 1 : 0);
        this.view.dispatch({ changes: { from, to }, userEvent: 'delete' });
        return true;
      }
    }
    const name = fig.dataset?.name;
    if (!name) return false;
    const doc = this.view.state.doc.toString();
    const re = /!\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = re.exec(doc))) {
      const nm = m[1].split('|')[0].replace(/#.*$/, '').trim();
      if (nm === name) {
        this.view.dispatch({ changes: { from: m.index, to: m.index + m[0].length }, userEvent: 'delete' });
        return true;
      }
    }
    return false;
  }

  /* ---------- 撤销/重做 -------- */
  canUndo() { return undoDepth(this.view.state) > 0; }
  canRedo() { return redoDepth(this.view.state) > 0; }
  undo() { if (this.isRead) return; undo(this.view); }
  redo() { if (this.isRead) return; redo(this.view); }

  /* ---------- 导航 ---------- */
  scrollToHeading(headingText) {
    const text = (headingText || '').trim();
    if (!text) return;
    const doc = this.view.state.doc;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      const m = /^#{1,6}\s+(.*)$/.exec(line.text);
      if (m && m[1].includes(text)) {
        this.view.dispatch({
          selection: EditorSelection.cursor(line.from),
          effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
        });
        return;
      }
    }
  }
}

/** 默认导出：类名不同，但方法契约与 LiveEditor 一致，接线时按需改名/包装 */
export default CmEditor;
