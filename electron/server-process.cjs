/* 只接受本次子进程的 IPC 就绪消息，不探测或复用端口上的其他 HTTP 服务。 */
const {spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const tokens=new WeakMap();
/** @param {{executable:string,entry:string,env:NodeJS.ProcessEnv,port:number,onLog?:(...args:unknown[])=>void,onProgress?:(data:any)=>void,timeout?:number,maxStartupMs?:number}} options */
exports.startServerProcess=({executable,entry,env,port,onLog=()=>{},onProgress=()=>{},timeout=30000,maxStartupMs=300000})=>{
  const nonce=randomBytes(32).toString('hex');
  const child=spawn(executable,[entry],{env:{...env,TRACERY_START_TOKEN:nonce},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  tokens.set(child,nonce);
  child.stdout.on('data',data=>onLog('[server]',String(data).trimEnd()));child.stderr.on('data',data=>onLog('[server:err]',String(data).trimEnd()));
  child.on('exit',code=>onLog('[server] 退出',code));
  const ready=new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(deadline);child.removeListener('message',message);child.removeListener('exit',exit);child.removeListener('error',fail);if(error){child.kill();reject(error);}else resolve(value);};
    const fail=error=>finish(error),exit=code=>fail(Error(`仓库服务未能启动（退出码 ${code}），请查看启动日志`));
    const message=data=>{
      if(data?.nonce!==nonce||data.pid!==child.pid)return;
      if(data.type==='tracery-progress') { clearTimeout(timer);timer=setTimeout(()=>fail(Error('仓库服务长时间没有响应，请检查磁盘和启动日志')),timeout);onProgress(data);return; }
      if(data.type==='tracery-start-error')return fail(Error(data.code==='EADDRINUSE'?`端口 ${port} 已被占用，请关闭重复服务后重新启动`:'仓库服务启动失败，请查看启动日志'));
      if(data.type==='tracery-ready'&&data.port===port)finish(null,{pid:child.pid,port});
    };
    let timer=setTimeout(()=>fail(Error('等待仓库服务就绪超时，请检查仓库磁盘和启动日志')),timeout);
    const deadline=setTimeout(()=>fail(Error('索引启动超过最长等待时间，请检查仓库磁盘和启动日志')),maxStartupMs);
    child.on('message',message);child.once('exit',exit);child.once('error',fail);
  });
  return {child,ready};
};

/* Windows kill 不执行信号清理：优先显式 IPC，等待实际退出，超时才强制结束。 */
exports.stopServerProcess=(child,timeout=20000)=>new Promise(resolve=>{
  if(!child||child.exitCode!==null||child.signalCode!==null)return resolve({graceful:true});
  let done=false;
  const finish=graceful=>{if(done)return;done=true;clearTimeout(timer);child.removeListener('exit',exit);resolve({graceful});};
  const exit=code=>finish(code===0);
  const timer=setTimeout(()=>{child.kill();finish(false);},timeout);
  child.once('exit',exit);
  if(child.connected)child.send({type:'tracery-shutdown',nonce:tokens.get(child)},error=>{if(error){child.kill();finish(false);}});
  else {child.kill();finish(false);}
});
