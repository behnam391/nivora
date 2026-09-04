import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import https from 'node:https';

const selector = String(process.argv[2] || '').trim();
const expectedHost = String(process.argv[3] || '').trim().toLowerCase();
if (!selector || !expectedHost) throw new Error('Usage: node scripts/verify-hysteria2-subscription.mjs <default|node-name-or-host> <expected-host>');

let node;
let token = process.env.PANEL_API_TOKEN || '';
if (selector === 'default') {
  if (!process.env.PANEL_BASE_URL || !token) throw new Error('Default panel environment is not configured');
  node = { base_url: process.env.PANEL_BASE_URL };
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

function call(path) {
  const url = new URL(`${node.base_url.replace(/\/$/, '')}/panel/api/${path}`);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 20_000,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
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
    request.end();
  });
}

const parse = value => typeof value === 'string' ? JSON.parse(value) : structuredClone(value || {});
const inbounds = await call('inbounds/list');
const inbound = inbounds.find(item => item.protocol === 'hysteria' && item.enable !== false);
if (!inbound) throw new Error('No enabled Hysteria2 inbound was found');
const client = (parse(inbound.settings).clients || []).find(item => item?.enable !== false && item?.subId);
if (!client) throw new Error('Hysteria2 has no enabled client with a subscription identity');
const links = await call(`clients/subLinks/${encodeURIComponent(client.subId)}`);
const rawLink = (Array.isArray(links) ? links : []).find(link => /^hy(?:steria2|2):\/\//i.test(String(link)));
if (!rawLink) throw new Error('The client subscription does not contain a Hysteria2 link');
const link = new URL(rawLink);
const actualHost = link.hostname.toLowerCase();
const serverName = String(link.searchParams.get('sni') || '').toLowerCase();
const result = {
  ready: actualHost === expectedHost && serverName === expectedHost && Boolean(link.username),
  inboundId: Number(inbound.id),
  remark: inbound.remark,
  scheme: link.protocol.replace(':', ''),
  host: actualHost,
  port: Number(link.port || 443),
  serverName,
  alpn: link.searchParams.get('alpn') || '',
  authenticationPresent: Boolean(link.username),
  clients: (parse(inbound.settings).clients || []).length
};
if (!result.ready) throw new Error(`Hysteria2 subscription verification failed: ${JSON.stringify(result)}`);
console.log(JSON.stringify(result, null, 2));
