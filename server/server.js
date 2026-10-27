/**
 * Tracery 服务端职责：
 *   vault 文件系统访问 / 文件监听 / 链接与标签索引（metadataCache）/ 配置持久化
 * 前端（渲染进程）只通过 HTTP API + WebSocket 与这里交互，不直接碰文件系统。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SyncEngine, vaultConfigDir } from './sync.js';
import { createLanShare } from './lan.js';
import { buildWorker } from './pwa.js';
import { HOTKEY_COMMANDS, bindingFor, sanitizeHotkeys, validateShortcut } from '../public/js/hotkeys.js';
import { Vault, IGNORED_DIRS } from './vault.js';
import { normalizeLayout } from '../public/js/layout-settings.js';
import { resolveInDirectory } from './path-guard.js';
import { resolveUserPath as resolveInVault } from './user-path.js';
import { publicSettings } from './public-settings.js';
import { contentSecurityPolicy, attachmentHeaders } from './content-security.js';
import { watchDirectories } from './directory-watcher.js';
import { createHistoryStore } from './history-store.js';
import { createHistoryBackup } from './history-backup.js';
import { createMobileAccess } from './mobile-access.js';
import { validateRequest, isLocalClient } from './request-guard.js';
import { readDiskNote, saveDiskNote, revisionOf } from './note-store.js';
import { readJson, writeJson } from './durable-json.js';
import { createTrashStore } from './trash-store.js';
import { createReferenceStore } from './reference-store.js';
import { createFullBackup } from './full-backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// 打包进 Electron 后 asar 是只读的：TRACERY_HOME 指向可写的用户数据目录
// （兼容旧环境变量名 EVNOTE_HOME：老脚本/便携启动器不用改）
/* ================= 本地版本历史 =================
 * 每次保存前把「旧内容」快照进 TRACERY_HOME/history/<仓库哈希>/<笔记相对路径>/<时间戳>.md
 * 每个文件最多留 20 个快照（按时间滚动删除）。
 */
const HOME = process.env.TRACERY_HOME || process.env.EVNOTE_HOME || ROOT;
const history = createHistoryStore(HOME);
const historyBackup = createHistoryBackup(HOME, history);
const references = createReferenceStore({ home: HOME, history });
let mutationQueue = Promise.resolve();
const runMutation = job => { const result = mutationQueue.then(job); mutationQueue = result.catch(() => {}); return result; };
const snapshotHistory = (root, rel, content) => history.snapshot(root, rel, content);

/* ================= 回收站 =================
 * 删除不再直接 unlink，而是移进 TRACERY_HOME/trash/<仓库哈希>/，
 * 每项 id__原文件名 + index.json 记录原始相对路径，可恢复。
 * 放在数据目录而不是仓库里：不污染笔记目录、不会被同步、文件树也看不见。
 */
const trash = createTrashStore(HOME);
const readTrashIndex = () => trash.list(vault.root);
const moveToTrash = (...args) => trash.move(...args);
const restoreFromTrash = (...args) => trash.restore(...args);
const purgeTrashItem = (...args) => trash.purge(...args);
const emptyTrash = root => trash.empty(root);
const CONFIG_FILE = path.join(HOME, 'tracery.config.json');
const LEGACY_CONFIG_FILE = path.join(HOME, 'evnote.config.json');
const DEFAULT_VAULT = path.join(ROOT, 'demo-vault');
const PORT = Number(process.env.PORT) || 9520;


/* ---------------- 配置 ---------------- */
const DEFAULT_SETTINGS = {
  themeName: 'apple',     // 皮肤：public/themes/<name>.css
  themeMode: 'dark',      // light | dark | auto
  accent: 'blue',         // 强调色预设
  radius: 'default',      // compact | default | large
  fontSize: 16,           // 编辑区字号 px
  editorWidth: 720,       // 正文最大宽度 px
  layout: undefined,      // 旧配置首次在客户端迁移拖动栏宽，修改后才持久化
  autosave: 900,          // 自动保存防抖 ms
  lineNumbers: true,      // 行号：源码模式与实时预览共用
  startup: 'last',        // last | empty
  hotkeys: {},           // 仅保存用户覆盖；null 表示取消绑定
  // 附件管理：新图片/文件（粘贴、拖入、绘图）的落点
  attachment: {
    mode: 'folder',       // folder=指定文件夹 | note=跟随笔记所在目录 | root=仓库根目录
    folder: '附件',
  },
  // 自托管同步（v1：文件级 + 冲突副本）
  sync: {
    serverUrl: '', token: '', vaultId: '', serverName: '', deviceName: '',
    autoSync: true, interval: 60, lastSyncAt: null, lastError: null,
  },
};

