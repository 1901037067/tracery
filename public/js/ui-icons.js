const paths = {
  appearance: '<path d="M12 3a9 9 0 1 0 0 18h1.4a2 2 0 0 0 1.2-3.6 1.6 1.6 0 0 1 .9-2.9H17a4 4 0 0 0 4-4C21 6.4 17 3 12 3Z"/><circle cx="7.5" cy="10" r=".8"/><circle cx="10" cy="6.8" r=".8"/><circle cx="15" cy="7" r=".8"/><circle cx="17" cy="10" r=".8"/>',
  editor: '<path d="m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16l-1 4Z"/>',
  layout: '<path d="M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4M10 16v4"/>',
  hotkeys: '<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h.01M11 14h7"/>',
  attachment: '<path d="m9 16 7-7a3 3 0 0 0-4-4l-8 8a5 5 0 0 0 7 7l9-9M8 12l-2 2a2 2 0 0 0 3 3l8-8"/>',
  sync: '<path d="M20 9a8 8 0 0 0-14-5L3 7m0-4v4h4M4 15a8 8 0 0 0 14 5l3-3m0 4v-4h-4"/>',
  general: '<path d="m10 3-1 3-3 1-3-1-1 4 3 2v3l-2 2 3 3 3-1 3 1 1 2 4-1v-3l2-2 3-1-1-4-3-1-1-3-4 1-3-2Z"/><circle cx="12" cy="12" r="3"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  up: '<path d="M12 19V5m-5 5 5-5 5 5"/>',
  down: '<path d="M12 5v14m-5-5 5 5 5-5"/>',
};
export const uiIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.about}</svg>`;
