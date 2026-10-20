/**
 * public/js/cm/widgets.js — CM6 块级 widget 与行级装饰（P3）
 * ------------------------------------------------------------------
 * EDITOR-MIGRATION.md 第 4 节 P3 的「无服务端依赖」子集：
 *   ① `![[图片.png|640]]` 整行 → 图片 widget + 右下角拖宽手柄（拖完改写 doc 里的宽度参数）
 *   ② `- [ ]` / `- [x]` → 复选框 widget，点击直接改 doc
 *   ③ Callout（`> [!tip]`）→ 行装饰色条 + 藏 `>`/`[!type]`；正文仍是 CM 真实行（不整块 replace）
 *   ④ 表格 → 行装饰补边框（**不整块 replace**，否则单元格不可编辑）
 *   ⑤ 双链/标签 → hover 与点击（走 domEventHandlers 回调，复用 P1 的行内装饰 span）
 * 「![[笔记]] 嵌入卡片」依赖 Api.note（服务端），按约定留到 P4 接回 app.js 时做。
 *
 * 三条来自 P0/P1 的硬约束（照抄结论）：
 *   - **块级 widget 装饰必须挂 StateField**（视图插件里用 block replace 会抛
 *     "Block decorations may not be specified via plugins"）→ 图片 embed 走 StateField；
 *   - **挂件高度变化走 state effect/事务**（原地改 DOM + requestMeasure 会被 CM 测量周期抢滚动）：
 *     图片拖宽在拖动期只改本地 DOM，pointerup 时 dispatch 一个 doc 变更（事务）持久化宽度，
 *     由 CM 重新测量、自动锚定滚动；
 *   - 行内替换/行装饰可以走 ViewPlugin（视口作用域、便宜）→ 复选框/Callout/表格走 ViewPlugin。
 *
 * 与块级模型的业务解耦：本模块不认路径、不认附件库，图片 URL / 是否图片都由调用方注入的
 * `resolveImage(name)` / `isImage(name)` 决定；P4 接 editor.js 的 resolveFile + Api.fileUrl。
 */
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { parseCached, refreshLivePreview } from './decorations.js';
import { renderMarkdown } from '../markdown.js';

const DEFAULT_IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
/** 附件类扩展名（非图片也算附件 → 文件条，而不是笔记嵌入卡片） */
const DEFAULT_ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf|mp4|mp3|wav|zip|docx?|xlsx?|pptx?|txt|csv)$/i;
const EMBED_LINE_RE = /^!\[\[([^\]]+)\]\]$/;   // 整行就是一个嵌入
const TASK_MARK_RE = /^(\s*[-*+]\s+)\[([ xX])\]/;
const QUOTE_MARK_RE = /^(\s*>\s?)/;
const CALLOUT_MARK_RE = /^(\s*>\s?)(\[![^\]]+\]\s*)/;

/** 0-based AST 行号 → CM 1-based doc 行（P1 坑 3：混用会整体挂歪） */
function docLine(state, idx0) { return state.doc.line(idx0 + 1); }

