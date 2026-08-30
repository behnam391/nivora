import { randomUUID } from 'node:crypto';
import { hashPassword } from './auth.js';
import { postWalletTransaction } from './wallet.js';
import { approveWalletTopup } from './auto-review.js';

const phone=v=>String(v||'').replace(/[^\d+]/g,'').replace(/^\+98/,'0').replace(/^0098/,'0');
const fa=v=>Number(v||0).toLocaleString('fa-IR');
const customerMenu={keyboard:[[{text:'👤 حساب من'},{text:'📦 اشتراک‌های من'}],[{text:'🔑 بازیابی رمز'},{text:'📥 دانلود برنامه'}],[{text:'☎️ پشتیبانی'}]],resize_keyboard:true};
const adminMenu={keyboard:[[{text:'📊 داشبورد'},{text:'✨ تحلیل هوشمند'}],[{text:'🔎 جست‌وجوی مشتری'},{text:'🧾 پرداخت‌های منتظر'}],[{text:'🎫 تیکت‌های باز'},{text:'🖥 وضعیت سیستم'}],[{text:'🌐 بازکردن پنل'},{text:'🛡 مدیریت'}]],resize_keyboard:true};
const log=(db,actor,action,type,id,details=null)=>db.prepare('INSERT INTO audit_log(actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run(actor,action,type,id,details&&JSON.stringify(details),new Date().toISOString());

export function createTelegramRecovery(db,{getConfig,fetchImpl=fetch,aiOperationsSummary}={}){
  const states=new Map();
  return async(req,res,readJson,json)=>{
    const c=getConfig();
    if(!c.enabled||!c.token||!c.secret)return json(res,503,{error:'TELEGRAM_RECOVERY_DISABLED'});
    if(req.headers['x-telegram-bot-api-secret-token']!==c.secret)return json(res,401,{error:'UNAUTHORIZED'});
    const send=(chat,text,extra={})=>fetchImpl(`https://api.telegram.org/bot${c.token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text,...extra})});
    const update=await readJson(req),m=update.message;if(!m?.chat?.id)return json(res,200,{ok:true});
    const chat=String(m.chat.id),user=String(m.from?.id||''),text=String(m.text||'').trim(),now=new Date(),admin=c.adminIds.includes(user),actor=`telegram:${user}`;

    if(admin){
      const state=states.get(user)||{};
      if(text==='/cancel'||text==='لغو'){states.delete(user);await send(chat,'عملیات لغو شد.',{reply_markup:adminMenu});return json(res,200,{ok:true});}
      if(text==='/start'||text==='🛡 مدیریت'){
        states.delete(user);const s=db.prepare(`SELECT (SELECT COUNT(*) FROM accounts WHERE role='customer') customers,(SELECT COUNT(*) FROM orders WHERE status='under_review') pending,(SELECT COUNT(*) FROM subscriptions WHERE status='active') active,(SELECT COUNT(*) FROM support_tickets WHERE status<>'closed') tickets`).get();
        await send(chat,`کنسول مدیریت Nivora\n\nمشتریان: ${fa(s.customers)}\nاشتراک فعال: ${fa(s.active)}\nپرداخت منتظر: ${fa(s.pending)}\nتیکت باز: ${fa(s.tickets)}`,{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(text==='📊 داشبورد'){
        const s=db.prepare(`SELECT (SELECT COUNT(*) FROM orders WHERE status='approved') orders,(SELECT COALESCE(SUM(amount_transferred_irr/10),0) FROM orders WHERE status='approved') sales,(SELECT COALESCE(SUM(balance_toman),0) FROM wallet_accounts) wallets,(SELECT COUNT(*) FROM subscriptions WHERE status='failed' AND created_at>=datetime('now','-1 day')) failed`).get();
        await send(chat,`فروش ثبت‌شده: ${fa(s.orders)}\nمبلغ فروش: ${fa(s.sales)} تومان\nموجودی کل کیف پول‌ها: ${fa(s.wallets)} تومان\nساخت ناموفق ۲۴ ساعت: ${fa(s.failed)}`,{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(text==='✨ تحلیل هوشمند'){
        try{if(!aiOperationsSummary)throw new Error('AI_NOT_CONFIGURED');await send(chat,'در حال تحلیل آمار تجمیعی…');await send(chat,await aiOperationsSummary(),{reply_markup:adminMenu});}catch(error){await send(chat,error.message==='AI_RATE_LIMITED'?'ظرفیت رایگان موقتاً پر شده است.':'سرویس هوش مصنوعی فعلاً پاسخ نداد.',{reply_markup:adminMenu});}return json(res,200,{ok:true});
      }
      if(text==='🖥 وضعیت سیستم'){
        const failed=db.prepare("SELECT COUNT(*) count FROM subscriptions WHERE status='failed' AND created_at>=datetime('now','-1 hour')").get().count;await send(chat,`برنامه: فعال ✅\nپایگاه داده: سالم ✅\nساخت ناموفق یک ساعت اخیر: ${fa(failed)}\nزمان بررسی: ${new Date().toLocaleString('fa-IR')}`,{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(text==='🌐 بازکردن پنل'){await send(chat,'ورود امن به پنل مدیریت:',{reply_markup:{inline_keyboard:[[{text:'بازکردن پنل مدیریت',url:c.adminUrl||'https://b.nivorali.com/admin'}]]}});return json(res,200,{ok:true});}
      if(text==='🔎 جست‌وجوی مشتری'){states.set(user,{mode:'search'});await send(chat,'نام یا شماره موبایل مشتری را بفرستید.',{reply_markup:{keyboard:[[{text:'لغو'}]],resize_keyboard:true}});return json(res,200,{ok:true});}
      if(state.mode==='search'){
        const q=text.replace(/[٪%_]/g,'').trim(),rows=db.prepare(`SELECT a.id,a.name,a.phone,a.status,COALESCE(w.balance_toman,0) balance,(SELECT COUNT(*) FROM orders o JOIN subscriptions s ON s.order_id=o.id WHERE o.account_id=a.id AND s.status='active') active_subscriptions FROM accounts a LEFT JOIN wallet_accounts w ON w.account_id=a.id WHERE a.role='customer' AND (a.phone=? OR a.name LIKE ?) ORDER BY a.updated_at DESC LIMIT 8`).all(phone(q),`%${q}%`);
        if(!rows.length){await send(chat,'مشتری پیدا نشد؛ دوباره جست‌وجو کنید یا «لغو» را بزنید.');return json(res,200,{ok:true});}
        states.set(user,{mode:'select',rows});await send(chat,rows.map((x,i)=>`${i+1}) ${x.name} — ${x.phone}\nکیف پول ${fa(x.balance)} تومان · اشتراک ${fa(x.active_subscriptions)} · ${x.status==='active'?'فعال':'مسدود'}`).join('\n\n')+'\n\nشماره مشتری را بفرستید.',{reply_markup:{keyboard:[rows.slice(0,4).map((_,i)=>({text:String(i+1)})),[{text:'لغو'}]],resize_keyboard:true}});return json(res,200,{ok:true});
      }
      if(state.mode==='select'){
        const account=state.rows?.[Number(text)-1];if(!account){await send(chat,'شماره معتبر فهرست را بفرستید.');return json(res,200,{ok:true});}
        states.set(user,{mode:'account',account});await send(chat,`${account.name}\n${account.phone}\nکیف پول: ${fa(account.balance)} تومان\nاشتراک فعال: ${fa(account.active_subscriptions)}\nوضعیت: ${account.status==='active'?'فعال':'مسدود'}`,{reply_markup:{keyboard:[[{text:'➕ شارژ کیف پول'},{text:account.status==='active'?'⛔ مسدودکردن حساب':'✅ فعال‌کردن حساب'}],[{text:'📦 نمایش اشتراک‌ها'},{text:'لغو'}]],resize_keyboard:true}});return json(res,200,{ok:true});
      }
      if(state.mode==='account'&&text==='📦 نمایش اشتراک‌ها'){
        const rows=db.prepare(`SELECT p.name,s.status,s.control_status FROM orders o JOIN plans p ON p.id=o.plan_id JOIN subscriptions s ON s.order_id=o.id WHERE o.account_id=? ORDER BY o.created_at DESC LIMIT 10`).all(state.account.id);await send(chat,rows.length?rows.map(x=>`${x.name} — ${x.status}${x.control_status&&x.control_status!=='active'?` (${x.control_status})`:''}`).join('\n'):'اشتراکی ثبت نشده است.');return json(res,200,{ok:true});
      }
      if(state.mode==='account'&&text==='➕ شارژ کیف پول'){state.mode='amount';states.set(user,state);await send(chat,'مبلغ شارژ را به تومان و فقط عدد بفرستید.');return json(res,200,{ok:true});}
      if(state.mode==='amount'){
        const amount=Number(text.replace(/[,٬،\s]/g,''));if(!Number.isInteger(amount)||amount<1000||amount>100000000){await send(chat,'مبلغ باید بین ۱٬۰۰۰ تا ۱۰۰٬۰۰۰٬۰۰۰ تومان باشد.');return json(res,200,{ok:true});}state.amount=amount;state.mode='credit-confirm';states.set(user,state);await send(chat,`${fa(amount)} تومان به کیف پول ${state.account.name} افزوده شود؟`,{reply_markup:{keyboard:[[{text:'تأیید شارژ'},{text:'لغو'}]],resize_keyboard:true}});return json(res,200,{ok:true});
      }
      if(state.mode==='credit-confirm'&&text==='تأیید شارژ'){
        const result=postWalletTransaction(db,{accountId:state.account.id,amountToman:state.amount,type:'manual_credit',reference:`telegram-${randomUUID()}`,actor,note:'شارژ توسط مدیر تلگرام'});log(db,actor,'credit','wallet',state.account.id,{amountToman:state.amount});states.delete(user);await send(chat,`شارژ انجام شد. موجودی جدید: ${fa(result.balanceToman)} تومان`,{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(state.mode==='account'&&['⛔ مسدودکردن حساب','✅ فعال‌کردن حساب'].includes(text)){state.nextStatus=text.startsWith('⛔')?'suspended':'active';state.mode='status-confirm';states.set(user,state);await send(chat,`${state.account.name} ${state.nextStatus==='active'?'فعال':'مسدود'} شود؟`,{reply_markup:{keyboard:[[{text:'تأیید تغییر وضعیت'},{text:'لغو'}]],resize_keyboard:true}});return json(res,200,{ok:true});}
      if(state.mode==='status-confirm'&&text==='تأیید تغییر وضعیت'){
        db.prepare('UPDATE accounts SET status=?,updated_at=? WHERE id=?').run(state.nextStatus,new Date().toISOString(),state.account.id);if(state.nextStatus==='suspended')db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(state.account.id);log(db,actor,'status','account',state.account.id,{status:state.nextStatus});states.delete(user);await send(chat,'وضعیت حساب تغییر کرد.',{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(text==='🧾 پرداخت‌های منتظر'){
        const rows=db.prepare(`SELECT t.id,t.amount_toman,a.name,a.phone FROM wallet_topups t JOIN accounts a ON a.id=t.account_id WHERE t.status='under_review' ORDER BY t.created_at DESC LIMIT 8`).all();states.set(user,{mode:'topups',rows});await send(chat,rows.length?rows.map((x,i)=>`${i+1}) ${x.name} — ${x.phone}\n${fa(x.amount_toman)} تومان`).join('\n\n')+'\n\nتأیید: «تأیید شارژ 1»\nرد: «رد شارژ 1 دلیل»':'درخواست شارژ منتظری وجود ندارد.',{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(state.mode==='topups'&&/^تأیید شارژ \d+$/.test(text)){
        const topup=state.rows?.[Number(text.match(/\d+$/)[0])-1];if(!topup){await send(chat,'شماره درخواست معتبر نیست.');return json(res,200,{ok:true});}try{const result=approveWalletTopup(db,topup.id,{actor,note:'تأیید مدیر در تلگرام'});log(db,actor,'approve','wallet_topup',topup.id,{amountToman:topup.amount_toman});await send(chat,`شارژ تأیید شد؛ موجودی جدید ${fa(result.balanceToman)} تومان است.`,{reply_markup:adminMenu});}catch{await send(chat,'این درخواست قبلاً بررسی شده یا قابل تأیید نیست.',{reply_markup:adminMenu});}states.delete(user);return json(res,200,{ok:true});
      }
      if(state.mode==='topups'&&/^رد شارژ \d+\s+.+/.test(text)){
        const match=text.match(/^رد شارژ (\d+)\s+(.+)/),topup=state.rows?.[Number(match[1])-1];if(!topup){await send(chat,'شماره درخواست معتبر نیست.');return json(res,200,{ok:true});}const result=db.prepare("UPDATE wallet_topups SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'").run(match[2].slice(0,300),actor,new Date().toISOString(),topup.id);if(result.changes)log(db,actor,'reject','wallet_topup',topup.id,{reason:match[2].slice(0,300)});states.delete(user);await send(chat,result.changes?'درخواست شارژ رد شد.':'درخواست دیگر قابل بررسی نیست.',{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(text==='🎫 تیکت‌های باز'){
        const rows=db.prepare(`SELECT t.id,t.subject,a.name,(SELECT body FROM ticket_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) last_message FROM support_tickets t JOIN accounts a ON a.id=t.account_id WHERE t.status<>'closed' ORDER BY t.updated_at DESC LIMIT 8`).all();states.set(user,{mode:'tickets',rows});await send(chat,rows.length?rows.map((x,i)=>`${i+1}) ${x.name} — ${x.subject}\n${String(x.last_message||'').slice(0,180)}`).join('\n\n')+'\n\nپاسخ: «پاسخ 1 متن پاسخ»':'تیکت بازی وجود ندارد.',{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(state.mode==='tickets'&&/^پاسخ \d+\s+.+/.test(text)){
        const match=text.match(/^پاسخ (\d+)\s+([\s\S]+)/),ticket=state.rows?.[Number(match[1])-1],body=match[2].trim();if(!ticket||body.length<2){await send(chat,'شماره یا متن پاسخ معتبر نیست.');return json(res,200,{ok:true});}const timestamp=new Date().toISOString();db.prepare("INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'admin',?,?)").run(randomUUID(),ticket.id,body.slice(0,2000),timestamp);db.prepare("UPDATE support_tickets SET status='answered',owner_archived_at=NULL,updated_at=? WHERE id=?").run(timestamp,ticket.id);log(db,actor,'reply','support_ticket',ticket.id);states.delete(user);await send(chat,'پاسخ تیکت ثبت شد.',{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      await send(chat,'یکی از گزینه‌های کنسول مدیریت را انتخاب کنید.',{reply_markup:adminMenu});return json(res,200,{ok:true});
    }

    const link=db.prepare('SELECT l.*,a.name FROM telegram_account_links l JOIN accounts a ON a.id=l.account_id WHERE l.telegram_user_id=?').get(user);
    if(text==='📥 دانلود برنامه'){if(!c.latestReleaseUrl){await send(chat,'لینک نسخه جدید هنوز منتشر نشده است.',{reply_markup:customerMenu});return json(res,200,{ok:true});}await send(chat,'آخرین نسخه رسمی Nivora آماده دانلود است.',{reply_markup:{inline_keyboard:[[{text:'📥 دانلود آخرین نسخه',url:c.latestReleaseUrl}]]}});return json(res,200,{ok:true});}
    if((text==='/start'||text==='🔑 بازیابی رمز')&&!link){await send(chat,'برای اتصال امن حساب، شماره متعلق به همین حساب تلگرام را ارسال کنید.',{reply_markup:{keyboard:[[{text:'📱 ارسال شماره من',request_contact:true}]],resize_keyboard:true,one_time_keyboard:true}});return json(res,200,{ok:true});}
    if(m.contact){if(String(m.contact.user_id)!==user){await send(chat,'فقط شماره حساب تلگرام خودتان پذیرفته می‌شود.');return json(res,200,{ok:true});}const p=phone(m.contact.phone_number),a=db.prepare("SELECT id,name FROM accounts WHERE phone=? AND role='customer' AND status='active'").get(p);if(!a){await send(chat,'حساب فعالی با این شماره پیدا نشد.');return json(res,200,{ok:true});}db.prepare(`INSERT INTO telegram_account_links(telegram_user_id,chat_id,account_id,phone,linked_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id=excluded.chat_id,account_id=excluded.account_id,phone=excluded.phone,last_seen_at=excluded.last_seen_at`).run(user,chat,a.id,p,now.toISOString(),now.toISOString());await send(chat,`حساب ${a.name} با موفقیت متصل شد.`,{reply_markup:customerMenu});return json(res,200,{ok:true});}
    if(!link){await send(chat,'ابتدا /start را بزنید و شماره خودتان را تأیید کنید.');return json(res,200,{ok:true});}
    if(text==='👤 حساب من'){const w=db.prepare('SELECT balance_toman FROM wallet_accounts WHERE account_id=?').get(link.account_id);await send(chat,`${link.name}\n${link.phone}\nموجودی: ${fa(w?.balance_toman)} تومان`,{reply_markup:customerMenu});}
    else if(text==='📦 اشتراک‌های من'){const rows=db.prepare(`SELECT p.name,s.status,s.subscription_url FROM orders o JOIN plans p ON p.id=o.plan_id JOIN subscriptions s ON s.order_id=o.id WHERE o.account_id=? AND o.order_kind='purchase' ORDER BY o.created_at DESC LIMIT 10`).all(link.account_id);await send(chat,rows.length?rows.map(x=>`${x.name} — ${x.status}${x.subscription_url?`\n${x.subscription_url}`:''}`).join('\n\n'):'اشتراکی ندارید.',{reply_markup:customerMenu});}
    else if(text==='🔑 بازیابی رمز'){db.prepare(`INSERT INTO telegram_recovery_sessions(chat_id,account_id,verified_phone,state,expires_at,created_at) VALUES(?,?,?,'waiting_password',?,?) ON CONFLICT(chat_id) DO UPDATE SET account_id=excluded.account_id,verified_phone=excluded.verified_phone,state='waiting_password',expires_at=excluded.expires_at`).run(chat,link.account_id,link.phone,new Date(now.getTime()+600000).toISOString(),now.toISOString());await send(chat,'رمز جدید با حداقل ۸ کاراکتر را ارسال کنید.',{reply_markup:{remove_keyboard:true}});}
    else{const s=db.prepare("SELECT * FROM telegram_recovery_sessions WHERE chat_id=? AND state='waiting_password' AND expires_at>?").get(chat,now.toISOString());if(s){let p;try{p=hashPassword(text)}catch{await send(chat,'رمز باید حداقل ۸ کاراکتر باشد.');return json(res,200,{ok:true});}db.prepare('UPDATE accounts SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(p.hash,p.salt,now.toISOString(),s.account_id);db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(s.account_id);db.prepare("UPDATE telegram_recovery_sessions SET state='complete' WHERE chat_id=?").run(chat);await send(chat,'رمز تغییر کرد.',{reply_markup:customerMenu});}else await send(chat,'یکی از گزینه‌های منو را انتخاب کنید.',{reply_markup:customerMenu});}
    return json(res,200,{ok:true});
  };
}
