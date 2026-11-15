// Global library views temporarily use the work area without changing saved sidebar settings.
let returnRibbon = [];
export function showWorkspaceView(name) {
  if (!document.body.dataset.workspaceView) returnRibbon = [...document.querySelectorAll('.ribbon-btn.active')];
  document.body.dataset.workspaceView = name;
  for (const button of document.querySelectorAll('.ribbon-btn')) {
    const active = button.dataset.workspaceView === name;
    button.classList.toggle('active', active);
    if (button.dataset.workspaceView) { button.setAttribute('aria-pressed', String(active)); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
  }
}
export function closeWorkspaceView(name) {
  if (document.body.dataset.workspaceView !== name) return;
  delete document.body.dataset.workspaceView;
  for (const button of document.querySelectorAll('.ribbon-btn[data-workspace-view]')) { button.classList.remove('active'); button.setAttribute('aria-pressed', 'false'); button.removeAttribute('aria-current'); }
  for (const button of returnRibbon) if (button.isConnected) button.classList.add('active');
  returnRibbon = [];
}
