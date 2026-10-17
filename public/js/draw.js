/**
 * 内置绘图面板
 * ------------------------------------------------------------------
 * 目标：随手画个示意图，直接插进当前笔记。不追求 Excalidraw 的矢量和协作，
 * 换来的是一块能立刻用的白板：
 *   - 画笔 / 荧光笔 / 橡皮，8 色 + 3 档粗细
 *   - 撤销 / 重做 / 清空
 *   - 保存为 PNG 写进仓库 `附件/`，同时在笔记光标处插入 ![[...]]
 *   - 笔画数据另存一份 .draw.json（以后做「重新编辑」不用重新画）
 */
import { Api, toast } from './api.js';

const COLORS = [
  ['#1d1d1f', '墨黑'],
  ['#6b6b70', '灰'],
  ['#e5484d', '红'],
  ['#f5a524', '橙'],
  ['#30a46c', '绿'],
  ['#0071e3', '蓝'],
  ['#7c5cff', '紫'],
  ['#ec4899', '粉'],
];
const SIZES = [2, 4, 9];

let overlay = null;
let canvas = null;
let ctx = null;
let toolbar = null;
let hint = null;

let strokes = [];
let history = [[]];
let historyIndex = 0;
let current = null;
let tool = 'pen';
let color = COLORS[0][0];
let width = SIZES[1];
let dpr = 1;
let W = 0;
let H = 0;
let opts = {};
let saving = false;

