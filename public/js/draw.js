/**
 * 内置绘图白板（Excalidraw 风格）
 * ------------------------------------------------------------------
 * 目标：在笔记里随手画示意图，视觉上要有 Excalidraw 那个味道——手绘抖动线、
 * 图形 + 箭头 + 文字、选择框拖拽、缩放平移、排线填充。
 *
 * 不引第三方库（离线可用、不打大包），核心三件事自己实现：
 *   ① rough 渲染：按 seed 生成抖动折线，每条线描两遍；圆/椭圆按角度抖动半径
 *   ② 场景模型：{ id, type, x, y, w, h, points, text, stroke, background, fillStyle,
 *      strokeWidth, strokeStyle, seed }，撤销 = 整个数组的快照
 *   ③ 交互：选择（框选/拖拽/四角缩放）、形状拖画、手绘、文字（浮层 textarea）、
 *      橡皮（点/刷）、滚轮平移 + Ctrl 滚轮缩放 + 空格拖拽
 *
 * 保存：PNG 写进仓库（目录按「设置 → 附件」），同时把场景 JSON 存成
 * <同名>.draw.json（v2），以后要做「重新编辑」不用重新画。
 */
import { Api, toast } from './api.js';
import { askText, askConfirm } from './dialog.js';
import { getSettings, resolveAssetDir } from './settings.js';
import { enableTouchControls } from './mobile.js';

/* ================= 常量 ================= */
const STROKE_COLORS = ['#1d1d1f', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#7048e8', '#c2255c', '#868e96'];
const BG_COLORS = ['#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#d0bfff', '#fcc2d7', '#e9ecef', '#ffffff'];
const WIDTHS = [1.5, 2.5, 4.5];
const FILLS = [['none', '无'], ['hachure', '排线'], ['solid', '实心']];
const DASHES = [['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']];
const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
const MIN_SIZE = 4;
const ROTATE_OFFSET = 26;     // 旋转柄离形状顶边的屏幕距离（px）
const ROTATE_SNAP = Math.PI / 12;   // 按住 Shift 时的 15° 吸附
const DRAFTS_KEY = 'tracery.drawDrafts';   // 草稿箱存本地 localStorage（不进仓库、不同步）
const DRAFT_LIMIT = 30;
const RECENT_COLORS_KEY = 'tracery.draw.recentColors';
const COLOR_LIMIT = 8;
const normalizeColor = value => {
  const hex = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) return '#' + [...hex].map(c => c + c).join('').toLowerCase();
  return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toLowerCase() : null;
};

function recentColors() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) || '[]');
    return Array.isArray(list) ? [...new Set(list.map(normalizeColor).filter(Boolean))].slice(0, COLOR_LIMIT) : [];
  } catch { return []; }
}

function rememberColor(color) {
  const value = normalizeColor(color);
  if (!value) return;
  try { localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify([value, ...recentColors().filter(c => c !== value)].slice(0, COLOR_LIMIT))); }
  catch { toast('最近颜色未能保存到本机'); }
  renderRecentColors();
}

function renderRecentColors() {
  const colors = recentColors();
  propsEl.querySelectorAll('.draw-color-recent').forEach(row => {
    row.replaceChildren(); row.hidden = !colors.length;
    const label = document.createElement('span'); label.textContent = '最近'; row.append(label);
    for (const color of colors) {
      const button = document.createElement('button');
      button.className = 'draw-recent-swatch'; button.dataset.color = color;
      button.style.setProperty('--sw', color); button.title = color.toUpperCase();
      button.setAttribute('aria-label', `最近颜色 ${color.toUpperCase()}`); row.append(button);
    }
  });
}

function colorControls(kind, colors) {
  const label = kind === 'stroke' ? '描边' : '图形背景';
  return `<div class="dp-group draw-color-group" data-color-kind="${kind}">
    <div class="dp-label">${label}</div>
    <div class="dp-row draw-color-presets">
      ${kind === 'background' ? '<button class="draw-bg draw-bg-none" data-color="transparent" title="透明" aria-label="透明背景"></button>' : ''}
      ${colors.map(color => `<button class="${kind === 'stroke' ? 'draw-swatch' : 'draw-bg'}" data-color="${color}" title="${color}" aria-label="${label} ${color}" style="--sw:${color}"></button>`).join('')}
    </div>
    <div class="draw-custom-color">
      <input type="color" class="draw-color-picker" aria-label="${label}自定义选色" title="打开${label}选色板" />
      <input type="text" class="draw-color-hex" aria-label="${label}色号" placeholder="#RRGGBB" maxlength="7" spellcheck="false" />
      <button class="draw-color-apply" title="应用${label}色号">应用</button>
    </div>
    <div class="draw-color-recent" aria-label="${label}最近颜色" hidden></div>
  </div>`;
}

function chooseColor(kind, value) {
  const color = value === 'transparent' && kind === 'background' ? value : normalizeColor(value);
  if (!color) return false;
  applyStyle(kind === 'stroke' ? { stroke: color } : { background: color, fillStyle: color === 'transparent' ? 'none' : (style.fillStyle === 'none' ? 'hachure' : style.fillStyle) });
  rememberColor(color);
  return true;
}

const TOOLS = [
  ['select', '选择', 'V'],
  ['hand', '抓手', 'H'],
  ['rect', '矩形', 'R'],
  ['ellipse', '椭圆', 'O'],
  ['diamond', '菱形', 'D'],
  ['arrow', '箭头', 'A'],
  ['line', '直线', 'L'],
  ['freedraw', '画笔', 'P'],
  ['text', '文字', 'T'],
  ['eraser', '橡皮', 'E'],
];

const TOOL_ICONS = {
  select: '<path d="M4 3l10 7-4.4 1.2L7.6 16z"/>',
  hand: '<path d="M6 8.2V4.6a1.3 1.3 0 0 1 2.6 0v3.2"/><path d="M8.6 7.8V3.9a1.3 1.3 0 0 1 2.6 0v3.9"/><path d="M11.2 8V5.4a1.3 1.3 0 0 1 2.6 0v5.2a5 5 0 0 1-5 5H7.6a4 4 0 0 1-3.1-1.5L2.6 11.4a1.4 1.4 0 0 1 2.1-1.8L6 11.2"/>',
  rect: '<rect x="3" y="4" width="12" height="10" rx="1.6"/>',
  ellipse: '<ellipse cx="9" cy="9" rx="6.4" ry="5.2"/>',
  diamond: '<path d="M9 2.6l6.2 6.4L9 15.4 2.8 9z"/>',
  arrow: '<path d="M3 15L14.4 4"/><path d="M9.4 3.4h5.6V9"/>',
  line: '<path d="M3.4 14.6L14.6 3.4"/>',
  freedraw: '<path d="M12.6 2.8l2.2 2.2-8.4 8.4-3.1.9.9-3.1z"/>',
  text: '<path d="M4 4.4h10"/><path d="M9 4.4v11"/>',
  eraser: '<path d="M7.4 14.8H15"/><path d="M9.6 2.9l4.6 4.6-6 6H4.4l-1.6-1.6z"/>',
};

/* ================= 状态 ================= */
let overlay = null;
let canvas = null;
let ctx = null;
let stage = null;
let toolsEl = null;
let propsEl = null;
let textEdit = null;
let hintEl = null;
let draftPanel = null;

let W = 0;
let H = 0;
let dpr = 1;
let view = { x: 0, y: 0, zoom: 1 };
let style = defaultStyle();
let elements = [];
let selected = new Set();
let tool = 'select';
let drag = null;
let editing = null;
let history = [[]];
let hIndex = 0;
let opts = {};
let saving = false;
let spaceDown = false;
let rafId = 0;
let activeDraftId = null;   // 当前画板对应的草稿（null = 新画板）
let savedDrawings = [];
let libraryFilter = 'drafts';
let libraryRequest = 0;
let libraryError = '';
let boardBackground = 'dots';
let toolbarPosition = null;
let toolbarDrag = null;
let returnNav = [];

function setBoardBackground(value) {
  boardBackground = ['dots', 'lines', 'blank'].includes(value) ? value : 'dots';
  overlay.querySelectorAll('[data-board-background]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.boardBackground === boardBackground));
  });
  canvas.dataset.background = boardBackground;
  scheduleDraw();
}

function defaultStyle() {
  return {
    stroke: STROKE_COLORS[0],
    background: 'transparent',
    fillStyle: 'none',
    strokeWidth: WIDTHS[1],
    strokeStyle: 'solid',
  };
}

