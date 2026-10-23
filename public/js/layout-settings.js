/** 设置面板、拖动侧栏与服务端共用边界；旧配置没有 layout 时保留迁移机会。 */
export const DEFAULT_LAYOUT = Object.freeze({ leftWidth: 272, rightWidth: 296, lineHeight: 1.78, contentPadding: 26 });
export const LAYOUT_FIELDS = Object.freeze({
  leftWidth: { label: '左侧栏宽度', min: 190, max: 640, step: 1, unit: 'px' },
  rightWidth: { label: '右侧栏宽度', min: 190, max: 640, step: 1, unit: 'px' },
  lineHeight: { label: '正文行高', min: 1.3, max: 2.4, step: .01, unit: '倍' },
  contentPadding: { label: '正文顶部留白', min: 8, max: 80, step: 1, unit: 'px' },
});
export function normalizeLayout(value, base = DEFAULT_LAYOUT) {
  const result = { ...base };
  for (const [key, rule] of Object.entries(LAYOUT_FIELDS)) {
    const n = value?.[key];
    if (Number.isFinite(n)) result[key] = Number((Math.round(Math.min(rule.max, Math.max(rule.min, n)) / rule.step) * rule.step).toFixed(2));
  }
  return result;
}