/* ---------------- 构建界面 ---------------- */
function ensure() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'draw-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="draw-top">
      <div class="draw-group draw-tools">
        <button data-tool="pen" class="draw-tool active" title="画笔 (P)">画笔</button>
        <button data-tool="marker" class="draw-tool" title="荧光笔 (M)">荧光</button>
        <button data-tool="eraser" class="draw-tool" title="橡皮 (E)">橡皮</button>
      </div>
      <div class="draw-group draw-colors">
        ${COLORS.map(([c, n], i) => `<button data-color="${c}" class="draw-swatch${i === 0 ? ' active' : ''}" title="${n}" style="--sw:${c}"></button>`).join('')}
      </div>
      <div class="draw-group draw-sizes">
        ${SIZES.map((s, i) => `<button data-size="${s}" class="draw-size${i === 1 ? ' active' : ''}" title="${s}px"><span style="width:${s + 2}px;height:${s + 2}px"></span></button>`).join('')}
      </div>
      <div class="draw-group draw-history">
        <button id="draw-undo" class="draw-icon" title="撤销 (Ctrl+Z)">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5.5L3.5 9 7 12.5"/><path d="M3.5 9h8a5 5 0 0 1 0 10h-2"/></svg>
        </button>
        <button id="draw-redo" class="draw-icon" title="重做 (Ctrl+Shift+Z)">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5.5L16.5 9 13 12.5"/><path d="M16.5 9h-8a5 5 0 0 0 0 10h2"/></svg>
        </button>
        <button id="draw-clear" class="draw-icon" title="清空">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4.5h4V6M5.5 6l.7 9.5h7.6L14.5 6"/></svg>
        </button>
      </div>
      <div class="draw-group draw-actions">
        <button id="draw-cancel" class="btn-ghost">取消</button>
        <button id="draw-save" class="btn-primary">插入笔记</button>
      </div>
    </div>
    <div class="draw-stage">
      <canvas id="draw-canvas"></canvas>
    </div>
    <div class="draw-hint">按住拖动画笔 · 快捷键 P / M / E 切换 · Esc 取消</div>`;
  document.body.appendChild(overlay);
  canvas = overlay.querySelector('#draw-canvas');
  ctx = canvas.getContext('2d');
  toolbar = overlay.querySelector('.draw-top');
  hint = overlay.querySelector('.draw-hint');

  // 工具
  overlay.querySelectorAll('.draw-tool').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool);
  });
  overlay.querySelectorAll('.draw-swatch').forEach((b) => {
    b.onclick = () => {
      color = b.dataset.color;
      overlay.querySelectorAll('.draw-swatch').forEach((x) => x.classList.toggle('active', x === b));
      if (tool === 'eraser') setTool('pen');
    };
  });
  overlay.querySelectorAll('.draw-size').forEach((b) => {
    b.onclick = () => {
      width = Number(b.dataset.size);
      overlay.querySelectorAll('.draw-size').forEach((x) => x.classList.toggle('active', x === b));
    };
  });
  overlay.querySelector('#draw-undo').onclick = undo;
  overlay.querySelector('#draw-redo').onclick = redo;
  overlay.querySelector('#draw-clear').onclick = () => {
    if (!strokes.length) return;
    strokes = [];
    pushHistory();   // 清空也要能撤销
    draw();
  };
  overlay.querySelector('#draw-cancel').onclick = () => close();
  overlay.querySelector('#draw-save').onclick = () => save();

  bindCanvas();
  document.addEventListener('keydown', onKey, true);
}

function setTool(t) {
  tool = t;
  overlay.querySelectorAll('.draw-tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  canvas.style.cursor = t === 'eraser' ? 'cell' : 'crosshair';
}

/* ---------------- 画布 ---------------- */
function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const nw = Math.max(1, Math.round(rect.width));
  const nh = Math.max(1, Math.round(rect.height));
  if (nw === W && nh === H) return;
  const sx = W ? nw / W : 1;
  const sy = H ? nh / H : 1;
  if (W && H && (sx !== 1 || sy !== 1)) {
    // 窗口尺寸变化：笔画按比例缩放，避免跑到画布外
    for (const s of [...strokes, ...(current ? [current] : [])]) {
      for (const p of s.points) { p.x *= sx; p.y *= sy; }
    }
  }
  W = nw; H = nh;
  dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function bindCanvas() {
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    current = { tool, color, width, points: [p] };
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    const p = pos(e);
    const last = current.points[current.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1.2) return;
    current.points.push(p);
    draw();
  });
  const end = () => {
    if (!current) return;
    if (current.points.length === 1) current.points.push({ ...current.points[0], x: current.points[0].x + 0.1 });
    strokes.push(current);
    current = null;
    pushHistory();
    draw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', (e) => { if (e.buttons === 0) end(); });
}

function strokeStyle(s) {
  if (s.tool === 'eraser') return { color: '#ffffff', width: s.width * 3.2, alpha: 1, cap: 'round' };
  if (s.tool === 'marker') return { color: s.color, width: s.width * 3, alpha: 0.32, cap: 'butt' };
  return { color: s.color, width: s.width, alpha: 1, cap: 'round' };
}

function drawStroke(s) {
  const st = strokeStyle(s);
  const pts = s.points;
  if (!pts.length) return;
  ctx.save();
  ctx.globalAlpha = st.alpha;
  ctx.strokeStyle = st.color;
  ctx.fillStyle = st.color;
  ctx.lineWidth = st.width;
  ctx.lineCap = st.cap;
  ctx.lineJoin = 'round';
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, st.width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  ctx.restore();
}

function draw() {
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  for (const s of strokes) drawStroke(s);
  if (current) drawStroke(current);
  canvas.dataset.strokes = String(strokes.length + (current ? 1 : 0));
}

/* ---------------- 撤销 / 重做（整块快照，清空也能撤销） ---------------- */
function cloneStrokes(list) {
  return list.map((s) => ({ ...s, points: s.points.map((p) => ({ x: p.x, y: p.y })) }));
}

/** 把当前画面压入历史；新操作会丢弃「未来」 */
function pushHistory() {
  history = history.slice(0, historyIndex + 1);
  history.push(cloneStrokes(strokes));
  historyIndex = history.length - 1;
  updateHistoryButtons();
}

function jumpTo(i) {
  if (i < 0 || i >= history.length) return;
  historyIndex = i;
  strokes = cloneStrokes(history[i]);
  current = null;
  draw();
  updateHistoryButtons();
}

function undo() {
  if (historyIndex <= 0) return;
  jumpTo(historyIndex - 1);
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  jumpTo(historyIndex + 1);
}

function updateHistoryButtons() {
  if (!overlay) return;
  const u = overlay.querySelector('#draw-undo');
  const r = overlay.querySelector('#draw-redo');
  const c = overlay.querySelector('#draw-clear');
  if (u) u.disabled = historyIndex <= 0;
  if (r) r.disabled = historyIndex >= history.length - 1;
  if (c) c.disabled = strokes.length === 0 && historyIndex === 0;
}

/* ---------------- 保存 ---------------- */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function save() {
  if (saving) return;
  if (!strokes.length) { toast('画布还是空的，先画点什么'); return; }
  saving = true;
  const btn = overlay.querySelector('#draw-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    for (const s of strokes) drawStroke(s);
    const dataUrl = canvas.toDataURL('image/png');
    const res = await Api.saveAsset({
      name: `绘图 ${stamp()}`,
      data: dataUrl,
      drawing: JSON.stringify({ v: 1, width: W, height: H, strokes }),
    });
    await opts.onInserted?.(res.path);
    close();
    toast('绘图已插入笔记');
  } catch (e) {
    toast(`保存失败：${e.message}`);
  } finally {
    saving = false;
    btn.disabled = false;
    btn.textContent = '插入笔记';
  }
}

/* ---------------- 开关 ---------------- */
export function openDraw(options = {}) {
  ensure();
  opts = options || {};
  strokes = [];
  history = [[]];
  historyIndex = 0;
  current = null;
  overlay.hidden = false;
  setTool('pen');
  updateHistoryButtons();
  requestAnimationFrame(() => {
    resizeCanvas();
    canvas.focus?.();
  });
  window.addEventListener('resize', resizeCanvas);
}

export function close() {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  window.removeEventListener('resize', resizeCanvas);
  strokes = [];
  history = [[]];
  historyIndex = 0;
  current = null;
}

export function isDrawOpen() {
  return !!overlay && !overlay.hidden;
}

function onKey(e) {
  if (!isDrawOpen()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopPropagation(); redo(); return; }
  if (mod) return;
  const k = e.key.toLowerCase();
  if (k === 'p') { setTool('pen'); e.stopPropagation(); }
  else if (k === 'm') { setTool('marker'); e.stopPropagation(); }
  else if (k === 'e') { setTool('eraser'); e.stopPropagation(); }
}
