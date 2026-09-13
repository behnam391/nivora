import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { buildClientPayload, createThreeXuiProvisioner } from '../src/providers/three-x-ui.js';
import { enrichSubscription } from '../src/subscription-stats.js';

test('legacy plan constraints migrate without losing linked orders or allowing negative values',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nivora-limits-')),path=join(dir,'test.db');let db;
  try{
    db=new DatabaseSync(path);
    db.exec(`CREATE TABLE plans(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',price_irr INTEGER NOT NULL CHECK(price_irr>=0),traffic_gb INTEGER NOT NULL CHECK(traffic_gb > 0),duration_days INTEGER NOT NULL CHECK(duration_days > 0),device_limit INTEGER NOT NULL DEFAULT 1,sort_order INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO plans VALUES('legacy','old','',1000,10,30,1,0,1,'2026-01-01','2026-01-01');`);
    db.close();db=openDatabase(path);
    db.prepare('UPDATE plans SET traffic_gb=0,duration_days=0 WHERE id=?').run('legacy');
    assert.equal(db.prepare('SELECT traffic_gb FROM plans WHERE id=?').get('legacy').traffic_gb,0);
    assert.throws(()=>db.exec("UPDATE plans SET traffic_gb=-1 WHERE id='legacy'"));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    db.close();db=openDatabase(path);assert.equal(db.prepare('SELECT duration_days FROM plans WHERE id=?').get('legacy').duration_days,0);
  }finally{db?.close();rmSync(dir,{recursive:true,force:true})}
});

test('zero maps to real unlimited traffic and expiry on the panel',()=>{
  const payload=buildClientPayload({id:'test',phone:'test',traffic_gb:0,duration_days:0,device_limit:1},1);
  assert.equal(payload.client.totalGB,0);assert.equal(Math.abs(payload.client.expiryTime),0);
  const stats=enrichSubscription({traffic_gb:0,duration_days:0,panel_client_id:'a'},{a:{totalBytes:100,expiryTime:Date.now()-100,upBytes:80}});
  assert.equal(stats.totalBytes,0);assert.equal(stats.expiryTime,null);
});

test('updating limits preserves protocol credentials and does not reset usage',async()=>{
  const client={email:'a',subId:'keep',id:'uuid',auth:'hy-secret',password:'keep-password',totalGB:40,expiryTime:20};let sent;
  const provision=createThreeXuiProvisioner({baseUrl:'https://panel.test',apiToken:'test',inboundId:1,subscriptionBaseUrl:'https://panel.test/sub'},async request=>{
    if(request.method==='GET')return {success:true,obj:{client}};
    sent=request.body;return {success:true,obj:{}};
  });
  await provision.setLimits({panelClientId:'a',trafficGb:0,durationDays:0});
  assert.deepEqual(sent,{...client,totalGB:0,expiryTime:0});
});
