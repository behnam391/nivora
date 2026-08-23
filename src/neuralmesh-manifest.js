import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify
} from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const asDateMs = value => ISO_DATE_PATTERN.test(String(value || '')) ? Date.parse(value) : Number.NaN;

function assertNoSensitiveFields(value, path = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:private.?key|secret|token)/i.test(key)) throw new Error(`SENSITIVE_FIELD:${path}.${key}`);
    assertNoSensitiveFields(item, `${path}.${key}`);
  }
}

export function validateNeuralMeshPayload(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_MANIFEST');
  assertNoSensitiveFields(payload);
  if (!Number.isInteger(payload.version) || payload.version < 1) throw new Error('INVALID_MANIFEST_VERSION');
  const issuedAt = asDateMs(payload.issuedAt), expiresAt = asDateMs(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new Error('INVALID_MANIFEST_WINDOW');
  if (expiresAt <= now.getTime()) throw new Error('MANIFEST_EXPIRED');
  if (!Array.isArray(payload.profiles) || payload.profiles.length < 3 || payload.profiles.length > 8) throw new Error('INVALID_MANIFEST_PROFILES');
  const ids = new Set();
  for (const profile of payload.profiles) {
    if (!profile || typeof profile !== 'object') throw new Error('INVALID_MANIFEST_PROFILE');
    if (!/^[a-z0-9-]{3,40}$/.test(String(profile.id || '')) || ids.has(profile.id)) throw new Error('INVALID_MANIFEST_PROFILE_ID');
    ids.add(profile.id);
    if (!String(profile.name || '').trim() || !String(profile.transport || '').trim()) throw new Error('INVALID_MANIFEST_PROFILE');
    if (!String(profile.uri || '').startsWith('vless://')) throw new Error('INVALID_MANIFEST_PROFILE_URI');
  }
  const measurement = payload.measurement;
  if (!measurement || !Number.isInteger(measurement.rounds) || measurement.rounds < 1 || measurement.rounds > 10) throw new Error('INVALID_MEASUREMENT_POLICY');
  if (!Number.isInteger(measurement.downloadBytes) || measurement.downloadBytes < 0 || measurement.downloadBytes > 20_000_000) throw new Error('INVALID_MEASUREMENT_POLICY');
  return payload;
}

function matchesBearer(authorization, expectedHash) {
  const raw = String(authorization || '');
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  const actual = createHash('sha256').update(token).digest();
  return token.length >= 32 && timingSafeEqual(actual, expectedHash);
}

export function createNeuralMeshManifestService({
  tokenHash,
  privateKey,
  readManifest,
  keyId = 'neuralmesh-lab-v1',
  now = () => new Date()
}) {
  if (!TOKEN_HASH_PATTERN.test(String(tokenHash || ''))) throw new Error('INVALID_MANIFEST_TOKEN_HASH');
  if (typeof readManifest !== 'function') throw new Error('MANIFEST_READER_REQUIRED');
  const expectedHash = Buffer.from(tokenHash, 'hex');
  const signingKey = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('MANIFEST_KEY_MUST_BE_ED25519');
  const publicKey = createPublicKey(signingKey);
  const publicKeySpkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  return {
    keyId,
    publicKeySpkiBase64,
    respond(authorization) {
      if (!matchesBearer(authorization, expectedHash)) return { status: 401, body: { error: 'UNAUTHORIZED' } };
      let payload;
      try {
        payload = validateNeuralMeshPayload(readManifest(), now());
      } catch (error) {
        if (error.message === 'MANIFEST_EXPIRED') return { status: 410, body: { error: 'MANIFEST_EXPIRED' } };
        return { status: 503, body: { error: 'MANIFEST_UNAVAILABLE' } };
      }
      const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
      return {
        status: 200,
        body: {
          algorithm: 'Ed25519',
          keyId,
          payload: bytes.toString('base64url'),
          signature: sign(null, bytes, signingKey).toString('base64url')
        }
      };
    }
  };
}

function assertRestrictedFile(path, label) {
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`${label}_NOT_FILE`);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error(`${label}_PERMISSIONS_TOO_OPEN`);
}

export function loadNeuralMeshManifestServiceFromEnv(env = process.env) {
  const tokenHash = env.NEURALMESH_MANIFEST_TOKEN_HASH;
  const manifestFile = env.NEURALMESH_MANIFEST_FILE;
  const signingKeyFile = env.NEURALMESH_SIGNING_KEY_FILE;
  if (!tokenHash && !manifestFile && !signingKeyFile) return null;
  if (!tokenHash || !manifestFile || !signingKeyFile) throw new Error('NEURALMESH_MANIFEST_CONFIGURATION_INCOMPLETE');
  assertRestrictedFile(manifestFile, 'MANIFEST_FILE');
  assertRestrictedFile(signingKeyFile, 'SIGNING_KEY_FILE');
  return createNeuralMeshManifestService({
    tokenHash,
    keyId: env.NEURALMESH_MANIFEST_KEY_ID || 'neuralmesh-lab-v1',
    privateKey: readFileSync(signingKeyFile),
    readManifest: () => JSON.parse(readFileSync(manifestFile, 'utf8'))
  });
}

export function verifyNeuralMeshEnvelope(envelope, publicKey, now = new Date()) {
  if (envelope?.algorithm !== 'Ed25519' || !envelope.payload || !envelope.signature) throw new Error('INVALID_ENVELOPE');
  const bytes = Buffer.from(envelope.payload, 'base64url');
  const signature = Buffer.from(envelope.signature, 'base64url');
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (!verify(null, bytes, key, signature)) throw new Error('BAD_SIGNATURE');
  return validateNeuralMeshPayload(JSON.parse(bytes.toString('utf8')), now);
}
