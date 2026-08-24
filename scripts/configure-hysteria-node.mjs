import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/db.js';
import { encryptHysteriaNodeValue, hashHysteriaNodeSecret } from '../src/hysteria-auth.js';

const [routeId, locationId, publicHost, portText = '443', sni = publicHost] = process.argv.slice(2);
const port = Number(portText);
if (!/^[A-Za-z0-9_.-]{2,80}$/.test(routeId || '') || !locationId || !publicHost || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Usage: node scripts/configure-hysteria-node.mjs ROUTE_ID LOCATION_ID PUBLIC_HOST [PORT] [SNI]');
}

const db = openDatabase();
if (!db.prepare('SELECT id FROM service_locations WHERE id=?').get(locationId)) throw new Error('Location does not exist');
const readRestricted = (fileName, fallback = '') => {
  if (fileName) return readFileSync(fileName, 'utf8').trim();
  return String(fallback || '').trim();
};
const nodeSecret = readRestricted(process.env.HYSTERIA2_NODE_SECRET_FILE, process.env.HYSTERIA2_NODE_SECRET);
if (!nodeSecret) throw new Error('HYSTERIA2_NODE_SECRET_FILE is required');
const obfsType = String(process.env.HYSTERIA2_OBFS_TYPE || '').trim().toLowerCase();
const obfsPassword = readRestricted(process.env.HYSTERIA2_OBFS_PASSWORD_FILE, process.env.HYSTERIA2_OBFS_PASSWORD);
if (obfsType && !['salamander','gecko'].includes(obfsType)) throw new Error('Unsupported HYSTERIA2_OBFS_TYPE');
if (obfsType && !obfsPassword) throw new Error('HYSTERIA2_OBFS_PASSWORD_FILE is required when obfs is enabled');
const pinSha256 = String(process.env.HYSTERIA2_PIN_SHA256 || '').trim();
const priority = Math.max(0, Math.min(10_000, Number(process.env.HYSTERIA2_PRIORITY) || 100));
const secretHash = hashHysteriaNodeSecret(nodeSecret);
const encryptedObfs = encryptHysteriaNodeValue(obfsPassword, process.env.HYSTERIA2_TICKET_SECRET || '');
const now = new Date().toISOString();
db.prepare(`
  INSERT INTO hysteria_nodes(id,location_id,public_host,public_port,sni,obfs_type,obfs_password_encrypted,pin_sha256,priority,node_secret_hash,active,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)
  ON CONFLICT(id) DO UPDATE SET location_id=excluded.location_id,public_host=excluded.public_host,
    public_port=excluded.public_port,sni=excluded.sni,obfs_type=excluded.obfs_type,
    obfs_password_encrypted=excluded.obfs_password_encrypted,pin_sha256=excluded.pin_sha256,
    priority=excluded.priority,node_secret_hash=excluded.node_secret_hash,active=1,updated_at=excluded.updated_at
`).run(routeId,locationId,publicHost,port,sni||'',obfsType,encryptedObfs,pinSha256,priority,secretHash,now,now);
db.close();

console.log(JSON.stringify({
  routeId,
  locationId,
  publicHost,
  port,
  sni:sni||'',
  obfsType:obfsType||null,
  certificatePinned:Boolean(pinSha256),
  priority,
  callbackPath:`/internal/v1/hysteria/auth/${routeId}`,
  usagePath:`/internal/v1/hysteria/usage/${routeId}`,
  note:'Node credentials were read from restricted files and were not printed.'
},null,2));
