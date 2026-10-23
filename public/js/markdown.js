/**
 * Tracery Markdown 引擎
 *  - renderMarkdown(md)      : Markdown → DOM（编辑器 / 嵌入 / 预览共用）
 *  - serializeHtml(rootEl)   : contenteditable DOM → Markdown（实时预览编辑器回写用）
 *  - domPointToMd(root,node,off) : DOM 光标位置 → Markdown 源码偏移（编辑操作定位用）
 * 支持：标题/列表(含任务)/引用(含 Callout)/代码围栏/表格/分割线/图片/外链/
 *       [[双链]](含 #标题 与 |别名)/![[嵌入]]/#标签/加粗/斜体/删除线/高亮/行内代码
 *
 * 渲染时每个块级元素会打上 data-md-line-start / data-md-content-start 标记，
 * 记录它在 Markdown 源码中的位置，供编辑器把 DOM 光标映射回源码偏移。
 */

import { mathHtml, inlineMath } from './math.js';
import { externalUrl } from './external-link.js';
const INLINE_TOKEN = '\u0001';

/* ================= 代码高亮（轻量自研，够用的范围：注释/字符串/数字/关键字） =================
 * 不引三方库：只做「一眼能分清」的着色，覆盖常用语言即可。
 * 渲染用，序列化仍走 code.textContent，不影响 Markdown 字节。 */
const CODE_KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue new class extends super this typeof instanceof in of try catch finally throw async await yield delete void import export from default static get set null true false undefined this',
  py: 'def class return if elif else for while in not and or is None True False import from as pass raise try except finally with lambda global nonlocal yield assert del break continue async await print self',
  json: 'true false null',
  bash: 'if then else fi for while do done case esac function return local export echo cd ls mkdir rm cp mv cat grep sed awk curl sudo npm node git',
  sql: 'select from where insert into values update set delete join left right inner outer on group by order having limit offset as and or not null distinct count sum avg min max create table drop alter',
};
const LANG_ALIAS = {
  javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', mjs: 'js', cjs: 'js',
  python: 'py', py3: 'py',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  postgresql: 'sql', mysql: 'sql',
};

/** 把代码文本转成带 <span class="tok-*"> 的 HTML（未知语言只转义、不着色） */
export function codeTokens(text, lang) {
  const key = LANG_ALIAS[lang] || lang;
  const kws = CODE_KEYWORDS[key];
  if (!kws) return [];
  const kw = kws.trim().split(/\s+/).join('|');
  // python/bash 用 # 注释；其余用 // 与 /* */
  const comment = key === 'py' || key === 'bash' ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  const str = '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`';
  const re = new RegExp(`(${comment})|(${str})|(\\b\\d+(?:\\.\\d+)?\\b)|\\b(${kw})\\b`, 'g');
  const tokens = [];
  let m;
  while ((m = re.exec(text))) {
    tokens.push({ from: m.index, to: m.index + m[0].length, cls: m[1] ? 'tok-com' : m[2] ? 'tok-str' : m[3] ? 'tok-num' : 'tok-kw' });
  }
  return tokens;
}

export function highlightCode(text, lang) {
  let out = '', last = 0;
  for (const token of codeTokens(text, lang)) {
    out += escapeHtml(text.slice(last, token.from)) + `<span class="${token.cls}">${escapeHtml(text.slice(token.from, token.to))}</span>`;
    last = token.to;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }
function slugify(text) {
  return String(text).trim().toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, 60) || 'h';
}

/* ================= 行内渲染 ================= */
function wikilinkHtml(target, alias, opts) {
  const hashIdx = target.indexOf('#');
  const heading = hashIdx >= 0 ? target.slice(hashIdx + 1) : '';
  const nameOnly = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  const resolved = opts.resolve ? (opts.resolve(nameOnly) || opts.resolve(target)) : null;
  const display = alias || (heading ? `${nameOnly} > ${heading}` : target);
  const cls = resolved ? 'wikilink' : 'wikilink unresolved';
  return `<a class="${cls}" data-target="${escAttr(target)}" data-resolved="${escAttr(resolved || '')}" data-heading="${escAttr(heading)}">${escapeHtml(display)}</a>`;
}

