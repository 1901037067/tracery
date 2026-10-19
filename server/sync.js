/**
 * Tracery 同步引擎（v1：文件级 + 冲突副本）
 * ------------------------------------------------------------------
 * 跑在「主进程」一侧（Node 服务端），因为只有它能碰文件系统。
 * 浏览器端只负责配置界面和展示状态，永远不直接与同步服务端通信。
 *
 * 同步判定（三方比对：local / remote / base）：
 *    base   = 上次同步成功时记录的 sha，用来判断「谁改过」
 *    只有本地改  → 上传
 *    只有远端改  → 下载
 *    两边都改    → 冲突：本地内容保留在原路径，远端内容写成「冲突副本」
 *    本地删除    → 提交删除（对方收到时文件进 .tracery/trash，不直接销毁）
 *
 * 为什么 v1 不做自动合并：Markdown 的合并结果一旦预测错，用户很难发现。
 * 宁可多一个副本文件，也不静默改用户的字。diff3 三方合并留到 v2。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mergeText, isMergeablePath } from './merge.js';
import {
  deriveKeys, newSalt, keyToHex, keyFromHex,
  encryptBuffer, decryptBuffer, nameToken, makeCheck, verifyCheck,
} from './crypto.js';

const IGNORED_DIRS = new Set(['.tracery', '.evnote', '.obsidian', '.git', 'node_modules', '.trash']);
const MAX_FILE = 100 * 1024 * 1024;   // 单文件上限 100MB
const MAX_ATTEMPTS = 3;               // 提交时清单被抢占的重试次数
const CHUNK = 1024 * 1024;            // 分块大小 1MB
const CHUNK_THRESHOLD = Number(process.env.TRACERY_CHUNK_THRESHOLD) || 4 * 1024 * 1024;
// 加密模式下 manifest 里两个**保留 key**（明文，不带用户信息）：
//   meta  = { v:3, salt, check }，新设备靠它派生密钥并校验密码
//   index = 加密的 { names: { hmac: 相对路径 } }，新设备靠它把 hmac 还原成路径
const META_KEY = 'tracery-v3-meta';
const INDEX_KEY = 'tracery-v3-index';
const RESERVED_KEYS = new Set([META_KEY, INDEX_KEY]);

/**
 * 仓库配置目录：新名 .tracery；首次打开旧仓库时把 .evnote 整体迁过来。
 * 为什么必须迁移而不是直接读旧名：.evnote 里有用户的 sync.json（配对 token）、
 * sync-state.json（同步基准）和 trash/（回收站），硬切目录等于丢配对、丢回收站。
 * 迁移失败（占用/权限）时返回旧目录路径，行为完全兼容，不阻塞启动。
 */
