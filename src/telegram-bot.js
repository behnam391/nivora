import { randomUUID } from 'node:crypto';
import { hashPassword } from './auth.js';
import { postWalletTransaction } from './wallet.js';
import { approveWalletTopup } from './auto-review.js';

const phone=v=>String(v||'').replace(/[^\d+]/g,'').replace(/^\+98/,'0').replace(/^0098/,'0');
const fa=v=>Number(v||0).toLocaleString('fa-IR');
const customerMenu={keyboard:[[{text:'🛒 خرید اشتراک'},{text:'🧭 پیشنهاد هوشمند'}],[{text:'👤 حساب من'},{text:'📦 اشتراک‌های من'}],[{text:'🔑 بازیابی رمز'},{text:'📥 دانلود برنامه'}],[{text:'☎️ پشتیبانی'}]],resize_keyboard:true};
const adminMenu={keyboard:[[{text:'📊 داشبورد'},{text:'🚀 فروش هوشمند'}],[{text:'✨ تحلیل هوشمند'},{text:'🔎 جست‌وجوی مشتری'}],[{text:'🧾 پرداخت‌های منتظر'},{text:'🎫 تیکت‌های باز'}],[{text:'🖥 وضعیت سیستم'},{text:'🌐 بازکردن پنل'}],[{text:'🛡 مدیریت'}]],resize_keyboard:true};
const log=(db,actor,action,type,id,details=null)=>db.prepare('INSERT INTO audit_log(actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run(actor,action,type,id,details&&JSON.stringify(details),new Date().toISOString());

export function createTelegramRecovery(db,{getConfig,fetchImpl=fetch,aiOperationsSummary,aiPublicAnswer}={}){
  const states=new Map();
  const groupReplyCooldowns=new Map();
  return async(req,res,readJson,json)=>{
    const c=getConfig();
    if(!c.enabled||!c.token||!c.secret)return json(res,503,{error:'TELEGRAM_RECOVERY_DISABLED'});
    if(req.headers['x-telegram-bot-api-secret-token']!==c.secret)return json(res,401,{error:'UNAUTHORIZED'});
    const send=(chat,text,extra={})=>fetchImpl(`https://api.telegram.org/bot${c.token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text,...extra})});
    const update=await readJson(req),callback=update.callback_query,m=update.message||callback?.message;if(!m?.chat?.id)return json(res,200,{ok:true});
    const chat=String(m.chat.id),user=String((callback?.from||m.from)?.id||''),text=String(callback?.data||m.text||'').trim(),now=new Date(),admin=c.adminIds.includes(user),actor=`telegram:${user}`,privateChat=m.chat.type==='private';
    const answerCallback=text=>callback?.id?fetchImpl(`https://api.telegram.org/bot${c.token}/answerCallbackQuery`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({callback_query_id:callback.id,text})}):Promise.resolve();
    const campaign=db.prepare("SELECT campaign_code FROM telegram_growth_events WHERE telegram_user_id=? AND event_type='campaign_start' ORDER BY created_at DESC LIMIT 1").get(user)?.campaign_code||null;
    const touchLead=(fields={})=>{
      const old=db.prepare('SELECT * FROM sales_leads WHERE telegram_user_id=?').get(user),timestamp=new Date().toISOString();
      if(old){db.prepare(`UPDATE sales_leads SET chat_id=?,account_id=COALESCE(?,account_id),campaign_code=COALESCE(?,campaign_code),network=COALESCE(?,network),device=COALESCE(?,device),usage=COALESCE(?,usage),recommended_plan_id=COALESCE(?,recommended_plan_id),status=?,updated_at=? WHERE telegram_user_id=?`).run(chat,fields.accountId||null,fields.campaignCode||campaign,fields.network||null,fields.device||null,fields.usage||null,fields.planId||null,fields.status||old.status,timestamp,user);}
      else db.prepare(`INSERT INTO sales_leads(id,telegram_user_id,chat_id,account_id,campaign_code,network,device,usage,recommended_plan_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),user,chat,fields.accountId||null,fields.campaignCode||campaign,fields.network||null,fields.device||null,fields.usage||null,fields.planId||null,fields.status||'new',timestamp,timestamp);
    };
    const activePlans=()=>db.prepare("SELECT id,name,CAST(price_irr/10 AS INTEGER) price_toman,traffic_gb,duration_days,device_limit FROM plans WHERE active=1 AND id NOT LIKE 'staff-%' ORDER BY sort_order,name").all();
    const planText=plan=>`${plan.name}\n${plan.traffic_gb?fa(plan.traffic_gb)+' گیگ':'حجم نامحدود'} · ${plan.duration_days?fa(plan.duration_days)+' روز':'زمان نامحدود'} · ${fa(plan.device_limit)} دستگاه\n${fa(plan.price_toman)} تومان`;

    // Account, payment and recovery flows must never run in a group. In groups the
    // bot answers only an explicit mention/reply and reveals no customer data.
    if(!privateChat){
      if(admin&&/^\/chatid(?:@\w+)?$/i.test(text)){await send(chat,`شناسه امن این گروه:\n${chat}`);return json(res,200,{ok:true});}
      const allowed=Boolean(c.groupIds?.includes(chat));
      const mentioned=c.username&&new RegExp(`@${c.username}\\b`,'i').test(text);
      const relevant=/(?:چطور|چگونه|راهنما|خرید|اشتراک|قیمت|پلن|پرداخت|کارت|رسید|نصب|دانلود|برنامه|وصل|اتصال|قطع|پشتیبان|تمدید|حجم|اعتبار|ویندوز|اندروید|آیفون|iphone|ios)/i.test(text);
      const invoked=/^\/(?:start|help)(?:@\w+)?\b/i.test(text)||mentioned||Boolean(m.reply_to_message?.from?.is_bot)||(c.groupAutoReply&&relevant);
      if(!allowed||!c.groupAiEnabled||!invoked)return json(res,200,{ok:true});
      const cooldownKey=`${chat}:${user}`,lastReply=groupReplyCooldowns.get(cooldownKey)||0;
      if(Date.now()-lastReply<12000)return json(res,200,{ok:true});
      groupReplyCooldowns.set(cooldownKey,Date.now());
      const question=text.replace(/^\/(?:start|help)(?:@\w+)?\s*/i,'').replace(c.username?new RegExp(`@${c.username}\\b`,'ig'):/$^/g,'').trim();
      const privateUrl=c.username?`https://t.me/${c.username}`:'https://t.me/nivorali_bot';
      if(question.length<3){await send(chat,'من دستیار عمومی Nivora هستم. سؤال عمومی درباره خرید، نصب، اتصال یا پشتیبانی را با منشن ربات بپرسید. اطلاعات حساب فقط در گفت‌وگوی خصوصی نمایش داده می‌شود.',{reply_markup:{inline_keyboard:[[{text:'گفت‌وگوی خصوصی',url:privateUrl}]]}});return json(res,200,{ok:true});}
      try{
        const answer=aiPublicAnswer?await aiPublicAnswer(question):'برای راهنمایی دقیق‌تر، از گفت‌وگوی خصوصی ربات با پشتیبانی در ارتباط باشید.';
        await send(chat,answer,{reply_markup:{inline_keyboard:[[{text:'ادامه خصوصی و خرید',url:privateUrl}]]}});
      }catch{await send(chat,'الان پاسخ‌گوی هوشمند در دسترس نیست؛ لطفاً در گفت‌وگوی خصوصی پیام بدهید.',{reply_markup:{inline_keyboard:[[{text:'گفت‌وگوی خصوصی',url:privateUrl}]]}});}
      return json(res,200,{ok:true});
    }

    const startMatch=text.match(/^\/start(?:@\w+)?\s+(?:camp|ref)_([A-Za-z0-9_-]{1,48})$/i);
    if(startMatch)db.prepare("INSERT OR IGNORE INTO telegram_growth_events(id,telegram_user_id,chat_id,event_type,campaign_code,created_at) VALUES(?,?,?,'campaign_start',?,?)").run(randomUUID(),user,chat,startMatch[1],now.toISOString());
    const normalizedText=startMatch?'/start':text;

    if(admin){
      const state=states.get(user)||{};
      if(/^topup:approve:[a-f0-9-]+$/i.test(text)){
        const id=text.split(':').at(-1);try{const result=approveWalletTopup(db,id,{actor,note:'تأیید مدیر در ربات تلگرام'});log(db,actor,'approve','wallet_topup',id);await answerCallback('تأیید شد');await send(chat,`✅ پرداخت تأیید و کیف پول شارژ شد. موجودی جدید: ${fa(result.balanceToman)} تومان`,{reply_markup:adminMenu});}catch{await answerCallback('قبلاً بررسی شده');await send(chat,'این درخواست قبلاً بررسی شده یا قابل تأیید نیست.',{reply_markup:adminMenu});}return json(res,200,{ok:true});
      }
      if(/^topup:reject:[a-f0-9-]+$/i.test(text)){
        const id=text.split(':').at(-1),topup=db.prepare("SELECT id,amount_toman FROM wallet_topups WHERE id=? AND status='under_review'").get(id);if(!topup){await answerCallback('قبلاً بررسی شده');return json(res,200,{ok:true});}states.set(user,{mode:'topup-reject-reason',topup});await answerCallback('دلیل را بفرستید');await send(chat,'دلیل رد پرداخت را بنویسید.',{reply_markup:{keyboard:[[{text:'لغو'}]],resize_keyboard:true}});return json(res,200,{ok:true});
      }
      if(state.mode==='topup-reject-reason'){
        if(text.length<3){await send(chat,'دلیل را کمی کامل‌تر بنویسید.');return json(res,200,{ok:true});}const result=db.prepare("UPDATE wallet_topups SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'").run(text.slice(0,300),actor,new Date().toISOString(),state.topup.id);if(result.changes)log(db,actor,'reject','wallet_topup',state.topup.id,{reason:text.slice(0,300)});states.delete(user);await send(chat,result.changes?'❌ درخواست پرداخت رد شد.':'درخواست دیگر قابل بررسی نیست.',{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(text==='/cancel'||text==='لغو'){states.delete(user);await send(chat,'عملیات لغو شد.',{reply_markup:adminMenu});return json(res,200,{ok:true});}
      if(normalizedText==='/start'||text==='🛡 مدیریت'){
        states.delete(user);const s=db.prepare(`SELECT (SELECT COUNT(*) FROM accounts WHERE role='customer') customers,(SELECT COUNT(*) FROM orders WHERE status='under_review') pending,(SELECT COUNT(*) FROM subscriptions WHERE status='active') active,(SELECT COUNT(*) FROM support_tickets WHERE status<>'closed') tickets`).get();
        await send(chat,`کنسول مدیریت Nivora\n\nمشتریان: ${fa(s.customers)}\nاشتراک فعال: ${fa(s.active)}\nپرداخت منتظر: ${fa(s.pending)}\nتیکت باز: ${fa(s.tickets)}`,{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(text==='📊 داشبورد'){
        const s=db.prepare(`SELECT (SELECT COUNT(*) FROM orders WHERE status='approved') orders,(SELECT COALESCE(SUM(amount_transferred_irr/10),0) FROM orders WHERE status='approved') sales,(SELECT COALESCE(SUM(balance_toman),0) FROM wallet_accounts) wallets,(SELECT COUNT(*) FROM subscriptions WHERE status='failed' AND created_at>=datetime('now','-1 day')) failed`).get();
        await send(chat,`فروش ثبت‌شده: ${fa(s.orders)}\nمبلغ فروش: ${fa(s.sales)} تومان\nموجودی کل کیف پول‌ها: ${fa(s.wallets)} تومان\nساخت ناموفق ۲۴ ساعت: ${fa(s.failed)}`,{reply_markup:adminMenu});return json(res,200,{ok:true});
      }
      if(text==='🚀 فروش هوشمند'){
        const s=db.prepare(`SELECT COUNT(*) leads,COUNT(CASE WHEN status IN ('qualified','recommended','linked','converted') THEN 1 END) qualified,COUNT(CASE WHEN status='recommended' THEN 1 END) recommended,COUNT(CASE WHEN status='linked' THEN 1 END) linked,COUNT(CASE WHEN status='converted' THEN 1 END) converted FROM sales_leads`).get();
        const campaigns=db.prepare(`SELECT COALESCE(campaign_code,'بدون کمپین') campaign,COUNT(DISTINCT telegram_user_id) starts FROM telegram_growth_events WHERE event_type='campaign_start' GROUP BY campaign_code ORDER BY starts DESC LIMIT 5`).all();
        const rate=s.leads?Math.round(Number(s.converted||0)*100/Number(s.leads)):0;
        await send(chat,`گزارش ایجنت فروش\n\nسرنخ‌ها: ${fa(s.leads)}\nنیازسنجی‌شده: ${fa(s.qualified)}\nپیشنهاد دریافت‌کرده: ${fa(s.recommended)}\nحساب متصل: ${fa(s.linked)}\nخرید موفق: ${fa(s.converted)}\nنرخ تبدیل: ${fa(rate)}٪${campaigns.length?'\n\nکمپین‌ها:\n'+campaigns.map(x=>`${x.campaign}: ${fa(x.starts)}`).join('\n'):''}`,{reply_markup:adminMenu});return json(res,200,{ok:true});
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
    if(/^sales:(network|device|usage):/i.test(text)){
      const [,step,value]=text.split(':'),state=states.get(user)||{};
      if(step==='network'){state.network=value;state.mode='sales-device';states.set(user,state);touchLead({network:value,status:'qualified'});await answerCallback('ثبت شد');await send(chat,'از چه دستگاهی استفاده می‌کنید؟',{reply_markup:{inline_keyboard:[[{text:'اندروید',callback_data:'sales:device:android'},{text:'آیفون',callback_data:'sales:device:ios'}],[{text:'ویندوز',callback_data:'sales:device:windows'},{text:'چند دستگاه',callback_data:'sales:device:multi'}]]}});return json(res,200,{ok:true});}
      if(step==='device'){state.device=value;state.mode='sales-usage';states.set(user,state);touchLead({device:value,status:'qualified'});await answerCallback('ثبت شد');await send(chat,'مصرف تقریبی ماهانه شما چقدر است؟',{reply_markup:{inline_keyboard:[[{text:'کم؛ پیام‌رسان و وب',callback_data:'sales:usage:light'}],[{text:'متوسط؛ شبکه‌های اجتماعی',callback_data:'sales:usage:medium'}],[{text:'زیاد؛ ویدئو و دانلود',callback_data:'sales:usage:heavy'}]]}});return json(res,200,{ok:true});}
      if(step==='usage'){
        state.usage=value;const plans=activePlans();if(!plans.length){await send(chat,'در حال حاضر پلن فعالی برای فروش وجود ندارد.',{reply_markup:customerMenu});return json(res,200,{ok:true});}
        const target=value==='light'?30:value==='medium'?60:120;
        const plan=plans.find(x=>Number(x.traffic_gb)===0||Number(x.traffic_gb)>=target)||plans.at(-1);
        states.delete(user);touchLead({usage:value,planId:plan.id,status:'recommended'});db.prepare("INSERT INTO telegram_growth_events(id,telegram_user_id,chat_id,event_type,campaign_code,created_at) VALUES(?,?,?,'plan_recommended',?,?)").run(randomUUID(),user,chat,campaign,new Date().toISOString());await answerCallback('پیشنهاد آماده شد');await send(chat,`پیشنهاد مناسب برای شما:\n\n${planText(plan)}\n\nاین پیشنهاد بر اساس دستگاه و میزان مصرف انتخاب شده است. خرید و پرداخت فقط داخل برنامه Nivora یا همین ربات انجام می‌شود.`,{reply_markup:{inline_keyboard:[[{text:'🛒 انتخاب همین پلن',callback_data:`sales:select:${plan.id}`}],[{text:'دیدن همه پلن‌ها',callback_data:'sales:plans:all'}]]}});return json(res,200,{ok:true});
      }
    }
    if(text==='sales:plans:all'){
      const plans=activePlans();await answerCallback('پلن‌های فعال');touchLead({status:'qualified'});await send(chat,plans.length?plans.map(planText).join('\n\n────────\n\n'):'پلن فعالی موجود نیست.',{reply_markup:{inline_keyboard:plans.slice(0,8).map(plan=>[{text:`انتخاب ${plan.name}`,callback_data:`sales:select:${plan.id}`}])}});return json(res,200,{ok:true});
    }
    if(text==='sales:restart'){
      states.set(user,{mode:'sales-network'});touchLead({status:'new'});await answerCallback('شروع نیازسنجی');await send(chat,'اینترنت اصلی شما کدام است؟',{reply_markup:{inline_keyboard:[[{text:'همراه اول',callback_data:'sales:network:mci'},{text:'ایرانسل',callback_data:'sales:network:mtn'}],[{text:'رایتل',callback_data:'sales:network:rightel'},{text:'وای‌فای / مخابرات',callback_data:'sales:network:wifi'}]]}});return json(res,200,{ok:true});
    }
    if(text==='🧭 پیشنهاد هوشمند'){
      states.set(user,{mode:'sales-network'});touchLead({status:'new'});await send(chat,'برای پیشنهاد دقیق‌تر، اینترنت اصلی شما کدام است؟',{reply_markup:{inline_keyboard:[[{text:'همراه اول',callback_data:'sales:network:mci'},{text:'ایرانسل',callback_data:'sales:network:mtn'}],[{text:'رایتل',callback_data:'sales:network:rightel'},{text:'وای‌فای / مخابرات',callback_data:'sales:network:wifi'}]]}});return json(res,200,{ok:true});
    }
    if(text==='🛒 خرید اشتراک'){
      const plans=activePlans();touchLead({status:'qualified'});db.prepare("INSERT INTO telegram_growth_events(id,telegram_user_id,chat_id,event_type,campaign_code,created_at) VALUES(?,?,?,'store_open',?,?)").run(randomUUID(),user,chat,campaign,new Date().toISOString());await send(chat,plans.length?`پلن‌های فعال Nivora:\n\n${plans.map(planText).join('\n\n────────\n\n')}`:'در حال حاضر پلن فعالی ثبت نشده است.',{reply_markup:{inline_keyboard:[...plans.slice(0,8).map(plan=>[{text:`خرید ${plan.name}`,callback_data:`sales:select:${plan.id}`}]),[{text:'🧭 کمک برای انتخاب',callback_data:'sales:restart'}]]}});return json(res,200,{ok:true});
    }
    if(/^sales:select:/.test(text)){
      const plan=activePlans().find(item=>item.id===text.slice('sales:select:'.length));await answerCallback(plan?'انتخاب شد':'پلن در دسترس نیست');if(!plan)return json(res,200,{ok:true});touchLead({planId:plan.id,status:'recommended'});const linked=db.prepare('SELECT 1 FROM telegram_account_links WHERE telegram_user_id=?').get(user);const rows=[[{text:'📥 بازکردن/دانلود برنامه Nivora',url:c.latestReleaseUrl||'https://t.me/nivorali'}]];await send(chat,`${planText(plan)}\n\n${linked?'برای پرداخت از کیف پول و فعال‌سازی فوری، برنامه Nivora را باز کنید.':'ابتدا داخل برنامه Nivora ثبت‌نام کنید؛ سپس همین پلن را از بخش خرید انتخاب نمایید.'}\nهیچ صفحه فروش وبی باز نمی‌شود.`,{reply_markup:{inline_keyboard:rows}});return json(res,200,{ok:true});
    }
    if(text==='📥 دانلود برنامه'){if(!c.latestReleaseUrl){await send(chat,'لینک نسخه جدید هنوز منتشر نشده است.',{reply_markup:customerMenu});return json(res,200,{ok:true});}await send(chat,'آخرین نسخه رسمی Nivora آماده دانلود است.',{reply_markup:{inline_keyboard:[[{text:'📥 دانلود آخرین نسخه',url:c.latestReleaseUrl}]]}});return json(res,200,{ok:true});}
    if(normalizedText==='/start'&&!link){touchLead({status:'new'});await send(chat,'به Nivora خوش آمدید 💙\n\nاگر هنوز حساب ندارید، همین‌جا پلن مناسب را پیدا کنید و خرید را ادامه دهید. اگر قبلاً ثبت‌نام کرده‌اید، شماره متعلق به همین حساب تلگرام را برای اتصال حساب بفرستید.',{reply_markup:{keyboard:[[{text:'🛒 خرید اشتراک'},{text:'🧭 پیشنهاد هوشمند'}],[{text:'📱 اتصال حساب موجود',request_contact:true},{text:'📥 دانلود برنامه'}]],resize_keyboard:true}});return json(res,200,{ok:true});}
    if(text==='🔑 بازیابی رمز'&&!link){await send(chat,'برای بازیابی رمز، شماره متعلق به حساب Nivora و همین حساب تلگرام را ارسال کنید.',{reply_markup:{keyboard:[[{text:'📱 ارسال شماره حساب',request_contact:true}],[{text:'🛒 خرید اشتراک'},{text:'🧭 پیشنهاد هوشمند'}]],resize_keyboard:true}});return json(res,200,{ok:true});}
    if(m.contact){if(String(m.contact.user_id)!==user){await send(chat,'فقط شماره حساب تلگرام خودتان پذیرفته می‌شود.');return json(res,200,{ok:true});}const p=phone(m.contact.phone_number),a=db.prepare("SELECT id,name FROM accounts WHERE phone=? AND role='customer' AND status='active'").get(p);if(!a){touchLead({status:'qualified'});await send(chat,'این شماره هنوز حساب فعال Nivora ندارد؛ مشکلی نیست. ثبت‌نام و پرداخت فقط داخل برنامه یا همین ربات انجام می‌شود.',{reply_markup:{inline_keyboard:[[{text:'🧭 دریافت پیشنهاد هوشمند',callback_data:'sales:restart'}],[{text:'🛒 مشاهده پلن‌ها در ربات',callback_data:'sales:plans:all'}],...(c.latestReleaseUrl?[[{text:'📥 دانلود برنامه',url:c.latestReleaseUrl}]]:[])]}});return json(res,200,{ok:true});}db.prepare(`INSERT INTO telegram_account_links(telegram_user_id,chat_id,account_id,phone,linked_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id=excluded.chat_id,account_id=excluded.account_id,phone=excluded.phone,last_seen_at=excluded.last_seen_at`).run(user,chat,a.id,p,now.toISOString(),now.toISOString());touchLead({accountId:a.id,status:'linked'});await send(chat,`حساب ${a.name} با موفقیت متصل شد.`,{reply_markup:customerMenu});return json(res,200,{ok:true});}
    if(!link){await send(chat,'ابتدا /start را بزنید و شماره خودتان را تأیید کنید.');return json(res,200,{ok:true});}
    if(text==='👤 حساب من'){const w=db.prepare('SELECT balance_toman FROM wallet_accounts WHERE account_id=?').get(link.account_id);await send(chat,`${link.name}\n${link.phone}\nموجودی: ${fa(w?.balance_toman)} تومان`,{reply_markup:customerMenu});}
    else if(text==='📦 اشتراک‌های من'){const rows=db.prepare(`SELECT p.name,s.status,s.subscription_url FROM orders o JOIN plans p ON p.id=o.plan_id JOIN subscriptions s ON s.order_id=o.id WHERE o.account_id=? AND o.order_kind='purchase' ORDER BY o.created_at DESC LIMIT 10`).all(link.account_id);await send(chat,rows.length?rows.map(x=>`${x.name} — ${x.status}${x.subscription_url?`\n${x.subscription_url}`:''}`).join('\n\n'):'اشتراکی ندارید.',{reply_markup:customerMenu});}
    else if(text==='🔑 بازیابی رمز'){db.prepare(`INSERT INTO telegram_recovery_sessions(chat_id,account_id,verified_phone,state,expires_at,created_at) VALUES(?,?,?,'waiting_password',?,?) ON CONFLICT(chat_id) DO UPDATE SET account_id=excluded.account_id,verified_phone=excluded.verified_phone,state='waiting_password',expires_at=excluded.expires_at`).run(chat,link.account_id,link.phone,new Date(now.getTime()+600000).toISOString(),now.toISOString());await send(chat,'رمز جدید با حداقل ۸ کاراکتر را ارسال کنید.',{reply_markup:{remove_keyboard:true}});}
    else{const s=db.prepare("SELECT * FROM telegram_recovery_sessions WHERE chat_id=? AND state='waiting_password' AND expires_at>?").get(chat,now.toISOString());if(s){let p;try{p=hashPassword(text)}catch{await send(chat,'رمز باید حداقل ۸ کاراکتر باشد.');return json(res,200,{ok:true});}db.prepare('UPDATE accounts SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(p.hash,p.salt,now.toISOString(),s.account_id);db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(s.account_id);db.prepare("UPDATE telegram_recovery_sessions SET state='complete' WHERE chat_id=?").run(chat);await send(chat,'رمز تغییر کرد.',{reply_markup:customerMenu});}else await send(chat,'یکی از گزینه‌های منو را انتخاب کنید.',{reply_markup:customerMenu});}
    return json(res,200,{ok:true});
  };
}
