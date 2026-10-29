/* 快捷键定义与校验共用一份，避免设置页、键盘处理和服务端保存各说各话。 */
export const HOTKEY_COMMANDS = [
  ['palette', '命令面板 / 快速打开', '应用', 'Mod+P'],
  ['settings', '打开设置', '应用', 'Mod+,'],
  ['search', '搜索笔记内容', '应用', 'Mod+Shift+F'],
  ['newNote', '新建笔记', '应用', 'Mod+N'],
  ['quickCapture', '快速记录', '应用', 'Mod+Shift+N'],
  ['template', '从模板新建笔记', '应用', null],
  ['noteProperties', '编辑笔记属性', '应用', null],
  ['noteList', '笔记列表', '应用', null],
  ['tasks', '全库任务汇总', '应用', null],
  ['pdfCitation', '摘录当前 PDF 到笔记', '应用', null],
  ['draw', '新建绘图', '应用', 'Mod+Shift+D'],
  ['mode', '切换编辑模式', '应用', 'Mod+E'],
  ['save', '立即保存', '应用', null],
  ['theme', '切换亮 / 暗主题', '应用', null],
  ['graph', '打开图谱视图', '应用', null],
  ['tags', '查看所有标签', '应用', null],
  ['history', '查看历史版本', '应用', null],
  ['vault', '切换 / 管理仓库', '应用', null],
  ['phone', '手机访问', '应用', null],
  ['exportHtml', '导出 HTML', '应用', null],
  ['exportPdf', '导出 PDF', '应用', null],
  ['closeTab', '关闭当前标签页', '导航', 'Mod+W'],
  ['nextTab', '下一个标签页', '导航', 'Mod+Tab'],
  ['previousTab', '上一个标签页', '导航', 'Mod+Shift+Tab'],
  ['leftSidebar', '折叠 / 展开左侧栏', '导航', 'Mod+\\'],
  ['rightSidebar', '折叠 / 展开右侧栏', '导航', 'Mod+Shift+\\'],
  ['undo', '撤销', '编辑', 'Mod+Z'],
  ['redo', '重做', '编辑', 'Mod+Shift+Z'],
  ['redoAlt', '重做（备用）', '编辑', 'Mod+Y'],
  ['bold', '加粗', '编辑', 'Mod+B'],
  ['italic', '斜体', '编辑', 'Mod+I'],
  ['strike', '删除线', '编辑', 'Mod+S'],
  ['wikilink', '插入双链', '编辑', 'Mod+K'],
].map(([id, label, group, defaultKey]) => ({ id, label, group, defaultKey, editorOnly: group === '编辑' }));

const modifiers = new Set(['Control', 'Ctrl', 'Meta', 'Cmd', 'Command', 'Mod', 'Alt', 'Shift']);
const keys = new Map(['Tab', 'Enter', 'Backspace', 'Delete', 'Space', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(key => [key.toLowerCase(), key]));
const shifted = { '|': '\\', '<': ',', '>': '.', '?': '/', ':': ';', '"': "'", '{': '[', '}': ']', '_': '-', '+': '=', '~': '`' };
const codeKeys = { Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`' };
const reserved = new Set(['Alt+F4', 'Mod+Alt+Delete', 'Mod+Shift+Escape', 'Mod+L', 'Mod+T', 'Mod+R', 'Mod+Shift+R', 'Mod+Shift+I', 'F5', 'F12']);

export function normalizeShortcut(value) {
  if (typeof value !== 'string' || value.length > 70) return null;
  const parts = value.split('+').map(s => s.trim()), last = parts.pop();
  if (!last || !parts.every(p => modifiers.has(p))) return null;
  const mod = parts.some(p => ['Control', 'Ctrl', 'Meta', 'Cmd', 'Command', 'Mod'].includes(p));
  const alt = parts.includes('Alt'), shift = parts.includes('Shift');
  let key = keys.get(last.toLowerCase()) || (/^f([1-9]|1[0-2])$/i.test(last) ? last.toUpperCase() : /^[a-z0-9,./;'\[\]\\=\-`]$/i.test(last) ? last.toUpperCase() : null);
  if (!key || (!mod && !alt && !/^F\d+$/.test(key))) return null;
  return [...(mod ? ['Mod'] : []), ...(alt ? ['Alt'] : []), ...(shift ? ['Shift'] : []), key].join('+');
}

export function shortcutFromEvent(event) {
  if (event.isComposing || event.keyCode === 229 || modifiers.has(event.key) || event.key === 'AltGraph') return null;
  let key = codeKeys[event.code] || (/^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5) : shifted[event.key] || event.key);
  if (key === ' ') key = 'Space';
  return normalizeShortcut([...(event.ctrlKey || event.metaKey ? ['Mod'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key].join('+'));
}

export function bindingFor(command, overrides = {}) {
  if (!Object.hasOwn(overrides, command.id)) return command.defaultKey;
  return overrides[command.id] === null ? null : normalizeShortcut(overrides[command.id]) || command.defaultKey;
}
export function shortcutLabel(shortcut, mac = false) {
  return shortcut ? shortcut.replace(/^Mod(?=\+)/, mac ? 'Cmd' : 'Ctrl') : '未设置';
}
export function validateShortcut(id, value, overrides = {}) {
  if (value === null) return '';
  const key = normalizeShortcut(value);
  if (!key) return '请使用 Ctrl / Cmd、Alt 组合键，或 F1～F12。';
  if (reserved.has(key)) return '该组合键由系统或浏览器保留，请换一个。';
  const other = HOTKEY_COMMANDS.find(c => c.id !== id && bindingFor(c, overrides) === key);
  return other ? `已用于“${other.label}”，请先清除或更改该快捷键。` : '';
}
export function sanitizeHotkeys(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const command of HOTKEY_COMMANDS) {
    if (!Object.hasOwn(value, command.id)) continue;
    if (value[command.id] === null) result[command.id] = null;
    else { const key = normalizeShortcut(value[command.id]); if (key && !reserved.has(key)) result[command.id] = key; }
  }
  return result;
}
