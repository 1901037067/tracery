/** 图标提示共用一个浮层，支持动态按钮、键盘焦点和边缘避让。 */
export function initTooltips() {
  const tip = document.createElement('div');
  tip.id = 'app-tooltip'; tip.className = 'app-tooltip'; tip.role = 'tooltip'; tip.hidden = true;
  document.body.append(tip);
  const selector = 'button[title], button[data-tooltip], [role="button"][title]';
  let target = null, text = '', timer = 0, described = null, labelled = false;
  const hide = () => {
    clearTimeout(timer); tip.hidden = true;
    if (target) {
      if (!target.hasAttribute('title')) target.title = text;
      if (labelled && target.getAttribute('aria-label') === text) target.removeAttribute('aria-label');
      if (described == null) target.removeAttribute('aria-describedby'); else target.setAttribute('aria-describedby', described);
    }
    target = null;
  };
  const position = () => {
    if (!target?.isConnected || !target.getClientRects().length) return hide();
    const r = target.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const side = !!target.closest('.ribbon');
    let x = side ? r.right + 9 : (r.left + r.right - t.width) / 2;
    let y = side ? (r.top + r.bottom - t.height) / 2 : r.bottom + 8;
    if (y + t.height > innerHeight - 8) y = r.top - t.height - 8;
    if (side && x + t.width > innerWidth - 8) x = r.left - t.width - 9;
    tip.style.left = `${Math.max(8, Math.min(x, innerWidth - t.width - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(y, innerHeight - t.height - 8))}px`;
  };
  const show = (el, immediate = false) => {
    if (el === target) return;
    hide();
    text = el.getAttribute('title') || el.dataset.tooltip || '';
    if (!text.trim()) return;
    target = el; described = el.getAttribute('aria-describedby');
    labelled = !el.hasAttribute('aria-label');
    if (labelled) el.setAttribute('aria-label', text);
    // 仅在提示期间移除 title，避免系统提示重叠；离开后还原，动态标题继续由原控件维护。
    el.removeAttribute('title');
    timer = setTimeout(() => {
      if (target !== el || !el.isConnected) return hide();
      const current = el.getAttribute('title');
      if (current != null) { text = current; el.removeAttribute('title'); }
      tip.replaceChildren();
      const match = /^(.*?)\s*[（(]((?:Ctrl|Cmd|Alt|Shift|Esc|F\d+|[A-Z])(?:[+\w\\, ]*))[）)]$/.exec(text);
      const label = document.createElement('span'); label.textContent = match ? match[1] : text; tip.append(label);
      if (match) { const key = document.createElement('kbd'); key.textContent = match[2]; tip.append(key); }
      el.setAttribute('aria-describedby', [described, tip.id].filter(Boolean).join(' '));
      tip.hidden = false; position();
    }, immediate ? 0 : 350);
  };
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const el = event.target.closest?.(selector);
    if (el) show(el); else if (target && !target.contains(event.target)) hide();
  });
  document.addEventListener('pointerout', event => {
    if (target?.contains(event.target) && !target.contains(event.relatedTarget)) hide();
  });
  document.addEventListener('focusin', event => { if (event.target.matches?.(selector) && event.target.matches(':focus-visible')) show(event.target, true); });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
}
