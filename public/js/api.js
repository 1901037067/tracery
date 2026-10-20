/* Tracery 前端 API 封装 + WebSocket */
const BASE = location.origin;

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const Api = {
  state: () => api('/api/state'),
  openVault: (path) => api('/api/vault/open', { method: 'POST', body: { path } }),
  forgetVault: (path) => api('/api/vault/forget', { method: 'POST', body: { path } }),
  tree: () => api('/api/tree'),
  drawings: () => api('/api/drawings'),
  note: (path) => api(`/api/note?path=${encodeURIComponent(path)}`),
  saveNote: (path, content) => api('/api/note', { method: 'PUT', body: { path, content } }),
  createNote: (path, content) => api('/api/note/create', { method: 'POST', body: { path, content } }),
  saveAsset: (payload) => api('/api/asset', { method: 'POST', body: payload }),
  rename: (path, newPath) => api('/api/rename', { method: 'POST', body: { path, newPath } }),
  remove: (path) => api('/api/delete', { method: 'POST', body: { path } }),
  // 回收站：删除先进这里，可恢复
  trash: () => api('/api/trash'),
  trashRestore: (id) => api('/api/trash/restore', { method: 'POST', body: { id } }),
  trashPurge: (id) => api('/api/trash/purge', { method: 'POST', body: { id } }),
  trashEmpty: () => api('/api/trash/empty', { method: 'POST', body: {} }),
  // 版本历史 + 全文替换
  history: (path) => api(`/api/history?path=${encodeURIComponent(path)}`),
  historyContent: (path, id) => api(`/api/history/content?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`),
  historyRestore: (path, id) => api('/api/history/restore', { method: 'POST', body: { path, id } }),
  replace: (query, replacement) => api('/api/replace', { method: 'POST', body: { query, replacement } }),
  links: (path) => api(`/api/links?path=${encodeURIComponent(path)}`),
  search: (q) => api(`/api/search?q=${encodeURIComponent(q)}`),
  tags: () => api('/api/tags'),
  graph: () => api('/api/graph'),
  setTheme: (theme, themeName) => api('/api/theme', { method: 'POST', body: { theme, themeName } }),
  saveSettings: (patch) => api('/api/settings', { method: 'POST', body: patch }),
  // 自托管同步
  syncStatus: () => api('/api/sync/status'),
  syncPair: (payload) => api('/api/sync/pair', { method: 'POST', body: payload }),
  syncUnlock: (password) => api('/api/sync/unlock', { method: 'POST', body: { password } }),
  syncNow: () => api('/api/sync/now', { method: 'POST', body: {} }),
  syncOptions: (patch) => api('/api/sync/options', { method: 'POST', body: patch }),
  syncDisconnect: () => api('/api/sync/disconnect', { method: 'POST', body: {} }),
  lanStart: () => api('/api/sync/lan/start', { method: 'POST', body: {} }),
  lanStop: () => api('/api/sync/lan/stop', { method: 'POST', body: {} }),
  lanFind: (code) => api('/api/sync/lan/find', { method: 'POST', body: { code } }),
  fileUrl: (path) => `${BASE}/api/file?path=${encodeURIComponent(path)}`,
};

/* WebSocket：仓库文件变化实时推送 */
export function connectWs(onMessage) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    try { onMessage(JSON.parse(ev.data)); } catch { /* ignore */ }
  };
  ws.onclose = () => setTimeout(() => connectWs(onMessage), 2000);
  return ws;
}

/* 小工具 */
export function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function fuzzyMatch(pattern, text) {
  // 简单模糊匹配：pattern 的字符按顺序出现在 text 中
  pattern = pattern.toLowerCase();
  text = text.toLowerCase();
  let pi = 0;
  let score = 0;
  let last = -1;
  for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
    if (text[ti] === pattern[pi]) {
      score += (last >= 0 && ti === last + 1) ? 2 : 1;
      last = ti;
      pi++;
    }
  }
  return pi === pattern.length ? score : -1;
}
