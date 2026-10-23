/**
 * public/js/cm/decorations.js — CM6 实时预览装饰生成器（P1 只读渲染）
 * ------------------------------------------------------------------
 * 输入 EditorState（doc 就是笔记全文），输出 DecorationSet。
 * 块级结构复用 markdown.js 的 parseMarkdown——和现有块级渲染同一份解析，
 * 不会出现「渲染一套、装饰另一套」的漂移。行内 span 用同款正则现场扫
 * （装饰只要区间，不需要 HTML；inlineToHtml 的 stash 链保持不动）。
 *
 * P0 实测结论（EDITOR-MIGRATION.md 7.1，Obsidian bundle 同款架构）：
 *   - 块级 replace（围栏行隐藏）必须挂 StateField，ViewPlugin 里直接抛
 *     "Block decorations may not be specified via plugins"；
 *   - 行内 mark / 行装饰走 ViewPlugin（视口作用域、便宜）。
 *
 * 光标行规则（Obsidian 同款，验收项 4）：光标所在行显示原始语法标记
 * （#、**、>、``` 全露出），离开即隐藏。P2 把它接进编辑器交互。
 *
 * P1 覆盖：标题、粗体/斜体/删除线/高亮/行内代码、双链/嵌入/标签、
 * 列表、引用、代码块（围栏隐藏）、分割线、表格（行装饰；完整表格是 P3）。
 */
import { parseMarkdown, codeTokens } from '../markdown.js';
import { inlineMath } from '../math.js';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { Annotation, StateField } from '@codemirror/state';

/* ================= 行内 span 扫描（装饰用，只求区间） =================
 * 顺序与 inlineToHtml 的行内链一致：代码/嵌入/双链优先（它们的内部不再
 * 解析），然后加粗、斜体、删除线、高亮、标签。已占用区间不重复挂牌，
 * 对应 inlineToHtml 的 stash 语义。
 * marker = 首尾要藏掉的标记字符数（Obsidian 行为：藏 ** 、藏 ` 、藏 [[]]，
 * 只给内容上样式）；marker=0 的（#标签）整段挂牌。 */
