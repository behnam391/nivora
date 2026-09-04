import { createDecipheriv, createHash, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const selector = String(process.argv[2] || '').trim();
const expectedHost = String(process.argv[3] || '').trim().toLowerCase();
if (!selector || !expectedHost) throw new Error('Usage: node scripts/smoke-test-hysteria2.mjs <default|node-name-or-host> <expected-host>');

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
      method: 'GET', rejectUnauthorized: false, timeout: 20_000,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => raw += chunk);
      response.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          if (response.statusCode < 200 || response.statusCode >= 300 || parsed.success === false) throw new Error(parsed.msg || `3X-UI HTTP ${response.statusCode}`);
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
const client = inbound && (parse(inbound.settings).clients || []).find(item => item?.enable !== false && item?.subId);
if (!client) throw new Error('No enabled Hysteria2 test identity was found');
const links = await call(`clients/subLinks/${encodeURIComponent(client.subId)}`);
const rawLink = (Array.isArray(links) ? links : []).find(link => /^hy(?:steria2|2):\/\//i.test(String(link)));
if (!rawLink) throw new Error('The selected subscription has no Hysteria2 link');
const link = new URL(rawLink);
const host = link.hostname.toLowerCase();
const sni = String(link.searchParams.get('sni') || '').toLowerCase();
const password = link.searchParams.get('obfs-password') || '';
if (host !== expectedHost || sni !== expectedHost || !link.username || link.searchParams.get('obfs') !== 'salamander' || !password) {
  throw new Error('The generated Hysteria2 link is incomplete');
}

const socksPort = randomInt(22000, 42000);
const configPath = join(tmpdir(), `nivora-hysteria-smoke-${process.pid}-${socksPort}.json`);
const config = {
  log: { loglevel: 'warning' },
  inbounds: [{ listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { udp: true } }],
  outbounds: [{
    protocol: 'hysteria', tag: 'proxy',
    settings: { version: 2, address: host, port: Number(link.port || 443) },
    streamSettings: {
      network: 'hysteria', security: 'tls',
      hysteriaSettings: { version: 2, auth: decodeURIComponent(link.username), udpIdleTimeout: 60 },
      tlsSettings: { serverName: sni, alpn: ['h3'] },
      finalmask: { udp: [{ type: 'salamander', settings: { password } }] }
    }
  }]
};
mkdirSync(tmpdir(), { recursive: true });
writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });

const xrayBinary = process.env.XRAY_BINARY || '/usr/local/x-ui/bin/xray-linux-amd64';
const xray = spawn(xrayBinary, ['run', '-c', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostics = '';
xray.stderr.setEncoding('utf8');
xray.stderr.on('data', chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-4000); });

const waitForPort = () => new Promise((resolve, reject) => {
  const deadline = Date.now() + 8000;
  const probe = () => {
    const socket = net.connect({ host: '127.0.0.1', port: socksPort });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', () => {
      socket.destroy();
      if (Date.now() >= deadline) reject(new Error(`Xray SOCKS listener did not start: ${diagnostics.replace(/\s+/g, ' ').trim()}`));
      else setTimeout(probe, 150);
    });
  };
  probe();
});

try {
  await waitForPort();
  const startedAt = Date.now();
  const curl = spawn('curl', ['--silent', '--show-error', '--fail', '--max-time', '20', '--socks5-hostname', `127.0.0.1:${socksPort}`, 'https://www.gstatic.com/generate_204'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let curlError = '';
  curl.stderr.setEncoding('utf8');
  curl.stderr.on('data', chunk => { curlError = `${curlError}${chunk}`.slice(-2000); });
  const exitCode = await new Promise((resolve, reject) => {
    curl.once('error', reject);
    curl.once('exit', code => resolve(code));
  });
  if (exitCode !== 0) throw new Error(`Hysteria2 egress probe failed: ${curlError.replace(/\s+/g, ' ').trim() || `curl exit ${exitCode}`}`);
  console.log(JSON.stringify({ ready: true, host, port: Number(link.port || 443), serverName: sni, latencyMs: Date.now() - startedAt }, null, 2));
} finally {
  xray.kill('SIGTERM');
  try { unlinkSync(configPath); } catch {}
}
