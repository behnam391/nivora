// Run on deployment host: node --env-file=.env scripts/publish-windows-131-telegram.mjs
import { DatabaseSync } from 'node:sqlite';
import { createHash, createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const db=new DatabaseSync(resolve(process.env.DATABASE_PATH||'data/nivora.db'));
const get=key=>db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
const put=(key,value)=>db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,String(value),new Date().toISOString());
const decrypt=value=>{try{const [iv,tag,data]=value.split('.'),key=createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY||process.env.ADMIN_TOKEN).digest(),cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));cipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString()}catch{return ''}};
const token=decrypt(get('telegram_token')||'')||process.env.TELEGRAM_BOT_TOKEN,channel=get('telegram_channel');
try {
  if(!token||!channel)throw Error('TELEGRAM_NOT_CONFIGURED');
  if(get('windows_131_portable_message'))throw Error('ALREADY_POSTED');
  const bytes=await readFile('/tmp/Nivora-Desktop-1.3.1.zip');
  if(bytes.length<1_000_000||bytes.length>49_000_000)throw Error(`INVALID_FILE_SIZE_${bytes.length}`);
  const form=new FormData();
  form.set('chat_id',channel);
  form.set('caption','🖥 نسخه ویندوز Nivora 1.3.1\n\n✅ نسخه قابل‌حمل و تست‌شده\n🌍 انتخاب صحیح و ماندگار لوکیشن\n🛡 اتصال کامل سیستم با مسیر پشتیبان خودکار\n⚡ جلوگیری از قطع اینترنت هنگام شکست مسیر TUN\n🔑 تغییر و بازیابی رمز عبور\n🔽 کوچک‌شدن کنار ساعت ویندوز\n\nفایل ZIP را Extract کنید و سپس Nivora.exe را اجرا کنید. فایل را مستقیماً داخل ZIP اجرا نکنید.');
  form.set('document',new Blob([bytes],{type:'application/zip'}),'Nivora-Desktop-1.3.1.zip');
  const response=await fetch(`https://api.telegram.org/bot${token}/sendDocument`,{method:'POST',body:form,signal:AbortSignal.timeout(180000)}),result=await response.json();
  if(!response.ok||!result.ok)throw Error(result.description||'TELEGRAM_UPLOAD_FAILED');
  put('windows_131_portable_message',result.result.message_id);
  console.log(JSON.stringify({published:true,channel,messageId:result.result.message_id,size:bytes.length}));
} finally {db.close()}
