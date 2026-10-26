import crypto from 'node:crypto';

/** @param {string} origin @param {string} [html] */
export function contentSecurityPolicy(origin, html = '') {
  const url = new URL(origin);
  const socket = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  // HTML 解析会归一化换行；仅允许随应用发布的 importmap，不放行普通内联脚本。
  const normalized = html.replace(/\r\n?/g, '\n');
  const hashes = [...normalized.matchAll(/<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map(match => `'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
  return ["default-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim(), "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https: http:", "font-src 'self' data:",
    `connect-src 'self' ${socket}`, "worker-src 'self'", "frame-src 'self'", "object-src 'self'",
    "media-src 'self' blob:", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');
}

/** 仓库文件是用户数据，不能成为 script-src 'self' 允许执行的应用脚本。
 * @param {string} extension @param {string} mime */
export function attachmentHeaders(extension, mime) {
  const passive = /^(?:image\/(?:png|jpeg|gif|svg\+xml|webp|x-icon)|application\/pdf|audio\/|video\/|font\/)/.test(mime);
  return { 'Content-Type': passive ? mime : 'application/octet-stream',
    ...(!passive ? { 'Content-Disposition': 'attachment' } : {}),
    ...(extension.toLowerCase() === '.svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; frame-ancestors 'self'" } : {}) };
}
