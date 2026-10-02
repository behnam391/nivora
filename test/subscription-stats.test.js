import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichSubscription } from '../src/subscription-stats.js';
import { readThreeXuiStats } from '../src/providers/three-x-ui.js';

test('subscription stats expose safe usage and remaining validity',()=>{
  const now=1_800_000_000_000,row=enrichSubscription({panel_client_id:'client',traffic_gb:10,duration_days:30},{client:{upBytes:1024**3,downBytes:2*1024**3,totalBytes:10*1024**3,expiryTime:now+5*86400000,enabled:true,syncedAt:now}},now);
  assert.equal(row.usedBytes,3*1024**3);assert.equal(row.remainingBytes,7*1024**3);assert.equal(row.usagePercent,30);assert.equal(row.remainingDays,5);assert.equal(row.panelEnabled,true);
});

test('negative panel expiry means validity begins on first connection',()=>{
  const row=enrichSubscription({panel_client_id:'client',traffic_gb:5,duration_days:30},{client:{expiryTime:-2592000000}});
  assert.equal(row.startsOnFirstUse,true);assert.equal(row.expiryTime,null);assert.equal(row.remainingDays,30);
});

test('3X-UI statistics include active usage without double-counting multiple inbounds',async()=>{
  const client={email:'nivo-test',up:1024,down:2048,total:8192,expiryTime:1_900_000_000_000,enable:true,lastOnline:1_800_000_000_000};
  const requests=[];
  const stats=await readThreeXuiStats({baseUrl:'https://panel.test/private',apiToken:'secret'},async request=>{
    requests.push(request);return {success:true,obj:[{clientStats:[client]},{clientStats:[{...client}]}]};
  });
  assert.equal(requests[0].url.pathname,'/private/panel/api/inbounds/list');
  assert.equal(requests[0].timeoutMs,4000);
  assert.equal(stats['nivo-test'].upBytes,1024);
  assert.equal(stats['nivo-test'].downBytes,2048);
  assert.equal(stats['nivo-test'].totalBytes,8192);
  assert.equal(stats['nivo-test'].expiryTime,client.expiryTime);
});

test('missing panel statistics are marked unavailable, not silently claimed as real',()=>{
  const row=enrichSubscription({panel_client_id:'missing',traffic_gb:10,duration_days:30},{});
  assert.equal(row.statsAvailable,false);
  assert.equal(row.expiryTime,null);
});
