// A deliberately small, non-executable YAML frontmatter reader. Edits replace only
// managed fields; unrelated YAML, comments, BOM and body bytes stay as supplied.
export const PROPERTY_FIELDS = {
  course: { label: '课程', aliases: ['course', '课程'] },
  status: { label: '状态', aliases: ['status', '状态'] },
  mastery: { label: '掌握程度', aliases: ['mastery', '掌握程度'] },
  review: { label: '复习日期', aliases: ['review', 'review_date', '复习日期'] },
  tags: { label: '标签', aliases: ['tags', '标签'] },
};
const unsupported = () => { throw Error('复杂 YAML 值'); };
function scalar(raw) {
  let quote = '', end = raw.length;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) { if (c === '\\' && quote === '"') i++; else if (c === quote) { if (quote === "'" && raw[i + 1] === "'") i++; else quote = ''; } }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) { end = i; break; }
  }
  const value = raw.slice(0, end).trim();
  if (!value || value === 'null' || value === '~') return null;
  if (value.startsWith('"')) { try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : unsupported(); } catch { return unsupported(); } }
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1, -1).replace(/''/g, "'") : unsupported();
  if (/^[&*!{|>]/.test(value)) return unsupported();
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return unsupported();
    const entries = [], body = value.slice(1, -1); let quote = '', start = 0;
    for (let i = 0; i <= body.length; i++) {
      const c = body[i];
      if (quote) { if (c === '\\' && quote === '"') i++; else if (c === quote) { if (quote === "'" && body[i + 1] === "'") i++; else quote = ''; } }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ',' || i === body.length) { const part = body.slice(start, i).trim(); if (part) entries.push(scalar(part)); start = i + 1; }
    }
    if (quote || entries.some(v => Array.isArray(v))) return unsupported();
    return entries;
  }
  const plain = value.replace(/\s+#.*$/, '').trim();
  if (/^(true|false)$/i.test(plain)) return plain.toLowerCase() === 'true';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(plain) && Number.isFinite(Number(plain))) return Number(plain);
  if (/[\[\]{}]/.test(plain) || /:\s/.test(plain)) return unsupported();
  return plain;
}
export function readProperties(source) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '', text = source.slice(bom.length);
  const eol = /^---[ \t]*\r\n/.test(text) ? '\r\n' : '\n';
  const result = { values: Object.create(null), entries: [], bom, eol, exists: false, error: '', source, body: text, start: 0, end: 0, lines: [] };
  const open = /^---[ \t]*\r?\n/.exec(text); if (!open) return result;
  result.exists = true;
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm; close.lastIndex = open[0].length;
  const match = close.exec(text.slice(0, 65540));
  if (!match || match.index > 65536) { result.error = '属性区未正确结束或超过 64 KiB，请在源码中检查。'; return result; }
  result.start = open[0].length; result.close = match.index; result.end = match.index + match[0].length; result.body = text.slice(result.end);
  result.lines = text.slice(result.start, match.index).split(eol);
  if (result.lines.at(-1) === '') result.lines.pop();
  const keys = [];
  for (let i = 0; i < result.lines.length; i++) {
    const line = result.lines[i], field = /^([^\s:#][^:#]*):(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (field && !/^[#]/.test(line)) {
      const keyText = field[1].trim(); let key = keyText;
      if (/^["']/.test(keyText)) { try { key = scalar(keyText); } catch { continue; } }
      if (typeof key === 'string') keys.push({ key, keyText, raw: field[2] || '', from: i });
    }
  }
  for (let i = 0; i < keys.length; i++) {
    const item = { ...keys[i], to: keys[i + 1]?.from ?? result.lines.length, supported: true, value: null };
    // Trailing blank lines/comments belong to the surrounding document, not the field.
    while (item.to > item.from + 1 && /^(?:\s*#.*|\s*)$/.test(result.lines[item.to - 1])) item.to--;
    try {
      const children = result.lines.slice(item.from + 1, item.to).filter(line => line.trim() && !/^\s*#/.test(line));
      if (!item.raw && children.length) {
        if (!children.every(line => /^\s+-\s+/.test(line))) unsupported();
        item.value = children.map(line => scalar(line.replace(/^\s+-\s+/, '')));
      } else { if (children.length) unsupported(); item.value = scalar(item.raw); }
    } catch { item.supported = false; }
    result.entries.push(item);
    if (item.supported) result.values[item.key] = item.value;
  }
  for (const [name, field] of Object.entries(PROPERTY_FIELDS)) {
    const found = result.entries.find(entry => field.aliases.includes(entry.key));
    if (found?.supported) result.values[name] = found.value;
  }
  return result;
}
export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
export function writeProperties(source, patch) {
  const parsed = readProperties(source); if (parsed.error) throw Error(parsed.error);
  if (!parsed.exists && source.includes('\r\n')) parsed.eol = '\r\n';
  const replacements = [], appended = [];
  for (const [name, value] of Object.entries(patch)) {
    const spec = PROPERTY_FIELDS[name]; if (!spec) throw Error('未知属性：' + name);
    if (value !== null && (name === 'mastery' ? typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 : name === 'tags' ? !Array.isArray(value) || value.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_/-]*$/u.test(tag)) : typeof value !== 'string' || value.length > 1000)) throw Error(spec.label + '格式不正确');
    if (name === 'review' && value && !validDate(value)) throw Error('请输入有效的复习日期');
    const matches = parsed.entries.filter(entry => spec.aliases.includes(entry.key));
    if (matches.length > 1 || matches.some(entry => !entry.supported)) throw Error(spec.label + '包含重复字段或复杂结构，请在源码中编辑。');
    const existing = matches[0], line = value === null || value === '' || (Array.isArray(value) && !value.length) ? [] : [`${existing?.keyText || name}: ${JSON.stringify(value)}`];
    if (existing) replacements.push({ ...existing, line }); else appended.push(...line);
  }
  const lines = [...parsed.lines];
  for (const item of replacements.sort((a, b) => b.from - a.from)) lines.splice(item.from, item.to - item.from, ...item.line);
  lines.push(...appended);
  if (!parsed.exists && !lines.length) return source;
  if (!parsed.exists) return parsed.bom + ['---', ...lines, '---', ''].join(parsed.eol) + parsed.body;
  const text = source.slice(parsed.bom.length);
  return parsed.bom + text.slice(0, parsed.start) + (lines.length ? lines.join(parsed.eol) + parsed.eol : '') + text.slice(parsed.close);
}
