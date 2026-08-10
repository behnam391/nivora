import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
const SHARE_SCHEMES = ['vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://'];

const decodeBase64 = value => Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const encodeBase64 = value => Buffer.from(value, 'utf8').toString('base64');

export function decodeSubscription(raw) {
  const trimmed = String(raw || '').trim();
  if (SHARE_SCHEMES.some(scheme => trimmed.toLowerCase().includes(scheme))) return { text: trimmed, base64: false };
  try {
    const decoded = decodeBase64(trimmed).trim();
    if (SHARE_SCHEMES.some(scheme => decoded.toLowerCase().includes(scheme))) return { text: decoded, base64: true };
  } catch {}
  return { text: trimmed, base64: false };
}

function appendLabel(hash, label) {
  const current = decodeURIComponent(String(hash || '').replace(/^#/, '')).trim();
  return encodeURIComponent([current, label].filter(Boolean).join(' · '));
}

function rewriteVmess(link, endpoint) {
  const payload = JSON.parse(decodeBase64(link.slice('vmess://'.length)));
  payload.add = endpoint.host;
  if (endpoint.port) payload.port = String(endpoint.port);
  payload.ps = [payload.ps, endpoint.label].filter(Boolean).join(' · ');
  return `vmess://${encodeBase64(JSON.stringify(payload))}`;
}

function rewriteUri(link, endpoint) {
  const parsed = new URL(link);
  if (!parsed.hostname) return null;
  parsed.hostname = endpoint.host;
  if (endpoint.port) parsed.port = String(endpoint.port);
  parsed.hash = appendLabel(parsed.hash, endpoint.label);
  return parsed.toString();
}

export function rewriteShareLink(link, endpoint) {
  const normalized = String(link || '').trim();
  if (!normalized) return null;
  try {
    if (normalized.toLowerCase().startsWith('vmess://')) return rewriteVmess(normalized, endpoint);
    if (SHARE_SCHEMES.some(scheme => scheme !== 'vmess://' && normalized.toLowerCase().startsWith(scheme))) return rewriteUri(normalized, endpoint);
  } catch {}
  return null;
}

export function buildMultiEndpointSubscription(raw, endpoints) {
  const source = decodeSubscription(raw);
  const links = source.text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const active = [...endpoints]
    .filter(endpoint => endpoint.active !== false && endpoint.host)
    .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
  if (!active.length || !links.length) return String(raw || '');
  const rewritten = [];
  for (const endpoint of active) {
    for (const link of links) {
      const result = rewriteShareLink(link, endpoint);
      if (result) rewritten.push(result);
    }
  }
  const output = [...new Set(rewritten)].join('\n');
  if (!output) return String(raw || '');
  return source.base64 ? encodeBase64(output) : output;
}

export function fetchSubscriptionText(target, { timeoutMs = 15_000, rejectUnauthorized = true, redirects = 3 } = {}) {
  const url = target instanceof URL ? target : new URL(target);
  if (!['http:', 'https:'].includes(url.protocol)) return Promise.reject(new Error('UNSUPPORTED_SUBSCRIPTION_PROTOCOL'));
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      rejectUnauthorized,
      timeout: timeoutMs,
      headers: { accept: 'text/plain, application/octet-stream;q=0.9', 'user-agent': 'Nivora-Subscription/1.0' }
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
        response.resume();
        return resolve(fetchSubscriptionText(new URL(response.headers.location, url), { timeoutMs, rejectUnauthorized, redirects: redirects - 1 }));
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`UPSTREAM_SUBSCRIPTION_HTTP_${response.statusCode}`));
      }
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
        if (Buffer.byteLength(raw) > MAX_SUBSCRIPTION_BYTES) request.destroy(new Error('UPSTREAM_SUBSCRIPTION_TOO_LARGE'));
      });
      response.on('end', () => resolve(raw));
    });
    request.on('timeout', () => request.destroy(new Error('UPSTREAM_SUBSCRIPTION_TIMEOUT')));
    request.on('error', reject);
  });
}

export function measureTcpEndpoint(host, port, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const started = process.hrtime.bigint();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      const latencyMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      socket.destroy();
      resolve(latencyMs);
    });
    socket.once('timeout', () => socket.destroy(new Error('ENDPOINT_TIMEOUT')));
    socket.once('error', reject);
  });
}
