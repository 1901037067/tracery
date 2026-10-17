/**
 * 图片灯箱：在应用内看大图
 * 支持滚轮缩放、拖动平移、双击复位、Esc 关闭。
 */
let box = null;
let stage = null;
let img = null;
let label = null;
let state = { scale: 1, x: 0, y: 0, drag: null };

function ensure() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'lightbox';
  box.hidden = true;
  box.innerHTML = `
    <div class="lb-stage"><img class="lb-img" alt="" draggable="false" /></div>
    <div class="lb-bar">
      <span class="lb-name"></span>
      <span class="lb-tools">
        <button data-act="out" title="缩小">−</button>
        <span class="lb-scale">100%</span>
        <button data-act="in" title="放大">＋</button>
        <button data-act="fit" title="适应窗口">适应</button>
        <button data-act="close" title="关闭 (Esc)">✕</button>
      </span>
    </div>`;
  document.body.appendChild(box);
  stage = box.querySelector('.lb-stage');
  img = box.querySelector('.lb-img');
  label = box.querySelector('.lb-scale');

  box.querySelector('.lb-bar').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'close') closeLightbox();
    else if (act === 'in') zoomBy(1.25);
    else if (act === 'out') zoomBy(0.8);
    else if (act === 'fit') fit();
  });
  // 点空白处关闭（点图片不关）
  box.addEventListener('mousedown', (e) => {
    if (e.target === box || e.target === stage) closeLightbox();
  });
  img.addEventListener('dblclick', () => {
    if (state.scale > 1.01) fit();
    else { state.scale = 1; state.x = 0; state.y = 0; apply(); }
  });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 0.89);
  }, { passive: false });
  stage.addEventListener('mousedown', (e) => {
    if (state.scale <= 1) return;
    state.drag = { x: e.clientX - state.x, y: e.clientY - state.y };
    stage.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!state.drag) return;
    state.x = e.clientX - state.drag.x;
    state.y = e.clientY - state.drag.y;
    apply();
  });
  window.addEventListener('mouseup', () => {
    state.drag = null;
    stage?.classList.remove('grabbing');
  });
  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeLightbox(); }
    else if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-') zoomBy(0.8);
    else if (e.key === '0') fit();
  }, true);
  return box;
}

function apply() {
  img.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  label.textContent = `${Math.round(state.scale * 100)}%`;
  stage.classList.toggle('zoomed', state.scale > 1.01);
}

function zoomBy(f) {
  state.scale = Math.min(8, Math.max(0.2, state.scale * f));
  if (state.scale <= 1) { state.x = 0; state.y = 0; }
  apply();
}

function fit() {
  state.scale = 1;
  state.x = 0;
  state.y = 0;
  apply();
}

export function openLightbox(src, alt = '') {
  ensure();
  img.src = src;
  img.alt = alt;
  box.querySelector('.lb-name').textContent = alt || '';
  box.hidden = false;
  fit();
  requestAnimationFrame(() => box.classList.add('open'));
  // 大图铺满但不超过自然尺寸：等比适配由 CSS max-width/height 完成，scale 从 1 起
}

export function closeLightbox() {
  if (!box || box.hidden) return;
  box.classList.remove('open');
  box.hidden = true;
  img.removeAttribute('src');
}
