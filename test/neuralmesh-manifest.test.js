import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createNeuralMeshManifestService, verifyNeuralMeshEnvelope } from '../src/neuralmesh-manifest.js';

const token = 'neuralmesh-test-token-with-more-than-32-characters';
const tokenHash = createHash('sha256').update(token).digest('hex');
const keys = generateKeyPairSync('ed25519');
const now = new Date('2026-08-14T12:00:00.000Z');

const payload = (expiresAt = '2026-09-14T12:00:00.000Z') => ({
  version: 1,
  issuedAt: '2026-08-14T11:00:00.000Z',
  expiresAt,
  profiles: [
    { id: 'reality-vision', name: 'Reality Vision', transport: 'tcp-reality-vision', uri: 'vless://00000000-0000-4000-8000-000000000001@example.test:443?type=tcp' },
    { id: 'xhttp-reality', name: 'XHTTP Reality', transport: 'xhttp-reality', uri: 'vless://00000000-0000-4000-8000-000000000001@example.test:8443?type=xhttp' },
    { id: 'xhttp-cdn', name: 'XHTTP CDN', transport: 'xhttp-tls-cdn', uri: 'vless://00000000-0000-4000-8000-000000000001@edge.example.test:443?security=tls&type=xhttp' }
  ],
  measurement: { rounds: 3, downloadBytes: 5_000_000 }
});

async function start(manifestPayload = payload()) {
  const db = openDatabase(':memory:');
  const service = createNeuralMeshManifestService({
    tokenHash,
    privateKey: keys.privateKey,
    readManifest: () => manifestPayload,
    now: () => now
  });
  const server = createServer(createApp(db, { adminToken: 'admin-test-token', neuralMeshManifest: service }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('NeuralMesh manifest requires its dedicated bearer token and disables caching', async t => {
  const { server, base } = await start(); t.after(() => server.close());
  let response = await fetch(`${base}/api/neuralmesh/manifest`);
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/neuralmesh/manifest`, { headers: { authorization: 'Bearer wrong-token-that-is-long-enough-to-hash-safely' } });
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/neuralmesh/manifest`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('vary'), 'authorization');
  const envelope = await response.json();
  assert.equal(verifyNeuralMeshEnvelope(envelope, keys.publicKey, now).profiles.length, 3);
});

test('NeuralMesh manifest rejects expired payloads', async t => {
  const { server, base } = await start(payload('2026-08-14T11:30:00.000Z')); t.after(() => server.close());
  const response = await fetch(`${base}/api/neuralmesh/manifest`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { error: 'MANIFEST_EXPIRED' });
});

test('NeuralMesh signature detects payload tampering', async t => {
  const { server, base } = await start(); t.after(() => server.close());
  const response = await fetch(`${base}/api/neuralmesh/manifest`, { headers: { authorization: `Bearer ${token}` } });
  const envelope = await response.json();
  const decoded = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  decoded.profiles[0].transport = 'tampered';
  envelope.payload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  assert.throws(() => verifyNeuralMeshEnvelope(envelope, keys.publicKey, now), /BAD_SIGNATURE/);
});

test('NeuralMesh manifest accepts Hysteria2 and rejects unknown share schemes', () => {
  const withHysteria = payload();
  withHysteria.profiles.push({
    id: 'hysteria2-turbo',
    name: 'Hysteria2 Turbo',
    transport: 'hysteria2-udp-bbr',
    uri: 'hysteria2://temporary-auth@example.test:7443/?sni=example.test&obfs=salamander&obfs-password=test'
  });
  const service = createNeuralMeshManifestService({
    tokenHash,
    privateKey: keys.privateKey,
    readManifest: () => withHysteria,
    now: () => now
  });
  assert.equal(service.respond(`Bearer ${token}`).status, 200);

  withHysteria.profiles[3].uri = 'https://example.test:7443/profile';
  assert.equal(service.respond(`Bearer ${token}`).status, 503);
});

test('health endpoint checks the database without exposing configuration', async t => {
  const { server, base } = await start(); t.after(() => server.close());
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'nivora' });
});
