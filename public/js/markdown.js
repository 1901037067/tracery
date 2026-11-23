/**
 * Tracery Markdown 引擎
 *  - parseMarkdown(md)  : Markdown → 块描述符（CM6 实时预览、大纲、嵌入与任务共用的块级解析）
 *  - renderMarkdown(md) : Markdown → DOM（笔记嵌入与 HTML/PDF 导出用）
 *  - inlineToHtml(text) : 行内 Markdown → HTML
 * 支持：标题/列表(含任务)/引用(含 Callout)/代码围栏/表格/分割线/图片/外链/
 *       [[双链]](含 #标题 与 |别名)/![[嵌入]]/#标签/加粗/斜体/删除线/高亮/行内代码
 */

import { mathHtml, inlineMath } from './math.js';
import { markdownLinks, decodeLinkEntities } from './external-link.js';
import { readProperties } from './note-properties.js';
import { parseFenceOpen, isFenceClose } from './reference-path.js';
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
function wikilinkHtml(target, alias, opts, labelHtml, destination) {
  const hashIdx = target.indexOf('#');
  const heading = hashIdx >= 0 ? target.slice(hashIdx + 1) : '';
  const nameOnly = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  const resolved = opts.resolve ? (opts.resolve(nameOnly) || opts.resolve(target)) : null;
  const display = alias || (heading ? `${nameOnly} > ${heading}` : target);
  const cls = (resolved ? 'wikilink' : 'wikilink unresolved') + (destination === undefined ? '' : ' markdown-local-link');
  return `<a class="${cls}"${destination === undefined ? '' : ` href="${escAttr(destination)}"`} data-target="${escAttr(target)}" data-resolved="${escAttr(resolved || '')}" data-heading="${escAttr(heading)}">${labelHtml ?? escapeHtml(display)}</a>`;
}

export function inlineToHtml(text, opts = {}) {
  const stash = [];
  const keep = (html) => { stash.push(html); return `${INLINE_TOKEN}${stash.length - 1}${INLINE_TOKEN}`; };
  let prepared = '', lastMath = 0;
  for (const math of inlineMath(text)) {
    prepared += text.slice(lastMath, math.from) + keep(`<span class="md-math">${mathHtml(math.tex, math.display)}</span>`);
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
    return keep(`<img alt="${alt}" src="${escAttr(src)}" loading="lazy" class="md-image" />`);
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

  // Standard Markdown links share destination parsing with live preview.
  const links = markdownLinks(s);
  for (const link of links.reverse()) {
    const label = decodeLinkEntities(s.slice(link.labelFrom, link.labelTo));
    const html = link.kind === 'local' ? wikilinkHtml(link.href, label, opts, inlineToHtml(label, opts), link.destination)
      : `<a class="external-link" href="${escAttr(link.destination)}" title="${escAttr(link.title)}" target="_blank" rel="noopener noreferrer">${inlineToHtml(label, opts)}</a>`;
    s = s.slice(0, link.from) + keep(html) + s.slice(link.to);
  }
  // Preserve supported contact links without treating their schemes as note names.
  s = s.replace(/\[([^\]]*)\]\(((?:mailto|tel):[^)\s]+)\)/gi, (match, label, href) => keep(`<a href="${escAttr(decodeLinkEntities(href))}" target="_blank" rel="noopener noreferrer">${label}</a>`));

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
 *   parseMarkdown(md) → 块描述符数组（纯数据，自带源码偏移）
 *   renderMarkdown(md, opts) → 用描述符建 DOM（嵌入 / 导出共用）
 * 装饰生成器（public/js/cm/decorations.js）消费同一份解析结果。 */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const MATH_LINE_RE = /^\s*\$\$(.*?)\$\$\s*$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const CALLOUT_RE = /^\s*>\s*\[!(\w+)\]\s*(.*)$/;

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

