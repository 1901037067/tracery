import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProperties, writeProperties, validDate } from '../public/js/note-properties.js';
import { renderTemplate, BUILTIN_TEMPLATES } from '../public/js/note-templates.js';
import { parseSearch } from '../public/js/search-query.js';
import { Vault } from '../server/vault.js';
import { noteCatalog } from '../server/note-catalog.js';
import { parseMarkdown } from '../public/js/markdown.js';

const original = '\uFEFF---\r\n# original comment\r\ncourse: "数学" # keep unrelated fields\r\ncustom:\r\n  nested: [one, two]\r\ntags:\r\n  - 数学\r\n  - "AI/优化"\r\nreview: 2026-10-28\r\n---\r\n# 正文\r\n\r\n![[image.png|288]]\r\n\r\n```yaml\r\nstatus: example\r\n```\r\n';
assert.equal(readProperties(original).values.course, '数学');
assert.deepEqual(readProperties(original).values.tags, ['数学', 'AI/优化']);
const updated = writeProperties(original, { status: '学习中', mastery: 75, review: '2026-11-01' });
assert.equal(readProperties(updated).body, readProperties(original).body);
assert.ok(updated.startsWith('\uFEFF---\r\n# original comment\r\ncourse: "数学" # keep unrelated fields\r\ncustom:\r\n  nested: [one, two]\r\n'));
assert.deepEqual(readProperties(updated).values.tags, ['数学', 'AI/优化']);
assert.equal(readProperties(updated).values.mastery, 75);
assert.equal(writeProperties(updated, {}).replaceAll('\r\n', ''), updated.replaceAll('\r\n', ''));
assert.equal(writeProperties(updated, {}), updated);
assert.equal(readProperties(writeProperties(updated, { mastery: null })).values.mastery, undefined);
assert.equal(readProperties(writeProperties('正文\n', { course: 'a: "b" #c\nnext' })).values.course, 'a: "b" #c\nnext');
assert.equal(readProperties(writeProperties('---\n"course": "old"\n---\nbody', { course: 'new' })).values.course, 'new');
assert.throws(() => writeProperties('---\ncourse: {}\n---\nbody', { course: 'new' }), /复杂/);
assert.throws(() => writeProperties('---\ncourse: a\n课程: b\n---\nbody', { course: 'new' }), /重复/);
assert.throws(() => writeProperties('---\ncourse: a\nbody', { course: 'new' }), /结束/);
assert.throws(() => writeProperties('---\ncourse: "' + 'x'.repeat(65540) + '"\n---\nbody', { course: 'new' }), /64 KiB/);
assert.throws(() => writeProperties(original, { mastery: 101 }), /格式/);
assert.throws(() => writeProperties(original, { review: '2026-02-30' }), /日期/);
assert.ok(validDate('2028-02-29')); assert.equal(validDate('2026-02-29'), false);
assert.equal({}.polluted, undefined);
assert.equal(readProperties('---\n__proto__: "safe"\n---\n').values.__proto__, 'safe');
const now = new Date(2026, 9, 29, 9, 5);
assert.equal(renderTemplate('{{title}} {{date}} {{time}} {{datetime}} {{selection}} {{unknown}}', { title: '课', now, selection: '{{date}} <script>bad</script>' }), '课 2026-10-29 09:05 2026-10-29 09:05 {{date}} <script>bad</script> {{unknown}}');
assert.equal(readProperties(renderTemplate('---\ncourse: "{{title}}"\n---\n', { title: 'a"\nstatus: bad', now })).values.course, 'a"\nstatus: bad');
assert.equal(BUILTIN_TEMPLATES.length, 4);
const markdown = parseMarkdown('---\nstatus: 学习中\n---\n# 正文\n');
assert.equal(markdown.blocks[0].type, 'frontmatter'); assert.equal(markdown.blocks[1].type, 'heading'); assert.equal(markdown.blocks[1].line, 3);
assert.throws(() => parseSearch('path:"unclosed'), /引号/);
assert.throws(() => parseSearch('tag:'), /不能为空/);
assert.throws(() => parseSearch('x'.repeat(2049)), /2048/);
assert.equal(parseSearch('"hello world"').literal, 'hello world');
assert.equal(parseSearch('"path:课程"').terms[0].kind, 'text'); assert.equal(parseSearch('"-word"').terms[0].negative, false);
assert.equal(parseSearch('path:课程 tag:数学 -"考试 真题"').literal, null);

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tracery-note-tools-'));
let vault;
try {
  for (const [rel, text] of Object.entries({
    '课程 2026/梯度.md': '---\ncourse: 数学\nstatus: 学习中\nmastery: 75\nreview: 2020-01-01\ntags: [数学, AI/优化]\n---\n# 梯度\n梯度 下降\n',
    '课程 2026/导数.md': '---\ncourse: 数学\nstatus: 已掌握\nmastery: 90\nreview: 2099-01-01\n---\n梯度下降 #数学\n',
    '归档/梯度考试.md': '# 梯度下降 考试 #数学\n',
    '零值.md': '---\nmastery: 0\n---\n# 零值',
    '无属性.md': '# no properties',
  })) { await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true }); await fs.writeFile(path.join(home, rel), text); }
  vault = new Vault(home); await vault.open();
  assert.deepEqual(vault.search('path:"课程 2026" tag:数学 "梯度下降" -考试').map(row => row.path), ['课程 2026/导数.md']);
  assert.deepEqual(vault.search('tag:AI -path:归档').map(row => row.path), ['课程 2026/梯度.md']);
  assert.equal(vault.search('梯度 下降 -path:归档').length, 2);
  assert.equal(vault.search('tag:数学').length, 3);
  assert.equal(vault.search('-tag:数学').length, 2);
  assert.deepEqual(vault.search('\n'), []);
  assert.equal(noteCatalog(vault, new URLSearchParams({ course: '数学', status: '学习中', due: 'true' })).total, 1);
  assert.deepEqual(noteCatalog(vault, new URLSearchParams({ mastery: '80' })).rows.map(row => row.path), ['课程 2026/导数.md']);
  const rows = noteCatalog(vault, new URLSearchParams({ sort: 'mastery', direction: 'asc' })).rows;
  assert.equal(rows[0].properties.mastery, 0); assert.equal(rows.at(-1).properties.mastery, null);
  assert.equal(noteCatalog(vault, new URLSearchParams({ sort: 'mastery', direction: 'desc' })).rows[0].properties.mastery, 90);
  assert.equal(noteCatalog(vault, new URLSearchParams({ limit: '2', offset: '2' })).rows.length, 2);
  await vault.close(); vault = new Vault(home); await vault.open();
  assert.equal(vault.stats.reads, 0, 'warm index must reuse note content');
  assert.equal(vault.search('tag:AI/优化').length, 1);
  const before = await fs.readFile(path.join(home, '课程 2026/梯度.md'), 'utf8');
  await fs.writeFile(path.join(home, '课程 2026/梯度.md'), writeProperties(before, { tags: ['新标签'], mastery: 88 }));
  await vault.applyChange('课程 2026/梯度.md');
  assert.equal(vault.search('tag:AI').length, 0); assert.equal(vault.search('tag:新标签').length, 1);
  console.log('PASS frontmatter byte preservation, bounded non-executable templates/search, quoted/negative/path/tag queries, property filters/paging/zero/missing sorts, warm-cache tags and incremental update');
} finally { await vault?.close(); await fs.rm(home, { recursive: true, force: true }); }