function normalizeConfig(cfg) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(cfg.settings || {}),
    sync: { ...DEFAULT_SETTINGS.sync, ...(cfg.settings?.sync || {}) },
    hotkeys: sanitizeHotkeys(cfg.settings?.hotkeys),
    layout: cfg.settings?.layout ? normalizeLayout(cfg.settings.layout) : undefined,
  };
  // 兼容旧版顶层 theme / themeName
  if (!cfg.settings && cfg.theme) settings.themeMode = cfg.theme === 'light' ? 'light' : 'dark';
  if (!cfg.settings && cfg.themeName) settings.themeName = cfg.themeName;
  return { currentVault: null, recentVaults: [], ...cfg, settings };
}
const storageWarnings = [];
function validConfig(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (value.currentVault == null || typeof value.currentVault === 'string')
    && (value.recentVaults === undefined || (Array.isArray(value.recentVaults) && value.recentVaults.every(root => typeof root === 'string')))
    && (value.settings === undefined || (value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings)));
}
function loadConfig() {
  return normalizeConfig(readJson(CONFIG_FILE, {}, { validate: validConfig, legacy: LEGACY_CONFIG_FILE, warn: message => { console.warn(message); storageWarnings.push(message); } }));
}
function saveConfig(cfg) { writeJson(CONFIG_FILE, cfg, { validate: validConfig }); }

/** 校验并合并设置补丁（不合法字段直接忽略） */
function mergeSettings(patch = {}) {
  const s = { ...config.settings };
  if (typeof patch.themeName === 'string') {
    const name = patch.themeName.replace(/[^a-z0-9_-]/gi, '');
    if (fs.existsSync(path.join(PUBLIC_DIR, 'themes', `${name}.css`))) s.themeName = name;
  }
  if (['light', 'dark', 'auto'].includes(patch.themeMode)) s.themeMode = patch.themeMode;
  if (['blue', 'purple', 'green', 'orange', 'pink', 'graphite'].includes(patch.accent)) s.accent = patch.accent;
  if (['compact', 'default', 'large'].includes(patch.radius)) s.radius = patch.radius;
  if (Number.isFinite(patch.fontSize)) s.fontSize = Math.min(20, Math.max(12, Math.round(patch.fontSize)));
  if (Number.isFinite(patch.editorWidth)) s.editorWidth = Math.min(1000, Math.max(560, Math.round(patch.editorWidth)));
  if (patch.layout && typeof patch.layout === 'object' && !Array.isArray(patch.layout)) s.layout = normalizeLayout(patch.layout, s.layout);
  if (Number.isFinite(patch.autosave)) s.autosave = Math.min(3000, Math.max(0, Math.round(patch.autosave)));
  if (typeof patch.lineNumbers === 'boolean') s.lineNumbers = patch.lineNumbers;
  if (['last', 'empty'].includes(patch.startup)) s.startup = patch.startup;
  if (patch.hotkeys && typeof patch.hotkeys === 'object') s.hotkeys = sanitizeHotkeys({ ...s.hotkeys, ...sanitizeHotkeys(patch.hotkeys) });
  // 附件管理（嵌套对象，字段逐个校验）
  if (patch.attachment && typeof patch.attachment === 'object') {
    s.attachment = { ...DEFAULT_SETTINGS.attachment, ...(s.attachment || {}) };
    const a = patch.attachment;
    if (['folder', 'note', 'root'].includes(a.mode)) s.attachment.mode = a.mode;
    if (typeof a.folder === 'string') {
      // 与 /api/asset 同一套规则：含 .. / 空段 / 非法字符 → 整条补丁忽略，保持原值
      const clean = sanitizeAssetDir(a.folder);
      if (clean) s.attachment.folder = clean.slice(0, 60);
    }
  }
  saveConfig({ ...config, settings: s });
  config.settings = s;
  return s;
}

/**
 * 清洗附件目录参数（/api/asset 的 body.dir 与设置里的 attachment.folder）：
 * 反斜杠转正斜杠 → 去首尾斜杠 → 逐段校验。
 * 空串 = 仓库根目录（合法）；含空段 / . / .. / Windows 非法字符 = 返回 null（调用方应拒绝）。
 * 为什么是「拒绝」而不是「洗干净」：客户端的目录只会来自设置计算，出现 .. 说明是 bug
 * 或恶意调用，静默改写会把文件写到用户没指定的地方，显性报错才能暴露问题。
 */
