import { normalizeLayout } from './layout-settings.js';
const KEY = 'tracery.layoutPresets';
export function readPresets() {
  let items; try { items = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { items = []; }
  return (Array.isArray(items) ? items : []).filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && item.layout && typeof item.layout === 'object').map(item => ({ id: item.id, name: item.name.slice(0, 40), layout: normalizeLayout(item.layout) }));
}
export function writePresets(items) { localStorage.setItem(KEY, JSON.stringify(items)); }
export function encodePreset(preset) { return JSON.stringify({ format: 'tracery-layout', version: 1, name: preset.name, layout: normalizeLayout(preset.layout) }, null, 2); }
export function decodePreset(text) {
  if (typeof text !== 'string' || text.length > 256 * 1024) throw Error('布局文件过大');
  const item = JSON.parse(text);
  if (item?.format !== 'tracery-layout' || item.version !== 1 || !item.layout || typeof item.layout !== 'object' || Array.isArray(item.layout)) throw Error('不支持的布局文件或版本');
  return { id: crypto.randomUUID(), name: String(item.name || '导入的布局').slice(0, 40), layout: normalizeLayout(item.layout) };
}
