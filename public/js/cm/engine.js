/**
 * public/js/cm/engine.js — CM6 版编辑器引擎（P4 适配器）
 * ------------------------------------------------------------------
 * 本文件是**独立适配器**：不 import `api.js` / `settings.js`，
 * 所有业务依赖（附件落盘、图片 URL、笔记嵌入解析、链接跳转）都由构造参数注入——
 * 这样它可以在 cmlab 探针页里端到端验证。
 *
 * DOM 契约（见 docs/EDITOR-MIGRATION.md 第 5 节）：
 *   - `#editor-live` 作为 CM 挂载点；三种模式共用**同一份 doc，只切换扩展集**
 *     （live 挂装饰 / source 不挂 / read 全量渲染 + 只读），行号走 compartment。
 *   - 撤销/重做交给 CM `history()`（带选区/滚动还原），不自建快照栈。
 *   - `dirty` 是字段（app.js 直接读 `editor.dirty`），语义不变。
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
import { isAttachmentTarget } from '../wiki-path.js';
import { wikiCompletion } from './wiki-completion.js';
import { noteAnchors } from '../note-embed.js';
import { mathPreview } from './math.js';

/** 极简防抖（与 api.js 同语义，避免引擎依赖 api） */
function debounce(fn, ms) {
  let t = null;
  const run = () => { clearTimeout(t); t = setTimeout(fn, ms); };
  run.cancel = () => { clearTimeout(t); t = null; };
  return run;
}

