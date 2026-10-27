/* 引用的目标范围与路径解析共用；改写只替换目标，保留别名、宽度、锚点和标题。 */
import { normalizeNotePath, noteIndex, resolveNote, isAttachmentTarget } from './wiki-path.js';
const NOTE = /\.(md|markdown|txt)$/i;
const external = value => /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(value);
export const parentPath = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
export function relativePath(from, to) {
  const a = parentPath(from).split('/').filter(Boolean), b = to.split('/');
  while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
  return [...a.map(() => '..'), ...b].join('/');
}
export function referenceIndex(paths) {
  const files = [...paths], exact = new Set(files), folded = new Map(), names = new Map();
  const add = (map, key, file) => { if (!map.has(key)) map.set(key, []); map.get(key).push(file); };
  for (const file of files) { add(folded, file.toLowerCase(), file); add(names, file.split('/').pop().toLowerCase(), file); }
  return { exact, folded, names, notes: noteIndex(files) };
}
export function resolveReference(raw, from, index, kind = 'wiki') {
  let target = raw.replace(/\\([ ()\[\]<>])/g, '$1').replace(/\\/g, '/').split(/[?#]/)[0];
  if (!target || external(target)) return null;
  try { target = decodeURIComponent(target); } catch { return null; }
  if (kind === 'wiki' && !isAttachmentTarget(target)) {
    const note = resolveNote(target, from, index.notes); if (note) return note;
  }
  const relative = /^\.\.?\//.test(target), root = target.startsWith('/');
  const candidates = root ? [normalizeNotePath(target.slice(1))] : [normalizeNotePath([parentPath(from), target].filter(Boolean).join('/')),
    ...(relative ? [] : [normalizeNotePath(target)])];
  for (const candidate of candidates) {
    if (index.exact.has(candidate)) return candidate;
    const matches = index.folded.get(candidate?.toLowerCase()); if (matches?.length === 1) return matches[0];
  }
  if (kind !== 'wiki' || relative || root || target.includes('/')) return null;
  const matches = index.names.get(target.toLowerCase()); return matches?.length === 1 ? matches[0] : null;
}

function codeMask(text) {
  const ranges = []; let fence = null, offset = 0;
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      ranges.push([offset, offset + line.length]);
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && /^\s*$/.test(line.slice(match[0].length))) fence = null;
    } else if (match) { fence = match[1]; ranges.push([offset, offset + line.length]); }
    else if (/^(?: {4}|\t)/.test(line)) ranges.push([offset, offset + line.length]);
    offset += line.length + 1;
  }
  const fenced = pos => ranges.some(([a, b]) => pos >= a && pos < b);
  const ticks = /(`+)([\s\S]*?)\1(?!`)/g; let match;
  while ((match = ticks.exec(text))) if (!fenced(match.index)) ranges.push([match.index, ticks.lastIndex]);
  return pos => ranges.some(([a, b]) => pos >= a && pos < b);
}
const escaped = (text, pos) => { let count = 0; while (pos > 0 && text[--pos] === '\\') count++; return count % 2 === 1; };
export function scanReferences(text) {
  const blocked = codeMask(text), result = [];
  const push = (from, to, kind, angle = false) => {
    const raw = text.slice(from, to), start = raw.search(/\S/), end = raw.trimEnd().length;
    if (start < 0 || external(raw.trim())) return;
    result.push({ from: from + start, to: from + end, raw: raw.trim(), kind, angle });
  };
  const wiki = /!?\[\[([^\]\n]+)\]\]/g; let match;
  while ((match = wiki.exec(text))) {
    if (blocked(match.index) || escaped(text, match.index)) continue;
    const from = match.index + (match[0].startsWith('!') ? 3 : 2), part = match[1].split('|')[0];
    push(from, from + part.length, 'wiki');
  }
  // Markdown 目标：尖括号路径、转义和成对括号；尾随的标题不属于目标。
  const destination = (start, definition = false) => {
    let cursor = start; while (/[ \t]/.test(text[cursor] || '') && cursor < text.length) cursor++;
    const angle = text[cursor] === '<', from = cursor + Number(angle); cursor = from;
    let depth = 0;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === '\\') { cursor += 2; continue; }
      if (angle ? char === '>' : /\s/.test(char) || (char === ')' && depth === 0)) break;
      if (!angle && char === '(') depth++;
      if (!angle && char === ')') depth--;
      if (char === '\n') return;
      cursor++;
    }
    if (angle && text[cursor] !== '>') return;
    if (!definition && !/^[ \t]*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))[ \t]*)?\)/.test(text.slice(cursor + Number(angle)))) return;
    if (cursor > from) push(from, cursor, 'markdown', angle);
  };
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== ']' || text[i + 1] !== '(' || blocked(i) || escaped(text, i)) continue;
    const open = text.lastIndexOf('[', i); if (open < 0 || text[open - 1] === '[' || blocked(open)) continue;
    destination(i + 2);
  }
  const definition = /^ {0,3}\[[^\]\n]+\]:[ \t]*/gm;
  while ((match = definition.exec(text))) if (!blocked(match.index)) destination(definition.lastIndex, true);
  return result.sort((a, b) => a.from - b.from).filter((item, i, all) => !i || item.from >= all[i - 1].to);
}

export function rewrittenReference(ref, from, target, index, explicit = false) {
  const suffixAt = ref.raw.search(/[?#]/), suffix = suffixAt < 0 ? '' : ref.raw.slice(suffixAt);
  const old = suffixAt < 0 ? ref.raw : ref.raw.slice(0, suffixAt);
  if (explicit && ref.kind === 'wiki') return target + suffix;
  if (resolveReference(ref.raw, from, index, ref.kind) === target) return ref.raw;
  let next;
  if (ref.kind === 'markdown' || /^\.\.?\//.test(old)) {
    next = old.startsWith('/') ? '/' + target : relativePath(from, target);
    if (ref.kind === 'wiki' && !/^\.\.?\//.test(next)) next = './' + next;
  } else if (!old.includes('/')) {
    const leaf = target.split('/').pop(), candidate = NOTE.test(target) && !NOTE.test(old) ? leaf.replace(NOTE, '') : leaf;
    next = resolveReference(candidate, from, index, 'wiki') === target ? candidate : target;
  } else next = old.startsWith('/') ? '/' + target : target;
  if (ref.kind === 'wiki' && !NOTE.test(old) && NOTE.test(next)) next = next.replace(NOTE, '');
  if (ref.kind === 'markdown') next = next.replace(/%/g, '%25').replace(ref.angle ? /[<>]/g : /[\s()<>]/g, char => encodeURIComponent(char));
  return next + suffix;
}
export function rewriteReferences(text, from, nextFrom, before, after, moveTarget = value => value, relink) {
  const edits = [];
  for (const ref of scanReferences(text)) {
    const resolved = resolveReference(ref.raw, from, before, ref.kind);
    const target = relink && ref.raw === relink.raw ? relink.target : resolved && moveTarget(resolved);
    if (!target) continue;
    const value = rewrittenReference(ref, nextFrom, target, after, !!relink);
    if (value !== ref.raw) edits.push({ ...ref, value });
  }
  for (const edit of edits.reverse()) text = text.slice(0, edit.from) + edit.value + text.slice(edit.to);
  return { text, count: edits.length };
}
