// On the deployment host: node --env-file=.env scripts/publish-android-0242.mjs <activate|notify|channel>
import { DatabaseSync } from 'node:sqlite';
import { createHash, createDecipheriv, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const mode=process.argv[2];
const db=new DatabaseSync(resolve(process.env.DATABASE_PATH||'data/nivora.db'));
const get=key=>db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
const put=(key,value)=>db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,String(value),new Date().toISOString());
const decrypt=value=>{try{const [iv,tag,data]=value.split('.'),key=createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY||process.env.ADMIN_TOKEN).digest(),cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));cipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString()}catch{return ''}};
const token=decrypt(get('telegram_token')||'')||process.env.TELEGRAM_BOT_TOKEN;
const channel=get('telegram_channel');
const url='https://raw.githubusercontent.com/behnam391/nivora/releases/android/Nivora-Customer-v0.24.2-universal.apk';
const notes='مدیریت اشتراک‌های تمام‌شده، نمایش مبلغ بازگشت وجه پیش از لغو، و نمایش نرخ مرجع دلار و یورو در بخش پلن‌ها.';
const message='🚀 نیورا ۰٫۲۴٫۲ برای اندروید منتشر شد\n\n🧹 اشتراک‌های تمام‌شده را از حساب خود حذف کنید.\n💳 اگر از اشتراک خریداری‌شده راضی نبودید، مبلغ قابل بازگشت را پیش از لغو ببینید؛ مبلغ تأییدشده به کیف پول برمی‌گردد. برای استفاده بیش از ۵ روز، سقف بازگشت ۵۰٪ است و میزان مصرف نیز در محاسبه اثر دارد.\n💱 نرخ مرجع دلار و یورو در صفحه پلن‌ها نمایش داده می‌شود.\n\nبرنامه را حذف نکنید؛ نسخه جدید را از داخل خود برنامه یا لینک رسمی روی نسخه قبلی نصب کنید. نسخه امضاشده و مناسب اندروید ۸ به بالاست.';

try {
  if(mode==='activate'){
    const response=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(30000)});
    if(!response.ok||Number(response.headers.get('content-length'))<1_000_000)throw Error('RELEASE_NOT_AVAILABLE');
    if(Number(get('android_customer_version_code')||0)>58)throw Error('NEWER_RELEASE_IS_ACTIVE');
    db.exec('BEGIN IMMEDIATE');
    try{for(const [key,value] of Object.entries({version_code:58,version_name:'0.24.2',download_url:url,release_notes:notes,force_update:false,published_at:new Date().toISOString()}))put(`android_customer_${key}`,value);put('telegram_latest_release_url',url);put('release_0242_activation',new Date().toISOString());db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error}
    console.log(JSON.stringify({activated:true,version:'0.24.2',url}));
  }else if(mode==='notify'){
    if(!get('release_0242_activation'))throw Error('RELEASE_NOT_ACTIVATED');
    if(get('release_0242_notification'))throw Error('ALREADY_NOTIFIED');
    const accounts=db.prepare("SELECT id FROM accounts WHERE role='customer' AND status='active'").all();
    const insert=db.prepare('INSERT INTO notifications(id,account_id,title,body,created_at) VALUES(?,?,?,?,?)');
    const now=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try{for(const account of accounts)insert.run(randomUUID(),account.id,'نسخه جدید نیورا منتشر شد','مدیریت اشتراک‌های تمام‌شده، بازگشت وجه و نرخ مرجع ارز به برنامه اضافه شد. از داخل برنامه به‌روزرسانی کنید.',now);put('release_0242_notification',now);db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error}
    console.log(JSON.stringify({notified:accounts.length}));
  }else if(mode==='channel'){
    if(!get('release_0242_activation'))throw Error('RELEASE_NOT_ACTIVATED');
    if(get('release_0242_channel_message'))throw Error('ALREADY_POSTED');
    if(!token||!channel)throw Error('TELEGRAM_CHANNEL_NOT_CONFIGURED');
    const payload={chat_id:channel,text:message,disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:'📥 دانلود نسخه اندروید',url}],[{text:'🤖 ربات نیورا',url:'https://t.me/nivorali_bot'}]]}};
    const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
    const result=await response.json();
    if(!response.ok||!result.ok)throw Error(result.description||'TELEGRAM_PUBLISH_FAILED');
    put('release_0242_channel_message',result.result.message_id);
    console.log(JSON.stringify({published:true,messageId:result.result.message_id}));
  }else throw Error('MODE_REQUIRED');
}finally{db.close()}