export function inlineToHtml(text, opts = {}) {
  const stash = [];
  const keep = (html) => { stash.push(html); return `${INLINE_TOKEN}${stash.length - 1}${INLINE_TOKEN}`; };
  let prepared = '', lastMath = 0;
  for (const math of inlineMath(text)) {
    prepared += text.slice(lastMath, math.from) + keep(`<span class="md-math" data-math-source="${escapeHtml(text.slice(math.from, math.to))}">${mathHtml(math.tex, math.display)}</span>`);
    lastMath = math.to;
  }
  let s = escapeHtml(prepared + text.slice(lastMath));

  // 行内代码（最高优先级，内部不再解析）
  s = s.replace(/`([^`\n]+)`/g, (m, c) => keep(`<code>${c}</code>`));
  // 只开放无属性的下划线标签，其余 HTML 继续按原文转义。
  s = s.replace(/&lt;u&gt;([^\n]*?)&lt;\/u&gt;/gi, '<u>$1</u>');

  // 图片 ![alt](url)：相对路径按仓库文件解析（Obsidian 仓库里通常写 ![](附件/a.png)）
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, inner) => {
    let url = inner.trim().replace(/&quot;/g, '"').replace(/^<|>$/g, '');
    // 去掉可选的 title：![](a.png "标题")
    const tm = url.match(/^(.*?)\s+"[^"]*"$/);
    if (tm) url = tm[1].trim();
    let src = url;
    if (!/^(https?:|data:|blob:|\/)/i.test(url)) {
      let plain = url;
      try { plain = decodeURI(url); } catch { /* 保留原样 */ }
      const resolved = opts.resolveFile?.(plain);
      if (resolved) src = opts.fileUrl ? opts.fileUrl(resolved) : url;
      else if (opts.fileUrl) src = opts.fileUrl(plain); // 交给服务端判定，至少路径能被安全编码
    }
    return keep(`<img alt="${alt}" src="${escAttr(src)}" data-md-src="${escAttr(url)}" loading="lazy" class="md-image" />`);
  });

  // 嵌入 ![[note]]
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (m, inner) =>
    keep(`<span class="embed-slot" data-embed="${escAttr(inner.trim())}"></span>`));

  // 双链 [[target|alias]]
  s = s.replace(/\[\[([^\]]+)\]\]/g, (m, inner) => {
    const bar = inner.indexOf('|');
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
    const alias = bar >= 0 ? inner.slice(bar + 1).trim() : '';
    return keep(wikilinkHtml(target, alias, opts));
  });

  // 外链 [text](url)
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+?)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, txt, url) => {
    if (/^[a-z][\w+.-]*:/i.test(url) && !/^(https?|mailto|tel):/i.test(url)) return m;
    return keep(`<a${externalUrl(url) ? ' class="external-link"' : ''} href="${url}" target="_blank" rel="noopener noreferrer">${inlineToHtml(txt, opts)}</a>`);
  });

  // 裸 URL 自动链接
  s = s.replace(/(https?:\/\/[^\s<]+)/g, (m, url) =>
    keep(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));

  // 加粗 / 斜体 / 删除线 / 高亮
  s = s.replace(/\*\*([^*]+)\*\*/g, (m, c) => keep(`<strong>${c}</strong>`));
  s = s.replace(/__([^_]+)__/g, (m, c) => keep(`<strong>${c}</strong>`));
  s = s.replace(/\*([^*\n]+)\*/g, (m, c) => keep(`<em>${c}</em>`));
  s = s.replace(/(^|[\s(（])_([^_\n]+)_(?=$|[\s).，。！？、；:])/g, (m, pre, c) => `${pre}${keep(`<em>${c}</em>`)}`);
  s = s.replace(/~~([^~]+)~~/g, (m, c) => keep(`<del>${c}</del>`));
  s = s.replace(/==([^=]+)==/g, (m, c) => keep(`<mark>${c}</mark>`));

  // 标签 #tag
  s = s.replace(/(^|[\s(（])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu, (m, pre, tag) =>
    `${pre}${keep(`<span class="md-tag" data-tag="${escAttr(tag)}">#${tag}</span>`)}`);

  // 还原
  s = s.replace(new RegExp(`${INLINE_TOKEN}(\\d+)${INLINE_TOKEN}`, 'g'), (m, i) => stash[+i] ?? '');
  return s;
}

/* ================= 块级解析（数据层） =================
 * 分两层，解析只有一份：
 *   parseMarkdown(md) → 块描述符数组（纯数据，自带源码偏移）
 *   renderMarkdown(md, opts) → 用描述符建 DOM（编辑器 / 嵌入 / 预览共用）
 * 描述符的 lineStart / lineEnd / contentStart 就是原先打在 DOM 上的
 * data-md-line-start / data-md-line-end / data-md-content-start；
 * 装饰生成器（public/js/cm/decorations.js）消费同一份解析结果，
 * 渲染和装饰不会各自为政。
 *
 * 2026-10-18 拆分注意：这是**纯代码搬运**，所有偏移公式（含引用体的常量平移、
 * 列表续言的塌缩平移）与原实现逐字一致——先行为不变，让 roundtrip/gap/enter/
 * polish/e2e 当护栏，再谈清理历史遗留。 */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})([^`]*)$/;
const MATH_LINE_RE = /^\s*\$\$(.*?)\$\$\s*$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const CALLOUT_RE = /^\s*>\s*\[!(\w+)\]\s*(.*)$/;
const QUOTE_PREFIX_RE = /^(\s*>\s?)/;

/** 子文档（引用体 / 列表续言）的行起点表 */
function subLineStarts(text) {
  const lines = text.split('\n');
  const starts = [0];
  for (let i = 0; i < lines.length - 1; i++) starts.push(starts[i] + lines[i].length + 1);
  return { lines, starts };
}

/** 引用解析前剥掉了每行的 >，偏移必须逐行映射回原文，整体加常量会让第二行起的装饰错位。 */
function mapQuotedBlocks(nodes, sub, originalLines, originalStarts, firstLine) {
  const position = (offset) => {
    let lo = 0, hi = sub.starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sub.starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    const original = firstLine + lo;
    const prefix = originalLines[original].length - sub.lines[lo].length;
    return originalStarts[original] + prefix + offset - sub.starts[lo];
  };
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    // 多行段落的 text 不含 > 前缀，不能再把整段当作原文里的连续子串扫描。
    if (node.type === 'paragraph' && !node.sourceSegments) {
      node.sourceSegments = node.text.split('\n').map((text, i) => ({ text, from: sub.starts[node.line + i] }));
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'number' && ['lineStart', 'lineEnd', 'contentStart', 'from'].includes(key)) node[key] = position(value);
      else if (typeof value === 'number' && ['line', 'endLine', 'startLine', 'openLine', 'closeLine'].includes(key)) node[key] += firstLine;
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(nodes);
}

/** HTML 序列化器用去掉引用前缀后的内容间距，保留它原有的坐标口径以免往返时凭空增加空行。 */
function shiftContentOffsets(node, delta) {
  if (Array.isArray(node)) { node.forEach((n) => shiftContentOffsets(n, delta)); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.lineStart === 'number') {
    node.lineStart += delta; node.lineEnd += delta; node.contentStart += delta;
  }
  for (const value of Object.values(node)) if (value && typeof value === 'object') shiftContentOffsets(value, delta);
}

/** Markdown → { blocks, lines, lineStarts, lineEnd }（装饰生成器直接用） */
export function parseMarkdown(md, opts = {}) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const lineStarts = [0];
  for (let i = 0; i < lines.length - 1; i++) lineStarts.push(lineStarts[i] + lines[i].length + 1);
  const lineEnd = (idx) => lineStarts[idx] + lines[idx].length;
  const blocks = scanDoc(lines, lineStarts, lineEnd, opts);
  return { blocks, lines, lineStarts, lineEnd };
}

