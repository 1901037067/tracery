// Literal, bounded search terms; no RegExp/eval or embedded query scripts.
const invalid = message => Object.assign(Error(message), { status: 400 });
export function parseSearch(query) {
  if (typeof query !== 'string' || query.length > 2048) throw invalid('搜索条件最多 2048 个字符');
  const tokens = []; let value = '', quoted = false, started = false, quotedStart = false;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (c === '\\' && quoted && ['"', '\\'].includes(query[i + 1])) { value += query[++i]; started = true; }
    else if (c === '"') { if (!started) quotedStart = true; quoted = !quoted; started = true; }
    else if (/\s/.test(c) && !quoted) { if (started) tokens.push({ value, quotedStart }); value = ''; started = false; quotedStart = false; }
    else { value += c; started = true; }
  }
  if (quoted) throw invalid('引号尚未闭合，请补齐双引号');
  if (started) tokens.push({ value, quotedStart });
  if (tokens.length > 64) throw invalid('搜索条件最多 64 项');
  const terms = tokens.map(({ value: raw, quotedStart }) => {
    const negative = !quotedStart && raw.startsWith('-') && raw.length > 1, token = negative ? raw.slice(1) : raw;
    const filter = !quotedStart && /^(path|tag):/i.exec(token);
    const kind = filter ? filter[1].toLowerCase() : !quotedStart && token.startsWith('#') ? 'tag' : 'text';
    const value = filter ? token.slice(filter[0].length) : kind === 'tag' ? token.slice(1) : token;
    if (!value.trim()) throw invalid('目录、标签或关键词不能为空');
    return { kind, value: value.toLowerCase(), negative };
  });
  const literal = terms.length === 1 && terms[0].kind === 'text' && !terms[0].negative ? tokens[0].value : null;
  return { terms, literal, highlights: terms.filter(t => t.kind === 'text' && !t.negative).map(t => t.value) };
}
export function matchesSearch(parsed, { path, name, content, tags }) {
  let text;
  const title = name.toLowerCase(), rel = path.replace(/\\/g, '/').toLowerCase();
  const tagList = [...tags].map(tag => tag.toLowerCase());
  return parsed.terms.every(term => {
    const match = term.kind === 'path' ? rel.includes(term.value.replace(/\\/g, '/')) : term.kind === 'tag' ? tagList.some(tag => tag === term.value || tag.startsWith(term.value + '/')) : title.includes(term.value) || (text ??= content.toLowerCase()).includes(term.value);
    return term.negative ? !match : match;
  });
}
