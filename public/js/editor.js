/**
 * Tracery 实时预览编辑器（仿 Obsidian Live Preview）
 *  - contenteditable WYSIWYG：Markdown 语法边打边渲染
 *  - 输入防抖 → DOM 序列化回 Markdown → 重渲染 → 按字符偏移恢复光标
 *  - Enter 智能续行 / Tab 缩进 / Ctrl+B/I/S 包裹 / 复选框点击 / 双链点击与悬浮预览 / ![[嵌入]]
 */
import { renderMarkdown, serializeHtml, domPointToMd, mdOffsetToDom, inlineToHtml, escapeHtml } from './markdown.js';
import { Api, toast, debounce } from './api.js';
import { getSettings, resolveAssetDir } from './settings.js';

const escHtml = (s) => escapeHtml(s).replace(/'/g, '&#39;');

/** 附件体积上限（与服务端 30MB 限制一致，先挡一道省得白传） */
const MAX_ASSET = 30 * 1024 * 1024;
const ASSET_EXT = /\.(png|jpe?g|webp|gif|pdf)$/i;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

export class LiveEditor {
  /**
   * @param opts {
   *   liveEl, sourceEl,      // contenteditable 容器 / 源码 textarea
   *   resolveLink(target)->path|null,
   *   onNavigate(path),
   *   onSave(path, content),
   *   onChange(content),     // 大纲/字数统计等
   *   onDirtyChange(bool),
   *   onModeChange(mode),
   * }
   */
  constructor(opts) {
    this.liveEl = opts.liveEl;
    this.sourceEl = opts.sourceEl;
    this.gutterEl = opts.gutterEl || null;   // 源码模式行号槽（实时模式不显示）
    // 源码区外层容器（行号槽 + textarea）：切模式要隐藏的是它，不再是 textarea 本身
    this.sourceWrap = opts.sourceWrap || this.sourceEl.closest('.source-wrap');
    this.opts = opts;
    this.path = null;
    this.mode = 'live';            // live | source
    this.md = '';                  // 权威内容（Markdown 文本）
    this.renderedMd = '';          // 当前 DOM 对应的 Markdown
    this.dirty = false;
    this.composing = false;
    this.previewTimer = null;

    // 行号开关（设置面板「编辑器 → 行号」）：源码槽 + 实时预览槽共用
    this.showLineNumbers = true;
    this.liveGutterEl = null;      // 实时预览行号槽（懒创建）
    this.liveGutterInner = null;

    // 撤销栈：contenteditable 每次重渲染都会重建 DOM，浏览器自带的 undo 记不住，
    // 所以自己按 Markdown 文本存快照（md + 光标偏移）。
    this.history = [];
    this.hIndex = -1;
    this.hTimer = null;
    this.historyLimit = 200;
    this._applyingHistory = false;
    this._resetHistory();

    this._bindEvents();
    this.autosaveMs = 900;
    this.autosave = debounce(() => this._doSave(), this.autosaveMs);
  }

  /** 自动保存防抖时长（毫秒），来自设置面板 */
  setAutosave(ms) {
    const value = Math.max(0, Number(ms) || 0);
    this.autosaveMs = value;
    this.autosave = debounce(() => this._doSave(), value);
  }

  /* ---------- 事件 ---------- */
  _bindEvents() {
    const el = this.liveEl;

    // 点 Markdown 图片 → 灯箱看大图
    el.addEventListener('click', (e) => {
      const img = e.target.closest('img.md-image');
      if (!img || !el.contains(img)) return;
      e.preventDefault();
      e.stopPropagation();
      this.opts.onImageClick?.(img.currentSrc || img.src, img.alt || '');
    });

    el.addEventListener('compositionstart', () => {
      this.composing = true;
      // 保险：极少数环境下 compositionend 不触发，3 秒后强制解除
      clearTimeout(this._composingTimer);
      this._composingTimer = setTimeout(() => { this.composing = false; }, 3000);
    });
    el.addEventListener('compositionend', () => {
      this.composing = false;
      clearTimeout(this._composingTimer);
      this._onInput();
    });

    el.addEventListener('input', (e) => {
      // 输入法组词过程中的 input 不处理
      if (e && e.isComposing) return;
      this._onInput();
    });

    el.addEventListener('keydown', (e) => {
      // Enter / Escape 不可能属于输入法组词，顺手解除卡死的 composing
      if (e.key === 'Enter' || e.key === 'Escape') this.composing = false;
      this._onKeydown(e);
    });
    el.addEventListener('blur', () => { this.composing = false; });

    /* ---------- 图片粘贴 / 文件拖入：存成附件，光标处插入 ![[路径]] ----------
     * 为什么必须拦下来：不拦的话浏览器默认行为是把图片塞进 contenteditable
     * （data URL / blob URL），刷新即丢；拖入文件甚至会直接导航打开。
     * 落点由设置里的「附件 → 新附件位置」决定，服务端还会再校验一次。 */
    const onPasteAsset = (e) => {
      const file = [...(e.clipboardData?.items || [])]
        .filter((it) => it.kind === 'file').map((it) => it.getAsFile()).find(Boolean);
      if (!file) return;
      e.preventDefault();
      this._saveAssetFile(file);
    };
    const onDropAsset = (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) this._saveAssetFile(f);
    };
    const onDragOver = (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
    };
    el.addEventListener('paste', onPasteAsset);
    el.addEventListener('drop', onDropAsset);
    el.addEventListener('dragover', onDragOver);
    this.sourceEl.addEventListener('paste', onPasteAsset);
    this.sourceEl.addEventListener('drop', onDropAsset);
    this.sourceEl.addEventListener('dragover', onDragOver);

    // 复选框
    el.addEventListener('click', (e) => {
      const cb = e.target;
      if (cb instanceof HTMLInputElement && cb.type === 'checkbox') {
        e.preventDefault();
        this._toggleCheckboxAtCaret(cb);
      }
    });

    // 双链点击 / 悬浮预览 / 标签点击
    el.addEventListener('click', (e) => {
      const link = e.target.closest?.('a.wikilink');
      if (link) {
        e.preventDefault();
        this._openWikilink(link);
        return;
      }
      const tag = e.target.closest?.('.md-tag');
      if (tag) {
        e.preventDefault();
        this.opts.onTagClick?.(tag.dataset.tag);
      }
    });
    el.addEventListener('mouseover', (e) => {
      const link = e.target.closest?.('a.wikilink');
      if (link && link.dataset.resolved) this._schedulePreview(link);
    });
    el.addEventListener('mouseout', (e) => {
      if (e.target.closest?.('a.wikilink')) this._cancelPreview();
    });

    // 源码模式 ↔ 实时模式
    this.sourceEl.addEventListener('input', () => {
      this.md = this.sourceEl.value;
      this.dirty = true;
      this.opts.onDirtyChange?.(true);
      this.opts.onChange?.(this.md);
      this._updateGutter();
      this.autosave();
    });
    // 行号槽跟着源码区滚动
    this.sourceEl.addEventListener('scroll', () => this._updateGutter());

    // 实时预览行号：滚动只做位移（不重算），窗口尺寸变化才重算对齐
    el.addEventListener('scroll', () => this._syncGutterScroll());
    window.addEventListener('resize', () => { if (this.mode === 'live') this._syncLiveGutter(); });
  }

  /** 刷新源码模式行号：行数变了才重建数字，滚动只同步 scrollTop */
  _updateGutter() {
    const gutter = this.gutterEl;
    if (!gutter) return;
    if (!this.showLineNumbers) { gutter.hidden = true; return; }
    gutter.hidden = false;
    if (this.mode !== 'source') return;
    const lines = this.sourceEl.value.split('\n').length;
    if (gutter.childElementCount !== lines) {
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= lines; i++) {
        const d = document.createElement('div');
        d.textContent = String(i);
        frag.appendChild(d);
      }
      gutter.replaceChildren(frag);
    }
    gutter.scrollTop = this.sourceEl.scrollTop;
  }

  /* ---------- 实时预览行号 ----------
   * 实时模式没有「源码行」这种 DOM 实体，只有渲染出来的块。所以按块测量：
   *   · 每个块都带 data-md-line-start（源码字符偏移）→ 换成行号；
   *   · 块内用 Range.getClientRects() 拿到「每个视觉行」的顶部，逐行编号
   *     （软换行段落、代码块、表格行都靠这个对齐）；
   *   · 列表按 li 编号，Callout 标题 + 正文分别编。
   * 数字画在编辑区左侧的覆盖层里，滚动只位移不重算。
   */
  setLineNumbers(on) {
    this.showLineNumbers = !!on;
    this._updateGutter();
    this._syncLiveGutter();
  }

  _ensureLiveGutter() {
    if (this.liveGutterEl) return this.liveGutterEl;
    const host = this.liveEl.parentElement;
    if (!host) return null;
    const g = document.createElement('div');
    g.className = 'live-gutter';
    g.hidden = true;
    const inner = document.createElement('div');
    inner.className = 'lg-inner';
    g.appendChild(inner);
    host.appendChild(g);
    this.liveGutterEl = g;
    this.liveGutterInner = inner;
    return g;
  }

  _syncGutterScroll() {
    if (!this.liveGutterEl || this.liveGutterEl.hidden) return;
    this.liveGutterInner.style.transform = `translateY(${-this.liveEl.scrollTop}px)`;
  }

  _syncLiveGutter() {
    const g = this._ensureLiveGutter();
    if (!g) return;
    if (!this.showLineNumbers || this.mode !== 'live' || this.liveEl.hidden) { g.hidden = true; return; }
    const items = this._collectLineNumbers();
    if (!items.length) { g.hidden = true; return; }

    const edRect = this.liveEl.getBoundingClientRect();
    const first = this.liveEl.firstElementChild?.getBoundingClientRect();
    const left = first ? Math.round(first.left - edRect.left - 44) : 0;
    g.style.left = `${Math.max(0, left)}px`;
    g.hidden = false;

    const frag = document.createDocumentFragment();
    for (const it of items) {
      const d = document.createElement('div');
      d.className = 'ln';
      d.textContent = String(it.n);
      d.style.top = `${Math.round(it.y)}px`;
      frag.appendChild(d);
    }
    this.liveGutterInner.replaceChildren(frag);
    this._syncGutterScroll();
  }

  /** 收集 [{ 行号, 纵坐标 }]（纵坐标相对滚动内容顶部） */
  _collectLineNumbers() {
    const lineOf = new Map();
    let ln = 1;
    lineOf.set(0, 1);
    for (let i = 0; i < this.md.length; i++) {
      if (this.md[i] === '\n') { ln += 1; lineOf.set(i + 1, ln); }
    }
    const edRect = this.liveEl.getBoundingClientRect();
    const scrollTop = this.liveEl.scrollTop;
    const out = [];
    const push = (lineNo, top, h) => {
      if (!Number.isFinite(lineNo) || lineNo < 1) return;
      out.push({ n: lineNo, y: top - edRect.top + scrollTop + Math.max(0, ((h || 14) - 14) / 2) });
    };

    for (const el of this.liveEl.children) {
      const tag = el.tagName;

      // 列表 / 表格：容器本身没有偏移标记，编号在 li / tr 上（要先于下面的判断）
      if (tag === 'UL' || tag === 'OL') {
        for (const li of el.querySelectorAll('li[data-md-line-start]')) {
          const liLine = lineOf.get(Number(li.dataset.mdLineStart));
          const r = li.getBoundingClientRect();
          const lh = parseFloat(getComputedStyle(li).lineHeight) || 24;
          push(liLine, r.top, Math.min(lh, r.height || lh));
        }
        continue;
      }
      if (tag === 'TABLE') {
        for (const tr of el.querySelectorAll('tr')) {
          const cell = tr.querySelector('th, td');
          const trLine = cell?.dataset?.mdLineStart ? lineOf.get(Number(cell.dataset.mdLineStart)) : null;
          const r = tr.getBoundingClientRect();
          push(trLine, r.top, r.height);
        }
        continue;
      }

      const startOff = Number(el.dataset.mdLineStart);
      if (!Number.isFinite(startOff)) continue;
      const start = lineOf.get(startOff);
      if (!start) continue;

      if (tag === 'PRE') {
        // 块首行是 ``` 围栏，代码行从下一行开始
        const code = el.querySelector('code') || el;
        lineBoxes(code).forEach((box, i) => push(start + 1 + i, box.top, box.h));
        continue;
      }
      if (el.classList.contains('callout')) {
        push(start, el.getBoundingClientRect().top, 20);
        const body = el.querySelector('.callout-body');
        const firstInner = body?.querySelector('[data-md-line-start]');
        const bodyStart = firstInner ? lineOf.get(Number(firstInner.dataset.mdLineStart)) : null;
        if (body && bodyStart) lineBoxes(body).forEach((box, i) => push(bodyStart + i, box.top, box.h));
        continue;
      }
      lineBoxes(el).forEach((box, i) => push(start + i, box.top, box.h));
    }

    out.sort((a, b) => a.y - b.y || a.n - b.n);
    const res = [];
    for (const it of out) {
      const prev = res[res.length - 1];
      if (prev && Math.abs(prev.y - it.y) < 3) continue;   // 同一视觉行只留一个号
      res.push(it);
    }
    return res;
  }

  /* ---------- 加载 / 保存 ---------- */
  load(path, content, { keepMode = false } = {}) {
    // 自己保存后 WS 会把文件变更广播回来、这里再读一次盘：内容一模一样就别重渲染了，
    // 否则每次自动保存都会清空撤销栈、把光标弹回别处（用户感觉「刚撤销完就跳走」）。
    if (path === this.path && content === this.md) return;
    this._flushSave();
    // 换文件时先清掉选区：否则 _renderLive 会把上一篇的光标位置恢复到新文件里
    window.getSelection()?.removeAllRanges();
    this.path = path;
    this.md = content;
    this.dirty = false;
    this.opts.onDirtyChange?.(false);
    if (!keepMode) this.setMode('live');
    this._renderLive();
    this.sourceEl.value = content;
    this._resetHistory();          // 撤销栈按笔记隔离，不能跨文件回滚
    this._updateGutter();
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

  /** 立即落盘（切换标签页 / 退出前调用） */
  async flush() { this._flushSave(); await new Promise((r) => setTimeout(r, 40)); }

  /* ---------- 渲染 ---------- */
  /** 渲染选项：链接 / 附件 / 相对图片都交给外部解析 */
  _mdOpts(extra = {}) {
    return {
      resolve: (target) => this.opts.resolveLink?.(target) || null,
      resolveFile: (f) => this.opts.resolveFile?.(f) || null,
      fileUrl: (p) => Api.fileUrl(p),
      ...extra,
    };
  }

  _renderLive() {
    const caret = this._saveCaret();
    this.liveEl.innerHTML = '';
    const frag = renderMarkdown(this.md, this._mdOpts());
    this.liveEl.appendChild(frag);
    this.renderedMd = this.md;
    this._restoreEmbeds();
    if (caret != null) this._restoreCaretMd(caret);
    this._syncLiveGutter();
    this.opts.onChange?.(this.md);
  }

  /** 输入防抖：序列化 → 变了就重渲染 */
  _onInput() {
    if (this.mode !== 'live' || this.composing) return;
    const md = serializeHtml(this.liveEl);
    this.md = md;
    this.dirty = true;
    this.opts.onDirtyChange?.(true);
    this.opts.onChange?.(md);
    this.autosave();
    this._scheduleHistory(520);    // 一段连续的输入合并成一步撤销
    clearTimeout(this._rerenderTimer);
    this._rerenderTimer = setTimeout(() => {
      if (this.mode !== 'live') return;
      if (md === this.renderedMd) return;
      this._renderLive();
    }, 220);
  }

  /* ---------- 光标保存 / 恢复 ----------
   * 统一用 Markdown 源码偏移做坐标（不再用「纯文本第几个字符」）：
   *   ① 纯文本偏移把 <br>、空行、块的边界全丢了。光标停在一个空块上时
   *      （锚点是元素而不是文本节点）旧实现 textOffsetOf 会返回「全文文本长度」，
   *      DOM 重建后光标被甩到全文最后一个字后面——实测就是「点空行打字，
   *      打完光标却跑到了下一段末尾，接着输的字全进到那一行」。
   *   ② 渲染时每个块都打了 data-md-content-start，domPointToMd / mdOffsetToDom
   *      是同一套精确的双向映射，编辑操作（回车/Tab/包裹）本来就走它。
   *      光标的保存/恢复也走它，全局只剩一套坐标，才不会互相打架。
   */
  _saveCaret() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.liveEl.contains(range.startContainer)) return null;
    const md = this._caretOffset();
    if (md == null) return null;
    // 在空行/空块上刚打的字，序列化后会「往下挪一行」——段落之间必须补一个空行，
    // 这一块在 md 里前移了一个 \n。光标偏移要跟着 +1，否则重建后少走一格
    // （实测：空行上打 "123"，光标停在 "12" 后面，继续输入就插到中间）。
    const host = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : range.startContainer;
    const leaf = host?.closest?.('[data-md-content-start]');
    if (leaf && leaf.textContent.trim() && this.md[Number(leaf.dataset.mdContentStart)] === '\n') {
      return md + 1;
    }
    return md;
  }

  /** 光标的 Markdown 偏移（不做任何补偿，撤销栈用这个） */
  _caretOffset() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.liveEl.contains(range.startContainer)) return null;
    const md = domPointToMd(this.liveEl, range.startContainer, range.startOffset);
    return md == null ? null : md;
  }

  _currentLineRange() {
    // 返回光标在 Markdown 源码中所属行的 [lineStart, lineEnd, offset]
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.liveEl.contains(range.startContainer)) return null;
    const offset = domPointToMd(this.liveEl, range.startContainer, range.startOffset);
    if (offset == null) return null;
    const lineStart = this.md.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const nl = this.md.indexOf('\n', offset);
    const lineEnd = nl === -1 ? this.md.length : nl;
    return { lineStart, lineEnd, offset };
  }

  /* ---------- 撤销 / 重做（Markdown 快照栈） ----------
   * 为什么不能用浏览器自带的 undo：编辑器每次输入都会 innerHTML 重建 DOM，
   * 原生 undo 栈跟着节点一起没了（Ctrl+Z 只会在残骸上乱跳）。所以自己存快照：
   *   { md, caret } —— md 是权威内容，caret 是当时的 Markdown 偏移。
   * 连续输入合并成一步（520ms 静默后落账），结构操作（回车/缩进/加粗…）
   * 立即落账，按操作回退，跟 Obsidian 的手感接近。
   */
  _resetHistory() {
    clearTimeout(this.hTimer);
    this.hTimer = null;
    this.history = [{ md: this.md, caret: this._caretOffset() ?? 0 }];
    this.hIndex = 0;
  }

  /** 把当前状态记进栈（跟上一张快照一样就跳过） */
  _commitHistory() {
    clearTimeout(this.hTimer);
    this.hTimer = null;
    if (this._applyingHistory) return;
    const top = this.history[this.hIndex];
    if (top && top.md === this.md) return;
    if (this.hIndex < this.history.length - 1) this.history.length = this.hIndex + 1;  // 新分支，砍掉 redo 尾巴
    this.history.push({ md: this.md, caret: this._caretOffset() ?? top?.caret ?? 0 });
    this.hIndex = this.history.length - 1;
    while (this.history.length > this.historyLimit) { this.history.shift(); this.hIndex -= 1; }
  }

  /** 延迟落账：打字用 520ms 合并，结构操作传 0（等 _placeCaret 放好光标） */
  _scheduleHistory(delay = 520) {
    if (this._applyingHistory) return;
    clearTimeout(this.hTimer);
    this.hTimer = setTimeout(() => this._commitHistory(), delay);
  }

  canUndo() { return this.mode === 'live' && (this.hIndex > 0 || !!this.hTimer); }
  canRedo() { return this.mode === 'live' && this.hIndex < this.history.length - 1; }

  undo() {
    if (this.mode !== 'live') { document.execCommand('undo'); return; }   // 源码模式交给 textarea 原生
    if (this.hTimer) this._commitHistory();                               // 还没落账的这次输入先记上
    if (this.hIndex <= 0) { toast('没有可撤销的操作'); return; }
    this._applyHistory(this.hIndex - 1);
  }

  redo() {
    if (this.mode !== 'live') { document.execCommand('redo'); return; }
    if (this.hTimer) this._commitHistory();
    if (this.hIndex >= this.history.length - 1) { toast('没有可重做的操作'); return; }
    this._applyHistory(this.hIndex + 1);
  }

  _applyHistory(idx) {
    const snap = this.history[idx];
    if (!snap) return;
    this.hIndex = idx;
    this._applyingHistory = true;
    this.md = snap.md;
    this.dirty = true;
    this.opts.onDirtyChange?.(true);
    this._renderLive();
    this._restoreCaretMd(Math.min(snap.caret ?? 0, this.md.length));
    this.sourceEl.value = this.md;
    this._updateGutter();
    this.autosave();
    this._applyingHistory = false;
  }

  /* ---------- 键盘 ---------- */
  _onKeydown(e) {
    if (this.mode !== 'live') {
      // 源码模式：Ctrl+S 保存
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this._doSave(); }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;

    // 撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }

    // Ctrl+E 切源码由外层处理
    if (mod && e.key === 'Enter') { e.preventDefault(); this._toggleCheckboxAtCaret(null); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); this._wrapSelection('**', '**'); return; }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); this._wrapSelection('*', '*'); return; }
    if (mod && e.key.toLowerCase() === 's' && !e.shiftKey) { e.preventDefault(); this._wrapSelection('~~', '~~'); return; }
    if (mod && e.key.toLowerCase() === 'e') { return; } // 交给 app 切模式
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); this._insertLink(); return; }

    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault();
      this._handleEnter();
      return;
    }
    if (e.key === 'Tab') {
      const lr = this._currentLineRange();
      if (lr) {
        e.preventDefault();
        const line = this.md.slice(lr.lineStart, lr.lineEnd);
        const isList = /^(\s*)([-*+]|\d+\.)\s/.test(line);
        if (isList) {
          if (e.shiftKey) {
            const dedented = line.replace(/^(\s{1,2})/, '');
            this._replaceRange(lr.lineStart, lr.lineEnd, dedented);
            this._placeCaret(lr.lineStart + Math.max(0, lr.offset - lr.lineStart - (line.length - dedented.length)));
          } else {
            this._replaceRange(lr.lineStart, lr.lineStart, '  ');
            this._placeCaret(lr.offset + 2);
          }
        } else {
          e.preventDefault();
          this._replaceRange(lr.offset, lr.offset, '  ');
          this._placeCaret(lr.offset + 2);
        }
      }
      return;
    }
  }

  _wrapSelection(mark, close) {
    const sel = window.getSelection();
    const text = sel.toString();
    if (!text) {
      // 没有选区：插入标记对，光标放中间
      const lr = this._currentLineRange() || { offset: this.md.length };
      this._replaceRange(lr.offset, lr.offset, mark + close);
      this._placeCaret(lr.offset + mark.length);
    } else {
      const a = domPointToMd(this.liveEl, sel.anchorNode, sel.anchorOffset) ?? 0;
      const b = domPointToMd(this.liveEl, sel.focusNode, sel.focusOffset) ?? 0;
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      this._replaceRange(start, end, mark + text + close);
      this._selectRange(start + mark.length, start + mark.length + text.length);
    }
  }

  _insertLink() {
    const sel = window.getSelection();
    const text = sel.toString();
    const offset = domPointToMd(this.liveEl, sel.anchorNode, sel.anchorOffset) ?? this.md.length;
    const inner = text || '链接文字';
    this._replaceRange(offset, offset + text.length, `[[${inner}]]`);
    this._placeCaret(offset + 2 + inner.length);
    toast('已插入 [[双链]]，输入笔记名后回车即可');
  }

  /** Enter：智能续行（列表/引用/任务自动带上前缀） */
  _handleEnter() {
    const lr = this._currentLineRange();
    if (!lr) return;
    const line = this.md.slice(lr.lineStart, lr.lineEnd);
    const relCaret = lr.offset - lr.lineStart;
    const before = line.slice(0, relCaret);
    const after = line.slice(relCaret);

    // 空列表项 / 空引用 → 退出
    if (/^\s*([-*+]|\d+\.)\s*$/.test(line) || /^\s*>\s*$/.test(line) || /^\s*[-*+]\s\[[ x]\]\s*$/.test(line)) {
      this._replaceRange(lr.lineStart, lr.lineEnd, '');
      this._placeCaret(lr.lineStart);
      return;
    }

    let prefix = '';
    let caretAdvance = 0;
    const ul = /^(\s*)([-*+])\s+/.exec(line);
    const ol = /^(\s*)(\d+)\.\s+/.exec(line);
    const task = /^(\s*)[-*+]\s+\[[ x]\]\s+/.exec(line);
    const quote = /^(\s*)>\s?/.exec(line);
    const heading = /^(#{1,6}\s+)/.exec(line);

    if (task) prefix = `${task[1]}- [ ] `;
    else if (ul) prefix = `${ul[1]}${ul[2]} `;
    else if (ol) prefix = `${ol[1]}${Number(ol[2]) + 1}. `;
    else if (quote) prefix = `${quote[1]}> `;
    else if (heading && relCaret >= line.length) prefix = ''; // 标题行尾回车 → 普通段落

    const insert = (prefix ? '\n' + prefix : '\n');
    this._replaceRange(lr.offset, lr.offset, insert);
    this._placeCaret(lr.offset + 1 + prefix.length);
    caretAdvance = prefix.length;
    return caretAdvance;
  }

  _toggleCheckboxAtCaret(cbEl) {
    let lineStart, lineEnd, caretOffset;
    if (cbEl) {
      // 点击复选框：直接用 li 上打的源码标记
      const li = cbEl.closest('li');
      if (!li?.dataset.mdLineStart) return;
      lineStart = Number(li.dataset.mdLineStart);
      lineEnd = Number(li.dataset.mdLineEnd);
      caretOffset = Number(li.dataset.mdContentStart ?? lineStart);
    } else {
      const lr = this._currentLineRange();
      if (!lr) return;
      lineStart = lr.lineStart; lineEnd = lr.lineEnd; caretOffset = lr.offset;
    }
    const line = this.md.slice(lineStart, lineEnd);
    const m = /^(\s*[-*+]\s+\[)([ x])(\].*)$/.exec(line);
    if (!m) { toast('当前行不是任务项（- [ ] 内容）'); return; }
    const next = m[2] === ' ' ? 'x' : ' ';
    this._replaceRange(lineStart, lineEnd, `${m[1]}${next}${m[3]}`);
    this._placeCaret(caretOffset);
  }

  /* ---------- Markdown 文本操作（统一走后：改文本 → 重渲染 → 光标） ---------- */
  _replaceRange(start, end, text) {
    this.md = this.md.slice(0, start) + text + this.md.slice(end);
    this.dirty = true;
    this.opts.onDirtyChange?.(true);
    this._renderLive();
    this._scheduleHistory(0);      // 结构操作单独成一步（0ms：等调用方把光标放好）
    this.autosave();
  }

  /**
   * 在光标处插入一段 Markdown（绘图、模板等用）。
   * 源码模式下直接改 textarea，实时预览模式下走 md 坐标系。
   */
  insertSnippet(text) {
    if (this.mode === 'source') {
      const el = this.sourceEl;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const next = el.value.slice(0, start) + text + el.value.slice(end);
      el.value = next;
      this.md = next;
      el.selectionStart = el.selectionEnd = start + text.length;
      this.dirty = true;
      this.opts.onDirtyChange?.(true);
      this.opts.onChange?.(this.md);
      this._updateGutter();
      this.autosave();
      return;
    }
    const lr = this._currentLineRange();
    const at = lr ? lr.offset : this.md.length;
    const lead = at === 0 ? '' : (this.md[at - 1] === '\n' ? '\n' : '\n\n');
    this._replaceRange(at, at, lead + text + '\n');
    this._placeCaret(at + lead.length + text.length + 1);
  }

  /* ---------- 右键菜单等外部调用（实时预览 / 源码模式都支持） ---------- */

  /** 源码模式的统一收尾：同步 md、通知、刷新行号、自动保存 */
  _sourceChanged(text) {
    this.md = text;
    this.dirty = true;
    this.opts.onDirtyChange?.(true);
    this.opts.onChange?.(this.md);
    this._updateGutter();
    this.autosave();
  }

  /** 用标记包裹选区（无选区时插入成对标记，光标居中） */
  wrapSelection(open, close) {
    if (this.mode === 'source') {
      const el = this.sourceEl;
      const s = el.selectionStart ?? 0;
      const e = el.selectionEnd ?? s;
      const text = el.value.slice(s, e);
      const next = el.value.slice(0, s) + open + text + close + el.value.slice(e);
      el.value = next;
      el.selectionStart = el.selectionEnd = s + open.length + (text ? text.length + close.length : 0);
      this._sourceChanged(next);
      return;
    }
    this._wrapSelection(open, close);
  }

  /** 当前行替换成指定前缀（'## ' / '- ' / '> ' / '' = 正文） */
  setLinePrefix(prefix) {
    const strip = (line) => line.replace(/^(\s*)(#{1,6}\s+|[-*+]\s+(?:\[[ x]\]\s+)?|>\s?|\d+\.\s+)/, '$1');
    if (this.mode === 'source') {
      const el = this.sourceEl;
      const pos = el.selectionStart ?? 0;
      const lineStart = el.value.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
      const nl = el.value.indexOf('\n', pos);
      const lineEnd = nl === -1 ? el.value.length : nl;
      const line = el.value.slice(lineStart, lineEnd);
      const indent = line.match(/^\s*/)[0];
      const next = indent + prefix + strip(line).slice(indent.length);
      el.value = el.value.slice(0, lineStart) + next + el.value.slice(lineEnd);
      el.selectionStart = el.selectionEnd = Math.min(lineStart + next.length, el.value.length);
      this._sourceChanged(el.value);
      return;
    }
    const lr = this._currentLineRange();
    if (!lr) return;
    const line = this.md.slice(lr.lineStart, lr.lineEnd);
    const indent = line.match(/^\s*/)[0];
    const next = indent + prefix + strip(line).slice(indent.length);
    this._replaceRange(lr.lineStart, lr.lineEnd, next);
    this._placeCaret(lr.lineStart + next.length);
  }

  /** 在光标处插入纯文本（不加额外空行——粘贴用） */
  insertText(text) {
    if (this.mode === 'source') {
      const el = this.sourceEl;
      const s = el.selectionStart ?? el.value.length;
      const e = el.selectionEnd ?? s;
      const next = el.value.slice(0, s) + text + el.value.slice(e);
      el.value = next;
      el.selectionStart = el.selectionEnd = s + text.length;
      this._sourceChanged(next);
      return;
    }
    const sel = window.getSelection();
    let a = null;
    let b = null;
    if (sel.rangeCount) {
      a = domPointToMd(this.liveEl, sel.anchorNode, sel.anchorOffset);
      b = domPointToMd(this.liveEl, sel.focusNode, sel.focusOffset);
    }
    const start = Math.min(a ?? this.md.length, b ?? this.md.length);
    const end = Math.max(a ?? this.md.length, b ?? this.md.length);
    this._replaceRange(start, end, text);
    this._placeCaret(start + text.length);
  }

  /** 全选当前编辑内容 */
  selectAll() {
    if (this.mode === 'source') {
      this.sourceEl.focus();
      this.sourceEl.select();
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(this.liveEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    this.liveEl.focus();
  }

  /** 从正文里移除某张图片的 Markdown 标记（图片右键菜单「移除图片」） */
  removeImageAt(el) {
    if (this.mode !== 'live') return;
    const fig = el?.closest?.('.embed-image');
    const img = fig ? fig.querySelector('img') : el;
    let token = '';
    if (fig) token = `![[${fig.dataset.target || ''}]]`;
    else if (img?.dataset?.mdSrc) token = `![${img.getAttribute('alt') || ''}](${img.dataset.mdSrc})`;
    let idx = token ? this.md.indexOf(token) : -1;
    let end = idx >= 0 ? idx + token.length : -1;
    if (idx < 0 && img?.dataset?.mdSrc) {
      // alt / 空格可能被序列化改写过：退化为按 src 定位整段 ![..](src)
      const tail = this.md.indexOf(`](${img.dataset.mdSrc})`);
      if (tail >= 0) {
        const open = this.md.lastIndexOf('![', tail);
        if (open >= 0) { idx = open; end = tail + 2 + img.dataset.mdSrc.length; }
      }
    }
    if (idx < 0) { toast('没找到图片在源码里的位置'); return; }
    this._replaceRange(idx, end, '');
  }

  /**
   * 把粘贴/拖入的文件存成仓库附件，并在光标处插入 ![[路径]]。
   * 落点 = 设置里的附件位置（folder/note/root），服务端独立清洗兜底。
   */
  async _saveAssetFile(file) {
    if (file.size > MAX_ASSET) { toast('文件超过 30MB，无法作为附件存入'); return; }
    const isImage = file.type.startsWith('image/');
    if (!isImage && !ASSET_EXT.test(file.name || '')) {
      toast(`暂不支持的文件类型：${file.name || file.type || '未知'}`);
      return;
    }
    let dataUrl;
    try { dataUrl = await readAsDataUrl(file); } catch (e) { toast(e.message); return; }
    // 截图/复制的图默认叫 image.png，一堆 image-2.png 很难认，换成带时间戳的名字
    let name = file.name || '';
    if (!name || /^image\.(png|jpe?g|gif|webp)$/i.test(name)) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      name = `粘贴的图片 ${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
    }
    try {
      const res = await Api.saveAsset({
        data: dataUrl,
        name,
        dir: resolveAssetDir(getSettings(), this.path),
      });
      if (res?.ok) {
        this.insertSnippet(`![[${res.path}]]`);
        this.opts.onAssetSaved?.(res.path);
      } else {
        toast(res?.error || '附件保存失败');
      }
    } catch (e) {
      toast(`附件保存失败：${e.message}`);
    }
  }

  _placeCaret(mdOffset) {
    // 同步恢复光标。原来这里包了一层 requestAnimationFrame——等一帧的功夫，
    // 用户下一个按键就送到了，字打进旧位置（实测：回车后立刻打字，字落在
    // 上一行行尾；列表回车后续打，"乙" 跑到 "甲" 后面）。_replaceRange 里
    // _renderLive 已同步重建 DOM，不需要再等帧。
    this._restoreCaretMd(mdOffset);
  }

  _restoreCaretMd(mdOffset) {
    try {
      const { node, offset } = mdOffsetToDom(this.liveEl, mdOffset);
      const sel = window.getSelection();
      const range = document.createRange();
      if (node.nodeType === Node.TEXT_NODE) {
        range.setStart(node, Math.min(offset, node.textContent.length));
      } else {
        range.setStart(node, 0);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* 光标恢复失败时保持默认 */ }
  }

  _selectRange(mdStart, mdEnd) {
    requestAnimationFrame(() => {
      try {
        const a = mdOffsetToDom(this.liveEl, mdStart);
        const b = mdOffsetToDom(this.liveEl, mdEnd);
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStart(a.node, Math.min(a.offset, a.node.textContent?.length ?? 0));
        range.setEnd(b.node, Math.min(b.offset, b.node.textContent?.length ?? 0));
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* ignore */ }
    });
  }

  /* ---------- 双链 ---------- */
  _openWikilink(link) {
    const target = link.dataset.target || '';
    const heading = link.dataset.heading || '';
    const resolved = link.dataset.resolved;
    if (resolved) {
      this.opts.onNavigate?.(resolved, heading);
    } else {
      // 未解析链接：Obsidian 行为 —— 点击后询问是否创建
      const name = target.split('#')[0].trim();
      if (!name) return;
      Promise.resolve(this.opts.confirmCreate?.(name)).then((ok) => {
        if (ok) this.opts.onCreateNote?.(name);
      });
    }
  }

  _schedulePreview(link) {
    this._cancelPreview();
    this.previewTimer = setTimeout(async () => {
      const path = link.dataset.resolved;
      if (!path) return;
      const pop = document.getElementById('link-preview');
      try {
        const { content, name } = await Api.note(path);
        const rect = link.getBoundingClientRect();
        pop.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'lp-title';
        title.textContent = name;
        const body = document.createElement('div');
        body.className = 'lp-body markdown-body';
        body.appendChild(renderMarkdown(content.slice(0, 1200), this._mdOpts({ tagOffsets: false })));
        pop.append(title, body);
        pop.hidden = false;
        const top = Math.min(rect.bottom + 8, window.innerHeight - 320);
        const left = Math.min(rect.left, window.innerWidth - 360);
        pop.style.top = `${top}px`;
        pop.style.left = `${left}px`;
      } catch { /* ignore */ }
    }, 450);
  }

  _cancelPreview() {
    clearTimeout(this.previewTimer);
    const pop = document.getElementById('link-preview');
    if (pop) pop.hidden = true;
  }

  /* ---------- 嵌入 ![[note]] / ![[image.png|400]] / 附件 ---------- */
  _restoreEmbeds() {
    const slots = this.liveEl.querySelectorAll('.embed-slot[data-embed]');
    for (const slot of slots) {
      const raw = slot.dataset.embed;
      const bar = raw.lastIndexOf('|');
      const targetPart = bar >= 0 ? raw.slice(0, bar) : raw;
      const alias = bar >= 0 ? raw.slice(bar + 1).trim() : '';
      const name = targetPart.split('#')[0].trim();
      const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name);

      if (isImage) {
        this._renderImageEmbed(slot, raw, name, alias);
        continue;
      }

      const resolved = this.opts.resolveLink?.(name);
      const box = document.createElement('div');
      box.className = 'embed';
      box.dataset.target = raw;
      box.contentEditable = 'false'; // 嵌入内容不可编辑，避免打字丢内容
      const title = document.createElement('div');
      title.className = 'embed-title';
      title.textContent = `![[${raw}]]`;
      box.appendChild(title);
      if (resolved) {
        const body = document.createElement('div');
        body.className = 'embed-body markdown-body';
        body.textContent = '加载中…';
        box.appendChild(body);
        Api.note(resolved).then(({ content }) => {
          body.textContent = '';
          // tagOffsets:false —— 嵌入内容的偏移标记属于另一份 md，不能混入主文档
          body.appendChild(renderMarkdown(content.slice(0, 3000), this._mdOpts({ tagOffsets: false })));
        }).catch(() => { body.textContent = '（无法加载）'; });
      } else {
        const filePath = this.opts.resolveFile?.(name);
        if (filePath) {
          const body = document.createElement('div');
          body.className = 'embed-body';
          const card = document.createElement('button');
          card.className = 'embed-file';
          card.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5H4.5v11h7v-8z"/><path d="M9.5 2.5v3h2"/></svg><span></span>`;
          card.querySelector('span').textContent = name;
          card.onclick = (e) => {
            e.stopPropagation();
            window.open(Api.fileUrl(filePath), '_blank');
          };
          body.appendChild(card);
          box.appendChild(body);
        } else {
          const body = document.createElement('div');
          body.className = 'embed-body';
          body.innerHTML = `<span style="color:var(--link-unresolved)">尚未创建「${escHtml(raw)}」</span>`;
          box.appendChild(body);
        }
      }
      slot.replaceWith(box);
      box.onclick = async (e) => {
        e.stopPropagation();
        if (resolved) this.opts.onNavigate?.(resolved);
        else if (!this.opts.resolveFile?.(name)) {
          const ok = await this.opts.confirmCreate?.(name);
          if (ok) this.opts.onCreateNote?.(name);
        }
      };
    }
  }

  /** 图片嵌入：不显示文件名的灰条，直接给图；点开灯箱看大图 */
  _renderImageEmbed(slot, raw, name, alias) {
    const filePath = this.opts.resolveFile?.(name);
    const fig = document.createElement('figure');
    fig.className = 'embed embed-image';
    fig.dataset.target = raw;
    fig.contentEditable = 'false';

    if (!filePath) {
      fig.innerHTML = `<div class="embed-missing">图片不存在：<code>${escHtml(name)}</code></div>`;
      slot.replaceWith(fig);
      return;
    }
    const img = document.createElement('img');
    img.src = Api.fileUrl(filePath);
    img.alt = name;
    img.loading = 'lazy';
    img.draggable = false;
    const w = Number.parseInt(alias, 10);
    if (Number.isFinite(w) && w > 0) {
      img.style.width = `${Math.min(w, 4000)}px`;
      img.style.maxWidth = '100%';
    }
    fig.appendChild(img);
    const cap = document.createElement('figcaption');
    cap.textContent = name;
    fig.appendChild(cap);

    // 右下角拖拽手柄：调宽度 → 改写 ![[name|宽]] 里的数字
    const grip = document.createElement('span');
    grip.className = 'img-grip';
    grip.title = '拖动调整宽度（双击还原）';
    fig.appendChild(grip);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = img.getBoundingClientRect().width;
      const capW = 1200;   // 上限，避免拖出天际
      const move = (ev) => {
        const w = Math.round(Math.min(capW, Math.max(80, startW + ev.clientX - startX)));
        img.style.width = `${w}px`;
        img.style.maxWidth = '100%';
        grip.dataset.w = String(w);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const w = Number(grip.dataset.w);
        if (w > 0) this.setImageWidth(fig, w);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      img.style.width = '';
      this.setImageWidth(fig, 0);   // 0 = 去掉尺寸
    });
    grip.addEventListener('click', (e) => e.stopPropagation());

    fig.addEventListener('click', (e) => {
      e.stopPropagation();
      this.opts.onImageClick?.(Api.fileUrl(filePath), name);
    });
    slot.replaceWith(fig);
  }

  /** 改写嵌入图片的宽度（0 = 去掉尺寸）；raw 就是 ![[...]] 括号里的内容 */
  setImageWidth(fig, width) {
    const raw = fig?.dataset?.target || '';
    if (!raw) return;
    const token = `![[${raw}]]`;
    const idx = this.md.indexOf(token);
    if (idx < 0) { toast('没找到图片在源码里的位置'); return; }
    const name = raw.split('|')[0].replace(/#.*$/, '').trim();
    const next = width > 0 ? `![[${name}|${Math.round(width)}]]` : `![[${name}]]`;
    this._replaceRange(idx, idx + token.length, next);
  }

  /* ---------- 模式切换 ---------- */
  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'source') {
      this._flushSave();
      this.sourceEl.value = this.md;
      this.liveEl.hidden = true;
      if (this.liveGutterEl) this.liveGutterEl.hidden = true;
      if (this.sourceWrap) this.sourceWrap.hidden = false;
      this.sourceEl.hidden = false;
      this.mode = 'source';
      this._updateGutter();
    } else {
      this.md = this.sourceEl.value;
      this.liveEl.hidden = false;
      if (this.sourceWrap) this.sourceWrap.hidden = true;
      this.sourceEl.hidden = true;
      this.mode = 'live';
      this._renderLive();
      this._resetHistory();   // 源码模式的改动交给 textarea 原生撤销，回来重新起栈
      this.autosave();
    }
    this.opts.onModeChange?.(this.mode);
  }

  toggleMode() { this.setMode(this.mode === 'live' ? 'source' : 'live'); }

  focus() {
    if (this.mode === 'live') this.liveEl.focus();
    else this.sourceEl.focus();
  }

  scrollToHeading(headingText) {
    if (!headingText) return;
    const slug = headingText.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
    const el = this.liveEl.querySelector(`[id^="${slug}"]`) || [...this.liveEl.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .find((h) => h.textContent.includes(headingText));
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.style.transition = 'background .6s';
      el.style.background = 'rgba(139,92,246,.18)';
      setTimeout(() => { el.style.background = ''; }, 900);
    }
  }
}

/**
 * 元素内「每个视觉行」的顶部与行高。
 * Range.getClientRects() 一行一个 rect（软换行段落、代码块、引用都适用），
 * 同一行里多个内联元素会给出多个 rect，按 top 合并。
 */
function lineBoxes(el) {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.6;
  const out = [];
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    for (const r of range.getClientRects()) {
      if (r.height < 1) continue;
      if (!out.length || r.top - out[out.length - 1].top > 4) {
        out.push({ top: r.top, h: Math.max(r.height, lh) });
      }
    }
  } catch { /* 测量失败就退化成整块一行 */ }
  if (!out.length) {
    const b = el.getBoundingClientRect();
    out.push({ top: b.top, h: lh });
  }
  return out;
}
