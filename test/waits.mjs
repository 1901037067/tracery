/* 等待实际状态，不用固定延迟代替加载/保存/布局完成。 */
async function diagnose(page,label,action) {
  try { return await action(); } catch(error) {
    const state=await page.evaluate(()=>({url:location.href,path:window.__tracery?.state.currentPath,editorPath:window.__tracery?.editor.path,dirty:window.__tracery?.editor.dirty,mode:window.__tracery?.editor.mode,viewport:[innerWidth,innerHeight]})).catch(()=>({url:page.url()}));
    error.message=`${label}: ${error.message}; ${JSON.stringify(state)}`;throw error;
  }
}
export function waitForApp(page) {
  return diagnose(page,'应用就绪',()=>page.waitForFunction(()=>window.__tracery?.state.tree&&window.__tracery.state.vault&&!document.getElementById('app').hidden&&typeof document.getElementById('btn-tab-more').onclick==='function'));
}
export function waitForNote(page,path,content) {
  return diagnose(page,'笔记就绪 '+path,()=>page.waitForFunction(({path,content})=>{
    const app=window.__tracery,editor=app?.editor;
    return app?.state.currentPath===path&&editor.path===path&&!editor._loading&&editor.getContent()===editor.view.state.doc.toString()&&(content===undefined||editor.getContent()===content);
  },{}, {path,content}));
}
export function waitForSaved(page,path,content) {
  return diagnose(page,'自动保存 '+path,()=>page.waitForFunction(async({path,content})=>{
    const editor=window.__tracery?.editor;if(editor?.path!==path||editor.dirty)return false;
    const response=await fetch('/api/note?path='+encodeURIComponent(path));if(!response.ok)return false;
    return (await response.json()).content===content;
  },{polling:100},{path,content}));
}
export function waitForLayout(page) {
  return diagnose(page,'布局就绪',async()=>{await waitForApp(page);return page.waitForFunction(()=>{
    document.body.getBoundingClientRect();
    const height=document.documentElement.style.getPropertyValue('--app-height');
    const viewportReady=innerWidth>900?!height:Math.abs(parseFloat(height)-(visualViewport?.height||innerHeight))<1;
    return viewportReady&&!document.getAnimations().some(animation=>animation instanceof CSSTransition&&animation.playState==='running');
  });});
}