/** 扫一份「文档」：块 + 文末空行占位（主文档与引用/Callout 子文档都走这里） */
function scanDoc(lines, lineStarts, lineEnd, opts = {}) {
  const ctx = { usedSlugs: new Map(), sourceOffsets: opts.sourceOffsets !== false };
  const blocks = scanBlocks(lines, lineStarts, lineEnd, 0, lines.length, ctx);
  // 文档以空行结尾时补占位（不能带 md-blank，见 renderBlock 注释）
  let lastText = lines.length - 1;
  while (lastText >= 0 && /^\s*$/.test(lines[lastText])) lastText--;
  for (let k = lastText + 1; k < lines.length; k++) {
    blocks.push({ type: 'blank-tail', line: k, lineStart: lineStarts[k], lineEnd: lineEnd(k), contentStart: lineStarts[k] });
  }
  return blocks;
}

function scanBlocks(lines, lineStarts, lineEnd, start, stop, ctx) {
  const out = [];
  let i = start;
  while (i < stop) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      // 源码里每一行空行都是一个描述符（一行一个，才对得上源码行号）
      let j = i;
      while (j < stop && /^\s*$/.test(lines[j])) j++;
      if (out.length && j < stop) {
        for (let k = i; k < j; k++) {
          out.push({ type: 'blank', line: k, lineStart: lineStarts[k], lineEnd: lineEnd(k), contentStart: lineStarts[k] });
        }
      }
      i = j;
      continue;
    }

    // 代码围栏
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1], lang = (fence[2] || '').trim().split(/\s+/)[0];
      const closing = new RegExp('^\\s*' + marker[0] + '{' + marker.length + ',}\\s*$');
      const buf = [];
      const openLine = i;
      i++;
      while (i < stop && !closing.test(lines[i])) { buf.push(lines[i]); i++; }
      const closed = i < stop;
      if (closed) i++; // 只有同符号、足够长、无语言信息的围栏才能闭合
      out.push({
        type: 'fence', lang, marker, closed, code: buf.join('\n'), line: openLine, endLine: Math.min(lines.length - 1, i - 1),
        lineStart: lineStarts[openLine],
        lineEnd: lineEnd(Math.min(lines.length - 1, i - 1)),
        contentStart: lineStarts[openLine] + fence[0].length + 1,
      });
      continue;
    }

    // 独立公式只在找到成对 $$ 时成立；未闭合时仍保持可编辑的原文。
    const inlineDisplay = MATH_LINE_RE.exec(line);
    if (line.trim() === '$$' || inlineDisplay) {
      let end = i, tex = inlineDisplay?.[1];
      if (!inlineDisplay) {
        end = i + 1; while (end < stop && lines[end].trim() !== '$$') end++;
        if (end < stop) tex = lines.slice(i + 1, end).join('\n');
      }
      if (tex != null) {
        out.push({ type: 'math', tex, line: i, endLine: end, lineStart: lineStarts[i], lineEnd: lineEnd(end), contentStart: lineStarts[i], source: lines.slice(i, end + 1).join('\n') });
        i = end + 1; continue;
      }
    }

    // 标题
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const plain = text.replace(/[*_`~=\[]/g, '');
      let slug = slugify(plain);
      const n = ctx.usedSlugs.get(slug) || 0;
      ctx.usedSlugs.set(slug, n + 1);
      if (n > 0) slug = `${slug}-${n}`;
      const m = /^(#{1,6}\s+)/.exec(line);
      out.push({
        type: 'heading', level, text, slug, line: i,
        lineStart: lineStarts[i], lineEnd: lineEnd(i),
        contentStart: lineStarts[i] + (m ? m[0].length : 0),
      });
      i++;
      continue;
    }

    // 分割线（描述符补上偏移——装饰生成器要用；渲染侧 hr 依旧不打 data-md-* 标记）
    if (HR_RE.test(line)) {
      out.push({ type: 'hr', line: i, lineStart: lineStarts[i], lineEnd: lineEnd(i), contentStart: lineStarts[i] });
      i++;
      continue;
    }

    // 引用 / Callout
    if (/^\s*>/.test(line)) {
      const callout = CALLOUT_RE.exec(line);
      const buf = [];
      const quoteStart = i;
      while (i < stop && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      if (callout) {
        // buf[0] 是 "[!type] 标题" 行本身，正文从 buf.slice(1) 开始
        const sub = subLineStarts(buf.slice(1).join('\n'));
        const bodyBlocks = buf.length > 1 ? scanDoc(sub.lines, sub.starts, (idx) => sub.starts[idx] + sub.lines[idx].length, ctx) : [];
        if (ctx.sourceOffsets) mapQuotedBlocks(bodyBlocks, sub, lines, lineStarts, quoteStart + 1);
        else shiftContentOffsets(bodyBlocks, lineStarts[quoteStart + 1]);
        out.push({
          type: 'callout', calloutType: callout[1].toLowerCase(), title: callout[2] || callout[1],
          blocks: bodyBlocks, line: quoteStart, endLine: Math.min(lines.length - 1, i - 1),
          lineStart: lineStarts[quoteStart],
          lineEnd: lineEnd(Math.min(lines.length - 1, i - 1)),
          contentStart: lineStarts[quoteStart] + callout[0].length,
        });
      } else {
        const sub = subLineStarts(buf.join('\n'));
        const innerBlocks = scanDoc(sub.lines, sub.starts, (idx) => sub.starts[idx] + sub.lines[idx].length, ctx);
        if (ctx.sourceOffsets) mapQuotedBlocks(innerBlocks, sub, lines, lineStarts, quoteStart);
        else shiftContentOffsets(innerBlocks, lineStarts[quoteStart]);
        out.push({ type: 'quote', blocks: innerBlocks, line: quoteStart, endLine: Math.min(lines.length - 1, i - 1) });
      }
      continue;
    }

    // 列表
    if (LIST_RE.test(line)) {
      const [list, next] = scanList(lines, lineStarts, lineEnd, i, stop);
      out.push(list); i = next; continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < stop && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const splitRowWithPos = (l, lineIdx) => {
        const cells = [];
        let pos = 0;
        let s = l.trim();
        const lead = l.length - l.trimStart().length;
        pos = lead;
        if (s.startsWith('|')) { pos += 1; s = s.slice(1); }
        for (const part of s.split('|')) {
          // 单元格偏移扫描时算好（子文档里的表格才能被整体平移）
          cells.push({
            text: part.trim(), pos,
            lineStart: lineStarts[lineIdx],
            lineEnd: lineEnd(lineIdx),
            contentStart: lineStarts[lineIdx] + pos,
          });
          pos += part.length + 1;
        }
        if (cells.length && cells[cells.length - 1].text === '') cells.pop();
        return cells;
      };
      const headerLine = i;
      const header = splitRowWithPos(line, headerLine);
      i += 2;
      const rows = [];
      while (i < stop && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push({ cells: splitRowWithPos(lines[i], i), line: i });
        i++;
      }
      out.push({ type: 'table', header: { cells: header, line: headerLine }, rows });
      continue;
    }

    // 普通段落（吃到空行或下一个块级起点）
    const buf = [line];
    const startLine = i;
    i++;
    while (i < stop && !/^\s*$/.test(lines[i]) && !HEADING_RE.test(lines[i]) && !FENCE_RE.test(lines[i])
           && !HR_RE.test(lines[i]) && !/^\s*>/.test(lines[i]) && !LIST_RE.test(lines[i]) && lines[i].trim() !== '$$' && !MATH_LINE_RE.test(lines[i])
           && !(lines[i].includes('|') && i + 1 < stop && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1]))) {
      buf.push(lines[i]); i++;
    }
    out.push({
      type: 'paragraph', text: buf.join('\n'), line: startLine, endLine: i - 1,
      lineStart: lineStarts[startLine], lineEnd: lineEnd(Math.min(lines.length - 1, i - 1)),
      contentStart: lineStarts[startLine],
    });
  }
  return out;
}

/** 列表扫描：返回 [{type:'list', ordered, items}, nextIndex]；items 为嵌套树 */
function scanList(lines, lineStarts, lineEnd, start, stop) {
  const items = []; // { indent, ordered, text, startLine }
  let i = start;
  while (i < stop) {
    const m = LIST_RE.exec(lines[i]);
    if (!m) break;
    const indent = m[1].replace(/\t/g, '  ').length;
    items.push({ indent, ordered: /\d/.test(m[2]), text: m[3], startLine: i });
    i++;
    // 延续行（缩进内容 / 空行后的缩进内容）
    while (i < stop) {
      const l = lines[i];
      if (/^\s*$/.test(l)) {
        const nxt = lines[i + 1];
        if (nxt !== undefined && /^\s+\S/.test(nxt) && !LIST_RE.test(nxt)) { items[items.length - 1].text += '\n'; i++; continue; }
        break;
      }
      if (LIST_RE.test(l)) break;
      if (/^\s{2,}\S/.test(l)) { items[items.length - 1].text += '\n' + l.replace(/^\s{2,}/, ''); i++; continue; }
      break;
    }
  }

  // 按缩进分组嵌套（栈算法：同级入同一帧，更深的挂到上一项）
  const rootItems = [];
  const stack = []; // { indent, items }
  for (const item of items) {
    while (stack.length && item.indent <= stack[stack.length - 1].indent) stack.pop();
    if (!stack.length) {
      rootItems.push(item);
      stack.push({ indent: item.indent, items: rootItems });
    } else {
      const frame = stack[stack.length - 1];
      const parent = frame.items[frame.items.length - 1];
      if (parent) {
        parent.children = parent.children || [];
        parent.children.push(item);
        stack.push({ indent: item.indent, items: parent.children });
      } else {
        frame.items.push(item);
      }
    }
  }

  // li 的源码偏移扫描时算好（子文档里的列表才能被整体平移）：
  // 行起点 + 行尾 + 内容起点（跳过缩进、列表标记、任务方括号）
  const prepItem = (n) => {
    const rawLine = lines[n.startLine];
    const lm = LIST_RE.exec(rawLine);
    const indentLen = lm ? lm[1].replace(/\t/g, '  ').length : 0;
    const markerLen = lm ? lm[2].length + 1 : 2; // "- " 计 2
    let contentOff = indentLen + markerLen;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(n.text);
    if (task) {
      n.task = task[1].toLowerCase() === 'x';
      n.text = task[2];
      contentOff += 4; // "[x] "
    }
    n.lineStart = lineStarts[n.startLine];
    n.lineEnd = lineStarts[n.startLine] + lines[n.startLine].length;
    n.contentStart = lineStarts[n.startLine] + contentOff;
    if (n.children) for (const c of n.children) prepItem(c);
  };
  for (const n of rootItems) prepItem(n);

  // lineStarts 挂在描述符上：渲染「续言块」时的平移基准（子文档里是子文档的表）
  return [{ type: 'list', ordered: rootItems[0]?.ordered ?? false, items: rootItems, lineStarts }, i];
}

/* ================= 块级渲染（DOM 层） ================= */

/** 给元素打上源码偏移标记（tagOffsets 关闭时跳过——嵌入/预览渲染用） */
function tagEl(el, b, tagOffsets) {
  if (!tagOffsets || b.lineStart == null) return;
  el.dataset.mdLineStart = String(b.lineStart);
  el.dataset.mdLineEnd = String(b.lineEnd);
  if (b.contentStart != null) el.dataset.mdContentStart = String(b.contentStart);
}

export function renderMarkdown(md, opts = {}) {
  const doc = parseMarkdown(md, { sourceOffsets: false });
  const tagOffsets = opts.tagOffsets !== false; // 嵌入/预览渲染时关闭（其 md 来源不同）
  const ctx = { opts, tagOffsets, lineStarts: doc.lineStarts, lines: doc.lines };
  const frag = document.createDocumentFragment();
  for (const b of doc.blocks) frag.appendChild(renderBlock(b, ctx));
  return frag;
}

function renderBlock(b, ctx) {
  switch (b.type) {
    case 'blank': {
      const p = document.createElement('p');
      p.dataset.mdBlank = '1';
      p.appendChild(document.createElement('br'));
      tagEl(p, b, ctx.tagOffsets);
      return p;
    }
    case 'blank-tail': {
      // 行尾空行占位：文件以 \n 结尾时渲染出来的空段落。为什么必须有它：段落累积器
      // 会跳过空行，"第一段\n" 原本渲染成 <p>第一段</p>，行尾那个换行在 DOM 里不存在——
      // 用户按回车打到新行，下一次输入序列化时这个 \n 就被吃掉（实测：段尾回车后续打，
      // 两行拼成一行）。补了空段落，回车落点才有可放光标的 DOM 节点，序列化也接得住
      // （见 serializeBlocks 空段落分支）。多个连续空行一个一行，行数由相邻块的源码
      // 行号差补回来；它**不能**带 md-blank（要把结尾的换行数留下来）。
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      tagEl(p, b, ctx.tagOffsets);
      return p;
    }
    case 'fence': {
      const pre = document.createElement('pre');
      pre.dataset.fenceMarker = b.marker || '```';
      const code = document.createElement('code');
      if (b.lang) code.className = `language-${b.lang}`;
      code.innerHTML = highlightCode(b.code, b.lang);
      pre.appendChild(code);
      if (b.lang) {
        const tag = document.createElement('span');
        tag.className = 'code-lang';
        tag.textContent = b.lang;
        pre.appendChild(tag);
      }
      tagEl(pre, b, ctx.tagOffsets);
      return pre;
    }
    case 'math': {
      const div = document.createElement('div'); div.className = 'md-math md-math-display';
      div.dataset.mathSource = b.source; div.innerHTML = mathHtml(b.tex, true);
      tagEl(div, b, ctx.tagOffsets); return div;
    }
    case 'heading': {
      const h = document.createElement(`h${b.level}`);
      h.id = b.slug;
      h.innerHTML = inlineToHtml(b.text, ctx.opts);
      tagEl(h, b, ctx.tagOffsets);
      return h;
    }
    case 'hr':
      return document.createElement('hr');
    case 'quote': {
      const bq = document.createElement('blockquote');
      for (const sub of b.blocks) bq.appendChild(renderBlock(sub, ctx));
      return bq;
    }
    case 'callout': {
      const div = document.createElement('div');
      div.className = 'callout';
      div.dataset.type = b.calloutType;
      const title = document.createElement('div');
      title.className = 'callout-title';
      title.textContent = b.title;
      const body = document.createElement('div');
      body.className = 'callout-body';
      for (const sub of b.blocks) body.appendChild(renderBlock(sub, ctx));
      div.append(title, body);
      tagEl(div, b, ctx.tagOffsets);
      return div;
    }
    case 'list':
      return renderList(b, ctx);
    case 'table': {
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      for (const c of b.header.cells) {
        const th = document.createElement('th');
        th.innerHTML = inlineToHtml(c.text, ctx.opts);
        tagEl(th, c, ctx.tagOffsets);
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      const tbody = document.createElement('tbody');
      for (const r of b.rows) {
        const tr = document.createElement('tr');
        for (const c of r.cells) {
          const td = document.createElement('td');
          td.innerHTML = inlineToHtml(c.text, ctx.opts);
          tagEl(td, c, ctx.tagOffsets);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      return table;
    }
    case 'paragraph': {
      const p = document.createElement('p');
      p.innerHTML = inlineToHtml(b.text, ctx.opts).replace(/\n/g, '<br>');
      tagEl(p, b, ctx.tagOffsets);
      return p;
    }
  }
  return document.createDocumentFragment();
}

/** 列表渲染：li = [复选框?] + span(首行) + div.li-rest(续言块) + 嵌套列表。
 *  li 的偏移用扫描时算好的值（描述符自带），续言块的平移基准用列表自带的
 *  lineStarts（子文档里的列表用的是子文档的表——与旧实现的闭包行为一致）。 */
function renderList(list, ctx) {
  const lineStarts = list.lineStarts;
  const buildTree = (nodes) => {
    const el = document.createElement(nodes[0].ordered ? 'ol' : 'ul');
    for (const n of nodes) {
      const li = document.createElement('li');
      if (n.task != null) {
        li.className = 'task-list-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = n.task;
        li.appendChild(cb);
      }
      const parts = n.text.split('\n');
      const span = document.createElement('span');
      span.innerHTML = inlineToHtml(parts[0], ctx.opts);
      li.appendChild(span);
      if (parts.length > 1) {
        const rest = document.createElement('div');
        rest.className = 'li-rest';
        const restFrag = renderMarkdown(parts.slice(1).join('\n'), ctx.opts);
        // 续行在源码中的偏移：从第二行开始平移（与旧实现同公式）
        const restStart = n.startLine + 1;
        if (ctx.tagOffsets) {
          for (const el2 of restFrag.querySelectorAll('[data-md-content-start]')) {
            const shift = lineStarts[restStart] - Number(el2.dataset.mdLineStart);
            el2.dataset.mdLineStart = String(Number(el2.dataset.mdLineStart) + shift);
            el2.dataset.mdLineEnd = String(Number(el2.dataset.mdLineEnd) + shift);
            el2.dataset.mdContentStart = String(Number(el2.dataset.mdContentStart) + shift);
          }
        }
        rest.appendChild(restFrag);
        li.appendChild(rest);
      }
      if (n.children && n.children.length) li.appendChild(buildTree(n.children));
      el.appendChild(li);
      // li 的源码标记：行起点 + 内容起点（跳过缩进和列表标记）
      if (ctx.tagOffsets) {
        li.dataset.mdLineStart = String(n.lineStart);
        li.dataset.mdLineEnd = String(n.lineEnd);
        li.dataset.mdContentStart = String(n.contentStart);
      }
    }
    return el;
  };
  return buildTree(list.items);
}

/* ================= DOM → Markdown 序列化 ================= */
function serializeInline(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node;
  const tag = el.tagName;
  const inner = () => [...el.childNodes].map(serializeInline).join('');
  switch (tag) {
    case 'STRONG': case 'B': return `**${inner()}**`;
    case 'EM': case 'I': return `*${inner()}*`;
    case 'DEL': case 'S': case 'STRIKE': return `~~${inner()}~~`;
    case 'MARK': return `==${inner()}==`;
    case 'U': return `<u>${inner()}</u>`;
    case 'CODE': return `\`${el.textContent}\``;
    case 'BR': return '\n';
    case 'IMG': {
      const alt = el.getAttribute('alt') || '';
      // 从 Markdown 图片语法渲染出来的：原样写回，不擅自改写成 ![[ ]]
      const original = el.getAttribute('data-md-src');
      if (original) return `![${alt}](${original})`;
      const src = el.getAttribute('src') || '';
      const m = /^\/api\/file\?path=(.+)$/.exec(src);
      if (m) return `![[${decodeURIComponent(m[1])}|${alt || 'image'}]]`;
      return `![${alt}](${src})`;
    }
    case 'A': {
      if (el.classList.contains('wikilink')) {
        const target = el.dataset.target || el.textContent;
        const display = el.textContent;
        const plain = target.replace(/\s*>\s*/, '#');
        if (!display || display === plain || display === target) return `[[${target}]]`;
        return `[[${target}|${display}]]`;
      }
      const href = el.getAttribute('href') || '';
      const text = el.textContent;
      if (!text || text === href) return href;
      return `[${text}](${href})`;
    }
    case 'SPAN': {
      // 标签：用当前文本内容序列化（用户可能在标签里编辑过），保持 round-trip
      if (el.classList.contains('md-tag')) {
        const t = el.textContent;
        return t.startsWith('#') ? t : `#${t}`;
      }
      if (el.classList.contains('embed-slot')) return `![[${el.dataset.embed || ''}]]`;
      if (el.classList.contains('md-math')) return el.dataset.mathSource || el.textContent;
      return inner();
    }
    case 'DIV': case 'P': case 'FIGURE': {
      // 嵌入块：round-trip 回 ![[target]]，而不是把展开内容序列化进正文
      if (el.classList?.contains('embed')) return `![[${el.dataset.target || ''}]]`;
      return `\n${inner()}\n`;
    }
    default: return inner();
  }
}

function serializeBlocks(root) {
  const out = [];
  // 每块的源码行区间 [lineStart, lineEnd]（渲染时打的标记）。拼接时靠它判断
  // 「这两块在源码里是不是紧挨着（中间没有空行）」——是的话只加一个 \n。
  const marks = [];
  const markOf = (el) => {
    const a = el?.dataset?.mdLineStart;
    const b = el?.dataset?.mdLineEnd;
    return a != null && b != null ? [Number(a), Number(b)] : null;
  };
  const push = (md, el) => { out.push(md); marks.push(markOf(el)); };

  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      if (t) push(t);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      push(`${'#'.repeat(Number(tag[1]))} ${serializeInline(el).trim()}`, el);
    } else if (tag === 'P' || (tag === 'DIV' && !el.classList.contains('callout') && !el.classList.contains('md-math-display'))) {
      const raw = [...el.childNodes].map(serializeInline).join('');
      const md = raw.trim();
      // 段落分隔符占位段：空的直接跳过——它代表的就是那个单空行，
      // 不该产生新块（产生块会把 "A\n\nB" 写成 "A\n\n\n\nB"，每次都长）。
      if (el.dataset?.mdBlank && !md) continue;
      // 空段落（只有 <br> 或真的空）→ 空块：渲染器为「行尾空行」补的 <p><br></p>
      // 靠它活下来——丢了它，用户打回车造出的新行会在下次输入时被吞
      if (md) push(md, el);
      else if (raw === '' || raw === '\n') push('', el);
    } else if (tag === 'UL' || tag === 'OL') {
      push(serializeList(el, tag === 'OL'), el);
    } else if (tag === 'BLOCKQUOTE') {
      const innerMd = serializeBlocks(el).trim();
      if (innerMd) push(innerMd.split('\n').map((l) => `> ${l}`).join('\n'), el);
    } else if (el.classList.contains('md-math-display')) {
      push(el.dataset.mathSource || el.textContent, el);
    } else if (tag === 'PRE') {
      const code = el.querySelector('code');
      const lang = code?.className?.match(/language-([^\s]+)/)?.[1] || '';
      const marker = el.dataset.fenceMarker || '```';
      push(marker + lang + '\n' + (code?.textContent || '') + '\n' + marker, el);
    } else if (tag === 'HR') {
      push('---', el);
    } else if (tag === 'TABLE') {
      const rows = [...el.querySelectorAll('tr')];
      if (!rows.length) continue;
      const cellText = (td) => [...td.childNodes].map(serializeInline).join('').replace(/\|/g, '\\|').trim();
      const mdRows = rows.map((tr) => '| ' + [...tr.children].map(cellText).join(' | ') + ' |');
      mdRows.splice(1, 0, '| ' + [...rows[0].children].map(() => '---').join(' | ') + ' |');
      push(mdRows.join('\n'), el);
    } else if (el.classList?.contains('callout')) {
      const type = el.dataset.type || 'note';
      const titleEl = el.querySelector(':scope > .callout-title');
      const bodyEl = el.querySelector(':scope > .callout-body');
      const title = titleEl?.textContent === type ? '' : (titleEl?.textContent || '');
      const bodyMd = bodyEl ? serializeBlocks(bodyEl).trim() : '';
      const head = `> [!${type}]${title ? ' ' + title : ''}`;
      push(bodyMd ? [head, ...bodyMd.split('\n').map((l) => `> ${l}`)].join('\n') : head, el);
    } else if (el.classList?.contains('embed')) {
      push(`![[${el.dataset.target || ''}]]`, el);
    } else {
      const md = serializeInline(el).trim();
      if (md) push(md, el);
    }
  }

  // 拼接规则：两块之间补几个换行，直接由**源码行号差**决定
  //   gap = 本块行首偏移 - 上一块行尾偏移
  //   空行 1 个 → gap=2 → '\n\n'；两行紧挨着 → gap=1 → '\n'
  // 这样「点空行打字」时字就留在那一行（gap=1），不会平白多出两行空行；
  // 「标题紧跟正文」这类源码本来就没空行的写法也能原样存回去。
  // 拿不到行号标记的块（列表/表格/引用/嵌入）退化为段落分隔 '\n\n'。
  let md = '';
  out.forEach((b, i) => {
    if (i === 0) { md = b; return; }
    const prev = out[i - 1];
    const pm = marks[i - 1];
    const cm = marks[i];
    if (pm && cm) {
      const gap = cm[0] - pm[1];
      if (gap >= 1) { md += '\n'.repeat(Math.min(gap, 12)) + b; return; }
    }
    if (prev === '' && b !== '') { md += b; return; }
    if (b === '' && i < out.length - 1) { md += '\n\n\n'; return; }
    md += '\n\n' + b;
  });
  return md;
}

