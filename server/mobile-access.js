/* 手机网页访问的独立监听、短时邀请和进程内会话；与仓库同步配对分离。 */
import http from 'node:http';
import crypto from 'node:crypto';
import { phoneAccess } from './access.js';
const readApis = new Set(['/api/state','/api/tree','/api/drawings','/api/note','/api/links','/api/search','/api/tags','/api/graph','/api/file','/api/history','/api/history/content','/api/trash']);
const writeApis = new Map([['/api/note','PUT'],['/api/note/create','POST'],['/api/asset','POST'],['/api/rename','POST'],['/api/delete','POST'],['/api/history/restore','POST'],['/api/replace','POST'],['/api/trash/restore','POST'],['/api/references/relink','POST']]);
const denied = (message,status=403) => Object.assign(new Error(message),{status});
export function createMobileAccess({handler,upgrade,onRevoke=()=>{},now=Date.now,port=0}) {
  let listener=null, invitation=null, operation=Promise.resolve();
  const sessions=new Map(),attempts=new Map();
  const cookie='tracery_mobile_'+crypto.randomBytes(8).toString('hex');
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  function renew(mode) { invitation={code:crypto.randomInt(0,1000000).toString().padStart(6,'0'),mode,expiresAt:now()+5*60000}; }
  function session(req) {
    const value=String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(cookie+'='))?.slice(cookie.length+1);
    const item=sessions.get(value);
    if(!item||item.expiresAt<=now()) { if(item){sessions.delete(value);onRevoke(value);}return null; }
    return {id:value,...item};
  }
  function revoke() { sessions.clear();onRevoke(); }
  function queue(job){const result=operation.then(job);operation=result.catch(()=>{});return result;}
  const timer=setInterval(()=>{for(const [id,item] of sessions)if(item.expiresAt<=now()){sessions.delete(id);onRevoke(id);}for(const [ip,item]of attempts)if(item.resetAt<=now())attempts.delete(ip);},10000);timer.unref();
  return {
    async dispose() { clearInterval(timer); await this.stop(); attempts.clear(); },
    status() {
      const port=listener?.address()?.port;
      return {enabled:!!port,addresses:port?phoneAccess(port).addresses:[],requiresComputer:true,sessions:[...sessions.values()].filter(s=>s.expiresAt>now()).length,
        invitation:invitation&&invitation.expiresAt>now()?{...invitation}:null};
    },
    start(mode='read') {return queue(async()=>{
      if(!['read','write'].includes(mode))throw denied('访问权限不合法',400);
      if(!listener){
        const next=http.createServer((req,res)=>{req.mobile=true;handler(req,res);});
        next.on('upgrade',(req,socket,head)=>{req.mobile=true;upgrade(req,socket,head);});
        try{await new Promise((resolve,reject)=>{next.once('error',reject);next.listen(port,'0.0.0.0',resolve);});}
        catch(error){next.close();if(error.code==='EADDRINUSE')throw denied(`手机访问端口 ${port} 已被占用，请关闭占用程序后重试；电脑本机仍可正常使用`,409);throw error;}
        listener=next;
      }
      renew(mode);return this.status();
    });},
    stop(){return queue(async()=>{
      invitation=null;revoke();const previous=listener;listener=null;
      if(previous)await new Promise(resolve=>{previous.close(resolve);previous.closeAllConnections();});
      return this.status();
    });},
    revoke(){revoke();invitation=null;return this.status();},
    session,
    authorize(req,url) {
      const current=session(req);
      if(!current)throw denied('请在电脑开启手机访问并输入通行码',401);
      req.mobileSession=current;
      const p=url.pathname,read=['GET','HEAD'].includes(req.method);
      if(p.startsWith('/api/')) {
        if(read&&readApis.has(p))return current;
        if(!read&&current.mode==='write'&&writeApis.get(p)===req.method)return current;
        throw denied(current.mode==='read'?'当前会话仅可查看；请在电脑授权读写':'此操作只能在电脑本机进行');
      }
      if(!read)throw denied('不支持此请求方式',405);
      return current;
    },
    authorizeSocket(req) {
      const current=session(req);if(!current)throw denied('手机访问会话已失效',401);return current;
    },
    async publicRequest(req,res,url,readBody) {
      const p=url.pathname;
      if(p==='/api/access/pair'&&req.method==='POST') {
        const ip=req.socket.remoteAddress;
        let rate=attempts.get(ip);if(!rate||rate.resetAt<=now()){rate={count:0,resetAt:now()+10*60000};attempts.set(ip,rate);}
        if(rate.count>=5)throw denied('尝试次数过多，请稍后重试',429);
        const {code}=await readBody(req,1024);
        // 读取正文会让出事件循环；并发请求也必须共用同一重试上限。
        if(rate.count>=5)throw denied('尝试次数过多，请稍后重试',429);
        const supplied=Buffer.from(String(code||'')),expected=Buffer.from(invitation?.code||'');
        if(!invitation||invitation.expiresAt<=now()||supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)){++rate.count;throw denied('通行码无效或已过期',401);}
        if(sessions.size>=16)throw denied('会话已达上限，请在电脑撤销旧访问',429);
        const id=crypto.randomBytes(32).toString('base64url'),mode=invitation.mode;
        const previous=session(req);if(previous){sessions.delete(previous.id);onRevoke(previous.id);}
        sessions.set(id,{mode,expiresAt:now()+12*60*60000});invitation=null;
        res.setHeader('Set-Cookie',`${cookie}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        json(res,200,{ok:true,mode});return true;
      }
      if(p==='/api/access/logout'&&req.method==='POST') {
        const current=session(req);if(current){sessions.delete(current.id);onRevoke(current.id);}
        res.setHeader('Set-Cookie',`${cookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);json(res,200,{ok:true});return true;
      }
      if(p==='/sw.js'){res.writeHead(404,{'Cache-Control':'no-store'});res.end();return true;}
      // 登录页及其静态依赖没有仓库数据；其他页面在授权前返回登录入口。
      if(['GET','HEAD'].includes(req.method)&&['/mobile-login.html','/js/mobile-login.js','/css/mobile-login.css','/favicon.ico'].includes(p))return false;
      if(!session(req)&&!p.startsWith('/api/')){res.writeHead(303,{Location:'/mobile-login.html','Cache-Control':'no-store'});res.end();return true;}
      this.authorize(req,url);return false;
    },
  };
}
