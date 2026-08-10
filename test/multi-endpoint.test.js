import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { buildMultiEndpointSubscription, decodeSubscription } from '../src/multi-endpoint.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

test('multi-endpoint renderer preserves Reality parameters and creates one config per route', () => {
  const source='vless://12345678-1234-1234-1234-123456789abc@65.109.184.177:443?type=tcp&security=reality&sni=www.cloudflare.com&pbk=public-key#Nivora';
  const rendered=buildMultiEndpointSubscription(source,[
    {label:'مسیر یک',host:'edge1.nivorali.com',port:443,priority:10,active:true},
    {label:'مسیر دو',host:'edge2.nivorali.com',port:8443,priority:20,active:true}
  ]);
  const links=rendered.split('\n');
  assert.equal(links.length,2);
  assert.match(links[0],/@edge1\.nivorali\.com:443/);
  assert.match(links[1],/@edge2\.nivorali\.com:8443/);
  for(const link of links){const url=new URL(link);assert.equal(url.searchParams.get('sni'),'www.cloudflare.com');assert.equal(url.searchParams.get('pbk'),'public-key');}
});

test('base64 vmess subscriptions keep their encoding while addresses are expanded', () => {
  const vmess=Buffer.from(JSON.stringify({v:'2',ps:'Nivora',add:'old.example.com',port:'443',id:'id',net:'tcp'})).toString('base64');
  const source=Buffer.from(`vmess://${vmess}`).toString('base64');
  const rendered=buildMultiEndpointSubscription(source,[
    {label:'A',host:'a.nivorali.com',port:443,priority:1,active:true},
    {label:'B',host:'b.nivorali.com',port:443,priority:2,active:true}
  ]);
  const decoded=decodeSubscription(rendered);
  assert.equal(decoded.base64,true);
  const links=decoded.text.split('\n');
  assert.equal(links.length,2);
  const first=JSON.parse(Buffer.from(links[0].slice(8),'base64').toString('utf8'));
  assert.equal(first.add,'a.nivorali.com');
});

test('public Nivora subscription gateway serves the active subdomain routes of a location', async t => {
  const upstream=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('vless://12345678-1234-1234-1234-123456789abc@65.109.184.177:443?security=reality&sni=www.cloudflare.com&pbk=key#Nivora')});
  await listen(upstream);t.after(()=>upstream.close());
  const upstreamUrl=`http://127.0.0.1:${upstream.address().port}/sub/source`;
  const provisioner=async order=>({panelClientId:`client-${order.id}`,subscriptionUrl:upstreamUrl});
  const db=openDatabase(':memory:');const server=createServer(createApp(db,{adminToken:'test-token',provisioner}));
  await listen(server);t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`,admin={authorization:'Bearer test-token','content-type':'application/json'};
  let response=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'Multi route',priceIrr:100000,trafficGb:20,durationDays:30,deviceLimit:1})});const plan=await response.json();
  response=await fetch(`${base}/api/admin/locations`,{method:'POST',headers:admin,body:JSON.stringify({name:'Finland',countryCode:'FI',panelInboundId:1})});const location=await response.json();
  await fetch(`${base}/api/admin/locations/${location.id}/plans`,{method:'POST',headers:admin,body:JSON.stringify({planIds:[plan.id]})});
  for(const [label,host,priority] of [['Route 1','edge1.nivorali.com',10],['Route 2','edge2.nivorali.com',20]]){
    response=await fetch(`${base}/api/admin/locations/${location.id}/endpoints`,{method:'POST',headers:admin,body:JSON.stringify({label,host,port:443,priority})});assert.equal(response.status,201);
  }
  response=await fetch(`${base}/api/orders`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerName:'Customer',phone:'09121234567',planId:plan.id,receiptReference:'receipt'})});const order=await response.json();
  response=await fetch(`${base}/api/admin/orders/${order.id}/approve`,{method:'POST',headers:admin,body:'{}'});assert.equal(response.status,200);const subscription=await response.json();
  assert.match(subscription.subscription_url,new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/sub/[a-f0-9]{32}$`));
  response=await fetch(subscription.subscription_url);assert.equal(response.status,200);assert.equal(response.headers.get('x-nivora-routes'),'2');
  const rendered=await response.text();assert.match(rendered,/edge1\.nivorali\.com/);assert.match(rendered,/edge2\.nivorali\.com/);assert.doesNotMatch(rendered,/@65\.109\.184\.177/);
});
