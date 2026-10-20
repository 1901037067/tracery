/* 移动端抽屉独立于桌面折叠状态，旋转屏幕或回到桌面时不会改掉原有栏宽。 */
const compact = matchMedia('(max-width: 900px)');
export const isCompact = () => compact.matches;
const byId = (id) => document.getElementById(id);
let lastTrigger = null;
const touchClicks = new WeakMap();
let clickGuardInstalled = false;

/** 画布手势之后浏览器可能抑制兼容 click；控件在手指原地松开时响应，并吞掉同次手势的补发 click。 */
export function enableTouchControls(root) {
  if (!clickGuardInstalled) {
    clickGuardInstalled = true;
    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('button');
      const last = button && touchClicks.get(button);
      if (event.isTrusted && last && performance.now() - last.time < 700
        && (event.pointerId === undefined || event.pointerId === last.pointerId)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, true);
  }
  let start = null;
  root.addEventListener('pointerdown', (event) => {
    const button = event.target.closest?.('button');
    start = event.pointerType === 'touch' && button && !button.disabled ? { button, id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  });
  root.addEventListener('pointercancel', () => { start = null; });
  root.addEventListener('pointerup', (event) => {
    const origin = start; start = null;
    if (!origin || event.pointerId !== origin.id || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) return;
    const rect = origin.button.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    touchClicks.set(origin.button, { pointerId: event.pointerId, time: performance.now() });
    origin.button.click();
  });
}

export function closeMobilePanels({ focus = false } = {}) {
  document.body.classList.remove('mobile-left-open', 'mobile-right-open');
  byId('mobile-backdrop').hidden = true;
  byId('editor-area').inert = false;
  byId('btn-toggle-left').setAttribute('aria-expanded', 'false');
  byId('btn-toggle-right').setAttribute('aria-expanded', 'false');
  if (focus) lastTrigger?.focus();
}

export function toggleMobilePanel(side) {
  const cls = `mobile-${side}-open`;
  const open = !document.body.classList.contains(cls);
  closeMobilePanels();
  if (open) {
    lastTrigger = byId(`btn-toggle-${side}`);
    document.body.classList.add(cls);
    byId('mobile-backdrop').hidden = false;
    byId('editor-area').inert = true;
    lastTrigger.setAttribute('aria-expanded', 'true');
    const drawer = byId(side === 'left' ? 'sidebar' : 'sidebar-right');
    drawer.querySelector('input, button, [tabindex="0"]')?.focus();
  }
}

export function initMobile() {
  enableTouchControls(byId('panel-graph'));
  const resizeViewport = () => {
    const viewport = window.visualViewport;
    if (isCompact() && viewport && Math.abs(viewport.scale - 1) < .01) document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
    else if (!isCompact()) document.documentElement.style.removeProperty('--app-height');
  };
  window.visualViewport?.addEventListener('resize', resizeViewport);
  window.addEventListener('resize', resizeViewport);
  resizeViewport();
  byId('mobile-backdrop').onclick = () => closeMobilePanels({ focus: true });
  compact.addEventListener('change', () => { closeMobilePanels(); resizeViewport(); });
  document.addEventListener('keydown', (event) => {
    if (!isCompact() || byId('mobile-backdrop').hidden) return;
    if (document.querySelector('.modal:not([hidden]), .dialog-backdrop:not([hidden]), .draw-overlay:not([hidden]), #welcome:not([hidden])')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeMobilePanels({ focus: true }); }
    if (event.key === 'Tab') {
      const selector = document.body.classList.contains('mobile-left-open') ? '.ribbon, #sidebar' : '#sidebar-right';
      const items = [...document.querySelectorAll(selector)].flatMap((el) => [...el.querySelectorAll('button, input, [tabindex="0"]')])
        .filter((el) => !el.disabled && el.getClientRects().length);
      const index = items.indexOf(document.activeElement);
      if (!items.length) return;
      if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
    }
  }, true);
}
