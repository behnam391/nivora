import { isIP } from 'node:net';

export function validClientId(id) { return /^[a-z][a-z0-9-]{2,47}$/.test(id); }
export function endpoint(host) {
  if (!(isIP(host) === 4 || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host))) throw new Error('INVALID_HOST');
  return host;
}
function key(value) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('INVALID_KEY');
  return value;
}
export function wireguardProfile({host, privateKey, publicKey, presharedKey, address}) {
  if (!/^10\.77\.0\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(address)) throw new Error('INVALID_ADDRESS');
  return `[Interface]\nPrivateKey = ${key(privateKey)}\nAddress = ${address}/32\nDNS = 1.1.1.1, 1.0.0.1\nMTU = 1280\n\n[Peer]\nPublicKey = ${key(publicKey)}\nPresharedKey = ${key(presharedKey)}\nEndpoint = ${endpoint(host)}:51820\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n`;
}
export function openvpnProfile({host, ca, cert, privateKey, tlsCrypt}) {
  for (const value of [ca, cert, privateKey, tlsCrypt]) if (typeof value !== 'string' || !value.includes('-----BEGIN ') || value.includes('</')) throw new Error('INVALID_PEM');
  return `client\ndev tun\nproto tcp-client\nremote ${endpoint(host)} 1194\nresolv-retry infinite\nnobind\npersist-key\npersist-tun\nremote-cert-tls server\nverify-x509-name nivora-classic-server name\ntls-version-min 1.2\ndata-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305\nauth SHA256\nauth-nocache\nverb 3\n<ca>\n${ca.trim()}\n</ca>\n<cert>\n${cert.trim()}\n</cert>\n<key>\n${privateKey.trim()}\n</key>\n<tls-crypt>\n${tlsCrypt.trim()}\n</tls-crypt>\n`;
}
