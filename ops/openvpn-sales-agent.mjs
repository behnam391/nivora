#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {timingSafeEqual} from 'node:crypto';
import {openvpnProfile} from './classic-vpn-profiles.mjs';
import {limits,permitted,renew,firewall} from './openvpn-sales-policy.mjs';
const root='/etc/nivora-classic',stateFile=root+'/sales-clients.json';
const read=p=>fs.readFileSync(p,'utf8').trim();
const write=(p,data,mode=0o600)=>{fs.writeFileSync(p+'.tmp',data,{mode});fs.chmodSync(p+'.tmp',mode);const fd=fs.openSync(p+'.tmp','r');fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(p+'.tmp',p);};
const run=(exe,args,options={})=>execFileSync(exe,args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30000,...options});
let state=fs.existsSync(stateFile)?JSON.parse(read(stateFile)):{clients:{},operations:{}};
const token=read(root+'/sales-token'),config=JSON.parse(read(root+'/config.json'));
fs.mkdirSync(root+'/ccd',{recursive:true,mode:0o755});
fs.chmodSync(root+'/ccd',0o755);
write(root+'/ccd/pilot-iphone','ifconfig-push 10.78.0.2 255.255.255.0\n',0o644);
function save(){write(stateFile,JSON.stringify(state));write(root+'/sales-access.json',JSON.stringify(Object.fromEntries(Object.entries(state.clients).map(([id,c])=>[id,{enabled:permitted(c),expiresAt:c.expiresAt}]))),0o644);}
function usage(){
  let items;
  try{items=JSON.parse(run('nft',['-j','list','table','inet','nivora_ovpn_sales'])).nftables;}catch(error){
    // Only absence is acceptable; malformed output/permission errors fail closed.
    if(!String(error.stderr).includes('No such file'))throw error;
    return {};
  }
  const quotas=Object.fromEntries(items.filter(x=>x.quota).map(x=>[x.quota.name,x.quota]));
  for(const c of Object.values(state.clients)){const q=quotas[c.id.replaceAll('-','')];if(q)c.usedBytes=Math.max(c.usedBytes,Number(q.used||0));}
  return quotas;
}
async function disconnect(id) {
  if(!fs.existsSync('/run/nivora-classic-openvpn.sock'))return;
  await new Promise((resolve,reject)=>{
    let data='';const socket=net.createConnection('/run/nivora-classic-openvpn.sock');
    socket.setTimeout(3000,()=>socket.destroy(new Error('MANAGEMENT_TIMEOUT')));
    socket.on('connect',()=>socket.write(`kill ${id}\n`));
    socket.on('data',buf=>{data+=buf;if(data.includes('SUCCESS:')||data.includes('not found')){socket.destroy();resolve();}else if(data.includes('ERROR:'))socket.destroy(new Error('MANAGEMENT_ERROR'));});socket.on('error',reject);
  });
}
async function sync(){const live=usage();save();run('nft',['-f','-'],{input:firewall(state.clients,live)});for(const c of Object.values(state.clients))if(!permitted(c))await disconnect(c.id);}
function view(c){return {id:c.id,totalBytes:c.totalBytes,usedBytes:c.usedBytes,expiryTime:c.expiresAt,enabled:permitted(c),deleted:c.deleted||false,upBytes:0,downBytes:c.usedBytes,syncedAt:new Date().toISOString()};}
async function operation(action,b){
  if(action==='health')return {ok:true,protocol:'openvpn',accounting:'kernel-quota',clients:Object.keys(state.clients).length};
  if(action==='allstats'){usage();save();return Object.fromEntries(Object.values(state.clients).map(c=>[c.id,view(c)]));}
  if(!/^ovpn-[a-f0-9]{32}$/.test(b.id||''))throw new Error('INVALID_CLIENT_ID');
  usage();const old=state.clients[b.id];
  if(action==='stats'){if(!old)throw new Error('CLIENT_NOT_FOUND');save();return view(old);}
  if(action==='profile'){
    if(!old||!permitted(old))throw new Error('CLIENT_INACTIVE');
    return {filename:'Nivora-'+b.id.slice(-8)+'.ovpn',content:openvpnProfile({host:config.host,ca:read(root+'/pki/ca.crt'),cert:read(root+`/pki/issued/${b.id}.crt`),privateKey:read(root+`/pki/private/${b.id}.key`),tlsCrypt:read(root+'/tls-crypt.key')})};
  }
  if(!/^[a-zA-Z0-9:_-]{8,150}$/.test(b.operationId||''))throw new Error('IDEMPOTENCY_REQUIRED');
  const key=b.operationId,payload=JSON.stringify({action,...b});
  if(state.operations[key]){if(state.operations[key]!==payload)throw new Error('IDEMPOTENCY_CONFLICT');await sync();return view(state.clients[b.id]);}
  if(action==='create') {
    const entitlement=limits(b.trafficGb,b.durationDays,b.deviceLimit);
    if(old)throw new Error('CLIENT_EXISTS');
    const used=new Set(Object.values(state.clients).map(c=>c.address));
    const address=Array.from({length:245},(_,i)=>`10.78.0.${i+10}`).find(a=>!used.has(a));if(!address)throw new Error('NODE_FULL');
    if(!fs.existsSync(root+`/pki/issued/${b.id}.crt`))run('/usr/share/easy-rsa/easyrsa',['--batch','build-client-full',b.id,'nopass'],{env:{...process.env,EASYRSA_PKI:root+'/pki',EASYRSA_REQ_CN:b.id,EASYRSA_CERT_EXPIRE:'3650'}});
    write(root+`/ccd/${b.id}`,`ifconfig-push ${address} 255.255.255.0\n`,0o644);
    state.clients[b.id]={id:b.id,address,...entitlement,enabled:true,usedBytes:0};
  }else{
    if(!old)throw new Error('CLIENT_NOT_FOUND');if(old.deleted)throw new Error('CLIENT_DELETED');
    if(action==='renew')state.clients[b.id]=renew(old,b.durationDays,b.trafficGb);
    else if(action==='limits')Object.assign(old,limits(b.trafficGb,b.durationDays));
    else if(action==='suspend')old.enabled=false;
    else if(action==='resume')old.enabled=true;
    else if(action==='remove'){old.enabled=false;old.deleted=true;}
    else throw new Error('INVALID_ACTION');
  }
  state.operations[key]=payload;save();await sync();return view(state.clients[b.id]);
}
let queue=Promise.resolve();
function enqueue(fn){const result=queue.then(fn);queue=result.catch(()=>{});return result;}
await sync();
const listenHost=process.env.NIVORA_OPENVPN_AGENT_HOST||'127.0.0.1';
const listenPort=Number(process.env.NIVORA_OPENVPN_AGENT_PORT||8791);
const tlsCert=process.env.NIVORA_OPENVPN_AGENT_TLS_CERT;
const tlsKey=process.env.NIVORA_OPENVPN_AGENT_TLS_KEY;
if(!Number.isInteger(listenPort)||listenPort<1||listenPort>65535)throw new Error('INVALID_LISTEN_PORT');
if(Boolean(tlsCert)!==Boolean(tlsKey))throw new Error('TLS_CERT_AND_KEY_REQUIRED');
const handler=async(req,res)=>{
  res.setHeader('cache-control','no-store');res.setHeader('content-type','application/json');
  const auth=Buffer.from(String(req.headers.authorization||'')),expected=Buffer.from('Bearer '+token);
  if(auth.length!==expected.length||!timingSafeEqual(auth,expected)){res.writeHead(401);return res.end('{"error":"UNAUTHORIZED"}');}
  if(req.method!=='POST'||!/^\/(health|allstats|create|renew|limits|suspend|resume|remove|stats|profile)$/.test(req.url)){res.writeHead(404);return res.end('{}');}
  let raw='',size=0;
  try{for await(const chunk of req){size+=chunk.length;if(size>8192){res.writeHead(413);res.end('{}');return;}raw+=chunk;}const body=JSON.parse(raw||'{}');const result=await enqueue(()=>operation(req.url.slice(1),body));res.end(JSON.stringify(result));}
  catch(error){const known=/^(INVALID_|CLIENT_|IDEMPOTENCY_|NODE_FULL|OPENVPN_)/.test(error.message);res.writeHead(known?400:503);res.end(JSON.stringify({error:known?error.message:'NODE_OPERATION_UNCERTAIN'}));console.error('OpenVPN operation failed:',known?error.message:'internal error');}
};
const server=tlsCert
  ? https.createServer({cert:fs.readFileSync(tlsCert),key:fs.readFileSync(tlsKey),minVersion:'TLSv1.2'},handler)
  : http.createServer(handler);
server.requestTimeout=10000;server.headersTimeout=10000;
server.listen(listenPort,listenHost);
const timer=setInterval(()=>enqueue(sync).catch(()=>console.error('OpenVPN accounting sync failed')),5000);
process.on('SIGTERM',()=>{clearInterval(timer);server.close();enqueue(async()=>{usage();save();process.exit(0);}).catch(()=>process.exit(1));});
