import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import https from 'node:https';

const args = process.argv.slice(2);
const selector = String(args[0] || '').trim();
const publicHost = String(args[1] || '').trim().toLowerCase();
const remark = String(args[2] || '').trim();
if (!selector || !publicHost || !remark) {
  throw new Error('Usage: node scripts/ensure-hysteria2-inbound.mjs <default|node-name-or-host> <public-host> <remark>');
}
if (!/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|(?:\d{1,3}\.){3}\d{1,3})$/.test(publicHost)) {
  throw new Error('Public host is invalid');
}

let node;
let token = process.env.PANEL_API_TOKEN || '';
if (selector === 'default') {
  if (!process.env.PANEL_BASE_URL || !token) throw new Error('Default panel environment is not configured');
  node = { name: 'default', base_url: process.env.PANEL_BASE_URL };
} else {
  const db = new DatabaseSync(process.env.DATABASE_PATH || './data/nivora.db', { readOnly: true });
  const matches = db.prepare('SELECT * FROM panel_nodes WHERE active=1 AND (name=? OR base_url LIKE ?)')
    .all(selector, `%${selector}%`);
  db.close();
  if (matches.length !== 1) throw new Error(matches.length ? 'Node selector is ambiguous' : `Panel node not found: ${selector}`);
  node = matches[0];
  const key = createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY || process.env.ADMIN_TOKEN || '').digest();
  const [iv, tag, cipher] = String(node.api_token_encrypted || '').split('.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  token = Buffer.concat([decipher.update(Buffer.from(cipher, 'base64url')), decipher.final()]).toString('utf8');
}
if (!token) throw new Error('Panel API token is not configured');

function call(method, path, body) {
  const url = new URL(`${node.base_url.replace(/\/$/, '')}/panel/api/${path}`);
  const payload = body === undefined ? '' : JSON.stringify(body);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      rejectUnauthorized: false,
      timeout: 20_000,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => raw += chunk);
      response.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          if (response.statusCode < 200 || response.statusCode >= 300 || parsed.success === false) {
            throw new Error(parsed.msg || `3X-UI HTTP ${response.statusCode}`);
          }
          resolve(parsed.obj ?? parsed);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('3X-UI request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const parse = value => typeof value === 'string' ? JSON.parse(value) : structuredClone(value || {});
const inbounds = await call('GET', 'inbounds/list');
const existing = inbounds.find(inbound => inbound.protocol === 'hysteria' && String(inbound.remark).trim() === remark);
if (existing) {
  const settings = parse(existing.settings);
  console.log(JSON.stringify({ created: false, id: Number(existing.id), remark: existing.remark, port: Number(existing.port), clients: settings.clients?.length || 0 }, null, 2));
  process.exit(0);
}

if (inbounds.some(inbound => inbound.protocol === 'hysteria' && Number(inbound.port) === 443)) {
  throw new Error('Another Hysteria inbound already uses UDP/443; reuse or rename it instead of creating a duplicate');
}

const certFiles = await call('GET', 'server/getWebCertFiles');
const certificateFile = String(certFiles?.webCertFile || '').trim();
const keyFile = String(certFiles?.webKeyFile || '').trim();
if (!certificateFile || !keyFile) throw new Error('Panel TLS certificate paths are not configured');

const backupRoot = process.env.NIVORA_BACKUP_DIRECTORY || './backups';
mkdirSync(backupRoot, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${backupRoot}/before-hysteria-create-${selector.replace(/[^a-z0-9_.-]+/gi, '-')}-${stamp}.json`;
writeFileSync(backupPath, `${JSON.stringify(inbounds, null, 2)}\n`, { mode: 0o600 });

const body = {
  up: 0,
  down: 0,
  total: 0,
  remark,
  enable: true,
  expiryTime: 0,
  listen: '',
  port: 443,
  protocol: 'hysteria',
  settings: JSON.stringify({ clients: [], version: 2 }),
  streamSettings: JSON.stringify({
    network: 'hysteria',
    security: 'tls',
    hysteriaSettings: { version: 2, udpIdleTimeout: 60 },
    tlsSettings: {
      serverName: publicHost,
      minVersion: '1.2',
      maxVersion: '1.3',
      cipherSuites: '',
      rejectUnknownSni: false,
      disableSystemRoot: false,
      enableSessionResumption: false,
      certificates: [{
        certificateFile,
        keyFile,
        ocspStapling: 0,
        oneTimeLoading: false,
        usage: 'encipherment',
        buildChain: false
      }],
      alpn: ['h3'],
      echServerKeys: '',
      settings: { echConfigList: '', pinnedPeerCertSha256: [], verifyPeerCertByName: '' }
    },
    finalmask: { udp: [{ type: 'salamander', settings: { password: randomBytes(18).toString('base64url') } }] }
  }),
  sniffing: JSON.stringify({ enabled: false, destOverride: ['http', 'tls', 'quic', 'fakedns'], metadataOnly: false, routeOnly: false }),
  allocate: JSON.stringify({ strategy: 'always', refresh: 5, concurrency: 3 }),
  trafficReset: 'never',
  trafficResetDay: 1,
  subSortIndex: 1,
  shareAddrStrategy: 'node',
  shareAddr: ''
};

const added = await call('POST', 'inbounds/add', body);
const createdId = Number(added?.id || 0);
const verified = (await call('GET', 'inbounds/list')).find(inbound =>
  (createdId && Number(inbound.id) === createdId) ||
  (inbound.protocol === 'hysteria' && String(inbound.remark).trim() === remark)
);
if (!verified) throw new Error('Hysteria2 inbound was not visible after creation');
const verifiedSettings = parse(verified.settings);
const verifiedStream = parse(verified.streamSettings);
if (verified.protocol !== 'hysteria' || Number(verified.port) !== 443 || Number(verifiedSettings.version) !== 2) {
  throw new Error('Created inbound did not pass Hysteria2 verification');
}

console.log(JSON.stringify({
  created: true,
  backupPath,
  id: Number(verified.id),
  remark: verified.remark,
  port: Number(verified.port),
  version: Number(verifiedSettings.version),
  security: verifiedStream.security,
  serverName: verifiedStream.tlsSettings?.serverName || publicHost
}, null, 2));
