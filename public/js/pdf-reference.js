export function pdfPage(value) {
  const text = String(value ?? ''), match = /^(?:#?page=)?([1-9]\d{0,5})$/.exec(text);
  return match ? Number(match[1]) : null;
}
export function encodePdfPath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
export function pdfUrl(url, page) {
  const result = new URL(url, globalThis.location?.href || 'http://localhost');
  const number = pdfPage(page); if (number) result.hash = 'page=' + number;
  return result.href;
}
export function citationMarkdown(source, page, excerpt) {
  const number = pdfPage(page);
  if (!number) throw Object.assign(Error('请填写有效 PDF 页码（从 1 开始）'), { status: 400 });
  if (typeof excerpt !== 'string' || !excerpt.trim() || excerpt.length > 32000) throw Object.assign(Error('摘录须为 1–32000 字符'), { status: 400 });
  const label = source.split('/').pop().replace(/[\[\]|\r\n]/g, ' ') + ' · 第 ' + number + ' 页';
  return excerpt.replace(/\r\n?/g, '\n').trim().split('\n').map(line => '> ' + line).join('\n')
    + `\n\n来源：[[/${encodePdfPath(source)}#page=${number}|${label}]]\n`;
}
