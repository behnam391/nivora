import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Sub1.txt';
const ALLOWED_SOURCE_HOSTS = new Set(['raw.githubusercontent.com']);
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SOURCE_LINES = 2_000;
const MAX_LINE_CHARS = 8_192;
const MAX_PARSED_CANDIDATES = 80;
const MAX_STALE_MS = 24 * 60 * 60 * 1_000;
const ALLOWED_ENDPOINT_PORTS = new Set([80, 443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8080, 8443, 8880]);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const CRITICAL_PARAMS = new Set(['security', 'sni', 'pbk', 'insecure', 'allowinsecure', 'skipcertverify', 'tlsinsecure', 'verify', 'type', 'flow', 'encryption']);
const UNSAFE_TRUE_PARAMS = new Set(['insecure', 'allowinsecure', 'skipcertverify', 'tlsinsecure']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const normalizeParamKey = value => String(value || '').trim().toLowerCase().replace(/[-_]/g, '');

const ipv4ToInt = value => value.split('.').reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
const cidrContains = (cidr, ip) => {
  const [network, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(network) & mask) === (ipv4ToInt(ip) & mask);
};

const BLOCKED_IPV4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'
];

export class EmergencyPoolError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.name = 'EmergencyPoolError';
    this.code = code;
    this.status = status;
  }
}

export function isPublicEmergencyAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  if (net.isIPv4(value)) return !BLOCKED_IPV4.some(cidr => cidrContains(cidr, value));
  if (!net.isIPv6(value)) return false;
  if (value.startsWith('::ffff:')) return isPublicEmergencyAddress(value.slice(7));
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')) return false;
  if (/^fe[89a-f]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:')) return false;
  return true;
}

export function normalizeEmergencySourceUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw new EmergencyPoolError('INVALID_EMERGENCY_SOURCE', 400); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443') || parsed.search || !ALLOWED_SOURCE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new EmergencyPoolError('INVALID_EMERGENCY_SOURCE', 400);
  }
  if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:refs\/heads\/)?[A-Za-z0-9_./-]+$/.test(parsed.pathname) || parsed.pathname.includes('/../')) {
    throw new EmergencyPoolError('INVALID_EMERGENCY_SOURCE', 400);
  }
  parsed.hash = '';
  return parsed.toString();
}

const localInterfaceAddresses = () => new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map(entry => String(entry.address).toLowerCase()));

export function normalizeEmergencyConfig(input = {}) {
  const rawSources = Array.isArray(input.sources) ? input.sources : String(input.sources || DEFAULT_SOURCE).split(/\r?\n|,/);
  const sources = [...new Set(rawSources.map(value => String(value).trim()).filter(Boolean).map(normalizeEmergencySourceUrl))].slice(0, 5);
  if (!sources.length) sources.push(DEFAULT_SOURCE);
  return {
    enabled: input.enabled === true || input.enabled === 'true',
    sources,
    maxNodes: Math.min(8, Math.max(3, Math.trunc(Number(input.maxNodes) || 8))),
    refreshMinutes: Math.min(120, Math.max(5, Math.trunc(Number(input.refreshMinutes) || 30)))
  };
}

function safeEndpointHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host || host.length > 253 || host.endsWith('.') || /[\s\u0000-\u001f\u007f]/.test(host)) return false;
  if (net.isIP(host)) return isPublicEmergencyAddress(host);
  if (!host.includes('.') || host === 'localhost' || /\.(?:localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
  return /^[a-z0-9.-]+$/.test(host) && !host.includes('..');
}

function hasUnsafeParameter(parsed) {
  const counts = new Map();
  for (const [rawKey, rawValue] of parsed.searchParams) {
    const key = normalizeParamKey(rawKey);
    if (!key || key.length > 80 || rawValue.length > 2_048 || /[\u0000-\u001f\u007f]/.test(`${key}${rawValue}`)) return true;
    if (CRITICAL_PARAMS.has(key)) {
      counts.set(key, (counts.get(key) || 0) + 1);
      if (counts.get(key) > 1) return true;
    }
    const value = rawValue.trim().toLowerCase();
    if (UNSAFE_TRUE_PARAMS.has(key) && TRUE_VALUES.has(value)) return true;
    if (key === 'verify' && FALSE_VALUES.has(value)) return true;
  }
  return false;
}

function parseEmergencyCandidate(line) {
  const value = String(line || '').replace(/^\uFEFF/, '').trim();
  if (!value || value.startsWith('#') || value.length > MAX_LINE_CHARS) return null;
  if (/[\u0000-\u001f\u007f]/.test(value) || /%(?:00|0a|0d)/i.test(value) || /%(?![0-9a-f]{2})/i.test(value)) return null;
  const scheme = value.slice(0, value.indexOf(':')).toLowerCase();
  if (!['vless', 'trojan', 'hysteria2', 'hy2'].includes(scheme)) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol.toLowerCase() !== `${scheme}:` || !parsed.username || !safeEndpointHost(parsed.hostname)) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || hasUnsafeParameter(parsed)) return null;
  if (!ALLOWED_ENDPOINT_PORTS.has(port)) return null;

  const originalHost = parsed.hostname.toLowerCase();
  const security = String(parsed.searchParams.get('security') || '').toLowerCase();
  const sni = String(parsed.searchParams.get('sni') || '').trim();
  if (scheme === 'vless') {
    if (parsed.password) return null;
    let identity;
    try { identity = decodeURIComponent(parsed.username); } catch { return null; }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity)) return null;
    if (!['tls', 'reality'].includes(security)) return null;
    if (String(parsed.searchParams.get('encryption') || 'none').toLowerCase() !== 'none') return null;
    if (sni && !safeEndpointHost(sni)) return null;
    if (security === 'reality' && (!sni || !/^[A-Za-z0-9_-]{43}$/.test(String(parsed.searchParams.get('pbk') || '')))) return null;
    const flow = String(parsed.searchParams.get('flow') || '').toLowerCase();
    if (flow && flow !== 'xtls-rprx-vision') return null;
    const transport = String(parsed.searchParams.get('type') || 'tcp').toLowerCase();
    if (!['tcp', 'grpc', 'ws', 'xhttp', 'splithttp', 'httpupgrade'].includes(transport)) return null;
  } else if (scheme === 'trojan') {
    if (security && security !== 'tls') return null;
    if (sni && !safeEndpointHost(sni)) return null;
    parsed.searchParams.set('security', 'tls');
  } else if (sni && !safeEndpointHost(sni)) {
    return null;
  }
  if (!sni && net.isIP(originalHost)) return null;
  if (!sni) parsed.searchParams.set('sni', originalHost);
  parsed.hash = '';
  const canonical = parsed.toString();
  return {
    scheme,
    parsed,
    originalHost,
    port,
    canonical,
    id: createHash('sha256').update(canonical).digest('hex').slice(0, 24),
    tcp: !['hysteria2', 'hy2'].includes(scheme)
  };
}

export function parseEmergencyFeed(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  if (lines.length > MAX_SOURCE_LINES) throw new EmergencyPoolError('EMERGENCY_SOURCE_TOO_MANY_LINES');
  const candidates = [];
  const seen = new Set();
  let rejected = 0;
  for (const line of lines) {
    const candidate = parseEmergencyCandidate(line);
    if (!candidate) { if (String(line).trim() && !String(line).trim().startsWith('#')) rejected += 1; continue; }
    if (seen.has(candidate.canonical)) continue;
    seen.add(candidate.canonical);
    candidates.push(candidate);
    if (candidates.length >= MAX_PARSED_CANDIDATES) break;
  }
  return { candidates, rejected };
}

async function withDeadline(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new EmergencyPoolError(code)), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

export function probeEmergencyTcp(host, port, timeoutMs = 1_800) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => socket.destroy(new EmergencyPoolError('EMERGENCY_PROBE_TIMEOUT')));
    socket.once('error', reject);
  });
}

