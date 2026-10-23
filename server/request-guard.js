import os from 'node:os';

const deny = message => Object.assign(new Error(message), { status: 403 });
function localHosts() {
  const names = new Set(['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase(), os.hostname().toLowerCase() + '.local']);
  for (const list of Object.values(os.networkInterfaces())) for (const info of list || []) names.add(info.address.toLowerCase().split('%')[0]);
  return names;
}
export function isLocalClient(req) {
  const address = String(req.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '');
  return address === '::1' || /^127\./.test(address) || localHosts().has(address);
}
/** 原生同网客户端仍可连接；浏览器请求只接受本机 Host 与同源页面。 */
export function validateRequest(req) {
  const raw = req.headers.host;
  if (typeof raw !== 'string' || req.rawHeaders?.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'host').length > 1) throw deny('Host 不合法');
  let target;
  try { target = new URL('http://' + raw); } catch { throw deny('Host 不合法'); }
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash || !localHosts().has(host) || Number(target.port || 80) !== req.socket.localPort) throw deny('仅接受本机或局域网地址');
  if (req.headers.origin) {
    let origin; try { origin = new URL(req.headers.origin); } catch { throw deny('请求来源不合法'); }
    if (origin.origin !== target.origin) throw deny('不接受跨来源请求');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw deny('不接受跨站请求');
  const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
  if (writes && hasBody && !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('写入请求必须使用 application/json'), { status: 415 });
  return true;
}
