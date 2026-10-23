import { DEFAULT_PANELS, PANE_NAMES, normalizePanels, movePane } from './pane-layout.js';

let controller;
export function panelDock(options) {
  if (!controller) controller = createDock();
  if (options) controller.configure(options);
  return controller;
}
function createDock() {
  const $ = id => document.getElementById(id), buttons = new Map(), panes = new Map(), listeners = new Set();
  const toolbar = document.querySelector('.library-header .panel-actions');
  const navBody = document.createElement('div'); navBody.className = 'dock-body'; $('panel-files').append(navBody);
  const hosts = {
    navigation: { root: $('sidebar'), header: document.querySelector('.library-header'), tabs: document.querySelector('.library-tabs'), body: navBody },
    context: { root: $('sidebar-right'), header: document.querySelector('.context-header'), tabs: document.querySelector('.context-tabs'), body: document.querySelector('.sidebar-sections') },
  };
  let panels = normalizePanels(DEFAULT_PANELS), callbacks = {}, signature = '', drag, suppress = false, menu;
  const active = {
    navigation: localStorage.getItem('tracery.dockActive.navigation') || localStorage.getItem('tracery.libraryView') || 'library',
    context: localStorage.getItem('tracery.dockActive.context') || localStorage.getItem('tracery.contextView') || 'outline',
  };
  for (const button of document.querySelectorAll('[data-library-view], [data-context-view]')) {
    const id = button.dataset.libraryView || button.dataset.contextView;
    buttons.set(id, button); panes.set(id, $(button.getAttribute('aria-controls')));
    button.dataset.paneId = id; button.classList.add('icon-tab');
    button.onclick = () => { if (!suppress) select(id); };
    button.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); showMoveMenu(id, event.clientX, event.clientY); };
    button.onkeydown = event => {
      const host = hostOf(id), ids = panels[host], index = ids.indexOf(id);
      if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        if (event.shiftKey) move(id, physicalHost(event.key === 'ArrowLeft' ? 'left' : 'right'));
        else move(id, host, index + (event.key === 'ArrowLeft' ? -1 : 1));
        return;
      }
      const target = { ArrowLeft: (index + ids.length - 1) % ids.length, ArrowRight: (index + 1) % ids.length, Home: 0, End: ids.length - 1 }[event.key];
      if (target !== undefined) { event.preventDefault(); select(ids[target], { focus: true }); }
    };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { id, x: event.clientX, y: event.clientY, moved: false }; button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
      if (!drag || drag.id !== id) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      drag.moved = true; button.classList.add('dock-dragging');
      let ghost = $('dock-drag-preview');
      if (!ghost) { ghost = document.createElement('div'); ghost.id = 'dock-drag-preview'; ghost.textContent = PANE_NAMES[id]; document.body.append(ghost); }
      ghost.style.left = `${event.clientX + 12}px`; ghost.style.top = `${event.clientY + 12}px`;
      clearMarks(); const target = dropAt(event.clientX, event.clientY);
      if (target) { hosts[target.host].root.classList.add('dock-drop-target'); target.button?.classList.add('dock-drop-before'); }
    });
    const finish = (event, commit) => {
      if (!drag || drag.id !== id) return;
      const moved = drag.moved, target = moved && commit ? dropAt(event.clientX, event.clientY) : null;
      drag = null; button.classList.remove('dock-dragging'); $('dock-drag-preview')?.remove(); clearMarks();
      if (moved) { suppress = true; setTimeout(() => { suppress = false; }, 0); }
      if (target) move(id, target.host, target.index);
    };
    button.addEventListener('pointerup', event => finish(event, true));
    button.addEventListener('pointercancel', event => finish(event, false));
    button.addEventListener('lostpointercapture', event => finish(event, false));
  }
  for (const [host, elements] of Object.entries(hosts)) {
    elements.root.dataset.dockHost = host; elements.header.classList.add('dock-header'); elements.tabs.classList.add('dock-tabs'); elements.body.classList.add('dock-body');
    const empty = document.createElement('div'); empty.className = 'dock-empty'; empty.textContent = '将侧栏图标拖到这里'; elements.empty = empty;
  }
  const hostOf = id => panels.navigation.includes(id) ? 'navigation' : 'context';
  function physicalHost(side) { return side === (matchMedia('(max-width:900px)').matches ? 'left' : document.documentElement.dataset.navigationSide || 'left') ? 'navigation' : 'context'; }
  function renderActive() {
    for (const [host, elements] of Object.entries(hosts)) {
      if (!panels[host].includes(active[host])) active[host] = panels[host][0];
      for (const id of panels[host]) {
        const selected = active[host] === id, button = buttons.get(id);
        button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; panes.get(id).hidden = !selected;
      }
      localStorage.setItem('tracery.dockActive.' + host, active[host] || '');
      if (!panels[host].length && !elements.empty.parentNode) elements.body.append(elements.empty);
      else if (panels[host].length) elements.empty.remove();
    }
    const owner = Object.keys(active).find(host => active[host] === 'library');
    toolbar.hidden = !owner;
    if (owner && toolbar.parentNode !== hosts[owner].header) hosts[owner].header.append(toolbar);
    for (const listener of listeners) listener();
  }
  function apply(layout) {
    panels = normalizePanels(layout.panels);
    const next = JSON.stringify(panels);
    if (signature !== next) {
      signature = next;
      for (const [host, elements] of Object.entries(hosts)) for (const id of panels[host]) {
        elements.tabs.append(buttons.get(id)); elements.body.append(panes.get(id));
      }
      renderActive();
    }
  }
  function select(id, { focus = false, reveal = false } = {}) {
    if (!buttons.has(id)) return;
    const host = hostOf(id); active[host] = id; renderActive();
    if (reveal) callbacks.onReveal?.(host, id);
    if (focus) buttons.get(id).focus();
  }
  function move(id, host, index = panels[host].length) {
    const source = hostOf(id), original = panels[source].indexOf(id);
    // 插入位置基于移除后的列表；拖放命中自身时无需改变顺序。
    const next = movePane(panels, id, host, index);
    if (JSON.stringify(next) === JSON.stringify(panels)) return;
    if (active[source] === id) active[source] = panels[source].filter(item => item !== id)[Math.min(Math.max(0, original), panels[source].length - 2)];
    active[host] = id;
    callbacks.onChange?.({ panels: next });
    apply({ panels: next }); callbacks.onReveal?.(host, id); buttons.get(id).focus();
  }
  function clearMarks() { for (const elements of Object.values(hosts)) elements.root.classList.remove('dock-drop-target'); for (const button of buttons.values()) button.classList.remove('dock-drop-before'); }
  function dropAt(x, y) {
    if (document.body.classList.contains('graph-focus')) return null;
    const target = document.elementFromPoint(x, y), root = target?.closest('[data-dock-host]');
    if (!root) return null;
    const host = root.dataset.dockHost, button = target.closest('[data-pane-id]');
    let index = button ? panels[host].indexOf(button.dataset.paneId) + (x > button.getBoundingClientRect().left + button.getBoundingClientRect().width / 2 ? 1 : 0) : panels[host].length;
    if (hostOf(drag.id) === host && panels[host].indexOf(drag.id) < index) index--;
    return { host, index, button };
  }
  function closeMenu() { menu?.remove(); menu = null; }
  function showMoveMenu(id, x, y) {
    closeMenu(); menu = document.createElement('div'); menu.className = 'context-menu dock-move-menu'; menu.setAttribute('role', 'menu');
    for (const [label, host, index] of [['移到左侧栏', physicalHost('left')], ['移到右侧栏', physicalHost('right')], ['向前移动', hostOf(id), panels[hostOf(id)].indexOf(id) - 1], ['向后移动', hostOf(id), panels[hostOf(id)].indexOf(id) + 1]]) {
      const button = document.createElement('button'); button.textContent = label; button.setAttribute('role', 'menuitem'); button.onclick = event => { event.stopPropagation(); closeMenu(); move(id, host, index); }; menu.append(button);
    }
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - 190))}px`; menu.style.top = `${Math.max(8, Math.min(y, innerHeight - 170))}px`; document.body.append(menu); menu.querySelector('button').focus();
    menu.onkeydown = event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    };
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', event => { if (menu && event.key === 'Escape') { closeMenu(); event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  apply({ panels });
  return { apply, select, onSelect: fn => { listeners.add(fn); fn(); }, isActive: id => active[hostOf(id)] === id,
    configure(options) { callbacks = { ...callbacks, ...options }; }, hostOf, get panels() { return panels; } };
}
