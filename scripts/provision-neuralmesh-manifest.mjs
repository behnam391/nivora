import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync
} from 'node:crypto';
import {
  chownSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

const manifestDirectory = process.env.NEURALMESH_DIRECTORY || '/etc/nivora/neuralmesh';
const manifestFile = `${manifestDirectory}/manifest.json`;
const privateKeyFile = `${manifestDirectory}/manifest-ed25519.pem`;
const publicKeyFile = `${manifestDirectory}/manifest-public-spki.b64`;
const environmentFile = process.env.NIVORA_ENV_FILE || '/opt/nivora/.env';
const tokenHash = String(process.env.NEURALMESH_MANIFEST_TOKEN_HASH || '').toLowerCase();
const keyId = process.env.NEURALMESH_MANIFEST_KEY_ID || 'neuralmesh-lab-v1';

if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error('A SHA-256 test token hash is required');

function atomicWrite(path, data, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, data, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function ensureSigningKey() {
  if (!existsSync(privateKeyFile)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    atomicWrite(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  }
  chmodSync(privateKeyFile, 0o600);
  const privateKey = createPrivateKey(readFileSync(privateKeyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Existing signing key is not Ed25519');
  const publicKey = createPublicKey(privateKey);
  const publicSpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  atomicWrite(publicKeyFile, `${publicSpki}\n`, 0o644);
  return publicSpki;
}

async function fetchTestLinks() {
  const apiBase = String(process.env.PANEL_BASE_URL || '').replace(/\/$/, '');
  const subscriptionBase = String(process.env.PANEL_SUBSCRIPTION_BASE_URL || '').replace(/\/$/, '');
  const panelToken = process.env.PANEL_API_TOKEN;
  if (!apiBase || !subscriptionBase || !panelToken) throw new Error('Panel environment is incomplete');
  const response = await fetch(`${apiBase}/panel/api/clients/get/${encodeURIComponent('neuralmesh-lab')}`, {
    headers: { authorization: `Bearer ${panelToken}`, accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Test client lookup failed: ${response.status}`);
  const result = await response.json();
  const client = result?.obj?.client || result?.obj || result?.client || result;
  if (!client?.subId) throw new Error('Test client has no subscription identifier');

  const subscription = await fetch(`${subscriptionBase}/${client.subId}`, {
    headers: { 'user-agent': 'Nivora-NeuralMesh-Provisioner/1.0' }
  });
  if (!subscription.ok) throw new Error(`Test subscription fetch failed: ${subscription.status}`);
  let body = (await subscription.text()).trim();
  if (!body.includes('://')) body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return body.split(/\r?\n/).map(value => value.trim()).filter(value => value.startsWith('vless://'));
}

function selectByPort(links, port) {
  const matches = links.filter(link => Number(new URL(link).port) === port);
  if (matches.length !== 1) throw new Error(`Expected exactly one test profile on port ${port}`);
  return matches[0];
}

function buildEdgeTlsLink(internalLink, { type, hash, alpn = 'h2' }) {
  const edge = new URL(internalLink);
  edge.hostname = 'wss-lab.nivorali.com';
  edge.port = '443';
  edge.searchParams.set('security', 'tls');
  edge.searchParams.set('sni', 'wss-lab.nivorali.com');
  edge.searchParams.set('host', 'wss-lab.nivorali.com');
  edge.searchParams.set('alpn', alpn);
  edge.searchParams.set('fp', 'chrome');
  edge.searchParams.set('type', type);
  edge.searchParams.delete('pbk');
  edge.searchParams.delete('sid');
  edge.searchParams.delete('flow');
  edge.hash = hash;
  return edge.toString();
}

function hysteriaTurboProfile() {
  const uriFile = String(process.env.NIVORA_TURBO_SHARE_URI_FILE || '').trim();
  if (uriFile) assertRestrictedFile(uriFile, 'NIVORA_TURBO_SHARE_URI_FILE');
  const raw = String(process.env.NIVORA_TURBO_SHARE_URI || (uriFile ? readFileSync(uriFile, 'utf8') : '')).trim();
  if (!raw) return null;
  let uri;
  try { uri = new URL(raw); } catch { throw new Error('NIVORA_TURBO_SHARE_URI is invalid'); }
  if (!['hysteria2:', 'hy2:'].includes(uri.protocol) || !uri.username || !uri.hostname || !uri.port) {
    throw new Error('NIVORA_TURBO_SHARE_URI must be a complete Hysteria2 URI');
  }
  if (!uri.searchParams.get('sni') || !uri.searchParams.get('obfs') || !uri.searchParams.get('obfs-password')) {
    throw new Error('NIVORA_TURBO_SHARE_URI is missing TLS or obfuscation parameters');
  }
  return {
    id: 'hysteria2-turbo-7443',
    name: 'Hysteria2 Turbo Finland',
    transport: 'hysteria2-udp-bbr',
    uri: uri.toString()
  };
}

function updateEnvironment(values) {
  let source = readFileSync(environmentFile, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    source = pattern.test(source) ? source.replace(pattern, line) : `${source.replace(/\s*$/, '')}\n${line}\n`;
  }
  atomicWrite(environmentFile, source, 0o600);
}

function restrictToServiceUser(paths) {
  const serviceUser = process.env.NEURALMESH_SERVICE_USER || 'nivora';
  const uid = Number(execFileSync('id', ['-u', serviceUser], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('id', ['-g', serviceUser], { encoding: 'utf8' }).trim());
  const parent = dirname(manifestDirectory);
  chownSync(parent, 0, gid);
  chmodSync(parent, 0o750);
  chownSync(manifestDirectory, uid, gid);
  chmodSync(manifestDirectory, 0o700);
  for (const path of paths) chownSync(path, uid, gid);
}

const links = await fetchTestLinks();
const now = new Date();
const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
const turboProfile = hysteriaTurboProfile();
const profiles = [
  {
    id: 'reality-vision-8443',
    name: 'Reality Vision Direct',
    transport: 'tcp-reality-vision',
    uri: selectByPort(links, 8443)
  },
  {
    id: 'xhttp-reality-2095',
    name: 'XHTTP Reality Direct',
    transport: 'xhttp-reality',
    uri: selectByPort(links, 2095)
  },
  {
    id: 'xhttp-tls-edge',
    name: 'XHTTP TLS Edge',
    transport: 'xhttp-stream-up-tls',
    uri: buildEdgeTlsLink(selectByPort(links, 50053), {
      type: 'xhttp',
      hash: '#NeuralMesh-XHTTP-TLS-CF'
    })
  },
  {
    id: 'vless-wss-cloudflare',
    name: 'VLESS WSS Cloudflare',
    transport: 'websocket-tls-cloudflare',
    uri: buildEdgeTlsLink(selectByPort(links, 2082), {
      type: 'ws',
      hash: '#NeuralMesh-VLESS-WSS-CF', alpn: 'http/1.1'
    })
  },
  {
    id: 'vless-grpc-cloudflare',
    name: 'VLESS gRPC Cloudflare',
    transport: 'grpc-tls-cloudflare',
    uri: buildEdgeTlsLink(selectByPort(links, 50051), {
      type: 'grpc',
      hash: '#NeuralMesh-VLESS-GRPC-CF'
    })
  },
  {
    id: 'vless-httpupgrade-cloudflare',
    name: 'VLESS HTTPUpgrade Cloudflare',
    transport: 'httpupgrade-tls-cloudflare',
    uri: buildEdgeTlsLink(selectByPort(links, 50052), {
      type: 'httpupgrade',
      hash: '#NeuralMesh-VLESS-HTTPUPGRADE-CF', alpn: 'http/1.1'
    })
  },
  ...(turboProfile ? [turboProfile] : [])
];
const manifest = {
  version: 1,
  issuedAt: now.toISOString(),
  expiresAt: expiresAt.toISOString(),
  profiles,
  measurement: {
    rounds: 1,
    downloadBytes: 1_000_000,
    estimatedTotalBytes: profiles.length * 1_000_000,
    http204Url: 'https://www.gstatic.com/generate_204',
    downloadUrl: 'https://speed.cloudflare.com/__down?bytes=5000000',
    instagramUrl: 'https://www.instagram.com/',
    youtube204Url: 'https://www.youtube.com/generate_204',
    connectTimeoutMs: 8_000,
    requestTimeoutMs: 8_000
  },
  scoring: {
    lowerIsBetter: true,
    minimumSuccessfulRounds: 1,
    weights: {
      tunnelConnect: 0.25,
      http204: 0.20,
      instagramTtfb: 0.20,
      youtube204: 0.15,
      download: 0.20
    },
    resetPenalty: 20_000,
    timeoutPenalty: 20_000,
    disconnectPenalty: 15_000
  }
};

const vlessProfiles = manifest.profiles.filter(profile => profile.uri.startsWith('vless://'));
if (new Set(vlessProfiles.map(profile => new URL(profile.uri).username)).size !== 1) {
  throw new Error('The test profiles do not share one identity');
}

const publicKeySpkiBase64 = ensureSigningKey();
atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
restrictToServiceUser([manifestFile, privateKeyFile, publicKeyFile]);
const environmentUpdates = {
  NEURALMESH_MANIFEST_TOKEN_HASH: tokenHash,
  NEURALMESH_MANIFEST_FILE: manifestFile,
  NEURALMESH_SIGNING_KEY_FILE: privateKeyFile,
  NEURALMESH_MANIFEST_KEY_ID: keyId
};
if (process.env.NIVORA_TURBO_SHARE_URI_FILE) {
  environmentUpdates.NIVORA_TURBO_SHARE_URI_FILE = process.env.NIVORA_TURBO_SHARE_URI_FILE;
}
updateEnvironment(environmentUpdates);

console.log(JSON.stringify({
  configured: true,
  keyId,
  publicKeySha256: createHash('sha256').update(Buffer.from(publicKeySpkiBase64, 'base64')).digest('hex'),
  expiresAt: manifest.expiresAt,
  profiles: manifest.profiles.map(({ id, transport }) => ({ id, transport }))
}));
