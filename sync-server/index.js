#!/usr/bin/env node
/**
 * Tracery 自托管同步服务端（独立 CLI，不依赖 Tracery 客户端）
 * ------------------------------------------------------------------
 * 职责：只做「内容寻址存储 + 版本化清单」，不理解 Markdown，不解析笔记。
 *   <data>/config.json              服务端身份（vaultId / 配对码 / 设备令牌）
 *   <data>/<vaultId>/manifest.json  { version, files: { 相对路径: { sha, size, mtime } } }
 *   <data>/<vaultId>/blobs/<sha256> 文件内容（同内容只存一份，天然去重）
 *
 * 这样做的好处：
 *   1. 服务端零业务逻辑，越简单越不容易坏；
 *   2. 内容寻址 → 同样的附件在多台设备间只传一次；
 *   3. v3 要加端到端加密时，只需把 blob 换成密文 + manifest 路径换 HMAC，协议不用改。
 *
 * 用法：
 *   npx tracery-sync                      # 默认 0.0.0.0:9600，数据在 ~/.tracery-sync
 *   npx tracery-sync --port 9600 --data D:\tracery-sync --name 家里的NAS
 *
 * 也可以作为模块嵌入：startSyncServer({ data, port, pairCode }) —— Tracery 的
 * 「局域网直连」就是用它在主机设备内部起一个同步服务端。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const out = { port: 9600, host: '0.0.0.0', data: null, name: null, pairCode: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || 9600;
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--data' || a === '-d') out.data = argv[++i];
    else if (a === '--name' || a === '-n') out.name = argv[++i];
    else if (a === '--pair-code') out.pairCode = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`
Tracery 自托管同步服务端

  --port, -p <端口>      监听端口（默认 9600）
  --host <地址>          监听地址（默认 0.0.0.0，局域网可访问）
  --data, -d <目录>      数据目录（默认 ~/.tracery-sync）
  --name, -n <名称>      服务端显示名（默认主机名）
  --pair-code <码>       指定配对码（默认随机生成，形如 ABCD-EFGH）

配对：客户端「设置 → 同步」里填本机地址 + 配对码。
`);
      process.exit(0);
    }
  }
  return out;
}

/**
 * 以库的方式启动同步服务端（局域网直连时由 Tracery 主进程内嵌调用）。
 * @returns {Promise<{ port:number, code:string, name:string, close:() => void }>}
 */
