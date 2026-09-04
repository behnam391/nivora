import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import https from 'node:https';

const selector = process.argv.slice(2).join(' ').trim();
const db = new DatabaseSync(process.env.DATABASE_PATH || './data/nivora.db', { readOnly: true });
const safeNodes = db.prepare(`
  SELECT id,name,provider,base_url,subscription_base_url,vision_inbound_ids,cdn_inbound_ids,hysteria_inbound_ids,active
  FROM panel_nodes ORDER BY name
`).all();
if (!selector) {
  db.close();
  console.log(JSON.stringify({ nodes: safeNodes }, null, 2));
  process.exit(0);
}
const matches = db.prepare('SELECT * FROM panel_nodes WHERE name=? OR base_url LIKE ?').all(selector, `%${selector}%`);
db.close();
if (matches.length !== 1) throw new Error(matches.length ? 'Node selector is ambiguous' : `Panel node not found: ${selector}`);
const node = matches[0];

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
          if (response.statusCode < 200 || response.statusCode >= 300 || parsed.success === false) throw new Error(parsed.msg || `HTTP ${response.statusCode}`);
          resolve(parsed.obj ?? parsed);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const parse = value => {
  try { return typeof value === 'string' ? JSON.parse(value) : structuredClone(value || {}); }
  catch { return {}; }
};
const [inbounds, settings] = await Promise.all([call('GET', 'inbounds/list'), call('POST', 'setting/all', {})]);
const settingValues = settings || {};
const certSettings = Object.fromEntries(Object.entries(settingValues).filter(([name]) =>
  /^(web|sub)(Cert|Key)File$/i.test(name) || /^(web|sub)(Domain|Port|Enable)$/i.test(name)
));
const safeInbounds = inbounds.map(inbound => {
  const stream = parse(inbound.streamSettings);
  const tls = stream.tlsSettings || {};
  return {
    id: Number(inbound.id),
    remark: inbound.remark,
    port: Number(inbound.port),
    protocol: inbound.protocol,
    enable: Boolean(inbound.enable),
    network: stream.network || '',
    security: stream.security || '',
    sni: tls.serverName || '',
    certificates: (tls.certificates || []).map(cert => ({
      certificateFile: cert.certificateFile || '',
      keyFile: cert.keyFile || ''
    }))
  };
});
console.log(JSON.stringify({ node: safeNodes.find(item => item.id === node.id), certSettings, inbounds: safeInbounds }, null, 2));
