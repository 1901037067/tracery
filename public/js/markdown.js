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

const INLINE_TOKEN = '\u0001';

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
  let s = escapeHtml(text);

  // 行内代码（最高优先级，内部不再解析）
  s = s.replace(/`([^`\n]+)`/g, (m, c) => keep(`<code>${c}</code>`));

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
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+?)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, txt, url) =>
    keep(`<a href="${url}" target="_blank" rel="noopener">${inlineToHtml(txt, opts)}</a>`));

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

  // 行内公式 $...$ / $$...$$（无数学引擎，等宽呈现）
  s = s.replace(/\$\$([^$\n]+)\$\$/g, (m, c) => keep(`<span class="md-math" style="font-family:var(--font-mono)">$$${c}$$</span>`));
  s = s.replace(/\$([^$\n]+)\$/g, (m, c) => keep(`<span class="md-math" style="font-family:var(--font-mono)">$${c}$</span>`));

  // 标签 #tag
  s = s.replace(/(^|[\s(（])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu, (m, pre, tag) =>
    `${pre}${keep(`<span class="md-tag" data-tag="${escAttr(tag)}">#${tag}</span>`)}`);

  // 还原
  s = s.replace(new RegExp(`${INLINE_TOKEN}(\\d+)${INLINE_TOKEN}`, 'g'), (m, i) => stash[+i] ?? '');
  return s;
}

/* ================= 块级渲染 ================= */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*```(\w*)\s*$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const CALLOUT_RE = /^\s*>\s*\[!(\w+)\]\s*(.*)$/;
const QUOTE_PREFIX_RE = /^(\s*>\s?)/;

