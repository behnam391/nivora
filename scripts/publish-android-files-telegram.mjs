// Run on deployment host: node --env-file=.env scripts/publish-android-files-telegram.mjs
import { DatabaseSync } from 'node:sqlite';
import { createHash, createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const db=new DatabaseSync(resolve(process.env.DATABASE_PATH||'data/nivora.db'));
const get=key=>db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
const put=(key,value)=>db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,String(value),new Date().toISOString());
const decrypt=value=>{try{const [iv,tag,data]=value.split('.'),key=createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY||process.env.ADMIN_TOKEN).digest(),cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));cipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString()}catch{return ''}};
const token=decrypt(get('telegram_token')||'')||process.env.TELEGRAM_BOT_TOKEN,channel=get('telegram_channel');
const files=[
  ['customer_arm64','/tmp/Nivora-Customer-v0.24.0-arm64.apk','Nivora-Customer-v0.24.0-arm64.apk','📱 نسخه مشتری Nivora ۰٫۲۴٫۰\n\n✅ مناسب بیشتر گوشی‌های جدید (ARM64)\n✅ رسمی و امضاشده\n\nبرای حفظ حساب و تنظیمات، برنامه قبلی را حذف نکنید و این فایل را روی نسخه موجود نصب کنید.'],
  ['customer_armv7','/tmp/Nivora-Customer-v0.24.0-armv7.apk','Nivora-Customer-v0.24.0-armv7.apk','📱 نسخه مشتری Nivora ۰٫۲۴٫۰\n\n✅ مناسب گوشی‌های قدیمی‌تر (ARMv7 / 32-bit)\n✅ رسمی و امضاشده\n\nاگر نسخه ARM64 نصب نشد از این فایل استفاده کنید. برنامه قبلی را حذف نکنید.'],
  ['partner','/tmp/Nivora-Partner-v0.24.0-universal.apk','Nivora-Partner-v0.24.0-universal.apk','💼 نسخه همکار Nivora ۰٫۲۴٫۰\n\n✅ نسخه عمومی و امضاشده\n✅ مدیریت مشتری، فروش اشتراک و ویرایش کیف پول\n\nبرای حفظ اطلاعات، برنامه قبلی را حذف نکنید و نسخه جدید را روی آن نصب کنید.']
];

try {
  if(!token||!channel)throw Error('TELEGRAM_NOT_CONFIGURED');
  const published=[];
  for(const [key,path,name,caption] of files){
    const setting=`android_0240_file_${key}`;
    if(get(setting)){published.push({key,skipped:true,messageId:Number(get(setting))});continue}
    const bytes=await readFile(path);
    if(bytes.length<1_000_000||bytes.length>49_000_000)throw Error(`INVALID_FILE_SIZE_${key}_${bytes.length}`);
    const form=new FormData();form.set('chat_id',channel);form.set('caption',caption);form.set('document',new Blob([bytes],{type:'application/vnd.android.package-archive'}),name);
    const response=await fetch(`https://api.telegram.org/bot${token}/sendDocument`,{method:'POST',body:form,signal:AbortSignal.timeout(180000)}),result=await response.json();
    if(!response.ok||!result.ok)throw Error(result.description||`TELEGRAM_UPLOAD_FAILED_${key}`);
    put(setting,result.result.message_id);published.push({key,messageId:result.result.message_id,size:bytes.length});
  }
  console.log(JSON.stringify({published:true,channel,files:published}));
} finally {db.close()}