const INLINE_PATTERNS = [
  { re: /`([^`\n]+)`/g, cls: 'cm-lp-code', marker: 1 },
  { re: /<u>([^\n]*?)<\/u>/gi, cls: 'cm-lp-underline', head: 3, tail: 4 },
  // `![[x]]` 的开闭标记长度不对称（`![[` = 3、`]]` = 2），不能用单一 marker：
  // 早先写成 marker:4 会把名字的首尾各吃掉一个字（实测 `![[常用代码]]` 只显示「用」）。
  // 这里用 head/tail 分开声明；图片类嵌入由 widgets.js 的行内图片 widget 接管（见 embed 标记）。
  { re: /!\[\[([^\]]+)\]\]/g, cls: 'cm-lp-embed', head: 3, tail: 2, embed: true },
  { re: /\[\[([^\]]+)\]\]/g, cls: 'cm-lp-wikilink', marker: 2, link: true },
  { re: /\*\*([^*]+)\*\*/g, cls: 'cm-lp-bold', marker: 2 },
  { re: /__([^_]+)__/g, cls: 'cm-lp-bold', marker: 2 },
  { re: /\*([^*\n]+)\*/g, cls: 'cm-lp-em', marker: 1 },
  { re: /(^|[\s(（])_([^_\n]+)_(?=$|[\s).，。！？、；:])/g, cls: 'cm-lp-em', marker: 1, inner: 2 },
  { re: /~~([^~]+)~~/g, cls: 'cm-lp-del', marker: 2 },
  { re: /==([^=]+)==/g, cls: 'cm-lp-mark', marker: 2 },
  { re: /(^|[\s(（])(#[\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu, cls: 'cm-lp-tag', marker: 0, inner: 2 },
];

/** 默认图片判定（与 widgets.js 同口径；调用方可用 opts.isImage 覆盖） */
const DEFAULT_IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const isImageName = (n) => DEFAULT_IMG_RE.test(String(n || '').split('|')[0].split('#')[0].trim());

/** 在 text（doc 中从 base 开始的片段）里扫行内装饰：
 *  marker/head+tail>0 → 首尾标记各推一个 hide + 内容区间推一个 mark；
 *  marker=0 → 整段推一个 mark。
 *  opts.isImage 命中的 `![[..]]` **不挂牌**——留给 widgets.js 的行内图片 widget 整段 replace。 */
function scanInline(text, base, out, opts = {}) {
  const consumed = inlineMath(text).map(math => [math.from, math.to]);
  const overlaps = (s, e) => consumed.some(([a, b]) => s < b && a < e);
  const isImage = opts.isImage || isImageName;
  const resolveLink = opts.resolveLink;
  for (const p of INLINE_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      let s, e;
      if (p.inner) { s = m.index + m[1].length; e = s + m[2].length; }
      else { s = m.index; e = m.index + m[0].length; }
      if (overlaps(s, e)) {
        // 关键：拒绝重叠匹配后必须把 lastIndex 回退到匹配起点+1 继续找。
        // 否则正则位置已经跳过假匹配，后面真正的匹配（如 **粗** 内部的 * 假匹配
        // 会吃掉随后的 *斜体*）永远扫不到。inlineToHtml 用 stash 替换文本所以没这个问题。
        p.re.lastIndex = m.index + 1;
        continue;
      }
      consumed.push([s, e]);
      // 图片嵌入：整段交给行内 widget（此处占用区间，避免 [[..]] 双链规则重复命中）
      if (p.embed && isImage(String(m[1] || '').split('|')[0].split('#')[0].trim())) continue;
      // 双链的解析结果决定 cls：未解析补 `cm-lp-unresolved`（与块级 .wikilink.unresolved 对齐）
      let cls = p.cls;
      if (p.link && resolveLink) {
        const target = String(m[1] || '').trim();
        let resolved = null;
        try { resolved = resolveLink(target); } catch { resolved = null; }
        if (!resolved) cls += ' cm-lp-unresolved';
      }
      const head = p.head ?? p.marker ?? 0;
      const tail = p.tail ?? p.marker ?? 0;
      if (head > 0 && e - s > head + tail) {
        out.push({ from: base + s, to: base + s + head, cls: '', kind: 'hide' });
        out.push({ from: base + e - tail, to: base + e, cls: '', kind: 'hide' });
        out.push({ from: base + s + head, to: base + e - tail, cls, kind: 'mark' });
      } else {
        out.push({ from: base + s, to: base + e, cls, kind: 'mark' });
      }
    }
  }
}

/* ================= 解析缓存（doc 不变不重扫） ================= */
const parseCache = { doc: null, parse: null };
export function parseCached(state) {
  const text = state.doc.toString();
  if (parseCache.doc !== text) {
    parseCache.doc = text;
    parseCache.parse = parseMarkdown(text);
  }
  return parseCache.parse;
}

/** 光标覆盖的源码行号集合（这些行显示原始语法） */
function cursorLines(state) {
  const set = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

const QUOTE_MARK_RE = /^(\s*>\s?)/;

/** AST 描述符的行号是 0-based（lines[] 下标），CM 的 doc.line(n) 是 1-based——
 *  所有跨 API 的取行都必须过这个转换，否则装饰整体挂歪一行。 */
function docLine(state, lineIdx0) { return state.doc.line(lineIdx0 + 1); }

/* ================= 装饰收集 =================
 * 产出 {from, to, cls, kind}：kind = 'line'（行装饰，点区间）/
 * 'mark'（行内挂牌）/ 'hide'（替换为空）。 */
function collectBlockDecos(blocks, state, cursor, out, opts = {}) {
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        out.push({ from: state.doc.lineAt(b.lineStart).from, cls: `cm-lp-h${b.level}`, kind: 'line' });
        if (!cursor.has(b.line + 1)) {
          out.push({ from: b.lineStart, to: b.contentStart, cls: '', kind: 'hide' }); // 藏 # 前缀
        }
        scanInline(b.text, b.contentStart, out, opts);
        break;
      }
      case 'paragraph':
        // 整行就是一个嵌入（![[...]]）——P3 交给 widgets.js 的块级 widget 接管，
        // 这里不再挂行内装饰（否则行内 mark 与整行 block replace 重叠，可能被 CM 判为冲突）
        if (b.line === b.endLine && /^\s*!\[\[[^\]]+\]\]\s*$/.test(b.text)) break;
        if (b.sourceSegments) for (const segment of b.sourceSegments) scanInline(segment.text, segment.from, out, opts);
        else scanInline(b.text, b.lineStart, out, opts);
        break;
      case 'list':
        for (const it of b.items) collectItemDecos(it, state, out, opts);
        break;
      case 'quote': {
        for (let n = b.line; n <= b.endLine; n++) {
          const line = docLine(state, n);
          if (opts.quoteLines.has(line.from)) continue;
          opts.quoteLines.add(line.from);
          const m = /^(?:[ \t]*>[ \t]?)+/.exec(line.text);
          const depth = (m?.[0].match(/>/g) || []).length;
          out.push({ from: line.from, cls: 'cm-lp-quote', attrs: { style: `--cm-quote-depth:${Math.max(1, depth)}` }, kind: 'line' });
          if (cursor.has(n + 1)) continue;
          if (m) out.push({ from: line.from, to: line.from + m[0].length, cls: '', kind: 'hide' });
        }
        collectBlockDecos(b.blocks, state, cursor, out, opts);
        break;
      }
      case 'callout':
        collectBlockDecos(b.blocks, state, cursor, out, opts);
        break;
      case 'fence': {
        const active = [...cursor].some(n => n >= b.line + 1 && n <= b.endLine + 1);
        const first = active ? b.line : Math.min(b.line + 1, b.endLine);
        const last = active || !b.closed ? b.endLine : Math.max(first, b.endLine - 1);
        for (let n = first; n <= last; n++) {
          const line = docLine(state, n);
          const cls = `cm-lp-code-line${n === first ? ' cm-lp-code-first' : ''}${n === last ? ' cm-lp-code-last' : ''}`;
          out.push({ from: line.from, cls, attrs: n === first ? { 'data-language': b.lang || 'text' } : {}, kind: 'line' });
          if (n === b.line || (b.closed && n === b.endLine)) continue;
          const lead = /^(?:[ \t]*>[ \t]?)+/.exec(line.text)?.[0].length || 0;
          for (const token of codeTokens(line.text.slice(lead), b.lang.toLowerCase())) out.push({ from: line.from + lead + token.from, to: line.from + lead + token.to, cls: token.cls, kind: 'mark', always: true });
        }
        break;
      }
      case 'hr':
        out.push({ from: state.doc.lineAt(b.lineStart).from, cls: 'cm-lp-hr', kind: 'line' });
        if (!cursor.has(b.line + 1)) {
          out.push({ from: b.lineStart, to: b.lineEnd, cls: '', kind: 'hide' });
        }
        break;
      case 'table': {
        // 分隔行（header 下面那一行）由 fenceHiding StateField 做块级收起——
        // 内联替换只删文字不塌行高，块替换必须挂 StateField（P0 结论）。
        // 行装饰：表头/数据行的底色；网格（藏 `|` + 单元格 padding）由 widgets.js 负责。
        out.push({ from: docLine(state, b.header.line).from, cls: 'cm-lp-tr cm-lp-tr-head', kind: 'line' });
        for (const r of b.rows) {
          out.push({ from: docLine(state, r.line).from, cls: 'cm-lp-tr', kind: 'line' });
        }
        // **单元格里的行内语法也要渲染**（2026-10-20 用户报障：格子里的 `[[双链]]`、`` `代码` ``、
        // `**粗**`、`#标签` 全是源码样式，双链点不动）。此前表格只挂了行装饰，没人扫格子内部。
        // AST 的 contentStart 指向「未 trim 的片段起点」，真实文本起点要跳过前导空白才对齐。
        for (const cell of [...b.header.cells, ...b.rows.flatMap((r) => r.cells)]) {
          if (!cell.text) continue;
          const raw = state.doc.sliceString(cell.contentStart, Math.min(cell.lineEnd, state.doc.length));
          const lead = raw.length - raw.trimStart().length;
          scanInline(cell.text, cell.contentStart + lead, out, opts);
        }
        break;
      }
      default:
        break; // blank / blank-tail 无装饰
    }
  }
}

