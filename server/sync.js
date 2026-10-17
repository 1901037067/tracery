/**
 * EVNote 同步引擎（v1：文件级 + 冲突副本）
 * ------------------------------------------------------------------
 * 跑在「主进程」一侧（Node 服务端），因为只有它能碰文件系统。
 * 浏览器端只负责配置界面和展示状态，永远不直接与同步服务端通信。
 *
 * 同步判定（三方比对：local / remote / base）：
 *    base   = 上次同步成功时记录的 sha，用来判断「谁改过」
 *    只有本地改  → 上传
 *    只有远端改  → 下载
 *    两边都改    → 冲突：本地内容保留在原路径，远端内容写成「冲突副本」
 *    本地删除    → 提交删除（对方收到时文件进 .evnote/trash，不直接销毁）
 *
 * 为什么 v1 不做自动合并：Markdown 的合并结果一旦预测错，用户很难发现。
 * 宁可多一个副本文件，也不静默改用户的字。diff3 三方合并留到 v2。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mergeText, isMergeablePath } from './merge.js';

const IGNORED_DIRS = new Set(['.evnote', '.obsidian', '.git', 'node_modules', '.trash']);
const MAX_FILE = 100 * 1024 * 1024;   // 单文件上限 100MB
const MAX_ATTEMPTS = 3;               // 提交时清单被抢占的重试次数
const CHUNK = 1024 * 1024;            // 分块大小 1MB
const CHUNK_THRESHOLD = Number(process.env.EVNOTE_CHUNK_THRESHOLD) || 4 * 1024 * 1024;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export class SyncEngine {
  /**
   * @param {object} opts
   * @param {() => string|null} opts.getVaultRoot 当前仓库根目录
   * @param {() => object} opts.getSettings       读取 settings.sync
   * @param {() => object} opts.getSettings 旧接口保留（同步配置已改为每仓库一份）
   * @param {(status: object) => void} opts.notify 状态变化通知（WS 广播）
   * @param {(kind: string) => void} opts.onApplied 同步写入文件后回调（重载索引）
   */
  constructor(opts) {
    this.getVaultRoot = opts.getVaultRoot;
    this.getDefaultSettings = opts.getSettings || (() => ({}));
    this.notify = opts.notify || (() => {});
    this.onApplied = opts.onApplied || (() => {});
    this.running = null;
    this.timer = null;
    this.pending = null;
    this.suppressUntil = 0;
    this.lastResult = null;
    this.progress = null;
    this._cfgCache = null;
    this._cfgFor = null;
  }

  /* ---------------- 配置（每个仓库一份，存在 <vault>/.evnote/sync.json） ----------------
   * 为什么不是全局：同步目标是「某个服务端的某个仓库」，不同笔记仓库绝不能共用一个同步配置，
   * 否则切换仓库时会把 A 的内容灌进 B。仓库内的 .evnote 不参与同步，token 不会外泄。
   */
  _configFile() {
    const root = this.getVaultRoot();
    return root ? path.join(root, '.evnote', 'sync.json') : null;
  }

  get cfg() {
    const file = this._configFile();
    if (!file) return {};
    if (this._cfgCache && this._cfgFor === file) return this._cfgCache;
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
    this._cfgCache = {
      serverUrl: '', token: '', vaultId: '', serverName: '', deviceName: '',
      autoSync: true, autoMerge: true, interval: 60, lastSyncAt: null, lastError: null,
      ...data,
    };
    this._cfgFor = file;
    return this._cfgCache;
  }

  _saveCfg(patch) {
    const next = { ...this.cfg, ...patch };
    const file = this._configFile();
    if (!file) return next;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    this._cfgCache = next;
    this._cfgFor = file;
    return next;
  }

  get configured() {
    const c = this.cfg;
    return !!(this.getVaultRoot() && c.serverUrl && c.token);
  }

  normalizeUrl(url) {
    let u = String(url || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
    return u;
  }

  status() {
    const c = this.cfg;
    return {
      configured: this.configured,
      serverUrl: c.serverUrl || '',
      serverName: c.serverName || '',
      deviceName: c.deviceName || '',
      vaultId: c.vaultId || '',
      autoSync: c.autoSync !== false,
      autoMerge: c.autoMerge !== false,
      interval: Number(c.interval) || 60,
      lastSyncAt: c.lastSyncAt || null,
      lastError: c.lastError || null,
      syncing: !!this.running,
      progress: this.progress,
      lastResult: this.lastResult,
    };
  }

  /* ---------------- 连接 / 断开 ---------------- */
  async pair({ serverUrl, code, deviceName }) {
    const url = this.normalizeUrl(serverUrl);
    if (!url) throw new Error('请填写同步服务端地址');
    if (!code) throw new Error('请填写配对码');

    let health;
    try {
      health = await this._fetchJson('GET', url, '/api/health', { auth: false });
    } catch (e) {
      throw new Error(`连不上同步服务端：${e.message}`);
    }
    if (!health?.ok) throw new Error('这个地址不是 EVNote 同步服务端');

    const paired = await this._fetchJson('POST', url, '/api/pair', {
      auth: false,
      body: {
        code: String(code).trim(),
        deviceName: deviceName || defaultDeviceName(),
      },
    });

    const prev = this.cfg;
    const sameTarget = prev.serverUrl === url && prev.vaultId === paired.vaultId;
    this._saveCfg({
      serverUrl: url,
      token: paired.token,
      vaultId: paired.vaultId,
      serverName: paired.serverName || health.name || '',
      deviceName: deviceName || prev.deviceName || defaultDeviceName(),
      lastError: null,
    });
    if (!sameTarget) await this._resetState(url, paired.vaultId);

    this.notify(this.status());
    this.startAuto();
    // 配对后立即跑一次，让用户马上看到结果
    const result = await this.syncNow({ reason: 'pair' });
    return { ...this.status(), firstResult: result };
  }

  async disconnect({ forget = false } = {}) {
    this.stopAuto();
    await this._resetState(null, null);
    this._saveCfg({
      serverUrl: '', token: '', vaultId: '', serverName: '',
      lastSyncAt: null, lastError: null,
    });
    if (forget) this.lastResult = null;
    this.notify(this.status());
    return this.status();
  }

  setOptions({ autoSync, autoMerge, interval, deviceName }) {
    const patch = {};
    if (typeof autoSync === 'boolean') patch.autoSync = autoSync;
    if (typeof autoMerge === 'boolean') patch.autoMerge = autoMerge;
    if (Number.isFinite(interval)) patch.interval = Math.min(3600, Math.max(15, Math.round(interval)));
    if (typeof deviceName === 'string' && deviceName.trim()) {
      patch.deviceName = deviceName.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
    }
    this._saveCfg(patch);
    this.startAuto();
    this.notify(this.status());
    return this.status();
  }

  /* ---------------- 自动同步 ---------------- */
  startAuto() {
    this.stopAuto();
    if (!this.configured || this.cfg.autoSync === false) return;
    const ms = Math.max(15, Number(this.cfg.interval) || 60) * 1000;
    this.timer = setInterval(() => {
      this.syncNow({ reason: 'timer' }).catch(() => {});
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  stopAuto() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }

  /** 本地文件变化后调用：延迟合并成一次同步，避免打字过程反复传输 */
  scheduleSync(reason = 'local-change', delay = 4000) {
    if (!this.configured || this.cfg.autoSync === false) return;
    if (Date.now() < this.suppressUntil) return;   // 刚被同步写盘，别回环
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      this.syncNow({ reason }).catch(() => {});
    }, delay);
    if (this.pending.unref) this.pending.unref();
  }

  /** 同步刚写过文件：这段时间内忽略 watcher 事件，防止自激 */
  noteWrite() { this.suppressUntil = Date.now() + 2500; }

  /* ---------------- 核心：一次同步 ---------------- */
  async syncNow({ reason = 'manual' } = {}) {
    if (!this.configured) throw new Error('尚未连接同步服务端');
    if (!this.getVaultRoot()) throw new Error('尚未打开仓库');
    if (this.running) return this.running;

    this.running = this._syncLoop(reason)
      .catch((e) => {
        const msg = e.message || String(e);
        this._saveCfg({ lastError: msg });
        this.notify(this.status());
        throw e;
      })
      .finally(() => {
        this.running = null;
        this.progress = null;
        this.notify(this.status());
      });
    this.notify(this.status());
    return this.running;
  }

  async _syncLoop(reason) {
    const root = this.getVaultRoot();
    const state = await this._loadState();
    const stats = { uploaded: 0, downloaded: 0, deleted: 0, merged: [], conflicts: [], version: 0, reason };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remote = await this._fetchJson('GET', this.cfg.serverUrl, '/api/manifest');
      const local = await this._snapshot(root);
      const base = state.files || {};
      const paths = new Set([...Object.keys(base), ...local.keys(), ...Object.keys(remote.files || {})]);
      const changes = [];
      const uploads = [];
      const downloads = [];
      const nextBase = {};

      for (const rel of paths) {
        const l = local.get(rel)?.sha || null;
        const r = remote.files?.[rel]?.sha || null;
        const b = base[rel] || null;

        if (l === r) { if (r) nextBase[rel] = r; continue; }

        if (l === b) {
          // 本地没动，远端变了
          if (r) { downloads.push({ path: rel, sha: r, size: remote.files[rel].size }); nextBase[rel] = r; }
          else { this._trashLocal(root, rel); stats.deleted++; }   // 远端删除 → 本地进回收站
          continue;
        }
        if (r === b) {
          // 远端没动，本地变了
          if (l) {
            uploads.push({ path: rel, sha: l });
            changes.push({ path: rel, sha: l, size: local.get(rel).size, mtime: local.get(rel).mtime });
            nextBase[rel] = l;
          } else {
            changes.push({ path: rel, deleted: true });
            stats.deleted++;
          }
          continue;
        }

        // —— 两边都变了 ——
        if (l && r) {
          // 先试自动合并：同一篇笔记改的不是同一段，就没有理由让用户手工合
          const merged = await this._tryAutoMerge(root, rel, b, r, l);
          if (merged) {
            uploads.push({ path: rel, sha: merged.sha });
            changes.push({ path: rel, sha: merged.sha, size: merged.size, mtime: merged.mtime });
            nextBase[rel] = merged.sha;
            stats.merged.push(rel);
            continue;
          }
          // 合不了（同一段/二进制/缺 base）：本地保留原路径，远端内容落成副本（两份都不丢）
          const copyRel = await this._writeConflictCopy(root, rel, r);
          if (copyRel) {
            const buf = await fsp.readFile(path.join(root, copyRel));
            const copySha = sha256(buf);
            const st = await fsp.stat(path.join(root, copyRel));
            uploads.push({ path: copyRel, sha: copySha });
            changes.push({ path: copyRel, sha: copySha, size: st.size, mtime: Math.round(st.mtimeMs) });
            nextBase[copyRel] = copySha;
            stats.conflicts.push({ path: rel, copy: copyRel });
          }
          uploads.push({ path: rel, sha: l });
          changes.push({ path: rel, sha: l, size: local.get(rel).size, mtime: local.get(rel).mtime });
          nextBase[rel] = l;
        } else if (l && !r) {
          // 远端删除 + 本地修改 → 保留本地，重新上传
          uploads.push({ path: rel, sha: l });
          changes.push({ path: rel, sha: l, size: local.get(rel).size, mtime: local.get(rel).mtime });
          nextBase[rel] = l;
        } else if (!l && r) {
          // 本地删除 + 远端修改 → 恢复远端（宁可多一个文件，也不丢内容）
          downloads.push({ path: rel, sha: r, size: remote.files[rel].size });
          nextBase[rel] = r;
        }
      }

      // 1. 下载
      for (const d of downloads) {
        await this._downloadBlob(root, d.path, d.sha, d.size);
        stats.downloaded++;
        this.progress = { phase: 'download', done: stats.downloaded, total: downloads.length };
        this.notify(this.status());
      }

      // 2. 上传
      for (let i = 0; i < uploads.length; i++) {
        await this._uploadBlob(root, uploads[i]);
        stats.uploaded++;
        this.progress = { phase: 'upload', done: i + 1, total: uploads.length };
        this.notify(this.status());
      }

      // 3. 提交清单
      let committedVersion = remote.version;
      if (changes.length) {
        const res = await this._fetchJson('POST', this.cfg.serverUrl, '/api/commit', {
          body: { baseVersion: remote.version, changes, deviceName: this.cfg.deviceName },
        });
        if (!res) { // 409：其他设备抢先提交，重新来一轮
          if (attempt < MAX_ATTEMPTS) continue;
          throw new Error('同步冲突重试次数超限，请稍后再试');
        }
        committedVersion = res.version;
      }

      stats.version = committedVersion;
      state.version = committedVersion;
      state.files = nextBase;
      state.serverUrl = this.cfg.serverUrl;
      state.vaultId = this.cfg.vaultId;
      await this._saveState(root, state);

      if (downloads.length) await this.onApplied('download');
      this._saveCfg({ lastSyncAt: new Date().toISOString(), lastError: null });
      this.lastResult = { ...stats, at: new Date().toISOString() };
      return this.lastResult;
    }
    throw new Error('同步未能完成');
  }

  /* ---------------- 文件快照（sha256） ---------------- */
  async _snapshot(root) {
    const files = new Map();
    const walk = async (abs, rel) => {
      let entries;
      try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (IGNORED_DIRS.has(e.name)) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        const absPath = path.join(abs, e.name);
        if (e.isDirectory()) { await walk(absPath, relPath); continue; }
        if (!e.isFile()) continue;
        try {
          const st = await fsp.stat(absPath);
          if (st.size > MAX_FILE) continue;          // 超大文件跳过，避免一次爆内存
          const buf = await fsp.readFile(absPath);
          files.set(relPath, { sha: sha256(buf), size: st.size, mtime: Math.round(st.mtimeMs) });
        } catch { /* 瞬时不可读：本轮跳过 */ }
      }
    };
    await walk(root, '');
    return files;
  }

  /* ---------------- blob 传输 ---------------- */
  async _uploadBlob(root, { path: rel, sha }) {
    const abs = path.join(root, rel);
    const st = await fsp.stat(abs);
    // 小文件一次性 PUT；大附件走分块（断了能续，不重传整份）
    if (st.size < CHUNK_THRESHOLD) {
      const buf = await fsp.readFile(abs);
      await this._fetchRaw('PUT', this.cfg.serverUrl, `/api/blob/${sha}`, buf);
      return;
    }
    await this._uploadChunked(abs, sha, st.size);
  }

  /** 分块上传：先问服务端要会话和已收到的块，再补缺的块，最后让它拼装校验 */
  async _uploadChunked(abs, sha, size) {
    const init = await this._fetchJson('POST', this.cfg.serverUrl, '/api/upload/init', {
      body: { sha, size, chunkSize: CHUNK },
    });
    if (init?.done) return;                        // 服务端已有同内容 blob（去重）
    const uploadId = init?.uploadId;
    if (!uploadId) throw new Error('服务端未返回上传会话');

    let received = new Set(init.received || []);
    try {
      const st = await this._fetchJson('GET', this.cfg.serverUrl, `/api/upload/${uploadId}`);
      received = new Set(st?.received || []);
    } catch { /* 拿不到就从头传 */ }

    const fh = await fsp.open(abs, 'r');
    try {
      const total = Math.ceil(size / CHUNK);
      for (let i = 0; i < total; i++) {
        if (received.has(i)) continue;
        const len = Math.min(CHUNK, size - i * CHUNK);
        const buf = Buffer.allocUnsafe(len);
        await fh.read(buf, 0, len, i * CHUNK);
        await this._putChunkWithRetry(uploadId, i, buf);
      }
    } finally {
      await fh.close();
    }
    await this._fetchJson('POST', this.cfg.serverUrl, `/api/upload/${uploadId}/complete`, { body: {} });
  }

  async _putChunkWithRetry(uploadId, index, buf) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this._fetchRaw('PUT', this.cfg.serverUrl, `/api/upload/${uploadId}/${index}`, buf);
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /** 下载：支持 Range 断点续传（中途断了只补缺失部分） */
  async _downloadBlob(root, rel, sha, size = 0) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.evnote-tmp`;
    let got = 0;
    try { got = (await fsp.stat(tmp)).size; } catch { got = 0; }
    if (size && got > size) { await fsp.rm(tmp, { force: true }); got = 0; }
    if (size && got === size && size > 0) {
      await fsp.rename(tmp, abs);
      this.noteWrite();
      return;
    }

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const headers = {};
        if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
        if (got > 0) headers.Range = `bytes=${got}-`;
        const res = await fetch(`${this.cfg.serverUrl}/api/blob/${sha}`, {
          headers,
          signal: AbortSignal.timeout(180000),
        });
        if (res.status === 416) break;                    // 已经下全了
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (res.status === 200) got = 0;                  // 服务端不支持 Range：整份重下
        const ws = fs.createWriteStream(tmp, { flags: got > 0 ? 'a' : 'w' });
        await pipeline(Readable.fromWeb(res.body), ws);
        const st = await fsp.stat(tmp);
        got = st.size;
        if (!size || got >= size) break;
        throw new Error('下载不完整，继续续传');
      } catch (e) {
        lastErr = e;
        if (attempt === 2) throw lastErr;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    await fsp.rename(tmp, abs);
    this.noteWrite();
  }

  /**
   * 尝试对文本笔记做三方合并。
   * 成功返回 { sha, size, mtime }（本地文件已写成合并结果），失败/有冲突返回 null。
   * base 的旧内容从服务端 blob 取——服务端保留历史 blob，正好当合并基准。
   */
  async _tryAutoMerge(root, rel, baseSha, remoteSha, localSha) {
    if (this.cfg.autoMerge === false) return null;
    if (!baseSha || !isMergeablePath(rel)) return null;
    try {
      const [baseBuf, remoteBuf] = await Promise.all([
        this._fetchRaw('GET', this.cfg.serverUrl, `/api/blob/${baseSha}`),
        this._fetchRaw('GET', this.cfg.serverUrl, `/api/blob/${remoteSha}`),
      ]);
      const abs = path.join(root, rel);
      const localText = await fsp.readFile(abs, 'utf8');
      const { text, conflicts } = mergeText(baseBuf.toString('utf8'), localText, remoteBuf.toString('utf8'));
      if (conflicts > 0) return null;              // 同一段被两边改了 → 交给冲突副本

      const buf = Buffer.from(text, 'utf8');
      const sha = sha256(buf);
      if (sha === localSha) {
        const st = await fsp.stat(abs);
        return { sha, size: st.size, mtime: Math.round(st.mtimeMs) };
      }
      await fsp.writeFile(abs, buf);
      this.noteWrite();
      const st = await fsp.stat(abs);
      return { sha, size: st.size, mtime: Math.round(st.mtimeMs) };
    } catch {
      return null;   // 缺 blob / 编码异常：退回保守策略
    }
  }

  /** 把远端版本写成「冲突副本」，返回相对路径 */
  async _writeConflictCopy(root, rel, remoteSha) {
    try {
      const buf = await this._fetchRaw('GET', this.cfg.serverUrl, `/api/blob/${remoteSha}`);
      const ext = path.extname(rel);
      const base = rel.slice(0, rel.length - ext.length);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const device = (this.cfg.deviceName || defaultDeviceName()).replace(/[\\/:*?"<>|]/g, '-');
      let copyRel = `${base} (冲突 ${device} ${stamp})${ext}`;
      let n = 1;
      while (fs.existsSync(path.join(root, copyRel))) {
        copyRel = `${base} (冲突 ${device} ${stamp}-${++n})${ext}`;
      }
      const abs = path.join(root, copyRel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buf);
      this.noteWrite();
      return copyRel;
    } catch {
      return null;  // 拿不到远端内容就跳过副本，主体同步继续
    }
  }

  /** 远端删除时，本地文件移进 .evnote/trash 而不是直接删掉 */
  _trashLocal(root, rel) {
    try {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(root, '.evnote', 'trash', stamp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(abs, dest);
      this.noteWrite();
    } catch { /* 移动失败就保留原文件，下轮再试 */ }
  }

  /* ---------------- HTTP ---------------- */
  async _fetchJson(method, baseUrl, apiPath, { body, auth = true } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth && this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
    let res;
    try {
      res = await fetch(`${baseUrl}${apiPath}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? '请求超时' : (e.cause?.code || e.message));
    }
    if (res.status === 409) return null;                 // 交给调用方重试
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    try { return await res.json(); } catch { return {}; }
  }

  async _fetchRaw(method, baseUrl, apiPath, buf) {
    const headers = {};
    if (buf) headers['Content-Length'] = String(buf.length);
    if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
    let res;
    try {
      res = await fetch(`${baseUrl}${apiPath}`, {
        method,
        headers,
        body: buf,
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? '传输超时' : (e.cause?.code || e.message));
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    if (method === 'GET') return Buffer.from(await res.arrayBuffer());
    return res.json().catch(() => ({}));
  }

  /* ---------------- 状态文件（存在 .evnote 里，不参与同步） ---------------- */
  _stateFile(root) { return root ? path.join(root, '.evnote', 'sync-state.json') : null; }

  async _loadState() {
    const root = this.getVaultRoot();
    const file = this._stateFile(root);
    if (!file) return { version: 0, files: {} };
    try {
      const st = JSON.parse(await fsp.readFile(file, 'utf8'));
      // 换了服务端或仓库：base 作废，否则会把两边的文件误判成「对方删除」
      if (st.serverUrl !== this.cfg.serverUrl || st.vaultId !== this.cfg.vaultId) {
        return { version: 0, files: {} };
      }
      return { version: st.version || 0, files: st.files || {} };
    } catch {
      return { version: 0, files: {} };
    }
  }

  async _saveState(root, state) {
    const file = this._stateFile(root || this.getVaultRoot());
    if (!file) return;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  }

  async _resetState(serverUrl, vaultId) {
    const root = this.getVaultRoot();
    const file = this._stateFile(root);
    if (!file) return;
    try { await fsp.rm(file, { force: true }); } catch { /* ignore */ }
  }
}

function defaultDeviceName() {
  const host = (process.env.COMPUTERNAME || process.env.HOSTNAME || 'device').replace(/\s+/g, '-');
  return host.slice(0, 40);
}
