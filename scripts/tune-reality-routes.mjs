import http from 'node:http';
import https from 'node:https';
import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

const apply = process.argv.includes('--apply');
const databasePath = process.env.DATABASE_PATH || '/opt/nivora/data/nivora.db';
const backupRoot = process.env.NIVORA_BACKUP_DIRECTORY || '/opt/nivora/backups';
const target = process.env.NIVORA_REALITY_TARGET || 'www.speedtest.net:443';
const serverName = target.replace(/:\d+$/, '');
const settingsKey = createHash('sha256')
  .update(process.env.SETTINGS_ENCRYPTION_KEY || process.env.ADMIN_TOKEN || '')
  .digest();

if (!process.env.PANEL_BASE_URL || !process.env.PANEL_API_TOKEN) {
  throw new Error('Main panel configuration is incomplete');
}

function decrypt(value) {
  try {
    const [iv, tag, ciphertext] = String(value || '').split('.');
    const decipher = createDecipheriv('aes-256-gcm', settingsKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}

function request(node, method, path, body) {
  const url = new URL(`${node.baseUrl.replace(/\/$/, '')}/panel/api/${path.replace(/^\//, '')}`);
  const payload = body === undefined ? null : JSON.stringify(body);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method,
      rejectUnauthorized: node.rejectUnauthorized,
      timeout: 20_000,
      headers: {
        authorization: `Bearer ${node.apiToken}`,
        accept: 'application/json',
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
      },
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => raw += chunk);
      response.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          if (response.statusCode < 200 || response.statusCode >= 300 || parsed.success === false) {
            throw new Error(parsed.msg || `${node.name}: HTTP ${response.statusCode}`);
          }
          resolve(parsed.obj ?? parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${node.name}: request timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function streamOf(inbound) {
  const raw = inbound.streamSettings ?? inbound.stream_settings ?? {};
  return typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
}

function settingsOf(inbound) {
  const raw = inbound.settings ?? {};
  return typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
}

function sniffingOf(inbound) {
  const raw = inbound.sniffing ?? {};
  return typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
}

function assertReality(inbound, node) {
  const stream = streamOf(inbound);
  if (inbound.protocol !== 'vless' || stream.network !== 'tcp' || stream.security !== 'reality') {
    throw new Error(`${node.name}: inbound ${inbound.id} is not VLESS TCP Reality`);
  }
  if (!stream.realitySettings?.privateKey) {
    throw new Error(`${node.name}: inbound ${inbound.id} has no Reality private key`);
  }
}

function updatePayload(inbound, { remark, port }) {
  const streamSettings = streamOf(inbound);
  streamSettings.realitySettings = {
    ...streamSettings.realitySettings,
    target,
    serverNames: [serverName],
    show: false,
    xver: 0,
  };
  return {
    enable: Boolean(inbound.enable),
    remark,
    listen: inbound.listen || '',
    port,
    protocol: inbound.protocol,
    expiryTime: Number(inbound.expiryTime ?? inbound.expiry_time ?? 0),
    total: Number(inbound.total || 0),
    settings: settingsOf(inbound),
    streamSettings,
    sniffing: sniffingOf(inbound),
    shareAddrStrategy: inbound.shareAddrStrategy ?? inbound.share_addr_strategy,
    shareAddr: inbound.shareAddr ?? inbound.share_addr,
  };
}

function summary(node, inbound) {
  const stream = streamOf(inbound);
  return {
    node: node.name,
    id: inbound.id,
    remark: inbound.remark,
    port: inbound.port,
    network: stream.network,
    security: stream.security,
    target: stream.realitySettings?.target || stream.realitySettings?.dest,
    serverNames: stream.realitySettings?.serverNames,
  };
}

const db = new DatabaseSync(databasePath, { readOnly: true });
const remoteNodes = db.prepare(`
  SELECT name,base_url,api_token_encrypted
  FROM panel_nodes WHERE active=1 ORDER BY name
`).all().map(row => ({
  name: row.name,
  baseUrl: row.base_url,
  apiToken: decrypt(row.api_token_encrypted),
  rejectUnauthorized: false,
  primaryPort: 443,
}));

const nodes = [
  ...remoteNodes,
  {
    name: 'Helsinki',
    baseUrl: process.env.PANEL_BASE_URL,
    apiToken: process.env.PANEL_API_TOKEN,
    rejectUnauthorized: process.env.PANEL_TLS_REJECT_UNAUTHORIZED !== 'false',
    primaryPort: Number(process.env.NIVORA_HELSINKI_REALITY_PORT || 8443),
  },
];

if (nodes.some(node => !node.apiToken)) throw new Error('A panel API token could not be decrypted');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDirectory = `${backupRoot}/reality-tuning-${stamp}`;
if (apply) {
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
}

const planned = [];
for (const node of nodes) {
  const inbounds = await request(node, 'GET', 'inbounds/list');
  const primary = inbounds.find(item => Number(item.id) === 1);
  const backup = inbounds.find(item => Number(item.id) === 2);
  if (!primary || !backup) throw new Error(`${node.name}: Reality inbounds 1 and 2 are required`);
  assertReality(primary, node);
  assertReality(backup, node);

  if (apply) {
    const backupPath = `${backupDirectory}/${node.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    writeFileSync(backupPath, `${JSON.stringify(inbounds, null, 2)}\n`, { mode: 0o600 });
    chmodSync(backupPath, 0o600);
    await request(node, 'POST', `inbounds/update/${primary.id}`, updatePayload(primary, {
      remark: 'NIVORA-REALITY-MAIN',
      port: node.primaryPort,
    }));
    await request(node, 'POST', `inbounds/update/${backup.id}`, updatePayload(backup, {
      remark: 'NIVORA-REALITY-BACKUP',
      port: Number(backup.port),
    }));
  }

  planned.push(
    { ...summary(node, primary), nextRemark: 'NIVORA-REALITY-MAIN', nextPort: node.primaryPort, nextTarget: target },
    { ...summary(node, backup), nextRemark: 'NIVORA-REALITY-BACKUP', nextPort: Number(backup.port), nextTarget: target },
  );
}

const verified = [];
if (apply) {
  for (const node of nodes) {
    const inbounds = await request(node, 'GET', 'inbounds/list');
    verified.push(...inbounds.filter(item => [1, 2].includes(Number(item.id))).map(item => summary(node, item)));
  }
}

console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', target, backupDirectory: apply ? backupDirectory : null, planned, verified }, null, 2));