export function startSyncServer(opts = {}) {
  // 默认数据目录：新名 ~/.tracery-sync；但已部署过旧版的机器沿用 ~/.evnote-sync，
  // 否则一次改名就会让服务端「失忆」（vaultId / 配对码 / token / blob 全重来，客户端全部要重新配对）
  let defaultData = path.join(os.homedir(), '.tracery-sync');
  if (!opts.data && !fs.existsSync(defaultData) && fs.existsSync(path.join(os.homedir(), '.evnote-sync'))) {
    defaultData = path.join(os.homedir(), '.evnote-sync');
  }
  const args = {
    port: Number(opts.port) || 9600,
    host: opts.host || '0.0.0.0',
    data: opts.data || defaultData,
    name: opts.name || os.hostname(),
    pairCode: opts.pairCode || null,
    quiet: !!opts.quiet,
  };
  const DATA = path.resolve(args.data);
  const SERVER_NAME = args.name;

/* ---------------- 身份与存储 ---------------- */
const IDENTITY_FILE = path.join(DATA, 'config.json');

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符 0/O/1/I
  const pick = (n) => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${pick(4)}-${pick(4)}`;
}

function loadIdentity() {
  try {
    return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  } catch {
    fs.mkdirSync(DATA, { recursive: true });
    const identity = {
      vaultId: crypto.randomBytes(8).toString('hex'),
      name: SERVER_NAME,
      pairCode: args.pairCode || randomCode(),
      tokens: {},          // token -> { device, createdAt }
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), 'utf8');
    return identity;
  }
}

const identity = loadIdentity();
if (args.pairCode && identity.pairCode !== args.pairCode) {
  identity.pairCode = args.pairCode;
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), 'utf8');
}

const VAULT_DIR = path.join(DATA, identity.vaultId);
const BLOB_DIR = path.join(VAULT_DIR, 'blobs');
const UPLOAD_DIR = path.join(VAULT_DIR, 'uploads');
const MANIFEST_FILE = path.join(VAULT_DIR, 'manifest.json');
fs.mkdirSync(BLOB_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** 清理超过 24 小时没动静的分块上传会话 */
function cleanupUploads() {
  try {
    for (const id of fs.readdirSync(UPLOAD_DIR)) {
      const dir = path.join(UPLOAD_DIR, id);
      try {
        const st = fs.statSync(dir);
        if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function readUploadMeta(id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, id, 'meta.json'), 'utf8'));
  } catch { return null; }
}

function receivedChunks(id) {
  try {
    return fs.readdirSync(path.join(UPLOAD_DIR, id))
      .map((f) => (/^\d+\.part$/.test(f) ? Number(f.slice(0, -5)) : -1))
      .filter((n) => n >= 0)
      .sort((a, b) => a - b);
  } catch { return []; }
}

cleanupUploads();

function loadManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    return { version: m.version || 0, updatedAt: m.updatedAt || null, files: m.files || {} };
  } catch {
    return { version: 0, updatedAt: null, files: {} };
  }
}

let manifest = loadManifest();
let saving = Promise.resolve();

/** 原子写清单：先写 .tmp 再 rename，避免断电时清单损坏 */
function saveManifest() {
  saving = saving.then(async () => {
    const tmp = `${MANIFEST_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    await fsp.rename(tmp, MANIFEST_FILE);
  });
  return saving;
}

/* ---------------- 工具 ---------------- */
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('请求体过大')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function authorized(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return token && identity.tokens[token] ? identity.tokens[token] : null;
}

/** 路径安全：拒绝绝对路径、.. 穿越、隐藏目录 */
function safeRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 512) return null;
  const normalized = p.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) return null;
  return parts.join('/');
}