function sanitizeAssetDir(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const segs = s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/');
  if (segs.some((seg) => !seg || seg === '.' || seg === '..' || /[:*?"<>|]/.test(seg))) return null;
  return segs.join('/').slice(0, 120);
}

let config = loadConfig();

/** 递归复制（不用 fs.cpSync：它在 asar 内会 opendir 失败） */
function copyDirSafe(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirSafe(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** 演示仓库：asar 内只读时复制到用户目录，保证开箱可写 */
function resolveDefaultVault() {
  // 打包后 DEFAULT_VAULT 在 app.asar 里；asar 是只读的虚拟文件系统，
  // 不能直接当仓库（写入会失败），必须复制到用户目录。
  const inAsar = DEFAULT_VAULT.includes('.asar');
  if (!inAsar) {
    try {
      fs.accessSync(DEFAULT_VAULT, fs.constants.W_OK);
      return DEFAULT_VAULT;
    } catch { /* 落到复制分支 */ }
  }
  const target = path.join(HOME, 'demo-vault');
  try {
    const marker = path.join(target, '欢迎使用 Tracery.md');
    if (!fs.existsSync(marker)) {
      copyDirSafe(DEFAULT_VAULT, target);
    }
  } catch (e) { console.warn('[vault] 复制演示仓库失败:', e.message); }
  return target;
}

/* ---------------- Vault 索引 ---------------- */

let vault = null;

/* ---------------- 同步引擎（对应 Obsidian Sync 的主进程侧） ---------------- */
const syncEngine = new SyncEngine({
  runExclusive: runMutation,
  getVaultRoot: () => vault?.root || null,
  notify: (status) => broadcast({ type: 'sync-status', status }),
  onApplied: async () => {
    // 同步写入了本地文件：重建索引，并让浏览器重新拉取内容
    if (!vault) return;
    await vault.open();
    broadcast({ type: 'fs-change', paths: ['*'], source: 'sync' });
  },
});
const backups = createFullBackup({ home: HOME, getVault: () => vault, getSettings: () => config.settings, runExclusive: runMutation });

/* ---------------- 局域网直连（六位通行码） ---------------- */
const lanShare = createLanShare({
  getVaultRoot: () => vault?.root || null,
  getEngine: () => syncEngine,
  home: HOME,
  notify: (status) => broadcast({ type: 'sync-status', status }),
});

/* ---------------- 静态资源 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

function sendJson(res, code, obj) {
  if (obj?.settings) obj = { ...obj, settings: publicSettings(obj.settings) };
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.aborted || req.destroyed) { reject(new Error('请求已中断')); return; }
    const chunks = []; let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > limit) { req.destroy(); reject(new Error('请求体过大')); return; }
      chunks.push(c);
    });
    req.on('end', () => { try {
      const raw = Buffer.concat(chunks).toString('utf8'), data = raw ? JSON.parse(raw) : {};
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('请求正文必须是对象'),{status:400});
      if (req.mobile && req.mobileSession) mobileAccess.authorize(req,new URL(req.url,'http://localhost'));
      if (req.mobile && data.vaultRoot !== undefined) {
        if (data.vaultRoot !== mobileVaultKey()) throw Object.assign(new Error('仓库已切换，原草稿保留'), {status:409});
        data.vaultRoot = vault?.root;
      }
      resolve(data);
    } catch (e) { reject(e); } });
    req.on('aborted', () => reject(new Error('请求已中断')));
    req.on('error', reject);
  });
}

/* ---------------- HTTP 路由 ---------------- */
let shutdownStarted = false;
const activeRequests = new Set();
async function handleRequest(req, res) {
  if (shutdownStarted) { sendJson(res, 503, { error: '服务正在退出，请稍后重试' }); return; }
  const route = new URL(req.url, 'http://localhost').pathname;
  const locked = req.method !== 'GET' && ['/api/note','/api/note/create','/api/settings','/api/theme','/api/asset','/api/rename','/api/delete','/api/replace','/api/vault/open','/api/history/restore','/api/trash/restore','/api/trash/purge','/api/trash/empty','/api/references/relink'].includes(route);
  const root = vault?.root;
  const operation = locked ? runMutation(() => {
    if (req.aborted || res.destroyed) return;
    if (root !== vault?.root) { sendJson(res, 409, { error: '仓库已经切换，请在原仓库重试' }); return; }
    return processRequest(req, res);
  }) : processRequest(req, res);
  activeRequests.add(operation);
  try { await operation; } finally { activeRequests.delete(operation); }
}
async function processRequest(req, res) {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  try {
    validateRequest(req);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = `http://${req.headers.host}`;
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(origin));
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.mobile) {
      res.setHeader('Cache-Control', 'no-store');
      if (await mobileAccess.publicRequest(req,res,u,readBody)) return;
    }
    if (p === '/sw.js') {
      const source = buildWorker(PUBLIC_DIR);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
      return res.end(source);
    }
    // ---- API ----
    if (p === '/api/access' && req.method === 'GET') return sendJson(res, 200, mobileAccess.status());
    if (p === '/api/access/start' && req.method === 'POST') { const {mode}=await readBody(req); return sendJson(res,200,await mobileAccess.start(mode)); }
    if (p === '/api/access/stop' && req.method === 'POST') return sendJson(res,200,await mobileAccess.stop());
    if (p === '/api/access/revoke' && req.method === 'POST') return sendJson(res,200,mobileAccess.revoke());
    if (p === '/api/state') {
      return sendJson(res, 200, {
        vault: vault ? { root: req.mobile ? mobileVaultKey() : vault.root, name: path.basename(vault.root) } : null,
        recentVaults: req.mobile ? [] : config.recentVaults,
        access: req.mobile ? {local:false,mode:req.mobileSession.mode} : {local:true,mode:'write'},
        settings: config.settings,
        storageWarnings: req.mobile ? [] : storageWarnings,
      });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const patch = await readBody(req);
      if (patch.hotkeys && typeof patch.hotkeys === 'object') {
        const hotkeys = sanitizeHotkeys({ ...config.settings.hotkeys, ...sanitizeHotkeys(patch.hotkeys) });
        for (const command of HOTKEY_COMMANDS) {
          const error = validateShortcut(command.id, bindingFor(command, hotkeys), hotkeys);
          if (error) return sendJson(res, 400, { error });
        }
      }
      const settings = mergeSettings(patch);
      broadcast({ type: 'settings', settings });
      return sendJson(res, 200, { ok: true, settings });
    }
    if (p === '/api/vault/open' && req.method === 'POST') {
      if (!isLocalClient(req)) return sendJson(res, 403, { error: '请在电脑本机切换仓库；手机仅访问当前仓库' });
      const { path: vaultPath } = await readBody(req);
      if (!vaultPath || !fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
        return sendJson(res, 400, { error: '目录不存在或不是文件夹' });
      }
      if (vault?.root !== path.resolve(vaultPath)) await lanShare.stop();
      if (vault?.root !== path.resolve(vaultPath)) mobileAccess.revoke();
      vault = new Vault(path.resolve(vaultPath));
      storageWarnings.push(...await references.recover(vault.root));
      await vault.open();
      config.currentVault = vault.root;
      config.recentVaults = [vault.root, ...config.recentVaults.filter((v) => v !== vault.root)].slice(0, 8);
      saveConfig(config);
      watchVault(vault.root);
      syncEngine.lastResult = null;
      syncEngine.startAuto();
      broadcast({ type: 'vault-opened', name: path.basename(vault.root) });
      return sendJson(res, 200, { ok: true, vault: { root: vault.root, name: path.basename(vault.root) } });
    }
    // 从「最近打开」里移除（只动配置，不碰磁盘）
    if (p === '/api/vault/forget' && req.method === 'POST') {
      const { path: target } = await readBody(req);
      config.recentVaults = config.recentVaults.filter((v) => v !== target);
      saveConfig(config);
      return sendJson(res, 200, { ok: true, recentVaults: config.recentVaults });
    }
    // ---- 自托管同步 ----
    if (p === '/api/sync/status') return sendJson(res, 200, syncEngine.status());

    if (p === '/api/sync/pair' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const status = await syncEngine.pair(body);
        return sendJson(res, 200, { ok: true, status });
      } catch (e) {
        return sendJson(res, 400, { error: e.message, status: syncEngine.status() });
      }
    }

    // 已配对但本机没解锁（换设备/重装）：用密码装回钥匙
    if (p === '/api/sync/unlock' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await syncEngine.unlock(body);
        return sendJson(res, 200, { ok: true, result, status: syncEngine.status() });
      } catch (e) {
        return sendJson(res, 400, { error: e.message, status: syncEngine.status() });
      }
    }

    if (p === '/api/sync/now' && req.method === 'POST') {
      try {
        const result = await syncEngine.syncNow({ reason: 'manual' });
        return sendJson(res, 200, { ok: true, result, status: syncEngine.status() });
      } catch (e) {
        return sendJson(res, 400, { error: e.message, status: syncEngine.status() });
      }
    }

    if (p === '/api/sync/options' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, status: syncEngine.setOptions(body) });
    }

    if (p === '/api/sync/disconnect' && req.method === 'POST') {
      if (lanShare.status().running) { const result = await lanShare.stop(); return sendJson(res, 200, { ok: true, status: result.sync }); }
      return sendJson(res, 200, { ok: true, status: await syncEngine.disconnect() });
    }

    // ---- 局域网直连（六位通行码，无需独立服务端） ----
    if (p === '/api/sync/lan/status') return sendJson(res, 200, lanShare.status());
    if (p === '/api/sync/lan/devices' && req.method === 'GET') return sendJson(res, 200, await lanShare.discover());

    if (p === '/api/sync/lan/start' && req.method === 'POST') {
      try {
        const r = await lanShare.start();
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { error: e.message, lan: lanShare.status() });
      }
    }

    if (p === '/api/sync/lan/stop' && req.method === 'POST') {
      const r = await lanShare.stop();
      return sendJson(res, 200, { ok: true, ...r });
    }

    if (p === '/api/sync/lan/find' && req.method === 'POST') {
      const { code } = await readBody(req);
      if (!/^\d{6}$/.test(String(code || ''))) return sendJson(res, 400, { error: '请输入 6 位数字通行码' });
      const hit = await lanShare.find(code);
      if (!hit) return sendJson(res, 404, { error: '局域网里没有找到这个通行码的设备' });
      return sendJson(res, 200, { ok: true, ...hit });
    }

    if (!vault && p.startsWith('/api/')) return sendJson(res, 409, { error: '尚未打开仓库' });

    if (p === '/api/tree') return sendJson(res, 200, vault.tree());
    if (p === '/api/drawings') return sendJson(res, 200, vault.drawings());

    if (p === '/api/note' && req.method === 'GET') {
      const rel = u.searchParams.get('path');
      if (rel) resolveInVault(vault.root, rel);
      if (!rel || !vault.notes.has(rel)) return sendJson(res, 404, { error: '笔记不存在' });
      const raw = await readDiskNote(vault.root, rel);
      if (raw === null) return sendJson(res, 404, { error: '笔记已从磁盘删除' });
      const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const { mtimeMs, size } = vault.files.get(rel) || {};
      return sendJson(res, 200, { path: rel, name: vault.notes.get(rel)?.name, content, mtimeMs, size, revision: revisionOf(raw) });
    }
    if (p === '/api/note' && req.method === 'PUT') {
      const { path: rel, content, expectedRevision, vaultRoot } = await readBody(req);
      if (!rel) return sendJson(res, 400, { error: '缺少 path' });
      const target = vault;
      resolveInVault(target.root, rel);
      if (vaultRoot !== undefined && vaultRoot !== target.root) return sendJson(res, 409, { error: '仓库已切换，原仓库的草稿已保留，请重新打开原仓库' });
      const revision = await saveDiskNote(target.root, rel, content, { expectedRevision,
        beforeCommit: previous => previous === null ? undefined : snapshotHistory(target.root, rel, previous) });
      const change = await target.applyChange(rel);
      if (target === vault) broadcast({ type: 'fs-change', paths: [rel], treeChanged: change.treeChanged });
      const { mtimeMs, size } = target.files.get(rel) || {};
      return sendJson(res, 200, { ok: true, mtimeMs, size, revision });
    }
    if (p === '/api/history/backup' && req.method === 'GET') {
      if (!isLocalClient(req)) return sendJson(res, 403, { error: '请在电脑本机管理历史备份' });
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 200, historyBackup.export(vault.root));
    }
    if (p.startsWith('/api/backup/')) {
      if (!isLocalClient(req)) return sendJson(res, 403, { error: '完整备份与恢复仅限电脑本机' });
      if (p === '/api/backup/status' && req.method === 'GET') return sendJson(res, 200, backups.status(u.searchParams.get('id')));
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (p === '/api/backup/cancel') { backups.cancel(body.id); return sendJson(res, 200, { ok: true }); }
        const kind = p.slice('/api/backup/'.length);
        if (['create', 'verify', 'restore'].includes(kind)) return sendJson(res, 202, { id: backups.start(kind, body) });
      }
    }
    if (p === '/api/history/import' && req.method === 'POST') {
      if (!isLocalClient(req)) return sendJson(res, 403, { error: '请在电脑本机管理历史备份' });
      const { archive, allowRebind, vaultRoot } = await readBody(req);
      if (vaultRoot !== vault.root) return sendJson(res, 409, { error: '当前仓库已改变，请重新选择备份' });
      return sendJson(res, 200, historyBackup.import(vault.root, archive, { allowRebind: allowRebind === true }));
    }
    if (p === '/api/history' && req.method === 'GET') {
      const rel = u.searchParams.get('path');
      if (!rel) return sendJson(res, 400, { error: '缺少 path' });
      return sendJson(res, 200, { items: history.list(vault.root,rel) });
    }
    if (p === '/api/history/content' && req.method === 'GET') {
      const rel = u.searchParams.get('path');
      const id = u.searchParams.get('id');
      return sendJson(res, 200, { content: history.read(vault.root,rel,id) });
    }
    if (p === '/api/history/restore' && req.method === 'POST') {
      const { path: rel, id } = await readBody(req);
      const target = vault;
      const restored = history.read(target.root,rel,id,{restore:true});
      const abs = resolveInVault(target.root, rel);
      let cur = null;
      try { cur = await fsp.readFile(abs, 'utf8'); } catch { /* 可能已被删 */ }
      await saveDiskNote(target.root, rel, restored, { expectedRevision: revisionOf(cur),
        beforeCommit: previous => previous === null ? undefined : snapshotHistory(target.root, rel, previous) });
      await target.applyChange(rel);
      if (target === vault) broadcast({ type: 'fs-change', paths: [rel] });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/replace' && req.method === 'POST') {
      const { query, replacement } = await readBody(req);
      if (!query) return sendJson(res, 400, { error: '查询为空' });
      const rep = String(replacement ?? '');
      const target = vault;
      const touched = [];
      let count = 0;
      for (const rel of target.notes.keys()) {
        const abs = resolveInVault(target.root, rel);
        let text;
        try { text = await fsp.readFile(abs, 'utf8'); } catch { continue; }
        if (!text.includes(query)) continue;
        const parts = text.split(query);
        count += parts.length - 1;
        await saveDiskNote(target.root, rel, parts.join(rep), { expectedRevision: revisionOf(text),
          beforeCommit: previous => snapshotHistory(target.root, rel, previous) });
        touched.push(rel);
      }
      if (touched.length) {
        await target.open();
        if (target === vault) broadcast({ type: 'fs-change', paths: touched });
      }
      return sendJson(res, 200, { ok: true, files: touched, count });
    }
    // 保存资源文件（粘贴/拖入的图片和文档、绘图）：base64 → <dir>/xxx.ext
    // dir 由客户端按「附件设置」算好；服务端独立清洗——API 调用方永远不可信
    if (p === '/api/asset' && req.method === 'POST') {
      const body = await readBody(req, 64 * 1024 * 1024);
      const target = vault;
      if (body.vaultRoot !== undefined && body.vaultRoot !== target.root) return sendJson(res, 409, { error: '仓库已切换，请回到原笔记重新插入附件' });
      const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
      const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(body.data || ''));
      const ext = m ? MIME_EXT[m[1].toLowerCase()] : null;
      if (!m || !ext) return sendJson(res, 400, { error: '数据格式错误（支持 png/jpg/webp/gif/pdf 的 base64 data URL）' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) return sendJson(res, 400, { error: '文件内容为空' });
      if (buf.length > 30 * 1024 * 1024) return sendJson(res, 413, { error: '文件超过 30MB' });
      // 缺省 附件（兼容旧客户端）；显式传 '' = 仓库根目录；非法值拒绝
      const dir = body.dir === undefined ? '附件' : sanitizeAssetDir(body.dir);
      if (dir === null) return sendJson(res, 400, { error: '附件目录不合法（不允许 .. 或绝对路径）' });
      const raw = String(body.name || '绘图').replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\.(png|jpe?g|webp|gif|pdf|svg)$/i, '').slice(0, 80) || '绘图';
      let rel;
      // overwrite：覆盖仓库内已有的图片（「编辑绘图」保存时用）。
      // 为什么不复用 name：覆盖必须落在**原路径**上，否则笔记里的 ![[..]] 会指向旧文件。
      // 安全口径与其它接口一致：只允许仓库内已存在的普通文件，不接受 ../ 或绝对路径。
      const overwrite = typeof body.overwrite === 'string' ? body.overwrite.replace(/\\/g, '/') : '';
      if (overwrite) {
        const absTarget = resolveInVault(target.root, overwrite);
        if (!fs.existsSync(absTarget) || !fs.statSync(absTarget).isFile()) {
          return sendJson(res, 404, { error: '要覆盖的文件不存在' });
        }
        rel = overwrite;
      } else {
        rel = dir ? `${dir}/${raw}.${ext}` : `${raw}.${ext}`;
        let n = 2;
        while (fs.existsSync(resolveInVault(target.root, rel))) rel = `${dir ? dir + '/' : ''}${raw}-${n++}.${ext}`;
        if (dir) await fsp.mkdir(resolveInVault(target.root, dir), { recursive: true });
      }
      await fsp.writeFile(resolveInVault(target.root, rel), buf);
      const touched = [rel];
      // 绘图的笔画数据另存一份（便于以后重新编辑；不参与正文）
      if (body.drawing) {
        const jsonDir = path.posix.dirname(rel);
        const jsonRel = `${jsonDir === '.' ? '' : jsonDir + '/'}${path.basename(rel, '.' + ext)}.draw.json`;
        await fsp.writeFile(resolveInVault(target.root, jsonRel), String(body.drawing), 'utf8');
        touched.push(jsonRel);
      }
      await target.applyChanges(touched);
      if (target === vault) broadcast({ type: 'fs-change', paths: touched });
      return sendJson(res, 200, { ok: true, path: rel, size: buf.length });
    }

    if (p === '/api/note/create' && req.method === 'POST') {      const { path: rel, content = '', vaultRoot } = await readBody(req);
      const target = vault;
      if (vaultRoot !== undefined && vaultRoot !== target.root) return sendJson(res, 409, { error: '仓库已切换，请在原仓库另存副本' });
      const abs = resolveInVault(target.root, rel);
      if (fs.existsSync(abs)) return sendJson(res, 409, { error: '文件已存在' });
      await saveDiskNote(target.root, rel, content, { expectedRevision: null });
      await target.applyChange(rel);
      if (target === vault) broadcast({ type: 'fs-change', paths: [rel] });
      return sendJson(res, 200, { ok: true, path: rel });
    }
    if (p === '/api/rename' && req.method === 'POST') {
      const { path: rel, newPath, vaultRoot } = await readBody(req);
      if (!rel || !newPath) return sendJson(res, 400, { error: '参数缺失' });
      const target = vault;
      if (vaultRoot !== undefined && vaultRoot !== target.root) return sendJson(res, 409, { error: '仓库已经切换' });
      try {
        const result = await references.rename(target.root, rel, newPath);
        return sendJson(res, 200, { ok: true, ...result });
      } finally { await target.open(); broadcast({ type: 'fs-change', paths: ['*'], treeChanged: true }); }
    }
    if (p === '/api/references/relink' && req.method === 'POST') {
      const { path: rel, raw, target: next, expectedRevision, vaultRoot } = await readBody(req), current = vault;
      if (vaultRoot !== current.root) return sendJson(res, 409, { error: '仓库已经切换' });
      const result = await references.relink(current.root, rel, raw, next, expectedRevision);
      await current.open(); broadcast({ type: 'fs-change', paths: result.paths });
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (p === '/api/delete' && req.method === 'POST') {
      const { path: rel } = await readBody(req);
      const abs = resolveInVault(vault.root, rel);
      if (!fs.existsSync(abs)) return sendJson(res, 404, { error: '文件不存在' });
      const isDir = fs.statSync(abs).isDirectory();
      // 不再直接 unlink：先进回收站，可以恢复（回收站目录在 TRACERY_HOME 下，
      // 不污染仓库本身，也不会被同步 / 文件树看到）
      await moveToTrash(vault.root, rel, abs);
      if (isDir) {
        // 删目录会连带带走里面的笔记：applyChange 只删它自己这一条，
        // 所以这里整仓重扫，清掉子笔记在索引/反链/图谱里的残留
        await vault.open();
      } else {
        await vault.applyChange(rel);
      }
      broadcast({ type: 'fs-change', paths: [rel] });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/trash' && req.method === 'GET') {
      return sendJson(res, 200, { items: readTrashIndex() });
    }
    if (p === '/api/trash/restore' && req.method === 'POST') {
      const { id } = await readBody(req);
      const restored = await restoreFromTrash(vault.root, id);
      if (!restored) return sendJson(res, 404, { error: '回收站里没有这一项' });
      await vault.open();
      broadcast({ type: 'fs-change', paths: [restored] });
      return sendJson(res, 200, { ok: true, path: restored });
    }
    if (p === '/api/trash/purge' && req.method === 'POST') {
      const { id } = await readBody(req);
      await purgeTrashItem(vault.root, id);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/trash/empty' && req.method === 'POST') {
      await emptyTrash(vault.root);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/links') {
      const rel = u.searchParams.get('path');
      return sendJson(res, 200, vault.linksFor(rel));
    }
    if (p === '/api/search') {
      const q = u.searchParams.get('q') || '';
      return sendJson(res, 200, { results: q ? vault.search(q) : [] });
    }
    if (p === '/api/tags') return sendJson(res, 200, { tags: vault.allTags() });
    if (p === '/api/graph') return sendJson(res, 200, vault.graph());
    if (p === '/api/file') {
      // 仓库内任意文件（笔记里的图片等）
      const rel = u.searchParams.get('path');
      const abs = resolveInVault(vault.root, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return sendJson(res, 404, { error: '文件不存在' });
      }
      const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      // 图片会被「编辑绘图」覆盖写，浏览器不能拿旧缓存：每次都回源校验
      res.writeHead(200, { ...attachmentHeaders(path.extname(abs), mime), 'Cache-Control': 'no-cache' });
      fs.createReadStream(abs).pipe(res);
      return;
    }
    // 兼容旧接口：映射到 settings
    if (p === '/api/theme' && req.method === 'POST') {
      const body = await readBody(req);
      const settings = mergeSettings({ themeMode: body.theme, themeName: body.themeName });
      return sendJson(res, 200, { ok: true, settings });
    }

    // ---- 静态资源 ----
    let filePath = resolveInDirectory(PUBLIC_DIR, p === '/' ? 'index.html' : decodeURIComponent(p).slice(1));
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA 回退
      filePath = path.join(PUBLIC_DIR, 'index.html');
      if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not Found'); }
    }
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    if (path.extname(filePath).toLowerCase() === '.html') {
      const html = await fsp.readFile(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': mime, 'Content-Security-Policy': contentSecurityPolicy(origin, html) });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[api error]', p, err);
    sendJson(res, err.status || 500, { error: String(err.message || err) });
  }
}
const server = http.createServer(handleRequest);
server.on('error',error=>{
  console.error('[server]',error.message);
  const message={type:'tracery-start-error',nonce:process.env.TRACERY_START_TOKEN,pid:process.pid,code:error.code};
  if(process.send)process.send(message,()=>process.exit(1));else process.exit(1);
});
function mobileVaultKey() { return 'mobile-vault:' + crypto.createHash('sha256').update(vault?.root || '').digest('hex'); }
const mobileAccess = createMobileAccess({ handler:handleRequest, upgrade:upgradeSocket, port:PORT < 65535 ? PORT+1 : PORT-1,
  onRevoke(id) { for(const client of wss.clients) if(client.mobileSession && (!id || client.mobileSession === id)) client.terminate(); },
});


