/**
 * Tracery 服务端 —— 对应 Obsidian 架构中的「主进程」职责：
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// 打包进 Electron 后 asar 是只读的：TRACERY_HOME 指向可写的用户数据目录
// （兼容旧环境变量名 EVNOTE_HOME：老脚本/便携启动器不用改）
/* ================= 本地版本历史 =================
 * 每次保存前把「旧内容」快照进 TRACERY_HOME/history/<仓库哈希>/<笔记相对路径>/<时间戳>.md
 * 每个文件最多留 20 个快照（按时间滚动删除）。
 */
function historyDir(root, rel) {
  const h = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  const safe = rel.split('/').map((s) => s.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')).join('/');
  return path.join(HOME, 'history', h, safe);
}
async function snapshotHistory(root, rel, prevContent) {
  if (prevContent == null) return;
  const dir = historyDir(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${Date.now()}.md`), prevContent, 'utf8');
  const files = fs.readdirSync(dir).filter((f) => /^\d+\.md$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 20))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }
}

const HOME = process.env.TRACERY_HOME || process.env.EVNOTE_HOME || ROOT;

/* ================= 回收站 =================
 * 删除不再直接 unlink，而是移进 TRACERY_HOME/trash/<仓库哈希>/，
 * 每项 id__原文件名 + index.json 记录原始相对路径，可恢复。
 * 放在数据目录而不是仓库里：不污染笔记目录、不会被同步、文件树也看不见。
 */
function trashDir(root) {
  const h = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  return path.join(HOME, 'trash', h);
}
function readTrashIndex(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) || []; } catch { return []; }
}
function writeTrashIndex(dir, items) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(items, null, 2), 'utf8');
}
const TRASH_LIMIT = 200;
async function moveToTrash(root, rel, abs) {
  const dir = trashDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const name = path.basename(abs);
  const dest = path.join(dir, `${id}__${name}`);
  let size = 0;
  try { size = (await fsp.stat(abs)).size; } catch { /* ignore */ }
  try {
    await fsp.rename(abs, dest);          // 同盘：秒移
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;      // 跨盘（仓库在 D/E，数据目录在 C）：复制后删
    await fsp.copyFile(abs, dest);
    await fsp.unlink(abs);
  }
  const items = readTrashIndex(dir);
  items.unshift({ id, path: rel.replace(/\\/g, '/'), name, deletedAt: Date.now(), size });
  const trimmed = items.slice(0, TRASH_LIMIT);
  for (const drop of items.slice(TRASH_LIMIT)) {
    try { await fsp.unlink(path.join(dir, `${drop.id}__${drop.name}`)); } catch { /* ignore */ }
  }
  writeTrashIndex(dir, trimmed);
}
async function restoreFromTrash(root, id) {
  const dir = trashDir(root);
  const items = readTrashIndex(dir);
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const item = items[i];
  const src = path.join(dir, `${item.id}__${item.name}`);
  if (!fs.existsSync(src)) { items.splice(i, 1); writeTrashIndex(dir, items); return null; }
  const dest = path.join(root, item.path);
  let target = dest;
  let n = 1;
  while (fs.existsSync(target)) {
    const ext = path.extname(dest);
    target = `${dest.slice(0, dest.length - ext.length)} (${n})${ext}`;
    n += 1;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try { await fsp.rename(src, target); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, target);
    await fsp.unlink(src);
  }
  items.splice(i, 1);
  writeTrashIndex(dir, items);
  return path.relative(root, target).replace(/\\/g, '/');
}
async function purgeTrashItem(root, id) {
  const dir = trashDir(root);
  const items = readTrashIndex(dir);
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return;
  const item = items[i];
  try { await fsp.unlink(path.join(dir, `${item.id}__${item.name}`)); } catch { /* ignore */ }
  items.splice(i, 1);
  writeTrashIndex(dir, items);
}
async function emptyTrash(root) {
  const dir = trashDir(root);
  for (const item of readTrashIndex(dir)) {
    try { await fsp.unlink(path.join(dir, `${item.id}__${item.name}`)); } catch { /* ignore */ }
  }
  writeTrashIndex(dir, []);
}
const CONFIG_FILE = path.join(HOME, 'tracery.config.json');
const LEGACY_CONFIG_FILE = path.join(HOME, 'evnote.config.json');
const DEFAULT_VAULT = path.join(ROOT, 'demo-vault');
const PORT = Number(process.env.PORT) || 9520;

const IGNORED_DIRS = new Set(['.tracery', '.evnote', '.obsidian', '.git', 'node_modules', '.trash']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);

/* ---------------- 配置 ---------------- */
const DEFAULT_SETTINGS = {
  themeName: 'apple',     // 皮肤：public/themes/<name>.css
  themeMode: 'dark',      // light | dark | auto
  accent: 'blue',         // 强调色预设
  radius: 'default',      // compact | default | large
  fontSize: 16,           // 编辑区字号 px
  editorWidth: 720,       // 正文最大宽度 px
  autosave: 900,          // 自动保存防抖 ms
  lineNumbers: true,      // 行号：源码模式与实时预览共用
  startup: 'last',        // last | empty
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
  };
  // 兼容旧版顶层 theme / themeName
  if (!cfg.settings && cfg.theme) settings.themeMode = cfg.theme === 'light' ? 'light' : 'dark';
  if (!cfg.settings && cfg.themeName) settings.themeName = cfg.themeName;
  return { currentVault: null, recentVaults: [], ...cfg, settings };
}
function loadConfig() {
  // 一次性迁移：旧版 evnote.config.json → tracery.config.json（保住用户的最近仓库与设置）
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_CONFIG_FILE)) {
    try { fs.renameSync(LEGACY_CONFIG_FILE, CONFIG_FILE); }
    catch { /* 迁不动就原地读旧文件，下面有回退 */ }
  }
  for (const file of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    try { return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* 试下一个 */ }
  }
  return { currentVault: null, recentVaults: [], settings: { ...DEFAULT_SETTINGS, sync: { ...DEFAULT_SETTINGS.sync } } };
}
function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

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
  if (Number.isFinite(patch.autosave)) s.autosave = Math.min(3000, Math.max(0, Math.round(patch.autosave)));
  if (typeof patch.lineNumbers === 'boolean') s.lineNumbers = patch.lineNumbers;
  if (['last', 'empty'].includes(patch.startup)) s.startup = patch.startup;
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
  config.settings = s;
  saveConfig(config);
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
    const marker = path.join(target, 'Markdown 语法.md');
    if (!fs.existsSync(marker)) {
      copyDirSafe(DEFAULT_VAULT, target);
    }
  } catch (e) { console.warn('[vault] 复制演示仓库失败:', e.message); }
  return target;
}

/* ---------------- Vault 索引 ---------------- */
class Vault {
  constructor(root) {
    this.root = root;
    this.notes = new Map();      // relPath -> { name, mtimeMs, links:[rawTarget], tags:Set, headings:[], backlinks:Set }
    this.byName = new Map();     // 小写文件名(不含.md) -> [relPath]
    this.files = new Map();      // relPath(所有文件) -> { mtimeMs, size, isDir:false }
    this.dirs = new Set();       // relPath 目录
    this.contentCache = new Map(); // relPath -> 内容（搜索用）
  }

  async open() {
    this.notes.clear(); this.byName.clear(); this.files.clear(); this.dirs.clear(); this.contentCache.clear();
    await this.walk(this.root, '');
    this.rebuildGraph();
  }

  async walk(absDir, relDir) {
    let entries;
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && IGNORED_DIRS.has(e.name)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        this.dirs.add(rel);
        await this.walk(path.join(absDir, e.name), rel);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(path.join(absDir, e.name));
          this.files.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
          if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
            const content = await fsp.readFile(path.join(absDir, e.name), 'utf8');
            this.indexNote(rel, content, st.mtimeMs);
          }
        } catch { /* 忽略瞬时不可读文件 */ }
      }
    }
  }

  /** 解析单篇笔记的链接/标签/标题，写入索引 */
  indexNote(rel, content, mtimeMs) {
    const ext = path.extname(rel).toLowerCase();
    const name = path.basename(rel, ext);
    this.contentCache.set(rel, content);
    const note = this.notes.get(rel) || { name, links: [], tags: new Set(), headings: [], backlinks: new Set() };
    note.name = name;
    note.mtimeMs = mtimeMs ?? note.mtimeMs;
    note.links = [];
    note.tags = new Set();
    note.headings = [];

    // [[双链]]：支持 [[目标]] / [[目标|别名]] / [[目标#标题]] / [[目标#标题|别名]]
    // 先剔除代码围栏与行内代码，避免把示例代码里的 [[...]] 当成真链接
    const codeFree = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
    const linkRe = /\[\[([^\]\|#]+)(?:#[^\]\|]*)?(?:\|[^\]]*)?\]\]/g;
    let m;
    while ((m = linkRe.exec(codeFree))) note.links.push(m[1].trim());

    // #标签（排除代码块内的，简化处理：跳过 ``` 围栏）
    const tagRe = /(^|[\s\(（])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
    let inFence = false;
    for (const line of content.split('\n')) {
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      let tm;
      const lineRe = new RegExp(tagRe.source, 'gu');
      while ((tm = lineRe.exec(line))) note.tags.add(tm[2]);
    }

    // 标题（大纲）
    for (const line of content.split('\n')) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) note.headings.push({ level: h[1].length, text: h[2].replace(/[*_`~]/g, '') });
    }

    this.notes.set(rel, note);
    const key = name.toLowerCase();
    if (!this.byName.has(key)) this.byName.set(key, []);
    const arr = this.byName.get(key);
    if (!arr.includes(rel)) arr.push(rel);
  }

  /** 反链等派生图数据 */
  rebuildGraph() {
    for (const n of this.notes.values()) n.backlinks = new Set();
    for (const [rel, note] of this.notes) {
      for (const target of note.links) {
        const resolved = this.resolve(target, rel);
        if (resolved && resolved !== rel) {
          this.notes.get(resolved)?.backlinks.add(rel);
        }
      }
    }
  }

  /** Obsidian 式链接解析：先按路径，再按文件名唯一匹配 */
  resolve(target, fromRel) {
    const clean = target.trim().replace(/\\/g, '/').replace(/\.md$/i, '');
    if (!clean) return null;
    // 1) 相对当前笔记的路径
    const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
    const tryPaths = [];
    if (clean.includes('/')) tryPaths.push(clean, `${clean}.md`);
    else {
      if (fromDir) tryPaths.push(`${fromDir}/${clean}.md`);
      tryPaths.push(`${clean}.md`);
    }
    for (const p of tryPaths) if (this.notes.has(p)) return p;
    // 2) 全库文件名匹配（唯一时才解析，与 Obsidian 行为一致）
    const arr = this.byName.get(clean.toLowerCase());
    if (arr && arr.length === 1) return arr[0];
    return null;
  }

  tree() {
    const node = (name) => ({ name, children: [], files: [] });
    const root = { name: path.basename(this.root), dirs: new Map(), files: [] };
    for (const rel of [...this.dirs].sort()) {
      const parts = rel.split('/');
      let cur = root;
      for (const p of parts) {
        if (!cur.dirs.has(p)) cur.dirs.set(p, { name: p, dirs: new Map(), files: [] });
        cur = cur.dirs.get(p);
      }
    }
    for (const rel of [...this.files.keys()].sort()) {
      // 绘图的笔画旁车文件不作为普通附件展示（仍参与同步）
      if (/\.draw\.json$/i.test(rel)) continue;
      const parts = rel.split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) cur = cur.dirs.get(parts[i]) || root;
      cur.files.push({ name: parts[parts.length - 1], path: rel });
    }
    const build = (n) => ({
      name: n.name,
      dirs: [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(build),
      files: n.files.sort((a, b) => a.name.localeCompare(b.name)),
    });
    return build(root);
  }

  /** 反链 + 出链 + 未解析链接（带上下文行） */
  linksFor(rel) {
    const note = this.notes.get(rel);
    if (!note) return { backlinks: [], outgoing: [], unresolved: [] };
    const contexts = (srcRel, needle) => {
      const src = this.notes.get(srcRel);
      const lines = [];
      if (!src) return lines;
      const content = this.contentCache.get(srcRel) || '';
      const lower = needle.toLowerCase();
      content.split('\n').forEach((line, i) => {
        if (line.toLowerCase().includes(lower)) lines.push({ line: i + 1, text: line.trim().slice(0, 200) });
      });
      return lines.slice(0, 8);
    };
    const backlinks = [...note.backlinks].map((src) => ({
      path: src,
      name: this.notes.get(src)?.name || src,
      contexts: contexts(src, `[[${note.name}`),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const outgoing = [...new Set(note.links)].map((t) => ({
      raw: t,
      resolved: this.resolve(t, rel),
    }));
    const unresolved = [...new Set(note.links)]
      .filter((t) => !this.resolve(t, rel))
      .map((t) => ({ raw: t, sources: [...this.notes.values()].filter((n) => n.links.includes(t)).map((n) => n.name) }));
    return { backlinks, outgoing, unresolved };
  }

  search(q, limit = 50) {
    const needle = q.toLowerCase();
    const results = [];
    for (const [rel, content] of this.contentCache) {
      const name = this.notes.get(rel)?.name || rel;
      const nameHit = name.toLowerCase().includes(needle);
      const lines = [];
      content.split('\n').forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) lines.push({ line: i + 1, text: line.trim().slice(0, 160) });
      });
      if (nameHit || lines.length) {
        results.push({ path: rel, name, nameHit, matches: lines.slice(0, 6) });
      }
      if (results.length >= limit) break;
    }
    return results.sort((a, b) => (b.nameHit ? 1 : 0) - (a.nameHit ? 1 : 0));
  }

  allTags() {
    const counts = new Map();
    for (const note of this.notes.values()) for (const t of note.tags) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  graph() {
    const nodes = [];
    const links = [];
    const degree = new Map();
    for (const [rel, note] of this.notes) {
      nodes.push({ id: rel, name: note.name, degree: 0 });
      degree.set(rel, 0);
    }
    const seen = new Set();
    for (const [rel, note] of this.notes) {
      for (const t of note.links) {
        const to = this.resolve(t, rel);
        if (!to || to === rel) continue;
        const key = `${rel}→${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: rel, target: to });
        degree.set(rel, degree.get(rel) + 1);
        degree.set(to, degree.get(to) + 1);
      }
    }
    for (const n of nodes) n.degree = degree.get(n.id) || 0;
    return { nodes, links };
  }

  /** 增量更新：文件变化事件 */
  async applyChange(rel) {
    const abs = path.join(this.root, rel);
    try {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) { this.dirs.add(rel); return; }
      const prev = this.files.get(rel);
      this.files.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
      if (TEXT_EXT.has(path.extname(rel).toLowerCase())) {
        const content = await fsp.readFile(abs, 'utf8');
        this.indexNote(rel, content, st.mtimeMs);
      }
      if (!prev) { /* 新文件 */ }
      this.rebuildGraph();
    } catch {
      // 文件被删除
      this.files.delete(rel);
      this.dirs.delete(rel);
      if (this.notes.has(rel)) {
        const name = this.notes.get(rel).name.toLowerCase();
        const arr = this.byName.get(name);
        if (arr) this.byName.set(name, arr.filter((r) => r !== rel));
        this.notes.delete(rel);
        this.contentCache.delete(rel);
      }
      this.rebuildGraph();
    }
  }
}

let vault = null;

/* ---------------- 同步引擎（对应 Obsidian Sync 的主进程侧） ---------------- */
const syncEngine = new SyncEngine({
  getVaultRoot: () => vault?.root || null,
  notify: (status) => broadcast({ type: 'sync-status', status }),
  onApplied: async () => {
    // 同步写入了本地文件：重建索引，并让浏览器重新拉取内容
    if (!vault) return;
    await vault.open();
    broadcast({ type: 'fs-change', paths: ['*'], source: 'sync' });
  },
});

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
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { req.destroy(); reject(new Error('请求体过大')); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* ---------------- HTTP 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  try {
    // ---- API ----
    if (p === '/api/state') {
      return sendJson(res, 200, {
        vault: vault ? { root: vault.root, name: path.basename(vault.root) } : null,
        recentVaults: config.recentVaults,
        settings: config.settings,
      });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const patch = await readBody(req);
      const settings = mergeSettings(patch);
      broadcast({ type: 'settings', settings });
      return sendJson(res, 200, { ok: true, settings });
    }
    if (p === '/api/vault/open' && req.method === 'POST') {
      const { path: vaultPath } = await readBody(req);
      if (!vaultPath || !fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
        return sendJson(res, 400, { error: '目录不存在或不是文件夹' });
      }
      vault = new Vault(path.resolve(vaultPath));
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
      return sendJson(res, 200, { ok: true, status: await syncEngine.disconnect() });
    }

    // ---- 局域网直连（六位通行码，无需独立服务端） ----
    if (p === '/api/sync/lan/status') return sendJson(res, 200, lanShare.status());

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

    if (!vault) return sendJson(res, 409, { error: '尚未打开仓库' });

    if (p === '/api/tree') return sendJson(res, 200, vault.tree());

    if (p === '/api/note' && req.method === 'GET') {
      const rel = u.searchParams.get('path');
      if (!rel || !vault.notes.has(rel)) return sendJson(res, 404, { error: '笔记不存在' });
      const content = vault.contentCache.get(rel) ?? '';
      return sendJson(res, 200, { path: rel, name: vault.notes.get(rel).name, content });
    }
    if (p === '/api/note' && req.method === 'PUT') {
      const { path: rel, content } = await readBody(req);
      if (!rel) return sendJson(res, 400, { error: '缺少 path' });
      const abs = path.join(vault.root, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      // 覆盖前先快照旧内容（内容没变就不留）
      let prev = null;
      try { prev = await fsp.readFile(abs, 'utf8'); } catch { /* 新文件 */ }
      if (prev !== null && prev !== content) await snapshotHistory(vault.root, rel, prev);
      await fsp.writeFile(abs, content, 'utf8');
      await vault.applyChange(rel);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/history' && req.method === 'GET') {
      const rel = u.searchParams.get('path');
      if (!rel) return sendJson(res, 400, { error: '缺少 path' });
      const dir = historyDir(vault.root, rel);
      let items = [];
      try {
        items = fs.readdirSync(dir)
          .filter((f) => /^\d+\.md$/.test(f))
          .map((f) => {
            const st = fs.statSync(path.join(dir, f));
            return { id: f.replace(/\.md$/, ''), time: Number(f.replace(/\.md$/, '')), size: st.size };
          })
          .sort((a, b) => b.time - a.time);
      } catch { /* 没有历史 */ }
      return sendJson(res, 200, { items });
    }
    if (p === '/api/history/content' && req.method === 'GET') {
      const rel = u.searchParams.get('path');
      const id = u.searchParams.get('id');
      const file = path.join(historyDir(vault.root, rel || ''), `${id}.md`);
      if (!rel || !/^\d+$/.test(id || '') || !fs.existsSync(file)) return sendJson(res, 404, { error: '版本不存在' });
      return sendJson(res, 200, { content: await fsp.readFile(file, 'utf8') });
    }
    if (p === '/api/history/restore' && req.method === 'POST') {
      const { path: rel, id } = await readBody(req);
      const dir = historyDir(vault.root, rel || '');
      const file = path.join(dir, `${id}.md`);
      if (!rel || !/^\d+$/.test(String(id || '')) || !fs.existsSync(file)) return sendJson(res, 404, { error: '版本不存在' });
      const abs = path.join(vault.root, rel);
      let cur = null;
      try { cur = await fsp.readFile(abs, 'utf8'); } catch { /* 可能已被删 */ }
      if (cur !== null) await snapshotHistory(vault.root, rel, cur);   // 恢复前也留一份当前内容
      await fsp.writeFile(abs, await fsp.readFile(file, 'utf8'), 'utf8');
      await vault.applyChange(rel);
      broadcast({ type: 'fs-change', paths: [rel] });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/replace' && req.method === 'POST') {
      const { query, replacement } = await readBody(req);
      if (!query) return sendJson(res, 400, { error: '查询为空' });
      const rep = String(replacement ?? '');
      const touched = [];
      let count = 0;
      for (const rel of vault.notes.keys()) {
        const abs = path.join(vault.root, rel);
        let text;
        try { text = await fsp.readFile(abs, 'utf8'); } catch { continue; }
        if (!text.includes(query)) continue;
        const parts = text.split(query);
        count += parts.length - 1;
        await snapshotHistory(vault.root, rel, text);   // 替换前留快照，可回滚
        await fsp.writeFile(abs, parts.join(rep), 'utf8');
        touched.push(rel);
      }
      if (touched.length) {
        await vault.open();
        broadcast({ type: 'fs-change', paths: touched });
      }
      return sendJson(res, 200, { ok: true, files: touched, count });
    }
    // 保存资源文件（粘贴/拖入的图片和文档、绘图）：base64 → <dir>/xxx.ext
    // dir 由客户端按「附件设置」算好；服务端独立清洗——API 调用方永远不可信
    if (p === '/api/asset' && req.method === 'POST') {
      const body = await readBody(req, 64 * 1024 * 1024);
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
      let rel = dir ? `${dir}/${raw}.${ext}` : `${raw}.${ext}`;
      let n = 2;
      while (fs.existsSync(path.join(vault.root, rel))) rel = `${dir}/${raw}-${n++}.${ext}`;
      if (dir) await fsp.mkdir(path.join(vault.root, dir), { recursive: true });
      await fsp.writeFile(path.join(vault.root, rel), buf);
      const touched = [rel];
      // 绘图的笔画数据另存一份（便于以后重新编辑；不参与正文）
      if (body.drawing) {
        const jsonRel = `${dir}/${path.basename(rel, '.' + ext)}.draw.json`;
        await fsp.writeFile(path.join(vault.root, jsonRel), String(body.drawing), 'utf8');
        touched.push(jsonRel);
      }
      for (const relPath of touched) await vault.applyChange(relPath);
      broadcast({ type: 'fs-change', paths: touched });
      return sendJson(res, 200, { ok: true, path: rel, size: buf.length });
    }

    if (p === '/api/note/create' && req.method === 'POST') {      const { path: rel, content = '' } = await readBody(req);
      const abs = path.join(vault.root, rel);
      if (fs.existsSync(abs)) return sendJson(res, 409, { error: '文件已存在' });
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
      await vault.applyChange(rel);
      broadcast({ type: 'fs-change', paths: [rel] });
      return sendJson(res, 200, { ok: true, path: rel });
    }
    if (p === '/api/rename' && req.method === 'POST') {
      const { path: rel, newPath } = await readBody(req);
      if (!rel || !newPath) return sendJson(res, 400, { error: '参数缺失' });
      const abs = path.join(vault.root, rel);
      const newAbs = path.join(vault.root, newPath);
      if (!fs.existsSync(abs)) return sendJson(res, 404, { error: '文件不存在' });
      await fsp.mkdir(path.dirname(newAbs), { recursive: true });
      await fsp.rename(abs, newAbs);
      // Obsidian 行为：重命名后自动更新指向它的双链
      const oldName = path.basename(rel, path.extname(rel));
      const newName = path.basename(newPath, path.extname(newPath));
      const touched = new Set([rel]);
      if (oldName !== newName) {
        for (const [srcRel, note] of vault.notes) {
          if (srcRel === rel || !note.links.includes(oldName)) continue;
          const srcAbs = path.join(vault.root, srcRel);
          const c = vault.contentCache.get(srcRel) || '';
          const updated = c.replace(new RegExp(`\\[\\[${escapeRe(oldName)}(\\|[^\\]]*)?\\]\\]`, 'g'), `[[${newName}$1]]`);
          if (updated !== c) { await fsp.writeFile(srcAbs, updated, 'utf8'); touched.add(srcRel); }
        }
      }
      await vault.open();
      broadcast({ type: 'fs-change', paths: [...touched] });
      return sendJson(res, 200, { ok: true, path: newPath });
    }
    if (p === '/api/delete' && req.method === 'POST') {
      const { path: rel } = await readBody(req);
      const abs = path.join(vault.root, rel);
      if (!fs.existsSync(abs)) return sendJson(res, 404, { error: '文件不存在' });
      // 不再直接 unlink：先进回收站，可以恢复（回收站目录在 TRACERY_HOME 下，
      // 不污染仓库本身，也不会被同步 / 文件树看到）
      await moveToTrash(vault.root, rel, abs);
      await vault.applyChange(rel);
      broadcast({ type: 'fs-change', paths: [rel] });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/trash' && req.method === 'GET') {
      return sendJson(res, 200, { items: readTrashIndex(trashDir(vault.root)) });
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
      const abs = path.join(vault.root, rel || '');
      if (!abs.startsWith(vault.root) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return sendJson(res, 404, { error: '文件不存在' });
      }
      const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
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
    let filePath = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA 回退
      filePath = path.join(PUBLIC_DIR, 'index.html');
      if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not Found'); }
    }
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[api error]', p, err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

/* ---------------- 文件监听（对应 Obsidian 的 vault 监听） ---------------- */
let watcher = null;
let watchTimer = null;
const pendingChanges = new Set();
function watchVault(root) {
  if (watcher) watcher.close();
  try {
    watcher = fs.watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const rel = filename.replace(/\\/g, '/');
      if (rel.split('/').some((s) => IGNORED_DIRS.has(s))) return;
      pendingChanges.add(rel);
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(flushChanges, 120);
    });
    watcher.on('error', () => {});
  } catch (e) {
    console.warn('[watch] 递归监听不可用，退化为轮询:', e.message);
    watcher = setInterval(async () => {
      if (vault) { await vault.open(); broadcast({ type: 'fs-change', paths: ['*'] }); }
    }, 5000);
  }
}
async function flushChanges() {
  if (!vault) return;
  const rels = [...pendingChanges];
  pendingChanges.clear();
  for (const rel of rels) await vault.applyChange(rel);
  broadcast({ type: 'fs-change', paths: rels });
  // 本地改了东西 → 安排一次同步（刚被同步写盘的文件会被引擎自己忽略）
  syncEngine.scheduleSync('local-change');
}

/* ---------------- 启动 ---------------- */
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
  vault = new Vault(root);
  await vault.open();
  watchVault(root);
  syncEngine.startAuto();

  server.listen(PORT, () => {
    console.log(`Tracery 已启动:  http://localhost:${PORT}`);
    console.log(`当前仓库:      ${vault.root}`);
    console.log(`笔记数:        ${vault.notes.size}`);
    if (syncEngine.configured) console.log(`同步:          ${syncEngine.cfg.serverUrl}`);
  });
}
start();
