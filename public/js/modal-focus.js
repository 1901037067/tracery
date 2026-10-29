// Modal scopes stack so a confirmation opened from settings owns the keyboard.
const scopes = [];
const focusable = root => [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
  .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[hidden]'));
document.addEventListener('keydown', event => {
  const scope = scopes.at(-1);
  if (!scope || event.key !== 'Tab' || event.defaultPrevented) return;
  const items = focusable(scope.root), first = items[0], last = items.at(-1);
  if (!first) { event.preventDefault(); return; }
  if (!scope.root.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
    event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
}, true);
export function enterModal(root, initial) {
  if (!scopes.some(scope => scope.root === root)) scopes.push({ root, previous: document.activeElement });
  (initial || focusable(root)[0])?.focus({ preventScroll: true });
}
export function leaveModal(root) {
  const index = scopes.findIndex(scope => scope.root === root);
  if (index < 0) return;
  const [{ previous }] = scopes.splice(index, 1);
  if (previous?.isConnected && previous.getClientRects().length && !previous.disabled) previous.focus({ preventScroll: true });
}
