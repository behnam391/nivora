import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.js';
import {createPurchaseRequests,isPurchasePath} from '../src/purchase-requests.js';

test('purchase journal prevents repeats, scopes actors and replays durable results',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const store=createPurchaseRequests(db),key='request-123456789012345';
 assert.equal(store.begin('a','/api/customer/purchase',key,{planId:'x'}).started,true);
 assert.equal(store.begin('a','/api/customer/purchase',key,{planId:'x'}).started,false);
 assert.equal(store.begin('a','/api/customer/purchase',key,{planId:'y'}).status,409);
 store.complete('a','/api/customer/purchase',key,201,{orderId:'one'});
 const replay=createPurchaseRequests(db).begin('a','/api/customer/purchase',key,{planId:'x'});
 assert.equal(replay.status,201);assert.deepEqual(replay.body,{orderId:'one'});assert.equal(replay.replayed,true);
 assert.equal(store.begin('b','/api/customer/purchase',key,{planId:'x'}).started,true);
});
test('purchase journal canonicalizes bodies and rejects malformed keys',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const s=createPurchaseRequests(db);
 assert.equal(s.begin('a','path','too-short',{}).status,400);
 assert.equal(s.begin('a','path','request-123456789012345',{b:2,a:1}).started,true);
 assert.equal(s.begin('a','path','request-123456789012345',{a:1,b:2}).started,false);
 for(const path of ['/api/customer/purchase','/api/reseller/purchase','/api/customer/orders/x/renew','/api/reseller/orders/x/renew','/api/admin/sales'])assert.equal(isPurchasePath(path),true);
 assert.equal(isPurchasePath('/api/customer/login'),false);
});
