import { createHash } from 'node:crypto';

export const isPurchasePath = path => /^\/api\/(customer|reseller)\/((?:wallet\/)?purchase|orders\/[^/]+\/renew)$/.test(path) || path === '/api/admin/sales';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// A pending operation is never expired/re-executed: a panel may have accepted it
// before the process or connection stopped. Reconciliation must resolve it first.
export function createPurchaseRequests(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS purchase_requests (
    actor TEXT NOT NULL, path TEXT NOT NULL, request_key TEXT NOT NULL,
    body_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    response_status INTEGER, response_json TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(actor,path,request_key)
  )`);
  return {
    begin(actor, path, key, body) {
      if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) return {status:400,body:{error:'INVALID_PURCHASE_KEY'}};
      const hash=createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
      const inserted=db.prepare('INSERT OR IGNORE INTO purchase_requests(actor,path,request_key,body_hash,created_at) VALUES(?,?,?,?,?)').run(actor,path,key,hash,new Date().toISOString());
      const row=db.prepare('SELECT * FROM purchase_requests WHERE actor=? AND path=? AND request_key=?').get(actor,path,key);
      if(row.body_hash!==hash)return {status:409,body:{error:'PURCHASE_KEY_CONFLICT'}};
      if(row.state==='complete')return {status:row.response_status,body:JSON.parse(row.response_json),replayed:true};
      return {row, started:inserted.changes===1};
    },
    complete(actor,path,key,status,body) {
      db.prepare("UPDATE purchase_requests SET state='complete',response_status=?,response_json=? WHERE actor=? AND path=? AND request_key=? AND state='pending'").run(status,JSON.stringify(body),actor,path,key);
    },
    find(actor,path,key) {return db.prepare('SELECT * FROM purchase_requests WHERE actor=? AND path=? AND request_key=?').get(actor,path,key);}
  };
}
