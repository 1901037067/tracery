import { parseMarkdown, renderMarkdown } from './markdown.js';
import { wikiParts } from './wiki-path.js';

const plainHeading = text => text.replace(/!?(?:\[([^\]]+)\]\([^)]*\))/g, '$1').replace(/[*_`~]/g, '').replace(/\s+#+\s*$/, '').trim();

function rangedBlocks(doc) {
  return doc.blocks.map(block => {
    if (block.type === 'list') {
      const items = [];
      const visit = list => list.forEach(item => { items.push(item); visit(item.children || []); }); visit(block.items);
      return { ...block, line: Math.min(...items.map(item => item.startLine)), endLine: Math.max(...items.map(item => item.startLine + item.text.split('\n').length - 1)) };
    }
    if (block.type === 'table') return { ...block, line: block.header.line, endLine: block.rows.at(-1)?.line ?? block.header.line + 1 };
    return block;
  });
}

/** 与正文解析共用块边界，代码围栏中的标题和块标记不参与定位。 */
export function noteAnchors(content) {
  const doc = parseMarkdown(content), anchors = [];
  for (const block of rangedBlocks(doc)) {
    if (block.type === 'heading') anchors.push({ anchor: plainHeading(block.text), label: plainHeading(block.text), line: block.line, level: block.level, from: block.lineStart });
    if (block.type === 'fence') continue;
    for (let line = block.line; line <= (block.endLine ?? block.line); line++) {
      const match = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(doc.lines[line] || '');
      if (match) anchors.push({ anchor: '^' + match[1], label: (doc.lines[line].replace(match[0], '').trim() || doc.lines[line - 1] || match[1]).slice(0, 80), line, from: doc.lineStarts[line] });
    }
  }
  return anchors;
}

export function selectNoteContent(content, anchor = '') {
  content = String(content || '').replace(/\r\n?/g, '\n');
  if (!anchor) return { md: content, line: 0 };
  const doc = parseMarkdown(content), anchors = noteAnchors(content);
  const found = anchors.find(item => item.anchor === anchor || (!anchor.startsWith('^') && plainHeading(item.anchor) === plainHeading(anchor)));
  if (!found) return { md: '', error: `${anchor.startsWith('^') ? '文本块' : '标题'}不存在：${anchor}` };
  if (!anchor.startsWith('^')) {
    const next = anchors.find(item => item.line > found.line && item.level && item.level <= found.level);
    return { md: content.slice(found.from, next?.from ?? content.length).trimEnd(), line: found.line };
  }
  const blocks = rangedBlocks(doc);
  let block = blocks.find(item => item.line <= found.line && (item.endLine ?? item.line) >= found.line);
  if (doc.lines[found.line].trim() === anchor && block?.line === found.line) {
    block = blocks.filter(item => (item.endLine ?? item.line) < found.line && !['blank', 'blank-tail'].includes(item.type)).at(-1);
  }
  const start = block?.line ?? found.line, end = Math.max(block?.endLine ?? block?.line ?? found.line, found.line);
  const md = doc.lines.slice(start, end + 1).join('\n').replace(new RegExp(`(?:[ \\t]+|^)\\${anchor}\\s*$`, 'm'), '').trimEnd();
  return { md, line: start };
}

/** 嵌入正文里的图片和链接以被嵌入笔记为基准；嵌套笔记显示可打开的引用，避免循环展开。 */
export function renderNoteContent(result, opts = {}) {
  const resolveFile = name => opts.resolveFile?.(name, result.path);
  const fragment = renderMarkdown(result.md, {
    tagOffsets: false,
    resolve: raw => opts.resolveLink?.(raw, result.path),
    resolveFile,
    fileUrl: opts.fileUrl,
  });
  fragment.querySelectorAll('input, textarea, select').forEach(input => { input.disabled = true; });
  fragment.querySelectorAll('.embed-slot').forEach(slot => {
    const raw = slot.dataset.embed, { target, alias } = wikiParts(raw);
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(target)) {
      const path = resolveFile(target);
      if (path) {
        const img = document.createElement('img'); img.src = opts.fileUrl?.(path) || path; img.alt = target;
        const width = Number.parseInt(alias, 10); if (width > 0) img.style.width = `${Math.min(width, 1600)}px`;
        img.className = 'cm-embed-image'; slot.replaceWith(img); return;
      }
    }
    const button = document.createElement('button'); button.className = 'cm-embed-reference';
    button.textContent = alias || raw; button.title = '打开嵌套引用';
    button.onclick = () => opts.openLink?.(raw, result.path); slot.replaceWith(button);
  });
  fragment.querySelectorAll('.wikilink').forEach(link => {
    link.onclick = event => { event.preventDefault(); event.stopPropagation(); opts.openLink?.(link.dataset.target, result.path); };
  });
  return fragment;
}
