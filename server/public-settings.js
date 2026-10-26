import { sanitizeHotkeys } from '../public/js/hotkeys.js';
import { normalizeLayout } from '../public/js/layout-settings.js';
/* 不向浏览器返回磁盘配置原件，旧版遗留 sync/未知字段也不例外。 */
export function publicSettings(settings) {
  const result = {};
  for (const key of ['themeName','themeMode','accent','radius','fontSize','editorWidth','autosave','lineNumbers','startup']) {
    if (typeof settings[key] === 'string' || typeof settings[key] === 'number' || typeof settings[key] === 'boolean') result[key] = settings[key];
  }
  result.hotkeys = sanitizeHotkeys(settings.hotkeys);
  if (settings.layout) result.layout = normalizeLayout(settings.layout);
  if (settings.attachment) result.attachment = { mode: settings.attachment.mode, folder: settings.attachment.folder };
  return result;
}
