/* 引用的目标范围与路径解析共用；改写只替换目标，保留别名、宽度、锚点和标题。 */
import { normalizeNotePath, noteIndex, resolveNote, isAttachmentTarget } from './wiki-path.js';
import { encodePdfPath } from './pdf-reference.js';
import { readProperties } from './note-properties.js';
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

export function parseFenceOpen(line, { allowDeepIndent = false } = {}) {
  const match = (allowDeepIndent ? /^\s*(`{3,}|~{3,})(.*)$/ : /^ {0,3}(`{3,}|~{3,})(.*)$/).exec(line);
  if (!match) return null;
  const marker = match[1], info = match[2] || '';
  if (marker[0] === '`' && info.includes('`')) return null;
  return { marker, lang: info.trim().split(/\s+/)[0], info, prefixLength: match[0].length - info.length };
}
export function isFenceClose(line, fence, { allowDeepIndent = false } = {}) {
  const match = (allowDeepIndent ? /^\s*(`{3,}|~{3,})\s*$/ : /^ {0,3}(`{3,}|~{3,})\s*$/).exec(line);
  return !!match && match[1][0] === fence[0] && match[1].length >= fence.length;
}
function mergeRanges(ranges) {
  if (ranges.length <= 1) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1], cur = ranges[i];
    if (cur[0] <= prev[1]) prev[1] = Math.max(prev[1], cur[1]);
    else merged.push(cur);
  }
  return merged;
}
function hasRange(ranges, pos) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [a, b] = ranges[mid];
    if (pos < a) hi = mid - 1;
    else if (pos >= b) lo = mid + 1;
    else return true;
  }
  return false;
}
export function codeMask(text, { indented = true } = {}) {
  const raw = []; let fence = null, offset = 0;
  for (const line of text.split('\n')) {
    if (fence) {
      raw.push([offset, offset + line.length]);
      if (isFenceClose(line, fence, { allowDeepIndent: !indented })) fence = null;
    } else {
      const open = parseFenceOpen(line, { allowDeepIndent: !indented });
      if (open) { fence = open.marker; raw.push([offset, offset + line.length]); }
      else if (indented && /^(?: {4}|\t)/.test(line)) raw.push([offset, offset + line.length]);
    }
    offset += line.length + 1;
  }
  const fenced = mergeRanges(raw);
  const all = [...fenced];
  if (text.includes('`')) {
    const ticks = /(`+)([\s\S]*?)\1(?!`)/g; let match;
    while ((match = ticks.exec(text))) if (!hasRange(fenced, match.index)) all.push([match.index, ticks.lastIndex]);
  }
  const merged = mergeRanges(all);
  const blocked = pos => hasRange(merged, pos);
  blocked.ranges = merged;
  return blocked;
}
const escaped = (text, pos) => { let count = 0; while (pos > 0 && text[--pos] === '\\') count++; return count % 2 === 1; };
export function scanReferences(text, { indented = true } = {}) {
  const blocked = codeMask(text, { indented }), result = [];
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
  if (explicit && ref.kind === 'wiki') return (/\.pdf$/i.test(target) ? '/' + encodePdfPath(target.replace(/^\//, '')) : target) + suffix;
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
  if (ref.kind === 'wiki' && /\.pdf$/i.test(next)) next = '/' + encodePdfPath(target.replace(/^\//, ''));
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

const TAG_RE = /(^|[\s(（])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const WIKI_LINK_RE = /!?\[\[([^\]\|#\n]+)(?:#[^\]\|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const INLINE_CODE_RE = /(`+)[^\n]*?\1(?!`)/g;

export function addPropertyTags(tags, propTags) {
  for (const tag of Array.isArray(propTags) ? propTags : typeof propTags === 'string' ? propTags.split(/[,，]/) : []) {
    if (typeof tag !== 'string') continue;
    const clean = tag.trim().replace(/^#/, '');
    if (clean) tags.add(clean);
  }
  return tags;
}

export function scanNoteIndex(source) {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const properties = readProperties(text);
  const tags = addPropertyTags(new Set(), properties.values.tags);
  const body = properties.exists && !properties.error ? properties.body : text;
  const links = [], headings = [];
  if (body.includes('[[')) {
    const blocked = codeMask(body, { indented: false });
    WIKI_LINK_RE.lastIndex = 0;
    let m;
    while ((m = WIKI_LINK_RE.exec(body))) {
      if (blocked(m.index) || escaped(body, m.index)) continue;
      if (!isAttachmentTarget(m[1])) links.push(m[1].trim());
    }
  }
  let fence = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (fence) {
      if (isFenceClose(line, fence, { allowDeepIndent: true })) fence = null;
      continue;
    }
    const open = parseFenceOpen(line, { allowDeepIndent: true });
    if (open) { fence = open.marker; continue; }
    const h = HEADING_RE.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2].replace(/[*_`~]/g, '') });
    if (line.includes('#')) {
      const prose = line.includes('`') ? line.replace(INLINE_CODE_RE, '') : line;
      TAG_RE.lastIndex = 0;
      let tm;
      while ((tm = TAG_RE.exec(prose))) tags.add(tm[2]);
    }
  }
  return { text, links, tags, headings };
}
