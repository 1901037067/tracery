/** A hidden navigation pane can be previewed without persisting an open layout. */
export function initNavigationPeek({ layout, compact, select }) {
  const sidebar = document.getElementById('sidebar'), buttons = [...document.querySelectorAll('.ribbon-btn[data-panel]')]
    .filter(button => ['files', 'search', 'tags'].includes(button.dataset.panel));
  let openTimer, closeTimer, active = false;
  const eligible = () => !compact() && !layout().navigationVisible && layout().ribbonVisible !== false && !document.body.classList.contains('graph-focus');
  const inside = target => target instanceof Element && (sidebar.contains(target) || buttons.some(button => button.contains(target)) || !!target.closest('.context-menu, .select-popover'));
  function close() {
    clearTimeout(openTimer); clearTimeout(closeTimer); openTimer = closeTimer = null;
    if (!active) return;
    active = false; document.body.classList.remove('navigation-peek');
    sidebar.inert = !compact() && !layout().navigationVisible && !document.body.classList.contains('graph-focus');
    if (sidebar.inert && sidebar.contains(document.activeElement)) document.getElementById('btn-toggle-' + (layout().navigationSide === 'right' ? 'right' : 'left'))?.focus({ preventScroll: true });
  }
  function sync() {
    const hidden = !compact() && !layout().navigationVisible && !document.body.classList.contains('graph-focus');
    for (const button of buttons) button.setAttribute('aria-disabled', String(hidden));
    if (!eligible()) close();
  }
  function leave() {
    clearTimeout(openTimer); openTimer = null;
    if (active && !closeTimer) closeTimer = setTimeout(close, 180);
  }
  for (const button of buttons) {
    button.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch' || !eligible()) return;
      clearTimeout(openTimer); clearTimeout(closeTimer); closeTimer = null;
      openTimer = setTimeout(() => {
        openTimer = null; if (!eligible()) return;
        active = true; document.body.classList.add('navigation-peek'); sidebar.inert = false;
        select(button.dataset.panel);
      }, 120);
    });
    button.addEventListener('pointerleave', leave);
  }
  sidebar.addEventListener('pointerenter', () => { clearTimeout(closeTimer); closeTimer = null; });
  sidebar.addEventListener('pointerleave', leave);
  document.addEventListener('pointermove', event => {
    if (!active) return;
    if (inside(event.target)) { clearTimeout(closeTimer); closeTimer = null; }
    else leave();
  }, { passive: true });
  document.addEventListener('pointerdown', event => { if (active && !inside(event.target)) close(); }, true);
  document.addEventListener('keydown', event => {
    if (active && event.key === 'Escape' && !document.querySelector('.context-menu, .select-popover, .modal:not([hidden]), .dialog-backdrop:not([hidden])')) { event.preventDefault(); event.stopImmediatePropagation(); close(); }
  }, true);
  window.addEventListener('blur', close); window.addEventListener('resize', sync);
  const observer = new MutationObserver(sync);
  observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-navigation-side', 'data-ribbon-visible'] });
  sync(); return { close };
}