/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ noServer:true });
function upgradeSocket(req,socket,head) {
  try {
    validateRequest(req);
    if(new URL(req.url,'http://localhost').pathname !== '/ws') throw Object.assign(new Error('Not Found'),{status:404});
    const session=req.mobile?mobileAccess.authorizeSocket(req):null;
    wss.handleUpgrade(req,socket,head,client=>{client.mobileSession=session?.id;wss.emit('connection',client,req);});
  } catch(error) { socket.end(`HTTP/1.1 ${error.status||403} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
}
server.on('upgrade',upgradeSocket);
function broadcast(msg) {
  if(msg.type === 'settings') msg = {...msg,settings:publicSettings(msg.settings)};
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1 && (!c.mobileSession || ['fs-change','vault-opened','settings'].includes(msg.type))) c.send(data);
}

/* ---------------- 文件监听（对应 Obsidian 的 vault 监听） ---------------- */
let watcher = null;
let watchEpoch = 0;
let watchTimer = null;
const pendingChanges = new Set();
function watchVault(root) {
  if (shutdownStarted) return;
  root=path.resolve(root);const epoch=++watchEpoch;let polling=false;
  if (watcher) { if (watcher.close) watcher.close(); else clearInterval(watcher); }
  clearTimeout(watchTimer); pendingChanges.clear();
  const poll=error=>{
    if(epoch!==watchEpoch||vault?.root!==root||polling)return;polling=true;
    if(watcher?.close)watcher.close();
    clearTimeout(watchTimer);pendingChanges.clear();
    console.warn('[watch] 监听不可用，退化为轮询:',error.message);
    let busy=false;
    watcher=setInterval(async()=>{
      if(shutdownStarted||busy||vault?.root!==root)return;busy=true;
      try { const active=vault;await active.open();if(vault===active)broadcast({type:'fs-change',paths:['*']}); }
      catch(reason){console.warn('[watch] 轮询失败:',reason.message);}
      finally{busy=false;}
    },5000);
  };
  try {
    const changed=(event, filename) => {
      if(epoch!==watchEpoch||polling)return;
      if (!filename) return;
      const rel = filename.replace(/\\/g, '/');
      if (rel.split('/').some((s) => IGNORED_DIRS.has(s.toLowerCase()))) return;
      pendingChanges.add(rel);
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(flushChanges, 120);
    };
    watcher = process.platform === 'linux' ? watchDirectories(root,vault.dirs,changed,poll) : fs.watch(root,{recursive:true},changed);
    if(watcher.on)watcher.on('error',poll);
  } catch (e) {
    poll(e);
  }
}
async function flushChanges() {
  if (!vault || shutdownStarted) return;
  const rels = [...pendingChanges];
  pendingChanges.clear();
  const active = vault;
  let change;
  if(rels.includes('*')){await active.open();change={paths:['*'],treeChanged:true};}
  else change = await active.applyChanges(rels);
  if (vault !== active) return;
  try { watcher?.sync?.(active.dirs); } catch(error) { watchVault(active.root); }
  if (change.paths.length) broadcast({ type: 'fs-change', ...change });
  // 本地改了东西 → 安排一次同步（刚被同步写盘的文件会被引擎自己忽略）
  // API 保存已更新索引时 watcher 会去重，但磁盘写入仍须触发自动同步。
  syncEngine.scheduleSync('local-change');
}

/* ---------------- 启动 ---------------- */
function startupProgress(data) {
  console.log('[index]', JSON.stringify(data));
  process.send?.({ ...data, type: 'tracery-progress', nonce: process.env.TRACERY_START_TOKEN, pid: process.pid });
}
async function start() {
  // 首次启动：没有仓库就用内置演示仓库，保证开箱即用
  let root = config.currentVault;
  if (!root || !fs.existsSync(root)) {
    root = resolveDefaultVault();
    fs.mkdirSync(vaultConfigDir(root), { recursive: true });
    config.currentVault = root;
  }
  // 保证当前仓库一定出现在「最近打开」里（首启动的演示仓库也能一键切回）
  config.recentVaults = [root, ...config.recentVaults.filter((v) => v !== root)].slice(0, 8);
  saveConfig(config);
  vault = new Vault(root, { onProgress: startupProgress });
  storageWarnings.push(...await references.recover(root));
  const pulse = setInterval(() => process.send?.({ type: 'tracery-progress', nonce: process.env.TRACERY_START_TOKEN, pid: process.pid, phase: 'working', message: '正在准备笔记仓库，请稍候' }), 2000);
  try { await vault.open(); } finally { clearInterval(pulse); }
  if (shutdownStarted) return;
  watchVault(root);

  server.listen(PORT, '127.0.0.1', () => {
    process.send?.({type:'tracery-ready',nonce:process.env.TRACERY_START_TOKEN,pid:process.pid,port:server.address().port});
    syncEngine.startAuto();
    console.log(`Tracery 已启动:  http://localhost:${PORT}`);
    console.log(`当前仓库:      ${vault.root}`);
    console.log(`笔记数:        ${vault.notes.size}`);
    if (syncEngine.configured) console.log(`同步:          ${syncEngine.cfg.serverUrl}`);
  });
}
let shutdownPromise;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownStarted = true;
  shutdownPromise = (async () => {
    console.log('[shutdown] 正在等待已接受的写入与同步任务');
    const deadline = setTimeout(() => { console.error('[shutdown] 收尾超时，强制退出；索引将在下次启动核对'); process.exit(1); }, 15000);
    server.close(); server.closeIdleConnections();
    syncEngine.stopAuto();
    // 请求切库期间仍可能重建监听，关闭标志同时阻止这些入口重新安排任务。
    ++watchEpoch; clearTimeout(watchTimer); pendingChanges.clear();
    if (watcher?.close) watcher.close(); else clearInterval(watcher);
    await Promise.allSettled([...activeRequests]);
    await backups.close();
    syncEngine.stopAuto();
    await syncEngine.running?.catch(error => console.warn('[shutdown] 同步任务未完成:', error.message));
    await trash.drain();
    if (vault) await vault.close();
    await lanShare.dispose();
    await mobileAccess.dispose();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    server.closeAllConnections();
    clearTimeout(deadline);
    console.log('[shutdown] 收尾完成');
    process.exit(0);
  })().catch(error => { console.error('[shutdown] 收尾失败:', error.message); process.exit(1); });
  return shutdownPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });
process.on('message', data => { if (data?.type === 'tracery-shutdown' && data.nonce === process.env.TRACERY_START_TOKEN) void shutdown(); });
// 主进程异常退出时，不遗留监听子进程。
if (process.connected) process.on('disconnect', () => { void shutdown(); });
start().catch(error => {
  console.error('[startup]', error.message);
  const message = { type: 'tracery-start-error', nonce: process.env.TRACERY_START_TOKEN, pid: process.pid, code: error.code };
  if (process.send) process.send(message, () => process.exit(1)); else process.exit(1);
});
