/** 位置和折叠按区域身份保存；手机维持导航在左、笔记上下文在右的抽屉。 */
const compact = matchMedia('(max-width: 900px)');
let current;
export function sidebarForSide(side, layout, mobile = compact.matches) {
  const navigation = mobile || layout.navigationSide === 'left' ? side === 'left' : side === 'right';
  return navigation ? { id: 'sidebar', key: 'navigationVisible', label: '笔记导航' }
    : { id: 'sidebar-right', key: 'contextVisible', label: '笔记上下文' };
}
export function applyWorkspaceLayout(layout) {
  current = layout;
  const root = document.documentElement, graph = document.body.classList.contains('graph-focus');
  root.dataset.navigationSide = layout.navigationSide;
  root.dataset.ribbonVisible = String(layout.ribbonVisible);
  root.dataset.statusBarVisible = String(layout.statusBarVisible);
  for (const [id, visible] of [['sidebar', layout.navigationVisible], ['sidebar-right', layout.contextVisible]]) {
    const panel = document.getElementById(id);
    panel.classList.toggle('collapsed', !visible);
    panel.inert = !compact.matches && !visible && !(id === 'sidebar' && graph);
  }
  for (const side of ['left', 'right']) {
    const region = sidebarForSide(side, layout), button = document.getElementById(`btn-toggle-${side}`);
    const visible = compact.matches ? document.body.classList.contains(`mobile-${side}-open`) : layout[region.key];
    button.classList.toggle('is-off', !visible);
    button.setAttribute('aria-expanded', String(visible));
    button.setAttribute('aria-controls', region.id);
    button.setAttribute('aria-label', `${visible ? '收起' : '展开'}${side === 'left' ? '左' : '右'}侧栏：${region.label}`);
    if (!compact.matches && !visible && document.getElementById(region.id).contains(document.activeElement) && !graph) button.focus();
  }
}
compact.addEventListener('change', () => { if (current) applyWorkspaceLayout(current); });
