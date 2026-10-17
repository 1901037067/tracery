/**
 * Tracery PDF 查看器
 * ------------------------------------------------------------------
 * 文件树点 .pdf → 全屏浮层里用 Chromium 自带 PDF 渲染（iframe）。
 * Electron 需要 webPreferences.plugins = true 才会启用内置 PDF 阅读器；
 * 浏览器里 Chrome/Edge 原生就支持。渲染不出来时兜底「用默认应用打开」。
 */
let box = null;
let frame = null;
let titleEl = null;
let btnOpen = null;
let currentAbs = '';

function ensureEl() {
  if (box) return;
  box = document.createElement('div');
  box.className = 'pdf-viewer';
  box.hidden = true;
  box.innerHTML = `
    <div class="pdf-panel" role="dialog" aria-label="PDF 查看器">
      <header class="pdf-head">
        <span class="pdf-title"></span>
        <span class="pdf-actions">
          <button class="mini-btn pdf-open-ext" title="用系统默认应用打开">用默认应用打开</button>
          <button class="mini-btn pdf-close" title="关闭 (Esc)">✕</button>
        </span>
      </header>
      <iframe class="pdf-frame" title="PDF 内容"></iframe>
    </div>`;
  document.body.appendChild(box);
  frame = box.querySelector('.pdf-frame');
  titleEl = box.querySelector('.pdf-title');
  btnOpen = box.querySelector('.pdf-open-ext');

  const close = () => {
    box.hidden = true;
    frame.removeAttribute('src');   // 停掉 PDF 渲染，释放内存
    document.removeEventListener('keydown', onKey, true);
  };
  box.addEventListener('mousedown', (e) => { if (e.target === box) close(); });  // 点遮罩关闭
  box.querySelector('.pdf-close').onclick = close;
  btnOpen.onclick = () => {
    if (currentAbs && window.electronAPI?.openPath) window.electronAPI.openPath(currentAbs);
    else if (frame?.src) window.open(frame.src, '_blank');
  };
  function onKey(e) {
    if (!box.hidden && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
  }
  box._onKey = onKey;
}

/**
 * 打开 PDF
 * @param {string} url     /api/file?path=... 地址
 * @param {string} name    显示名（文件名）
 * @param {string} [abs]   绝对路径（桌面版「用默认应用打开」用）
 */
export function openPdfViewer(url, name, abs = '') {
  ensureEl();
  currentAbs = abs;
  titleEl.textContent = name || 'PDF';
  frame.src = url;
  box.hidden = false;
  document.addEventListener('keydown', box._onKey, true);
}