const LINE_MARKUP_RE = /^(\s*)(#{1,6}\s+|[-*+]\s+(?:\[[ x]\]\s+)?|>\s?|\d+\.\s+)/;

export class CmEditor {
  /**
   * @param opts CM 需要的注入点：
   *   liveEl（CM 挂载点）,
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

    this.path = null;
    this.mode = 'live';            // live | source | read（同一份 doc，切扩展集）
    this.md = '';                  // 与 view.state.doc 同步的权威文本
    this._generation = 0;
    this.revision = undefined;
    this.vaultRoot = undefined;
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

    // 右键落在「已有选区」内时保住选区：
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
      EditorState.transactionFilter.of(tr => this.accessReadOnly && tr.docChanged ? [] : tr),
      this.editableComp.of(read ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
      this.lineNumComp.of(!read && this.showLineNumbers ? lineNumbers() : []),
      history(),
      Prec.high(keymap.of(editingKeymap)),
      ...wikiCompletion(this.opts.completeWiki),
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
      mathPreview({ readOnly }),
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
        fileUrl: this.opts.fileUrl,
        resolveFile: this.opts.resolveFile,
        resolveLink: this.opts.resolveLink,
        openLink: this.opts.openEmbedLink,
        openNote: this.opts.openEmbedNote,
        onImageClick: this.opts.onImageClick,
        onFileClick: this.opts.onFileClick,
        onRelinkAttachment: this.accessReadOnly ? null : this.opts.onRelinkAttachment,
        // 双链点击：解析得到就跳过去；解析不到（这篇笔记还不存在）→ 交给 onCreateWikilink
        // 走「问一句就当场创建」那条路（demo-vault/双链与反链.md 承诺的行为，反链面板同口径）。
        onOpenWikilink: (target) => {
          if (isAttachmentTarget(target)) { this.opts.onFileClick?.(target); return; }
          const resolved = this.opts.resolveLink?.(target) || null;
          if (resolved) this.opts.onNavigate?.(resolved, target.includes('#') ? target.split('|')[0].split('#').slice(1).join('#') : undefined);
          else this.opts.onCreateWikilink?.(target);
        },
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
    if (!this._loading && (u.selectionSet || u.docChanged)) this.opts.onSelectionChange?.(u.state.doc.lineAt(u.state.selection.main.head).number);
    if (this._loading || !u.docChanged) return;
    this.md = u.state.doc.toString();
    this.dirty = true;
    this.opts.onDirtyChange?.(true);
    this.opts.onChange?.(this.md);
    this.autosave();
  }

  /* ---------- 附件拦截回调（P2 domEventHandlers 递出来的 File） ---------- */
  async _onAssetFile(file) {
    const generation = this._generation;
    try {
      const res = this.opts.saveAsset ? await this.opts.saveAsset(file, { path: this.path, vaultRoot: this.vaultRoot }) : null;
      if (res?.ok && res.path) {
        if (generation !== this._generation) { this.opts.onAssetSaved?.(res.path); this.opts.onAssetDeferred?.(res.path); return; }
        this.insertSnippet(`![[${res.path}]]`);
        this.opts.onAssetSaved?.(res.path);
      } else {
        this.opts.onAssetUnhandled?.(file);
      }
    } catch (e) {
      this.opts.onAssetUnhandled?.(file, e);
    }
  }

  /* ---------- 对外方法（app.js 与测试都按这套调用） ---------- */

  setAutosave(ms) {
    this.autosave.cancel();
    this.autosaveMs = Math.max(0, Number(ms) || 0);
    this.autosave = debounce(() => this._doSave(), this.autosaveMs);
    if (this.dirty) this.autosave();
  }

  load(path, content, { keepMode = false, revision, vaultRoot, discardChanges = false } = {}) {
    if (!discardChanges && path === this.path && content === this.md && vaultRoot === this.vaultRoot) { this.revision = revision; return; }
    if (!discardChanges) this._flushSave();
    this.autosave.cancel();
    this._generation++;
    this.revision = revision;
    this.vaultRoot = vaultRoot;
    this._loading = true;
    this.path = path;
    this.md = content;
    this.dirty = false;
    if (!keepMode) this.mode = this.accessReadOnly ? 'read' : 'live';
    // 换文件 = 全新 state（撤销栈按笔记隔离）
    this.view.setState(EditorState.create({ doc: content, extensions: this._extensions() }));
    this._loading = false;
    this.opts.onDirtyChange?.(false);
    this.opts.onChange?.(this.md);
  }

  getContent() { return this.md; }

  async _doSave() {
    if (this._saving) {
      const ok = await this._saving;
      return ok && this.dirty ? this._doSave() : ok;
    }
    if (!this.path || !this.dirty) return true;
    const path = this.path, content = this.md;
    const generation = this._generation;
    const context = { expectedRevision: this.revision, vaultRoot: this.vaultRoot };
    this.opts.onSaveState?.('saving');
    // 只有服务端确认后才能清掉 dirty；保存期间又输入的文字属于下一次保存。
    this._saving = Promise.resolve().then(() => this.opts.onSave?.(path, content, context)).then((result) => {
      const ok = result !== false;
      if (generation === this._generation && ok && result?.revision !== undefined) this.revision = result.revision;
      if (ok && generation === this._generation && this.path === path && this.md === content) {
        this.dirty = false;
        this.opts.onDirtyChange?.(false);
      }
      if (generation === this._generation) this.opts.onSaveState?.(ok ? (this.dirty ? 'dirty' : 'saved') : 'error');
      return ok;
    }).catch(() => { if (generation === this._generation) this.opts.onSaveState?.('error'); return false; }).finally(() => { this._saving = null; });
    return this._saving;
  }

  _flushSave() { if (this.dirty) this._doSave(); }

  async flush() {
    if (this.view.composing) return false;
    return await this._doSave();
  }

  /* ---------- 模式 ---------- */
  get isRead() { return this.mode === 'read'; }

  setMode(mode) {
    if (this.accessReadOnly) mode = 'read';
    if (mode !== 'live' && mode !== 'source' && mode !== 'read') return;
    if (mode === this.mode) return;
    this._flushSave();
    this.mode = mode;
    const read = mode === 'read';
    // 三种模式 = 同一份 doc 换扩展集：
    //   live/source：装饰开/关；read：装饰换「全量渲染」那套 + 只读 + 收行号
    this.view.dispatch({
      effects: [
        this.decoComp.reconfigure(this._decoExtensions()),
        this.editableComp.reconfigure(read ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
        this.lineNumComp.reconfigure(!read && this.showLineNumbers ? lineNumbers() : []),
      ],
    });
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
  /** 在光标处插入一段 Markdown（绘图、模板等用）：首尾补空行 */
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
  scrollToLine(number) {
    const line = this.view.state.doc.line(Math.max(1, Math.min(number, this.view.state.doc.lines)));
    this.view.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
    this.view.focus();
  }
  scrollToHeading(headingText) {
    const text = (headingText || '').trim();
    if (!text) return;
    const doc = this.view.state.doc;
    if (text.startsWith('^')) {
      const block = noteAnchors(doc.toString()).find(item => item.anchor === text);
      if (block) this.scrollToLine(block.line + 1);
      return;
    }
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

export default CmEditor;
