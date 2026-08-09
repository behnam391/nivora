import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,readdirSync,statSync,unlinkSync } from 'node:fs';
import { basename,dirname,resolve } from 'node:path';
const source=resolve(process.env.DATABASE_PATH||'./data/nivora.db'),backupDir=resolve(process.env.BACKUP_DIR||'./backups'),keep=Math.max(Number(process.env.BACKUP_KEEP)||14,3);mkdirSync(backupDir,{recursive:true});
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),target=resolve(backupDir,`nivora-${stamp}.db`);if(dirname(target)!==backupDir)throw new Error('INVALID_BACKUP_TARGET');
const db=new DatabaseSync(source);try{db.exec(`PRAGMA wal_checkpoint(FULL); VACUUM INTO '${target.replaceAll("'","''")}'`);}finally{db.close()}
const verify=new DatabaseSync(target,{readOnly:true});try{const check=verify.prepare('PRAGMA integrity_check').get();if(check.integrity_check!=='ok')throw new Error('BACKUP_INTEGRITY_FAILED');}finally{verify.close()}
const files=readdirSync(backupDir).filter(x=>/^nivora-.*\.db$/.test(x)).map(x=>({name:x,path:resolve(backupDir,x),mtime:statSync(resolve(backupDir,x)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);for(const file of files.slice(keep)){if(dirname(file.path)===backupDir&&basename(file.path)===file.name)unlinkSync(file.path)}console.log(JSON.stringify({ok:true,backup:target,sizeBytes:statSync(target).size,retained:Math.min(files.length,keep)}));
