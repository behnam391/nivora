import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmergencyBundle,
  createEmergencyPool,
  EmergencyPoolError,
  fetchEmergencySource,
  isPublicEmergencyAddress,
  normalizeEmergencySourceUrl,
  parseEmergencyFeed
} from '../src/emergency-pool.js';

const uuid = '12345678-1234-4234-9234-123456789abc';
const reality = `vless://${uuid}@edge.example.com:443?encryption=none&security=reality&type=tcp&sni=www.speedtest.net&pbk=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG#Original`;
const hysteria = 'hy2://public-password@hy.example.com:443/?sni=hy.example.com#Original';
const lookup = async host => [{ address: host === 'edge.example.com' ? '203.0.114.10' : '203.0.114.11', family: 4 }];
const sourceLookup = async () => [{ address: '8.8.8.8', family: 4 }];
const probeTcp = async () => true;

test('emergency feed keeps only explicit secure protocols and strips original labels', async () => {
  const raw = [
    '# metadata',
    reality,
    hysteria,
    `vless://${uuid}@8.8.8.8:443?security=none&type=ws`,
    'hy2://password@8.8.4.4:443/?insecure=1&sni=example.com',
    'ss://YWVzLTI1Ni1nY206cGFzcw@8.8.8.8:8388#public',
    `vless://${uuid}@127.0.0.1:443?security=reality&type=tcp&sni=example.com&pbk=abcdefghijklmnopqrstuvwxyz`
  ].join('\n');

  const result = await buildEmergencyBundle(raw, { maxNodes: 8, lookup, probeTcp });
  const links = result.bundle.split('\n');
  assert.equal(result.nodeCount, 2);
  assert.deepEqual(result.protocols, ['vless', 'hy2']);
  assert.equal(links.every(link => !link.includes('Original')), true);
  assert.equal(links.every(link => /Nivora(?:%20|\+)Emergency/.test(link)), true);
  assert.match(links[0], /203\.0\.114\.10/);
  assert.match(links[1], /203\.0\.114\.11/);
});

test('critical duplicate parameters and encoded control characters are rejected', () => {
  const parsed = parseEmergencyFeed([
    reality,
    `vless://${uuid}@edge.example.com:443?security=reality&security=none&type=tcp&sni=x.test&pbk=abcdefghijklmnopqrstuvwxyz`,
    `vless://${uuid}@edge.example.com:443?security=reality&type=tcp&sni=x.test&pbk=abcdefghijklmnopqrstuvwxyz%0aevil`,
    `vless://%C0%AF@edge.example.com:443?security=reality&type=tcp&sni=x.test&pbk=abcdefghijklmnopqrstuvwxyz0123456789abc`,
    `vless://${uuid}@edge.example.com:443?security=reality&type=tcp&sni=good.test%09evil&pbk=abcdefghijklmnopqrstuvwxyz0123456789abc`,
    `${reality.split('#')[0]}&allow_insecure=1`,
    `${reality.split('#')[0]}&verify=0`,
    `${reality.split('#')[0]}&encryption=none`,
    reality.replace(`vless://${uuid}@`, `vless://${uuid}:extra@`),
    'file:///etc/passwd'
  ].join('\n'));
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.rejected, 9);
});

test('reality validation requires a real public SNI, standard public key and supported flow', () => {
  const validKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const parsed = parseEmergencyFeed([
    `vless://${uuid}@edge.example.com:443?encryption=none&security=reality&type=tcp&sni=www.example.com&pbk=${validKey}&flow=xtls-rprx-vision`,
    `vless://${uuid}@edge.example.com:443?encryption=none&security=reality&type=tcp&sni=localhost&pbk=${validKey}`,
    `vless://${uuid}@edge.example.com:443?encryption=none&security=reality&type=tcp&sni=www.example.com&pbk=short`,
    `vless://${uuid}@edge.example.com:443?encryption=none&security=reality&type=tcp&sni=www.example.com&pbk=${validKey}&flow=unsupported`
  ].join('\n'));
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.rejected, 3);
});