/** Markdown → { blocks, lines, lineStarts, lineEnd }（装饰生成器直接用） */
export function parseMarkdown(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const lineStarts = [0];
  for (let i = 0; i < lines.length - 1; i++) lineStarts.push(lineStarts[i] + lines[i].length + 1);
  const lineEnd = (idx) => lineStarts[idx] + lines[idx].length;
  const blocks = scanDoc(lines, lineStarts, lineEnd);
  return { blocks, lines, lineStarts, lineEnd };
}

/** 扫一份「文档」：块 + 文末空行占位（主文档与引用/Callout 子文档都走这里） */
function scanDoc(lines, lineStarts, lineEnd, ctx = { usedSlugs: new Map() }) {
  const properties = lines[0] === '---' ? readProperties(lines.join('\n')) : null;
  const endLine = properties?.exists && !properties.error ? lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(line)) : -1;
  const blocks = scanBlocks(lines, lineStarts, lineEnd, endLine >= 0 ? endLine + 1 : 0, lines.length, ctx);
  if (endLine >= 0) blocks.unshift({ type: 'frontmatter', line: 0, endLine, lineStart: 0, lineEnd: lineEnd(endLine), contentStart: 0, text: lines.slice(0, endLine + 1).join('\n') });
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
    const fence = parseFenceOpen(line, { allowDeepIndent: true });
    if (fence) {
      const { marker, lang } = fence;
      const buf = [];
      const openLine = i;
      i++;
      while (i < stop && !isFenceClose(lines[i], marker, { allowDeepIndent: true })) { buf.push(lines[i]); i++; }
      const closed = i < stop;
      if (closed) i++; // 只有同符号、足够长、无语言信息的围栏才能闭合
      out.push({
        type: 'fence', lang, marker, closed, code: buf.join('\n'), line: openLine, endLine: Math.min(lines.length - 1, i - 1),
        lineStart: lineStarts[openLine],
        lineEnd: lineEnd(Math.min(lines.length - 1, i - 1)),
        contentStart: lineStarts[openLine] + line.length + 1,
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
        mapQuotedBlocks(bodyBlocks, sub, lines, lineStarts, quoteStart + 1);
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
        mapQuotedBlocks(innerBlocks, sub, lines, lineStarts, quoteStart);
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
    while (i < stop && !/^\s*$/.test(lines[i]) && !HEADING_RE.test(lines[i]) && !parseFenceOpen(lines[i], { allowDeepIndent: true })
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

export function renderMarkdown(md, opts = {}) {
  const doc = parseMarkdown(md);
  const ctx = { opts };
  const frag = document.createDocumentFragment();
  for (const b of doc.blocks) frag.appendChild(renderBlock(b, ctx));
  return frag;
}

function renderBlock(b, ctx) {
  switch (b.type) {
    case 'frontmatter': {
      const pre = document.createElement('pre'); pre.className = 'md-frontmatter'; pre.dataset.frontmatter = 'true'; pre.setAttribute('aria-label', '笔记属性源码'); pre.textContent = b.text; return pre;
    }
    case 'blank':
    case 'blank-tail':
      return document.createDocumentFragment();
    case 'fence': {
      const pre = document.createElement('pre');
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
      return pre;
    }
    case 'math': {
      const div = document.createElement('div'); div.className = 'md-math md-math-display';
      div.innerHTML = mathHtml(b.tex, true);
      return div;
    }
    case 'heading': {
      const h = document.createElement(`h${b.level}`);
      h.id = b.slug;
      h.innerHTML = inlineToHtml(b.text, ctx.opts);
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
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      const tbody = document.createElement('tbody');
      for (const r of b.rows) {
        const tr = document.createElement('tr');
        for (const c of r.cells) {
          const td = document.createElement('td');
          td.innerHTML = inlineToHtml(c.text, ctx.opts);
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
      return p;
    }
  }
  return document.createDocumentFragment();
}

function renderList(list, ctx) {
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
        rest.appendChild(renderMarkdown(parts.slice(1).join('\n'), ctx.opts));
        li.appendChild(rest);
      }
      if (n.children && n.children.length) li.appendChild(buildTree(n.children));
      el.appendChild(li);
    }
    return el;
  };
  return buildTree(list.items);
}
