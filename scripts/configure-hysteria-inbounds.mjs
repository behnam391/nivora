import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [nodeSelector, inboundIdsInput] = process.argv.slice(2);
if (!nodeSelector || !inboundIdsInput) {
  throw new Error('Usage: node scripts/configure-hysteria-inbounds.mjs <node-name-or-host> <inbound-ids>');
}

const inboundIds = String(inboundIdsInput)
  .split(',')
  .map(value => Number(value.trim()))
  .filter((value, index, values) => Number.isInteger(value) && value > 0 && values.indexOf(value) === index);
if (!inboundIds.length) throw new Error('At least one valid Hysteria2 inbound ID is required');

const databasePath = process.env.DATABASE_PATH || './data/nivora.db';
const backupRoot = process.env.NIVORA_BACKUP_DIRECTORY || './backups';
mkdirSync(backupRoot, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (nodeSelector === 'default') {
  if (!process.env.PANEL_BASE_URL || !process.env.PANEL_API_TOKEN) {
    throw new Error('Default panel environment is not configured');
  }
  const envPath = process.env.NIVORA_ENV_PATH || './.env';
  if (!existsSync(envPath)) throw new Error(`Environment file not found: ${envPath}`);
  const backupPath = `${backupRoot}/before-hysteria-inbounds-${stamp}.env`;
  copyFileSync(envPath, backupPath);
  const key = 'PANEL_HYSTERIA_INBOUND_IDS';
  const value = inboundIds.join(',');
  const lines = readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  let replaced = false;
  const next = lines.map(line => {
    if (!line.startsWith(`${key}=`)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) next.push(`${key}=${value}`);
  writeFileSync(envPath, `${next.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  console.log(JSON.stringify({ backupPath, updated: { id: 'default', hysteria_inbound_ids: value }, restartRequired: true }, null, 2));
  process.exit(0);
}

const backupPath = `${backupRoot}/before-hysteria-inbounds-${stamp}.db`;
copyFileSync(databasePath, backupPath);

const db = new DatabaseSync(databasePath);
const matches = db.prepare(`
  SELECT id,name,base_url FROM panel_nodes
  WHERE name=? OR base_url LIKE ?
`).all(nodeSelector, `%${nodeSelector}%`);
if (matches.length !== 1) {
  db.close();
  throw new Error(matches.length ? 'Node selector is ambiguous' : `Panel node not found: ${nodeSelector}`);
}

const node = matches[0];
db.prepare('UPDATE panel_nodes SET hysteria_inbound_ids=?,updated_at=? WHERE id=?')
  .run(inboundIds.join(','), new Date().toISOString(), node.id);
const updated = db.prepare(`
  SELECT id,name,base_url,vision_inbound_ids,cdn_inbound_ids,hysteria_inbound_ids,active
  FROM panel_nodes WHERE id=?
`).get(node.id);
db.close();

console.log(JSON.stringify({ backupPath, updated }, null, 2));