test('public-address policy blocks local, carrier, documentation, multicast and private IPv6 ranges', () => {
  for (const value of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.1', '224.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'fec0::1', 'fed0::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicEmergencyAddress(value), false, value);
  }
  assert.equal(isPublicEmergencyAddress('8.8.8.8'), true);
  assert.equal(isPublicEmergencyAddress('2606:4700:4700::1111'), true);
});

test('source allowlist accepts only exact credential-free GitHub Raw HTTPS URLs', () => {
  assert.equal(
    normalizeEmergencySourceUrl('https://raw.githubusercontent.com/barry-far/V2ray-config/main/Sub1.txt#label'),
    'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Sub1.txt'
  );
  for (const value of [
    'http://raw.githubusercontent.com/a/b/main/x.txt',
    'https://raw.githubusercontent.com.attacker.test/a/b/main/x.txt',
    'https://raw.githubusercontent.com:8443/a/b/main/x.txt',
    'https://raw.githubusercontent.com/a/b/main/x.txt?download=1',
    'https://user:pass@raw.githubusercontent.com/a/b/main/x.txt',
    'https://127.0.0.1/source.txt'
  ]) assert.throws(() => normalizeEmergencySourceUrl(value), error => error instanceof EmergencyPoolError && error.code === 'INVALID_EMERGENCY_SOURCE');
});

