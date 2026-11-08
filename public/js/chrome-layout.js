/* 标签行与文件标题共用几何变量；侧栏页签换位/换行时测量真正的分割线。 */
export function initChromeLayout() {
  const layout = document.querySelector('.layout'); if (!layout) return;
  let frame;
  const footers = new Set();
  const measure = () => {
    cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const root = document.documentElement, sides = root.dataset.navigationSide === 'right' ? ['#sidebar-right', '#sidebar'] : ['#sidebar', '#sidebar-right'];
      for (const footer of document.querySelectorAll('#editor-area .statusbar, #editor-area .note-list-footer')) {
        if (!footers.has(footer)) { footers.add(footer); resize.observe(footer); }
      }
      const footer = [...footers].find(el => el.isConnected && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden');
      if (footer) {
        const height = `${Math.round(footer.getBoundingClientRect().height * 100) / 100}px`;
        if (layout.style.getPropertyValue('--chrome-footer-height') !== height) layout.style.setProperty('--chrome-footer-height', height);
      } else layout.style.removeProperty('--chrome-footer-height');
      // A zero-width hidden dock wraps its icons into many rows. Never measure
      // it (including a temporary hover preview), or a width transition frame.
      const panel = sides.map(side => document.querySelector(side)).find(panel => panel && !panel.classList.contains('collapsed')
        && panel.getBoundingClientRect().width >= 100
        && !panel.getAnimations().some(animation => animation.transitionProperty === 'width' && animation.playState === 'running')
        && panel.querySelector('.dock-tabs')?.getBoundingClientRect().height);
      const tabs = panel?.querySelector('.dock-tabs'), header = tabs?.closest('.dock-header');
      if (!tabs || !header || !tabs.getBoundingClientRect().height) { layout.style.removeProperty('--dock-divider-offset'); return; }
      const style = getComputedStyle(header), height = tabs.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.rowGap);
      const value = `${Math.round(height * 100) / 100}px`;
      if (layout.style.getPropertyValue('--dock-divider-offset') !== value) layout.style.setProperty('--dock-divider-offset', value);
    });
  };
  const resize = new ResizeObserver(measure);
  for (const el of document.querySelectorAll('.dock-tabs')) resize.observe(el);
  const attributes = new MutationObserver(measure); attributes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-navigation-side', 'data-status-bar-visible'] });
  const editor = document.getElementById('editor-area');
  if (editor) attributes.observe(editor, { childList: true, attributes: true, attributeFilter: ['class', 'data-note-view'] });
  for (const panel of document.querySelectorAll('#sidebar, #sidebar-right')) {
    attributes.observe(panel, { attributes: true, attributeFilter: ['class'] });
    panel.addEventListener('transitionend', measure); panel.addEventListener('transitioncancel', measure);
  }
  const files = document.getElementById('panel-files');
  if (files) attributes.observe(files, { attributes: true, attributeFilter: ['class'] });
  measure();
  return () => { cancelAnimationFrame(frame); resize.disconnect(); attributes.disconnect(); for (const panel of document.querySelectorAll('#sidebar, #sidebar-right')) { panel.removeEventListener('transitionend', measure); panel.removeEventListener('transitioncancel', measure); } };
}