async function vetCandidate(candidate, { lookup, probeTcp, blockedAddresses }) {
  let addresses;
  if (net.isIP(candidate.originalHost)) {
    addresses = [{ address: candidate.originalHost, family: net.isIPv4(candidate.originalHost) ? 4 : 6 }];
  } else {
    try {
      addresses = await withDeadline(lookup(candidate.originalHost, { all: true, verbatim: true }), 3_000, 'EMERGENCY_DNS_TIMEOUT');
    } catch { return null; }
  }
  if (!addresses?.length || addresses.some(record => !isPublicEmergencyAddress(record.address) || blockedAddresses.has(String(record.address).toLowerCase()))) return null;
  const selected = addresses.find(record => record.family === 4) || addresses[0];
  if (candidate.tcp) {
    try {
      const reachable = await withDeadline(probeTcp(selected.address, candidate.port, 1_800), 2_200, 'EMERGENCY_PROBE_TIMEOUT');
      if (!reachable) return null;
    }
    catch { return null; }
  }
  candidate.parsed.hostname = selected.family === 6 ? `[${selected.address}]` : selected.address;
  candidate.parsed.hash = encodeURIComponent('Nivora Emergency');
  return { ...candidate, pinnedAddress: selected.address, uri: candidate.parsed.toString() };
}

export async function buildEmergencyBundle(raw, { maxNodes = 8, lookup = dns.promises.lookup, probeTcp = probeEmergencyTcp, blockedAddresses = localInterfaceAddresses() } = {}) {
  const feeds = [];
  const parseErrors = [];
  for (const source of (Array.isArray(raw) ? raw : [raw])) {
    try { feeds.push(parseEmergencyFeed(source)); } catch (error) { parseErrors.push(error); }
  }
  if (!feeds.length) throw parseErrors[0] || new EmergencyPoolError('EMERGENCY_POOL_EMPTY');
  const candidates = [];
  const seen = new Set();
  for (let index = 0; candidates.length < MAX_PARSED_CANDIDATES; index += 1) {
    let found = false;
    for (const feed of feeds) {
      const candidate = feed.candidates[index];
      if (!candidate) continue;
      found = true;
      if (seen.has(candidate.canonical)) continue;
      seen.add(candidate.canonical);
      candidates.push(candidate);
      if (candidates.length >= MAX_PARSED_CANDIDATES) break;
    }
    if (!found) break;
  }
  const vetted = (await mapLimit(candidates, 8, candidate => vetCandidate(candidate, { lookup, probeTcp, blockedAddresses }))).filter(Boolean);
  const tcp = vetted.filter(candidate => candidate.tcp);
  const udp = vetted.filter(candidate => !candidate.tcp);
  const ordered = [];
  while ((tcp.length || udp.length) && ordered.length < Math.min(8, Math.max(3, Number(maxNodes) || 8))) {
    if (tcp.length) ordered.push(tcp.shift());
    if (udp.length && ordered.length < maxNodes) ordered.push(udp.shift());
  }
  const selected = ordered.slice(0, maxNodes).map((candidate, index) => {
    const parsedUri = new URL(candidate.uri);
    parsedUri.hash = encodeURIComponent(`Nivora Emergency ${index + 1}`);
    return { id: candidate.id, scheme: candidate.scheme, uri: parsedUri.toString() };
  });
  if (selected.length < 1) throw new EmergencyPoolError('EMERGENCY_POOL_EMPTY');
  return {
    bundle: selected.map(item => item.uri).join('\n'),
    nodeCount: selected.length,
    accepted: vetted.length,
    rejected: feeds.reduce((sum, feed) => sum + feed.rejected, 0) + (candidates.length - vetted.length),
    protocols: [...new Set(selected.map(item => item.scheme))]
  };
}