/* ================= 小工具 ================= */
let idSeq = 0;
const newId = () => `e${Date.now().toString(36)}${(idSeq++).toString(36)}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 确定性随机：同一个 seed 每次重绘抖动完全一样（否则画面会「呼吸」） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashSeed = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

function bounds(el) {
  if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
    const pts = el.points || [[0, 0], [0, 0]];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [px, py] of pts) {
      const ax = el.x + px, ay = el.y + py;
      x1 = Math.min(x1, ax); y1 = Math.min(y1, ay);
      x2 = Math.max(x2, ax); y2 = Math.max(y2, ay);
    }
    return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  }
  return {
    x: Math.min(el.x, el.x + el.w),
    y: Math.min(el.y, el.y + el.h),
    w: Math.abs(el.w),
    h: Math.abs(el.h),
  };
}

/* ---- 旋转（angle 存弧度，绕**未旋转包围盒的中心**转） ----
 * 为什么绕包围盒中心：绘制/命中检测都能复用未旋转的 bounds，不用给每种形状单独维护
 * 一套「旋转后几何」；代价是缩放的锚点要额外补偿（见 onPointerMove 的 resize 分支）。 */

/** 元素中心（世界坐标） */
function centerOf(el) {
  const b = bounds(el);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** 绕 (cx,cy) 旋转一个点/向量 */
function rotatePoint(px, py, cx, cy, ang) {
  const dx = px - cx, dy = py - cy;
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** 旋转后的世界包围盒（导出 PNG 的裁剪框要用它，未旋转 bounds 会把转出头的部分裁掉） */
function elementExtent(el) {
  const b = bounds(el);
  if (!el.angle) return b;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const cs = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]
    .map(([px, py]) => rotatePoint(px, py, cx, cy, el.angle));
  const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
  return {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
  };
}

function dashPattern(el) {
  const w = el.strokeWidth;
  if (el.strokeStyle === 'dashed') return [w * 3.4, w * 2.4];
  if (el.strokeStyle === 'dotted') return [0.6, w * 2.2];
  return [];
}

/* ================= rough 渲染 ================= */
/** 抖动折线（两遍，端点抖动减半，像手画的重描） */
function roughSegment(c, x1, y1, x2, y2, rnd, amp, passes = 2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const steps = clamp(Math.round(len / 34) + 2, 2, 9);
  for (let p = 0; p < passes; p++) {
    c.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const edge = i === 0 || i === steps ? 0.35 : 1;
      const off = (rnd() * 2 - 1) * amp * edge;
      const x = x1 + dx * t + nx * off;
      const y = y1 + dy * t + ny * off;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
}

/** 抖动椭圆：按角度采样，半径做小幅噪声 */
function roughEllipse(c, cx, cy, rx, ry, rnd, amp, passes = 2) {
  const n = clamp(Math.round((rx + ry) / 3), 24, 72);
  for (let p = 0; p < passes; p++) {
    const start = rnd() * Math.PI * 2;
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = start + (i / n) * Math.PI * 2;
      const jr = 1 + ((rnd() * 2 - 1) * amp) / Math.max(rx, ry, 6);
      const x = cx + Math.cos(a) * rx * jr;
      const y = cy + Math.sin(a) * ry * jr;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
}

/** 精确路径（填充 / 命中检测用；手绘抖动只影响描边外观） */
function shapePath(c, el, b = bounds(el)) {
  c.beginPath();
  if (el.type === 'rect' || el.type === 'text') {
    c.rect(b.x, b.y, b.w, b.h);
  } else if (el.type === 'ellipse') {
    c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
  } else if (el.type === 'diamond') {
    c.moveTo(b.x + b.w / 2, b.y);
    c.lineTo(b.x + b.w, b.y + b.h / 2);
    c.lineTo(b.x + b.w / 2, b.y + b.h);
    c.lineTo(b.x, b.y + b.h / 2);
    c.closePath();
  } else if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
    const pts = el.points || [];
    pts.forEach(([px, py], i) => (i ? c.lineTo(el.x + px, el.y + py) : c.moveTo(el.x + px, el.y + py)));
  }
}

function fillElement(c, el, rnd, b) {
  if (!el.background || el.background === 'transparent' || el.fillStyle === 'none') return;
  if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') return;
  c.save();
  shapePath(c, el, b);
  if (el.fillStyle === 'solid') {
    c.fillStyle = el.background;
    c.fill();
    c.restore();
    return;
  }
  // 排线：裁剪到形状内部，再斜着扫线（两条方向 = 交叉网）
  c.clip();
  c.strokeStyle = el.background;
  c.lineWidth = Math.max(1, el.strokeWidth * 0.7);
  c.globalAlpha = 0.95;
  const gap = clamp(12 - el.strokeWidth, 6, 14);
  const { x, y, w, h } = b;
  for (let d = -h; d < w + h; d += gap) {
    c.beginPath();
    c.moveTo(x + d, y);
    c.lineTo(x + d + h, y + h);
    c.stroke();
  }
  c.restore();
}

function drawText(c, el) {
  const size = el.fontSize || 20;
  c.save();
  c.fillStyle = el.stroke;
  c.textBaseline = 'top';
  c.font = `${size}px ${FONT}`;
  const lines = String(el.text || '').split('\n');
  const lh = size * 1.32;
  lines.forEach((line, i) => c.fillText(line, el.x, el.y + i * lh));
  c.restore();
}

function drawElement(c, el) {
  c.save();
  // 旋转统一在这里处理：把画布绕元素中心转一下，后面所有形状照常用「未旋转」几何画。
  // 文字也走这条（drawText 自己还有一层 save/restore，不冲突）。
  if (el.angle) {
    const ctr = centerOf(el);
    c.translate(ctr.x, ctr.y);
    c.rotate(el.angle);
    c.translate(-ctr.x, -ctr.y);
  }
  if (el.type === 'text') { drawText(c, el); c.restore(); return; }
  const b = bounds(el);
  const amp = clamp(el.strokeWidth * 0.9, 1, 4);
  const rnd = mulberry32(el.seed || hashSeed(el.id));
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = el.stroke;
  c.lineWidth = el.strokeWidth;
  c.setLineDash(dashPattern(el));

  fillElement(c, el, rnd, b);

  if (el.type === 'rect') {
    roughSegment(c, b.x, b.y, b.x + b.w, b.y, rnd, amp);
    roughSegment(c, b.x + b.w, b.y, b.x + b.w, b.y + b.h, rnd, amp);
    roughSegment(c, b.x + b.w, b.y + b.h, b.x, b.y + b.h, rnd, amp);
    roughSegment(c, b.x, b.y + b.h, b.x, b.y, rnd, amp);
  } else if (el.type === 'ellipse') {
    roughEllipse(c, b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, rnd, amp);
  } else if (el.type === 'diamond') {
    roughSegment(c, b.x + b.w / 2, b.y, b.x + b.w, b.y + b.h / 2, rnd, amp);
    roughSegment(c, b.x + b.w, b.y + b.h / 2, b.x + b.w / 2, b.y + b.h, rnd, amp);
    roughSegment(c, b.x + b.w / 2, b.y + b.h, b.x, b.y + b.h / 2, rnd, amp);
    roughSegment(c, b.x, b.y + b.h / 2, b.x + b.w / 2, b.y, rnd, amp);
  } else if (el.type === 'line' || el.type === 'arrow') {
    const pts = el.points || [];
    // 中间点软化：先按折线走，端点/顶点处再描一遍，像 Excalidraw 的多段线
    const abs = pts.map(([px, py]) => [el.x + px, el.y + py]);
    for (let i = 1; i < abs.length; i++) {
      roughSegment(c, abs[i - 1][0], abs[i - 1][1], abs[i][0], abs[i][1], rnd, amp);
    }
    if (el.type === 'arrow' && abs.length >= 2) {
      const [x1, y1] = abs[abs.length - 2];
      const [x2, y2] = abs[abs.length - 1];
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = clamp(10 + el.strokeWidth * 2.2, 12, 24);
      for (const s of [-1, 1]) {
        const a = ang + Math.PI + s * 0.42;
        roughSegment(c, x2, y2, x2 + Math.cos(a) * head, y2 + Math.sin(a) * head, rnd, amp * 0.7, 1);
      }
    }
  } else if (el.type === 'freedraw') {
    const pts = el.points || [];
    if (pts.length) {
      c.beginPath();
      c.moveTo(el.x + pts[0][0], el.y + pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (el.x + pts[i][0] + el.x + pts[i + 1][0]) / 2;
        const my = (el.y + pts[i][1] + el.y + pts[i + 1][1]) / 2;
        c.quadraticCurveTo(el.x + pts[i][0], el.y + pts[i][1], mx, my);
      }
      const last = pts[pts.length - 1];
      c.lineTo(el.x + last[0], el.y + last[1]);
      c.stroke();
    }
  }
  c.restore();
}

/* ================= 画布 ================= */
function resizeCanvas() {
  if (!canvas || !stage) return;
  W = Math.max(1, stage.clientWidth);
  H = Math.max(1, stage.clientHeight);
  dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  scheduleDraw();
}

function screenToWorld(px, py) {
  return { x: px / view.zoom + view.x, y: py / view.zoom + view.y };
}
function worldToScreen(wx, wy) {
  return { x: (wx - view.x) * view.zoom, y: (wy - view.y) * view.zoom };
}
function localPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top };
}

function scheduleDraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
}

function draw() {
  if (!ctx) return;
  const z = dpr * view.zoom;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(z, 0, 0, z, -dpr * view.zoom * view.x, -dpr * view.zoom * view.y);
  drawGrid();
  for (const el of elements) drawElement(ctx, el);
  // 选中框 / 缩放柄画在屏幕坐标系，不随缩放变粗
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (drag?.mode === 'marquee') {
    const a = worldToScreen(drag.start.x, drag.start.y), b = worldToScreen(drag.cur.x, drag.cur.y);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
    ctx.save(); ctx.fillStyle = 'rgba(105,101,219,.12)'; ctx.strokeStyle = '#6965db'; ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x + .5, y + .5, w, h); ctx.restore();
  }
  drawSelection();
  canvas.dataset.strokes = String(elements.length);
  canvas.dataset.selected = String(selected.size);
  // 供测试/调试读取：单选元素的旋转角（度）。画布上没有可视化的角度输入框，
  // 断言只能从这里拿（与 dataset.strokes/selected 同一套口径）。
  const selOne = selected.size === 1 ? elements.find((e) => selected.has(e.id)) : null;
  canvas.dataset.selectedAngle = selOne ? String(Math.round((selOne.angle || 0) * 180 / Math.PI)) : '';
}

function drawGrid() {
  // 点阵画在屏幕坐标系里（点大小不随缩放变化，跟 Excalidraw 一样）；
  // 缩得太小时直接不画——否则 24px 一格会变成几万个点，拖一下卡一下。
  const step = 24 * view.zoom;
  if (boardBackground === 'blank' || step < 10) return;
  const offX = -(((view.x * view.zoom) % step) + step) % step;
  const offY = -(((view.y * view.zoom) % step) + step) % step;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.085)';
  ctx.strokeStyle = 'rgba(0,0,0,0.085)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (boardBackground === 'lines') {
    for (let x = offX; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = offY; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.restore();
    return;
  }
  for (let x = offX; x < W; x += step) {
    for (let y = offY; y < H; y += step) {
      ctx.moveTo(x + 1, y);
      ctx.arc(x, y, 1, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.restore();
}

/** 四角缩放柄（屏幕坐标）。ang ≠ 0 时按元素中心把四个角一起转过去 */
function handleRects(b, ang = 0) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const s = 8;
  const corners = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], se: [b.x + b.w, b.y + b.h], sw: [b.x, b.y + b.h] };
  return Object.entries(corners).map(([k, [wx, wy]]) => {
    const r = rotatePoint(wx, wy, cx, cy, ang);
    const p = worldToScreen(r.x, r.y);
    return { k, x: p.x - s / 2, y: p.y - s / 2, cx: p.x, cy: p.y, size: s };
  });
}

/** 旋转柄位置（屏幕坐标）：从顶边中点沿元素「本地朝上」方向再外推 ROTATE_OFFSET。
 *  用本地朝上的方向（而不是「中心→顶边中点」）是因为细长/接近水平的图形两者几乎重合，
 *  方向向量会退化。 */
function rotateHandlePos(b, ang = 0) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const topMid = rotatePoint(cx, cy - b.h / 2, cx, cy, ang);
  const p = worldToScreen(topMid.x, topMid.y);
  const up = { x: Math.sin(ang), y: -Math.cos(ang) };   // 本地 (0,-1) 旋转 ang 后的方向
  const len = Math.hypot(up.x, up.y) || 1;
  return { x: p.x + (up.x / len) * ROTATE_OFFSET, y: p.y + (up.y / len) * ROTATE_OFFSET };
}

function drawSelection() {
  if (!selected.size) return;
  const boxes = [...selected].map((id) => elements.find((e) => e.id === id)).filter(Boolean).map(bounds);
  if (!boxes.length) return;
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  const b = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  const single = selected.size === 1 ? elements.find((e) => selected.has(e.id)) : null;
  const ang = single?.angle || 0;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  // 外扩 6px 在**世界**坐标里做（≈屏幕上 6px，缩放后依然恒等），旋转后仍是贴着形状的框
  const pad = 6 / view.zoom;
  const outline = [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad],
    [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]]
    .map(([px, py]) => { const r = rotatePoint(px, py, cx, cy, ang); return worldToScreen(r.x, r.y); });
  ctx.save();
  ctx.strokeStyle = '#6965db';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([]);
  ctx.beginPath();
  outline.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  if (single) {
    for (const h of handleRects(b, ang)) {
      ctx.beginPath();
      ctx.rect(h.x, h.y, h.size, h.size);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
    }
    // 旋转柄（圆形）：点住拖动 = 绕中心旋转；Shift 吸附 15°
    const rh = rotateHandlePos(b, ang);
    ctx.beginPath();
    ctx.arc(rh.x, rh.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/* ================= 命中检测 ================= */
function pointIn(el, wx, wy, tol = 6) {
  // 命中检测在「未旋转」坐标系里做：把指针反向转回元素本地，后面所有形状判定都不用改
  if (el.angle) {
    const ctr = centerOf(el);
    const p = rotatePoint(wx, wy, ctr.x, ctr.y, -el.angle);
    wx = p.x;
    wy = p.y;
  }
  const b = bounds(el);
  const pad = tol + el.strokeWidth;
  if (wx < b.x - pad || wx > b.x + b.w + pad || wy < b.y - pad || wy > b.y + b.h + pad) return false;
  if (el.type === 'freedraw') {
    const pts = el.points || [];
    for (let i = 1; i < pts.length; i++) {
      const ax = el.x + pts[i - 1][0], ay = el.y + pts[i - 1][1];
      const bx = el.x + pts[i][0], by = el.y + pts[i][1];
      if (distToSegment(wx, wy, ax, ay, bx, by) <= tol + el.strokeWidth) return true;
    }
    return false;
  }
  const saved = ctx.getTransform();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  shapePath(ctx, el, b);
  let hit = el.type === 'text' ? true : ctx.isPointInPath(wx, wy);
  if (!hit && el.type !== 'text') {
    ctx.lineWidth = Math.max(el.strokeWidth, 2) + tol * 2;
    hit = ctx.isPointInStroke(wx, wy);
  }
  ctx.restore();
  ctx.setTransform(saved);
  return hit;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitTest(wx, wy) {
  for (let i = elements.length - 1; i >= 0; i--) {
    if (pointIn(elements[i], wx, wy)) return elements[i];
  }
  return null;
}

function hitsInRect(b) {
  return elements.filter((el) => {
    const e = bounds(el);
    return e.x + e.w >= b.x && e.x <= b.x + b.w && e.y + e.h >= b.y && e.y <= b.y + b.h;
  });
}

/* ================= 历史 ================= */
const clone = (list) => JSON.parse(JSON.stringify(list));

function snapshot() {
  const json = JSON.stringify(elements);
  if (history[hIndex] && JSON.stringify(history[hIndex]) === json) { updateHistoryButtons(); return; }
  history = history.slice(0, hIndex + 1);
  history.push(clone(elements));
  hIndex = history.length - 1;
  if (history.length > 120) { history.shift(); hIndex -= 1; }
  updateHistoryButtons();
}

function jumpTo(i) {
  if (i < 0 || i >= history.length) return;
  hIndex = i;
  elements = clone(history[i]);
  selected.clear();
  editing = null;
  scheduleDraw();
  updateHistoryButtons();
}

function undo() { if (hIndex > 0) jumpTo(hIndex - 1); }
function redo() { if (hIndex < history.length - 1) jumpTo(hIndex + 1); }

function updateHistoryButtons() {
  if (!overlay) return;
  const u = overlay.querySelector('#draw-undo');
  const r = overlay.querySelector('#draw-redo');
  const c = overlay.querySelector('#draw-clear');
  if (u) u.disabled = hIndex <= 0;
  if (r) r.disabled = hIndex >= history.length - 1;
  if (c) c.disabled = elements.length === 0;
}

/* ================= 创建元素 ================= */
function baseEl(type, x, y) {
  return {
    id: newId(),
    type,
    x,
    y,
    w: 0,
    h: 0,
    points: [],
    text: '',
    fontSize: 20,
    angle: 0,    // 旋转角（弧度，绕未旋转包围盒中心）
    stroke: style.stroke,
    background: style.background,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    seed: Math.floor(Math.random() * 2 ** 31),
  };
}

function styleForSelected() {
  // 选中状态下改样式：直接改选中的元素（Excalidraw 的手感）
  for (const el of elements) {
    if (!selected.has(el.id)) continue;
    el.stroke = style.stroke;
    el.background = style.background;
    el.fillStyle = style.fillStyle;
    el.strokeWidth = style.strokeWidth;
    el.strokeStyle = style.strokeStyle;
  }
  if (selected.size) { snapshot(); scheduleDraw(); }
}

/* ================= 指针交互 ================= */
function onPointerDown(e) {
  if (e.button === 1 || (spaceDown && e.button === 0)) {
    canvas.setPointerCapture(e.pointerId);
    drag = { mode: 'pan', startPx: e.clientX, startPy: e.clientY, view: { ...view } };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  const { px, py } = localPoint(e);
  const w = screenToWorld(px, py);
  canvas.setPointerCapture(e.pointerId);

  if (tool === 'hand') {
    drag = { mode: 'pan', startPx: e.clientX, startPy: e.clientY, view: { ...view } };
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (tool === 'select') {
    // 先判断旋转柄 / 缩放柄
    if (selected.size === 1) {
      const el = elements.find((x) => selected.has(x.id));
      if (el) {
        const b = bounds(el);
        const ang = el.angle || 0;
        const rh = rotateHandlePos(b, ang);
        if (Math.hypot(px - rh.x, py - rh.y) <= 9) {
          drag = { mode: 'rotate', id: el.id };
          canvas.style.cursor = 'grabbing';
          return;
        }
        for (const h of handleRects(b, ang)) {
          if (Math.abs(px - h.cx) <= 7 && Math.abs(py - h.cy) <= 7) {
            drag = { mode: 'resize', k: h.k, id: el.id, orig: clone([el])[0], b: { ...b } };
            return;
          }
        }
      }
    }
    const hit = hitTest(w.x, w.y);
    if (hit) {
      if (e.shiftKey) {
        if (selected.has(hit.id)) selected.delete(hit.id); else selected.add(hit.id);
      } else if (!selected.has(hit.id)) {
        selected = new Set([hit.id]);
      }
      adoptSelectionStyle();
      const chosen = elements.filter((el) => selected.has(el.id));
      drag = {
        mode: 'move',
        start: w,
        orig: clone(chosen),
        moved: false,
      };
      scheduleDraw();
      return;
    }
    // 空白：框选
    selected.clear();
    drag = { mode: 'marquee', start: w, cur: w };
    scheduleDraw();
    return;
  }

  if (tool === 'eraser') {
    const hit = hitTest(w.x, w.y);
    if (hit) {
      elements = elements.filter((el) => el !== hit);
      selected.delete(hit.id);
      snapshot();
      scheduleDraw();
    }
    drag = { mode: 'erase' };
    return;
  }

  if (tool === 'text') {
    commitText();
    const el = baseEl('text', w.x, w.y);
    el.text = '';
    el.stroke = style.stroke;
    elements.push(el);
    selected = new Set([el.id]);
    // 注意：这里不 snapshot —— 此刻文字还是空的，落进历史的话「撤销」会把
    // 刚打的字一路撤没（历史里存的是空文本）。等 commitText() 再存。
    openTextEditor(el, true);
    return;
  }

  // 形状 / 线 / 手绘
  const el = baseEl(tool, w.x, w.y);
  if (tool === 'freedraw') {
    el.points = [[0, 0]];
  } else {
    el.points = [[0, 0], [0, 0]];
  }
  elements.push(el);
  drag = { mode: 'create', id: el.id, start: w, el };
  scheduleDraw();
}

function onPointerMove(e) {
  if (!drag) return;
  const { px, py } = localPoint(e);
  const w = screenToWorld(px, py);

  if (drag.mode === 'pan') {
    view.x = drag.view.x - (e.clientX - drag.startPx) / view.zoom;
    view.y = drag.view.y - (e.clientY - drag.startPy) / view.zoom;
    scheduleDraw();
    return;
  }

  if (drag.mode === 'erase') {
    const hit = hitTest(w.x, w.y);
    if (hit) {
      elements = elements.filter((el) => el !== hit);
      selected.delete(hit.id);
      scheduleDraw();
    }
    return;
  }

  if (drag.mode === 'marquee') {
    drag.cur = w;
    const b = {
      x: Math.min(drag.start.x, w.x),
      y: Math.min(drag.start.y, w.y),
      w: Math.abs(w.x - drag.start.x),
      h: Math.abs(w.y - drag.start.y),
    };
    selected = new Set(hitsInRect(b).map((el) => el.id));
    scheduleDraw();
    return;
  }

  if (drag.mode === 'create') {
    const el = drag.el;
    let dx = w.x - drag.start.x;
    let dy = w.y - drag.start.y;
    if (e.shiftKey && el.type !== 'freedraw') {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * m;
    }
    if (el.type === 'freedraw') {
      const last = el.points[el.points.length - 1];
      const nx = w.x - el.x;
      const ny = w.y - el.y;
      if (Math.hypot(nx - last[0], ny - last[1]) > 1.6) el.points.push([nx, ny]);
    } else if (el.type === 'line' || el.type === 'arrow') {
      el.points = [[0, 0], [dx, dy]];
      el.w = dx;
      el.h = dy;
    } else {
      el.w = dx;
      el.h = dy;
    }
    scheduleDraw();
    return;
  }

  if (drag.mode === 'move') {
    const dx = w.x - drag.start.x;
    const dy = w.y - drag.start.y;
    drag.moved = drag.moved || Math.hypot(dx, dy) > 1;
    for (const orig of drag.orig) {
      const el = elements.find((x) => x.id === orig.id);
      if (el) { el.x = orig.x + dx; el.y = orig.y + dy; }
    }
    scheduleDraw();
    return;
  }

  if (drag.mode === 'rotate') {
    const el = elements.find((x) => x.id === drag.id);
    if (!el) return;
    const ctr = centerOf(el);
    // 「指针朝正上方 = 0°」：旋转柄初始就在中心正上方，所以加 π/2 补偿
    let a = Math.atan2(w.y - ctr.y, w.x - ctr.x) + Math.PI / 2;
    if (e.shiftKey) a = Math.round(a / ROTATE_SNAP) * ROTATE_SNAP;   // 15° 吸附
    el.angle = a;
    scheduleDraw();
    return;
  }

  if (drag.mode === 'resize') {
    const el = elements.find((x) => x.id === drag.id);
    if (!el) return;
    const o = drag.orig;
    const b = drag.b;                       // 拖拽起点的**未旋转**包围盒
    const ang = o.angle || 0;
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    // 指针换算到元素「未旋转」的本地坐标：于是下面就是原样的轴对齐缩放
    const lp = rotatePoint(w.x, w.y, c.x, c.y, -ang);
    // 与拖动角对角的那一个角（本地坐标）：缩放时它在世界里必须钉住不动
    const A = {
      nw: { x: b.x + b.w, y: b.y + b.h },
      ne: { x: b.x, y: b.y + b.h },
      se: { x: b.x, y: b.y },
      sw: { x: b.x + b.w, y: b.y },
    }[drag.k];
    const ap = rotatePoint(A.x, A.y, c.x, c.y, ang);   // 锚点的世界坐标
    const dx = lp.x - A.x;
    const dy = lp.y - A.y;
    let nw = Math.abs(dx);
    let nh = Math.abs(dy);
    let nx = Math.min(A.x, A.x + dx);
    let ny = Math.min(A.y, A.y + dy);
    if (nw < MIN_SIZE) { nw = MIN_SIZE; nx = dx < 0 ? A.x - MIN_SIZE : A.x; }
    if (nh < MIN_SIZE) { nh = MIN_SIZE; ny = dy < 0 ? A.y - MIN_SIZE : A.y; }
    // 旋转中心从 c 挪到新中心后，锚点的世界位置会跟着漂移；把它平移回去。
    // 因为「中心与点同时平移 s」会让旋转结果也平移 s，所以一次补偿即精确（无需迭代）。
    const nc = { x: nx + nw / 2, y: ny + nh / 2 };
    const drift = rotatePoint(A.x, A.y, nc.x, nc.y, ang);
    const shiftX = ap.x - drift.x;
    const shiftY = ap.y - drift.y;
    if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
      const sx = nw / (b.w || 1);
      const sy = nh / (b.h || 1);
      el.points = o.points.map(([px, py]) => [px * sx, py * sy]);
      el.x = nx;
      el.y = ny;
      el.w = nw;
      el.h = nh;
    } else {
      el.x = nx; el.y = ny; el.w = nw; el.h = nh;
      if (el.type === 'text') el.fontSize = Math.max(10, Math.round(o.fontSize * (nh / (b.h || 1))));
    }
    el.x += shiftX;
    el.y += shiftY;
    scheduleDraw();
  }
}

function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.style.cursor = cursorFor(tool);

  if (d.mode === 'create') {
    const el = d.el;
    const b = bounds(el);
    if (el.type === 'freedraw') {
      if ((el.points || []).length < 2) {
        elements = elements.filter((x) => x !== el);
      } else {
        // 归一化到包围盒原点，方便后续缩放
        const ox = b.x, oy = b.y;
        el.points = el.points.map(([px, py]) => [px + el.x - ox, py + el.y - oy]);
        el.x = ox;
        el.y = oy;
        el.w = b.w;
        el.h = b.h;
        snapshot();
      }
    } else if (el.type === 'line' || el.type === 'arrow') {
      if (Math.hypot(el.points[1][0], el.points[1][1]) < 4) elements = elements.filter((x) => x !== el);
      else snapshot();
    } else {
      if (b.w < MIN_SIZE || b.h < MIN_SIZE) {
        elements = elements.filter((x) => x !== el);
      } else {
        el.x = b.x; el.y = b.y; el.w = b.w; el.h = b.h;
        if (el.type === 'text') measureText(el);
        snapshot();
      }
    }
    // 画完回到选择工具，直接能调（Excalidraw 默认 lock=off 的手感）。
    // 画笔例外：一笔画完还留着画笔，才能连续画第二笔。
    if (elements.includes(el)) {
      if (el.type === 'freedraw') {
        selected.clear();
      } else {
        selected = new Set([el.id]);
        setTool('select', { keepSelection: true });
      }
    } else {
      selected.clear();
    }
    commitText();
    scheduleDraw();
    return;
  }

  if (d.mode === 'move' && d.moved) snapshot();
  if (d.mode === 'resize') snapshot();
  if (d.mode === 'rotate') snapshot();
  if (d.mode === 'erase') snapshot();
  if (d.mode === 'marquee') {
    drag = null;
    scheduleDraw();
    return;
  }
  scheduleDraw();
}

function onPointerCancel() {
  drag = null;
  canvas.style.cursor = cursorFor(tool);
}

function cursorFor(t) {
  if (t === 'select') return 'default';
  if (t === 'hand') return 'grab';
  if (t === 'text') return 'text';
  if (t === 'eraser') return 'cell';
  return 'crosshair';
}

function onWheel(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const { px, py } = localPoint(e);
    const before = screenToWorld(px, py);
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    view.zoom = clamp(view.zoom * factor, 0.2, 4);
    const after = screenToWorld(px, py);
    view.x += before.x - after.x;
    view.y += before.y - after.y;
  } else {
    e.preventDefault();
    view.x += (e.shiftKey ? e.deltaY : e.deltaX) / view.zoom;
    view.y += (e.shiftKey ? 0 : e.deltaY) / view.zoom;
  }
  updateZoomLabel();
  scheduleDraw();
}

/* ================= 文字编辑 ================= */
function measureText(el) {
  const size = el.fontSize || 20;
  const saved = ctx.font;
  ctx.font = `${size}px ${FONT}`;
  const lines = String(el.text || '').split('\n');
  el.w = Math.max(8, ...lines.map((l) => ctx.measureText(l).width));
  el.h = Math.max(size, lines.length * size * 1.32);
  ctx.font = saved;
}

function openTextEditor(el, isNew) {
  editing = { id: el.id, isNew: !!isNew };
  const p = worldToScreen(el.x, el.y);
  const size = (el.fontSize || 20) * view.zoom;
  textEdit.hidden = false;
  textEdit.style.left = `${p.x - 2}px`;
  textEdit.style.top = `${p.y - 3}px`;
  textEdit.style.fontSize = `${size}px`;
  textEdit.style.lineHeight = '1.32';
  textEdit.style.color = el.stroke;
  textEdit.value = el.text || '';
  textEdit.dataset.id = el.id;
  setTimeout(() => {
    textEdit.focus();
    textEdit.setSelectionRange(textEdit.value.length, textEdit.value.length);
    autoSizeTextEdit();
  }, 0);
}

function autoSizeTextEdit() {
  textEdit.style.width = '2px';
  textEdit.style.height = '2px';
  textEdit.style.width = `${Math.max(40, textEdit.scrollWidth + 6)}px`;
  textEdit.style.height = `${Math.max(24, textEdit.scrollHeight + 2)}px`;
}

function commitText() {
  if (!editing) return;
  const el = elements.find((x) => x.id === editing.id);
  const value = textEdit.value;
  textEdit.hidden = true;
  editing = null;
  if (!el) return;
  const hadText = String(el.text || '').trim().length > 0;
  el.text = value;
  if (!value.trim()) {
    elements = elements.filter((x) => x !== el);
    selected.delete(el.id);
    if (hadText) snapshot();     // 清空旧文字 = 删除，要能撤销
  } else {
    measureText(el);
    snapshot();                  // 文字定稿才入历史（新建/编辑都走这里）
    selected = new Set([el.id]);
  }
  scheduleDraw();
}

function editSelectedText() {
  if (selected.size !== 1) return;
  const el = elements.find((x) => selected.has(x.id));
  if (el && el.type === 'text') openTextEditor(el, false);
}

/* ================= 键盘 ================= */
function onKey(e) {
  if (!overlay || overlay.hidden) return;
  if (document.querySelector('#settings:not([hidden]), #palette:not([hidden]), .dialog-backdrop, .phone-access:not([hidden]), .context-menu')) return;
  if (e.target !== textEdit && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (editing) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); textEdit.blur(); }
    return;    // 文字编辑时把按键都留给 textarea
  }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if (selected.size) { selected.clear(); scheduleDraw(); } else close();
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopPropagation(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault(); e.stopPropagation();
    selected = new Set(elements.map((el) => el.id));
    scheduleDraw();
    return;
  }
  if (mod) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!selected.size) return;
    e.preventDefault(); e.stopPropagation();
    elements = elements.filter((el) => !selected.has(el.id));
    selected.clear();
    snapshot();
    scheduleDraw();
    return;
  }
  if (e.key === ' ') { spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (k === 'enter' && selected.size === 1) { e.preventDefault(); editSelectedText(); return; }
  const t = TOOLS.find(([, , key]) => key.toLowerCase() === k);
  if (t) { e.preventDefault(); e.stopPropagation(); setTool(t[0]); }
}

function onKeyUp(e) {
  if (e.key === ' ') {
    spaceDown = false;
    if (canvas) canvas.style.cursor = cursorFor(tool);
  }
}

/* ================= 工具栏 ================= */
function setTool(t, { keepSelection = false } = {}) {
  tool = t;
  if (!keepSelection && t !== 'select') selected.clear();
  if (toolsEl) toolsEl.querySelectorAll('.draw-tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  if (canvas) canvas.style.cursor = cursorFor(t);
  // 抓手/橡皮只置灰图形样式，画板背景仍可切换。
  propsEl?.querySelector('.draw-element-style').classList.toggle('disabled', t === 'hand' || t === 'eraser');
  scheduleDraw();
}

/** 选中图形后，属性面板跟着显示这个图形的样式（Excalidraw 手感） */
function adoptSelectionStyle() {
  const el = elements.find((x) => selected.has(x.id));
  if (!el || el.type === 'freedraw') return;
  style = {
    ...style,
    stroke: el.stroke,
    background: el.background,
    fillStyle: el.fillStyle,
    strokeWidth: el.strokeWidth,
    strokeStyle: el.strokeStyle,
  };
  syncStyleUI();
}

function applyStyle(patch, { fromSelection = true } = {}) {
  style = { ...style, ...patch };
  syncStyleUI();
  if (fromSelection && selected.size) styleForSelected();
}

function syncStyleUI() {
  if (!propsEl) return;
  propsEl.querySelectorAll('.draw-swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === style.stroke));
  propsEl.querySelectorAll('.draw-bg').forEach((b) => b.classList.toggle('active', b.dataset.color === style.background));
  propsEl.querySelectorAll('.draw-fill').forEach((b) => b.classList.toggle('active', b.dataset.fill === style.fillStyle));
  propsEl.querySelectorAll('.draw-size').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === style.strokeWidth));
  propsEl.querySelectorAll('.draw-dash').forEach((b) => b.classList.toggle('active', b.dataset.dash === style.strokeStyle));
  const bg = propsEl.querySelector('.draw-bg-none');
  if (bg) bg.classList.toggle('active', style.background === 'transparent');
  propsEl.querySelectorAll('.draw-color-group').forEach(group => {
    const color = normalizeColor(style[group.dataset.colorKind]);
    group.querySelector('.draw-color-picker').value = color || '#ffffff';
    const hex = group.querySelector('.draw-color-hex');
    if (document.activeElement !== hex) hex.value = color?.toUpperCase() || '';
  });
}

function updateZoomLabel() {
  const el = overlay?.querySelector('#draw-zoom-val');
  if (el) el.textContent = `${Math.round(view.zoom * 100)}%`;
}

function zoomBy(factor) {
  const cx = W / 2;
  const cy = H / 2;
  const before = screenToWorld(cx, cy);
  view.zoom = clamp(view.zoom * factor, 0.2, 4);
  const after = screenToWorld(cx, cy);
  view.x += before.x - after.x;
  view.y += before.y - after.y;
  updateZoomLabel();
  scheduleDraw();
}

function resetView() {
  view = { x: 0, y: 0, zoom: 1 };
  updateZoomLabel();
  scheduleDraw();
}

/** 默认与侧栏开关齐平；拖动后始终约束在画板内，缩窄窗口也能抓回手柄。 */
function layoutToolbar() {
  if (!toolsEl || overlay.hidden || !toolsEl.offsetWidth) return;
  const compact = matchMedia('(max-width: 900px)').matches;
  const left = compact ? 12 : overlay.querySelector('.draw-mobile-switches').offsetLeft + overlay.querySelector('.draw-mobile-switches').offsetWidth + 12;
  const right = compact ? overlay.clientWidth - 12 : overlay.querySelector('.draw-top').offsetLeft - 12;
  toolsEl.style.maxWidth = `${Math.max(48, toolbarPosition ? overlay.clientWidth - 24 : right - left)}px`;
  const width = toolsEl.offsetWidth, height = toolsEl.offsetHeight;
  const x = clamp(toolbarPosition?.x ?? (left + (right - left - width) / 2), 12, Math.max(12, overlay.clientWidth - width - 12));
  const y = clamp(toolbarPosition?.y ?? (compact ? 120 : 12), 12, Math.max(12, overlay.clientHeight - height - 12));
  toolsEl.style.transform = 'none';
  toolsEl.style.left = `${x}px`;
  toolsEl.style.top = `${y}px`;
  if (toolbarPosition) toolbarPosition = { x, y };
}

function enableToolbarDrag() {
  const handle = toolsEl.querySelector('.draw-tools-handle');
  toolsEl.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target !== toolsEl && !handle.contains(event.target))) return;
    event.preventDefault();
    toolbarPosition = { x: toolsEl.offsetLeft, y: toolsEl.offsetTop };
    layoutToolbar();
    const capture = handle.contains(event.target) ? handle : toolsEl;
    toolbarDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, capture, ...toolbarPosition };
    capture.setPointerCapture(event.pointerId);
    toolsEl.classList.add('dragging');
  });
  toolsEl.addEventListener('pointermove', event => {
    if (toolbarDrag?.pointerId !== event.pointerId) return;
    toolbarPosition = { x: toolbarDrag.x + event.clientX - toolbarDrag.startX, y: toolbarDrag.y + event.clientY - toolbarDrag.startY };
    layoutToolbar();
  });
  const endDrag = event => {
    if (toolbarDrag?.pointerId !== event.pointerId) return;
    const capture = toolbarDrag.capture;
    toolbarDrag = null;
    toolsEl.classList.remove('dragging');
    if (capture.hasPointerCapture(event.pointerId)) capture.releasePointerCapture(event.pointerId);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) toolsEl.addEventListener(type, endDrag);
  handle.ondblclick = () => { toolbarPosition = null; layoutToolbar(); };
  handle.onkeydown = event => {
    const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    toolbarPosition = { x: toolsEl.offsetLeft + delta[0], y: toolsEl.offsetTop + delta[1] };
    layoutToolbar();
  };
}

function syncWorkspaceBounds() {
  if (!overlay || overlay.hidden) return;
  const title = document.querySelector('.titlebar')?.getBoundingClientRect();
  const nav = document.querySelector('.ribbon')?.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(overlay).getPropertyValue('--draw-gap')) || 0;
  const top = Math.max(0, title?.bottom || 0) + gap;
  overlay.style.top = `${top}px`;
  overlay.style.setProperty('--draw-top', `${top}px`);
  overlay.style.left = `${(nav && nav.width > 0 ? Math.max(0, nav.right) : 0) + gap}px`;
  resizeCanvas();
  layoutToolbar();
}

function ensure() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'draw-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <header class="draw-top">
      <div class="draw-brand">
        <span class="draw-brand-dot"></span>
        <span>绘图</span>
      </div>
      <div class="draw-zoom">
        <button id="draw-zoom-out" title="缩小 (Ctrl+滚轮)">−</button>
        <button id="draw-zoom-val" title="恢复 100%" class="draw-zoom-val">100%</button>
        <button id="draw-zoom-in" title="放大 (Ctrl+滚轮)">+</button>
      </div>
      <div class="draw-actions">
        <button id="draw-stash" class="btn-ghost" title="把当前画板暂存为草稿（不插入笔记）；从草稿箱重开的画板会覆盖该草稿">暂存</button>
        <button id="draw-cancel" class="btn-ghost">取消</button>
        <button id="draw-save" class="btn-primary">插入笔记</button>
      </div>
    </header>
    <div class="draw-mobile-switches"><button id="draw-toggle-library" aria-expanded="false">图片库</button><button id="draw-toggle-props" aria-expanded="false">颜色与样式</button></div>
    <button id="draw-toggle-ui" class="draw-toggle-ui" title="收起功能区" aria-label="收起功能区" aria-expanded="true">⌃</button>
    <div class="draw-stage">
      <canvas id="draw-canvas"></canvas>
      <div class="draw-tools">
        <button class="draw-tools-handle" aria-label="拖动工具栏" title="拖动工具栏（双击复位，方向键微调）">⠿</button>
        ${TOOLS.map(([t, label, key]) => `
          <button class="draw-tool${t === 'select' ? ' active' : ''}" data-tool="${t}" title="${label} (${key})" aria-label="${label}">
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round">${TOOL_ICONS[t]}</svg>
          </button>`).join('')}
        <div class="draw-tool-sep"></div>
        <button id="draw-undo" class="draw-tool" title="撤销 (Ctrl+Z)">
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 5L3 8.4l3.4 3.4"/><path d="M3 8.4h7a3.6 3.6 0 0 1 0 7.2h-2"/></svg>
        </button>
        <button id="draw-redo" class="draw-tool" title="重做 (Ctrl+Shift+Z)">
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.6 5L15 8.4l-3.4 3.4"/><path d="M15 8.4H8a3.6 3.6 0 0 0 0 7.2h2"/></svg>
        </button>
        <button id="draw-clear" class="draw-tool" title="清空画布">
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 5.4h11.6M7 5.4V3.8h4v1.6M4.8 5.4l.7 9.4h7l.7-9.4"/></svg>
        </button>
      </div>
      <aside class="draw-props">
        <div class="draw-side-title">样式<button id="draw-close-props" aria-label="收起样式">×</button></div>
        <div class="draw-board-background">
          <div class="dp-label">画板背景</div>
          <div class="dp-row" role="group" aria-label="画板背景">
            <button data-board-background="dots" aria-pressed="true">点阵</button>
            <button data-board-background="lines" aria-pressed="false">网格线</button>
            <button data-board-background="blank" aria-pressed="false">空白</button>
          </div>
        </div>
        <div class="draw-element-style">
        ${colorControls('stroke', STROKE_COLORS)}
        ${colorControls('background', BG_COLORS)}
        <div class="dp-group">
          <div class="dp-label">填充</div>
          <div class="dp-row">
            ${FILLS.map(([v, n]) => `<button class="draw-fill" data-fill="${v}" title="填充：${n}">${n}</button>`).join('')}
          </div>
        </div>
        <div class="dp-group">
          <div class="dp-label">线宽</div>
          <div class="dp-row">
            ${WIDTHS.map((w, i) => `<button class="draw-size${i === 1 ? ' active' : ''}" data-size="${w}" title="线宽 ${w}"><span style="width:${w + 3}px;height:${w + 3}px"></span></button>`).join('')}
          </div>
        </div>
        <div class="dp-group">
          <div class="dp-label">线型</div>
          <div class="dp-row">
            ${DASHES.map(([v, n]) => `<button class="draw-dash" data-dash="${v}" title="线型：${n}"><span class="dash-${v}"></span></button>`).join('')}
          </div>
        </div>
        </div>
      </aside>
      <div class="draw-hint" id="draw-hint">拖拽画形状 · 空格拖动画布 · Ctrl+滚轮缩放 · Delete 删除 · Esc 取消</div>
      <aside class="draw-drafts" id="draw-drafts">
        <div class="dd-head"><span>图片库</span><button class="dd-new" id="draw-draft-new" title="新建画板（已有草稿保留）">＋ 新建</button><button id="draw-close-library" aria-label="收起图片库">×</button></div>
        <div class="dd-tabs" role="tablist" aria-label="绘图状态">
          <button id="draw-drafts-btn" role="tab" data-library="drafts">未插入 <span></span></button>
          <button id="draw-inserted-btn" role="tab" data-library="inserted">已插入 <span></span></button>
        </div>
        <div class="dd-list" id="draw-draft-list"></div>
      </aside>
      <textarea class="draw-textedit" id="draw-textedit" spellcheck="false" hidden></textarea>
    </div>`;
  // 画布占满工作区；面板与工具只作为悬浮控件，不改变世界坐标与视图尺寸。
  const workspace = document.createElement('div');
  workspace.className = 'draw-workspace';
  const panelBackdrop = document.createElement('button');
  panelBackdrop.className = 'draw-panel-backdrop'; panelBackdrop.hidden = true;
  panelBackdrop.setAttribute('aria-label', '关闭绘图侧栏');
  const setDrawPanel = (panel) => {
    overlay.classList.toggle('draw-show-library', panel === 'library');
    overlay.classList.toggle('draw-show-props', panel === 'props');
    panelBackdrop.hidden = !panel;
    overlay.querySelector('#draw-toggle-library').setAttribute('aria-expanded', String(panel === 'library'));
    overlay.querySelector('#draw-toggle-props').setAttribute('aria-expanded', String(panel === 'props'));
  };
  panelBackdrop.onclick = () => setDrawPanel(null);
  overlay.querySelector('#draw-toggle-library').onclick = () => setDrawPanel(overlay.classList.contains('draw-show-library') ? null : 'library');
  overlay.querySelector('#draw-toggle-props').onclick = () => setDrawPanel(overlay.classList.contains('draw-show-props') ? null : 'props');
  overlay._closePanels = () => setDrawPanel(null);
  overlay.querySelector('#draw-close-props').onclick = () => setDrawPanel(null);
  overlay.querySelector('#draw-close-library').onclick = () => setDrawPanel(null);
  const toggleUI = overlay.querySelector('#draw-toggle-ui');
  let quiet = localStorage.getItem('tracery.draw.uiHidden') === 'true';
  const setQuiet = value => {
    quiet = value; overlay.classList.toggle('draw-ui-hidden', quiet);
    toggleUI.textContent = quiet ? '⌄' : '⌃';
    toggleUI.title = toggleUI.ariaLabel = quiet ? '显示功能区' : '收起功能区';
    toggleUI.setAttribute('aria-expanded', String(!quiet));
    localStorage.setItem('tracery.draw.uiHidden', String(quiet));
    layoutToolbar();
  };
  toggleUI.onclick = () => setQuiet(!quiet); setQuiet(quiet);
  const center = document.createElement('div');
  center.className = 'draw-center';
  const stageNode = overlay.querySelector('.draw-stage');
  const toolsNode = overlay.querySelector('.draw-tools');
  const hintNode = overlay.querySelector('.draw-hint');
  workspace.append(overlay.querySelector('.draw-drafts'), center, overlay.querySelector('.draw-props'));
  workspace.appendChild(panelBackdrop);
  center.append(toolsNode, stageNode, hintNode);
  overlay.appendChild(workspace);
  overlay.appendChild(overlay.querySelector('.draw-zoom'));
  document.body.appendChild(overlay);
  const boundsObserver = new ResizeObserver(syncWorkspaceBounds);
  for (const node of document.querySelectorAll('.titlebar, .ribbon')) boundsObserver.observe(node);
  enableTouchControls(overlay);

  canvas = overlay.querySelector('#draw-canvas');
  ctx = canvas.getContext('2d');
  stage = overlay.querySelector('.draw-stage');
  toolsEl = overlay.querySelector('.draw-tools');
  propsEl = overlay.querySelector('.draw-props');
  textEdit = overlay.querySelector('#draw-textedit');
  hintEl = overlay.querySelector('#draw-hint');
  draftPanel = overlay.querySelector('#draw-drafts');
  enableToolbarDrag();
  overlay.querySelectorAll('[data-board-background]').forEach(button => {
    button.onclick = () => setBoardBackground(button.dataset.boardBackground);
  });

  toolsEl.querySelectorAll('.draw-tool[data-tool]').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool);
  });
  overlay.querySelector('#draw-undo').onclick = undo;
  overlay.querySelector('#draw-redo').onclick = redo;
  overlay.querySelector('#draw-clear').onclick = () => {
    if (!elements.length) return;
    elements = [];
    selected.clear();
    snapshot();
    scheduleDraw();
  };
  overlay.querySelector('#draw-cancel').onclick = () => close();
  overlay.querySelector('#draw-save').onclick = () => save();
  overlay.querySelector('#draw-stash').onclick = () => stashCurrent();
  overlay.querySelector('#draw-drafts-btn').onclick = () => toggleDrafts();
  overlay.querySelector('#draw-inserted-btn').onclick = () => { libraryFilter = 'inserted'; renderDrafts(); };
  overlay.querySelector('#draw-draft-new').onclick = () => newBoard();
  overlay.querySelector('#draw-zoom-in').onclick = () => zoomBy(1.15);
  overlay.querySelector('#draw-zoom-out').onclick = () => zoomBy(1 / 1.15);
  overlay.querySelector('#draw-zoom-val').onclick = resetView;

  renderRecentColors();
  propsEl.querySelectorAll('.draw-color-group').forEach(group => {
    const kind = group.dataset.colorKind, hex = group.querySelector('.draw-color-hex');
    group.onclick = event => {
      const button = event.target.closest('button[data-color]');
      if (button) chooseColor(kind, button.dataset.color);
    };
    group.querySelector('.draw-color-picker').onchange = event => chooseColor(kind, event.target.value);
    const applyHex = () => {
      const color = normalizeColor(hex.value);
      hex.setCustomValidity(color ? '' : '请输入 3 位或 6 位十六进制色号，例如 #1971C2');
      if (!color) { hex.reportValidity(); return; }
      chooseColor(kind, color); hex.value = color.toUpperCase();
    };
    hex.oninput = () => hex.setCustomValidity('');
    hex.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); applyHex(); } };
    group.querySelector('.draw-color-apply').onclick = applyHex;
  });
  propsEl.querySelectorAll('.draw-fill').forEach((b) => {
    b.onclick = () => applyStyle({ fillStyle: b.dataset.fill });
  });
  propsEl.querySelectorAll('.draw-size').forEach((b) => {
    b.onclick = () => applyStyle({ strokeWidth: Number(b.dataset.size) });
  });
  propsEl.querySelectorAll('.draw-dash').forEach((b) => {
    b.onclick = () => applyStyle({ strokeStyle: b.dataset.dash });
  });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', (e) => {
    const { px, py } = localPoint(e);
    const w = screenToWorld(px, py);
    const hit = hitTest(w.x, w.y);
    if (hit && hit.type === 'text') {
      selected = new Set([hit.id]);
      openTextEditor(hit, false);
    }
  });

  textEdit.addEventListener('input', () => {
    autoSizeTextEdit();
    const el = elements.find((x) => x.id === textEdit.dataset.id);
    if (el) {
      el.text = textEdit.value;
      measureText(el);
      scheduleDraw();
    }
  });
  textEdit.addEventListener('blur', () => {
    if (!editing) return;
    commitText();
  });
  textEdit.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); textEdit.blur(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); textEdit.blur(); }
    e.stopPropagation();
  });

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('resize', syncWorkspaceBounds);
}