function serializeList(listEl, ordered) {
  const lines = [];
  let n = 1;
  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;
    const cb = li.querySelector(':scope > input[type="checkbox"]');
    let prefix = ordered ? `${n++}. ` : '- ';
    if (cb) prefix = `- [${cb.checked ? 'x' : ' '}] `;
    const indent = ' '.repeat(prefix.length);
    let main = '';
    const nested = [];
    for (const child of li.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) nested.push(child);
      else main += serializeInline(child);
    }
    const mainLines = main.replace(/^\n+/, '').split('\n');
    lines.push(prefix + mainLines[0]);
    for (let i = 1; i < mainLines.length; i++) lines.push(mainLines[i] ? indent + mainLines[i] : '');
    for (const nl of nested) {
      const sub = serializeList(nl, nl.tagName === 'OL');
      if (sub) lines.push(...sub.split('\n').map((l) => indent + l));
    }
  }
  return lines.join('\n');
}

export function serializeHtml(rootEl) {
  return serializeBlocks(rootEl);
}

/* ================= 光标位置映射 ================= */
/** DOM 内某个 (node, offset) 的纯文本投影偏移 */
export function textOffsetOf(root, node, offset) {
  // 锚点是文本节点：数到它为止
  if (node.nodeType === Node.TEXT_NODE) {
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (t === node) return count + offset;
      count += t.textContent.length;
    }
    return count;
  }
  // 锚点是元素（光标停在一个空块上、或块的边界处）：只数「光标之前」的文本。
  // 旧实现走到这里会把整篇文本长度当成偏移，DOM 重建后光标直接被甩到全文末尾。
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const ref = node.childNodes[Math.min(offset, node.childNodes.length)] || node;
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (t === ref) return count;
    if (t.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING) count += t.textContent.length;
    else return count;
  }
  return count;
}

