import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { buildMultiEndpointSubscription, decodeSubscription, parseCleanIpList } from '../src/multi-endpoint.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

test('Cloudflare clean IP routes clone only compatible CDN links and preserve direct Reality', () => {
  const reality='vless://12345678-1234-1234-1234-123456789abc@65.109.184.177:443?type=tcp&security=reality&sni=www.cloudflare.com&pbk=public-key#Direct';
  const cdn='vless://12345678-1234-1234-1234-123456789abc@edge.nivorali.com:443?type=ws&security=tls&host=edge.nivorali.com&sni=edge.nivorali.com&path=%2Fws&flow=none#CDN';
  const rendered=buildMultiEndpointSubscription(`${reality}\n${cdn}`,[{label:'Cloudflare 01',host:'104.16.0.1',port:443,mode:'cloudflare',serverName:'edge.nivorali.com',priority:10,active:true}]);
  const links=rendered.split('\n');
  assert.equal(links.length,3);
  assert.equal(links[0],reality);
  assert.equal(links[1],cdn);
  const clone=new URL(links[2]);
  assert.equal(clone.hostname,'104.16.0.1');
  assert.equal(clone.searchParams.get('sni'),'edge.nivorali.com');
  assert.equal(clone.searchParams.get('host'),'edge.nivorali.com');
  assert.equal(clone.searchParams.get('flow'),null);
});

test('base64 vmess subscriptions keep their encoding while Cloudflare address, Host and SNI are expanded', () => {
  const vmess=Buffer.from(JSON.stringify({v:'2',ps:'Nivora',add:'edge.nivorali.com',port:'443',id:'id',net:'ws',tls:'tls',host:'edge.nivorali.com',sni:'edge.nivorali.com'})).toString('base64');
  const source=Buffer.from(`vmess://${vmess}`).toString('base64');
  const rendered=buildMultiEndpointSubscription(source,[{label:'A',host:'104.16.0.2',port:443,mode:'cloudflare',serverName:'edge.nivorali.com',priority:1,active:true}]);
  const decoded=decodeSubscription(rendered);
  assert.equal(decoded.base64,true);
  const links=decoded.text.split('\n');
  assert.equal(links.length,2);
  const cloned=JSON.parse(Buffer.from(links[1].slice(8),'base64').toString('utf8'));
  assert.equal(cloned.add,'104.16.0.2');assert.equal(cloned.host,'edge.nivorali.com');assert.equal(cloned.sni,'edge.nivorali.com');
});

test('clean IP import parser excludes CIDRs and non-Cloudflare addresses', () => {
  assert.deepEqual(parseCleanIpList('104.16.0.0/13\n104.16.0.1\n8.8.8.8\n172.64.1.2\n104.16.0.1'),['104.16.0.1','172.64.1.2']);
});

test('public Nivora subscription gateway includes direct and active Cloudflare routes of a location', async t => {
  const direct='vless://12345678-1234-1234-1234-123456789abc@65.109.184.177:443?security=reality&type=tcp&sni=www.cloudflare.com&pbk=key#Direct';
  const cdn='vless://12345678-1234-1234-1234-123456789abc@edge.nivorali.com:443?security=tls&type=ws&sni=edge.nivorali.com&host=edge.nivorali.com&path=%2Fws#CDN';
  const upstream=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end(`${direct}\n${cdn}`)});
  await listen(upstream);t.after(()=>upstream.close());
  const upstreamUrl=`http://127.0.0.1:${upstream.address().port}/sub/source`;
  const provisioner=async order=>({panelClientId:`client-${order.id}`,subscriptionUrl:upstreamUrl});
  const db=openDatabase(':memory:');const server=createServer(createApp(db,{adminToken:'test-token',provisioner}));
  await listen(server);t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`,admin={authorization:'Bearer test-token','content-type':'application/json'};
  let response=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'Multi route',priceIrr:100000,trafficGb:20,durationDays:30,deviceLimit:1})});const plan=await response.json();
  response=await fetch(`${base}/api/admin/locations`,{method:'POST',headers:admin,body:JSON.stringify({name:'Finland',countryCode:'FI',panelInboundId:1,panelCdnInboundId:2})});const location=await response.json();
  await fetch(`${base}/api/admin/locations/${location.id}/plans`,{method:'POST',headers:admin,body:JSON.stringify({planIds:[plan.id]})});
  response=await fetch(`${base}/api/admin/locations/${location.id}/endpoints`,{method:'POST',headers:admin,body:JSON.stringify({label:'Cloudflare 01',host:'104.16.0.1',serverName:'edge.nivorali.com',port:443,mode:'cloudflare',priority:10})});assert.equal(response.status,201);
  response=await fetch(`${base}/api/orders`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerName:'Customer',phone:'09121234567',planId:plan.id,receiptReference:'receipt'})});const order=await response.json();
  response=await fetch(`${base}/api/admin/orders/${order.id}/approve`,{method:'POST',headers:admin,body:'{}'});assert.equal(response.status,200);const subscription=await response.json();
  response=await fetch(subscription.subscription_url);assert.equal(response.status,200);assert.equal(response.headers.get('x-nivora-routes'),'1');
  const rendered=await response.text();assert.match(rendered,/@65\.109\.184\.177/);assert.match(rendered,/@104\.16\.0\.1/);assert.match(rendered,/sni=edge\.nivorali\.com/);
});
