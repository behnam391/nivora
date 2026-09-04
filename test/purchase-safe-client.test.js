import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

function fixture(fetch) {
 const storage=new Map(),window={fetch};
 const context={window,crypto:webcrypto,Headers,URL,TextEncoder,location:{href:'https://example.test/account'},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};
 vm.runInNewContext(readFileSync(new URL('../public/purchase-safe.js',import.meta.url),'utf8'),context);
 return window.NivoraPurchaseFetch;
}
test('web purchase retains its key after a lost response and resets after definite success',async()=>{
 const keys=[];let count=0;
 const purchase=fixture(async(_url,options)=>{keys.push(options.headers.get('Idempotency-Key'));if(count++===0)throw new Error('NETWORK_LOST');return new Response(JSON.stringify({orderId:'one'}),{status:201})});
 const options={method:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify({planId:'one'})};
 await assert.rejects(purchase('/api/customer/wallet/purchase',options));
 await purchase('/api/customer/wallet/purchase',options);
 await purchase('/api/customer/wallet/purchase',options);
 assert.equal(keys[0],keys[1]);assert.notEqual(keys[1],keys[2]);
});
test('web pending purchase is retried with the same key and other requests pass through',async()=>{
 const keys=[];const purchase=fixture(async(_url,options)=>{keys.push(new Headers(options.headers).get('Idempotency-Key'));return new Response(JSON.stringify({error:'PURCHASE_PENDING'}),{status:409})});
 const options={method:'POST',body:'{}'};
 await purchase('/api/reseller/orders/one/renew',options);await purchase('/api/reseller/orders/one/renew',options);
 await purchase('/api/customer/me',{});
 assert.equal(keys[0],keys[1]);assert.ok(keys[0]);assert.equal(keys[2],null);
});
