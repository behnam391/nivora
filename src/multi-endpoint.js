import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
const SHARE_SCHEMES = ['vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://'];
const CDN_TRANSPORTS = new Set(['ws', 'websocket', 'grpc', 'xhttp', 'splithttp', 'httpupgrade']);
const CLOUDFLARE_IPV4_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];

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

function isCloudflareEndpoint(endpoint) {
  return String(endpoint.mode || endpoint.transport_mode || 'direct').toLowerCase() === 'cloudflare';
}

function rewriteVmess(link, endpoint) {
  const payload = JSON.parse(decodeBase64(link.slice('vmess://'.length)));
  if (isCloudflareEndpoint(endpoint)) {
    const network = String(payload.net || '').toLowerCase();
    const tls = String(payload.tls || '').toLowerCase();
    if (!CDN_TRANSPORTS.has(network) || (tls !== 'tls' && tls !== 'reality')) return null;
    const serverName = endpoint.serverName || endpoint.server_name;
    if (!serverName) return null;
    payload.add = endpoint.host;
    payload.port = String(endpoint.port || 443);
    payload.host = serverName;
    payload.sni = serverName;
    payload.tls = 'tls';
  } else {
    payload.add = endpoint.host;
    if (endpoint.port) payload.port = String(endpoint.port);
  }
  payload.ps = [payload.ps, endpoint.label].filter(Boolean).join(' · ');
  return `vmess://${encodeBase64(JSON.stringify(payload))}`;
}

function rewriteUri(link, endpoint) {
  const parsed = new URL(link);
  if (!parsed.hostname) return null;
  if (isCloudflareEndpoint(endpoint)) {
    const network = String(parsed.searchParams.get('type') || parsed.searchParams.get('network') || '').toLowerCase();
    const security = String(parsed.searchParams.get('security') || '').toLowerCase();
    const serverName = endpoint.serverName || endpoint.server_name;
    if (!CDN_TRANSPORTS.has(network) || security !== 'tls' || !serverName) return null;
    parsed.hostname = endpoint.host;
    parsed.port = String(endpoint.port || 443);
    parsed.searchParams.set('sni', serverName);
    parsed.searchParams.set('host', serverName);
    parsed.searchParams.delete('flow');
  } else {
    parsed.hostname = endpoint.host;
    if (endpoint.port) parsed.port = String(endpoint.port);
  }
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
  const output = [...links];
  for (const endpoint of active) {
    for (const link of links) {
      const result = rewriteShareLink(link, endpoint);
      if (result) output.push(result);
    }
  }
  const rendered = [...new Set(output)].join('\n');
  return source.base64 ? encodeBase64(rendered) : rendered;
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

const ipv4ToInt = value => value.split('.').reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
const cidrContains = (cidr, ip) => {
  const [network, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(network) & mask) === (ipv4ToInt(ip) & mask);
};

export const isCloudflareIpv4 = ip => net.isIPv4(ip) && CLOUDFLARE_IPV4_CIDRS.some(cidr => cidrContains(cidr, ip));

export function parseCleanIpList(raw, limit = 50) {
  const found = [];
  const text = String(raw || '');
  const expression = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
  for (const match of text.matchAll(expression)) {
    const ip = match[0];
    const trailing = text.slice((match.index || 0) + ip.length, (match.index || 0) + ip.length + 4);
    if (trailing.startsWith('/') || !isCloudflareIpv4(ip) || found.includes(ip)) continue;
    found.push(ip);
    if (found.length >= Math.max(1, Math.min(Number(limit) || 50, 100))) break;
  }
  return found;
}

function isPublicResolvedAddress(address) {
  if (net.isIPv4(address)) {
    const value = ipv4ToInt(address);
    const blocked = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4'];
    return !blocked.some(cidr => cidrContains(cidr, address)) && value !== 0xffffffff;
  }
  return net.isIPv6(address) && address !== '::1' && !address.toLowerCase().startsWith('fc') && !address.toLowerCase().startsWith('fd') && !address.toLowerCase().startsWith('fe8');
}

export async function fetchCleanIpSource(target, { timeoutMs = 12_000, redirects = 2, limit = 50 } = {}) {
  const url = target instanceof URL ? target : new URL(target);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('CLEAN_IP_SOURCE_MUST_BE_PUBLIC_HTTPS');
  const resolved = await dns.promises.lookup(url.hostname, { all: true });
  const allowed = resolved.filter(record => isPublicResolvedAddress(record.address));
  if (!allowed.length || allowed.length !== resolved.length) throw new Error('CLEAN_IP_SOURCE_NOT_PUBLIC');
  const selected = allowed[0];
  const raw = await new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: timeoutMs,
      headers: { accept: 'text/plain, text/csv;q=0.9, application/json;q=0.8', 'user-agent': 'Nivora-CleanIP-Importer/1.0' },
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family)
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
        response.resume();
        return resolve(fetchCleanIpSource(new URL(response.headers.location, url), { timeoutMs, redirects: redirects - 1, limit }).then(result => result.raw));
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`CLEAN_IP_SOURCE_HTTP_${response.statusCode}`));
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_SUBSCRIPTION_BYTES) request.destroy(new Error('CLEAN_IP_SOURCE_TOO_LARGE'));
      });
      response.on('end', () => resolve(body));
    });
    request.on('timeout', () => request.destroy(new Error('CLEAN_IP_SOURCE_TIMEOUT')));
    request.on('error', reject);
  });
  return { raw, ips: parseCleanIpList(raw, limit) };
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

export function measureCloudflareEndpoint(host, port, serverName, timeoutMs = 7_000) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const request = https.request({
      host,
      port: Number(port),
      servername: serverName,
      method: 'HEAD',
      path: '/',
      timeout: timeoutMs,
      rejectUnauthorized: true,
      headers: { host: serverName, 'user-agent': 'Nivora-Route-Probe/1.0', connection: 'close' }
    }, response => {
      response.resume();
      const latencyMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      resolve(latencyMs);
    });
    request.on('timeout', () => request.destroy(new Error('ENDPOINT_TIMEOUT')));
    request.on('error', reject);
    request.end();
  });
}
