import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const [audience, versionCodeRaw, versionName, downloadUrl, ...noteParts] = process.argv.slice(2);
const versionCode = Number(versionCodeRaw);
if (!['customer', 'partner'].includes(audience) || !Number.isInteger(versionCode) || versionCode < 1 || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(versionName || '')) {
  throw new Error('Usage: node scripts/set-app-release.mjs customer 48 0.23.2 https://example/app.apk [notes]');
}
const parsed = new URL(downloadUrl);
if (parsed.protocol !== 'https:') throw new Error('HTTPS download URL required');
const database = new DatabaseSync(resolve(process.env.DATABASE_PATH || './data/nivora.db'));
const now = new Date().toISOString(), prefix = `android_${audience}_`;
const put = database.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
database.exec('BEGIN IMMEDIATE');
try {
  put.run(`${prefix}version_code`, String(versionCode), now);
  put.run(`${prefix}version_name`, versionName, now);
  put.run(`${prefix}download_url`, downloadUrl, now);
  put.run(`${prefix}release_notes`, noteParts.join(' ').slice(0, 2000), now);
  put.run(`${prefix}force_update`, 'false', now);
  put.run(`${prefix}published_at`, now, now);
  database.exec('COMMIT');
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
} finally {
  database.close();
}
console.log(JSON.stringify({ audience, versionCode, versionName, downloadUrl, publishedAt: now }));
