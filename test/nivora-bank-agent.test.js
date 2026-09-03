import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BankAgentError, bankAgentSigningPayload, verifyBankAgentRequest } from '../src/nivora-bank-agent.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createServer } from 'node:http';

test('Nivora bank agent accepts an authentic recent event and rejects tampering',()=>{
  const secret='s'.repeat(48),now=Date.now(),body={eventId:'evt-12345678',sender:'Day Bank',receivedAt:new Date(now).toISOString(),message:'واریز ۵۰۰۰۰ تومان'};
  const headers={'x-nivora-agent-id':'nba_test','x-nivora-timestamp':String(now),'x-nivora-nonce':'a'.repeat(32)};
  headers['x-nivora-signature']=createHmac('sha256',secret).update(bankAgentSigningPayload({agentId:headers['x-nivora-agent-id'],timestamp:headers['x-nivora-timestamp'],nonce:headers['x-nivora-nonce'],...body})).digest('hex');
  assert.equal(verifyBankAgentRequest({headers,body,secret,expectedAgentId:'nba_test',now}).eventId,body.eventId);
  assert.throws(()=>verifyBankAgentRequest({headers,body:{...body,message:'واریز ۹۰۰۰۰ تومان'},secret,expectedAgentId:'nba_test',now}),error=>error instanceof BankAgentError&&error.code==='BANK_AGENT_SIGNATURE');
});

test('Nivora bank agent rejects stale requests',()=>{
  const secret='x'.repeat(48),now=Date.now(),body={eventId:'evt-12345678',sender:'Day Bank',receivedAt:new Date(now).toISOString(),message:'واریز ۵۰۰۰۰ تومان'},timestamp=String(now-600_000),nonce='b'.repeat(32);
  const signature=createHmac('sha256',secret).update(bankAgentSigningPayload({agentId:'nba_test',timestamp,nonce,...body})).digest('hex');
  assert.throws(()=>verifyBankAgentRequest({headers:{'x-nivora-agent-id':'nba_test','x-nivora-timestamp':timestamp,'x-nivora-nonce':nonce,'x-nivora-signature':signature},body,secret,expectedAgentId:'nba_test',now}),error=>error.code==='BANK_AGENT_TIMESTAMP');
});

test('first-party webhook ingests once and rejects a replay',async t=>{
  const db=openDatabase(':memory:'),server=createServer(createApp(db,{adminToken:'admin-test'}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`,admin={authorization:'Bearer admin-test','content-type':'application/json'};
  let response=await fetch(`${base}/api/admin/bank-agent-settings`,{method:'PATCH',headers:admin,body:JSON.stringify({rotateSecret:true})}),pair=await response.json();
  assert.equal(response.status,200,JSON.stringify(pair));assert.ok(pair.agentId);assert.ok(pair.generatedSecret);
  response=await fetch(`${base}/api/admin/bank-agent-settings`,{method:'PATCH',headers:admin,body:JSON.stringify({enabled:true,allowedSenders:['Day Bank'],autoReviewEnabled:true})});assert.equal(response.status,200);
  const saved=await fetch(`${base}/api/admin/bank-agent-settings`,{headers:admin}).then(r=>r.json());assert.equal(saved.agentId,pair.agentId);
  const now=Date.now(),body={eventId:'evt-live-1234',sender:'Day Bank',receivedAt:new Date(now).toISOString(),message:'افزایش موجودی ۵۰٬۰۰۰ تومان'},timestamp=String(now),nonce='c'.repeat(32),agentId=pair.agentId;
  const signature=createHmac('sha256',pair.generatedSecret).update(bankAgentSigningPayload({agentId,timestamp,nonce,...body})).digest('hex'),headers={'content-type':'application/json','x-nivora-agent-id':agentId,'x-nivora-timestamp':timestamp,'x-nivora-nonce':nonce,'x-nivora-signature':signature};
  const payload=JSON.stringify({eventId:body.eventId,sender:body.sender,receivedAt:body.receivedAt,message:body.message});response=await fetch(`${base}/api/webhooks/nivora-bank-agent`,{method:'POST',headers,body:payload});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(db.prepare("SELECT COUNT(*) count FROM bank_transactions WHERE source='nivora-agent'").get().count,1);
  response=await fetch(`${base}/api/webhooks/nivora-bank-agent`,{method:'POST',headers,body:payload});assert.equal(response.status,409);assert.equal((await response.json()).error,'BANK_AGENT_REPLAY');
});