/** 无序列表的圆点标记（Obsidian 在实时预览里把 `-`/`*`/`+` 渲染成 `•`，而不是露出源码的横线）。
 *  光标行仍要露源码——build 里的「光标行规则」会跳过这条 replace，两层逻辑正好互补。 */
class BulletWidget extends WidgetType {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lp-bullet';
    s.textContent = '•';
    return s;
  }
  eq() { return true; }
}

/** 列表「标记段」的形状：缩进 + 标记字符 + 空格 (+ 可选的任务方括号与空格)。
 *  只认无序标记（`-*+`）——有序列表的 `1.` 要让用户看见真实编号，继续走 muted mark。 */
const LIST_MARKER_RE = /^([ \t]*)([-*+])([ \t]+)(?:\[[ xX]\][ \t]*)?$/;

/** 列表项：标记 muted（有序列表）+ 逐行行内 span + 递归子项。
 *  无序项把标记字符换成圆点、任务项把整个标记段去掉（复选框就是它的标记）——
 *  「说话式」的说明见上面 BulletWidget 的注释。
 *  续言行的 base 按「源码行行首 + 该行缩进」算——scanList 把续言缩进剥掉过，
 *  但 doc 里原行还在，逐行对着 doc 扫才挂得上。 */
function collectItemDecos(item, state, out, opts = {}) {
  const line = item.lineStart != null ? state.doc.lineAt(Math.max(0, Math.min(item.lineStart, state.doc.length))) : null;
  const raw = line ? state.doc.sliceString(item.lineStart, Math.min(item.contentStart, line.to)) : '';
  const m = LIST_MARKER_RE.exec(raw);
  if (line && m) {
    const from = item.lineStart + m[1].length;          // 跳过缩进（嵌套层级要保住）
    if (item.task != null) {
      // 任务项：标记 + 空格整段去掉；`[ ]` 紧接着被 widgets.js 换成复选框
      out.push({ from, to: from + m[2].length + m[3].length, cls: '', kind: 'hide' });
    } else {
      // 普通无序项：只换掉标记字符，后面的空格留着当间隔（`• 文本`）
      out.push({ from, to: from + m[2].length, kind: 'replace', widget: new BulletWidget() });
    }
  } else {
    out.push({ from: item.lineStart, to: item.contentStart, cls: 'cm-lp-marker', kind: 'mark' });
  }
  const lines = item.text.split('\n');
  for (let k = 0; k < lines.length; k++) {
    if (!lines[k]) continue;
    const srcLine = docLine(state, item.startLine + k);
    if (!srcLine) break;
    const base = k === 0 ? item.contentStart : srcLine.from + (/^\s*/.exec(srcLine.text)?.[0].length ?? 0);
    scanInline(lines[k], base, out, opts);
  }
  if (item.children) for (const c of item.children) collectItemDecos(c, state, out, opts);
}