/** 纯文本偏移 → 最近的 (node, offset) */
export function nodeAtTextOffset(root, target) {
  let count = 0;
  let lastText = null;
  let lastOffset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    const len = t.textContent.length;
    if (count + len >= target) return { node: t, offset: target - count };
    count += len;
    lastText = t; lastOffset = len;
  }
  if (lastText) return { node: lastText, offset: lastOffset };
  return { node: root, offset: 0 };
}

/**
 * DOM 光标位置 → Markdown 源码偏移。
 * 优先用渲染时打上的块级标记（data-md-content-start）做精确映射；
 * 找不到标记时退化为整篇纯文本投影（不精确但可用）。
 */
export function domPointToMd(root, node, offset) {
  let el = node;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const leaf = el?.closest?.('[data-md-content-start]');
  if (!leaf) return textOffsetOf(root, node, offset);
  const domOff = domOffsetBrAware(leaf, node, offset);
  const contentStart = Number(leaf.dataset.mdContentStart);
  return contentStart + inlineMapOffset(leaf, domOff);
}

/**
 * 与 inlineMapOffset 同口径的 DOM 偏移：<br> 计 1（它对应 Markdown 里的 \n）。
 * 为什么不能直接用 textOffsetOf：那个函数只数文本节点，而 inlineMapOffset 的
 * walker 把 <br> 算 1 个字符——口径不一致时，含软换行的段落里光标映射整体偏移
 * （实测：行尾在 "Xef" 末尾，md 偏移应是 19，旧实现给 18，回车把字从中间拆开）。
 * 元素锚点（选区落在元素上、offset 是子节点索引）时，累加到前 offset 个子节点。
 */
