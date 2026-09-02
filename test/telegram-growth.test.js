import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createTelegramRecovery } from '../src/telegram-bot.js';

const run=async({message,config={},aiPublicAnswer}={})=>{
  const db=openDatabase(':memory:'),sent=[];
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

test('group AI fails closed until that group is explicitly allowed',async()=>{
  const result=await run({message:{chat:{id:-1009999999,type:'supergroup'},from:{id:42},text:'@nivorali_bot قیمت چیست؟'},aiPublicAnswer:async()=>{throw new Error('must not run')}});
  assert.equal(result.status,200);assert.equal(result.sent.length,0);
});

test('private campaign deep links are recorded and continue normal onboarding',async()=>{
  const first=await run({message:{chat:{id:42,type:'private'},from:{id:42},text:'/start camp_irancell-sep'}});
  assert.equal(first.status,200);assert.equal(first.sent.length,1);assert.match(first.sent[0].text,/شماره/);
  assert.equal(first.db.prepare("SELECT COUNT(*) count FROM telegram_growth_events WHERE campaign_code='irancell-sep'").get().count,1);
});
