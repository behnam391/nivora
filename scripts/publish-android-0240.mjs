// Run on the deployment host with: node --env-file=.env scripts/publish-android-0240.mjs <activate|channel>
import { DatabaseSync } from 'node:sqlite';
import { createHash, createDecipheriv } from 'node:crypto';
import { resolve } from 'node:path';

const mode=process.argv[2];
const db=new DatabaseSync(resolve(process.env.DATABASE_PATH||'data/nivora.db'));
const get=key=>db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
const put=(key,value)=>db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,String(value),new Date().toISOString());
const decrypt=value=>{try{const [iv,tag,data]=value.split('.'),key=createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY||process.env.ADMIN_TOKEN).digest(),cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));cipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString()}catch{return ''}};
const token=decrypt(get('telegram_token')||'')||process.env.TELEGRAM_BOT_TOKEN,channel=get('telegram_channel');
const base='https://raw.githubusercontent.com/behnam391/nivora/releases/android/';
const customer=base+'Nivora-Customer-v0.24.0-universal.apk',partner=base+'Nivora-Partner-v0.24.0-universal.apk';
const customerNotes='کلید اتصال سریع در پنل بالای اندروید، دسترسی به لوکیشن ترکیه، اتصال پایدارتر و پشتیبانی از سرویس OpenVPN برای استفاده کاربران آیفون.';
const partnerNotes='ویرایش کامل کیف پول مشتری با نمایش موجودی و دکمه‌های جداگانه افزایش، کاهش و صفر کردن؛ همراه با دسترسی به فروش لوکیشن ترکیه و OpenVPN.';
async function telegram(method,payload){const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)}),data=await response.json();if(!response.ok||!data.ok)throw Error(data.description||'TELEGRAM_FAILED');return data.result}

try {
  if(mode==='activate'){
    for(const url of [customer,partner]){const response=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(25000)});if(!response.ok||Number(response.headers.get('content-length'))<1_000_000)throw Error('RELEASE_NOT_AVAILABLE')}
    db.exec('BEGIN IMMEDIATE');
    try {
      for(const [audience,url,notes] of [['customer',customer,customerNotes],['partner',partner,partnerNotes]]){
        const prefix=`android_${audience}_`;
        for(const [key,value] of Object.entries({version_code:56,version_name:'0.24.0',download_url:url,release_notes:notes,force_update:false,published_at:new Date().toISOString()}))put(prefix+key,value);
      }
      put('telegram_latest_release_url',customer);put('release_0240_activation',new Date().toISOString());db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error}
    console.log(JSON.stringify({activated:true,version:'0.24.0'}));
  } else if(mode==='channel'){
    if(get('release_0240_channel_message'))throw Error('ALREADY_POSTED');
    if(!get('release_0240_activation'))throw Error('RELEASE_NOT_ACTIVATED');
    const text='🚀 نسخه جدید Nivora ۰٫۲۴٫۰ منتشر شد\n\n🇹🇷 لوکیشن ترکیه به مسیرهای قابل خرید اضافه شده است.\n🍎 اشتراک OpenVPN نیز برای اتصال راحت‌تر کاربران آیفون در دسترس است.\n⚡ در نسخه مشتری، کلید روشن و خاموش سریع Nivora به پنل بالای اندروید اضافه شده است.\n💼 در نسخه همکار، کیف پول مشتری با سه گزینه مستقل افزایش، کاهش و صفر کردن موجودی مدیریت می‌شود.\n\nنسخه‌ها رسمی و امضاشده هستند؛ برای حفظ اطلاعات، برنامه قبلی را حذف نکنید و نسخه جدید را روی آن نصب کنید.';
    const message=await telegram('sendMessage',{chat_id:channel,text,disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:'📥 دانلود نسخه مشتری',url:customer}],[{text:'💼 دانلود نسخه همکار',url:partner}],[{text:'🤖 ربات Nivora',url:'https://t.me/nivorali_bot'}]]}});
    put('release_0240_channel_message',message.message_id);console.log(JSON.stringify({published:true,channel,messageId:message.message_id}));
  } else throw Error('MODE_REQUIRED');
} finally { db.close() }
