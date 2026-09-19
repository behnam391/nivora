import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createTelegramRecovery } from '../src/telegram-bot.js';

const run=async({message,config={},aiPublicAnswer,seed}={})=>{
  const db=openDatabase(':memory:'),sent=[];
  if(seed)seed(db);
  const handler=createTelegramRecovery(db,{
    getConfig:()=>({enabled:true,token:'1:test',secret:'secret',username:'nivorali_bot',adminIds:[],groupIds:['-1001234567'],groupAiEnabled:true,...config}),
    fetchImpl:async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})}},
    aiPublicAnswer
  });
  let status,body;
  await handler({headers:{'x-telegram-bot-api-secret-token':'secret'}},{writeHead:value=>{status=value},end:value=>{body=JSON.parse(value)}},async()=>({message}), (res,code,payload)=>{res.writeHead(code);res.end(JSON.stringify(payload))});
  return {db,sent,status,body};
};

test('group messages never expose customer actions and only explicit mentions invoke AI',async()=>{
  const ignored=await run({message:{chat:{id:-1001234567,type:'supergroup'},from:{id:42},text:'👤 حساب من'},aiPublicAnswer:async()=>{throw new Error('must not run')}});
  assert.equal(ignored.status,200);assert.equal(ignored.sent.length,0);
  const answered=await run({message:{chat:{id:-1001234567,type:'supergroup'},from:{id:42},text:'@nivorali_bot چطور خرید کنم؟'},aiPublicAnswer:async q=>`پاسخ عمومی: ${q}`});
  assert.equal(answered.sent.length,1);assert.match(answered.sent[0].text,/پاسخ عمومی/);assert.doesNotMatch(answered.sent[0].text,/اشتراک:\/\//);
});

test('private sales advisor qualifies a lead and recommends an active plan',async()=>{
  const seed=db=>{const now=new Date().toISOString();db.prepare(`INSERT INTO plans(id,name,description,price_irr,traffic_gb,duration_days,device_limit,sort_order,active,created_at,updated_at) VALUES('p60','استاندارد','',1590000,60,30,1,1,1,?,?)`).run(now,now)};
  const network=await run({seed,message:{chat:{id:52,type:'private'},from:{id:52},text:'sales:network:mtn'},config:{latestReleaseUrl:''}});
  assert.match(network.sent[0].text,/دستگاه/);
  const lead=network.db.prepare('SELECT * FROM sales_leads WHERE telegram_user_id=?').get('52');
  assert.equal(lead.network,'mtn');
});

test('group AI fails closed until that group is explicitly allowed',async()=>{
  const result=await run({message:{chat:{id:-1009999999,type:'supergroup'},from:{id:42},text:'@nivorali_bot قیمت چیست؟'},aiPublicAnswer:async()=>{throw new Error('must not run')}});
  assert.equal(result.status,200);assert.equal(result.sent.length,0);
});

test('approved groups can answer relevant questions without a mention when auto reply is enabled',async()=>{
  const result=await run({config:{groupAutoReply:true},message:{chat:{id:-1001234567,type:'supergroup'},from:{id:42},text:'قیمت اشتراک‌ها چقدر است؟'},aiPublicAnswer:async()=> 'برای مشاهده قیمت‌های فعلی وارد برنامه شوید.'});
  assert.equal(result.sent.length,1);assert.match(result.sent[0].text,/قیمت/);
});

test('private campaign deep links are recorded and continue normal onboarding',async()=>{
  const first=await run({message:{chat:{id:42,type:'private'},from:{id:42},text:'/start camp_irancell-sep'}});
  assert.equal(first.status,200);assert.equal(first.sent.length,1);assert.match(first.sent[0].text,/خرید/);
  assert.equal(first.db.prepare("SELECT COUNT(*) count FROM telegram_growth_events WHERE campaign_code='irancell-sep'").get().count,1);
});

test('a new Telegram contact is retained as a sales lead instead of being rejected',async()=>{
  const result=await run({message:{chat:{id:75,type:'private'},from:{id:75},contact:{user_id:75,phone_number:'+989121234567'}}});
  assert.equal(result.status,200);assert.equal(result.sent.length,1);assert.match(result.sent[0].text,/ساخت حساب/);
  assert.equal(result.db.prepare("SELECT status FROM sales_leads WHERE telegram_user_id='75'").get().status,'qualified');
});

test('Telegram registration creates and links a customer without storing plaintext password',async()=>{
  const db=openDatabase(':memory:'),sent=[];
  const handler=createTelegramRecovery(db,{getConfig:()=>({enabled:true,token:'1:test',secret:'secret',username:'nivorali_bot',adminIds:[],groupIds:[]}),fetchImpl:async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})}}});
  const deliver=async message=>handler({headers:{'x-telegram-bot-api-secret-token':'secret'}},{writeHead(){},end(){}},async()=>({message}),(res,_code,payload)=>res.end(JSON.stringify(payload)));
  await deliver({message_id:1,chat:{id:88,type:'private'},from:{id:88},contact:{user_id:88,phone_number:'+989121234568'}});
  await deliver({message_id:2,chat:{id:88,type:'private'},from:{id:88},text:'کاربر تازه'});
  await deliver({message_id:3,chat:{id:88,type:'private'},from:{id:88},text:'strong-pass-88'});
  const account=db.prepare("SELECT * FROM accounts WHERE phone='09121234568'").get(),link=db.prepare("SELECT * FROM telegram_account_links WHERE telegram_user_id='88'").get();
  assert.equal(account.name,'کاربر تازه');assert.equal(link.account_id,account.id);assert.notEqual(account.password_hash,'strong-pass-88');assert(sent.some(item=>item.message_id===3));
});