export function renderMarkdown(md, opts = {}) {
  const frag = document.createDocumentFragment();
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const tagOffsets = opts.tagOffsets !== false; // 嵌入/预览渲染时关闭（其 md 来源不同）

  // 每行在源码中的起始偏移
  const lineStarts = [0];
  for (let i = 0; i < lines.length - 1; i++) lineStarts.push(lineStarts[i] + lines[i].length + 1);
  const lineEnd = (idx) => lineStarts[idx] + lines[idx].length;

  const usedSlugs = new Map();

  function tagLeaf(el, lineIdx, contentOffsetInLine) {
    if (!tagOffsets || !el) return;
    el.dataset.mdLineStart = String(lineStarts[lineIdx]);
    el.dataset.mdLineEnd = String(lineEnd(lineIdx));
    if (contentOffsetInLine != null) {
      el.dataset.mdContentStart = String(lineStarts[lineIdx] + contentOffsetInLine);
    }
  }

  function makeHeadingEl(level, text, lineIdx) {
    const h = document.createElement(`h${level}`);
    const plain = text.replace(/[*_`~=\[]/g, '');
    let slug = slugify(plain);
    const n = usedSlugs.get(slug) || 0;
    usedSlugs.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    h.id = slug;
    h.innerHTML = inlineToHtml(text, opts);
    const m = /^(#{1,6}\s+)/.exec(lines[lineIdx]);
    tagLeaf(h, lineIdx, m ? m[0].length : 0);
    return h;
  }

  function parseBlocks(start, stop) {
    const out = [];
    let i = start;
    while (i < stop) {
      const line = lines[i];

      if (/^\s*$/.test(line)) { i++; continue; }

      // 代码围栏
      const fence = FENCE_RE.exec(line);
      if (fence) {
        const lang = fence[1] || '';
        const buf = [];
        const openLine = i;
        i++;
        while (i < stop && !FENCE_RE.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过结束围栏
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (lang) code.className = `language-${lang}`;
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        if (lang) {
          const tag = document.createElement('span');
          tag.className = 'code-lang';
          tag.textContent = lang;
          pre.appendChild(tag);
        }
        tagLeaf(pre, openLine, fence[0].length + 1);
        out.push(pre);
        continue;
      }

      // 标题
      const h = HEADING_RE.exec(line);
      if (h) { out.push(makeHeadingEl(h[1].length, h[2].trim(), i)); i++; continue; }

      // 分割线
      if (HR_RE.test(line)) { out.push(document.createElement('hr')); i++; continue; }

      // 引用 / Callout
      if (/^\s*>/.test(line)) {
        const callout = CALLOUT_RE.exec(line);
        const buf = [];
        const quoteStart = i;
        while (i < stop && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        if (callout) {
          const div = document.createElement('div');
          div.className = 'callout';
          div.dataset.type = callout[1].toLowerCase();
          const title = document.createElement('div');
          title.className = 'callout-title';
          title.textContent = callout[2] || callout[1];
          const body = document.createElement('div');
          body.className = 'callout-body';
          // 注意：buf[0] 是 "[!type] 标题" 行本身，正文从 buf.slice(1) 开始
          const bodyMd = buf.slice(1).join('\n');
          const bodyFrag = renderMarkdown(bodyMd, opts);
          // 修正 body 内块的源码偏移：整体平移到原文档位置
          shiftOffsets(bodyFrag, lineStarts[quoteStart + 1] - 0);
          body.appendChild(bodyFrag);
          div.append(title, body);
          tagLeaf(div, quoteStart, callout[0].length);
          out.push(div);
        } else {
          const bq = document.createElement('blockquote');
          const innerFrag = renderMarkdown(buf.join('\n'), opts);
          shiftOffsets(innerFrag, lineStarts[quoteStart]);
          bq.appendChild(innerFrag);
          out.push(bq);
        }
        continue;
      }

      // 列表
      if (LIST_RE.test(line)) {
        const [el, next] = parseList(i, stop);
        out.push(el); i = next; continue;
      }

      // 表格
      if (line.includes('|') && i + 1 < stop && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
        const splitRowWithPos = (l) => {
          const cells = [];
          let pos = 0;
          let s = l.trim();
          const lead = l.length - l.trimStart().length;
          pos = lead;
          if (s.startsWith('|')) { pos += 1; s = s.slice(1); }
          for (const part of s.split('|')) {
            cells.push({ text: part.trim(), pos });
            pos += part.length + 1;
          }
          if (cells.length && cells[cells.length - 1].text === '') cells.pop();
          return cells;
        };
        const header = splitRowWithPos(line);
        const headerLine = i;
        i += 2;
        const bodyRows = [];
        while (i < stop && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
          bodyRows.push({ cells: splitRowWithPos(lines[i]), line: i });
          i++;
        }
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        header.forEach((c) => {
          const th = document.createElement('th');
          th.innerHTML = inlineToHtml(c.text, opts);
          tagLeaf(th, headerLine, c.pos);
          htr.appendChild(th);
        });
        thead.appendChild(htr);
        const tbody = document.createElement('tbody');
        bodyRows.forEach((r) => {
          const tr = document.createElement('tr');
          r.cells.forEach((c) => {
            const td = document.createElement('td');
            td.innerHTML = inlineToHtml(c.text, opts);
            tagLeaf(td, r.line, c.pos);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.append(thead, tbody);
        out.push(table);
        continue;
      }

      // 普通段落（吃到空行或下一个块级起点）
      const buf = [line];
      const startLine = i;
      i++;
      while (i < stop && !/^\s*$/.test(lines[i]) && !HEADING_RE.test(lines[i]) && !FENCE_RE.test(lines[i])
             && !HR_RE.test(lines[i]) && !/^\s*>/.test(lines[i]) && !LIST_RE.test(lines[i])
             && !(lines[i].includes('|') && i + 1 < stop && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1]))) {
        buf.push(lines[i]); i++;
      }
      const p = document.createElement('p');
      p.innerHTML = inlineToHtml(buf.join('\n'), opts).replace(/\n/g, '<br>');
      tagLeaf(p, startLine, 0);
      out.push(p);
    }
    return out;
  }

  /** 把子渲染结果里的偏移标记整体平移（用于引用/Callout 内嵌块） */
  function shiftOffsets(frag, delta) {
    if (!tagOffsets) return;
    for (const el of frag.querySelectorAll('[data-md-content-start]')) {
      el.dataset.mdLineStart = String(Number(el.dataset.mdLineStart) + delta);
      el.dataset.mdLineEnd = String(Number(el.dataset.mdLineEnd) + delta);
      el.dataset.mdContentStart = String(Number(el.dataset.mdContentStart) + delta);
    }
  }

  function parseList(start, stop) {
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

    const buildTree = (nodes) => {
      const el = document.createElement(nodes[0].ordered ? 'ol' : 'ul');
      for (const n of nodes) {
        const li = document.createElement('li');
        const rawLine = lines[n.startLine];
        const lm = LIST_RE.exec(rawLine);
        const indentLen = lm ? lm[1].replace(/\t/g, '  ').length : 0;
        const markerLen = lm ? lm[2].length + 1 : 2; // "- " 计 2
        let contentOff = indentLen + markerLen;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(n.text);
        if (task) {
          li.className = 'task-list-item';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = task[1].toLowerCase() === 'x';
          li.appendChild(cb);
          n.text = task[2];
          contentOff += 4; // "[x] "
        }
        const parts = n.text.split('\n');
        const span = document.createElement('span');
        span.innerHTML = inlineToHtml(parts[0], opts);
        li.appendChild(span);
        if (parts.length > 1) {
          const rest = document.createElement('div');
          rest.className = 'li-rest';
          const restFrag = renderMarkdown(parts.slice(1).join('\n'), opts);
          // 续行在源码中的偏移：从第二行开始平移
          const restStart = n.startLine + 1;
          if (tagOffsets) {
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
        if (tagOffsets) {
          li.dataset.mdLineStart = String(lineStarts[n.startLine]);
          li.dataset.mdLineEnd = String(lineEnd(n.startLine));
          li.dataset.mdContentStart = String(lineStarts[n.startLine] + contentOff);
        }
      }
      return el;
    };
    return [buildTree(rootItems), i];
  }

  for (const el of parseBlocks(0, lines.length)) frag.appendChild(el);

  // 文档以空行结尾时，补一个空段落 <p><br></p>。
  // 为什么必须有它：段落累积器会跳过空行，"第一段\n" 原本渲染成 <p>第一段</p>，
  // 行尾那个换行在 DOM 里不存在——用户按回车打到新行，下一次输入序列化时
  // 这个 \n 就被吃掉（实测：段尾回车后续打，两行拼成一行）。补了空段落，
  // 回车落点才有可放光标的 DOM 节点，序列化也接得住（见 serializeBlocks 空段落分支）。
  // 多个连续空行只补一个：序列化按 '\n\n' 拼接，每空行都补会逐轮膨胀、破坏不动点。
  // 从尾部向前找最后一个非空行；它之后的连续空白段才是「行尾空行」
  let lastText = lines.length - 1;
  while (lastText >= 0 && /^\s*$/.test(lines[lastText])) lastText--;
  if (lastText < lines.length - 1) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    tagLeaf(p, lastText + 1, 0);
    frag.appendChild(p);
  }
  return frag;
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
      if (el.classList.contains('md-math')) return el.textContent;
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
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      if (t) out.push(t);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      out.push(`${'#'.repeat(Number(tag[1]))} ${serializeInline(el).trim()}`);
    } else if (tag === 'P' || (tag === 'DIV' && !el.classList.contains('callout'))) {
      const raw = [...el.childNodes].map(serializeInline).join('');
      const md = raw.trim();
      // 空段落（只有 <br> 或真的空）→ 空块：渲染器为「行尾空行」补的 <p><br></p>
      // 靠它活下来——丢了它，用户打回车造出的新行会在下次输入时被吞
      if (md) out.push(md);
      else if (raw === '' || raw === '\n') out.push('');
    } else if (tag === 'UL' || tag === 'OL') {
      out.push(serializeList(el, tag === 'OL'));
    } else if (tag === 'BLOCKQUOTE') {
      const innerMd = serializeBlocks(el).trim();
      if (innerMd) out.push(innerMd.split('\n').map((l) => `> ${l}`).join('\n'));
    } else if (tag === 'PRE') {
      const code = el.querySelector('code');
      const lang = code?.className?.match(/language-(\w+)/)?.[1] || '';
      out.push('```' + lang + '\n' + (code?.textContent || '') + '\n```');
    } else if (tag === 'HR') {
      out.push('---');
    } else if (tag === 'TABLE') {
      const rows = [...el.querySelectorAll('tr')];
      if (!rows.length) continue;
      const cellText = (td) => [...td.childNodes].map(serializeInline).join('').replace(/\|/g, '\\|').trim();
      const mdRows = rows.map((tr) => '| ' + [...tr.children].map(cellText).join(' | ') + ' |');
      mdRows.splice(1, 0, '| ' + [...rows[0].children].map(() => '---').join(' | ') + ' |');
      out.push(mdRows.join('\n'));
    } else if (el.classList?.contains('callout')) {
      const type = el.dataset.type || 'note';
      const titleEl = el.querySelector(':scope > .callout-title');
      const bodyEl = el.querySelector(':scope > .callout-body');
      const title = titleEl?.textContent === type ? '' : (titleEl?.textContent || '');
      const bodyMd = bodyEl ? serializeBlocks(bodyEl).trim() : '';
      const head = `> [!${type}]${title ? ' ' + title : ''}`;
      out.push(bodyMd ? [head, ...bodyMd.split('\n').map((l) => `> ${l}`)].join('\n') : head);
    } else if (el.classList?.contains('embed')) {
      out.push(`![[${el.dataset.target || ''}]]`);
    } else {
      const md = serializeInline(el).trim();
      if (md) out.push(md);
    }
  }
  return out.join('\n\n');
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
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (t === node) return count + offset;
    count += t.textContent.length;
  }
  // node 本身是元素（如空块）：按其后所有文本长度近似
  if (node === root || (root.contains?.(node) && node.nodeType === Node.ELEMENT_NODE)) {
    return offset <= 0 ? count : count;
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
  const len = (n) => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent.length;
    if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'BR') return 1;
    return 0;
  };
  let count = 0;
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
    count += len(cur);
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
