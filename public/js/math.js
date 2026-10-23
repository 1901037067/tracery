import katex from '../vendor/katex/katex.mjs';

const cache = new Map();
export function mathHtml(tex, display = false) {
  const key = `${display}|${tex}`;
  if (cache.has(key)) return cache.get(key);
  const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 30 });
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, html); return html;
}

/** 扫描未转义的美元分隔符，跳过行内代码，避免把价格当成公式。 */
export function inlineMath(text) {
  const result = [];
  const escaped = pos => { let count = 0; while (pos > 0 && text[--pos] === '\\') count++; return count % 2 === 1; };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`' && !escaped(i)) {
      let n = 1; while (text[i + n] === '`') n++;
      const close = text.indexOf('`'.repeat(n), i + n); i = close >= 0 ? close + n - 1 : i + n - 1; continue;
    }
    if (text[i] !== '$' || escaped(i)) continue;
    const width = text[i + 1] === '$' ? 2 : 1, start = i + width;
    if (!text[start] || /\s/.test(text[start])) { i += width - 1; continue; }
    for (let j = start; j < text.length; j++) {
      if (text[j] === '\n' || (text[j] === '`' && !escaped(j))) break;
      if (text[j] !== '$' || escaped(j)) continue;
      if (width === 2 && text[j + 1] !== '$') continue;
      if (/\s/.test(text[j - 1]) || (width === 1 && /\d/.test(text[j + 1] || ''))) break;
      result.push({ from: i, to: j + width, tex: text.slice(start, j), display: width === 2 });
      i = j + width - 1; break;
    }
  }
  return result;
}
