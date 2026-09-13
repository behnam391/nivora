#!/usr/bin/env node
// Root-only pilot node controller. Not yet a billing/provisioning adapter.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { endpoint, validClientId, wireguardProfile, openvpnProfile } from './classic-vpn-profiles.mjs';

const root = '/etc/nivora-classic';
const read = p => fs.readFileSync(p, 'utf8').trim();
const run = (file,args=[],options={}) => execFileSync(file,args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],...options}).trim();
const write = (p,data,mode=0o600) => { fs.writeFileSync(p+'.tmp',data,{mode}); fs.chmodSync(p+'.tmp',mode); fs.renameSync(p+'.tmp',p); };
const [command,id,daysArg] = process.argv.slice(2);

// OpenVPN runs this after dropping privileges. Only a sanitized access list is public.
if(command==='authorize') {
  try {
    const access = JSON.parse(read(root+'/access.json'));
    const salesPath=root+'/sales-access.json';
    const sales=fs.existsSync(salesPath)?JSON.parse(read(salesPath)):{};
    const row = sales[process.env.common_name] || access[process.env.common_name];
    process.exit(row?.enabled && (!row.expiresAt || Date.now()<row.expiresAt) ? 0 : 1);
  } catch { process.exit(1); }
}
if(process.getuid?.()!==0) throw new Error('ROOT_REQUIRED');
const config = JSON.parse(read(root+'/config.json'));
const statePath=root+'/clients.json';
const clients=fs.existsSync(statePath)?JSON.parse(read(statePath)):{};
const save = () => {
  write(statePath,JSON.stringify(clients,null,2));
  write(root+'/access.json',JSON.stringify(Object.fromEntries(Object.entries(clients).map(([name,c])=>[name,{enabled:c.enabled,expiresAt:c.expiresAt}]))),0o644);
};
async function killClient(name) {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection('/run/nivora-classic-openvpn.sock');
    let response='';
    socket.setTimeout(4000,()=>socket.destroy(new Error('MANAGEMENT_TIMEOUT')));
    socket.on('connect',()=>socket.write(`kill ${name}\n`));
    socket.on('data',data=>{
      response+=data;
      if(response.includes('SUCCESS:') || response.includes('not found')) { socket.destroy(); resolve(); }
      else if(response.includes('ERROR:')) socket.destroy(new Error('MANAGEMENT_REJECTED'));
    });
    socket.on('error',reject);
  });
}
async function sync() {
  // syncconf preserves healthy peers; no service restart for peer updates.
  let wg=`[Interface]\nPrivateKey = ${read(root+'/server.key')}\nListenPort = 51820\n`;
  for(const c of Object.values(clients)) if(c.enabled && Date.now()<c.expiresAt) wg+=`\n[Peer]\nPublicKey = ${c.publicKey}\nPresharedKey = ${c.presharedKey}\nAllowedIPs = ${c.address}/32\n`;
  write('/etc/wireguard/nivora-runtime.conf',wg);
  run('wg',['syncconf','nvwg0','/etc/wireguard/nivora-runtime.conf']);
  for(const [name,c] of Object.entries(clients)) if(!c.enabled || Date.now()>=c.expiresAt) await killClient(name);
}
if(command==='add') {
  if(!validClientId(id)) throw new Error('INVALID_CLIENT_ID');
  if(clients[id]) throw new Error('CLIENT_EXISTS');
  const days=Number(daysArg||7);
  if(!Number.isInteger(days)||days<1||days>365) throw new Error('INVALID_DAYS');
  const used=new Set(Object.values(clients).map(c=>c.address));
  const address=Array.from({length:253},(_,i)=>`10.77.0.${i+2}`).find(a=>!used.has(a));
  if(!address) throw new Error('NODE_FULL');
  const privateKey=run('wg',['genkey']),publicKey=run('wg',['pubkey'],{input:privateKey+'\n'}),presharedKey=run('wg',['genpsk']);
  run('/usr/share/easy-rsa/easyrsa',['--batch','build-client-full',id,'nopass'],{env:{...process.env,EASYRSA_PKI:root+'/pki',EASYRSA_CERT_EXPIRE:'365'}});
  clients[id]={address,privateKey,publicKey,presharedKey,enabled:true,expiresAt:Date.now()+days*86400000};
  save(); await sync();
} else if(['suspend','resume','renew'].includes(command)) {
  if(!validClientId(id)||!clients[id]) throw new Error('CLIENT_NOT_FOUND');
  if(command==='renew') {
    const days=Number(daysArg);
    if(!Number.isInteger(days)||days<1||days>365) throw new Error('INVALID_DAYS');
    clients[id].expiresAt=Math.max(Date.now(),clients[id].expiresAt)+days*86400000;
  } else clients[id].enabled=command==='resume';
  save(); await sync();
} else if(command==='sync') { save(); await sync(); }
else if(command==='export') {
  if(!validClientId(id)||!clients[id]) throw new Error('CLIENT_NOT_FOUND');
  const c=clients[id];
  if(!c.enabled||Date.now()>=c.expiresAt) throw new Error('CLIENT_INACTIVE');
  const dest=root+'/exports';fs.mkdirSync(dest,{recursive:true,mode:0o700});
  write(`${dest}/${id}.conf`,wireguardProfile({host:endpoint(config.host),...c,publicKey:read(root+'/server.pub')}));
  write(`${dest}/${id}.ovpn`,openvpnProfile({host:config.host,ca:read(root+'/pki/ca.crt'),cert:read(root+`/pki/issued/${id}.crt`),privateKey:read(root+`/pki/private/${id}.key`),tlsCrypt:read(root+'/tls-crypt.key')}));
  console.log(`Private profiles saved in ${dest}; do not publish them.`);
} else if(command==='status') {
  console.log(JSON.stringify(Object.entries(clients).map(([name,c])=>({id:name,address:c.address,enabled:c.enabled,expiresAt:new Date(c.expiresAt).toISOString()})),null,2));
} else throw new Error('COMMAND: add ID DAYS | suspend ID | resume ID | renew ID DAYS | export ID | sync | status');
