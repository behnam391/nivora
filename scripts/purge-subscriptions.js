import { createDecipheriv, createHash } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createThreeXuiProvisioner } from '../src/providers/three-x-ui.js';

const apply = process.argv.includes('--apply');
const db = openDatabase();

function decrypt(value) {
  try {
    const [ivRaw, tagRaw, dataRaw] = String(value || '').split('.');
    const key = createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY || process.env.ADMIN_TOKEN || '').digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function provisionerFor(nodeId) {
  if (!nodeId) return process.env.PANEL_API_TOKEN ? createThreeXuiProvisioner({ disableIpLimit: true }) : null;
  const node = db.prepare('SELECT * FROM panel_nodes WHERE id=?').get(nodeId);
  const apiToken = node && decrypt(node.api_token_encrypted);
  if (!node?.base_url || !node.subscription_base_url || !apiToken) return null;
  return createThreeXuiProvisioner({
    baseUrl: node.base_url,
    apiToken,
    inboundId: 1,
    visionInboundIds: node.vision_inbound_ids,
    cdnInboundIds: node.cdn_inbound_ids,
    subscriptionBaseUrl: node.subscription_base_url,
    rejectUnauthorized: false,
    disableIpLimit: true
  });
}

const subscriptions = db.prepare(`
  SELECT s.id, s.panel_client_id, COALESCE(l.panel_node_id, '') node_id
  FROM subscriptions s
  LEFT JOIN orders o ON o.id=s.order_id
  LEFT JOIN service_locations l ON l.id=o.location_id
`).all();
const clientGroups = new Map();
for (const row of subscriptions) {
  if (!row.panel_client_id) continue;
  const key = row.node_id || 'default';
  if (!clientGroups.has(key)) clientGroups.set(key, new Set());
  clientGroups.get(key).add(row.panel_client_id);
}

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  subscriptions: subscriptions.length,
  xuiClients: [...clientGroups.values()].reduce((total, ids) => total + ids.size, 0),
  panelGroups: clientGroups.size
};

if (!apply) {
  console.log(JSON.stringify({ ...summary, message: 'No data changed. Run with --apply after a verified backup.' }));
  db.close();
  process.exit(0);
}

const failures = [];
for (const [key, ids] of clientGroups) {
  const provisioner = provisionerFor(key === 'default' ? '' : key);
  if (!provisioner?.remove) {
    failures.push({ panel: key, error: 'PANEL_PROVISIONER_UNAVAILABLE', clients: ids.size });
    continue;
  }
  for (const panelClientId of ids) {
    try { await provisioner.remove({ panelClientId }); }
    catch (error) { failures.push({ panel: key, error: String(error?.message || error) }); }
  }
}

if (failures.length) {
  console.log(JSON.stringify({ ...summary, ok: false, failures }));
  db.close();
  process.exit(2);
}

db.exec('BEGIN IMMEDIATE');
try {
  db.exec('UPDATE bank_transactions SET matched_order_id=NULL WHERE matched_order_id IN (SELECT id FROM orders)');
  db.exec('DELETE FROM order_reviews WHERE order_id IN (SELECT id FROM orders)');
  db.exec('DELETE FROM discount_redemptions WHERE order_id IN (SELECT id FROM orders)');
  db.exec('DELETE FROM subscriptions');
  db.exec('DELETE FROM orders');
  db.exec('COMMIT');
  console.log(JSON.stringify({ ...summary, ok: true, message: 'Subscriptions and their X-UI clients were removed. Accounts, plans, locations, and wallet history were retained.' }));
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally { db.close(); }