function domOffsetBrAware(root, node, offset) {
  // 递归计长：元素按内容算（<li> → <span>文字</span>，只认文本节点会算成 0）
  const len = (n) => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent.length;
    if (n.nodeType !== Node.ELEMENT_NODE) return 0;
    if (n.tagName === 'BR') return 1;
    let sum = 0;
    for (const c of n.childNodes) sum += len(c);
    return sum;
  };
  // 逐节点累加用「浅长度」：walker 会自己走进子节点，递归算会重复计
  const shallowLen = (n) => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent.length;
    if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'BR') return 1;
    return 0;
  };
  let count = 0;
  // 锚点就是块本身（光标停在空块上，或停在块的首尾边界）：只算前 offset 个子节点。
  // 不特判的话下面的 walker 从块的孩子开始走，永远匹配不到锚点，会把整块的
  // 长度全加进去——空行（只有一个 <br>）就变成「偏移 +1」，回车/输入整体错位。
  if (node === root) {
    for (let i = 0; i < offset && i < root.childNodes.length; i++) count += len(root.childNodes[i]);
    return count;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  let cur;
  while ((cur = walker.nextNode())) {
    if (cur === node) {
      if (cur.nodeType === Node.TEXT_NODE) return count + offset;
      if (cur.nodeType === Node.ELEMENT_NODE) {
        if (offset <= 0) return count;
        let extra = 0;
        for (let i = 0; i < offset && i < cur.childNodes.length; i++) extra += len(cur.childNodes[i]);
        return count + extra;
      }
      return count;
    }
    count += shallowLen(cur);
  }
  return count;
}

