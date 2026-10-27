/* 标签行与文件标题共用几何变量；侧栏页签换位/换行时测量真正的分割线。 */
export function initChromeLayout() {
  const layout = document.querySelector('.layout'); if (!layout) return;
  let frame;
  const measure = () => {
    cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const root = document.documentElement, side = root.dataset.navigationSide === 'right' ? '#sidebar-right' : '#sidebar';
      const tabs = document.querySelector(side + ' .dock-tabs'), header = tabs?.closest('.dock-header');
      if (!tabs || !header || !tabs.getBoundingClientRect().height) { layout.style.removeProperty('--dock-divider-offset'); return; }
      const style = getComputedStyle(header), height = tabs.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.rowGap);
      const value = `${Math.round(height * 100) / 100}px`;
      if (layout.style.getPropertyValue('--dock-divider-offset') !== value) layout.style.setProperty('--dock-divider-offset', value);
    });
  };
  const resize = new ResizeObserver(measure);
  for (const el of document.querySelectorAll('.dock-tabs')) resize.observe(el);
  const attributes = new MutationObserver(measure); attributes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-navigation-side'] });
  measure();
  return () => { cancelAnimationFrame(frame); resize.disconnect(); attributes.disconnect(); };
}
