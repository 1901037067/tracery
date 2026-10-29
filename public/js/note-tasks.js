import { parseMarkdown } from './markdown.js';
import { readProperties, validDate } from './note-properties.js';

// Reuse the editor's list tree; do not infer tasks from arbitrary occurrences of [ ].
export function parseTasks(source) {
  const bom = source.startsWith('\uFEFF') ? 1 : 0, text = source.slice(bom), raw = [...text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)];
  const properties = readProperties(text); if (properties.exists && properties.error) return [];
  const doc = parseMarkdown(text), blocked = new Set(), headerEnd = doc.blocks[0]?.type === 'frontmatter' ? doc.blocks[0].endLine : -1; let fence = null;
  raw.forEach((match, i) => {
    if (i <= headerEnd) return;
    const start = /^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(match[1]);
    if (fence) { blocked.add(i); if (start && start[1][0] === fence[0] && start[1].length >= fence.length && !start[2].trim()) fence = null; }
    else if (start) { fence = start[1]; blocked.add(i); }
  });
  const lineOf = offset => { let a = 0, b = doc.lineStarts.length - 1; while (a < b) { const mid = Math.ceil((a + b) / 2); if (doc.lineStarts[mid] <= offset) a = mid; else b = mid - 1; } return a; };
  const rows = [], seen = new Set();
  const items = (nodes, nested = false) => {
    for (const node of nodes) {
      if (!nested && node.indent >= 4) continue;
      const line = lineOf(node.lineStart), original = raw[line]?.[1], match = original && /^([ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])[ \t]+\[)([ xX])(\][ \t]+)(.*)$/.exec(original);
      if (match && !blocked.has(line) && !seen.has(line) && (nested || node.indent < 4)) {
        const prose = match[4].replace(/(`+)[\s\S]*?\1/g, ''), due = /(?:^|\s)(?:📅\s*|due:\s*|到期:\s*)(\d{4}-\d{2}-\d{2})(?![\dA-Za-z_-])/u.exec(prose)?.[1];
        rows.push({ line: line + 1, raw: original, text: match[4], completed: match[2].toLowerCase() === 'x', due: due && validDate(due) ? due : '', marker: bom + raw[line].index + match[1].length }); seen.add(line);
      }
      if (node.children) items(node.children, true);
    }
  };
  const blocks = nodes => { for (const block of nodes) { if (block.type === 'list') items(block.items); if (block.blocks) blocks(block.blocks); } };
  blocks(doc.blocks); return rows.sort((a, b) => a.line - b.line);
}
export function taskPatch(source, line, expectedLine, checked) {
  if (!Number.isSafeInteger(line) || line < 1 || typeof expectedLine !== 'string' || typeof checked !== 'boolean') throw Error('任务参数不正确');
  const task = parseTasks(source).find(task => task.line === line);
  if (!task || task.raw !== expectedLine) throw Error('任务已变化，请刷新列表后重试');
  if (task.completed === checked) return source;
  return source.slice(0, task.marker) + (checked ? 'x' : ' ') + source.slice(task.marker + 1);
}
