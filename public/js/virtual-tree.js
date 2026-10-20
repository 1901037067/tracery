/* 大仓库只为可见行建 DOM；完整路径和折叠状态始终来自数据，不依赖屏幕外节点。 */
export class VirtualTree {
  constructor(box, createRow) {
    this.box = box; this.createRow = createRow; this.rows = []; this.indices = new Map();
    this.layer = document.createElement('div'); this.layer.className = 'virtual-tree';
    this.layer.setAttribute('role', 'tree');
    box.replaceChildren(this.layer);
    this.scroll = () => { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = null; this.paint(); }); };
    box.addEventListener('scroll', this.scroll, { passive: true });
    this.resize = new ResizeObserver(() => this.paint(true)); this.resize.observe(box);
  }
  rowHeight() { return parseFloat(getComputedStyle(this.box).getPropertyValue('--tree-row-height')) || 32; }
  setRows(rows) {
    const height = this.rowHeight();
    const old = this.rows[Math.floor(this.box.scrollTop / height)];
    const offset = this.box.scrollTop % height;
    this.rows = rows;
    this.indices = new Map(rows.map((row, i) => [row.key, i]));
    this.layer.style.height = `${rows.length * height}px`;
    if (old && this.indices.has(old.key)) this.box.scrollTop = this.indices.get(old.key) * height + offset;
    this.box.scrollTop = Math.min(this.box.scrollTop, Math.max(0, rows.length * height - this.box.clientHeight));
    this.paint(true);
  }
  paint(force = false) {
    const h = this.rowHeight();
    this.layer.style.height = `${this.rows.length * h}px`;
    const start = Math.max(0, Math.floor(this.box.scrollTop / h) - 8);
    const end = Math.min(this.rows.length, Math.ceil((this.box.scrollTop + (this.box.clientHeight || 600)) / h) + 8);
    if (!force && start === this.start && end === this.end && h === this.height) return;
    this.start = start; this.end = end; this.height = h;
    const nodes = [];
    for (let i = start; i < end; i++) {
      const row = this.rows[i], el = this.createRow(row);
      el.classList.add('virtual-tree-row');
      el.style.cssText = `height:${h}px;top:${i * h}px;padding-left:${9 + row.depth * 18}px`;
      if (row.kind !== 'heading') {
        el.setAttribute('role', 'treeitem'); el.setAttribute('aria-level', String(row.depth + 1)); el.tabIndex = 0;
        if (row.kind === 'dir') el.setAttribute('aria-expanded', String(row.open));
        el.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); } };
      }
      nodes.push(el);
    }
    this.layer.replaceChildren(...nodes);
  }
  select(path) {
    for (const el of this.layer.querySelectorAll('.tree-item[data-path]')) el.classList.toggle('active', el.dataset.path === path);
  }
  reveal(path) {
    const i = this.indices.get(`file:${path}`);
    if (i === undefined) return false;
    this.box.scrollTop = Math.max(0, i * this.rowHeight() - this.box.clientHeight / 2);
    this.paint(true); return true;
  }
  destroy() { this.resize.disconnect(); this.box.removeEventListener('scroll', this.scroll); cancelAnimationFrame(this.raf); }
}

export function flattenTree(tree, collapsed, pinned) {
  const rows = [];
  if (pinned.size) {
    rows.push({ kind: 'heading', key: 'pinned', depth: 0 });
    for (const path of pinned) rows.push({ kind: 'pinned', key: `pinned:${path}`, depth: 0, file: { path, name: path.split('/').pop() } });
  }
  const walk = (node, depth, parent = '') => {
    for (const dir of node.dirs || []) {
      const rel = parent ? `${parent}/${dir.name}` : dir.name, open = !collapsed.has(dir.name);
      rows.push({ kind: 'dir', key: `dir:${rel}`, depth, node: dir, rel, open });
      if (open) walk(dir, depth + 1, rel);
    }
    for (const file of node.files || []) rows.push({ kind: 'file', key: `file:${file.path}`, depth, file });
  };
  walk(tree, 0); return rows;
}