/**
 * 块内映射：DOM 文本偏移 → 该块 Markdown 源码内的偏移。
 * 与 serializeInline 同构，但边发射源码边统计 DOM 文本长度。
 */
const MARKERS = { STRONG: '**', B: '**', EM: '*', I: '*', DEL: '~~', S: '~~', STRIKE: '~~', MARK: '==' };

function inlineMapOffset(root, domTarget) {
  let domCount = 0;
  let mdLen = 0;
  let done = false;

  const emit = (s) => { if (!done) mdLen += s.length; };

  function walkText(t) {
    if (done) return;
    if (domCount + t.length >= domTarget) {
      mdLen += domTarget - domCount;
      domCount = domTarget;
      done = true;
      return;
    }
    mdLen += t.length;
    domCount += t.length;
  }

  function walk(node) {
    if (done) return;
    if (node.nodeType === Node.TEXT_NODE) { walkText(node.textContent); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName;
    if (tag === 'BR') {
      if (domCount + 1 > domTarget) { done = true; return; }
      mdLen += 1; domCount += 1;
      return;
    }
    if (tag === 'IMG') {
      const src = el.getAttribute('src') || '';
      const m = /^\/api\/file\?path=(.+)$/.exec(src);
      emit(m ? `![[${decodeURIComponent(m[1])}]]` : `![${el.getAttribute('alt') || ''}](${src})`);
      return;
    }
    if (tag === 'SPAN' && el.classList.contains('embed-slot')) {
      emit(`![[${el.dataset.embed || ''}]]`);
      return;
    }
    if (tag === 'SPAN' && el.classList.contains('md-tag')) {
      emit(`#${el.dataset.tag || el.textContent}`);
      return;
    }
    if (tag === 'CODE') {
      emit('`');
      walkText(el.textContent);
      emit('`');
      return;
    }
    if (tag === 'A' && el.classList.contains('wikilink')) {
      const target = el.dataset.target || '';
      const display = el.textContent;
      emit(`[[${target}`);
      if (display !== target.replace(/\s*>\s*/, '#') && display !== target) emit('|');
      for (const c of el.childNodes) walk(c);
      emit(']]');
      return;
    }
    if (tag === 'A') {
      emit('[');
      for (const c of el.childNodes) walk(c);
      emit(`](${el.getAttribute('href') || ''})`);
      return;
    }
    const pre = MARKERS[tag] || '';
    if (pre) emit(pre);
    for (const c of el.childNodes) walk(c);
    if (pre) emit(pre);
  }

  for (const c of root.childNodes) walk(c);
  return mdLen;
}

/**
 * Markdown 源码偏移 → DOM 光标位置（domPointToMd 的逆运算）。
 * 先定位所属块（data-md-content-start 最大且不超过目标），再在块内反向映射。
 */
export function mdOffsetToDom(root, mdOffset) {
  const leaves = [...root.querySelectorAll('[data-md-content-start]')];
  let leaf = null;
  let cs = 0;
  for (const el of leaves) {
    const v = Number(el.dataset.mdContentStart);
    if (v <= mdOffset && (!leaf || v >= cs)) { leaf = el; cs = v; }
  }
  if (!leaf) return nodeAtTextOffset(root, mdOffset);
  const target = mdOffset - cs;

  let mdEmitted = 0;
  let result = null;

  const placeAtStart = (el) => {
    // 放到元素内第一个文本节点的起点
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const t = w.nextNode();
    result = t ? { node: t, offset: 0 } : { node: el, offset: 0 };
  };

  function walk(node) {
    if (result) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent;
      if (mdEmitted + t.length >= target) { result = { node, offset: Math.max(0, target - mdEmitted) }; return; }
      mdEmitted += t.length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName;
    if (tag === 'BR') {
      if (mdEmitted + 1 > target) { result = null; return; }
      mdEmitted += 1;
      return;
    }
    if (tag === 'IMG') {
      const src = el.getAttribute('src') || '';
      const m = /^\/api\/file\?path=(.+)$/.exec(src);
      const md = m ? `![[${decodeURIComponent(m[1])}]]` : `![${el.getAttribute('alt') || ''}](${src})`;
      if (mdEmitted + md.length > target) { placeAtStart(el.parentElement || el); return; }
      mdEmitted += md.length;
      return;
    }
    if (tag === 'SPAN' && el.classList.contains('embed-slot')) {
      const md = `![[${el.dataset.embed || ''}]]`;
      if (mdEmitted + md.length > target) { placeAtStart(el.parentElement || el); return; }
      mdEmitted += md.length;
      return;
    }
    if (tag === 'SPAN' && el.classList.contains('md-tag')) {
      const md = `#${el.dataset.tag || el.textContent}`;
      if (mdEmitted + md.length > target) { placeAtStart(el.parentElement || el); return; }
      mdEmitted += md.length;
      return;
    }
    if (tag === 'CODE') {
      const md = `\`${el.textContent}\``;
      if (mdEmitted + md.length > target) {
        const inner = Math.max(0, target - mdEmitted - 1);
        result = { node: el.firstChild || el, offset: inner };
        return;
      }
      mdEmitted += md.length;
      return;
    }
    if (tag === 'A' && el.classList.contains('wikilink')) {
      const targetAttr = el.dataset.target || '';
      const display = el.textContent;
      const open = `[[${targetAttr}`;
      const sep = (display !== targetAttr.replace(/\s*>\s*/, '#') && display !== targetAttr) ? '|' : '';
      if (mdEmitted + open.length + sep.length > target) { placeAtStart(el); return; }
      mdEmitted += open.length + sep.length;
      for (const c of el.childNodes) { walk(c); if (result) return; }
      if (mdEmitted + 2 > target) { placeAtStart(el); return; }
      mdEmitted += 2;
      return;
    }
    if (tag === 'A') {
      if (mdEmitted + 1 > target) { placeAtStart(el); return; }
      mdEmitted += 1;
      for (const c of el.childNodes) { walk(c); if (result) return; }
      const href = `](${el.getAttribute('href') || ''})`;
      if (mdEmitted + href.length > target) { placeAtStart(el.parentElement || el); return; }
      mdEmitted += href.length;
      return;
    }
    const pre = MARKERS[tag] || '';
    if (pre) {
      if (mdEmitted + pre.length > target) { placeAtStart(el); return; }
      mdEmitted += pre.length;
    }
    for (const c of el.childNodes) { walk(c); if (result) return; }
    if (pre) {
      if (mdEmitted + pre.length > target) { placeAtStart(el.parentElement || el); return; }
      mdEmitted += pre.length;
    }
  }

  for (const c of leaf.childNodes) { walk(c); if (result) break; }
  if (!result) {
    if (!leaf.textContent.trim()) {
      // 空段落（渲染器补的行尾空行 <p><br></p>）：光标放进段落内，
      // 否则会掉到全文最后一个文本节点——用户回车后的新行上打不了字
      result = { node: leaf, offset: 0 };
    } else {
      // 目标超出该块（通常是文档末尾）：放到全文最后一个文本节点末尾
      const last = nodeAtTextOffset(root, Number.MAX_SAFE_INTEGER);
      result = last;
    }
  }
  return result;
}