export function vaultConfigDir(root) {
  const now = path.join(root, '.tracery');
  const legacy = path.join(root, '.evnote');
  if (!fs.existsSync(now) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, now);
      console.log(`[迁移] 仓库配置目录 ${legacy} → ${now}`);
    } catch (e) {
      console.warn(`[迁移失败] 继续兼容读取旧目录：${e.message}`);
      return legacy;
    }
  }
  return now;
}

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
    this._cfgMtime = 0;
  }

  /* ---------------- 配置（每个仓库一份，存在 <vault>/.tracery/sync.json） ----------------
   * 为什么不是全局：同步目标是「某个服务端的某个仓库」，不同笔记仓库绝不能共用一个同步配置，
   * 否则切换仓库时会把 A 的内容灌进 B。仓库内的 .tracery 不参与同步，token 不会外泄。
   */
  _configFile() {
    const root = this.getVaultRoot();
    return root ? path.join(vaultConfigDir(root), 'sync.json') : null;
  }

  get cfg() {
    const file = this._configFile();
    if (!file) return {};
    // 文件被外部改过（换机拷贝、手工修配置）也要能读到：缓存按 mtime 失效
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
    if (this._cfgCache && this._cfgFor === file && this._cfgMtime === mtime) return this._cfgCache;
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
    this._cfgCache = {
      serverUrl: '', token: '', vaultId: '', serverName: '', deviceName: '',
      autoSync: true, autoMerge: true, interval: 60, lastSyncAt: null, lastError: null,
      encryption: null,
      ...data,
    };
    this._cfgFor = file;
    this._cfgMtime = mtime;
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
    try { this._cfgMtime = fs.statSync(file).mtimeMs; } catch { this._cfgMtime = 0; }
    return next;
  }

  /** 本机已装好加密钥匙时返回配置，否则 null */
  get _enc() {
    const e = this.cfg.encryption;
    return e && e.enabled && e.encKey && e.nameKey ? e : null;
  }

  _encKey() { return keyFromHex(this._enc.encKey); }
  _nameKey() { return keyFromHex(this._enc.nameKey); }

  /** 逻辑路径 → manifest key（加密模式是 HMAC，明文模式就是路径本身） */
  _keyOf(rel) { return this._enc ? nameToken(this._nameKey(), rel) : rel; }

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
      // 端到端加密：encrypted = 已装好钥匙；needsPassword = 仓库是加密的但本机还没解锁
      encrypted: !!this._enc,
      needsPassword: !!(c.encryption && c.encryption.enabled && !c.encryption.encKey),
      syncing: !!this.running,
      progress: this.progress,
      lastResult: this.lastResult,
    };
  }

  /* ---------------- 连接 / 断开 ---------------- */
  async pair({ serverUrl, code, deviceName, password, encrypt }) {
    const url = this.normalizeUrl(serverUrl);
    if (!url) throw new Error('请填写同步服务端地址');
    if (!code) throw new Error('请填写配对码');

    let health;
    try {
      health = await this._fetchJson('GET', url, '/api/health', { auth: false });
    } catch (e) {
      throw new Error(`连不上同步服务端：${e.message}`);
    }
    if (!health?.ok) throw new Error('这个地址不是 Tracery 同步服务端');

    const paired = await this._fetchJson('POST', url, '/api/pair', {
      auth: false,
      body: {
        code: String(code).trim(),
        deviceName: deviceName || defaultDeviceName(),
      },
    });

    const prev = { ...this.cfg };
    const sameTarget = prev.serverUrl === url && prev.vaultId === paired.vaultId;
    // 先带着新 token 写一份临时配置：下面的 manifest/meta 探测都要用 token
    this._saveCfg({
      serverUrl: url,
      token: paired.token,
      vaultId: paired.vaultId,
      serverName: paired.serverName || health.name || '',
      deviceName: deviceName || prev.deviceName || defaultDeviceName(),
      lastError: null,
    });

    // 端到端加密：服务端只放 salt + check，密码永远不上传
    let encryption = null;
    try {
      const manifest = await this._fetchJson('GET', url, '/api/manifest');
      const metaEnt = manifest?.files?.[META_KEY];
      if (metaEnt) {
        if (!password) throw new Error('这个仓库启用了端到端加密，请输入同步密码');
        const meta = JSON.parse((await this._fetchRaw('GET', url, `/api/blob/${metaEnt.sha}`)).toString('utf8'));
        const { encKey, nameKey } = deriveKeys(password, meta.salt);
        if (!verifyCheck(encKey, meta.check)) throw new Error('同步密码不正确');
        encryption = {
          enabled: true, salt: meta.salt,
          encKey: keyToHex(encKey), nameKey: keyToHex(nameKey), check: meta.check,
        };
      } else if (encrypt) {
        if (!password || String(password).length < 6) throw new Error('端到端加密的密码至少 6 位');
        if (Object.keys(manifest?.files || {}).length) {
          throw new Error('这个仓库里已有明文数据，不能直接开加密：请换一个空仓库，或先断开再重新配对');
        }
        const salt = newSalt();
        const { encKey, nameKey } = deriveKeys(password, salt);
        encryption = {
          enabled: true, salt,
          encKey: keyToHex(encKey), nameKey: keyToHex(nameKey), check: makeCheck(encKey),
        };
      }
    } catch (e) {
      // 配对失败（密码错/加密冲突）：把 token 之外的配置回滚，别留一个半连上的状态
      this._saveCfg({ ...prev, lastError: null });
      throw e;
    }

    this._saveCfg({ encryption });
    if (!sameTarget || (prev.encryption?.salt !== encryption?.salt)) await this._resetState(url, paired.vaultId);

    this.notify(this.status());
    this.startAuto();
    // 配对后立即跑一次，让用户马上看到结果
    const result = await this.syncNow({ reason: 'pair' });
    return { ...this.status(), firstResult: result };
  }

  /** 已配对但本机没解锁（换设备/重装）时，用密码装回钥匙 */
  async unlock({ password }) {
    if (!this.configured) throw new Error('尚未连接同步服务端');
    if (!password) throw new Error('请输入同步密码');
    const manifest = await this._fetchJson('GET', this.cfg.serverUrl, '/api/manifest');
    const ent = manifest?.files?.[META_KEY];
    if (!ent) throw new Error('这个仓库没有启用端到端加密');
    const meta = JSON.parse((await this._fetchRaw('GET', this.cfg.serverUrl, `/api/blob/${ent.sha}`)).toString('utf8'));
    const { encKey, nameKey } = deriveKeys(password, meta.salt);
    if (!verifyCheck(encKey, meta.check)) throw new Error('同步密码不正确');
    this._saveCfg({
      encryption: { enabled: true, salt: meta.salt, encKey: keyToHex(encKey), nameKey: keyToHex(nameKey), check: meta.check },
      lastError: null,
    });
    await this._resetState(this.cfg.serverUrl, this.cfg.vaultId);   // base 是明文 sha，解锁后不可复用
    this.notify(this.status());
    return this.syncNow({ reason: 'unlock' });
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
    if (this.cfg.encryption?.enabled && !this._enc) {
      throw new Error('这个仓库启用了端到端加密，请先输入同步密码解锁');
    }
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
    const enc = !!this._enc;
    const stats = { uploaded: 0, downloaded: 0, deleted: 0, merged: [], conflicts: [], version: 0, reason };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remote = await this._fetchJson('GET', this.cfg.serverUrl, '/api/manifest');
      const local = await this._snapshot(root);
      const base = state.files || {};
      const remoteFiles = remote.files || {};

      /* 路径映射：明文模式 key 就是路径；加密模式 key 是 HMAC，只能靠
         「本机已知路径」+「服务端上的加密索引」反查。查不到的远端 key 说明索引过期，
         本轮先跳过（宁可少同步一次，也不猜路径写错地方）。 */
      const relByKey = new Map();
      let indexMap = new Map();
      if (enc) {
        indexMap = await this._readIndex(remote);
        for (const [k, v] of indexMap) relByKey.set(k, v);
      } else {
        for (const k of Object.keys(remoteFiles)) relByKey.set(k, k);
      }
      for (const rel of local.keys()) relByKey.set(this._keyOf(rel), rel);
      for (const rel of Object.keys(base)) relByKey.set(this._keyOf(rel), rel);

      const rels = new Set([...Object.keys(base), ...local.keys()]);
      for (const [key, rel] of relByKey) {
        if (RESERVED_KEYS.has(key)) continue;
        rels.add(rel);
      }
      const unknownKeys = Object.keys(remoteFiles).filter((k) => !RESERVED_KEYS.has(k) && !relByKey.has(k));
      if (unknownKeys.length) console.warn(`[sync] ${unknownKeys.length} 个远端文件无法还原路径（索引可能过期），本轮跳过`);
      stats.unknown = unknownKeys.length;

      const changes = [];
      const uploads = [];      // { blobSha, size, buf }（buf 已在内存里；大文件走临时文件分块）
      const downloads = [];    // { rel, sha, size }
      const nextBase = {};

      /** 把本地文件读成「待上传的 blob」：加密模式下 blob 是密文，sha 也按密文算 */
      const prepareUpload = async (rel) => {
        const abs = path.join(root, rel);
        const plain = await fsp.readFile(abs);
        const plainSha = sha256(plain);
        if (!enc) return { plainSha, blobSha: plainSha, size: plain.length, buf: plain };
        const blob = encryptBuffer(this._encKey(), plain);
        return { plainSha, blobSha: sha256(blob), size: blob.length, buf: blob };
      };

      for (const rel of rels) {
        const key = this._keyOf(rel);
        const l = local.get(rel)?.sha || null;
        const r = remoteFiles[key]?.sha || null;
        const bent = base[rel] || null;
        // 旧版 state 存的是字符串 sha（明文），兼容读成 {l,r} 相同
        const bL = bent ? (typeof bent === 'string' ? bent : bent.l) : null;
        const bR = bent ? (typeof bent === 'string' ? bent : (bent.r ?? bent.l)) : null;
        const localChanged = l !== bL;
        const remoteChanged = r !== bR;

        if (!localChanged && !remoteChanged) {
          if (l) nextBase[rel] = { l, r };
          continue;
        }

        if (!localChanged && remoteChanged) {
          // 本地没动，远端变了（加密模式这里比的是密文 sha）
          if (r) { downloads.push({ rel, sha: r, size: remoteFiles[key].size }); nextBase[rel] = { l: null, r }; }
          else { this._trashLocal(root, rel); stats.deleted++; }
          continue;
        }

        if (localChanged && !remoteChanged) {
          // 远端没动，本地变了
          if (l) {
            const prep = await prepareUpload(rel);
            uploads.push(prep);
            changes.push({ path: key, sha: prep.blobSha, size: prep.size, mtime: local.get(rel).mtime });
            nextBase[rel] = { l: prep.plainSha, r: prep.blobSha };
          } else {
            changes.push({ path: key, deleted: true });
            stats.deleted++;
          }
          continue;
        }

        // —— 两边都变了 ——
        if (l && r) {
          // 先花一次加密算本地密文：**确定性 IV** 让「内容相同」直接等价于「密文 sha 相同」，
          // 于是「刚解锁 base 被清空」「两台设备恰好改成同一份」这类情况不会被误判成冲突。
          const prepLocal = await prepareUpload(rel);
          if (prepLocal.blobSha === r) {
            nextBase[rel] = { l: prepLocal.plainSha, r };
            continue;
          }
          const merged = await this._tryAutoMerge(root, rel, bR, r, l);
          if (merged) {
            uploads.push(merged);
            changes.push({ path: key, sha: merged.blobSha, size: merged.size, mtime: Date.now() });
            nextBase[rel] = { l: merged.plainSha, r: merged.blobSha };
            stats.merged.push(rel);
            continue;
          }
          // 合不了：本地保留原路径，远端内容落成冲突副本（两份都不丢）
          const copyRel = await this._writeConflictCopy(root, rel, r);
          if (copyRel) {
            const prepCopy = await prepareUpload(copyRel);
            uploads.push(prepCopy);
            changes.push({ path: this._keyOf(copyRel), sha: prepCopy.blobSha, size: prepCopy.size, mtime: Date.now() });
            nextBase[copyRel] = { l: prepCopy.plainSha, r: prepCopy.blobSha };
            stats.conflicts.push({ path: rel, copy: copyRel });
          }
          uploads.push(prepLocal);
          changes.push({ path: key, sha: prepLocal.blobSha, size: prepLocal.size, mtime: local.get(rel).mtime });
          nextBase[rel] = { l: prepLocal.plainSha, r: prepLocal.blobSha };
        } else if (l && !r) {
          // 远端删除 + 本地修改 → 保留本地，重新上传
          const prep = await prepareUpload(rel);
          uploads.push(prep);
          changes.push({ path: key, sha: prep.blobSha, size: prep.size, mtime: local.get(rel).mtime });
          nextBase[rel] = { l: prep.plainSha, r: prep.blobSha };
        } else if (!l && r) {
          // 本地删除 + 远端修改 → 恢复远端
          downloads.push({ rel, sha: r, size: remoteFiles[key].size });
          nextBase[rel] = { l: null, r };
        }
      }

      // 加密仓库的 meta / 路径索引：首次同步写 meta，路径集合变了就重写索引
      if (enc) {
        await this._ensureMeta(remote, changes, uploads, sha256);
        await this._syncIndex(nextBase, indexMap, changes, uploads, sha256);
      }

      // 1. 下载（加密模式下载的是密文，落地前解密）
      for (const d of downloads) {
        const plainSha = await this._downloadBlob(root, d.rel, d.sha, d.size, enc);
        if (nextBase[d.rel]) nextBase[d.rel].l = plainSha;
        stats.downloaded++;
        this.progress = { phase: 'download', done: stats.downloaded, total: downloads.length };
        this.notify(this.status());
      }

      // 2. 上传
      for (let i = 0; i < uploads.length; i++) {
        await this._uploadPrepared(uploads[i]);
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
      state.encrypted = enc;
      await this._saveState(root, state);

      if (downloads.length) await this.onApplied('download');
      this._saveCfg({ lastSyncAt: new Date().toISOString(), lastError: null });
      this.lastResult = { ...stats, at: new Date().toISOString() };
      return this.lastResult;
    }
    throw new Error('同步未能完成');
  }

  /* ---------------- 加密模式的辅助：meta / 索引读取与写入 ---------------- */

  async _readIndex(remote) {
    if (!this._enc) return new Map();
    const ent = remote.files?.[INDEX_KEY];
    if (!ent) return new Map();
    try {
      const blob = await this._fetchRaw('GET', this.cfg.serverUrl, `/api/blob/${ent.sha}`);
      const data = JSON.parse(decryptBuffer(this._encKey(), blob).toString('utf8'));
      return new Map(Object.entries(data.names || {}));
    } catch (e) {
      console.warn('[sync] 索引解密失败（密码不对或索引损坏）：', e.message);
      return new Map();
    }
  }

  /** 首次加密同步时把 { salt, check } 以明文 JSON 落到服务端（不含任何秘密） */
  async _ensureMeta(remote, changes, uploads, sha) {
    if (remote.files?.[META_KEY]) return;
    const meta = { v: 3, salt: this.cfg.encryption.salt, check: this.cfg.encryption.check };
    const buf = Buffer.from(JSON.stringify(meta), 'utf8');
    const blobSha = sha(buf);
    uploads.push({ blobSha, size: buf.length, buf });
    changes.push({ path: META_KEY, sha: blobSha, size: buf.length, mtime: Date.now() });
  }

  /** 路径索引：{ hmac: 相对路径 }，整体加密后作为一个 blob 提交 */
  async _syncIndex(nextBase, indexMap, changes, uploads, sha) {
    const want = new Map();
    for (const rel of Object.keys(nextBase)) want.set(this._keyOf(rel), rel);
    const same = want.size === indexMap.size && [...want].every(([k, v]) => indexMap.get(k) === v);
    if (same) return;
    const plain = Buffer.from(JSON.stringify({ v: 3, names: Object.fromEntries(want) }), 'utf8');
    const blob = encryptBuffer(this._encKey(), plain);
    const blobSha = sha(blob);
    uploads.push({ blobSha, size: blob.length, buf: blob });
    changes.push({ path: INDEX_KEY, sha: blobSha, size: blob.length, mtime: Date.now() });
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
  /** 上传一个已准备好的 blob（明文或密文）：小文件直传，大文件落临时文件走分块续传。
   *  sha 是**blob 的 sha**——加密模式即密文的 sha，服务端只按它做内容寻址。 */
  async _uploadPrepared({ blobSha, size, buf }) {
    if (size < CHUNK_THRESHOLD) {
      await this._fetchRaw('PUT', this.cfg.serverUrl, `/api/blob/${blobSha}`, buf);
      return;
    }
    const tmp = path.join(os.tmpdir(), `tracery-v3-${blobSha.slice(0, 16)}-${process.pid}.bin`);
    await fsp.writeFile(tmp, buf);
    try { await this._uploadChunked(tmp, blobSha, size); }
    finally { await fsp.rm(tmp, { force: true }); }
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

  /** 下载：支持 Range 断点续传（中途断了只补缺失部分）。
   *  加密模式下下载到的是密文，落地前解密；返回**明文** sha（写进 base.l）。 */
  async _downloadBlob(root, rel, sha, size = 0, decrypt = false) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tracery-tmp`;
    let got = 0;
    try { got = (await fsp.stat(tmp)).size; } catch { got = 0; }
    if (size && got > size) { await fsp.rm(tmp, { force: true }); got = 0; }
    if (size && got === size && size > 0) {
      const plainSha = await this._finalizeDownload(tmp, decrypt);
      await fsp.rename(tmp, abs);
      this.noteWrite();
      return plainSha;
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
    const plainSha = await this._finalizeDownload(tmp, decrypt);
    await fsp.rename(tmp, abs);
    this.noteWrite();
    return plainSha;
  }

  /** 下载落地前的最后一步：需要解密就在原文件上解密，返回最终内容的 sha */
  async _finalizeDownload(file, decrypt) {
    const data = await fsp.readFile(file);
    if (!decrypt) return sha256(data);
    const plain = decryptBuffer(this._encKey(), data);
    await fsp.writeFile(file, plain);
    return sha256(plain);
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
      // 加密模式下服务端只有密文：先解密再交给 diff3
      const dec = (buf) => (this._enc ? decryptBuffer(this._encKey(), buf) : buf);
      const abs = path.join(root, rel);
      const localText = await fsp.readFile(abs, 'utf8');
      const { text, conflicts } = mergeText(dec(baseBuf).toString('utf8'), localText, dec(remoteBuf).toString('utf8'));
      if (conflicts > 0) return null;              // 同一段被两边改了 → 交给冲突副本

      const plain = Buffer.from(text, 'utf8');
      const plainSha = sha256(plain);
      if (plainSha !== localSha) {
        await fsp.writeFile(abs, plain);
        this.noteWrite();
      }
      const blob = this._enc ? encryptBuffer(this._encKey(), plain) : plain;
      return { plainSha, blobSha: sha256(blob), size: blob.length, buf: blob };
    } catch {
      return null;   // 缺 blob / 编码异常 / 解密失败：退回保守策略
    }
  }

  /** 把远端版本写成「冲突副本」，返回相对路径 */
  async _writeConflictCopy(root, rel, remoteSha) {
    try {
      const raw = await this._fetchRaw('GET', this.cfg.serverUrl, `/api/blob/${remoteSha}`);
      const buf = this._enc ? decryptBuffer(this._encKey(), raw) : raw;
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

  /** 远端删除时，本地文件移进 .tracery/trash 而不是直接删掉 */
  _trashLocal(root, rel) {
    try {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(vaultConfigDir(root), 'trash', stamp, rel);
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

  /* ---------------- 状态文件（存在 .tracery 里，不参与同步） ---------------- */
  _stateFile(root) { return root ? path.join(vaultConfigDir(root), 'sync-state.json') : null; }

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
      // 加密模式变了（开/关/换密码）→ base 的 sha 语义不同，必须作废重来
      if (Boolean(st.encrypted) !== Boolean(this._enc)) return { version: 0, files: {} };
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
