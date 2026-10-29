export const BUILTIN_TEMPLATES = [
  { id: 'blank', name: '空白笔记', content: '# {{title}}\n\n{{selection}}' },
  { id: 'course', name: '课程笔记', content: '---\ncourse: ""\nstatus: "学习中"\nmastery: 0\nreview: "{{date}}"\ntags: ["课程"]\n---\n# {{title}}\n\n日期：{{date}}\n\n## 核心概念\n\n{{selection}}\n\n## 例题与推导\n\n\n## 待解决的问题\n\n' },
  { id: 'paper', name: '论文阅读', content: '---\nstatus: "阅读中"\nreview: "{{date}}"\ntags: ["论文"]\n---\n# {{title}}\n\n阅读日期：{{date}}\n\n## 研究问题\n\n{{selection}}\n\n## 方法与贡献\n\n\n## 实验与证据\n\n\n## 局限与思考\n\n' },
  { id: 'meeting', name: '会议记录', content: '---\nstatus: "待整理"\ntags: ["会议"]\n---\n# {{title}}\n\n时间：{{datetime}}\n\n## 议题\n\n{{selection}}\n\n## 决策\n\n\n## 后续行动\n\n- [ ] \n' },
];
export function localDate(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function renderTemplate(source, { title = '', selection = '', now = new Date() } = {}) {
  const time = [now.getHours(), now.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
  const values = { title, selection, date: localDate(now), time, datetime: localDate(now) + ' ' + time };
  // One pass: substituted note text is never reinterpreted as a template.
  return source.replace(/\{\{\s*(title|selection|date|time|datetime)\s*\}\}/g, (token, key, offset) => {
    const value = values[key], lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    // Quotes in a supplied title/selection must not escape a YAML string literal.
    const prefix = source.slice(lineStart, offset);
    return /^\w+:\s*"[^"\n]*$/.test(prefix) ? JSON.stringify(value).slice(1, -1) : value;
  });
}
