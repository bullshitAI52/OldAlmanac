'use strict';
const fs=require('node:fs'),path=require('node:path');
const {today,almanac,split}=require('./core.cjs');
const {analyze,config}=require('./server.cjs');
const SITE='https://bullshitai52.github.io/OldAlmanac/';
function atomic(file,obj){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',JSON.stringify(obj),{mode:0o600});fs.renameSync(file+'.tmp',file);}
function due(now=new Date()){const hour=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);return hour>='00:01';}
async function render(date,png,executablePath){
  const {chromium}=require('playwright-core');
  const browser=await chromium.launch({executablePath,headless:true,args:['--enable-unsafe-swiftshader']});
  try{
    const context=await browser.newContext({viewport:{width:1200,height:1600},deviceScaleFactor:2,timezoneId:'Asia/Shanghai',locale:'zh-CN',reducedMotion:'reduce'});
    const page=await context.newPage();
    await page.clock.setFixedTime(new Date(date+'T12:00:00+08:00'));
    // The webpage canvas exporter overlaps vertical writing-mode text in Chromium.
    // Apply a capture-only narrow-column equivalent; leave the hosted page unchanged.
    await page.route(SITE,async route=>{
      const response=await route.fetch();
      const html=(await response.text()).replace('</head>','<style>.calendar-card .proverb{writing-mode:horizontal-tb!important;width:1.2em!important;height:auto!important;line-height:1.4!important;letter-spacing:0!important;overflow-wrap:anywhere!important;word-break:break-all!important;}</style></head>');
      await route.fulfill({response,body:html});
    });
    await page.goto(SITE,{waitUntil:'load',timeout:90000});
    await page.waitForFunction(d=>document.querySelector('#date-picker')?.value===d && document.querySelector('#page-loader')?.hidden===true && document.querySelector('#current-page')?.width>0,date,{timeout:90000});
    await page.evaluate(()=>document.fonts.ready);
    const result=await page.evaluate(date=>{
      const canvas=document.querySelector('#current-page');
      const [y,m,d]=date.split('-').map(Number),l=window.Solar.fromYmd(y,m,d).getLunar();
      return {image:canvas.toDataURL('image/png'),yi:l.getDayYi(1),ji:l.getDayJi(1)};
    },date);
    const expected=almanac(date);
    if(JSON.stringify(result.yi)!==JSON.stringify(expected.yi)||JSON.stringify(result.ji)!==JSON.stringify(expected.ji))throw Error('网页数据与机器人版本不同，需同步lunar.js');
    const image=Buffer.from(result.image.split(',')[1],'base64');
    if(image.length<10000||image.length>9*1024*1024)throw Error('日历图片大小异常');
    fs.writeFileSync(png,image,{mode:0o600});
  }finally{await browser.close();}
}
async function sendPart(record,key,persist,send){
  // Persist intent first. An interrupted/ambiguous request is never auto-repeated.
  if(record[key])return false;
  record[key]='sending';persist();
  try{await send();record[key]='sent';persist();return true;}
  catch(e){record[key]='uncertain';persist();throw e;}
}
async function telegram(token,method,body){
  const isForm=body instanceof FormData;
  const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:isForm?{}:{'Content-Type':'application/json'},body:isForm?body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const d=await r.json();if(!r.ok||!d.ok)throw Error('Telegram发送失败');return d.result;
}
async function main(){
  const date=today();if(!due())return;
  const c=config(),dir=process.env.DAILY_STATE_DIR||'/var/lib/oldalmanac-bot/daily';
  const ids=(process.env.DAILY_CHAT_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!ids.length||ids.some(id=>!c.allowed.has(id)))throw Error('每日推送收件人未配置或不在白名单');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,date+'.json'),png=path.join(dir,date+'.png');
  const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{date,recipients:{}};
  if(state.date!==date||!state.recipients)throw Error('每日推送状态损坏');
  const persist=()=>atomic(file,state);
  if(ids.every(id=>state.recipients[id]?.photo==='sent'&&state.recipients[id]?.text==='sent')){console.log(date+' 已完成，跳过重复推送');return;}
  if(!fs.existsSync(png))await render(date,png,process.env.CHROMIUM_EXECUTABLE);
  if(!state.summary){
    const a=almanac(date);
    try{state.summary=await analyze(c,a,'按聊天式模板解释这一天的黄历：少术语，分组讲清宜忌，时间和方位便于查看，最后自然总结。使用当天完整资料，约600至900字。');}
    catch{state.summary='今天的大白话解读暂时生成失败。宜：'+a.yi.join('、')+'；忌：'+a.ji.join('、')+'。以上为传统民俗参考，实际安排仍以天气、健康及工作需要为准。';state.aiFallback=true;}
    // One daily summary, shared by recipients. Separate from interactive /ask quota.
    persist();
  }
  for(const id of ids){
    const record=state.recipients[id]||(state.recipients[id]={});
    await sendPart(record,'photo',persist,async()=>{
      const form=new FormData();form.set('chat_id',id);form.set('caption',`${date} 日历 · 北京时间\n来源：电子老黄历网页，民俗参考`);form.set('photo',new Blob([fs.readFileSync(png)],{type:'image/png'}),date+'.png');
      await telegram(c.token,'sendPhoto',form);
    });
    await new Promise(r=>setTimeout(r,1200));
    // Track each chunk separately; never cut off the final summary.
    const parts=split(`${date} 日历大白话${state.aiFallback?'（本地备用说明）':' · DeepSeek'}\n\n${state.summary}`,3500);
    if(!record.text){
      for(let i=0;i<parts.length;i++){
        await sendPart(record,'text'+i,persist,()=>telegram(c.token,'sendMessage',{chat_id:id,text:parts[i]}));
        if(record['text'+i]!=='sent')break;
        if(i<parts.length-1)await new Promise(r=>setTimeout(r,1200));
      }
      if(parts.every((_,i)=>record['text'+i]==='sent')){record.text='sent';persist();}
    }
  }
  console.log(date+' 每日推送处理完成');
}
if(require.main===module)main().catch(()=>{console.error('每日推送未完成，请检查网络、浏览器或私有状态；未输出密钥。');process.exitCode=1;});
module.exports={due,sendPart,render};
