/**
 * Markdown round-trip 属性测试（保护 editor/markdown 双向引擎）
 * ------------------------------------------------------------------
 * 这个引擎是整个应用里最脆的一环：md → DOM（渲染）→ md（序列化）任何
 * 一环失真，用户「打开再保存」就会丢内容或产生无意义 diff（还会污染同步）。
 *
 * 四级契约：
 *   ① 恒等 identity   —— 格式规范的文档 serialize(render(md)) === md，
 *      对应真实场景「打开笔记、不编辑、保存」文件不能被动一个字节
 *   ② 不动点 fixpoint —— 任意（含怪格式）文档第二次 round-trip 后必须稳定，
 *      对应「渲染正常化只许发生一次，不能每次打开都变」
 *   ③ 内容不丢        —— 生成文档里的每个单词都必须出现在 DOM 文本里
 *   ④ 渲染确定性      —— 同一输入渲染两次，DOM 完全一致
 *
 * 另加 demo-vault 全量文件的不动点检查（真实语料）。
 * 在无头 Edge 里跑（真实 DOM），不是 jsdom 模拟。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9593;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-rt-home');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME },
  stdio: 'pipe',
});
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/api/state`)).ok) break; } catch { /* wait */ }
  await sleep(250);
}

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const log = [];
const check = (name, ok, detail = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const ENGINE = 'cm';   // v1.4.0 起只有 CM6 内核
await page.goto(`http://localhost:${PORT}/?engine=${ENGINE}`, { waitUntil: 'networkidle0' });
await sleep(1000);

// 在页面里装载引擎，并挂一个 round-trip 辅助函数
await page.evaluate(async () => {
  const mod = await import('/js/markdown.js');
  window.__rt = (md) => {
    const div = document.createElement('div');
    div.appendChild(mod.renderMarkdown(md));
    return mod.serializeHtml(div);
  };
  window.__renderHtml = (md) => {
    const div = document.createElement('div');
    div.appendChild(mod.renderMarkdown(md));
    return div.innerHTML;
  };
  window.__domText = (md) => {
    const div = document.createElement('div');
    div.appendChild(mod.renderMarkdown(md));
    return div.textContent;
  };
});

/* ================= ① 恒等语料（规范格式，必须逐字节回来） ================= */
const IDENTITY_CORPUS = [
  '# 标题\n\n正文一段。',
  '## 二级标题\n\n- 甲\n- 乙',
  '**加粗**与*斜体*与~~删除~~与==高亮==与`代码`',
  '[[双链]]、[[目标|别名]]、[外链](https://example.com)、https://bare.url',
  '![图](附件/图.png)、![[嵌入.png]]、![[嵌入.png|400]]、![](空alt.png)',
  '#标签 和文中的 #另一个标签',
  '- 无序\n- 列表\n  - 嵌套\n    - 更深',
  '1. 有序\n2. 第二\n3. 第三',
  '- [ ] 待办\n- [x] 完成',
  '> 引用一行\n> 引用二行',
  '> [!tip] 提示标题\n> 内容一\n> 内容二',
  '> [!note]\n> 无标题提示',
  '```js\nconst a = 1;\n```',
  '```\n无语言代码\n第二行\n```',
  '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |',
  '| 含**格式** | 含[[链接]] |\n| --- | --- |\n| `码` | ~~删~~ |',
  '---',
  '普通段\n第二行（软换行）',
  '多段\n\n第二段\n\n第三段',
  '- 列表中带 **格式**\n- 和 [[链接]]',
  '$$x^2$$ 和 $y$ 公式',
  '',
];

const rtResults = await page.evaluate((docs) => docs.map((md) => {
  let once, twice, err = null;
  try { once = window.__rt(md); twice = window.__rt(once); } catch (e) { err = String(e.message || e); }
  return { once, twice, err };
}), IDENTITY_CORPUS);

let idOk = 0;
const idFails = [];
rtResults.forEach((r, i) => {
  if (r.err) { idFails.push(`抛异常: ${JSON.stringify(IDENTITY_CORPUS[i])} → ${r.err}`); return; }
  if (r.once === IDENTITY_CORPUS[i]) idOk++;
  else idFails.push(`\n  输入: ${JSON.stringify(IDENTITY_CORPUS[i])}\n  输出: ${JSON.stringify(r.once)}`);
});
check(`恒等语料 ${idOk}/${IDENTITY_CORPUS.length} 逐字节 round-trip`, idFails.length === 0, idFails.join(''));

/* ================= ②③④ 模糊测试（种子可复现） ================= */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ['笔记', '内容', '测试', 'round', 'trip', '甲', '乙', '丙', ' Obsidian', 'alpha', 'beta'];
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

function genInline(rng, words) {
  // 只把「会渲染成可见文本」的词记进 words（嵌入目标 / 图片 alt / 链接 URL 不显示，不计入）
  const w = () => { const v = pick(rng, WORDS); words.push(v.trim()); return v; };
  const wHidden = () => pick(rng, WORDS);
  switch (Math.floor(rng() * 12)) {
    case 0: return w();
    case 1: return `**${w()}**`;
    case 2: return `*${w()}*`;
    case 3: return `~~${w()}~~`;
    case 4: return `==${w()}==`;
    case 5: return `\`${w()}\``;
    case 6: return `[[${w()}]]`;                    // 链接文本可见
    case 7: return `[[${wHidden()}|${w()}]]`;       // 只有别名可见
    case 8: return `[${w()}](${wHidden()})`;        // 只有链接文本可见，URL 进 href
    case 9: return `![${wHidden()}](${wHidden()}.png)`; // alt/URL 都不可见
    case 10: return `![[${wHidden()}.png]]`;        // 嵌入目标不显示
    default: return `#${w()}`;
  }
}
function genBlock(rng, words) {
  const inline = (n) => Array.from({ length: n }, () => genInline(rng, words)).join('');
  switch (Math.floor(rng() * 9)) {
    case 0: return `${'#'.repeat(1 + Math.floor(rng() * 3))} ${inline(2)}`;
    case 1: return inline(3);
    case 2: {
      const n = 1 + Math.floor(rng() * 3);
      return Array.from({ length: n }, (_, i) =>
        `${rng() < 0.3 ? '- [x] ' : '- '}${inline(2)}${i === 0 && rng() < 0.4 ? '\n  - ' + inline(1) : ''}`).join('\n');
    }
    case 3: return Array.from({ length: 2 + Math.floor(rng() * 2) }, (_, i) => `${i + 1}. ${inline(1)}`).join('\n');
    case 4: return `> ${inline(2)}\n> ${inline(1)}`;
    case 5: return `> [!${pick(rng, ['note', 'tip', 'warning'])}] ${inline(1)}\n> ${inline(2)}`;
    case 6: return '```' + pick(rng, ['', 'js', 'py']) + '\n' + inline(1) + '\nline two\n```';
    case 7: return `| ${inline(1)} | ${inline(1)} |\n| --- | --- |\n| ${inline(1)} | ${inline(1)} |`;
    default: return '---';
  }
}
const FUZZ_N = 300;
const fuzzDocs = [];
for (let seed = 1; seed <= FUZZ_N; seed++) {
  const rng = mulberry32(seed);
  const words = [];
  const blocks = Array.from({ length: 1 + Math.floor(rng() * 4) }, () => genBlock(rng, words));
  fuzzDocs.push({ seed, md: blocks.join('\n\n'), words: [...new Set(words)] });
}

const fuzz = await page.evaluate(({ docs }) => docs.map(({ seed, md, words }) => {
  let once, twice, render1, render2, domText, err = null;
  try {
    once = window.__rt(md);
    twice = window.__rt(once);
    render1 = window.__renderHtml(md);
    render2 = window.__renderHtml(md);
    domText = window.__domText(md);
  } catch (e) { err = String(e.message || e); }
  return { seed, md, words, once, twice, render1, render2, domText, err };
}), { docs: fuzzDocs });

const fpFails = [], errFails = [], detFails = [], lossFails = [];
for (const r of fuzz) {
  if (r.err) { errFails.push(`seed=${r.seed}: ${r.err}\n  ${JSON.stringify(r.md)}`); continue; }
  if (r.twice !== r.once) {
    fpFails.push(`seed=${r.seed}\n  一次: ${JSON.stringify(r.once)}\n  两次: ${JSON.stringify(r.twice)}`);
  }
  if (r.render1 !== r.render2) detFails.push(`seed=${r.seed} 两次渲染不一致`);
  const missing = r.words.filter((w) => w && !r.domText.includes(w));
  if (missing.length) lossFails.push(`seed=${r.seed} 丢词: ${missing.join(',')}\n  ${JSON.stringify(r.md)}`);
}
check(`模糊 ${FUZZ_N} 篇：无异常`, errFails.length === 0, errFails.slice(0, 2).join('\n'));
check(`模糊 ${FUZZ_N} 篇：不动点（二次 round-trip 稳定）`, fpFails.length === 0, fpFails.slice(0, 2).join('\n'));
check(`模糊 ${FUZZ_N} 篇：渲染确定性`, detFails.length === 0, detFails.slice(0, 2).join('\n'));
check(`模糊 ${FUZZ_N} 篇：内容不丢（单词全在 DOM 文本中）`, lossFails.length === 0, lossFails.slice(0, 2).join('\n'));

/* ================= demo-vault 真实语料：不动点 ================= */
const vaultFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^\./.test(e.name)) walk(p); }
    else if (/\.md$/i.test(e.name)) vaultFiles.push(p);
  }
};
walk(path.join(ROOT, 'demo-vault'));
const vaultDocs = vaultFiles.map((p) => ({ name: path.relative(ROOT, p), md: fs.readFileSync(p, 'utf8') }));

const vaultRt = await page.evaluate((docs) => docs.map(({ name, md }) => {
  let once, twice, err = null;
  try { once = window.__rt(md); twice = window.__rt(once); } catch (e) { err = String(e.message || e); }
  return { name, once, twice, err };
}), vaultDocs);

const vaultFails = [];
for (const r of vaultRt) {
  if (r.err) vaultFails.push(`${r.name}: 抛异常 ${r.err}`);
  else if (r.twice !== r.once) vaultFails.push(`${r.name}: 二次 round-trip 不稳定`);
}
check(`demo-vault ${vaultDocs.length} 篇真实语料：不动点`, vaultFails.length === 0, vaultFails.join('\n'));

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