async function resolvePinnedSource(parsed, lookup, blockedAddresses) {
  let addresses;
  try { addresses = await withDeadline(lookup(parsed.hostname, { all: true, verbatim: true }), 3_000, 'EMERGENCY_SOURCE_DNS_FAILED'); }
  catch (error) { throw error instanceof EmergencyPoolError ? error : new EmergencyPoolError('EMERGENCY_SOURCE_DNS_FAILED'); }
  if (!addresses?.length || addresses.some(record => !isPublicEmergencyAddress(record.address) || blockedAddresses.has(String(record.address).toLowerCase()))) {
    throw new EmergencyPoolError('EMERGENCY_SOURCE_DNS_FAILED');
  }
  return (addresses.find(record => record.family === 4) || addresses[0]).address;
}

function downloadPinnedSource(parsed, address, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error instanceof EmergencyPoolError ? error : new EmergencyPoolError('EMERGENCY_SOURCE_UNAVAILABLE'));
    };
    const request = https.request({
      protocol: 'https:', hostname: address, port: 443, method: 'GET',
      servername: parsed.hostname, path: `${parsed.pathname}${parsed.search}`,
      rejectUnauthorized: true,
      headers: { host: parsed.hostname, accept: 'text/plain', 'accept-encoding': 'identity', 'user-agent': 'Nivora-Emergency-Pool/1.0' }
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return fail(new EmergencyPoolError('EMERGENCY_SOURCE_UNAVAILABLE'));
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > MAX_SOURCE_BYTES) {
        response.destroy();
        return fail(new EmergencyPoolError('EMERGENCY_SOURCE_TOO_LARGE'));
      }
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        if (settled) return;
        length += chunk.length;
        if (length > MAX_SOURCE_BYTES) {
          response.destroy();
          return fail(new EmergencyPoolError('EMERGENCY_SOURCE_TOO_LARGE'));
        }
        chunks.push(chunk);
      });
      response.once('error', fail);
      response.once('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, length).toString('utf8'));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new EmergencyPoolError('EMERGENCY_SOURCE_TIMEOUT')));
    request.once('error', fail);
    request.end();
  });
}

