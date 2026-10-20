/* DNS-SD 只公布连接提示，不公布通行码 / token；每次扫描用 HTTP 确认可达性，避免把旧公告当在线设备。 */
import { Bonjour } from 'bonjour-service';
import os from 'node:os';
import net from 'node:net';

export const SERVICE_TYPE = 'tracery-sync';
export function localInterfaces() {
  return Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
}
const ipv4 = (s) => s.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
export function isLocalAddress(address) {
  if (net.isIP(address) !== 4) return false;
  if (address.startsWith('127.')) return true;
  const value = ipv4(address);
  return localInterfaces().some((n) => (value & ipv4(n.netmask)) === (ipv4(n.address) & ipv4(n.netmask)));
}
function text(value, max = 100) { return Array.from(String(value || '').replace(/[\x00-\x1f\x7f]/g, '')).slice(0, max).join(''); }
export function serviceCandidate(service) {
  const t = service.txt || {};
  if (service.type !== SERVICE_TYPE || service.protocol !== 'tcp' || t.app !== 'tracery' || t.v !== '1'
    || !/^[a-f0-9]{32}$/.test(t.id || '') || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return null;
  const addresses = [...new Set([service.referer?.address, ...(service.addresses || [])].filter((a) => typeof a === 'string' && isLocalAddress(a)))];
  if (!addresses.length) return null;
  return { id: t.id, name: text(t.device) || 'Tracery 设备', vault: text(t.vault), port: service.port, addresses, source: 'mdns' };
}
function transport(onError) {
  const instance = new Bonjour({}, onError);
  // 库的 errorCallback 处理应答错误；底层 socket 的 bind 错误仍需独立监听。
  instance.server.mdns.on('error', onError);
  return instance;
}
function destroy(instance) { try { instance?.destroy(); } catch { /* 已关闭或未绑定 */ } }

export async function advertise({ id, port, device, vault }, { disabled = false, factory = transport } = {}) {
  let instance, service, closed = false, networkTimer;
  const state = { available: false, error: disabled ? 'mDNS 已禁用' : null };
  const stop = async () => {
    if (closed) return; closed = true; clearInterval(networkTimer);
    if (service) await new Promise((resolve) => {
      const timer = setTimeout(resolve, 400);
      try { service.stop(() => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
    });
    destroy(instance); state.available = false;
  };
  if (disabled) return { state, stop };
  await new Promise((resolve) => {
    const timer = setTimeout(() => { state.error = 'mDNS 公告未就绪'; resolve(); }, 2500);
    const fail = () => { state.error = 'mDNS 不可用，可使用通行码或手动地址'; state.available = false; clearTimeout(timer); resolve(); };
    try {
      instance = factory(fail);
      service = instance.publish({ name: `Tracery-${id}`, host: `tracery-${id}.local`, type: SERVICE_TYPE,
        protocol: 'tcp', port, disableIPv6: true,
        txt: { app: 'tracery', v: '1', id, device: text(device, 60), vault: text(vault, 60) } });
      service.on('error', fail);
      service.on('up', () => { if (closed) return; state.available = true; state.error = null; clearTimeout(timer); resolve(); });
    } catch { fail(); }
  });
  if (!state.available) { await stop(); return { state, stop }; }
  let addresses = localInterfaces().map((n) => n.address).sort().join(',');
  networkTimer = setInterval(() => {
    const next = localInterfaces().map((n) => n.address).sort().join(',');
    if (next === addresses || closed) return;
    addresses = next;
    service.stop(() => { if (!closed) service.start(); });
  }, 5000);
  networkTimer.unref?.();
  return { state, stop };
}

export function browse({ timeoutMs = 1800, disabled = false, factory = transport } = {}) {
  if (disabled) return Promise.resolve({ candidates: [], available: false, error: 'mDNS 已禁用，可使用通行码或手动地址' });
  return new Promise((resolve) => {
    let instance, browser, done = false, timer;
    const services = new Map();
    const finish = (error = null) => {
      if (done) return; done = true; clearTimeout(timer);
      browser?.stop(); destroy(instance);
      resolve({ candidates: [...services.values()], available: !error, error });
    };
    try {
      instance = factory(() => finish('mDNS 不可用，可使用通行码或手动地址'));
      browser = instance.find({ type: SERVICE_TYPE, protocol: 'tcp' });
      const up = (s) => { const c = serviceCandidate(s); if (c) services.set(c.id, c); };
      browser.on('up', up); browser.on('srv-update', up); browser.on('txt-update', up);
      browser.on('down', (s) => services.delete(s.txt?.id));
      timer = setTimeout(() => finish(), timeoutMs);
    } catch { finish('mDNS 不可用，可使用通行码或手动地址'); }
  });
}

export async function reachable(candidate) {
  // 多网卡并发探测，VPN / 失效网卡不会逐个拖慢等待时间。
  try {
    return await Promise.any(candidate.addresses.slice(0, 8).map(async (ip) => {
      const url = `http://${ip}:${candidate.port}`;
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(900), redirect: 'error' });
      const health = await response.json();
      if (!response.ok || health.app !== 'tracery-sync' || !health.ok) throw new Error('非 Tracery 服务');
      const { addresses, ...data } = candidate;
      return { ...data, ip, url };
    }));
  } catch { return null; }
}
