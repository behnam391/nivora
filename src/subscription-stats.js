import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function readPanelStats(file = process.env.PANEL_STATS_PATH || 'data/panel-stats.json') {
  try { return JSON.parse(await readFile(resolve(file), 'utf8')); } catch { return {}; }
}

export function enrichSubscription(order, stats = {}, now = Date.now()) {
  if(order.control_status&&order.control_status!=='active')order.subscription_status=order.control_status;
  const row = stats[order.panel_client_id] || {};
  const totalBytes = Number(row.totalBytes ?? (Number(order.traffic_gb || 0) * 1024 ** 3));
  const usedBytes = Number(row.upBytes || 0) + Number(row.downBytes || 0);
  const expiry = Number(row.expiryTime || 0);
  const expiryTime = expiry > 0 ? expiry : null;
  return {...order, usedBytes, totalBytes, remainingBytes:Math.max(0,totalBytes-usedBytes),
    usagePercent:totalBytes?Math.min(100,Math.round(usedBytes*10000/totalBytes)/100):0,
    expiryTime, remainingDays:expiryTime?Math.max(0,Math.ceil((expiryTime-now)/86400000)):Number(order.duration_days||0),
    startsOnFirstUse:expiry<0, lastOnline:row.lastOnline||null,
    panelEnabled:row.enabled===undefined?null:Boolean(row.enabled), statsSyncedAt:row.syncedAt||null};
}