/* ================= 视图插件：行内 mark + 行装饰 =================
 * 做成工厂是为了把「业务判定」注入进来（引擎零业务 import 的约定）：
 *   opts.isImage(name)      → 图片嵌入交给 widgets.js 的行内 widget，这里不挂牌
 *   opts.resolveLink(name)  → 双链是否需要 `cm-lp-unresolved` 变体类（与块级同口径）
 * 不传 opts 时的行为与 P1 完全一致（探针页仍然这么用）。 */

/** 「链接/文件索引变了，请重建装饰」的注解。
 *  装饰的依赖不只有 doc/选区：`[[双链]]` 是否解析得出、`![[图]]` 能否找到文件，都取决于
 *  app 侧的 nameIndex / 文件树。这两者异步到达（刷新带 150ms 防抖），而 ViewPlugin 只在
 *  doc/视口/选区变化时重建 → 笔记开得太早时链接会一直停在「未解析」、新粘贴的图片不显示。
 *  修法：索引刷新后 dispatch 一个只带注解的空事务，显式让装饰重建。 */
export const refreshLivePreview = Annotation.define();

export function createLivePreview(opts = {}) {
  // 阅读模式：没有「光标行」这回事——所有标记一律隐藏、widget 一律显示（= 剥离源码后的成品）。
  // 不再另写一套装饰，只是把光标集换成空集。
  const cursorOf = opts.readOnly ? () => new Set() : cursorLines;
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = this.build(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet
        || u.transactions.some((tr) => tr.annotation(refreshLivePreview))) {
        this.decorations = this.build(u.view);
      }
    }
    build(view) {
      const state = view.state;
      const { blocks } = parseCached(state);
      const cursor = cursorOf(state);
      const raw = [];
      try {
        collectBlockDecos(blocks, state, cursor, raw, { ...opts, quoteLines: new Set() });
        // 只装饰视口范围（visibleRanges 自带缓冲区；视口外不建 DOM）
        const lo = view.visibleRanges[0]?.from ?? 0;
        const hi = view.visibleRanges[view.visibleRanges.length - 1]?.to ?? state.doc.length;
        const spans = [];
        for (const d of raw) {
          const to = d.to ?? d.from;
          // 防御：偏移缺失/越界的项直接跳过——一个坏装饰不该拖垮整个编辑器
          // （CM6 对崩溃的插件是整体禁用，2026-10-18 实测：hr 描述符漏偏移时全站装饰消失）
          if (!Number.isFinite(d.from) || !Number.isFinite(to) || d.from < 0 || to > state.doc.length) continue;
          if (to < lo || d.from > hi) continue;
          // 光标行规则：mark/hide 在光标行一律不挂（显示原始语法）；行装饰（字号等）照常
          if (!d.always && d.kind !== 'line' && cursor.has(state.doc.lineAt(d.from).number)) continue;
          if (d.kind === 'line') spans.push(Decoration.line({ class: d.cls, attributes: d.attrs }).range(d.from));
          else if (d.kind === 'mark') spans.push(Decoration.mark({ class: d.cls }).range(d.from, to));
          // 带 widget 的替换（列表圆点）：把源码标记换成渲染后的样子
          else if (d.widget && d.from < to) spans.push(Decoration.replace({ widget: d.widget }).range(d.from, to));
          else if (d.from < to) spans.push(Decoration.replace({}).range(d.from, to));
        }
        return Decoration.set(spans, true);
      } catch (e) {
        console.error('[decorations] build 崩溃，本帧放弃装饰:', e.message);
        return Decoration.none;
      }
    }
  }, { decorations: (v) => v.decorations });
}