function lanUrls(port) {
  const urls = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`);
    }
  }
  return urls;
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${args.port}`);
  const p = u.pathname;

  try {
    // 健康检查：不需要鉴权，客户端用来判断地址是否正确
    if (p === '/api/health') {
      return json(res, 200, {
        ok: true,
        app: 'tracery-sync',
        name: identity.name,
        vaultId: identity.vaultId,
        version: manifest.version,
        files: Object.keys(manifest.files).length,
      });
    }

    // 配对：用配对码换长期 token
    if (p === '/api/pair' && req.method === 'POST') {
      const body = await readBody(req);
      if (normCode(body.code) !== normCode(identity.pairCode)) {
        return json(res, 401, { error: '配对码不正确' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      identity.tokens[token] = {
        device: String(body.deviceName || '未命名设备').slice(0, 60),
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), 'utf8');
      console.log(`[pair] 新设备已配对：${identity.tokens[token].device}`);
      return json(res, 200, {
        token,
        vaultId: identity.vaultId,
        serverName: identity.name,
        version: manifest.version,
      });
    }

    // 以下接口都要 token
    const device = authorized(req);
    if (!device) return json(res, 401, { error: '未授权：token 无效或已失效' });

    if (p === '/api/manifest' && req.method === 'GET') {
      return json(res, 200, { version: manifest.version, updatedAt: manifest.updatedAt, files: manifest.files });
    }

    if (p.startsWith('/api/blob/') && req.method === 'GET') {
      const sha = p.slice('/api/blob/'.length);
      if (!/^[a-f0-9]{64}$/.test(sha)) return json(res, 400, { error: 'sha 格式错误' });
      const file = path.join(BLOB_DIR, sha);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'blob 不存在' });
      const size = (await fsp.stat(file)).size;
      // Range：断点续传 / 分块下载
      const range = req.headers.range;
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end !== null) {          // bytes=-N 最后 N 字节
          start = Math.max(0, size - end);
          end = size - 1;
        }
        if (start === null) start = 0;
        if (end === null || end >= size) end = size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
      });
      return fs.createReadStream(file).pipe(res);
    }

    // ---- 分块上传（大附件断点续传）----
    if (p === '/api/upload/init' && req.method === 'POST') {
      const body = await readBody(req);
      const sha = String(body.sha || '');
      if (!/^[a-f0-9]{64}$/.test(sha)) return json(res, 400, { error: 'sha 格式错误' });
      if (fs.existsSync(path.join(BLOB_DIR, sha))) return json(res, 200, { done: true, sha });
      cleanupUploads();
      const uploadId = crypto.randomBytes(12).toString('hex');
      const dir = path.join(UPLOAD_DIR, uploadId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        sha,
        size: Number(body.size) || 0,
        chunkSize: Number(body.chunkSize) || 1024 * 1024,
        device,
        createdAt: new Date().toISOString(),
      }));
      return json(res, 200, { uploadId, sha, received: [] });
    }

    if (p.startsWith('/api/upload/') && req.method === 'GET') {
      const id = p.slice('/api/upload/'.length);
      const meta = readUploadMeta(id);
      if (!meta) return json(res, 404, { error: '上传会话不存在或已过期' });
      return json(res, 200, { uploadId: id, sha: meta.sha, received: receivedChunks(id) });
    }

    const chunkMatch = /^\/api\/upload\/([a-f0-9]{24})\/(\d+)$/.exec(p);
    if (chunkMatch && req.method === 'PUT') {
      const [, id, idxRaw] = chunkMatch;
      const meta = readUploadMeta(id);
      if (!meta) return json(res, 404, { error: '上传会话不存在或已过期' });
      const index = Number(idxRaw);
      if (!Number.isInteger(index) || index < 0 || index > 100000) return json(res, 400, { error: '分块序号非法' });
      const dir = path.join(UPLOAD_DIR, id);
      const part = path.join(dir, `${String(index).padStart(6, '0')}.part`);
      const tmp = `${part}.tmp`;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      await fsp.rename(tmp, part);
      return json(res, 200, { ok: true, index, received: receivedChunks(id).length });
    }

    if (p.startsWith('/api/upload/') && p.endsWith('/complete') && req.method === 'POST') {
      const id = p.slice('/api/upload/'.length, -'/complete'.length);
      const meta = readUploadMeta(id);
      if (!meta) return json(res, 404, { error: '上传会话不存在或已过期' });
      const dir = path.join(UPLOAD_DIR, id);
      const files = fs.readdirSync(dir).filter((f) => /^\d+\.part$/.test(f)).sort();
      const target = path.join(BLOB_DIR, meta.sha);
      const tmp = path.join(dir, 'assembled.tmp');
      const ws = fs.createWriteStream(tmp);
      for (const f of files) {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(path.join(dir, f));
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(ws, { end: false });
        });
      }
      await new Promise((resolve, reject) => { ws.end(resolve); ws.on('error', reject); });
      const hash = crypto.createHash('sha256').update(await fsp.readFile(tmp)).digest('hex');
      if (hash !== meta.sha) {
        await fsp.rm(dir, { recursive: true, force: true });
        return json(res, 400, { error: '分块拼装后哈希不匹配' });
      }
      await fsp.rename(tmp, target);
      await fsp.rm(dir, { recursive: true, force: true });
      return json(res, 200, { ok: true, sha: meta.sha });
    }

    if (p.startsWith('/api/blob/') && req.method === 'PUT') {
      const sha = p.slice('/api/blob/'.length);
      if (!/^[a-f0-9]{64}$/.test(sha)) return json(res, 400, { error: 'sha 格式错误' });
      const file = path.join(BLOB_DIR, sha);
      if (fs.existsSync(file)) {
        req.resume();
        return json(res, 200, { ok: true, dedup: true });
      }
      const tmp = `${file}.${process.pid}.tmp`;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      // 完整性校验：内容哈希必须等于声明的 sha
      const actual = crypto.createHash('sha256').update(await fsp.readFile(tmp)).digest('hex');
      if (actual !== sha) {
        await fsp.rm(tmp, { force: true });
        return json(res, 400, { error: '内容哈希与 sha 不匹配（传输损坏）' });
      }
      await fsp.rename(tmp, file);
      return json(res, 200, { ok: true });
    }

    // 提交变更：baseVersion 一致才接受，避免并发写覆盖
    if (p === '/api/commit' && req.method === 'POST') {
      const body = await readBody(req, 32 * 1024 * 1024);
      if (Number(body.baseVersion) !== manifest.version) {
        return json(res, 409, { error: '清单已被其他设备更新', version: manifest.version });
      }
      const changes = Array.isArray(body.changes) ? body.changes : [];
      for (const c of changes) {
        const rel = safeRelPath(c.path);
        if (!rel) return json(res, 400, { error: `非法路径：${c.path}` });
        if (c.deleted) {
          delete manifest.files[rel];
          continue;
        }
        if (!/^[a-f0-9]{64}$/.test(String(c.sha || ''))) return json(res, 400, { error: `sha 非法：${c.path}` });
        if (!fs.existsSync(path.join(BLOB_DIR, c.sha))) return json(res, 400, { error: `blob 缺失：${c.path}` });
        manifest.files[rel] = {
          sha: c.sha,
          size: Number(c.size) || 0,
          mtime: Number(c.mtime) || Date.now(),
        };
      }
      manifest.version += 1;
      manifest.updatedAt = new Date().toISOString();
      await saveManifest();
      return json(res, 200, { ok: true, version: manifest.version });
    }

    // 简易状态页：浏览器打开能看到服务端还活着
    if (p === '/' && req.method === 'GET') {
      const html = `<!doctype html><meta charset="utf-8"><title>Tracery Sync</title>
<style>body{font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:620px;margin:12vh auto;padding:0 24px;color:#1d1d1f}
h1{font-size:22px}code{background:#f2f2f4;padding:2px 6px;border-radius:5px}p{color:#6b6b70}</style>
<h1>Tracery 同步服务端</h1>
<p>服务名：<b>${identity.name}</b> · 仓库版本：<b>v${manifest.version}</b> · 文件数：<b>${Object.keys(manifest.files).length}</b></p>
<p>配对码：<code>${identity.pairCode}</code>（在客户端「设置 → 同步」里填写）</p>
<p>已配对设备：${Object.values(identity.tokens).map((t) => t.device).join('、') || '暂无'}</p>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    return json(res, 404, { error: '接口不存在' });
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, args.host, () => {
      server.off('error', reject);
      const actual = server.address().port;
      if (!args.quiet) {
        const urls = args.host === '0.0.0.0' ? lanUrls(actual) : [`http://${args.host}:${actual}`];
        console.log('\n  Tracery 同步服务端已启动');
        console.log('  服务名     ' + identity.name);
        console.log('  数据目录   ' + VAULT_DIR);
        console.log('  仓库版本   v' + manifest.version + ' · ' + Object.keys(manifest.files).length + ' 个文件');
        console.log('  配对码     ' + identity.pairCode);
        console.log('  地址       ' + (urls.join('  ') || `http://localhost:${actual}`));
        console.log('\n  在客户端「设置 → 同步」里填入地址和配对码即可。\n');
      }
      resolve({
        port: actual,
        code: identity.pairCode,
        name: identity.name,
        close: () => server.close(),
      });
    });
  });
}

/* ---------------- 直接运行 = CLI 模式 ---------------- */
function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch { return false; }
}
if (isDirectRun()) {
  startSyncServer(parseArgs(process.argv)).catch((e) => {
    console.error('启动失败:', e.message);
    process.exit(1);
  });
}
