/**
 * 局域网直连（LAN Share）
 * ------------------------------------------------------------------
 * 用户想法：同一个 Wi-Fi 下，主机设备生成一个 6 位通行码，其他设备输码即可
 * 直连同步，不用装任何服务端。
 *
 * 实现：
 *   主机 = 内嵌一个同步服务端（复用 sync-server 的 startSyncServer），
 *   并把自己的同步引擎指到它 —— 主机自己也是这台服务端的客户端，
 *   于是上传/下载/合并全部复用现有链路，零新协议。
 *   发现 = UDP 广播：客户端广播 { 通行码 }，监听中的主机回 { IP, 端口, 名称 }。
 *
 * 安全边界：
 *   - 通行码每次开启都重新生成，只用于配对换 token
 *   - 服务端只绑定局域网，配对后凭 token 通信
 *   - HTTP 明文，限局域网使用
 */
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { startSyncServer } from '../sync-server/index.js';

const DISCOVER_PORTS = [47891, 47892, 47893];
const DISCOVER_MS = 3000;

function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/** /24 近似广播地址（够用的启发式，主通道是 255.255.255.255 + 回环） */
function broadcastAddrs() {
  return ['255.255.255.255', ...localIPs().map((ip) => `${ip.split('.').slice(0, 3).join('.')}.255`)];
}

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '0.0.0.0', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 位数字
}

export function createLanShare({ getVaultRoot, getEngine, home, notify }) {
  let session = null; // { server, udp, code, port, dataDir, startedAt }

  function status() {
    return {
      running: !!session,
      code: session?.code || null,
      port: session?.port || null,
      ips: localIPs(),
      dataDir: session ? session.dataDir : null,
      startedAt: session?.startedAt || null,
    };
  }

  /** 主机：开启共享（内嵌服务端 + UDP 应答 + 把自己的引擎配对上去） */
  async function start() {
    const root = getVaultRoot();
    if (!root) throw new Error('尚未打开仓库');
    if (session) return { lan: status(), sync: getEngine().status() };

    const engine = getEngine();
    if (engine.cfg.serverUrl && engine.cfg.token) {
      throw new Error('当前仓库已配置同步，请先断开连接再开启局域网共享');
    }

    const code = randomCode();
    const port = await pickFreePort();
    const vaultId = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
    const dataDir = path.join(home, 'lan-share', vaultId);

    const server = await startSyncServer({
      data: dataDir,
      port,
      name: `EVNote · ${os.hostname()}`,
      pairCode: code,
      quiet: true,
    });

    // UDP 应答：客户端广播通行码，我们回自己的端口和名称
    const udp = dgram.createSocket('udp4');
    udp.on('message', (msg, rinfo) => {
      try {
        const q = JSON.parse(String(msg));
        if (q.t === 'evnote-discover' && String(q.code) === code) {
          const reply = Buffer.from(JSON.stringify({
            t: 'evnote-offer',
            code,
            port,
            name: `EVNote · ${os.hostname()}`,
            ips: localIPs(),
          }));
          udp.send(reply, rinfo.port, rinfo.address);
        }
      } catch { /* 无视畸形包 */ }
    });
    let udpPort = null;
    for (const p of DISCOVER_PORTS) {
      try {
        await new Promise((res, rej) => {
          udp.once('error', rej);
          udp.bind(p, () => {
            udp.off('error', rej);
            try { udp.setBroadcast(true); } catch { /* ignore */ }
            res();
          });
        });
        udpPort = p;
        break;
      } catch { /* 端口被占，试下一个 */ }
    }
    if (udpPort === null) {
      try { server.close(); } catch { /* ignore */ }
      throw new Error('发现服务的 UDP 端口被占用，无法开启共享');
    }

    session = { server, udp, code, port, dataDir, startedAt: Date.now() };

    // 主机自己的引擎也连到这个内嵌服务端：上传/下载/合并全部复用现有链路
    await engine.pair({
      serverUrl: `http://127.0.0.1:${port}`,
      code,
      deviceName: '本机（共享中转）',
    });
    notify(engine.status());
    return { lan: status(), sync: engine.status() };
  }

  /** 主机：关闭共享（断开引擎、关 UDP 与内嵌服务端） */
  async function stop() {
    const engine = getEngine();
    if (!session) return { lan: status(), sync: engine.status() };
    try { await engine.disconnect(); } catch { /* ignore */ }
    try { session.udp.close(); } catch { /* ignore */ }
    try { session.server.close(); } catch { /* ignore */ }
    session = null;
    notify(engine.status());
    return { lan: status(), sync: engine.status() };
  }

  /** 客户端：广播通行码，找到主机后探测可达地址 */
  function find(code, timeoutMs = DISCOVER_MS) {
    return new Promise((resolve) => {
      const offers = new Map();
      const sock = dgram.createSocket('udp4');
      const finish = async () => {
        try { sock.close(); } catch { /* ignore */ }
        // 依次探测：选第一个 /api/health 能通的地址（主机可能有多个网卡 IP）
        for (const o of offers.values()) {
          for (const ip of o.ips?.length ? o.ips : [o.ip]) {
            const url = `http://${ip}:${o.port}`;
            const ok = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200) })
              .then((r) => r.ok).catch(() => false);
            if (ok) { resolve({ url, name: o.name, ip }); return; }
          }
        }
        resolve(null);
      };

      sock.on('message', (msg) => {
        try {
          const o = JSON.parse(String(msg));
          if (o.t === 'evnote-offer' && String(o.code) === String(code)) {
            offers.set(o.name, o);
          }
        } catch { /* ignore */ }
      });

      sock.bind(() => {
        try { sock.setBroadcast(true); } catch { /* ignore */ }
        const q = Buffer.from(JSON.stringify({ t: 'evnote-discover', code: String(code) }));
        const targets = ['127.0.0.1', ...broadcastAddrs()];
        const sendAll = () => {
          for (const p of DISCOVER_PORTS) {
            for (const ip of targets) {
              try { sock.send(q, p, ip); } catch { /* ignore */ }
            }
          }
        };
        sendAll();
        const timer = setInterval(sendAll, 600);
        setTimeout(() => { clearInterval(timer); finish(); }, timeoutMs);
      });
    });
  }

  return { start, stop, status, find };
}