/** 光标覆盖的源码行号集合（这些行按 P1 规则显示原始语法） */
function cursorLines(state) {
  const set = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

/** 解析嵌入 raw（`名字|宽度` 里的内容）→ { name, width, isImage, isAsset, src } */
function parseEmbed(raw, opts) {
  const name = raw.split('|')[0].replace(/#.*$/, '').trim();
  const alias = raw.split('|')[1];
  const width = Number.parseInt(alias, 10);
  const isImage = (opts.isImage ?? ((n) => DEFAULT_IMG_RE.test(n)))(name);
  const isAsset = (opts.isAsset ?? ((n) => DEFAULT_ASSET_RE.test(n)))(name);
  const src = opts.resolveImage?.(name) ?? null;
  return { name, width: Number.isFinite(width) && width > 0 ? width : 0, isImage, isAsset, src };
}

/* ================= ① 图片嵌入 widget（块级，StateField） ================= */

class ImageEmbedWidget extends WidgetType {
  constructor(embed, from, onImageClick) {
    super();
    this.embed = embed;
    this.from = from;
    this.onImageClick = onImageClick || null;
  }
  eq(o) { return o.from === this.from && o.embed.raw === this.embed.raw && o.embed.src === this.embed.src; }
  get estimatedHeight() { return this.embed.isImage ? (this.embed.width ? Math.min(this.embed.width * 0.62, 900) : 240) : 36; }
  toDOM(view) {
    const { name, width, isImage, src } = this.embed;
    const fig = document.createElement('figure');
    fig.className = 'cm-lp-img' + (isImage ? ' embed-image' : ' embed-file');
    fig.contentEditable = 'false';
    fig.dataset.name = name;
    fig.dataset.target = this.embed.raw;   // 与块级渲染同口径：右键菜单「复制路径/删除图片」靠它
    fig.dataset.from = String(this.from);   // 供 setImageWidth / removeImageAt 定位
    if (!isImage) { fig.textContent = `📎 ${name}`; return fig; }
    if (!src) { fig.innerHTML = `<div class="cm-lp-img-missing">图片不存在：<code>${name}</code></div>`; return fig; }
    const img = document.createElement('img');
    img.src = src; img.alt = name; img.draggable = false; img.loading = 'lazy';
    if (width) { img.style.width = `${width}px`; img.style.maxWidth = '100%'; }
    const grip = document.createElement('span');
    grip.className = 'cm-lp-img-grip';
    grip.title = '拖动调整宽度（双击还原）';
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX;
      // 用「逻辑宽度」（style.width）当基准，比 getBoundingClientRect 稳（图片可能未加载）
      const specified = Number.parseInt(img.style.width, 10);
      const startW = Number.isFinite(specified) && specified > 0 ? specified : img.getBoundingClientRect().width;
      const move = (ev) => {
        const w = Math.round(Math.min(1200, Math.max(80, startW + ev.clientX - startX)));
        img.style.width = `${w}px`; img.style.maxWidth = '100%';
        grip.dataset.w = String(w);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const w = Number(grip.dataset.w);
        // 拖完才写 doc（事务 → CM 重新测量并锚定滚动，P0 结论 2）
        if (w > 0) setEmbedWidth(view, this.from, w);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    grip.addEventListener('dblclick', (e) => { e.stopPropagation(); img.style.width = ''; setEmbedWidth(view, this.from, 0); });
    grip.addEventListener('click', (e) => e.stopPropagation());
    // 点图片本体 → 灯箱（对齐 editor.js 的 onImageClick）
    fig.addEventListener('click', (e) => { e.stopPropagation(); this.onImageClick?.(src, name); });
    fig.append(img, grip);
    return fig;
  }
  // 不实现 ignoreEvent（默认 false）；拖宽手柄自己 stopPropagation，不让 CM 抢走指针事件。
}

/* ---------- ①b 行内图片 widget（`前缀 ![[图]] 后缀` / `![](路径)`） ----------
 * 背景（7.11 结论 4）：块级嵌入只认「整行就是一个 ![[..]]」，行内的只渲染成文字标记、
 * 不出图；`![](路径)` 更是完全不渲染。补法是**行内 replace widget**（内联替换走 ViewPlugin
 * 即可，不需要 StateField——只有会改变行高的**块级** replace 才必须走 StateField）。
 *
 * 三条与块级 widget 一致的口径：
 *   - 恒定显示，不套「光标行露源码」（P3 结论 1：StateField/行内 widget 的选区重建刷新时机
 *     不可靠，套上去会闪；图片本来也不需要「点进去改语法」）；
 *   - 拖宽只在 pointerup 时 dispatch 一次 doc 变更（P0 结论 2：原地改 DOM 会被 CM 测量抢锚点）；
 *   - 拖宽基准用 `img.style.width`（逻辑宽度），图未加载时 rect 可能是 0（P3 结论 5）。 */
class InlineImageWidget extends WidgetType {
  /** @param embed {raw,name,width,src,isImage,wiki} */
  constructor(embed, from, onImageClick) {
    super();
    this.embed = embed;
    this.from = from;
    this.onImageClick = onImageClick || null;
  }
  eq(o) { return o.from === this.from && o.embed.raw === this.embed.raw && o.embed.src === this.embed.src; }
  toDOM(view) {
    const { name, width, src, raw, wiki } = this.embed;
    const box = document.createElement('span');
    box.className = 'cm-lp-img cm-lp-img-inline embed-image';
    box.contentEditable = 'false';
    box.dataset.name = name;
    // `![[..]]` 的 target 就是 token 内容（`名字|宽`）；`![](路径)` 的 target 用 URL 本身
    // ——右键菜单「复制路径/删除图片」都按它解析，塞整个 `![alt](url)` 会解析不出来。
    box.dataset.target = wiki ? raw : name;
    box.dataset.from = String(this.from);
    if (!src) {
      box.classList.add('cm-lp-img-missing');
      box.textContent = `🖼 ${name}（未找到）`;
      return box;
    }
    const img = document.createElement('img');
    img.src = src; img.alt = name; img.draggable = false; img.loading = 'lazy';
    // 行内 widget 没有 estimatedHeight（图片尺寸要等加载才知道），图加载完行高会变 →
    // 必须请 CM 重测一次，否则行号槽会停在「图还没加载」时的旧位置（实测行号挤在图中间）。
    img.addEventListener('load', () => { try { view.requestMeasure(); } catch { /* view 已销毁 */ } });
    if (wiki) img.dataset.embed = name;
    else { img.dataset.mdSrc = name; img.classList.add('md-image'); }
    if (width) { img.style.width = `${width}px`; img.style.maxWidth = '100%'; }
    // 点图 → 灯箱（与块级内核 onImageClick 同口径）
    box.addEventListener('click', (e) => { e.stopPropagation(); this.onImageClick?.(src, name); });
    box.append(img);
    // 只有 `![[..]]` 支持 `|宽`；`![](路径)` 的语法里没有宽度位，不给手柄（拖了也没地方写）
    if (wiki) {
      const grip = document.createElement('span');
      grip.className = 'cm-lp-img-grip cm-lp-img-grip-inline';
      grip.title = '拖动调整宽度（双击还原）';
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX;
        const specified = Number.parseInt(img.style.width, 10);
        const startW = Number.isFinite(specified) && specified > 0 ? specified : img.getBoundingClientRect().width;
        const move = (ev) => {
          const w = Math.round(Math.min(1200, Math.max(80, startW + ev.clientX - startX)));
          img.style.width = `${w}px`; img.style.maxWidth = '100%';
          grip.dataset.w = String(w);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          const w = Number(grip.dataset.w);
          if (w > 0) setEmbedWidth(view, this.from, w);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      grip.addEventListener('dblclick', (e) => { e.stopPropagation(); img.style.width = ''; setEmbedWidth(view, this.from, 0); });
      grip.addEventListener('click', (e) => e.stopPropagation());
      box.append(grip);
    }
    return box;
  }
  ignoreEvent() { return true; }   // 点击只走灯箱，不让 CM 把光标塞进 widget
}

/** 改写某个嵌入的宽度（0 = 去掉尺寸），走 doc 事务。与 editor.js setImageWidth 同口径。
 *  `pos` 指向 token 起点：整行嵌入传行首、行内嵌入传 token 起点（widget 的 dataset.from）。
 *  只替换 `![[..]]` 这一段，**前后文字原样保留**——行内嵌入写宽度不能吃掉邻居。 */
export function setEmbedWidth(view, pos, width) {
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  const m = /^\s*!\[\[([^\]\n]+)\]\]/.exec(doc.sliceString(pos, line.to));
  if (!m) return false;
  const lead = m[0].indexOf('![[');
  const from = pos + lead;
  const to = from + (m[0].length - lead);
  const name = m[1].split('|')[0].replace(/#.*$/, '').trim();
  const next = width > 0 ? `![[${name}|${Math.round(width)}]]` : `![[${name}]]`;
  if (doc.sliceString(from, to) === next) return true;
  view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' });
  return true;
}

/* ---------- 笔记嵌入卡片（异步解析，走 StateEffect） ----------
 * `![[笔记名]]`（非附件扩展名）→ 卡片。内容解析是异步的（P4 接 Api.note），所以：
 *   ① 用 StateEffect `noteLoaded` 把「名字 → markdown」塞进 `noteCache` StateField；
 *   ② 嵌入 StateField 在收到该 effect 时重建装饰 → 新 widget（eq 带上 md）→ DOM 重渲染；
 *   ③ 首次渲染没有内容时显示「加载中…」并触发一次解析（模块级 pending 去重）。 */
const noteLoaded = StateEffect.define();

export const noteCache = StateField.define({
  create: () => new Map(),
  update(map, tr) {
    let next = map;
    for (const e of tr.effects) {
      if (e.is(noteLoaded)) { next = new Map(next); next.set(e.value.name, e.value.md); }
    }
    return next;
  },
});

class NoteEmbedWidget extends WidgetType {
  constructor({ name, from, md }) { super(); this.name = name; this.from = from; this.md = md; }
  eq(o) { return o.name === this.name && o.from === this.from && o.md === this.md; }
  get estimatedHeight() { return 140; }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'cm-lp-note';
    box.contentEditable = 'false';
    box.dataset.name = this.name;
    box.dataset.from = String(this.from);
    if (this.md == null) {
      box.innerHTML = `<div class="cm-lp-note-loading">加载中… ${this.name}</div>`;
      this.load?.(view);      // 首次渲染时触发解析（load 由 embedWidgets 注入）
      return box;
    }
    const head = document.createElement('div');
    head.className = 'cm-lp-note-title';
    head.textContent = `📄 ${this.name}`;
    const body = document.createElement('div');
    body.className = 'cm-lp-note-body';
    body.appendChild(renderMarkdown(this.md, { tagOffsets: false }));
    box.append(head, body);
    return box;
  }
  ignoreEvent() { return true; }   // 卡片内容只读（要编辑请点开原笔记）
}

/** 图片 / 附件 / 笔记卡片三合一的嵌入装饰（块级，必须 StateField）。
 *  注意：块级 widget **不套用「光标行显示原始语法」规则**——StateField 的选区重建
 *  在 CM6 里不会像 ViewPlugin 那样即时反映到 DOM（实测：create 时默认光标在第 1 行，
 *  会让该行图片被跳过且其后选区重建也不刷新）。块级嵌入恒定显示，保证确定性。 */
export function embedWidgets(opts = {}) {
  const pending = new Set();
  const load = (view, name) => {
    if (pending.has(name) || !opts.loadNote) return;
    pending.add(name);
    Promise.resolve(opts.loadNote(name))
      .then((md) => { pending.delete(name); if (md != null && view.dom.isConnected) view.dispatch({ effects: noteLoaded.of({ name, md }) }); })
      .catch(() => pending.delete(name));
  };
  const build = (state) => {
    const { blocks } = parseCached(state);
    const cache = state.field(noteCache, false) || null;
    const b = new RangeSetBuilder();
    for (const blk of blocks) {
      if (blk.type !== 'paragraph' || blk.line !== blk.endLine) continue;
      const m = EMBED_LINE_RE.exec(blk.text.trim());
      if (!m) continue;
      const emb = parseEmbed(m[1], opts);
      const line = docLine(state, blk.line);
      if (line.from >= line.to) continue;
      let widget;
      if (emb.isImage || emb.isAsset) {
        widget = new ImageEmbedWidget({ raw: m[1], ...emb }, line.from, opts.onImageClick);
      } else if (opts.loadNote) {
        widget = new NoteEmbedWidget({ name: emb.name, from: line.from, md: cache?.get(emb.name) ?? null });
        widget.load = (view) => load(view, emb.name);
      } else {
        continue;                    // 既不认附件、又没有解析器 → 保留原始语法
      }
      // 块级 replace 的 range 用 [line.from, line.to)：整行收起成 widget（P1 坑 4）
      b.addRange(line.from, line.to, Decoration.replace({ widget, block: true }));
    }
    return b.finish();
  };
  const embeds = StateField.define({
    create: (state) => build(state),
    update: (value, tr) => ((tr.docChanged || tr.effects.some((e) => e.is(noteLoaded))) ? build(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [noteCache, embeds];
}

/* 兼容旧名（P3 探针与文档用它）：现由 embedWidgets 统一处理图片/附件/笔记 */
export const imageEmbeds = embedWidgets;

/* ================= ② 复选框 widget（行内替换，ViewPlugin） ================= */

class CheckboxWidget extends WidgetType {
  constructor(checked, from) { super(); this.checked = checked; this.from = from; }
  eq(o) { return o.checked === this.checked && o.from === this.from; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-lp-cb';
    box.checked = this.checked;
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const cur = view.state.doc.sliceString(this.from + 1, this.from + 2);
      const next = cur === ' ' ? 'x' : /[xX]/.test(cur) ? ' ' : null;
      if (!next) return;
      view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: next }, userEvent: 'input' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

/* ================= ③④ 行级装饰收集（Callout / 表格 / 列表复选框） =================
 * 产出 {from,to?,cls,kind,always?}：kind = 'line' | 'mark' | 'hide' | 'replace'。
 * always=true 的项不受「光标行显示原始语法」过滤（如表格边框）。 */
class CalloutIconWidget extends WidgetType {
  constructor(type, fallback = '') { super(); this.type = type; this.fallback = fallback; }
  eq(other) { return other.type === this.type && other.fallback === this.fallback; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-lp-callout-icon';
    span.setAttribute('aria-hidden', 'true');
    const paths = {
      tip: '<path d="M9 18h6M10 21h4M8.5 14.5a6 6 0 1 1 7 0L15 17H9z"/>',
      warning: '<path d="M12 3L2 21h20zM12 9v5M12 17v1"/>',
      danger: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
      example: '<path d="M5 4h14v16H5zM9 8h6M9 12h6M9 16h4"/>',
      note: '<path d="M4 16l-1 5 5-1L21 7l-4-4zM14 6l4 4"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
    };
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[this.type] || paths.info}</svg>`;
    if (this.fallback) span.appendChild(document.createTextNode(this.fallback));
    return span;
  }
  ignoreEvent() { return false; }
}

function walkBlocks(blocks, state, cursor, out) {
  for (const b of blocks) {
    switch (b.type) {
      case 'callout': {
        for (let n = b.line; n <= b.endLine; n++) {
          const line = docLine(state, n);
          const edges = `${n === b.line ? ' cm-lp-callout-first' : ''}${n === b.endLine ? ' cm-lp-callout-last' : ''}${cursor.has(n + 1) ? ' cm-lp-callout-source' : ''}`;
          out.push({ from: line.from, cls: `cm-lp-callout cm-lp-callout-${b.calloutType}${edges}`, kind: 'line', always: true });
          out.push({ from: line.from, cls: n === b.line ? 'cm-lp-callout-title' : 'cm-lp-callout-body', kind: 'line', always: true });
          if (cursor.has(n + 1)) continue; // 光标行露出原始 `> [!type]`
          // 标题行藏 `> [!type] `（CALLOUT_MARK_RE），正文行只藏 `> `（QUOTE_MARK_RE）
          const q = (n === b.line ? CALLOUT_MARK_RE.exec(line.text) : null) || QUOTE_MARK_RE.exec(line.text);
          if (q) out.push({ from: line.from, to: line.from + q[0].length, kind: 'hide' });
          if (n === b.line && q) {
            const fallback = line.text.slice(q[0].length).trim() ? '' : ({ info: '信息', note: '笔记', tip: '提示', warning: '注意', danger: '警告', example: '示例' }[b.calloutType] || b.calloutType);
            out.push({ from: line.from + q[0].length, kind: 'widget', widget: new CalloutIconWidget(b.calloutType, fallback) });
          }
        }
        if (b.blocks) walkBlocks(b.blocks, state, cursor, out);
        break;
      }
      case 'table': {
        // 行装饰 + **单元格网格**：只藏管道字符、给单元格内容挂 padding/右边线，
        // 文本仍是可编辑的真实行（不整块 replace——那样单元格就点不进去了）。
        out.push({ from: docLine(state, b.header.line).from, cls: 'cm-lp-tbl cm-lp-tbl-head', kind: 'line', always: true });
        for (const r of b.rows) out.push({ from: docLine(state, r.line).from, cls: 'cm-lp-tbl', kind: 'line', always: true });
        const rowLines = [docLine(state, b.header.line), ...b.rows.map((r) => docLine(state, r.line))];
        // 列宽按「整列最长内容」估算一次，各行共用 → 竖线才对得齐（纯 CSS 做不到）
        const colW = tableColWidths(rowLines);
        for (const ln of rowLines) tableCellDecos(ln, out, colW);
        break;
      }
      case 'quote':
        if (b.blocks) walkBlocks(b.blocks, state, cursor, out);
        break;
      case 'list':
        for (const it of b.items) walkItem(it, state, cursor, out);
        break;
      default:
        break; // heading / paragraph / fence / hr / blank 无 P3 新增装饰
    }
  }
}

/** 一行表格 → 「藏掉每个 |」+「给每个单元格挂牌」（pad/右边线靠 CSS）。
 *  为什么不做成 widget：单元格要能直接打字，整块/整格 replace 都会让光标进不去；
 *  mark 只在文本外加一层 span，编辑、选区、Tab 跳格全部保持原生行为。
 *  分隔行（| --- |）不处理——它由 fenceHiding 整行收起。 */
/** 量文本像素宽：用 canvas 按编辑区真实字体量（表头是 600 粗体，必须分开量，
 *  否则「表头比正文宽一点」就会在格子里折行，整行看着像错位）。 */
let measureCtx = null;
let measureFont = '';
function textWidthPx(text, bold = false) {
  try {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const el = document.querySelector('#editor-live .cm-content') || document.getElementById('editor-live');
    const cs = el ? getComputedStyle(el) : null;
    const font = `${bold ? '600 ' : ''}${cs ? cs.fontSize : '16px'} ${cs ? cs.fontFamily : 'sans-serif'}`;
    if (font !== measureFont) { measureCtx.font = font; measureFont = font; }
    return measureCtx.measureText(text).width;
  } catch {
    let w = 0;
    for (const ch of text) {
      if (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch)) w += 15;
      else if (/[A-Za-z0-9]/.test(ch)) w += 8.2;
      else w += 6;
    }
    return bold ? w * 1.05 : w;
  }
}

/** 一列的目标宽度：整列最长内容 + 40px（左右 padding + 边线 + 呼吸）。
 *  **不压缩**：表格比正文列宽时保持自然宽度，靠 CSS 让该行不换行、由
 *  .cm-scroller 出横向滚动条（Obsidian 也是这么做的）。
 *  压缩过的后果是单元格重新折行，看起来像"表格塌了"——比横向滚动难看得多。 */
function tableColWidths(lines) {
  const widths = [];
  lines.forEach((line, idx) => {
    const pipes = linePipes(line.text);
    for (let k = 0; k + 1 < pipes.length; k++) {
      const text = line.text.slice(pipes[k] + 1, pipes[k + 1]).trim();
      widths[k] = Math.max(widths[k] || 0, textWidthPx(text, idx === 0));
    }
  });
  return widths.map((w) => Math.round(Math.min(460, Math.max(76, w + 40))));
}

function linePipes(text) {
  const pipes = [];
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '|' && text[k - 1] !== '\\') pipes.push(k);
  }
  return pipes;
}

function tableCellDecos(line, out, colW) {
  if (!line || !line.text.includes('|')) return;
  const pipes = linePipes(line.text);
  if (pipes.length < 2) return;
  for (const p of pipes) out.push({ from: line.from + p, to: line.from + p + 1, kind: 'hide', always: true });
  for (let k = 0; k + 1 < pipes.length; k++) {
    const from = line.from + pipes[k] + 1;
    const to = line.from + pipes[k + 1];
    if (to <= from) continue;
    const cls = 'cm-lp-cell'
      + (k === 0 ? ' cm-lp-cell-first' : '')
      + (k + 1 === pipes.length - 1 ? ' cm-lp-cell-last' : '');
    const w = colW?.[k];
    out.push({ from, to, kind: 'mark', cls, always: true, attrs: w ? { style: `width:${w}px` } : undefined });
  }
}

function walkItem(item, state, cursor, out) {
  if (item.task != null) {
    const line = docLine(state, item.startLine);
    const m = TASK_MARK_RE.exec(line.text);
    if (m && !cursor.has(line.number)) {
      const from = line.from + m[1].length;          // `[` 的位置
      out.push({ from, to: from + 3, kind: 'replace', widget: new CheckboxWidget(m[2].toLowerCase() === 'x', from) });
    }
  }
  if (item.children) for (const c of item.children) walkItem(c, state, cursor, out);
}

/* ---------- ③ 行内图片扫描（`文字 ![[图]] 文字` / `![](路径)`） ----------
 * 与 widgetsPlugin 同一帧产出（同一份视口作用域），只是描述符带 always:true——
 * 图片恒定显示，不受「光标行露源码」过滤。 */
const MD_IMG_RE = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
const INLINE_EMBED_RE = /!\[\[([^\]]+)\]\]/g;
const WHOLE_EMBED_LINE_RE = /^\s*!\[\[[^\]]+\]\]\s*$/;

/** 该位置是否落在行内代码的反引号里（奇偶判断，够用且零成本） */
function inInlineCode(text, idx) {
  let n = 0;
  for (let i = 0; i < idx; i++) if (text[i] === '`') n++;
  return n % 2 === 1;
}

/** `![alt](url "title")` → { url, src }；相对路径按仓库文件解析（与 markdown.js inlineToHtml 同口径） */
function mdImageSrc(inner, opts) {
  let url = String(inner || '').trim().replace(/^<|>$/g, '');
  const tm = url.match(/^(.*?)\s+"[^"]*"$/);   // 去掉可选的 title
  if (tm) url = tm[1].trim();
  if (!url) return null;
  if (/^(https?:|data:|blob:)/i.test(url)) return { url, src: url };
  let plain = url;
  try { plain = decodeURI(url); } catch { /* 保留原样 */ }
  if (opts.resolveMdImage) return { url, src: opts.resolveMdImage(url, plain) };
  const resolved = opts.resolveFile?.(plain);
  const target = resolved || plain;
  return { url, src: opts.fileUrl?.(target) ?? target };
}

function inlineImageDecos(state, lo, hi, opts, out) {
  const { blocks } = parseCached(state);
  const skip = new Set();
  const walk = (bs) => {
    for (const b of bs) {
      // 代码块里的 `![[..]]` 只是代码文本，不能出图
      if (b.type === 'fence') { for (let n = b.line; n <= b.endLine; n++) skip.add(n + 1); }
      // 整行嵌入由块级 widget 接管（重复挂会在同一区间叠两个 replace）
      else if (b.type === 'paragraph' && b.line === b.endLine && WHOLE_EMBED_LINE_RE.test(b.text)) skip.add(b.line + 1);
      if (b.blocks) walk(b.blocks);
    }
  };
  walk(blocks);
  const isImage = opts.isImage ?? ((n) => DEFAULT_IMG_RE.test(n));
  const firstLine = state.doc.lineAt(Math.max(0, Math.min(lo, state.doc.length))).number;
  const lastLine = state.doc.lineAt(Math.max(0, Math.min(hi, state.doc.length))).number;
  for (let n = firstLine; n <= lastLine; n++) {
    if (skip.has(n)) continue;
    const line = state.doc.line(n);
    const text = line.text;
    if (text.indexOf('![') < 0) continue;
    INLINE_EMBED_RE.lastIndex = 0;
    let m;
    while ((m = INLINE_EMBED_RE.exec(text))) {
      if (inInlineCode(text, m.index)) continue;
      const raw = m[1];
      const name = raw.split('|')[0].replace(/#.*$/, '').trim();
      if (!isImage(name)) continue;   // 非图片嵌入：仍由 decorations.js 挂牌成 `.cm-lp-embed` 文字标记
      const emb = parseEmbed(raw, opts);
      if (!emb.src) continue;         // 找不到文件 → 保留原始语法（比渲染一个坏图框有用）
      const from = line.from + m.index;
      out.push({
        from, to: from + m[0].length, kind: 'replace', always: true,
        // raw 用 token **内容**（`名字|宽`），与块级 widget 的 dataset.target 同口径
        widget: new InlineImageWidget({ raw, ...emb, wiki: true }, from, opts.onImageClick),
      });
    }
    MD_IMG_RE.lastIndex = 0;
    while ((m = MD_IMG_RE.exec(text))) {
      if (inInlineCode(text, m.index)) continue;
      const info = mdImageSrc(m[2], opts);
      if (!info || !info.src) continue;
      const from = line.from + m.index;
      out.push({
        from, to: from + m[0].length, kind: 'replace', always: true,
        widget: new InlineImageWidget(
          { raw: m[0], name: info.url, width: 0, src: info.src, isImage: true, isAsset: false, wiki: false },
          from, opts.onImageClick,
        ),
      });
    }
  }
}

/** 行级装饰插件（视口作用域）：Callout 色条/藏标记、表格边框、列表复选框、行内图片 */
export function widgetsPlugin(opts = {}) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet
        || u.transactions.some((tr) => tr.annotation(refreshLivePreview))) this.decorations = this.build(u.view);
    }
    build(view) {
      const state = view.state;
      let blocks;
      try { ({ blocks } = parseCached(state)); } catch (e) { console.error('[widgets] parse 崩溃:', e.message); return Decoration.none; }
      // 阅读模式没有「光标行」概念：复选框、隐藏标记一律照常渲染（= 剥离源码后的成品）
      const cursor = opts.readOnly ? new Set() : cursorLines(state);
      const raw = [];
      const spans = [];
      try {
        walkBlocks(blocks, state, cursor, raw);
        const lo = view.visibleRanges[0]?.from ?? 0;
        const hi = view.visibleRanges[view.visibleRanges.length - 1]?.to ?? state.doc.length;
        inlineImageDecos(state, lo, hi, opts, raw);
        for (const d of raw) {
          const to = d.to ?? d.from;
          // 防御（P1 坑 1）：一个非法 range 会让整个插件被 CM6 禁用
          if (!Number.isFinite(d.from) || !Number.isFinite(to) || d.from < 0 || to > state.doc.length) continue;
          if (to < lo || d.from > hi) continue;
          if (!d.always && d.kind !== 'line' && cursor.has(state.doc.lineAt(d.from).number)) continue;
          if (d.kind === 'line') spans.push(Decoration.line({ class: d.cls }).range(d.from));
          else if (d.kind === 'widget') spans.push(Decoration.widget({ widget: d.widget, side: -1 }).range(d.from));
          else if (d.kind === 'mark') spans.push(Decoration.mark({ class: d.cls, attributes: d.attrs }).range(d.from, to));
          else if (d.kind === 'replace') spans.push(Decoration.replace({ widget: d.widget }).range(d.from, to));
          else if (d.from < to) spans.push(Decoration.replace({}).range(d.from, to));
        }
        return Decoration.set(spans, true);
      } catch (e) {
        console.error('[widgets] build 崩溃，本帧放弃装饰:', e && e.stack || e);
        return Decoration.none;
      }
    }
  }, { decorations: (v) => v.decorations });
}

/* ================= ⑤ 双链 / 标签：hover + 点击 =================
 * 复用 P1 在行内加的 `.cm-lp-wikilink` / `.cm-lp-tag` span；这里只挂事件回调，
 * P4 接 editor.js 的 _openWikilink / _schedulePreview / onTagClick。 */
export function linkEvents({ onOpenWikilink, onHoverWikilink, onTagClick } = {}) {
  return EditorView.domEventHandlers({
    // 左键按下时必须拦在 CM 自己的选区处理之前（按钮按住不放的那一下）。
    // 为什么非拦不可：浏览器默认的 mousedown 会把光标落到点击处 → 本行变成「光标行」，
    // 装饰规则随即撤掉该行的 mark/hide（露出原始 `[[ ]]` 语法），`.cm-lp-wikilink` /
    // `.cm-lp-tag` 这两个 span 被 CM 重建 DOM 时拆掉；紧接着派发的 click 事件就再也
    // closest 不到它们 —— 表现就是「用鼠标点双链毫无反应」。实测确认：真实鼠标点击永远
    // 跳不过去，而测试里合成 `span.click()` 却能过（它不触发 mousedown）。
    // 拦下后选区不动、span 保持存在，随后的 click 正常命中并跳转/搜索。
    mousedown(event) {
      if (event.button !== 0) return false;      // 右键交给菜单，不动
      const t = event.target;
      if (t.closest?.('.cm-lp-wikilink') || t.closest?.('.cm-lp-tag')) {
        event.preventDefault();
        return true;                              // 同时阻止 CM 把选区设到点击处
      }
      return false;
    },
    click(event) {
      const link = event.target.closest?.('.cm-lp-wikilink');
      if (link) { event.preventDefault(); onOpenWikilink?.(link.textContent, event); return true; }
      const tag = event.target.closest?.('.cm-lp-tag');
      if (tag) { event.preventDefault(); onTagClick?.(tag.textContent, event); return true; }
      return false;
    },
    mouseover(event) {
      const link = event.target.closest?.('.cm-lp-wikilink');
      if (link) onHoverWikilink?.(link.textContent, link, event);
      return false;   // hover 不拦，别影响 CM 自身处理
    },
  });
}

/* ================= 装配 ================= */

/** P3 扩展集合。opts: { resolveImage(name)->url|null, resolveMdImage(url,plain)->url|null,
 *  isImage, isAsset, loadNote(name)->md|Promise, onImageClick, onOpenWikilink, onHoverWikilink, onTagClick } */
export function widgetExtensions(opts = {}) {
  return [
    ...embedWidgets(opts),
    widgetsPlugin(opts),
    linkEvents(opts),
  ];
}
