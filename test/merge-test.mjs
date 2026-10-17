/**
 * 三方合并单元测试（纯函数，不需要起服务）
 * 运行：node test/merge-test.mjs
 */
import { mergeText, isMergeablePath } from '../server/merge.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
};

const base = [
  '# 标题',
  '',
  '第一段：原始内容。',
  '',
  '第二段：原始内容。',
  '',
  '第三段：原始内容。',
].join('\n');

// 1. 两边改不同段 → 自动合并
{
  const ours = base.replace('第一段：原始内容。', '第一段：我在笔记本上改的。');
  const theirs = base.replace('第三段：原始内容。', '第三段：台式机改的。');
  const r = mergeText(base, ours, theirs);
  check('不同段落改动自动合并', r.conflicts === 0 && r.text.includes('笔记本') && r.text.includes('台式机'), JSON.stringify({ c: r.conflicts }));
}

// 2. 两边改同一段 → 报告冲突
{
  const ours = base.replace('第二段：原始内容。', '第二段：A 版本');
  const theirs = base.replace('第二段：原始内容。', '第二段：B 版本');
  const r = mergeText(base, ours, theirs);
  check('同一段落改动判为冲突', r.conflicts === 1 && r.text.includes('<<<<<<<'), JSON.stringify({ c: r.conflicts }));
}

// 3. 两边改成完全相同的内容 → 不算冲突
{
  const ours = base.replace('第二段：原始内容。', '第二段：一样的内容');
  const theirs = base.replace('第二段：原始内容。', '第二段：一样的内容');
  const r = mergeText(base, ours, theirs);
  check('两边改成同样内容不算冲突', r.conflicts === 0 && !r.text.includes('<<<<<<<'));
}

// 4. 一边只新增、一边只改中间段
{
  const ours = `${base}\n\n新增的一段（A）。`;
  const theirs = base.replace('第二段：原始内容。', '第二段：改过的。');
  const r = mergeText(base, ours, theirs);
  check('一边追加一边修改可合并', r.conflicts === 0 && r.text.includes('新增的一段') && r.text.includes('改过的'), JSON.stringify({ c: r.conflicts }));
}

// 4b. 追加位置紧挨着被改的最后一行 → 判为冲突（宁可多一个副本，不猜）
{
  const ours = `${base}\n\n新增的一段（A）。`;
  const theirs = base.replace('第三段：原始内容。', '第三段：改过的。');
  const r = mergeText(base, ours, theirs);
  check('紧邻改动的追加偏保守判冲突', r.conflicts >= 1, `conflicts=${r.conflicts}`);
}

// 5. 两边都在末尾追加不同内容 → 冲突
{
  const r = mergeText(base, `${base}\n\nA 的尾巴`, `${base}\n\nB 的尾巴`);
  check('末尾同时追加判为冲突', r.conflicts >= 1, `conflicts=${r.conflicts}`);
}

// 6. CRLF 行尾保持
{
  const crlfBase = base.replace(/\n/g, '\r\n');
  const ours = crlfBase.replace('第一段：原始内容。', '第一段：改 A');
  const theirs = crlfBase.replace('第三段：原始内容。', '第三段：改 B');
  const r = mergeText(crlfBase, ours, theirs);
  check('CRLF 文件合并后仍是 CRLF', r.conflicts === 0 && !/[^\r]\n/.test(r.text), JSON.stringify({ crlfOnly: !/[^\r]\n/.test(r.text) }));
}

// 7. 只有一边变化（另一方视为未改）→ 直接取变化方
{
  const ours = base.replace('第一段：原始内容。', '第一段：只有我改了');
  const r = mergeText(base, ours, base);
  check('单边改动原样通过', r.conflicts === 0 && r.text === ours);
}

// 8. 空文件与新增内容
{
  const r = mergeText('', '我写的第一行\n', '（另一台设备新建）\n');
  check('空基准下的双向新增判为冲突（不乱合）', r.conflicts >= 1, `conflicts=${r.conflicts}`);
}

// 9. 扩展名判断
check('只对文本笔记启用合并', isMergeablePath('a.md') && isMergeablePath('目录/b.markdown') && isMergeablePath('c.txt')
  && !isMergeablePath('图.png') && !isMergeablePath('a.pdf'));

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过\n`);
process.exit(pass === results.length ? 0 : 1);
