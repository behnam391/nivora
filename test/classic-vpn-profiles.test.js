import test from 'node:test';
import assert from 'node:assert/strict';
import { validClientId, endpoint, wireguardProfile, openvpnProfile } from '../ops/classic-vpn-profiles.mjs';
const key='A'.repeat(43)+'=';
test('classic identifiers and endpoints reject injection',()=>{
  assert.ok(validClientId('pilot-iphone'));
  for(const id of ['../root','abc\nkill all','x;reboot']) assert.equal(validClientId(id),false);
  assert.equal(endpoint('65.109.218.141'),'65.109.218.141');
  assert.throws(()=>endpoint('example.com\nremote bad'));
});
test('WireGuard profile routes IPv4 and captures IPv6, with keepalive',()=>{
  const p=wireguardProfile({host:'vpn.example.com',privateKey:key,publicKey:key,presharedKey:key,address:'10.77.0.2'});
  assert.match(p,/AllowedIPs = 0.0.0.0\/0, ::\/0/);
  assert.match(p,/PersistentKeepalive = 25/);
  assert.throws(()=>wireguardProfile({host:'vpn.example.com',privateKey:key,publicKey:key,presharedKey:key,address:'192.168.1.2'}));
});
test('OpenVPN profile verifies server identity and embeds separate credentials',()=>{
  const pem='-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----';
  const p=openvpnProfile({host:'vpn.example.com',ca:pem,cert:pem,privateKey:pem,tlsCrypt:pem});
  assert.match(p,/remote-cert-tls server/);
  assert.match(p,/verify-x509-name nivora-classic-server name/);
  assert.match(p,/proto tcp-client/);
  assert.doesNotMatch(p,/comp-lzo|compress /);
  assert.throws(()=>openvpnProfile({host:'vpn.example.com',ca:pem+'</ca>',cert:pem,privateKey:pem,tlsCrypt:pem}));
});
