import { planTabDrop, groupForTab } from './tab-workspace.js';

/** 指针捕获保持在原节点；让位使用独立 translate，不改变原有标签圆角和纵向对齐。 */
export function createTabDrag({ state, label, color, commit }) {
  let gesture = null, card = null, marker = null;
  function units(workspace) {
    const result = [], seen = new Set();
    for (const key of workspace.tabs) {
      const group = groupForTab(workspace, key);
      if (group && !seen.has(group.id)) { result.push({ id: 'group:' + group.id, group, text: group.name }); seen.add(group.id); }
      if (!group?.collapsed) result.push({ id: 'tab:' + key, key, group, text: label(key) });
    }
    return result;
  }
  function cancel() {
    if (gesture) {
      for (const item of gesture.targets) { item.el.style.translate = ''; item.el.classList.remove('dragging', 'drop-target', 'drop-before', 'drop-after'); }
      for (const rail of gesture.rails) { rail.el.style.left = rail.left; rail.el.style.width = rail.width; }
      gesture.list.classList.remove('is-reordering');
    }
    gesture = null; card?.remove(); marker?.remove(); card = marker = null;
  }
  function targetAt(event) {
    const bounds = gesture.list.getBoundingClientRect();
    if (event.clientY < bounds.top - 6 || event.clientY > bounds.bottom + 6 || event.clientX < bounds.left || event.clientX > bounds.right) return null;
    const hit = gesture.targets.find(item => event.clientX >= item.rect.left && event.clientX <= item.rect.right)
      || gesture.targets.reduce((best, item) => !best || Math.abs(event.clientX - item.rect.left - item.rect.width / 2) < Math.abs(event.clientX - best.rect.left - best.rect.width / 2) ? item : best, null);
    if (!hit) return null;
    return { ...hit.drop, after: event.clientX > hit.rect.left + hit.rect.width / 2, item: hit };
  }
  function drawPreview(event) {
    const drop = targetAt(event), plan = planTabDrop(state, gesture.drag, drop);
    gesture.plan = plan;
    if (!card) { card = document.createElement('div'); card.className = 'tab-drag-preview'; card.setAttribute('aria-hidden', 'true'); document.body.append(card); }
    const signature = JSON.stringify([plan?.tabs, plan?.tabGroups, drop?.kind, drop?.key, drop?.groupId, drop?.after]);
    if (signature !== gesture.signature) {
      gesture.signature = signature;
      for (const item of gesture.targets) item.el.classList.remove('drop-before', 'drop-after', 'drop-target');
      card.replaceChildren(); const title = document.createElement('div'); title.className = 'tab-drop-caption';
      const source = gesture.drag.kind === 'group' ? state.tabGroups.find(g => g.id === gesture.drag.groupId)?.name : label(gesture.drag.key);
      const target = drop?.kind === 'group' ? state.tabGroups.find(g => g.id === drop.groupId)?.name : drop ? label(drop.key) : '';
      title.textContent = !drop ? '拖到标签栏调整位置' : !plan ? `${source} · 保持当前位置` : gesture.drag.kind === 'tab' && drop.kind === 'group' ? `松开后 · 加入「${target}」` : `松开后 · ${source}移到「${target}」${drop.after ? '之后' : '之前'}`;
      card.append(title);
      const order = document.createElement('div'); order.className = 'tab-drop-order';
      const projected = units(plan || state);
      for (const unit of projected) {
        const pill = document.createElement('span'); pill.className = unit.key ? 'tab-drop-note' : 'tab-drop-group'; pill.textContent = unit.text;
        if (unit.key) pill.dataset.key = unit.key;
        if (unit.group) pill.style.setProperty('--preview-group', color(unit.group));
        pill.classList.toggle('is-moving', gesture.drag.kind === 'group' ? unit.group?.id === gesture.drag.groupId : unit.key === gesture.drag.key);
        if (unit.key === state.tabs[state.activeTab]) pill.classList.add('is-active'); order.append(pill);
      }
      card.append(order);
      const sameNodes = plan && projected.length === gesture.targets.length && projected.every(unit => gesture.targets.some(item => item.id === unit.id));
      let projectedStart;
      gesture.list.classList.toggle('is-reordering', !!sameNodes);
      if (sameNodes) {
        let x = gesture.targets[0].rect.left;
        const gap = parseFloat(getComputedStyle(gesture.list).gap) || 0, positions = new Map();
        for (const unit of projected) {
          const item = gesture.targets.find(item => item.id === unit.id); positions.set(unit.id, { left: x, right: x + item.rect.width });
          item.el.style.translate = `${x - item.rect.left}px 0`; x += item.rect.width + gap;
        }
        projectedStart = positions.get(gesture.drag.kind === 'group' ? 'group:' + gesture.drag.groupId : 'tab:' + gesture.drag.key)?.left;
        for (const rail of gesture.rails) {
          const group = plan.tabGroups.find(g => g.id === rail.el.dataset.group), first = positions.get('group:' + group?.id), last = positions.get('tab:' + group?.tabs.at(-1));
          if (first && last) { rail.el.style.left = `${first.left - gesture.list.getBoundingClientRect().left + 8}px`; rail.el.style.width = `${last.right - first.left - 8}px`; }
        }
      } else {
        for (const item of gesture.targets) item.el.style.translate = '';
        for (const rail of gesture.rails) { rail.el.style.left = rail.left; rail.el.style.width = rail.width; }
      }
      marker?.remove(); marker = null;
      if (plan && drop) {
        drop.item.el.classList.add(drop.kind === 'group' && gesture.drag.kind === 'tab' ? 'drop-target' : drop.after ? 'drop-after' : 'drop-before');
        marker = document.createElement('div'); marker.className = 'tab-drop-marker'; document.body.append(marker);
        marker.style.left = `${(projectedStart ?? (drop.after ? drop.item.rect.right : drop.item.rect.left)) - 1}px`;
        marker.style.top = `${drop.item.rect.top + 3}px`; marker.style.height = `${drop.item.rect.height - 6}px`;
        const group = plan.tabGroups.find(g => g.id === (gesture.drag.groupId || drop.groupId)); if (group) marker.style.background = color(group);
      }
    }
    card.style.left = `${Math.max(8, Math.min(event.clientX - 90, innerWidth - card.offsetWidth - 8))}px`;
    card.style.top = `${Math.min(innerHeight - card.offsetHeight - 8, gesture.list.getBoundingClientRect().bottom + 10)}px`;
  }
  function bind(el, drag) {
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('.tab-close')) return;
      cancel(); const list = el.closest('#tablist');
      const targets = [...list.querySelectorAll('.tab:not([hidden]), .tab-group-header')].map(node => {
        const isGroup = node.classList.contains('tab-group-header'), key = state.tabs[Number(node.dataset.index)];
        return { el: node, id: isGroup ? 'group:' + node.dataset.group : 'tab:' + key, rect: node.getBoundingClientRect(), drop: isGroup ? { kind: 'group', groupId: node.dataset.group } : { kind: 'tab', key } };
      });
      gesture = { el, list, drag, targets, rails: [...list.querySelectorAll('.tab-group-rail')].map(el => ({ el, left: el.style.left, width: el.style.width })), x: event.clientX, y: event.clientY, moved: false };
      el.setPointerCapture(event.pointerId);
    });
    el.addEventListener('pointermove', event => {
      if (!gesture || gesture.el !== el) return;
      if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
      gesture.moved = true;
      for (const item of gesture.targets) if (item.el === el || (gesture.drag.kind === 'group' && item.el.dataset.group === gesture.drag.groupId)) item.el.classList.add('dragging');
      drawPreview(event);
    });
    const end = (event, save) => {
      if (!gesture || gesture.el !== el) return;
      if (gesture.moved && save) drawPreview(event);
      const { moved, plan } = gesture; cancel();
      if (moved) commit(save ? plan : null);
    };
    el.addEventListener('pointerup', e => end(e, true));
    el.addEventListener('pointercancel', e => end(e, false));
    el.addEventListener('lostpointercapture', e => end(e, false));
  }
  window.addEventListener('blur', cancel); window.addEventListener('resize', cancel);
  return { bind, cancel };
}
