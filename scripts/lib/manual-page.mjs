/* 生成一个没有外部依赖的验收页面：离线填写、筛选和导出，结果只保存在本机浏览器。 */
export function manualPage(cases, vault, icon) {
  const payload = JSON.stringify({ cases, vault }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tracery · 本地验收清单</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:#202838;font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1100px;margin:auto;padding:32px 24px 80px}header{display:flex;gap:18px;align-items:center}header img{width:68px;border-radius:14px}h1{font-size:28px;margin:0}h2{font-size:19px;margin:28px 0 12px}.muted{color:#64748b}p{margin:8px 0 16px}.notice{border-left:4px solid #168da3;padding:14px 18px;background:#e8f6f8;border-radius:8px}.bar,.meta{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}label{display:flex;gap:7px;align-items:center}input,select,textarea,button{font:inherit;color:inherit;border:1px solid #cbd5e1;border-radius:7px;background:white;padding:8px 10px}input{min-width:100px}#search{flex:1;min-width:230px}button{cursor:pointer}button.primary{background:#176bd7;color:white;border-color:#176bd7}button:hover{filter:brightness(.96)}.stats{display:flex;flex-wrap:wrap;gap:12px}.stat{background:white;border:1px solid #e0e6ef;border-radius:10px;padding:12px 18px;min-width:124px}.stat strong{display:block;font-size:25px}.case{background:white;border:1px solid #dce3ed;border-radius:9px;margin:10px 0;overflow:hidden}.case[data-status=fail]{border-color:#e48888}.case[data-status=pass]{border-color:#77bca2}summary{cursor:pointer;padding:15px;display:flex;gap:10px;align-items:center;list-style:none}summary:before{content:'▸';color:#64748b}.case[open]>summary:before{content:'▾'}.id{font-variant-numeric:tabular-nums;color:#516276}.title{font-weight:600;flex:1}.badge{font-size:12px;border-radius:4px;padding:2px 7px;background:#edf2fa}.p0{background:#fff0e0;color:#9b5300}.status{min-width:54px;text-align:right}.content{padding:0 20px 18px;border-top:1px solid #edf0f5}dl{display:grid;grid-template-columns:72px 1fr;gap:9px 16px}dt{color:#64748b}dd{margin:0;white-space:pre-wrap}.result-row{display:flex;align-items:flex-start;gap:15px;flex-wrap:wrap}textarea{width:100%;resize:vertical;min-height:75px}.notes{flex:1;min-width:230px;display:block}small{color:#64748b}code{background:#e8edf3;border-radius:4px;padding:2px 5px;word-break:break-all}#empty{padding:32px;text-align:center}#storage{color:#a43d28}[hidden]{display:none!important}@media(max-width:650px){main{padding:20px 12px}h1{font-size:22px}.meta label{display:block;width:100%}.meta input{width:100%}.badge.physical{display:none}summary{padding:12px;gap:7px}dl{display:block}dt{margin-top:12px}header img{width:52px}}
</style><main>
<header><img alt="Tracery 新图标" src="data:image/png;base64,${icon}"><div><h1>Tracery 本地验收清单</h1><div class="muted">逐项操作 · 留下证据 · 本机保存</div></div></header>
<p class="notice">这是现场验收用例，不是已通过结果。请只操作生成的测试仓库；高风险异常场景只在副本中复现。自动测试、实体手机、两台电脑与系统图标显示分别记录。</p>
<p>测试仓库：<code id="vault"></code><br><small>此页无需联网。填写内容尽量同时导出备份；浏览器清理站点数据或移动页面后，本地记录可能不可用。</small></p>
<div class="meta"><label>测试者 <input id="tester" placeholder="姓名 / 昵称"></label><label>构建版本 <input id="build" placeholder="如 1.4.2 + 测试日期"></label><label>设备与系统 <input id="platform" placeholder="Windows / 手机 / 浏览器版本"></label></div>
<div class="stats" id="stats" aria-live="polite"></div>
<div class="bar"><input type="search" id="search" aria-label="搜索用例" placeholder="搜索：光标、附件、手机、同步…"><select id="area" aria-label="功能分组"><option value="">全部功能</option></select><select id="status-filter" aria-label="结果筛选"><option value="">全部结果</option><option value="pending">未测</option><option value="pass">通过</option><option value="fail">失败</option><option value="blocked">待环境</option></select><select id="priority" aria-label="优先级"><option value="">全部优先级</option><option>P0</option><option>P1</option></select></div>
<div class="bar"><button class="primary" id="export-json">导出 JSON 结果</button><button id="export-md">导出 Markdown 结果</button><button id="expand">展开可见用例</button><button id="collapse">收起全部</button></div>
<p id="storage" role="status"></p><div id="list"></div><p id="empty" hidden>没有匹配的用例。</p>
<p class="muted">P0：数据安全、核心使用与交付必测。P1：兼容与体验。标记“实体设备”的项目需现场补验。失败时请记录复现步骤、实际结果、截图位置和日志，不要仅写“不能用”。</p>
</main><script>
const DATA=${payload};
const names={pending:'未测',pass:'通过',fail:'失败',blocked:'待环境'};
const key='tracery-manual-qa-v1';let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')||{}}catch(e){}
let records=saved.records||{},meta=saved.meta||{};const byId=id=>document.getElementById(id);
byId('vault').textContent=DATA.vault;
function save(){try{localStorage.setItem(key,JSON.stringify({records,meta}));byId('storage').textContent=''}catch(e){byId('storage').textContent='浏览器不允许本地持久保存，请及时导出结果。'}}
for(const id of ['tester','build','platform']){byId(id).value=meta[id]||'';byId(id).oninput=()=>{meta[id]=byId(id).value;save()}}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
const groups=[];
for(const area of [...new Set(DATA.cases.map(c=>c.area))]){
  byId('area').add(new Option(area,area));const group=el('section');group.append(el('h2','',area));byId('list').append(group);groups.push(group);
  for(const c of DATA.cases.filter(c=>c.area===area)){
    const record=records[c.id]||{status:'pending',notes:''};if(!names[record.status])record.status='pending';records[c.id]=record;
    const card=el('details','case');card.dataset.id=c.id;card.dataset.status=record.status;card._case=c;
    const summary=el('summary');summary.append(el('span','id',c.id),el('span','badge '+c.priority.toLowerCase(),c.priority),el('span','title',c.title));if(c.physical)summary.append(el('span','badge physical','实体设备'));const badge=el('span','status',names[record.status]);summary.append(badge);card.append(summary);
    const content=el('div','content'),dl=el('dl');for(const [label,field] of [['前提','precondition'],['操作','steps'],['预期','expected']])dl.append(el('dt','',label),el('dd','',c[field]));content.append(dl);
    const row=el('div','result-row'),label=el('label','','结果 '),select=el('select');select.setAttribute('aria-label',c.id+' 结果');for(const [value,text]of Object.entries(names))select.add(new Option(text,value));select.value=record.status;label.append(select);row.append(label);
    const noteLabel=el('label','notes','实际结果 / 证据 '),note=el('textarea');note.value=record.notes||'';note.placeholder='复现步骤、差异、截图或日志路径';note.setAttribute('aria-label',c.id+' 记录');noteLabel.append(note);row.append(noteLabel);content.append(row);card.append(content);group.append(card);
    select.onchange=()=>{record.status=select.value;card.dataset.status=select.value;badge.textContent=names[select.value];save();refresh()};note.oninput=()=>{record.notes=note.value;save()};
  }
}
function refresh(){const counts={pending:0,pass:0,fail:0,blocked:0};for(const c of DATA.cases)counts[records[c.id].status]++;byId('stats').replaceChildren();for(const [label,n]of [['用例总数',DATA.cases.length],...Object.entries(counts).map(([s,n])=>[names[s],n])]){const stat=el('div','stat');stat.append(el('strong','',n),el('span','',label));byId('stats').append(stat)}
  const query=byId('search').value.trim().toLowerCase(),area=byId('area').value,status=byId('status-filter').value,priority=byId('priority').value;let visible=0;
  for(const card of document.querySelectorAll('.case')){const c=card._case;card.hidden=!!((area&&c.area!==area)||(status&&records[c.id].status!==status)||(priority&&c.priority!==priority)||(query&&!Object.values(c).join(' ').toLowerCase().includes(query)));if(!card.hidden)visible++}
  for(const group of groups)group.hidden=![...group.querySelectorAll('.case')].some(c=>!c.hidden);byId('empty').hidden=visible>0;
}
for(const id of ['search','area','status-filter','priority'])byId(id).addEventListener('input',refresh);
byId('expand').onclick=()=>document.querySelectorAll('.case:not([hidden])').forEach(c=>c.open=true);byId('collapse').onclick=()=>document.querySelectorAll('.case').forEach(c=>c.open=false);
function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=el('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function report(){return{exportedAt:new Date().toISOString(),meta,vault:DATA.vault,limitations:'自动测试与现场结果分开；未测不代表通过。当前没有完整手机离线仓库或独立只读授权。',cases:DATA.cases.map(c=>({...c,...records[c.id]}))}}
byId('export-json').onclick=()=>download('Tracery-验收结果.json',JSON.stringify(report(),null,2),'application/json');
byId('export-md').onclick=()=>{const r=report();let lines=['# Tracery 现场验收结果','','时间：'+r.exportedAt,'测试者：'+(meta.tester||'未填'),'构建：'+(meta.build||'未填'),'设备：'+(meta.platform||'未填'),'仓库：'+r.vault,'',r.limitations,''];for(const c of r.cases)lines.push('## '+c.id+' '+c.title+' · '+names[c.status],'','优先级：'+c.priority+' · '+c.area,'前提：'+c.precondition,'操作：'+c.steps,'预期：'+c.expected,'实际与证据：'+(c.notes||'未记录'),'');download('Tracery-验收结果.md',lines.join('\\n'),'text/markdown;charset=utf-8')};refresh();
</script></html>`;
}
