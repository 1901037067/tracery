/** Markdown 网页链接；只允许能够交给外部浏览器的 HTTP(S) 地址。 */
export function externalUrl(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw) || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  try { const url = new URL(raw); return url.hostname ? url.href : null; } catch { return null; }
}

export function externalLinks(text) {
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
    const inner = text.slice(body, end).trim();
    const dest = /^(<[^>]+>|\S+?)(?:\s+"([^"\n]*)")?$/.exec(inner);
    const href = dest && externalUrl(dest[1].replace(/^<|>$/g, '').replace(/\\([()\\])/g, '$1'));
    if (!href) continue;
    links.push({ from: match.index, to: end + 1, labelFrom: match.index + 1, labelTo: body - 2, href, title: dest[2] || href });
    start.lastIndex = end + 1;
  }
  return links;
}
