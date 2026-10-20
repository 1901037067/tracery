/* Tracery 图谱视图（仿 Obsidian Graph View）— Canvas 力导向布局 */
export class ForceGraph {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;             // { onNodeClick(path) }
    this.nodes = [];
    this.links = [];
    this.scale = 1;
    this.panX = 0; this.panY = 0;
    this.dragNode = null;
    this.hoverNode = null;
    this.raf = null;
    this._cssWidth = 0; this._cssHeight = 0;

    this._bind();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this._cssWidth = rect.width;
    this._cssHeight = rect.height;
    this.canvas.width = Math.max(1, rect.width * dpr);
    this.canvas.height = Math.max(1, rect.height * dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._draw();
  }

  setData({ nodes, links }) {
    const w = this._cssWidth || 300;
    const h = this._cssHeight || 300;
    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) / 3;
    this.nodes = nodes.map((n, i) => {
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      const r = radius * (0.4 + 0.6 * ((i * 2654435761) % 100) / 100);
      return {
        ...n,
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        vx: 0, vy: 0,
        r: 4 + Math.min(7, Math.sqrt(n.degree || 0) * 1.6),
      };
    });
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.links = links
      .map((l) => ({ source: byId.get(l.source), target: byId.get(l.target) }))
      .filter((l) => l.source && l.target);
    this._reheat();
  }

  _reheat() {
    this.alpha = 1;
    if (!this.raf) this._tick();
  }

  pause() { cancelAnimationFrame(this.raf); this.raf = null; }

  zoomIn() { this.scale = Math.min(4, this.scale * 1.25); this._draw(); }
  zoomOut() { this.scale = Math.max(0.2, this.scale / 1.25); this._draw(); }

  /** 适应窗口：按内容包围盒算缩放与平移，让所有节点完整可见 */
  fit({ reheat = false } = {}) {
    const w = this._cssWidth, h = this._cssHeight;
    if (!w || !h || !this.nodes.length) {
      this.scale = 1; this.panX = 0; this.panY = 0;
      this._draw();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const pad = 70;
    const bw = Math.max(60, maxX - minX);
    const bh = Math.max(60, maxY - minY);
    const s = Math.min(3, Math.max(0.2, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.scale = s;
    this.panX = -(cx - w / 2) * s;
    this.panY = -(cy - h / 2) * s;
    this._draw();
    if (reheat) this._reheat();
  }

  _tick() {
    const { nodes, links } = this;
    const cx = this._cssWidth / 2, cy = this._cssHeight / 2;
    this.alpha = Math.max(0, (this.alpha || 1) - 0.012);

    // 斥力
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (Math.random() - .5); dy = (Math.random() - .5); d2 = 1; }
        if (d2 > 400000) continue;
        const f = 900 / d2;
        const fx = (dx / Math.sqrt(d2)) * f, fy = (dy / Math.sqrt(d2)) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // 弹簧
    for (const l of links) {
      const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = (d - 70) * 0.02;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      l.source.vx += fx; l.source.vy += fy;
      l.target.vx -= fx; l.target.vy -= fy;
    }
    // 向心 + 阻尼
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.002;
      n.vy += (cy - n.y) * 0.002;
      if (n === this.dragNode) { n.vx = 0; n.vy = 0; continue; }
      n.x += n.vx * 0.85;
      n.y += n.vy * 0.85;
      n.vx *= 0.82; n.vy *= 0.82;
    }
    this._draw();
    if (this.alpha > 0.02 || this.dragNode) {
      this.raf = requestAnimationFrame(() => this._tick());
    } else {
      this.raf = null;
    }
  }

  _draw() {
    const ctx = this.ctx;
    const w = this._cssWidth, h = this._cssHeight;
    if (!w || !h) return;
    const styles = getComputedStyle(document.documentElement);
    const linkColor = styles.getPropertyValue('--border-light').trim() || '#444';
    const nodeColor = styles.getPropertyValue('--text-muted').trim() || '#999';
    const activeColor = '#8b5cf6';
    const textColor = styles.getPropertyValue('--text-faint').trim() || '#777';

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(this.panX + w / 2, this.panY + h / 2);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-w / 2, -h / 2);

    // 边
    ctx.strokeStyle = linkColor;
    ctx.lineWidth = 1;
    for (const l of this.links) {
      const highlight = this.hoverNode && (l.source === this.hoverNode || l.target === this.hoverNode);
      ctx.globalAlpha = highlight ? 0.95 : 0.35;
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 节点
    for (const n of this.nodes) {
      const isHover = n === this.hoverNode;
      const isActive = this.opts.activePath && n.id === this.opts.activePath;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = isHover || isActive ? activeColor : (n.degree ? nodeColor : textColor);
      ctx.globalAlpha = isHover || isActive ? 1 : 0.9;
      ctx.fill();
      if (isHover || isActive) {
        ctx.strokeStyle = activeColor;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 6;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (this.scale > 0.55 || isHover || n.degree >= 3) {
        ctx.fillStyle = isHover || isActive ? activeColor : textColor;
        ctx.font = `${Math.max(9, 11 / this.scale)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(n.name, n.x, n.y - n.r - 4);
      }
    }
    ctx.restore();
  }

  _toWorld(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (evt.clientX - rect.left - this.panX - this._cssWidth / 2) / this.scale + this._cssWidth / 2;
    const y = (evt.clientY - rect.top - this.panY - this._cssHeight / 2) / this.scale + this._cssHeight / 2;
    return { x, y };
  }

  _nodeAt(evt) {
    const { x, y } = this._toWorld(evt);
    let best = null, bestD = 20 / this.scale;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  _bind() {
    let panning = false, lastX = 0, lastY = 0;
    let startX = 0, startY = 0, moved = false;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (!e.isPrimary) return;
      this.canvas.setPointerCapture(e.pointerId);
      const n = this._nodeAt(e);
      if (n) { this.dragNode = n; this._reheat(); }
      else { panning = true; }
      lastX = e.clientX; lastY = e.clientY;
      startX = e.clientX; startY = e.clientY; moved = false;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if ((this.dragNode || panning) && Math.hypot(e.clientX - startX, e.clientY - startY) > 5) moved = true;
      if (this.dragNode) {
        const { x, y } = this._toWorld(e);
        this.dragNode.x = x; this.dragNode.y = y;
        this._reheat();
      } else if (panning) {
        this.panX += e.clientX - lastX;
        this.panY += e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        this._draw();
      } else {
        const n = this._nodeAt(e);
        if (n !== this.hoverNode) {
          this.hoverNode = n;
          this.canvas.style.cursor = n ? 'pointer' : 'grab';
          this._draw();
        }
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      if (this.dragNode) {
        const clicked = this.dragNode;
        this.dragNode = null;
        // 大图谱里拖节点用于整理布局，只有原地单击才应离开图谱打开笔记。
        if (!moved) this.opts.onNodeClick?.(clicked.id);
      }
      panning = false;
    });
    this.canvas.addEventListener('pointercancel', () => { this.dragNode = null; panning = false; });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.scale = Math.min(4, Math.max(0.2, this.scale * factor));
      this._draw();
    }, { passive: false });
    this.canvas.addEventListener('dblclick', () => {
      this.scale = 1; this.panX = 0; this.panY = 0;
      this._draw();
    });
  }

  centerOn(path) {
    const n = this.nodes.find((x) => x.id === path);
    if (!n) return;
    this.panX = -n.x + this._cssWidth / 2 - (this._cssWidth / 2);
    this.panY = -n.y + this._cssHeight / 2 - (this._cssHeight / 2);
    this.hoverNode = n;
    this._draw();
  }
}
