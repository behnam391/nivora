import test from 'node:test';
import assert from 'node:assert/strict';
import {limits,permitted,renew,firewall,GB,DAY} from '../ops/openvpn-sales-policy.mjs';
import {createOpenVpnProvisioner} from '../src/providers/openvpn.js';
const id='ovpn-'+'a'.repeat(32);
test('OpenVPN quota and expiry gates fail closed',()=>{
  const c={id,address:'10.78.0.10',enabled:true,totalBytes:GB,usedBytes:GB,expiresAt:Date.now()+DAY};
  assert.equal(permitted(c),false);
  assert.equal(permitted({...c,usedBytes:0}),true);
  assert.equal(permitted({...c,usedBytes:0,expiresAt:1}),false);
  assert.equal(permitted({...c,totalBytes:0,expiresAt:0}),true);
  assert.equal(permitted({...c,totalBytes:0,expiresAt:0,deleted:true}),false);
  assert.throws(()=>limits(1,30,2),/ONE_DEVICE/);
  assert.throws(()=>limits(-1,30));
});
test('renew adds quota without erasing consumption',()=>{
  const c={totalBytes:GB,usedBytes:123,expiresAt:1000};
  const r=renew(c,30,2,2000);
  assert.equal(r.usedBytes,123);assert.equal(r.totalBytes,3*GB);assert.equal(r.expiresAt,2000+30*DAY);
  assert.equal(renew(c,0,0).totalBytes,0);assert.equal(renew(c,0,0).expiresAt,0);
});
test('both directions share quota and unknown clients are denied',()=>{
  const c={id,address:'10.78.0.10',enabled:true,totalBytes:GB,usedBytes:12,expiresAt:0};
  const output=firewall({[id]:c});
  assert.equal((output.match(/quota name/g)||[]).length,2);
  assert.match(output,/iifname "nvovpn0" drop/);assert.match(output,/oifname "nvovpn0" drop/);
  assert.doesNotMatch(output,/flush ruleset/);
  const retained=firewall({[id]:c},{[id.replaceAll('-','')]:{bytes:GB,used:12}});
  assert.doesNotMatch(retained,/delete quota|add quota/);
});
test('provider uses stable create and renewal operation IDs',async()=>{
  const calls=[];const p=createOpenVpnProvisioner({baseUrl:'http://127.0.0.1:8791',apiToken:'test'},async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return {ok:true,json:async()=>({})};});
  const order={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',traffic_gb:10,duration_days:30,device_limit:1};
  const result=await p(order);assert.equal(result.panelClientId,id);
  await p.renew({panelClientId:id,addDays:30,addTrafficGb:10,operationId:'order-renew-123'});
  assert.equal(calls[0].body.operationId,'create:'+order.id);
  assert.equal(calls[1].body.operationId,'renew:order-renew-123');
});
test('lost mutation response is uncertain, not refund-safe',async()=>{
  const p=createOpenVpnProvisioner({baseUrl:'http://127.0.0.1:8791',apiToken:'test'},async()=>{throw new Error('timeout')});
  await assert.rejects(p({id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',traffic_gb:1,duration_days:1,device_limit:1}),e=>e.uncertain===true);
  assert.throws(()=>createOpenVpnProvisioner({baseUrl:'http://remote.example',apiToken:'test'}),/HTTPS/);
});
