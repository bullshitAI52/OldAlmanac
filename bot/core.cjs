'use strict';
const { Solar, LunarUtil } = require('../lunar.js');
const INTERPRETATION_TEMPLATE = require('node:fs').readFileSync(require('node:path').join(__dirname,'interpretation-template.txt'),'utf8');
function today(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function almanac(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式为 YYYY-MM-DD');
  const [y,m,d] = date.split('-').map(Number), check = new Date(Date.UTC(y,m-1,d));
  if (y<1900 || y>2100 || check.getUTCFullYear()!==y || check.getUTCMonth()!==m-1 || check.getUTCDate()!==d) throw new Error('请输入1900–2100年的有效日期');
  const solar = Solar.fromYmd(y,m,d), lunar = solar.getLunar();
  const gates=['正北','西南','正东','东南','西北','正西','东北','正南'];
  const ci=LunarUtil.getJiaZiIndex(lunar.getDayChongGan()+lunar.getDayChong()),ly=lunar.getYear();
  const birth=ly-((((ly-4-ci)%60)+60)%60);
  const ages=[birth,birth-60].filter(y=>y>=1901&&y<=2099).map(y=>ly-y+1).filter(age=>age>=1);
  const detail={
    times:lunar.getTimes().map(t=>({branch:t.getZhi(),from:t.getMinHm(),to:t.getMaxHm(),folkLuck:t.getTianShenLuck()})),
    directions:{喜神:lunar.getDayPositionXiDesc(),财神:lunar.getDayPositionCaiDesc(),贵神:lunar.getDayPositionYangGuiDesc(),吉门:gates[Math.floor(LunarUtil.JIA_ZI.indexOf(lunar.getDayInGanZhi())/3)%8]},
    directionNote:'吉门沿用网页自定义轮转公式，不代表标准奇门遁甲结论。所有方向为民俗标签，不预测财运。',
    elements:{天干:lunar.getDayGan(),天干五行:LunarUtil.WU_XING_GAN[lunar.getDayGan()],地支:lunar.getDayZhi(),地支五行:LunarUtil.WU_XING_ZHI[lunar.getDayZhi()],纳音:lunar.getDayNaYin()},
    dayOfficer:lunar.getZhiXing(),mansion:lunar.getXiu(),nineStar:lunar.getDayNineStar().getNumber()+lunar.getDayNineStar().getColor(),fetalDeity:lunar.getDayPositionTai(),
    zodiac:{year:lunar.getYearShengXiao(),month:lunar.getMonthShengXiao(),day:lunar.getDayShengXiao(),clash:lunar.getDayChongShengXiao()},
    displayedClashAge:ages.length?Math.min(...ages):null,
    ageNote:'网页按干支推算的民俗虚岁标签，不是用户实际年龄，更不是个人风险预测。',
    displayedYi:lunar.getDayYi(1).filter(x=>x.length<=2).slice(0,6),displayedJi:lunar.getDayJi(1).filter(x=>x.length<=2).slice(0,4),
    displayNote:'网页会过滤长词并截断条目；图中忌留空不表示没有禁忌，应参考完整yi/ji。子时跨日，times分别提供早子、晚子，不能合并为同一吉凶。'
  };
  return {detail,date,week:'星期'+solar.getWeekInChinese(),lunar:lunar.toString(),year:lunar.getYearInGanZhi(),month:lunar.getMonthInGanZhi(),day:lunar.getDayInGanZhi(),yi:lunar.getDayYi(1),ji:lunar.getDayJi(1),term:lunar.getJieQi() || '当日无节气交接',clash:lunar.getDayChongDesc(),sha:lunar.getDaySha()};
}
function format(a) {
  return `${a.date} ${a.week}\n农历：${a.lunar}\n干支：${a.year}年 ${a.month}月 ${a.day}日\n节气：${a.term}\n宜：${a.yi.join('、')}\n忌：${a.ji.join('、')}\n冲：${a.clash}；煞：${a.sha}\n\n来源：项目 lunar.js；民俗参考，不代表现实结果。`;
}
function parse(text, now) {
  text = text.trim();
  if(text==='命令模板')text='/template';
  if(text==='今天黄历')text='/today';
  if(/^\/(template|date|ask)(?:@\w+)?$/.test(text))return {kind:'template'};
  if (text.length > 800) throw new Error('问题请控制在800字以内');
  if (/^\/(start|help|id)(?:@\w+)?$/.test(text)) return {kind:text.match(/^\/(\w+)/)[1]};
  if (/^\/today(?:@\w+)?$/.test(text) || text==='今天') return {kind:'date',date:today(now)};
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {almanac(text); return {kind:'date',date:text};}
  let match = text.match(/^\/date(?:@\w+)?\s+(\S+)$/);
  if (match) {almanac(match[1]); return {kind:'date',date:match[1]};}
  match = text.match(/^\/ask(?:@\w+)?(?:\s+([\s\S]+))?$/);
  if (!match) throw new Error('用 /today 查询今天，/date YYYY-MM-DD 查询日期，或 /ask YYYY-MM-DD 问题 请求解读');
  const body = (match[1] || '').trim();
  if (!body) throw new Error('示例：/ask 2026-10-18 解释当天宜忌');
  const dated = body.match(/^(\d{4}-\d{2}-\d{2})(?:\s+([\s\S]*))?$/);
  if (/^\d{4}[-/]/.test(body) && !dated) throw new Error('日期后请加空格，格式为 /ask YYYY-MM-DD 问题');
  const date = dated ? dated[1] : today(now); almanac(date);
  return {kind:'ask',date,question:dated ? (dated[2] || '解释当天宜忌') : body};
}
function messages(a, question) {
  return [{role:'system',content:INTERPRETATION_TEMPLATE}, {role:'user',content:JSON.stringify({calendar:a,question})}];
}
function split(text, size=3500) {
  const out=[]; let part='';
  for (const c of text) { if (part.length+c.length>size) {out.push(part); part='';} part+=c; }
  if(part) out.push(part); return out;
}
module.exports={today,almanac,format,parse,messages,split};
