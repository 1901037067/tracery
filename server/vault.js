/* 仓库索引独立于 HTTP 生命周期，便于用临时大仓库测量启动与增量更新。 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readIndex, writeIndex, snapshotIndex, sameStat, fileStat } from './index-cache.js';
export const IGNORED_DIRS = new Set(['.tracery', '.evnote', '.obsidian', '.git', 'node_modules', '.trash']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);

export class Vault {
  constructor(root) {
    this.root = path.resolve(root);
    this.notes = new Map();      // relPath -> { name, mtimeMs, links:[rawTarget], tags:Set, headings:[], backlinks:Set }
    this.byName = new Map();     // 小写文件名(不含.md) -> [relPath]
    this.files = new Map();      // relPath(所有文件) -> { mtimeMs, size, isDir:false }
    this.dirs = new Set();       // relPath 目录
    this.contentCache = new Map(); // relPath -> 内容（搜索用）
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
    clearTimeout(this._cacheTimer);
    const cached = this.notes.size ? new Map(snapshotIndex(this)) : await readIndex(this.root);
    // 扫描完成后一次交换，目录改名时 API 不会看到扫描到一半的仓库。
    const staging = new Vault(this.root);
    await staging._loadFiles(cached);
    for (const key of ['notes', 'byName', 'files', 'dirs', 'contentCache', 'stats']) this[key] = staging[key];
    this._tree = null;
    if (this.stats.parsed || cached.size !== this.notes.size) await this.persist();
    this.stats.openMs = Math.round(performance.now() - started);
  }

  async _loadFiles(cached) {
    const files = [];
    await this.walk(this.root, '', files);
    // 限制并发，减少逐文件 I/O 往返，也避免同时打开一万份文件。
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
      while (next < files.length) {
        const rel = files[next++];
        try {
          const st = await fsp.stat(path.join(this.root, rel));
          this.files.set(rel, fileStat(st));
          if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
          const e = cached.get(rel);
          if (sameStat(e, st)) {
            this.notes.set(rel, { name: e.name, links: e.links, tags: new Set(e.tags), headings: e.headings, mtimeMs: st.mtimeMs, backlinks: new Set() });
            this.contentCache.set(rel, e.content); this._addName(rel, e.name); this.stats.reused++;
          } else await this._readNote(rel, st);
        } catch { /* 瞬时不可读的文件下次重试，缓存不冒充真实文件 */ }
      }
    }));
    this.rebuildGraph();
  }

  async walk(absDir, relDir, files) {
    let entries;
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && IGNORED_DIRS.has(e.name)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        this.dirs.add(rel);
        await this.walk(path.join(absDir, e.name), rel, files);
      } else if (e.isFile()) {
        files.push(rel);
      }
    }
  }

  _addName(rel, name) {
    const key = name.toLowerCase();
    if (!this.byName.has(key)) this.byName.set(key, []);
    const paths = this.byName.get(key);
    if (!paths.includes(rel)) paths.push(rel);
  }
  async _readNote(rel, st) {
    const abs = path.join(this.root, rel), content = await fsp.readFile(abs, 'utf8');
    this.stats.reads++;
    this.indexNote(rel, content, st.mtimeMs);
    const after = await fsp.stat(abs);
    // 读取期间修改过的文件不给有效签名，后续事件 / 启动会重新读。
    this.files.set(rel, sameStat(st, after) ? fileStat(st) : { ...fileStat(after), mtimeMs: -1 });
  }
  persist() {
    clearTimeout(this._cacheTimer);
    const notes = snapshotIndex(this);
    this._writing = (this._writing || Promise.resolve()).then(() => writeIndex(this.root, notes));
    return this._writing;
  }
  _schedulePersist() {
    clearTimeout(this._cacheTimer);
    this._cacheTimer = setTimeout(() => this.persist(), 800);
    this._cacheTimer.unref?.();
  }

  /** 解析单篇笔记的链接/标签/标题，写入索引 */
  indexNote(rel, content, mtimeMs) {
    this.stats.parsed++;
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
    while ((m = linkRe.exec(codeFree))) note.links.push(m[1].trim());

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
  }

  /** 反链等派生图数据 */
  rebuildGraph() {
    this.stats.graphBuilds++;
    for (const n of this.notes.values()) n.backlinks = new Set();
    for (const [rel, note] of this.notes) {
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
    return this._tree = build(root);
  }

  /** 图片库由实际文件与引用推导，旧绘图也能进入列表，删掉引用后自然回到「未插入」。 */
  drawings() {
    const drawings = [];
    for (const [scenePath, stat] of this.files) {
      if (!/\.draw\.json$/i.test(scenePath)) continue;
      const stem = scenePath.replace(/\.draw\.json$/i, '');
      const imagePath = ['png', 'jpg', 'jpeg', 'webp', 'gif'].map((ext) => `${stem}.${ext}`).find((p) => this.files.has(p));
      if (imagePath) drawings.push({ path: imagePath, scenePath, name: path.posix.basename(stem), updatedAt: stat.mtimeMs || stat.mtime || 0, notes: [] });
    }
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
    return { drawings: drawings.map((d) => ({ ...d, inserted: d.notes.length > 0 })).sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path)) };
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

  /** 一批监听事件只派生一次图；普通文字编辑只改该笔记的出链，不扫描全仓。 */
  applyChange(rel) { return this.applyChanges([rel]); }
  applyChanges(rels) { return this._run(() => this._applyChanges(rels)); }
  async _applyChanges(rels) {
    const changed = [], updates = [];
    let structure = false, noteStructure = false;
    const entries = [];
    for (const rel of new Set(rels)) {
      if (!rel || rel.split(/[\\/]/).some((s) => s === '..' || IGNORED_DIRS.has(s)) || path.isAbsolute(rel)) continue;
      let st;
      try { st = await fsp.stat(path.join(this.root, rel)); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) continue; }
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
    if (structure) this._tree = null;
    if (changed.length) this._schedulePersist();
    return { paths: changed, treeChanged: structure };
  }
}
