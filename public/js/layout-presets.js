import { normalizeLayout } from './layout-settings.js';
import { isBlankTab, tidyTabGroups } from './tab-workspace.js';
const LEGACY = 'tracery.layoutPresets';
let currentRoot = () => '';
export function setWorkspaceRoot(fn) { currentRoot = fn; }
const key = () => `tracery.workspaces.${currentRoot() || 'default'}`;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const safePath = value => typeof value === 'string' && value.length <= 2048 && !/[\\:\u0000-\u001f]/.test(value) && !value.startsWith('/') && !value.split('/').some(p => p === '..' || p === '.') && /\.(?:md|pdf)$/i.test(value);
export function normalizeSession(value) {
  if (!record(value)) return null;
  const tabs = [...new Set((Array.isArray(value.tabs) ? value.tabs : []).filter(p => safePath(p) || (isBlankTab(p) && p.length < 100)))].slice(0, 500);
  const workspace = { tabs, activeTab: tabs.indexOf(value.active), tabGroups: (Array.isArray(value.groups) ? value.groups : []).filter(record).slice(0, 500).map(g => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed, tabs: Array.isArray(g.tabs) ? [...g.tabs] : [] })) };
  tidyTabGroups(workspace);
  const positions = Object.create(null);
  for (const p of tabs) {
    const v = value.positions?.[p]; if (!record(v)) continue;
    const number = n => Number.isFinite(n) ? Math.max(0, Math.min(n, 1e9)) : 0;
    positions[p] = { top: number(v.top), left: number(v.left), anchor: Math.floor(number(v.anchor)), head: Math.floor(number(v.head)), mode: ['live', 'source', 'read'].includes(v.mode) ? v.mode : 'live' };
  }
  const dock = {};
  for (const host of ['navigation', 'context']) if (typeof value.dock?.[host] === 'string') dock[host] = value.dock[host];
  return { tabs: workspace.tabs, active: tabs.includes(value.active) ? value.active : workspace.tabs[0] || null, groups: workspace.tabGroups, positions, dock };
}
function normalize(item) {
  if (!record(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || !record(item.layout)) return null;
  return { id: item.id, name: item.name.slice(0, 40), layout: normalizeLayout(item.layout), session: normalizeSession(item.session) };
}
export function readPresets() {
  let items;
  try {
    const saved = localStorage.getItem(key());
    items = JSON.parse(saved ?? localStorage.getItem(LEGACY) ?? '[]');
    items = (Array.isArray(items) ? items : []).map(normalize).filter(Boolean);
    if (saved === null && items.length) { try { writePresets(items); } catch { /* 空间不足时仍可读取原有布局，不丢弃旧快照。 */ } }
  } catch { items = []; }
  return items;
}
export function writePresets(items) { localStorage.setItem(key(), JSON.stringify(items.map(normalize).filter(Boolean))); }
export function encodePreset(preset) { return JSON.stringify({ format: 'tracery-workspace', version: 1, name: preset.name, layout: normalizeLayout(preset.layout), session: normalizeSession(preset.session) }, null, 2); }
export function decodePreset(text) {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw Error('工作区文件过大');
  const item = JSON.parse(text);
  if (!['tracery-layout', 'tracery-workspace'].includes(item?.format) || item.version !== 1 || !record(item.layout)) throw Error('不支持的工作区文件或版本');
  return { id: crypto.randomUUID(), name: String(item.name || '导入的工作区').slice(0, 40), layout: normalizeLayout(item.layout), session: item.format === 'tracery-workspace' ? normalizeSession(item.session) : null };
}