/** 无注入版本（探针页 / 兼容旧引用） */
export const livePreviewPlugin = createLivePreview();

/* ================= 状态字段：整行收起（块级 replace） =================
 * P0 教训：块级 replace 只能来自 StateField（provide: decorations.from）。
 * 覆盖两类「整行不该占高度」的行：
 *   ① 代码围栏两行（```lang / ```）——光标离开代码块时收起，进入时露出；
 *   ② 表格分隔行（| --- |）——表格行装饰在 ViewPlugin 里，分隔行在这里塌掉。 */

class ZeroWidget extends WidgetType {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-lp-zero';
    return el;
  }
  eq() { return true; }
}

class EmptyCodeWidget extends WidgetType {
  constructor(lang, from, readOnly) { super(); this.lang = lang; this.from = from; this.readOnly = readOnly; }
  eq(other) { return other.lang === this.lang && other.from === this.from && other.readOnly === this.readOnly; }
  toDOM(view) {
    const node = document.createElement('div'); node.className = 'cm-lp-empty-code cm-lp-code-first'; node.dataset.language = this.lang || 'text';
    if (!this.readOnly) node.onmousedown = event => { event.preventDefault(); view.dispatch({ selection: { anchor: this.from } }); view.focus(); };
    return node;
  }
}

const fenceCache = { key: null, set: null };

