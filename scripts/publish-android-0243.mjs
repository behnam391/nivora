// On the deployment host: node --env-file=.env scripts/publish-android-0243.mjs <activate|notify|files>
import { DatabaseSync } from 'node:sqlite';
import { createHash, createDecipheriv, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const mode=process.argv[2];
const db=new DatabaseSync(resolve(process.env.DATABASE_PATH||'data/nivora.db'));
const get=key=>db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
const put=(key,value)=>db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,String(value),new Date().toISOString());
const decrypt=value=>{try{const [iv,tag,data]=value.split('.'),key=createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY||process.env.ADMIN_TOKEN).digest(),cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));cipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString()}catch{return ''}};
const url='https://raw.githubusercontent.com/behnam391/nivora/releases/android/Nivora-Customer-v0.24.3-universal.apk';
const notes='حذف اشتراک انتخاب‌شده بدون بازگشت وجه، یادآوری ملایم تمدید و بهبود پایداری و امنیت.';
const announcement='🔔 بروزرسانی Nivora ۰٫۲۴٫۳\n\nمی‌دانیم امروز دو بروزرسانی منتشر شده است. وقتی اصلاحات مهم آماده می‌شود، انتشارشان را به تعویق نمی‌اندازیم؛ این نسخه بهبودهای امنیتی و پایداری و رفع ایرادهای گزارش‌شده را در بر دارد.\n\n✨ یادآوری تمدید پیش از پایان اشتراک، با امکان «بعداً»\n🧹 حذف اشتراک انتخاب‌شده بدون بازگشت وجه، با تأیید صریح\n\nبرنامه قبلی را حذف نکنید؛ این فایل امضاشده را روی آن نصب کنید. از گزارش‌ها و همراهی شما ممنونیم 💙';

try{
  if(mode==='activate'){
    const response=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(30000)});
    if(!response.ok||Number(response.headers.get('content-length'))<1_000_000)throw Error('RELEASE_NOT_AVAILABLE');
    if(Number(get('android_customer_version_code')||0)>59)throw Error('NEWER_RELEASE_IS_ACTIVE');
    if(Number(get('android_customer_version_code')||0)===59){console.log(JSON.stringify({activated:true,skipped:true,version:'0.24.3'}));process.exit(0)}
    db.exec('BEGIN IMMEDIATE');
    try{for(const [key,value] of Object.entries({version_code:59,version_name:'0.24.3',download_url:url,release_notes:notes,force_update:false,published_at:new Date().toISOString()}))put(`android_customer_${key}`,value);put('telegram_latest_release_url',url);put('release_0243_activation',new Date().toISOString());db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error}
    console.log(JSON.stringify({activated:true,version:'0.24.3',url}));
  }else if(mode==='notify'){
    if(!get('release_0243_activation'))throw Error('RELEASE_NOT_ACTIVATED');
    if(get('release_0243_notification')){console.log(JSON.stringify({notified:true,skipped:true}));process.exit(0)}
    const accounts=db.prepare("SELECT id FROM accounts WHERE role='customer' AND status='active'").all(),insert=db.prepare('INSERT INTO notifications(id,account_id,title,body,created_at) VALUES(?,?,?,?,?)'),now=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try{for(const account of accounts)insert.run(randomUUID(),account.id,'بروزرسانی جدید نیورا','نسخه ۰٫۲۴٫۳ با بهبود پایداری، یادآوری تمدید و مدیریت بهتر اشتراک آماده است. از داخل برنامه به‌روزرسانی کنید.',now);put('release_0243_notification',now);db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error}
    console.log(JSON.stringify({notified:accounts.length}));
  }else if(mode==='files'){
    if(!get('release_0243_activation'))throw Error('RELEASE_NOT_ACTIVATED');
    const token=decrypt(get('telegram_token')||'')||process.env.TELEGRAM_BOT_TOKEN,channel=get('telegram_channel');
    if(!token||!channel)throw Error('TELEGRAM_CHANNEL_NOT_CONFIGURED');
    const files=[
      ['arm64','/tmp/Nivora-Customer-v0.24.3-arm64.apk','Nivora-Customer-v0.24.3-arm64.apk',announcement+'\n\n📱 این فایل برای بیشتر گوشی‌های جدید (ARM64) است.'],
      ['armv7','/tmp/Nivora-Customer-v0.24.3-armv7.apk','Nivora-Customer-v0.24.3-armv7.apk','📱 نسخه ۰٫۲۴٫۳ برای گوشی‌های قدیمی‌تر ۳۲بیتی (ARMv7).\n\nاگر فایل ARM64 نصب نشد، این نسخه را روی برنامه قبلی نصب کنید؛ برنامه را حذف نکنید.']
    ];
    const published=[];
    for(const [kind,path,name,caption] of files){
      const key=`release_0243_file_${kind}`;
      if(get(key)){published.push({kind,skipped:true,messageId:Number(get(key))});continue}
      const bytes=await readFile(path);
      if(bytes.length<1_000_000||bytes.length>49_000_000)throw Error(`INVALID_APK_SIZE_${kind}`);
      const form=new FormData();form.set('chat_id',channel);form.set('caption',caption);form.set('document',new Blob([bytes],{type:'application/vnd.android.package-archive'}),name);
      const response=await fetch(`https://api.telegram.org/bot${token}/sendDocument`,{method:'POST',body:form,signal:AbortSignal.timeout(240000)}),result=await response.json();
      if(!response.ok||!result.ok)throw Error(result.description||`TELEGRAM_UPLOAD_FAILED_${kind}`);
      put(key,result.result.message_id);published.push({kind,messageId:result.result.message_id,size:bytes.length});
    }
    console.log(JSON.stringify({published:true,channel,files:published}));
  }else throw Error('MODE_REQUIRED');
}finally{db.close()}
