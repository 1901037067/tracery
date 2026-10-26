/* 只接受本次子进程的 IPC 就绪消息，不探测或复用端口上的其他 HTTP 服务。 */
const {spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');
/** @param {{executable:string,entry:string,env:NodeJS.ProcessEnv,port:number,onLog?:(...args:unknown[])=>void,timeout?:number}} options */
exports.startServerProcess=({executable,entry,env,port,onLog=()=>{},timeout=30000})=>{
  const nonce=randomBytes(32).toString('hex');
  const child=spawn(executable,[entry],{env:{...env,TRACERY_START_TOKEN:nonce},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.on('data',data=>onLog('[server]',String(data).trimEnd()));child.stderr.on('data',data=>onLog('[server:err]',String(data).trimEnd()));
  child.on('exit',code=>onLog('[server] 退出',code));
  const ready=new Promise((resolve,reject)=>{
    const finish=(error,value)=>{clearTimeout(timer);child.removeListener('message',message);child.removeListener('exit',exit);child.removeListener('error',fail);if(error){child.kill();reject(error);}else resolve(value);};
    const fail=error=>finish(error),exit=code=>fail(Error(`仓库服务未能启动（退出码 ${code}），请查看启动日志`));
    const message=data=>{
      if(data?.nonce!==nonce||data.pid!==child.pid)return;
      if(data.type==='tracery-start-error')return fail(Error(data.code==='EADDRINUSE'?`端口 ${port} 已被占用，请关闭重复服务后重新启动`:'仓库服务启动失败，请查看启动日志'));
      if(data.type==='tracery-ready'&&data.port===port)finish(null,{pid:child.pid,port});
    };
    const timer=setTimeout(()=>fail(Error('等待仓库服务就绪超时，请检查仓库磁盘和启动日志')),timeout);
    child.on('message',message);child.once('exit',exit);child.once('error',fail);
  });
  return {child,ready};
};