test('source fetch enforces decoded body size and never follows redirects', async () => {
  const source = 'https://raw.githubusercontent.com/a/b/main/sub.txt';
  const ok = await fetchEmergencySource(source, { fetchImpl: async () => new Response(reality, { status: 200 }), lookup: sourceLookup });
  assert.equal(ok, reality);
  await assert.rejects(
    fetchEmergencySource(source, { fetchImpl: async () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 }), lookup: sourceLookup }),
    error => error.code === 'EMERGENCY_SOURCE_TOO_LARGE'
  );
  await assert.rejects(
    fetchEmergencySource(source, { fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.com/' } }), lookup: sourceLookup }),
    error => error.code === 'EMERGENCY_SOURCE_UNAVAILABLE'
  );
  await assert.rejects(
    fetchEmergencySource(source, { fetchImpl: async () => new Response(reality, { status: 200 }), lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
    error => error.code === 'EMERGENCY_SOURCE_DNS_FAILED'
  );
});

test('endpoint vetting never probes this server or arbitrary TCP ports', async () => {
  let probes = 0;
  const randomPort = `vless://${uuid}@edge.example.com:33862?encryption=none&security=reality&type=tcp&sni=www.example.com&pbk=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`;
  const unsafeHy2Port = 'hy2://password@8.8.8.8:53?sni=www.example.com';
  await assert.rejects(
    buildEmergencyBundle(reality, { lookup, probeTcp, blockedAddresses: new Set(['203.0.114.10']) }),
    error => error.code === 'EMERGENCY_POOL_EMPTY'
  );
  await assert.rejects(
    buildEmergencyBundle(randomPort, { lookup, probeTcp: async () => { probes += 1; return true; }, blockedAddresses: new Set() }),
    error => error.code === 'EMERGENCY_POOL_EMPTY'
  );
  await assert.rejects(
    buildEmergencyBundle(unsafeHy2Port, { lookup, probeTcp, blockedAddresses: new Set() }),
    error => error.code === 'EMERGENCY_POOL_EMPTY'
  );
  assert.equal(probes, 0);
});

test('IPv6-only endpoints are pinned as literals instead of retaining their domain', async () => {
  const result = await buildEmergencyBundle(reality, {
    lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
    probeTcp,
    blockedAddresses: new Set()
  });
  const endpoint = new URL(result.bundle);
  assert.equal(endpoint.hostname, '[2606:4700:4700::1111]');
  assert.doesNotMatch(result.bundle, /edge\.example\.com/);
});

test('multiple sources are parsed independently and round-robin prevents later-source starvation', async () => {
  const dead = Array.from({ length: 80 }, (_, index) =>
    `vless://${uuid}@dead-${index}.example.com:443?encryption=none&security=reality&type=tcp&sni=www.example.com&pbk=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`
  ).join('\n');
  const good = reality.replace('edge.example.com', 'good.example.com');
  const result = await buildEmergencyBundle([dead, good], {
    lookup: async host => [{ address: host === 'good.example.com' ? '203.0.114.20' : '203.0.114.21', family: 4 }],
    probeTcp: async host => host === '203.0.114.20',
    blockedAddresses: new Set()
  });
  assert.equal(result.nodeCount, 1);
  assert.match(result.bundle, /203\.0\.114\.20/);

  const oversizedPoison = Array.from({ length: 2_001 }, () => '# noise').join('\n');
  const isolated = await buildEmergencyBundle([oversizedPoison, good], {
    lookup: async () => [{ address: '203.0.114.20', family: 4 }],
    probeTcp,
    blockedAddresses: new Set()
  });
  assert.equal(isolated.nodeCount, 1);
});

test('pool stores a short summary, serves cached bundle and respects the global kill switch', async () => {
  let enabled = true;
  let stored = '';
  let fetches = 0;
  const pool = createEmergencyPool({
    getConfig: () => ({ enabled, sources: ['https://raw.githubusercontent.com/a/b/main/sub.txt'], maxNodes: 3, refreshMinutes: 30 }),
    readCache: () => stored,
    writeCache: value => { stored = value; },
    fetchImpl: async () => { fetches += 1; return new Response(`${reality}\n${hysteria}`, { status: 200 }); },
    lookup: async host => host === 'raw.githubusercontent.com' ? sourceLookup() : lookup(host),
    probeTcp
  });

  const refreshed = await pool.refresh();
  assert.equal(refreshed.ready, true);
  assert.equal(refreshed.nodeCount, 2);
  assert.equal(Object.hasOwn(refreshed, 'bundle'), false);
  const delivered = await pool.getBundle();
  assert.equal(delivered.nodeCount, 2);
  assert.equal(fetches, 1);
  enabled = false;
  assert.equal(pool.status().ready, false);
  await assert.rejects(pool.getBundle(), error => error.code === 'EMERGENCY_DISABLED');
});

test('enabled pool warms itself in the background when no usable cache exists', async () => {
  let stored = '';
  let fetches = 0;
  const pool = createEmergencyPool({
    getConfig: () => ({ enabled: true, sources: ['https://raw.githubusercontent.com/a/b/main/sub.txt'], maxNodes: 3, refreshMinutes: 30 }),
    readCache: () => stored,
    writeCache: value => { stored = value; },
    fetchImpl: async () => { fetches += 1; return new Response(reality, { status: 200 }); },
    lookup: async host => host === 'raw.githubusercontent.com' ? sourceLookup() : lookup(host),
    probeTcp
  });
  assert.equal(pool.status().ready, false);
  for (let attempt = 0; attempt < 20 && !stored; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fetches, 1);
  assert.equal(pool.status().ready, true);
});

test('failed refreshes use backoff so customer retries cannot hammer upstream sources', async () => {
  let fetches = 0;
  const pool = createEmergencyPool({
    getConfig: () => ({ enabled: true, sources: ['https://raw.githubusercontent.com/a/b/main/sub.txt'], maxNodes: 3, refreshMinutes: 30 }),
    readCache: () => '',
    writeCache: () => {},
    fetchImpl: async () => { fetches += 1; return new Response('', { status: 503 }); },
    lookup: sourceLookup,
    probeTcp,
    now: () => 1_000_000
  });
  await assert.rejects(pool.refresh(), error => error.code === 'EMERGENCY_SOURCE_UNAVAILABLE');
  await assert.rejects(pool.refresh(), error => error.code === 'EMERGENCY_REFRESH_BACKOFF');
  assert.equal(fetches, 1);
  assert.ok(pool.status().retryAt);
});
