/** Markdown 链接目的地解析；网页只允许 HTTP(S)，库内链接按笔记所在目录解释。 */
export function externalUrl(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw) || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  try { const url = new URL(raw); return url.hostname ? url.href : null; } catch { return null; }
}

/** Markdown destinations are relative to the containing note, unlike bare wiki names. */
export function localMarkdownTarget(value) {
  const raw = String(value || '').trim();
  if (!raw || /^[a-z][\w+.-]*:/i.test(raw) || /^(?:\/\/|\\)/.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let decoded;
  try { decoded = decodeURI(raw); } catch { return null; }
  if (/^[a-z][\w+.-]*:/i.test(decoded) || /^(?:\/\/|\\)/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  if (decoded.startsWith('#')) return decoded;
  return decoded.startsWith('/') ? decoded.slice(1) : /^\.{1,2}\//.test(decoded) ? decoded : './' + decoded;
}

export const decodeLinkEntities = value => value.replace(/&(?:amp|quot|lt|gt|#39);/g, entity => ({ '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#39;': "'" })[entity]);
export function markdownLinks(text) {
  const links = [], start = /(!?)\[([^\]\n]+)\]\(/g;
  let match;
  while ((match = start.exec(text))) {
    if (match[1] || text[match.index - 1] === '\\') continue;
    const body = start.lastIndex;
    let end = body, depth = 1, quoted = false;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (ch === '\n') break;
      if (ch === '\\') { end++; continue; }
      if (ch === '"') quoted = !quoted;
      if (!quoted && ch === '(') depth++;
      if (!quoted && ch === ')' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    const inner = decodeLinkEntities(text.slice(body, end).trim());
    const dest = /^(<[^>]+>|\S+?)(?:\s+"([^"\n]*)")?$/.exec(inner);
    const raw = dest?.[1].replace(/^<|>$/g, '').replace(/\\([()\\])/g, '$1');
    const external = externalUrl(raw), local = localMarkdownTarget(raw);
    const href = external || local;
    if (!href) continue;
    links.push({ from: match.index, to: end + 1, labelFrom: match.index + 1, labelTo: body - 2, href, destination: raw, kind: external ? 'external' : 'local', title: dest[2] || raw });
    start.lastIndex = end + 1;
  }
  return links;
}
export const externalLinks = text => markdownLinks(text).filter(link => link.kind === 'external');
