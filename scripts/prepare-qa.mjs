/* 生成可丢弃的手工验收仓库和本地清单；再次运行默认保留已有测试笔记与测试结果。 */
import fs from 'node:fs';
import path from 'node:path';
import { cases } from '../test/manual-cases.mjs';
import { manualPage } from './lib/manual-page.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist/qa');
fs.mkdirSync(OUT, { recursive: true });
const fresh = process.argv.includes('--fresh');
const vault = path.join(OUT, fresh ? '验收仓库-' + new Date().toISOString().replaceAll(/[:.]/g, '-') : '验收仓库');
const put = (file, content) => { const dest = path.join(vault, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, content); };

// 两页确定性 PDF 仅作为附件回归样本；用真实字体的复杂 PDF 应另由用户现场补验。
function samplePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>', '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [index, page] of [[3, 1], [5, 2]]) { const stream = `BT /F1 24 Tf 60 740 Td (Tracery QA - Page ${page} of 2) Tj ET\n`; objects[index] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`; }
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}
if (!fs.existsSync(vault)) {
  fs.mkdirSync(vault);
  put('00-验收入口.md', '# Tracery 专用验收仓库\n\n这是可丢弃的测试数据，请勿替换真实笔记。\n\n- [[01-编辑与定位]]\n- [[双链与标签]]\n- [[附件与PDF]]\n- [[长文压力]]\n- [[同步/同步样例]]\n\n#验收 #本地\n');
  const lines = ['# 编辑与定位', '', '> [!note] 点击定位测试', '> 上方 Callout 与标题不应让下方光标偏移。', '', '## 同名标题', '', '第一处同名标题。', '', '### 子标题', '', '- 无序列表', '- [ ] 未完成任务', '- [x] 完成任务', '', '| 名称 | 状态 |', '| --- | --- |', '| 中文 | 正常 |', '', '## 同名标题', '', '第二处同名标题。'];
  while (lines.length < 31) lines.push(lines.length % 2 ? '' : '定位填充：请对照左边行号。');
  lines.push('## 第32行标题：请直接点击这里', '', '- [ ] 第34行任务一', '- [ ] 第35行任务二', '- [ ] 第36行任务三', '', '普通段落用于回车、退格、选区、中文输入法和自动换行测试。', '', '```javascript', 'console.log("Tracery QA");', '```', '', '#验收 #编辑');
  put('01-编辑与定位.md', lines.join('\n') + '\n');
  put('项目甲/同名.md', '# 项目甲的同名笔记\n\n甲唯一关键词：蓝鲸甲。\n\n## 标题锚点\n\n甲项目内容。\n');
  put('项目乙/同名.md', '# 项目乙的同名笔记\n\n乙唯一关键词：海豚乙。\n');
  put('双链与标签.md', '# 双链与标签\n\n[[项目甲/同名]] · [[项目乙/同名]]\n\n[[项目甲/同名|甲项目别名]] · [[项目甲/同名#标题锚点]]\n\n歧义：[[同名]]；缺失：[[尚未创建-验收]]\n\n![[项目乙/同名]]\n\n#验收 #项目/甲 #中文标签\n');
  put('附件与PDF.md', '# 附件与 PDF\n\n![[附件/品牌 图标.png]]\n\n[打开两页PDF](附件/两页样本.pdf)\n\n[[附件/中文 空格.txt]]\n\n在此测试图片粘贴、文件拖放和绘图插入。\n');
  put('附件/品牌 图标.png', fs.readFileSync(path.join(ROOT, 'public/icon.png')));
  put('附件/中文 空格.txt', 'Tracery UTF-8 附件样本\n中文、空格与换行。\n');
  put('附件/两页样本.pdf', samplePdf());
  put('导入/BOM.md', '\uFEFF# 带 BOM 的标题\n\n兼容性验收：记录首标题的实际渲染情况。\n');
  put('导入/CRLF.md', '# CRLF 文件\r\n\r\n第一段中文。\r\n第二段。\r\n');
  put('长文压力.md', '# 三千行长文\n\n' + Array.from({ length: 3000 }, (_, i) => `${i % 100 === 0 ? '## ' : ''}第${i + 1}段：长文定位与滚动验收，唯一索引 QA-${String(i + 1).padStart(4, '0')}。`).join('\n') + '\n');
  put('同步/同步样例.md', '# 同步样例\n\n第一段由设备甲修改。\n\n第二段由设备乙修改。\n\n共享冲突行：原始文字。\n');
  put('待删除/子目录/恢复测试.md', '# 删除与恢复\n\n恢复目录后，这段文字和层级应保持完整。\n');
  put('空白笔记.md', ''); fs.mkdirSync(path.join(vault, '空文件夹'));
  put('.qa-fixture.json', JSON.stringify({ createdAt: new Date().toISOString(), disposable: true }, null, 2));
}
const icon = fs.readFileSync(path.join(ROOT, 'public/icon.png')).toString('base64');
fs.writeFileSync(path.join(OUT, 'manual-test.html'), manualPage(cases, vault, icon));
fs.writeFileSync(path.join(OUT, 'TEST-CASES.json'), JSON.stringify(cases, null, 2));
fs.writeFileSync(path.join(OUT, 'TEST-CASES.md'), '# Tracery 手工验收用例\n\n以下均为待执行用例，非已通过声明。仅使用测试副本；实体手机与双电脑项目需现场补验。\n\n' + cases.map(c => `## ${c.id} ${c.title}\n\n- 功能：${c.area}；${c.priority}${c.physical ? '；实体设备' : ''}\n- 前提：${c.precondition}\n- 操作：${c.steps}\n- 预期：${c.expected}\n- 结果：[ ] 通过 [ ] 失败 [ ] 待环境 [ ] 未测\n- 实际与证据：\n`).join('\n'));
fs.writeFileSync(path.join(OUT, '使用说明.md'), `# 本地验收包\n\n1. 双击 manual-test.html，填写设备与版本信息，先做 P0；筛选功能和结果，记录差异，导出 JSON / Markdown。页面不发送网络请求。\n2. 用 Tracery 的“打开仓库”选择：${vault}\n3. 不要在真实仓库测试删除、覆盖、冲突、只读或异常退出。双电脑同步先复制两份验收仓库。手机访问会写入电脑当前仓库，没有独立只读授权。\n4. 自动回归在源码目录运行：\n\n\`\`\`powershell\nnpm run test:smoke\nnpm run test:core\nnpm run test:all\n# 单独重测指定套件\nnode test/run-suite.mjs only icons cursor sidebar\n\`\`\`\n\n需要本地 Node 和项目依赖，以及默认路径下的 Edge（可用 TRACERY_BROWSER 指定）。全量共29个套件，串行运行，报告在 dist/test-runs/<运行编号>/REPORT.md；失败日志保留。已占用测试端口时先关闭自己之前启动的测试实例。\n\n自动运行复制当前工作区到 dist 的每套件隔离目录；配置、测试笔记、截图写副本，不覆盖源演示笔记。网络测试会启动自己的本地监听和局域网发现；mDNS、UDP回退、配对授权分别检查。\n\n再次运行 npm run qa:prepare 会保留已有验收仓库。需要全新样本：npm run qa:prepare -- --fresh（另建带时间的目录）。页面填写结果也默认保留；导出文件请另行备份。\n\n普通手机网页、mDNS发现、PWA安装和整库离线是四种不同能力。当前手机读写需要电脑运行，SW只缓存应用资源；不支持电脑关闭后独立浏览整库。实体手机、Windows系统图标缓存、真实IME和跨设备网络仍需手工验收。\n\n此目录是被Git忽略的本地验收材料，不属于对外发布文档。\n`);
console.log(`已准备 ${cases.length} 条现场用例\n清单：${path.join(OUT, 'manual-test.html')}\n仓库：${vault}\n自动检测：npm run test:smoke / npm run test:all`);