export async function fetchEmergencySource(target, { fetchImpl = null, timeoutMs = 10_000, lookup = dns.promises.lookup, blockedAddresses = localInterfaceAddresses() } = {}) {
  const source = normalizeEmergencySourceUrl(target);
  const parsed = new URL(source);
  const pinnedAddress = await resolvePinnedSource(parsed, lookup, blockedAddresses);
  if (!fetchImpl) return downloadPinnedSource(parsed, pinnedAddress, timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(source, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'text/plain', 'accept-encoding': 'identity', 'user-agent': 'Nivora-Emergency-Pool/1.0' }
    });
    if (!response?.ok) throw new EmergencyPoolError('EMERGENCY_SOURCE_UNAVAILABLE');
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared > MAX_SOURCE_BYTES) throw new EmergencyPoolError('EMERGENCY_SOURCE_TOO_LARGE');
    const reader = response.body?.getReader?.();
    if (!reader) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_SOURCE_BYTES) throw new EmergencyPoolError('EMERGENCY_SOURCE_TOO_LARGE');
      return bytes.toString('utf8');
    }
    const chunks = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SOURCE_BYTES) { await reader.cancel(); throw new EmergencyPoolError('EMERGENCY_SOURCE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } catch (error) {
    if (error instanceof EmergencyPoolError) throw error;
    throw new EmergencyPoolError(error?.name === 'AbortError' ? 'EMERGENCY_SOURCE_TIMEOUT' : 'EMERGENCY_SOURCE_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}

export function createEmergencyPool({ getConfig, readCache, writeCache, fetchImpl = null, lookup = dns.promises.lookup, probeTcp = probeEmergencyTcp, now = () => Date.now() }) {
  let inFlight = null;
  let lastError = '';
  let failureCount = 0;
  let nextRetryAt = 0;
  const cacheValue = () => {
    try {
      const value = readCache?.();
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch { return null; }
  };
  const configValue = () => normalizeEmergencyConfig(getConfig?.() || {});
  const fingerprint = config => createHash('sha256').update(JSON.stringify({ sources: config.sources, maxNodes: config.maxNodes })).digest('hex');
  const cacheUsable = (cache, config) => cache?.bundle && cache.nodeCount > 0 && cache.configFingerprint === fingerprint(config) && now() - Date.parse(cache.updatedAt) <= MAX_STALE_MS;

  async function performRefresh({ allowDisabled = false } = {}) {
    const config = configValue();
    if (!config.enabled && !allowDisabled) throw new EmergencyPoolError('EMERGENCY_DISABLED', 403);
    const blockedAddresses = localInterfaceAddresses();
    const settled = await Promise.allSettled(config.sources.map(source => fetchEmergencySource(source, { fetchImpl, lookup, blockedAddresses })));
    const bodies = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
    if (!bodies.length) throw new EmergencyPoolError('EMERGENCY_SOURCE_UNAVAILABLE');
    const built = await buildEmergencyBundle(bodies, { maxNodes: config.maxNodes, lookup, probeTcp, blockedAddresses });
    const cache = {
      ...built,
      updatedAt: new Date(now()).toISOString(),
      configFingerprint: fingerprint(config),
      sourceCount: bodies.length
    };
    writeCache?.(JSON.stringify(cache));
    lastError = '';
    failureCount = 0;
    nextRetryAt = 0;
    return cache;
  }

  function refresh(options = {}) {
    if (!options.force && now() < nextRetryAt) return Promise.reject(new EmergencyPoolError('EMERGENCY_REFRESH_BACKOFF'));
    if (!inFlight) {
      inFlight = performRefresh(options)
        .catch(error => {
          lastError = error?.code || 'EMERGENCY_REFRESH_FAILED';
          failureCount = Math.min(failureCount + 1, 5);
          nextRetryAt = now() + Math.min(10 * 60_000, 30_000 * 2 ** (failureCount - 1));
          throw error;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  function summary(cache = cacheValue(), config = configValue()) {
    const usable = cacheUsable(cache, config);
    return {
      enabled: config.enabled,
      ready: Boolean(config.enabled && usable),
      sources: config.sources,
      maxNodes: config.maxNodes,
      refreshMinutes: config.refreshMinutes,
      nodeCount: usable ? Number(cache.nodeCount) : 0,
      protocols: usable ? cache.protocols || [] : [],
      updatedAt: usable ? cache.updatedAt : null,
      accepted: usable ? Number(cache.accepted || 0) : 0,
      rejected: usable ? Number(cache.rejected || 0) : 0,
      sourceCount: usable ? Number(cache.sourceCount || 0) : 0,
      lastError,
      retryAt: nextRetryAt > now() ? new Date(nextRetryAt).toISOString() : null
    };
  }

  function status() {
    const config = configValue();
    const cache = cacheValue();
    const age = cache?.updatedAt ? now() - Date.parse(cache.updatedAt) : Number.POSITIVE_INFINITY;
    if (config.enabled && (!cacheUsable(cache, config) || age > config.refreshMinutes * 60_000) && !inFlight) {
      refresh().catch(() => {});
    }
    return summary(cache, config);
  }

  return {
    status,
    refresh: async options => {
      const cache = await refresh(options);
      return summary(cache);
    },
    getBundle: async () => {
      const config = configValue();
      if (!config.enabled) throw new EmergencyPoolError('EMERGENCY_DISABLED', 403);
      const cache = cacheValue();
      if (cacheUsable(cache, config)) {
        const age = now() - Date.parse(cache.updatedAt);
        if (age > config.refreshMinutes * 60_000 && !inFlight) refresh().catch(() => {});
        return { bundle: cache.bundle, nodeCount: cache.nodeCount, updatedAt: cache.updatedAt, stale: age > config.refreshMinutes * 60_000 };
      }
      const fresh = await refresh();
      return { bundle: fresh.bundle, nodeCount: fresh.nodeCount, updatedAt: fresh.updatedAt, stale: false };
    }
  };
}

export const DEFAULT_EMERGENCY_SOURCE = DEFAULT_SOURCE;
