// REA 证据提取 v3：webpack 模块归属、import 边、导出名、局限说明
// 注：原始分析结果 test/rea-obsidian-raw.json（231MB）体积过大，提取后已删除；
//     提取结论保留在 test/rea-evidence.json。重新生成需重跑：
//     rea analyze-javascript-application <obsidian.asar> --format json --max-heap-mb 2048 --analysis-timeout-ms 600000
import fs from 'node:fs';

const raw = JSON.parse(fs.readFileSync('test/rea-obsidian-raw.json', 'utf8'));
const obs = raw.details?.partial_observation;
const norm = obs.normalized_result;
const g = norm.graph;
const nodes = g.nodes;
const edges = g.edges || [];

const propsOf = (n) => n.observations?.[0]?.properties || {};
const byId = new Map(nodes.map((n) => [n.node_id, n]));

const out = {};

// webpack 模块按 bundle 归组
const bundles = {};
for (const n of nodes) {
  if (n.kind !== 'javascript-module') continue;
  const p = propsOf(n);
  const bundle = p.path || '(unknown)';
  bundles[bundle] = bundles[bundle] || { count: 0, bundler: p.bundler || null, exports: [] };
  bundles[bundle].count++;
  if (Array.isArray(p.exports)) {
    bundles[bundle].exports.push(...p.exports.map((e) => ({ mod: n.identity?.key, name: e })));
  }
}
out.bundles = bundles;

// import 边（specifier 形式）
const imports = [];
for (const e of edges) {
  const s = byId.get(e.source_node_id);
  const t = byId.get(e.target_node_id);
  const p = e.properties || {};
  imports.push({
    relation: e.relation,
    kind: p.kind,
    specifier: p.specifier,
    fromBundle: s ? (propsOf(s).path || s.identity?.key) : null,
    fromKey: s?.identity?.key,
    toBundle: t ? (propsOf(t).path || t.identity?.key) : null,
    toKey: t?.identity?.key,
    resolved: p.resolved_path,
    confidence: e.evidence?.confidence,
  });
}
out.importCount = imports.length;
out.importSpecifiers = [...new Set(imports.map((i) => `${i.kind}:${i.specifier}`))].slice(0, 200);
// 外部/裸模块 specifier（非数字 webpack id 的）
out.externalSpecifiers = [...new Set(imports
  .filter((i) => i.specifier && !/^\d+$/.test(i.specifier))
  .map((i) => `${i.kind} '${i.specifier}' (in ${i.fromBundle})`))].slice(0, 120);

// 有趣的导出名（Obsidian API 痕迹）
const interesting = [];
for (const [bundle, info] of Object.entries(bundles)) {
  for (const e of info.exports) {
    if (/^(Vault|TFile|TFolder|TAbstractFile|MetadataCache|Workspace|App|Plugin|Editor|MarkdownView|FileView|Notice|Setting|Modal|PluginSettingTab| normalizePath|requestUrl|Keymap|Component)$/.test(e.name)) {
      interesting.push({ bundle, mod: e.mod, name: e.name });
    }
  }
}
out.obsidianApiExports = interesting.slice(0, 100);

out.limitations = g.limitations || [];
out.coverage = g.coverage || null;
out.rootNodeIds = g.root_node_ids;
out.graphId = g.graph_id;

fs.writeFileSync('test/rea-evidence.json', JSON.stringify(out, null, 2));

console.log('=== bundles ===');
for (const [b, info] of Object.entries(bundles)) console.log(`  ${b}: ${info.count} modules (bundler=${info.bundler})`);
console.log('importCount:', out.importCount);
console.log('=== external/bare specifiers (first 60) ===');
for (const s of out.externalSpecifiers.slice(0, 60)) console.log('  ', s);
console.log('=== obsidian API exports ===');
for (const e of out.obsidianApiExports.slice(0, 40)) console.log('  ', e.bundle, `module ${e.mod} exports`, e.name);
console.log('=== limitations ===');
console.log(JSON.stringify(out.limitations, null, 1).slice(0, 2000));
