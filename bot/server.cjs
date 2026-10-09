'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {today,almanac,format,parse,messages,split}=require('./core.cjs');
const HELP='老黄历机器人\n/today 今天黄历（北京时间）\n/date 2026-10-18 指定日期\n/ask 2026-10-18 解释宜忌\n/ask 解释今天宜忌\n/id 查看你的用户ID\n\n查询不调用AI，只有 /ask 使用DeepSeek。解读问题及当日黄历会发给DeepSeek，不发送Telegram身份。';
async function post(url, body, headers={}, timeout=45000) {
  let response;
  try {response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});}
  catch {throw new Error('网络连接失败或超时');}
  if(!response.ok) throw new Error(`接口HTTP ${response.status}`);
  let data; try {data=await response.json();} catch {throw new Error('接口返回格式错误');}
  return data;
}
async function analyze(config,a,question,request=post) {
  if(!config.key) throw new Error('尚未配置DeepSeek');
  const data=await request('https://api.deepseek.com/chat/completions',{model:config.model,thinking:{type:'disabled'},messages:messages(a,question),max_tokens:1200,stream:false},{Authorization:`Bearer ${config.key}`},60000);
  const choice=data?.choices?.[0];
  if(typeof choice?.message?.content!=='string' || !choice.message.content.trim()) throw new Error('AI未返回可用解读');
  return choice.message.content.trim()+(choice.finish_reason==='length'?'\n（解读达到长度上限）':'');
}
function loadState(file) {
  if(!fs.existsSync(file)) return {offset:0,day:'',used:0};
  const s=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Number.isSafeInteger(s.offset)||s.offset<0||!Number.isSafeInteger(s.used)||s.used<0||typeof s.day!=='string') throw new Error('状态文件损坏，请检查后恢复备份');
  return s;
}
function saveState(file,s) {fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); fs.writeFileSync(file+'.tmp',JSON.stringify(s),{mode:0o600}); fs.renameSync(file+'.tmp',file);}
function config(env=process.env) {
  const daily=Number(env.MAX_DAILY_AI_REQUESTS || 30);
  if(!Number.isInteger(daily)||daily<1||daily>10000) throw new Error('每日调用限额配置错误');
  const ids=(env.ALLOWED_USER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(ids.some(x=>!/^\d+$/.test(x))) throw new Error('白名单须为数字用户ID');
  if(!env.TELEGRAM_BOT_TOKEN) throw new Error('未配置 TELEGRAM_BOT_TOKEN');
  return {token:env.TELEGRAM_BOT_TOKEN,key:env.DEEPSEEK_API_KEY,model:env.DEEPSEEK_MODEL||'deepseek-flash',allowed:new Set(ids),daily,stateFile:env.STATE_FILE||path.join(__dirname,'data/state.json')};
}
function createHandler(c,state,persist,tg,ai=analyze,clock=()=>new Date()) {
  const cooldown=new Map();
  const send=async(id,text)=>{for(const chunk of split(text)) await tg('sendMessage',{chat_id:id,text:chunk});};
  return async update=>{
    const m=update.message;
    if(!m || m.chat?.type!=='private' || m.from?.is_bot || typeof m.text!=='string') return;
    if(/^\/id(?:@\w+)?$/.test(m.text.trim())) return send(m.chat.id,`你的用户ID：${m.from.id}`);
    if(!c.allowed.has(String(m.from.id))) return send(m.chat.id,'未授权使用。发送 /id 获取ID，请管理员加入白名单。');
    let action; try {action=parse(m.text,clock());} catch(e) {return send(m.chat.id,e.message);}
    if(action.kind==='start'||action.kind==='help') return send(m.chat.id,HELP);
    const a=almanac(action.date);
    if(action.kind==='date') return send(m.chat.id,format(a));
    if(!c.key) return send(m.chat.id,format(a)+'\n\nAI尚未配置，当前只提供黄历查询。');
    const now=clock(), day=today(now), id=String(m.from.id);
    if(now.getTime()-(cooldown.get(id)||0)<15000) return send(m.chat.id,'请稍等15秒再请求解读。');
    if(state.day!==day) {state.day=day; state.used=0;}
    if(state.used>=c.daily) return send(m.chat.id,'今天的AI调用额度已用完，仍可用 /today 或 /date 查询。');
    state.used++; persist(); cooldown.set(id,now.getTime());
    // Mark attempts before calling AI: failed/time-out requests may still incur cost.
    await send(m.chat.id,format(a));
    let answer;
    try {answer=await ai(c,a,action.question);} catch {return send(m.chat.id,'DeepSeek暂时无法解读，以上黄历查询仍有效。请稍后重试。');}
    await send(m.chat.id,'DeepSeek解读（民俗参考）\n'+answer);
  };
}
async function main() {
  const c=config(), state=loadState(c.stateFile);
  const tg=async(method,body={})=>{
    const r=await post(`https://api.telegram.org/bot${c.token}/${method}`,body);
    if(!r.ok) throw new Error('Telegram接口失败'); return r.result;
  };
  const me=await tg('getMe'), hook=await tg('getWebhookInfo');
  if(hook.url) throw new Error('该机器人已设置webhook；请使用独立机器人或人工确认切换，不自动删除');
  const persist=()=>saveState(c.stateFile,state);
  const handler=createHandler(c,state,persist,tg);
  let stopping=false;
  process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  console.log(`机器人已启动 @${me.username}，授权人数 ${c.allowed.size}`);
  while(!stopping) {
    let updates;
    try {updates=await tg('getUpdates',{offset:state.offset,timeout:25,limit:20,allowed_updates:['message']});}
    catch {console.error('轮询失败，10秒后重试（检查网络、令牌或重复实例）');await new Promise(r=>setTimeout(r,10000));continue;}
    for(const update of updates) {
      if(stopping) break;
      // Persist before handling to avoid recharging AI after a crash. Delivery is at-most-once.
      state.offset=update.update_id+1; persist();
      try {await handler(update);} catch {console.error('本条消息未完成，请用户重试；不输出正文或密钥。');}
    }
  }
}
if(require.main===module) main().catch(e=>{console.error(e.message.startsWith('未配置')||e.message.includes('状态文件')||e.message.includes('webhook')?e.message:'启动失败，请检查配置、网络及状态目录。');process.exitCode=1;});
module.exports={analyze,config,loadState,saveState,createHandler};
