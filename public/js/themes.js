// Display names are independent of stored IDs so existing settings keep working.
export const THEMES = Object.freeze([
  { id: 'apple', name: '清简', description: '明净中性', preview: ['#ededf0', '#ffffff', '#34343a'] },
  { id: 'obsidian', name: 'Obsidian 风', description: '经典灰阶', preview: ['#e9e6ef', '#ffffff', '#665382'] },
  { id: 'paper', name: '暖纸', description: '暖白与墨棕', preview: ['#e9e2d6', '#fffaf0', '#655143'] },
  { id: 'sage', name: '青岚', description: '浅绿与青灰', preview: ['#dfe8e2', '#f8fcf9', '#395c52'] },
  { id: 'dusk', name: '暮蓝', description: '冷白与深蓝', preview: ['#e0e6f0', '#f8faff', '#405675'] },
]);
export const themeLabel = id => THEMES.find(theme => theme.id === id)?.name || id;
