/* 局域网共享复用现有同步引擎；mDNS 列出附近主机，旧版按码 UDP 查找作为兼容入口。 */
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { startSyncServer } from '../sync-server/index.js';
import { advertise, browse, reachable, localInterfaces, isLocalAddress } from './mdns.js';
const DISCOVER_PORTS = [47891, 47892, 47893];
const localIPs = () => localInterfaces().map((n) => n.address);
export function broadcastAddrs(interfaces = localInterfaces()) {
  // 按真实掩码计算，避免把 /16、/23 等网络都误当成 /24。
  return [...new Set(['255.255.255.255', ...interfaces.map((n) => n.address.split('.').map((p, i) => Number(p) | (255 ^ Number(n.netmask.split('.')[i]))).join('.'))])];
}
function close(socket) { try { socket?.close(); } catch { /* 未绑定或已关闭 */ } }
async function legacyResponder({ code, port, name }) {
  if (process.env.TRACERY_DISABLE_LAN_UDP === '1') return null;
  for (const udpPort of DISCOVER_PORTS) {
    const udp = dgram.createSocket('udp4'); udp.on('error', () => {});
    try {
      await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(udpPort, () => { udp.off('error', reject); resolve(); }); });
      udp.on('message', (msg, rinfo) => {
        if (msg.length > 1024) return;
        try {
          const q = JSON.parse(String(msg));
          if (q.t !== 'tracery-discover' || String(q.code) !== code) return;
          const reply = Buffer.from(JSON.stringify({ t: 'tracery-offer', code, port, name, ips: localIPs() }));
          udp.send(reply, rinfo.port, rinfo.address, () => {});
        } catch { /* 无视畸形包 */ }
      });
      return udp;
    } catch { close(udp); }
  }
  return null;
}

export function createLanShare({ getVaultRoot, getEngine, home, notify }) {
  let session = null, task = Promise.resolve(), scanning = null;
  const serial = (job) => { const result = task.then(job); task = result.catch(() => {}); return result; };
  function status() {
    return { running: !!session, code: session?.code || null, port: session?.port || null,
      ips: localIPs(), urls: session ? localIPs().map((ip) => `http://${ip}:${session.port}`) : [],
      dataDir: session?.dataDir || null, startedAt: session?.startedAt || null, vault: session ? path.basename(session.root) : null,
      mdns: session?.publisher.state || { available: false, error: null }, legacyAvailable: !!session?.udp };
  }
  async function startInternal() {
    const root = getVaultRoot();
    if (!root) throw new Error('尚未打开仓库');
    const engine = getEngine();
    if (session) return { lan: status(), sync: engine.status() };
    if (engine.cfg.serverUrl && engine.cfg.token) throw new Error('当前仓库已配置同步，请先断开连接再开启局域网共享');
    const code = String(crypto.randomInt(100000, 1000000)), id = crypto.randomBytes(16).toString('hex');
    const dataDir = path.join(home, 'lan-share', crypto.createHash('sha256').update(root).digest('hex').slice(0, 16));
    let server, udp, publisher;
    try {
      server = await startSyncServer({ data: dataDir, port: 0, name: `Tracery · ${os.hostname()}`, pairCode: code, quiet: true, showPairCode: false });
      udp = await legacyResponder({ code, port: server.port, name: server.name });
      await engine.pair({ serverUrl: `http://127.0.0.1:${server.port}`, code, deviceName: '本机（共享中转）' });
      publisher = await advertise({ id, port: server.port, device: os.hostname(), vault: path.basename(root) }, { disabled: process.env.TRACERY_DISABLE_MDNS === '1' });
      if (!publisher.state.available && !udp) throw new Error('局域网发现不可用，请检查网络或使用独立同步服务端');
      session = { root, id, server, udp, publisher, code, port: server.port, dataDir, startedAt: Date.now() };
      notify(engine.status());
      return { lan: status(), sync: engine.status() };
    } catch (error) {
      await publisher?.stop(); close(udp); server?.close();
      if (server && engine.cfg.serverUrl === `http://127.0.0.1:${server.port}`) await engine.disconnect().catch(() => {});
      throw error;
    }
  }
  async function stopInternal() {
    const engine = getEngine(), previous = session; session = null;
    if (previous) {
      await previous.publisher.stop(); close(previous.udp); previous.server.close();
      if (getVaultRoot() === previous.root) await engine.disconnect();
      notify(engine.status());
    }
    return { lan: status(), sync: engine.status() };
  }
  async function discover() {
    if (scanning) return scanning;
    scanning = (async () => {
      const result = await browse({ disabled: process.env.TRACERY_DISABLE_MDNS === '1' });
      const devices = [], candidates = result.candidates.slice(0, 32); let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
        while (next < candidates.length) {
          const candidate = candidates[next++], device = await reachable(candidate);
          if (device) devices.push({ ...device, isSelf: candidate.id === session?.id });
        }
      }));
      return { devices: devices.sort((a, b) => a.name.localeCompare(b.name) || a.vault.localeCompare(b.vault) || a.id.localeCompare(b.id)),
        discovery: { available: result.available, error: result.error } };
    })().finally(() => { scanning = null; });
    return scanning;
  }
  function find(code, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const offers = new Map(), sock = dgram.createSocket('udp4'); let done = false, interval;
      const timer = setTimeout(() => finish(), timeoutMs);
      const finish = async () => {
        if (done) return; done = true; clearTimeout(timer); clearInterval(interval); close(sock);
        const hits = await Promise.all([...offers.values()].map(reachable)); resolve(hits.find(Boolean) || null);
      };
      sock.on('error', () => finish());
      sock.on('message', (msg, rinfo) => {
        if (msg.length > 4096 || offers.size >= 16) return;
        try {
          const o = JSON.parse(String(msg));
          if (o.t !== 'tracery-offer' || String(o.code) !== String(code) || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return;
          const addresses = [...new Set([rinfo.address, ...(Array.isArray(o.ips) ? o.ips : [])].filter((ip) => typeof ip === 'string' && isLocalAddress(ip)))];
          offers.set(`${rinfo.address}:${o.port}`, { name: String(o.name || 'Tracery 设备').slice(0, 100), port: o.port, addresses, source: 'udp' });
        } catch { /* 无视畸形包 */ }
      });
      sock.bind(() => {
        if (done) return;
        try { sock.setBroadcast(true); } catch { finish(); return; }
        const q = Buffer.from(JSON.stringify({ t: 'tracery-discover', code: String(code) }));
        const send = () => { for (const port of DISCOVER_PORTS) for (const ip of ['127.0.0.1', ...broadcastAddrs()]) sock.send(q, port, ip, () => {}); };
        send(); interval = setInterval(send, 600);
      });
    });
  }
  return { start: () => serial(startInternal), stop: () => serial(stopInternal), status, find, discover };
}
