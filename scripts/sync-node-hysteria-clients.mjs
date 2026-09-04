import { createDecipheriv, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import https from 'node:https';

const [nodeSelector] = process.argv.slice(2);
if (!nodeSelector) throw new Error('Usage: node scripts/sync-node-hysteria-clients.mjs <node-name-or-host>');

const db = new DatabaseSync(process.env.DATABASE_PATH || './data/nivora.db', { readOnly: true });
const nodes = db.prepare('SELECT * FROM panel_nodes WHERE active=1 AND (name=? OR base_url LIKE ?)')
  .all(nodeSelector, `%${nodeSelector}%`);
db.close();
if (nodes.length !== 1) throw new Error(nodes.length ? 'Node selector is ambiguous' : `Panel node not found: ${nodeSelector}`);
const node = nodes[0];

const sourceIds = String(node.vision_inbound_ids || '').split(',').map(Number).filter(Number.isInteger);
const targetIds = String(node.hysteria_inbound_ids || '').split(',').map(Number).filter(Number.isInteger);
if (!sourceIds.length || !targetIds.length) throw new Error('Vision and Hysteria2 inbound IDs must be configured first');

const key = createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY || process.env.ADMIN_TOKEN || '').digest();
const [iv, tag, cipher] = String(node.api_token_encrypted || '').split('.');
const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
decipher.setAuthTag(Buffer.from(tag, 'base64url'));
const token = Buffer.concat([decipher.update(Buffer.from(cipher, 'base64url')), decipher.final()]).toString('utf8');

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
const allInbounds = await call('GET', 'inbounds/list');
const byId = new Map(allInbounds.map(inbound => [Number(inbound.id), inbound]));
const sourceClients = new Map();
for (const sourceId of sourceIds) {
  const inbound = byId.get(sourceId);
  if (!inbound) throw new Error(`Vision inbound not found: ${sourceId}`);
  for (const client of parse(inbound.settings).clients || []) {
    if (client?.email && client.enable !== false && !sourceClients.has(client.email)) sourceClients.set(client.email, client);
  }
}

const backupRoot = process.env.NIVORA_BACKUP_DIRECTORY || './backups';
mkdirSync(backupRoot, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${backupRoot}/before-hysteria-client-sync-${stamp}.json`;
writeFileSync(backupPath, `${JSON.stringify(allInbounds, null, 2)}\n`, { mode: 0o600 });

let added = 0;
for (const targetId of targetIds) {
  const inbound = byId.get(targetId);
  if (!inbound || inbound.protocol !== 'hysteria') throw new Error(`Hysteria2 inbound not found: ${targetId}`);
  const existing = new Set((parse(inbound.settings).clients || []).map(client => client?.email).filter(Boolean));
  for (const client of sourceClients.values()) {
    if (existing.has(client.email)) continue;
    await call('POST', 'clients/add', {
      client: { ...client, flow: '', limitIp: 0 },
      inboundIds: [targetId]
    });
    existing.add(client.email);
    added += 1;
  }
}

const verified = await call('GET', 'inbounds/list');
const targetSummary = verified.filter(inbound => targetIds.includes(Number(inbound.id))).map(inbound => ({
  id: Number(inbound.id),
  remark: inbound.remark,
  protocol: inbound.protocol,
  clients: (parse(inbound.settings).clients || []).length,
  authReady: (parse(inbound.settings).clients || []).filter(client => Boolean(client?.auth)).length
}));
console.log(JSON.stringify({ backupPath, activeSourceClients: sourceClients.size, added, targets: targetSummary }, null, 2));