/** 围栏/表格分隔行是否要「整行收起」——实时预览按光标判断（光标进代码块要露围栏），
 *  阅读模式没有光标概念，永远收起。做成工厂是为了让阅读模式拿一份独立实例（各自缓存）。 */
export function createFenceHiding({ readOnly = false } = {}) {
  return StateField.define({
    create(state) { return buildFenceDecos(state, readOnly); },
    update(value, tr) {
      if (!tr.docChanged && !tr.selectionSet) return value;
      return buildFenceDecos(tr.state, readOnly);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/** 无参实例：探针页与实时预览沿用（行为与加工厂前逐字一致） */
export const fenceHiding = createFenceHiding();

function buildFenceDecos(state, readOnly = false) {
  const cursor = readOnly ? new Set() : cursorLines(state);
  const key = (readOnly ? 'ro|' : 'rw|') + state.doc.toString() + '|' + [...cursor].join(',');
  if (fenceCache.key === key) return fenceCache.set;
  fenceCache.key = key;
  const { blocks } = parseCached(state);
  const spans = [];
  const walk = (bs) => {
    for (const b of bs) {
      if (b.type === 'fence') {
        const cursorIn = [...cursor].some((n) => n >= b.line + 1 && n <= b.endLine + 1);
        if (!cursorIn) {
          if (b.closed && !b.code) {
            const open = docLine(state, b.line), close = docLine(state, b.endLine);
            spans.push(Decoration.replace({ widget: new EmptyCodeWidget(b.lang, open.from, readOnly), block: true }).range(open.from, close.to));
            continue;
          }
          // 围栏两行各自整行收起。块级 replace 的配方是 [line.from, line.to)
          // （不含换行）——早先图省事写成从开围栏到闭围栏的一个大 range，
          // 把代码正文也一起替换没了，行号 8-11 全丢。
          const openLine = docLine(state, b.line);
          const closeLine = docLine(state, b.endLine);
          if (openLine.from < openLine.to) {
            spans.push(Decoration.replace({ widget: new ZeroWidget(), block: true }).range(openLine.from, openLine.to));
          }
          if (b.closed && closeLine.from < closeLine.to && closeLine.number !== openLine.number) {
            spans.push(Decoration.replace({ widget: new ZeroWidget(), block: true }).range(closeLine.from, closeLine.to));
          }
        }
      }
      if (b.type === 'table') {
        // 分隔行（| --- |）**永远收起**：表格在实时预览里是「网格」，把 `---` 露出来
        // 只在光标进表格时闪一下，反而像没渲染好（单元格编辑已由 widgets.js 的网格接管）。
        // 需要改对齐方式时进源码模式（Ctrl+E）。
        const delim = docLine(state, b.header.line + 1);
        if (delim && delim.from < delim.to) {
          spans.push(Decoration.replace({ widget: new ZeroWidget(), block: true }).range(delim.from, delim.to));
        }
      }
      if (b.blocks) walk(b.blocks);
    }
  };
  walk(blocks);
  fenceCache.set = Decoration.set(spans, true);
  return fenceCache.set;
}
