import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceUrl=new URL('../windows/Nivora.Desktop/Program.cs',import.meta.url);
const uiUrl=new URL('../windows/Nivora.Desktop/ui/index.html',import.meta.url);

test('Windows client authenticates protected subscriptions without leaking device headers',async()=>{
  const source=await readFile(sourceUrl,'utf8');
  assert.match(source,/X-Nivora-Device/);
  assert.match(source,/AllowAutoRedirect\s*=\s*false/);
  assert.match(source,/target\.Scheme\s*!=\s*"https"/);
  assert.match(source,/target\.Host,new Uri\(Api\)\.Host/);
  assert.match(source,/Request\(HttpMethod\.Get, url, sessionToken\)/);
});

test('Windows client restores the previous proxy and keeps a stable local device ID',async()=>{
  const source=await readFile(sourceUrl,'utf8');
  assert.match(source,/previousProxyEnabled/);
  assert.match(source,/previousProxyServer/);
  assert.match(source,/proxyCaptured/);
  assert.match(source,/device\.id/);
  assert.match(source,/RandomNumberGenerator\.Create/);
});

test('Windows interface is compact, escaped and exposes no subscription copy action',async()=>{
  const ui=await readFile(uiUrl,'utf8');
  assert.match(ui,/Nivora Desktop 1\.1\.0/);
  assert.match(ui,/const esc=/);
  assert.match(ui,/data-tab="subscriptions"/);
  assert.match(ui,/data-open="wallet"/);
  assert.doesNotMatch(ui,/کپی لینک|clipboard\.writeText/);
});