/* ================= 草稿箱（暂存 / 多开画板） =================
 * 需求原文：「绘图加暂存功能，可以多开画板」。做法是只把**场景 JSON**（不含 PNG）
 * 存到本机 localStorage，一个画板 = 一条草稿：随时暂存、随时从草稿箱重开，份数不限，
 * 于是等于「同时保留多块画板」。
 * 为什么放本机 localStorage 而不是仓库/服务端：草稿是「还没决定要不要插进笔记」的
 * 半成品，写进仓库会污染文件树、还会被同步（每台设备还要各自合并）；localStorage
 * 天然是「本机暂存区」，关掉应用也还在。
 */
function newDraftId() {
  return `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function readDrafts() {
  try {
    const arr = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeDrafts(list) {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(list.slice(0, DRAFT_LIMIT)));
    return true;
  } catch {
    toast('草稿保存失败：本机存储空间不足');
    return false;
  }
}

function draftTimeText(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把一份场景装进画板（草稿重开 / 重新编辑共用） */
function setScene(list, background = 'dots') {
  setBoardBackground(background);
  elements = clone(Array.isArray(list) ? list : []);
  selected = new Set();
  history = [clone(elements)];
  hIndex = 0;
  drag = null;
  editing = null;
  spaceDown = false;
  textEdit.hidden = true;
  updateHistoryButtons();
  requestAnimationFrame(() => {
    resizeCanvas();
    if (elements.length) { fitViewToContent(); updateZoomLabel(); }
    draw();
  });
}

function renderDrafts() {
  if (!draftPanel) return;
  const listBox = draftPanel.querySelector('#draw-draft-list');
  listBox.innerHTML = '';
  const drafts = readDrafts().filter((d) => !d.vaultRoot || d.vaultRoot === opts.vaultRoot);
  const pending = savedDrawings.filter((d) => !d.inserted);
  for (const btn of draftPanel.querySelectorAll('[data-library]')) {
    const active = btn.dataset.library === libraryFilter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.querySelector('span').textContent = btn.dataset.library === 'drafts' ? drafts.length + pending.length : savedDrawings.length - pending.length;
  }
  const entries = libraryFilter === 'drafts'
    ? [...drafts.map((d) => ({ ...d, localDraft: true })), ...pending]
    : savedDrawings.filter((d) => d.inserted);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'dd-empty';
    empty.textContent = libraryError || (libraryFilter === 'drafts' ? '暂存画板后会显示在这里，随时继续画。' : '插入笔记的绘图会显示在这里，可重新编辑。');
    listBox.appendChild(empty);
    return;
  }
  for (const d of entries) {
    const row = document.createElement('div');
    row.className = 'dd-row' + ((d.localDraft && d.id === activeDraftId) || (!d.localDraft && d.path === opts.editingPath) ? ' active' : '');
    row.dataset.kind = d.localDraft ? 'draft' : 'saved';
    row.dataset.path = d.path || '';
    const preview = document.createElement('button');
    preview.className = 'dd-preview';
    preview.title = `打开${d.name}`;
    preview.onclick = () => d.localDraft ? openDraft(d.id) : openSavedDrawing(d);
    if (d.localDraft) {
      const thumb = document.createElement('canvas');
      thumb.width = 360; thumb.height = 180;
      const g = thumb.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 360, 180);
      const bounds = (d.elements || []).map(elementExtent);
      if (bounds.length) {
        const x = Math.min(...bounds.map((b) => b.x)), y = Math.min(...bounds.map((b) => b.y));
        const w = Math.max(...bounds.map((b) => b.x + b.w)) - x, h = Math.max(...bounds.map((b) => b.y + b.h)) - y;
        const scale = Math.min(320 / Math.max(w, 1), 140 / Math.max(h, 1), 2);
        g.translate(180 - (x + w / 2) * scale, 90 - (y + h / 2) * scale);
        g.scale(scale, scale);
        for (const el of d.elements || []) drawElement(g, el);
      }
      preview.appendChild(thumb);
    } else {
      const img = document.createElement('img');
      img.src = `${Api.fileUrl(d.path)}&v=${d.updatedAt}`;
      img.alt = d.name; img.loading = 'lazy';
      preview.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'dd-name';
    name.textContent = d.name;
    name.title = d.name;
    const time = document.createElement('span');
    time.className = 'dd-time';
    time.textContent = d.localDraft ? `本机草稿 · ${draftTimeText(d.updatedAt || 0)}`
      : d.inserted ? `用于 ${d.notes.length} 篇笔记` : '尚未插入笔记';
    time.title = d.notes?.join('\n') || '';
    const openBtn = document.createElement('button');
    openBtn.className = 'dd-open';
    openBtn.textContent = d.inserted ? '编辑' : '继续画';
    openBtn.onclick = preview.onclick;
    const delBtn = document.createElement('button');
    delBtn.className = 'dd-del';
    delBtn.textContent = '删除';
    delBtn.title = '删除这份草稿';
    delBtn.onclick = () => deleteDraft(d.id);
    row.append(preview, name, time, openBtn);
    if (d.localDraft) row.appendChild(delBtn);
    listBox.appendChild(row);
  }
}

function toggleDrafts() {
  if (!draftPanel) return;
  libraryFilter = 'drafts';
  draftPanel.hidden = false;
  renderDrafts();
}

async function refreshDrawingLibrary() {
  const request = ++libraryRequest;
  try {
    const result = await Api.drawings();
    if (request !== libraryRequest || overlay.hidden) return;
    savedDrawings = result.drawings || [];
    libraryError = '';
  } catch {
    if (request !== libraryRequest || overlay.hidden) return;
    libraryError = '图片库加载失败，重新打开绘图可重试。';
  }
  renderDrafts();
}

function saveLabel() { return opts.editingPath && !opts.insertOnSave ? '更新绘图' : '插入笔记'; }
function resetSaveTarget() {
  opts.editingPath = null;
  opts.insertOnSave = false;
  overlay.querySelector('#draw-save').textContent = saveLabel();
}

async function openSavedDrawing(drawing) {
  if (elements.length && opts.editingPath !== drawing.path) {
    if (!await askConfirm({ title: `打开「${drawing.name}」？`, desc: '当前画板将被替换，请先暂存需要保留的改动。', okText: '打开' })) return;
  }
  try {
    const response = await fetch(Api.fileUrl(drawing.scenePath), { cache: 'no-store' });
    if (!response.ok) throw new Error('找不到绘图数据');
    const scene = await response.json();
    if (!Array.isArray(scene.elements)) throw new Error('绘图数据格式不正确');
    activeDraftId = null;
    opts.editingPath = drawing.path;
    opts.insertOnSave = !drawing.inserted;
    overlay.querySelector('#draw-save').textContent = saveLabel();
    style = defaultStyle(); setTool('select'); syncStyleUI();
    setScene(scene.elements, scene.appState?.boardBackground);
    renderDrafts();
  } catch (error) { toast(`无法打开绘图：${error.message}`); }
}

/** 暂存：新建草稿要起名；已经在草稿上继续画则直接覆盖 */
async function stashCurrent() {
  commitText();
  if (!elements.length) { toast('画板还是空的，先画点什么'); return; }
  if (activeDraftId) {
    const drafts = readDrafts();
    const i = drafts.findIndex((d) => d.id === activeDraftId);
    if (i >= 0) {
      drafts[i] = { ...drafts[i], updatedAt: Date.now(), elements: clone(elements), boardBackground };
      if (writeDrafts(drafts)) { renderDrafts(); toast('草稿已更新'); }
      return;
    }
    activeDraftId = null;   // 草稿被别处删掉了 → 当作新草稿
  }
  const name = await askText({
    title: '暂存为新草稿',
    desc: '草稿只存在本机（不进仓库、不同步），之后可以从「草稿箱」重开继续画。',
    value: `草稿 ${stamp()}`,
    okText: '暂存',
  });
  if (!name) return;
  const id = newDraftId();
  const drafts = readDrafts();
  drafts.unshift({ id, name, vaultRoot: opts.vaultRoot || '', updatedAt: Date.now(), elements: clone(elements), boardBackground });
  if (!writeDrafts(drafts)) return;
  activeDraftId = id;
  resetSaveTarget();
  renderDrafts();
  toast('已暂存到草稿箱');
}

async function openDraft(id) {
  const d = readDrafts().find((x) => x.id === id);
  if (!d) return;
  if (elements.length && id !== activeDraftId) {
    const ok = await askConfirm({
      title: `打开草稿「${d.name}」？`,
      desc: '当前画板的内容会被替换；还没暂存的改动会丢失。',
      okText: '打开',
      danger: true,
    });
    if (!ok) return;
  }
  activeDraftId = id;
  resetSaveTarget();
  style = defaultStyle();
  setTool('select');
  syncStyleUI();
  setScene(d.elements || [], d.boardBackground);
  renderDrafts();
  toast(`已打开草稿「${d.name}」`);
}

async function deleteDraft(id) {
  const d = readDrafts().find((x) => x.id === id);
  if (!d) return;
  const ok = await askConfirm({
    title: `删除草稿「${d.name}」？`,
    desc: '只删本机草稿，已经插入笔记的图不受影响。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  writeDrafts(readDrafts().filter((x) => x.id !== id));
  if (activeDraftId === id) activeDraftId = null;
  renderDrafts();
  toast('草稿已删除');
}

/** 新建一块画板：清空画布、脱离当前草稿（已有草稿都留着，这就是「多开」的入口） */
async function newBoard() {
  if (elements.length) {
    const ok = await askConfirm({
      title: '新建一块画板？',
      desc: '当前画板会被清空；还没暂存的改动会丢失（已暂存的草稿不受影响）。',
      okText: '新建',
      danger: true,
    });
    if (!ok) return;
  }
  activeDraftId = null;
  resetSaveTarget();
  resetView();
  style = defaultStyle();
  syncStyleUI();
  setTool('select');
  setScene([]);
  renderDrafts();
  toast('已新建画板');
}

/* ================= 保存 ================= */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function contentBounds() {
  if (!elements.length) return { x: 0, y: 0, w: 300, h: 200 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const el of elements) {
    const b = elementExtent(el);        // 用旋转后的外接框，转出头的部分不能被裁掉
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 导出 PNG：只截内容包围盒 + 留白，白底，2 倍超采样 */
function exportPng(scale = 2) {
  const b = contentBounds();
  const pad = 28;
  const w = Math.max(120, Math.round(b.w + pad * 2));
  const h = Math.max(80, Math.round(b.h + pad * 2));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const g = c.getContext('2d');
  g.scale(scale, scale);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.translate(pad - b.x, pad - b.y);
  for (const el of elements) drawElement(g, el);
  return c.toDataURL('image/png');
}

async function save() {
  if (saving) return;
  if (!elements.length) { toast('画布还是空的，先画点什么'); return; }
  commitText();
  saving = true;
  const btn = overlay.querySelector('#draw-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  const editingPath = opts.editingPath ? String(opts.editingPath).replace(/\\/g, '/') : '';
  try {
    const dataUrl = exportPng(2);
    const drawing = JSON.stringify({
      v: 2,
      appState: { viewBackgroundColor: '#ffffff', boardBackground },
      elements,
    });
    const res = editingPath
      // 重新编辑：**覆盖原 PNG + 原 draw.json**，笔记里的 ![[路径]] 不用改
      ? await Api.saveAsset({ data: dataUrl, drawing, overwrite: editingPath })
      : await Api.saveAsset({
        name: `绘图 ${stamp()}`,
        data: dataUrl,
        dir: resolveAssetDir(getSettings(), opts.getNotePath?.()),
        drawing,
      });
    if (editingPath && !opts.insertOnSave) {
      await opts.onUpdated?.(res.path || editingPath);
      close();
      toast('绘图已更新');
    } else {
      await opts.onInserted?.(res.path);
      // 成功插入后只保留仓库中的成品，避免同一画板同时出现在两个分类。
      if (activeDraftId) writeDrafts(readDrafts().filter((d) => d.id !== activeDraftId));
      close();
      toast('绘图已插入笔记');
    }
  } catch (e) {
    toast(`保存失败：${e.message}`);
  } finally {
    saving = false;
    btn.disabled = false;
    btn.textContent = saveLabel();
  }
}

/* ================= 开关 ================= */
/** 把场景缩放到画布可见范围（重新编辑已有绘图时用，不然只看到空白） */
function fitViewToContent() {
  const b = contentBounds();
  const padX = 90, padY = 90;
  const zoom = Math.max(0.15, Math.min(1.5, Math.min(
    (W - padX * 2) / Math.max(60, b.w),
    (H - padY * 2) / Math.max(60, b.h),
  )));
  view = { zoom, x: b.x + b.w / 2 - W / (2 * zoom), y: b.y + b.h / 2 - H / (2 * zoom) };
}

export function openDraw(options = {}) {
  ensure();
  if (!isDrawOpen()) {
    returnNav = [...document.querySelectorAll('.ribbon-btn[data-panel].active')];
    returnNav.forEach(button => button.classList.remove('active'));
    const drawButton = document.querySelector('#btn-draw');
    drawButton?.classList.add('active');
    drawButton?.setAttribute('aria-pressed', 'true');
  }
  opts = options || {};
  // elements：重新编辑时传入既有场景（draw.json 里的数组）；空数组 = 新画
  // draftId：从草稿箱重开某份草稿时传入（保存/再暂存都以它为准）
  activeDraftId = opts.draftId || null;
  style = defaultStyle();
  view = { x: 0, y: 0, zoom: 1 };
  overlay.hidden = false;
  syncWorkspaceBounds();
  overlay._closePanels();
  savedDrawings = [];
  libraryError = '';
  toggleDrafts();
  refreshDrawingLibrary();
  const btn = overlay.querySelector('#draw-save');
  if (btn) btn.textContent = saveLabel();
  setTool('select');
  syncStyleUI();
  updateZoomLabel();
  setScene(Array.isArray(opts.elements) ? opts.elements : [], opts.boardBackground);
}

export function close() {
  if (!overlay || overlay.hidden) return;
  commitText();
  overlay.hidden = true;
  document.querySelector('#btn-draw')?.classList.remove('active');
  document.querySelector('#btn-draw')?.setAttribute('aria-pressed', 'false');
  returnNav.forEach(button => button.classList.add('active'));
  returnNav = [];
  toolbarDrag = null;
  toolsEl.classList.remove('dragging');
  libraryRequest++;
  elements = [];
  selected.clear();
  history = [[]];
  hIndex = 0;
  drag = null;
  editing = null;
  activeDraftId = null;
  if (draftPanel) draftPanel.hidden = true;
}

/** 保留可见主导航：离开画板时先在本设备保留草稿，存储失败则保持画板。 */
export function suspendDraw() {
  if (!isDrawOpen()) return true;
  commitText();
  if (elements.length) {
    const drafts = readDrafts(), existing = drafts.find(d => d.id === activeDraftId);
    const draft = { id: activeDraftId || newDraftId(), name: existing?.name || `未完成绘图 ${stamp()}`,
      vaultRoot: opts.vaultRoot || '', updatedAt: Date.now(), elements: clone(elements), boardBackground };
    if (!writeDrafts([draft, ...drafts.filter(d => d.id !== draft.id)])) return false;
    toast('绘图已保留到本机图片库');
  }
  close(); return true;
}

export function isDrawOpen() {
  return !!overlay && !overlay.hidden;
}
