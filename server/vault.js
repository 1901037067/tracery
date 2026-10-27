/* 仓库索引独立于 HTTP 生命周期，便于用临时大仓库测量启动与增量更新。 */
import fsp from 'node:fs/promises';
import { noteIndex, resolveNote, isAttachmentTarget } from '../public/js/wiki-path.js';
import path from 'node:path';
import { IndexCache, snapshotIndex, sameStat, fileStat } from './index-cache.js';
import { resolveInVault } from './path-guard.js';
import { isPrivateUserPath } from './user-path.js';
export const IGNORED_DIRS = new Set(['.tracery', '.evnote', '.obsidian', '.git', 'node_modules', '.trash', '.local']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);
// 仅影响浏览列表；其他文件仍保留在仓库、附件下载与同步清单中。
const VISIBLE_EXT = new Set([...TEXT_EXT, '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);

export class Vault {
  constructor(root, { onProgress = () => {} } = {}) {
    this.root = path.resolve(root);
    this.onProgress = onProgress;
    this.notes = new Map();      // relPath -> { name, mtimeMs, links:[rawTarget], tags:Set, headings:[], backlinks:Set }
    this.byName = new Map();     // 小写文件名(不含.md) -> [relPath]
    this.files = new Map();      // relPath(所有文件) -> { mtimeMs, size, isDir:false }
    this.dirs = new Set();       // relPath 目录
    this.contentCache = new Map(); // relPath -> 内容（搜索用）
    this._rawSources = new Map(); // 原始链接目标 -> 来源路径，独立于同名消歧结果
    this._noteOrder = new Map();
    this._nextOrder = 0;
    this.cache = new IndexCache(this.root);
    this._queue = Promise.resolve();
    this.stats = { reads: 0, parsed: 0, reused: 0, graphBuilds: 0 };
  }

  open() { return this._run(() => this._open()); }
  _run(job) {
    const result = this._queue.then(job);
    this._queue = result.catch(() => {});
    return result;
  }

  async _open() {
    const started = performance.now();
    this.onProgress({ phase: 'cache', message: '正在检查笔记索引' });
    clearTimeout(this._cacheTimer);
    const cached = this.notes.size ? new Map(snapshotIndex(this)) : await this.cache.read();
    this.onProgress({ phase: 'scan', reason: this.cache.readReason || 'memory', message: cached.size ? '正在核对笔记索引' : '正在重建笔记索引' });
    // 扫描完成后一次交换，目录改名时 API 不会看到扫描到一半的仓库。
    const staging = new Vault(this.root, { onProgress: this.onProgress });
    await staging._loadFiles(cached);
    for (const key of ['notes', 'byName', 'files', 'dirs', 'contentCache', 'stats', '_rawSources', '_noteOrder', '_nextOrder']) this[key] = staging[key];
    this._tree = null;
    this._drawings = null;
    if (this.stats.parsed || cached.size !== this.notes.size || staging._linksRepaired) {
      this.onProgress({ phase: 'persist', message: '正在保存索引缓存' });
      if (!await this.persist()) this.onProgress({ phase: 'cache-warning', message: '索引缓存无法写入，本次仍可使用，下次将重新核对' });
    }
    this.stats.openMs = Math.round(performance.now() - started);
    this.onProgress({ phase: 'complete', message: '笔记索引已就绪', notes: this.notes.size, reused: this.stats.reused, parsed: this.stats.parsed, elapsedMs: this.stats.openMs });
  }

  async _loadFiles(cached) {
    const files = [];
    await this.walk(this.root, '', files);
    this.onProgress({ phase: 'load', message: '正在读取笔记索引', total: files.length, completed: 0 });
    // 限制并发，减少逐文件 I/O 往返，也避免同时打开一万份文件。
    let next = 0, completed = 0, lastReport = performance.now();
    await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
      while (next < files.length) {
        const rel = files[next++];
        try {
          const abs = path.join(this.root, rel), st = await fsp.lstat(abs);
          if (!st.isFile()) continue;
          this.files.set(rel, fileStat(st));
          if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
          const e = cached.get(rel);
          if (sameStat(e, st)) {
            const links = e.links.filter(link => !isAttachmentTarget(link));
            if (links.length !== e.links.length) this._linksRepaired = true;
            this.notes.set(rel, { name: e.name, links, tags: new Set(e.tags), headings: e.headings, mtimeMs: st.mtimeMs, backlinks: new Set() });
            this.contentCache.set(rel, e.content); this._addName(rel, e.name); this.stats.reused++;
          } else await this._readNote(rel, st, abs);
        } catch { /* 瞬时不可读的文件下次重试，缓存不冒充真实文件 */ }
        finally {
          completed++;
          if (completed === files.length || performance.now() - lastReport > 500) {
            lastReport = performance.now();
            this.onProgress({ phase: 'load', message: '正在读取笔记索引', completed, total: files.length });
          }
        }
      }
    }));
    this.rebuildGraph();
  }

  async walk(absDir, relDir, files) {
    let entries;
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (IGNORED_DIRS.has(e.name.toLowerCase())) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (isPrivateUserPath(this.root,rel)) continue;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name.toLowerCase())) continue;
        try { resolveInVault(this.root, rel); } catch { continue; }
        this.dirs.add(rel);
        await this.walk(path.join(absDir, e.name), rel, files);
      } else if (e.isFile()) {
        files.push(rel);
      }
    }
  }

  _addName(rel, name) {
    if (!this._noteOrder.has(rel)) this._noteOrder.set(rel, this._nextOrder++);
    const key = name.toLowerCase();
    if (!this.byName.has(key)) this.byName.set(key, []);
    const paths = this.byName.get(key);
    if (!paths.includes(rel)) { paths.push(rel); this._linkIndex = null; }
  }
  async _readNote(rel, st, scannedFile) {
    // 批量扫描已验证父目录，lstat 也确认是普通文件；增量入口仍独立验证。
    const abs = scannedFile || resolveInVault(this.root, rel), content = await fsp.readFile(abs, 'utf8');
    this.stats.reads++;
    this.indexNote(rel, content, st.mtimeMs);
    const after = await fsp.stat(abs);
    // 读取期间修改过的文件不给有效签名，后续事件 / 启动会重新读。
    this.files.set(rel, sameStat(st, after) ? fileStat(st) : { ...fileStat(after), mtimeMs: -1 });
  }
  persist() {
    clearTimeout(this._cacheTimer);
    this._persistPending = true;
    if (!this._writing) this._writing = Promise.resolve().then(async () => {
      let ok = true;
      try {
        do {
          this._persistPending = false;
          ok = await this.cache.write(snapshotIndex(this)) && ok;
        } while (this._persistPending);
        return ok;
      } finally { this._writing = null; }
    });
    return this._writing;
  }
  _schedulePersist() {
    clearTimeout(this._cacheTimer);
    this._cacheTimer = setTimeout(() => this.persist(), 800);
    this._cacheTimer.unref?.();
  }

  async close() {
    clearTimeout(this._cacheTimer);
    await this._queue;
    return this.persist();
  }

  /** 解析单篇笔记的链接/标签/标题，写入索引 */
  indexNote(rel, content, mtimeMs) {
    this.stats.parsed++;
    this._removeRawSources(rel);
    this._drawings = null;
    // 文件首行的 UTF-8 BOM 会把整行解析带歪：逐行正则 `^(#{1,6})\s+` 匹配不上 `\uFEFF#`，
    // 于是「# 不隐藏、没有标题样式、右栏大纲漏」，搜索/反链/标签索引同样漏（2026-10-20 用户报障）。
    // 只在**读**的这一个入口剥掉：下游（编辑器、大纲、索引、图谱）拿到的都是干净文本，
    // 而磁盘上的字节保持原样——用户不改这篇笔记就不会动到文件；一旦保存，文件顺手被规范化。
    const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    const ext = path.extname(rel).toLowerCase();
    const name = path.basename(rel, ext);
    this.contentCache.set(rel, text);
    const note = this.notes.get(rel) || { name, links: [], tags: new Set(), headings: [], backlinks: new Set() };
    note.name = name;
    note.mtimeMs = mtimeMs ?? note.mtimeMs;
    note.links = [];
    note.tags = new Set();
    note.headings = [];

    // [[双链]]：支持 [[目标]] / [[目标|别名]] / [[目标#标题]] / [[目标#标题|别名]]
    // 先剔除代码围栏与行内代码，避免把示例代码里的 [[...]] 当成真链接
    const codeFree = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
    const linkRe = /\[\[([^\]\|#]+)(?:#[^\]\|]*)?(?:\|[^\]]*)?\]\]/g;
    let m;
    while ((m = linkRe.exec(codeFree))) if (!isAttachmentTarget(m[1])) note.links.push(m[1].trim());

    // #标签（排除代码块内的，简化处理：跳过 ``` 围栏）
    const tagRe = /(^|[\s\(（])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
    let inFence = false;
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      let tm;
      const lineRe = new RegExp(tagRe.source, 'gu');
      while ((tm = lineRe.exec(line))) note.tags.add(tm[2]);
    }

    // 标题（大纲）
    for (const line of text.split('\n')) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) note.headings.push({ level: h[1].length, text: h[2].replace(/[*_`~]/g, '') });
    }

    this.notes.set(rel, note);
    this._addName(rel, name);
    this._addRawSources(rel, note.links);
  }

  _removeRawSources(rel) {
    for (const target of this.notes.get(rel)?.links || []) {
      const sources = this._rawSources.get(target);
      sources?.delete(rel);
      if (!sources?.size) this._rawSources.delete(target);
    }
  }
  _addRawSources(rel, links) {
    for (const target of links) {
      if (!this._rawSources.has(target)) this._rawSources.set(target, new Set());
      this._rawSources.get(target).add(rel);
    }
  }

  /** 反链等派生图数据 */
  rebuildGraph() {
    this._linkIndex = null;
    this._rawSources.clear();
    this.stats.graphBuilds++;
    for (const n of this.notes.values()) n.backlinks = new Set();
    for (const [rel, note] of this.notes) {
      this._addRawSources(rel, note.links);
      note.resolved = new Set();
      for (const target of note.links) {
        const resolved = this.resolve(target, rel);
        if (resolved && resolved !== rel) {
          this.notes.get(resolved)?.backlinks.add(rel);
          note.resolved.add(resolved);
        }
      }
    }
  }

  /** Obsidian 式链接解析：先按路径，再按文件名唯一匹配 */
  resolve(target, fromRel) {
    if (!this._linkIndex || this._indexNotes !== this.notes) {
      this._linkIndex = noteIndex(this.notes.keys()); this._indexNotes = this.notes;
    }
    return resolveNote(target, fromRel || '', this._linkIndex);
  }

  tree() {
    if (this._tree) return this._tree;
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
      if (!VISIBLE_EXT.has(path.extname(rel).toLowerCase())) continue;
      const parts = rel.split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) cur = cur.dirs.get(parts[i]) || root;
      const stat = this.files.get(rel);
      cur.files.push({ name: parts[parts.length - 1], path: rel, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs });
    }
    const build = (n) => ({
      name: n.name,
      dirs: [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(build),
      files: n.files.sort((a, b) => a.name.localeCompare(b.name)),
    });
    return this._tree = build(root);
  }

  /** 图片库由实际文件与引用推导，旧绘图也能进入列表，删掉引用后自然回到「未插入」。 */
  drawings() {
    if (this._drawings) return this._drawings;
    const drawings = [];
    for (const [scenePath, stat] of this.files) {
      if (!/\.draw\.json$/i.test(scenePath)) continue;
      const stem = scenePath.replace(/\.draw\.json$/i, '');
      const imagePath = ['png', 'jpg', 'jpeg', 'webp', 'gif'].map((ext) => `${stem}.${ext}`).find((p) => this.files.has(p));
      if (imagePath) drawings.push({ path: imagePath, scenePath, name: path.posix.basename(stem), updatedAt: stat.mtimeMs || stat.mtime || 0, notes: [] });
    }
    if (!drawings.length) return this._drawings = { drawings: [] };
    const byPath = new Map(drawings.map((d) => [d.path, d]));
    const byName = new Map();
    for (const d of drawings) {
      const name = path.posix.basename(d.path);
      byName.set(name, [...(byName.get(name) || []), d]);
    }
    for (const [notePath, content] of this.contentCache) {
      // 代码示例不算插图；双链与 Markdown 图片均按原路径或唯一文件名匹配。
      const text = content.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/`[^`\n]*`/g, '');
      const refs = [...text.matchAll(/!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/g)];
      for (const match of refs) {
        let target = match[1] ? match[1].split('|')[0] : match[2].replace(/\s+"[^"]*"$/, '').replace(/^<|>$/g, '');
        try { target = decodeURIComponent(target); } catch { /* 保留原路径 */ }
        target = target.trim().replace(/\\/g, '/');
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(notePath), target));
        const names = byName.get(target) || [];
        const drawing = match[1] ? byPath.get(target) || byPath.get(relative) || (names.length === 1 ? names[0] : null)
          : byPath.get(relative) || byPath.get(target);
        if (drawing && !drawing.notes.includes(notePath)) drawing.notes.push(notePath);
      }
    }
    return this._drawings = { drawings: drawings.map((d) => ({ ...d, inserted: d.notes.length > 0 })).sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path)) };
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
      .map((t) => ({ raw: t, sources: [...(this._rawSources.get(t) || [])]
        .sort((a, b) => this._noteOrder.get(a) - this._noteOrder.get(b)).map((src) => this.notes.get(src).name) }));
    return { backlinks, outgoing, unresolved };
  }

  search(q, limit = 50) {
    if (!q || limit <= 0) return [];
    const needle = q.toLowerCase();
    const results = [];
    for (const [rel, content] of this.contentCache) {
      const name = this.notes.get(rel)?.name || rel;
      const nameHit = name.toLowerCase().includes(needle);
      const lines = [];
      const sourceLines = content.split('\n');
      for (let i = 0; i < sourceLines.length; i++) {
        const line = sourceLines[i];
        if (line.toLowerCase().includes(needle)) lines.push({ line: i + 1, text: line.trim().slice(0, 160) });
        if (lines.length >= 6) break;
      }
      if (nameHit || lines.length) {
        results.push({ path: rel, name, nameHit, matches: lines.slice(0, 6) });
      }
    }
    const rank = row => row.name.toLowerCase() === needle ? 2 : row.nameHit ? 1 : 0;
    return results.sort((a, b) => rank(b) - rank(a)
      || (this.notes.get(b.path)?.mtimeMs || 0) - (this.notes.get(a.path)?.mtimeMs || 0)
      || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit);
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

  /** 一批监听事件只派生一次图；普通文字编辑只改该笔记的出链，不扫描全仓。 */
  applyChange(rel) { return this.applyChanges([rel]); }
  applyChanges(rels) { return this._run(() => this._applyChanges(rels)); }
  async _applyChanges(rels) {
    const changed = [], updates = [];
    let structure = false, noteStructure = false;
    const entries = [];
    for (const rel of new Set(rels)) {
      if (!rel || rel.split(/[\\/]/).some((s) => s === '..' || IGNORED_DIRS.has(s.toLowerCase())) || path.isAbsolute(rel)) continue;
      if (isPrivateUserPath(this.root,rel)) continue;
      let st;
      try { st = await fsp.stat(resolveInVault(this.root, rel)); }
      catch (error) { if (error.status !== 403 && !['ENOENT', 'ENOTDIR'].includes(error.code)) continue; }
      // 目录改动可能只发父目录事件，统一校验目录清单并复用未变笔记的索引。
      if (st?.isDirectory() || this.dirs.has(rel)) {
        await this._open();
        return { paths: ['*'], treeChanged: true };
      }
      entries.push({ rel, st });
    }
    for (const { rel, st } of entries) {
      const prev = this.files.get(rel);
      if (st && sameStat(prev, st)) continue;
      if (!st && !prev) continue;
      changed.push(rel);
      if (!prev || !st) structure = true;
      if (!st) {
        this.files.delete(rel);
        const note = this.notes.get(rel);
        if (note) {
          this._removeRawSources(rel);
          this._noteOrder.delete(rel);
          this.byName.set(note.name.toLowerCase(), (this.byName.get(note.name.toLowerCase()) || []).filter((p) => p !== rel));
          this.notes.delete(rel); this.contentCache.delete(rel); noteStructure = true;
        }
        continue;
      }
      this.files.set(rel, fileStat(st));
      const segments = rel.split('/'); segments.pop();
      for (let i = 1; i <= segments.length; i++) this.dirs.add(segments.slice(0, i).join('/'));
      if (TEXT_EXT.has(path.extname(rel).toLowerCase())) {
        if (!this.notes.has(rel)) noteStructure = true;
        const oldTargets = this.notes.get(rel)?.resolved || new Set();
        try { await this._readNote(rel, st); updates.push({ rel, oldTargets }); }
        catch { this.files.set(rel, { ...fileStat(st), mtimeMs: -1 }); }
      }
    }
    if (noteStructure) this.rebuildGraph();
    else for (const { rel, oldTargets } of updates) {
      for (const target of oldTargets) this.notes.get(target)?.backlinks.delete(rel);
      const note = this.notes.get(rel);
      note.resolved = new Set(note.links.map((t) => this.resolve(t, rel)).filter((t) => t && t !== rel));
      for (const target of note.resolved) this.notes.get(target)?.backlinks.add(rel);
    }
    if (changed.length) { this._tree = null; this._drawings = null; }
    if (changed.length) this._schedulePersist();
    return { paths: changed, treeChanged: structure };
  }
}
