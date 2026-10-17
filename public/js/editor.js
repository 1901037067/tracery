/**
 * Tracery 实时预览编辑器（仿 Obsidian Live Preview）
 *  - contenteditable WYSIWYG：Markdown 语法边打边渲染
 *  - 输入防抖 → DOM 序列化回 Markdown → 重渲染 → 按字符偏移恢复光标
 *  - Enter 智能续行 / Tab 缩进 / Ctrl+B/I/S 包裹 / 复选框点击 / 双链点击与悬浮预览 / ![[嵌入]]
 */
import { renderMarkdown, serializeHtml, textOffsetOf, nodeAtTextOffset, domPointToMd, mdOffsetToDom, inlineToHtml, escapeHtml } from './markdown.js';
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
    this.opts = opts;
    this.path = null;
    this.mode = 'live';            // live | source
    this.md = '';                  // 权威内容（Markdown 文本）
    this.renderedMd = '';          // 当前 DOM 对应的 Markdown
    this.dirty = false;
    this.composing = false;
    this.previewTimer = null;

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
      this.autosave();
    });
  }

  /* ---------- 加载 / 保存 ---------- */
  load(path, content, { keepMode = false } = {}) {
    this._flushSave();
    this.path = path;
    this.md = content;
    this.dirty = false;
    this.opts.onDirtyChange?.(false);
    if (!keepMode) this.setMode('live');
    this._renderLive();
    this.sourceEl.value = content;
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
    if (caret) this._restoreCaret(caret);
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
    clearTimeout(this._rerenderTimer);
    this._rerenderTimer = setTimeout(() => {
      if (this.mode !== 'live') return;
      if (md === this.renderedMd) return;
      this._renderLive();
    }, 220);
  }

  /* ---------- 光标保存 / 恢复（按纯文本字符偏移） ---------- */
  _saveCaret() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.liveEl.contains(range.startContainer)) return null;
    return textOffsetOf(this.liveEl, range.startContainer, range.startOffset);
  }

  _restoreCaret(offset) {
    const { node, offset: off } = nodeAtTextOffset(this.liveEl, offset);
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      if (node.nodeType === Node.TEXT_NODE) {
        range.setStart(node, Math.min(off, node.textContent.length));
      } else {
        range.setStart(node, 0);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* 光标恢复失败时保持默认 */ }
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

  /* ---------- 键盘 ---------- */
  _onKeydown(e) {
    if (this.mode !== 'live') {
      // 源码模式：Ctrl+S 保存
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this._doSave(); }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;

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
      this.autosave();
      return;
    }
    const lr = this._currentLineRange();
    const at = lr ? lr.offset : this.md.length;
    const lead = at === 0 ? '' : (this.md[at - 1] === '\n' ? '\n' : '\n\n');
    this._replaceRange(at, at, lead + text + '\n');
    this._placeCaret(at + lead.length + text.length + 1);
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
    requestAnimationFrame(() => this._restoreCaretMd(mdOffset));
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

    fig.addEventListener('click', (e) => {
      e.stopPropagation();
      this.opts.onImageClick?.(Api.fileUrl(filePath), name);
    });
    slot.replaceWith(fig);
  }

  /* ---------- 模式切换 ---------- */
  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'source') {
      this._flushSave();
      this.sourceEl.value = this.md;
      this.liveEl.hidden = true;
      this.sourceEl.hidden = false;
      this.mode = 'source';
    } else {
      this.md = this.sourceEl.value;
      this.liveEl.hidden = false;
      this.sourceEl.hidden = true;
      this.mode = 'live';
      this._renderLive();
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
