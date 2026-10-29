/** PDF 在主编辑区显示，标签与导航由 app.js 管理；渲染继续使用本机内置阅读器。 */
import { pdfPage, pdfUrl } from './pdf-reference.js';
let box, frame, titleEl, currentAbs = '', currentPath = '', currentRoot, actions = {};
const pages = new Map();

export function configurePdfViewer(value) { actions = value; }

function ensureEl() {
  if (box) return;
  box = document.createElement('section');
  box.className = 'pdf-viewer'; box.hidden = true; box.setAttribute('aria-label', 'PDF 阅读区');
  box.innerHTML = `<div class="pdf-panel">
    <header class="pdf-head">
      <span class="pdf-badge" aria-hidden="true">PDF</span><span class="pdf-title"></span>
      <span class="pdf-actions">
        <button class="mini-btn pdf-cite" title="将已复制的文字连同页码写入笔记">摘录到笔记</button>
        <button class="mini-btn pdf-open-ext" title="用系统默认应用打开">外部打开</button>
        <button class="mini-btn pdf-close" title="关闭 PDF 标签页" aria-label="关闭 PDF 标签页">✕</button>
      </span>
    </header>
    <iframe class="pdf-frame" title="PDF 内容"></iframe>
  </div>`;
  document.querySelector('#editor-area .editor-wrap').append(box);
  frame = box.querySelector('.pdf-frame'); titleEl = box.querySelector('.pdf-title');
  box.querySelector('.pdf-close').onclick = () => actions.close?.();
  box.querySelector('.pdf-cite').onclick = () => actions.cite?.();
  box.querySelector('.pdf-open-ext').onclick = () => {
    if (currentAbs && window.electronAPI?.openPath) window.electronAPI.openPath(currentAbs);
    else if (frame?.src) window.open(frame.src, '_blank', 'noopener');
  };
}

/** 文件树、收藏和附件入口都经过同一条导航队列，不能绕过保存失败保护。 */
export function openPdfViewer(url) {
  const target = new URL(url, location.href), path = target.searchParams.get('path');
  if (path) return actions.open?.(path, pdfPage(target.hash));
}

export function showPdfViewer(url, name, abs = '') {
  ensureEl(); currentAbs = abs;
  const target = new URL(url, location.href); currentPath = target.searchParams.get('path') || '';
  currentRoot = actions.root?.() || '';
  const key = currentRoot + '\n' + currentPath, page = pdfPage(target.hash);
  if (page) { pages.delete(key); pages.set(key, page); if (pages.size > 100) pages.delete(pages.keys().next().value); }
  if (!target.hash && pages.has(key)) url = pdfUrl(url, pages.get(key));
  box.querySelector('.pdf-cite').disabled = !!actions.readOnly?.();
  titleEl.textContent = name || 'PDF';
  if (frame.getAttribute('src') !== url) frame.src = url;
  box.hidden = false;
}
export function currentPdf() { return box && !box.hidden && currentRoot === (actions.root?.() || '') ? { path: currentPath, name: titleEl.textContent } : null; }

export function hidePdfViewer() {
  if (!box || box.hidden) return;
  box.hidden = true; frame.removeAttribute('src'); currentAbs = '';
}
