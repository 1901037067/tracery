import { uiIcon } from './ui-icons.js';
const controls = new WeakMap();
let opened = null, counter = 0;
export function closeSelect() {
  if (!opened) return;
  opened.popup.remove(); opened.button.setAttribute('aria-expanded', 'false'); opened.button.removeAttribute('aria-activedescendant'); opened = null;
}
export function refreshSelect(select) {
  const control = controls.get(select); if (!control) return;
  control.label.textContent = select.selectedOptions[0]?.textContent || select.getAttribute('aria-label') || '请选择';
  control.button.disabled = select.disabled;
  if (opened?.select === select) { if (select.disabled) closeSelect(); else renderOptions(opened); }
}
function renderOptions(c) {
  c.popup.replaceChildren();
  [...c.select.options].forEach((option, index) => {
    const row = document.createElement('div'); row.className = 'select-option'; row.id = `${c.popup.id}-${index}`;
    row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.selected)); row.setAttribute('aria-disabled', String(option.disabled));
    const text = document.createElement('span'); text.textContent = option.textContent;
    const check = document.createElement('span'); check.className = 'select-option-check'; check.innerHTML = uiIcon('check'); check.hidden = !option.selected;
    row.append(text, check); row.onpointermove = () => { if (!option.disabled) activate(c, index); };
    row.onpointerdown = e => e.preventDefault(); row.onclick = () => choose(c, index); c.popup.append(row);
  });
  activate(c, c.active);
}
function activate(c, index) {
  const options = [...c.select.options];
  if (!options[index] || options[index].disabled) index = options.findIndex(o => !o.disabled);
  c.active = index;
  [...c.popup.children].forEach((row, i) => row.classList.toggle('is-active', i === index));
  if (index >= 0) { c.button.setAttribute('aria-activedescendant', `${c.popup.id}-${index}`); c.popup.children[index]?.scrollIntoView({ block: 'nearest' }); }
}
function choose(c, index) {
  if (!c.select.options[index] || c.select.options[index].disabled) return;
  c.select.selectedIndex = index; closeSelect(); refreshSelect(c.select);
  c.select.dispatchEvent(new Event('input', { bubbles: true })); c.select.dispatchEvent(new Event('change', { bubbles: true })); c.button.focus();
}
function show(c, instant = false) {
  closeSelect(); opened = c; c.active = c.select.selectedIndex;
  c.popup.dataset.instant = String(instant);
  c.button.setAttribute('aria-expanded', 'true'); document.body.append(c.popup); renderOptions(c);
  const r = c.button.getBoundingClientRect(), below = innerHeight - r.bottom - 14, above = r.top - 14;
  const up = below < 160 && above > below, available = up ? above : below;
  c.popup.style.width = `${Math.min(innerWidth - 16, Math.max(180, r.width))}px`;
  c.popup.style.maxHeight = `${Math.max(60, Math.min(320, available))}px`;
  c.popup.style.left = `${Math.max(8, Math.min(r.left, innerWidth - c.popup.offsetWidth - 8))}px`;
  c.popup.style.top = `${up ? Math.max(8, r.top - c.popup.offsetHeight - 6) : r.bottom + 6}px`;
  c.popup.style.transformOrigin = `${Math.max(0, Math.min(c.popup.offsetWidth, r.left + r.width / 2 - parseFloat(c.popup.style.left)))}px ${up ? 'bottom' : 'top'}`;
}
export function upgradeSelects(root) {
  for (const select of root.querySelectorAll('select')) {
    if (controls.has(select)) continue;
    const wrap = document.createElement('span'); wrap.className = 'select-control'; select.before(wrap); wrap.append(select); select.hidden = true;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'select-trigger';
    button.setAttribute('role', 'combobox'); button.setAttribute('aria-label', select.getAttribute('aria-label') || '请选择'); button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    if (select.hasAttribute('aria-labelledby')) button.setAttribute('aria-labelledby', select.getAttribute('aria-labelledby'));
    const popup = document.createElement('div'); popup.id = `select-options-${++counter}`; popup.className = 'select-popover'; popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-label', button.getAttribute('aria-label')); button.setAttribute('aria-controls', popup.id);
    const label = document.createElement('span'); label.className = 'select-value'; const arrow = document.createElement('span'); arrow.className = 'select-chevron'; arrow.innerHTML = uiIcon('chevron'); button.append(label, arrow); wrap.append(button);
    const c = { select, button, popup, label, active: 0, query: '', queryAt: 0 }; controls.set(select, c);
    button.onclick = event => opened === c ? closeSelect() : show(c, event.detail === 0);
    button.onkeydown = e => {
      if (e.key === 'Tab') { closeSelect(); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        if (!opened || opened !== c) { show(c, true); if (e.key === 'Enter' || e.key === ' ') return; }
        if (e.key === 'Enter' || e.key === ' ') choose(c, c.active);
        else {
          const indexes = [...select.options].map((o, i) => o.disabled ? -1 : i).filter(i => i >= 0), at = indexes.indexOf(c.active);
          activate(c, e.key === 'Home' ? indexes[0] : e.key === 'End' ? indexes.at(-1) : indexes[(at + (e.key === 'ArrowDown' ? 1 : -1) + indexes.length) % indexes.length]);
        }
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (opened !== c) show(c, true); c.query = (Date.now() - c.queryAt < 700 ? c.query : '') + e.key.toLowerCase(); c.queryAt = Date.now();
        const index = [...select.options].findIndex(o => !o.disabled && o.textContent.toLowerCase().startsWith(c.query)); if (index >= 0) activate(c, index);
      }
    };
    select.addEventListener('change', () => refreshSelect(select));
    new MutationObserver(() => refreshSelect(select)).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
    refreshSelect(select);
  }
}
window.addEventListener('pointerdown', e => { if (opened && !opened.button.contains(e.target) && !opened.popup.contains(e.target)) closeSelect(); }, true);
window.addEventListener('keydown', e => { if (opened && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeSelect(); } }, true);
window.addEventListener('scroll', e => { if (opened && !opened.popup.contains(e.target)) closeSelect(); }, true);
window.addEventListener('resize', closeSelect);
