import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichSubscription } from '../src/subscription-stats.js';

test('subscription stats expose safe usage and remaining validity',()=>{
  const now=1_800_000_000_000,row=enrichSubscription({panel_client_id:'client',traffic_gb:10,duration_days:30},{client:{upBytes:1024**3,downBytes:2*1024**3,totalBytes:10*1024**3,expiryTime:now+5*86400000,enabled:true,syncedAt:now}},now);
  assert.equal(row.usedBytes,3*1024**3);assert.equal(row.remainingBytes,7*1024**3);assert.equal(row.usagePercent,30);assert.equal(row.remainingDays,5);assert.equal(row.panelEnabled,true);
});

test('negative panel expiry means validity begins on first connection',()=>{
  const row=enrichSubscription({panel_client_id:'client',traffic_gb:5,duration_days:30},{client:{expiryTime:-2592000000}});
  assert.equal(row.startsOnFirstUse,true);assert.equal(row.expiryTime,null);assert.equal(row.remainingDays,30);
});
