const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const fa=value=>new Intl.NumberFormat('fa-IR').format(Number(value)||0);
const date=value=>value?new Date(value).toLocaleString('fa-IR',{dateStyle:'medium',timeStyle:'short'}):'—';
const esc=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const safeUrl=value=>{try{const url=new URL(value,location.origin);return ['http:','https:'].includes(url.protocol)?url.href:'#'}catch{return '#'}};
const errorText=code=>({INSUFFICIENT_BALANCE:'موجودی کیف پول کافی نیست.',PHONE_ALREADY_EXISTS:'این شماره قبلاً ثبت شده است.',INVALID_CREDENTIALS:'شماره یا رمز عبور صحیح نیست.',DEVICE_ALREADY_BOUND:'این حساب روی دستگاه دیگری فعال است؛ از پشتیبانی بخواهید دستگاه قبلی را آزاد کند.',DEVICE_LIMIT_REACHED:'ظرفیت دستگاه‌های این حساب تکمیل است؛ از پشتیبانی بخواهید یکی را آزاد کند.',DEVICE_REQUIRED:'این آیفون شناسایی نشد؛ صفحه را تازه کنید و دوباره بزنید.',RATE_LIMITED:'تعداد تلاش‌ها زیاد بود؛ یک دقیقه صبر کنید و دوباره وارد شوید.',IMPORT_RATE_LIMITED:'تعداد لینک‌های ساخته‌شده زیاد است؛ ده دقیقه دیگر دوباره امتحان کنید.',SUBSCRIPTION_NOT_FOUND:'اشتراک مورد نظر پیدا نشد.',SUBSCRIPTION_NOT_ACTIVE:'این اشتراک فعال نیست و قابل افزودن به آیفون نیست.',SUBSCRIPTION_NOT_READY:'اشتراک هنوز برای اتصال آماده نشده است.',IMPORT_LINK_EXPIRED:'این لینک منقضی شده؛ یک لینک تازه بسازید.',WEAK_PASSWORD:'رمز باید حداقل ۸ کاراکتر باشد.',NO_CAPACITY:'ظرفیت این پلن تکمیل است.',DISCOUNT_NOT_AVAILABLE:'کد تخفیف معتبر یا قابل استفاده نیست.',PROVISION_FAILED:'ساخت اشتراک ناموفق بود و مبلغ به کیف پول برگشت.',RENEW_FAILED:'تمدید ناموفق بود و مبلغ به کیف پول برگشت.',INVALID_TOPUP:'مبلغ یا اطلاعات رسید کامل نیست.',INVALID_PAYMENT_AMOUNT:'مبلغ واریز معتبر نیست.',RECEIPT_REQUIRED:'شماره پیگیری و تصویر رسید را کامل وارد کنید.',INVALID_RECEIPT:'تصویر رسید معتبر نیست.',INVALID_RECEIPT_TYPE:'فرمت رسید باید JPG، PNG یا WebP باشد.',RECEIPT_TOO_LARGE:'حجم تصویر باید کمتر از ۴ مگابایت باشد.',RECEIPT_NOT_AVAILABLE:'این رسید در دسترس نیست؛ دوباره آپلود کنید.',RECEIPT_ALREADY_USED:'این تصویر رسید قبلاً استفاده شده است.',TOO_MANY_PENDING_TOPUPS:'پنج درخواست شارژ شما در حال بررسی است.',RECEIPT_RATE_LIMITED:'تعداد آپلودها زیاد بود؛ کمی بعد دوباره تلاش کنید.',RECEIPT_STORAGE_BUSY:'فضای دریافت رسید موقتاً در دسترس نیست.',INVALID_TICKET:'موضوع و پیام را کامل بنویسید.',DEBT_NOT_FOUND:'این بدهی دیگر قابل اعلام پرداخت نیست.',UNAUTHORIZED:'نشست شما منقضی شده است.'}[code]||(/[\u0600-\u06ff]/.test(String(code))?String(code):'عملیات انجام نشد؛ دوباره تلاش کنید.'));

let mode='login';
let token=localStorage.getItem('nivora_customer_token')||'';
let plans=[],config={},ticketRows=[],activeTicket=null,activeIosOrder=null,currentAccount=null,loading=false,polling=false;
let volatileIosDevice='',iosExpiryTimer=null;

async function api(url,options={}){
  const response=await fetch(url,{...options,headers:{...(options.headers||{}),...(token?{authorization:`Bearer ${token}`}:{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error||'SERVER_ERROR');error.status=response.status;throw error}
  return data;
}
function toast(message,error=false){const node=$('#toast');node.textContent=message;node.classList.toggle('error-toast',error);node.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove('show'),2800)}
function setBusy(button,busy,label='در حال انجام…'){if(!button)return;button.disabled=busy;if(!button.dataset.label)button.dataset.label=button.textContent;button.textContent=busy?label:button.dataset.label}

function setMode(next){
  mode=next;
  $$('.tabs button').forEach(button=>button.classList.toggle('active',button.dataset.mode===mode));
  $('#name-label').hidden=mode!=='register';$('#name').required=mode==='register';
  $('#password').autocomplete=mode==='register'?'new-password':'current-password';
  $('#auth-error').textContent='';
}

function statusInfo(order){
  if(order.control_status==='suspended')return ['تعلیق‌شده','failed'];
  if(order.control_status==='deleted')return ['حذف‌شده','failed'];
  return ({active:['فعال',''],pending_provision:['در حال ساخت','pending'],failed:['ناموفق','failed'],expired:['منقضی','failed']}[order.subscription_status]||[order.status||'در انتظار','pending']);
}
function empty(title,detail=''){return `<article class="empty-state"><b>${esc(title)}</b>${detail?`<small>${esc(detail)}</small>`:''}</article>`}

function render(account){
  currentAccount=account;$('#auth').hidden=true;$('#dashboard').hidden=false;$('#logout').hidden=false;
  $('#customer-name').textContent=account.name;$('#profile-name').value=account.name;$('#balance').textContent=fa(account.balanceToman);
  const active=account.orders.filter(order=>order.subscription_status==='active'&&!["suspended","deleted"].includes(order.control_status)).length;
  $('#active-subscriptions').textContent=fa(active);$('#pending-topups').textContent=fa(account.topups.filter(item=>item.status==='under_review').length);$('#unread-notifications').textContent=fa(account.notifications.filter(item=>!item.read_at).length);$('#open-tickets').textContent=fa(ticketRows.filter(item=>item.status!=='closed').length);

  $('#notifications').innerHTML=account.notifications.length?account.notifications.map(item=>`<article class="${item.read_at?'':'unread'}"><span><b>${esc(item.title)}</b><small>${esc(item.body)} · ${date(item.created_at)}</small></span>${item.read_at?'':'<span class="status-pill">جدید</span>'}</article>`).join(''):empty('اعلان تازه‌ای ندارید.');

  $('#debts').innerHTML=account.debts?.length?account.debts.map(item=>`<article class="debt-row"><span><b>${esc(item.reseller_name)}</b><small>${esc(item.note)} · ${date(item.created_at)}</small></span><div><b class="debt-amount">${fa(item.amount_toman)} تومان</b><div class="debt-actions">${item.status==='open'?`<button data-debt-payment="${esc(item.id)}">پرداخت کردم</button>`:'<span class="status-pill pending">در انتظار تأیید</span>'}</div></div></article>`).join(''):empty('بدهی بازی ندارید.','تسویه‌های شما اینجا نمایش داده می‌شود.');
  $$('[data-debt-payment]').forEach(button=>button.onclick=()=>reportDebtPayment(button.dataset.debtPayment,button));

  $('#orders').innerHTML=account.orders.length?account.orders.map(order=>{const [label,state]=statusInfo(order);const remaining=Number.isFinite(Number(order.remainingDays))?` · ${fa(order.remainingDays)} روز مانده`:'';const canConnect=order.subscription_status==='active'&&order.control_status==='active';return `<article><div><h3>${esc(order.plan_name)}</h3><small>${order.order_kind==='renewal'?'تمدید':'خرید'} · ${fa(order.traffic_gb)} گیگ · ${fa(order.duration_days)} روز · ${fa(order.device_limit)} دستگاه${remaining}</small><span class="status-pill ${state}">${esc(label)}</span></div><div class="actions">${canConnect?'<span class="app-guidance">اندروید: اپ Nivora · آیفون: Hiddify</span>':''}${canConnect?`<button class="ios-connect-button" data-ios="${esc(order.id)}">اتصال آیفون</button>`:''}${order.order_kind==='purchase'&&canConnect?`<button data-renew="${esc(order.id)}">تمدید</button>`:''}</div></article>`}).join(''):empty('هنوز اشتراکی ندارید.','برای شروع یک پلن انتخاب کنید.');
  $$('[data-renew]').forEach(button=>button.onclick=()=>renew(button.dataset.renew,button));
  $$('[data-ios]').forEach(button=>button.onclick=()=>openIosImport(button.dataset.ios,button));

  const topupStatus={under_review:'در انتظار بررسی',approved:'تأیید و شارژ شد',rejected:'رد شد'};
  $('#topups').innerHTML=account.topups.length?account.topups.map(item=>`<article><span><b>${fa(item.amount_toman)} تومان</b><small>${date(item.created_at)}${item.receipt_reference?` · پیگیری ${esc(item.receipt_reference)}`:''}${item.review_note?` · ${esc(item.review_note)}`:''}</small>${item.receipt_image_url?`<a class="receipt-link" href="${safeUrl(item.receipt_image_url)}" target="_blank" rel="noopener">مشاهده رسید</a>`:''}</span><b class="${item.status==='under_review'?'pending':item.status}">${esc(topupStatus[item.status]||item.status)}</b></article>`).join(''):empty('درخواستی ثبت نشده است.');
  const transactionNames={manual_credit:'شارژ مدیریت',manual_debit:'اصلاح موجودی',purchase:'خرید اشتراک',refund:'بازگشت وجه',transfer_in:'واریز به کیف پول',transfer_out:'انتقال از کیف پول'};
  $('#transactions').innerHTML=account.transactions.length?account.transactions.map(item=>`<article><span><b>${esc(item.note||transactionNames[item.type]||item.type)}</b><small>${date(item.created_at)}</small></span><b class="${item.amount_toman>0?'positive':'negative'}">${item.amount_toman>0?'+':''}${fa(item.amount_toman)} تومان</b></article>`).join(''):empty('گردشی ثبت نشده است.');
  renderTickets();
}

function renderTickets(){
  $('#tickets').innerHTML=ticketRows.length?ticketRows.map(item=>`<button class="ticket-row" data-ticket="${esc(item.id)}"><span><b>${esc(item.subject)}</b><small>${esc(item.last_message||'بدون پیام')} · ${date(item.updated_at)}</small></span><span class="status-pill ${item.status==='closed'?'failed':item.status==='answered'?'':'pending'}">${item.status==='closed'?'بسته':item.status==='answered'?'پاسخ داده شد':'باز'}</span></button>`).join(''):empty('هنوز تیکتی ندارید.','برای گفت‌وگو با پشتیبانی، تیکت تازه بسازید.');
  $$('[data-ticket]').forEach(button=>button.onclick=()=>openConversation(button.dataset.ticket));
}

async function reportDebtPayment(id,button){
  if(!confirm('پرداخت این بدهی به همکار فروش اعلام شود؟'))return;
  setBusy(button,true,'در حال ثبت…');
  try{await api(`/api/customer/debts/${encodeURIComponent(id)}/report-payment`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});toast('اعلام پرداخت برای همکار فروش ارسال شد.');await load()}
  catch(error){toast(errorText(error.message),true)}finally{setBusy(button,false)}
}

async function renew(id,button){
  if(!confirm('هزینه پلن از کیف پول کسر و اشتراک تمدید شود؟'))return;
  setBusy(button,true,'در حال تمدید…');
  try{await api(`/api/customer/orders/${encodeURIComponent(id)}/renew`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});toast('اشتراک با موفقیت تمدید شد.');await load()}
  catch(error){toast(errorText(error.message),true)}finally{setBusy(button,false)}
}

function iosDeviceId(){
  let value='';
  try{value=localStorage.getItem('nivora_ios_device')||'';}catch{}
  if(!/^[A-Za-z0-9_-]{20,160}$/.test(value)){
    const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);
    value=`ios_${[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('')}`;
    try{localStorage.setItem('nivora_ios_device',value);}catch{volatileIosDevice=value;}
  }
  return value||volatileIosDevice;
}

function resetIosLink(message='در حال آماده‌سازی اتصال امن…'){
  clearTimeout(iosExpiryTimer);const open=$('#ios-open');open.href='#';open.classList.add('disabled');open.setAttribute('aria-disabled','true');$('#ios-status').textContent=message;
}

async function prepareIosImport(button){
  if(!activeIosOrder)return;
  resetIosLink();setBusy(button,true,'در حال ساخت…');
  try{
    const result=await api(`/api/customer/orders/${encodeURIComponent(activeIosOrder)}/ios-import`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':iosDeviceId()},body:'{}'});
    const subscription=new URL(result.subscriptionUrl,location.origin);
    if(!['http:','https:'].includes(subscription.protocol)||!/^\/ios\/import\/[A-Za-z0-9_-]+$/.test(subscription.pathname))throw new Error('SUBSCRIPTION_NOT_READY');
    const deepLink=`hiddify://import/?url=${encodeURIComponent(subscription.href)}&name=${encodeURIComponent(result.profileName||'Nivora')}`;
    const open=$('#ios-open');open.href=deepLink;open.classList.remove('disabled');open.setAttribute('aria-disabled','false');
    $('#ios-status').textContent='اتصال آماده است؛ اکنون دکمه آبی را لمس و افزودن پروفایل را در Hiddify تأیید کنید.';
    iosExpiryTimer=setTimeout(()=>resetIosLink('زمان این لینک تمام شد؛ «ساخت لینک تازه» را بزنید.'),Math.max(1,Number(result.expiresInSeconds)||120)*1000);
  }catch(error){resetIosLink(errorText(error.message));toast(errorText(error.message),true)}finally{setBusy(button,false)}
}

function openIosImport(orderId,button){
  activeIosOrder=orderId;const dialog=$('#ios-dialog');if(!dialog.open)dialog.showModal();void prepareIosImport(button);
}

function fillPlans(){
  const select=$('#plan');select.innerHTML=plans.map(plan=>`<option value="${esc(plan.id)}">${esc(plan.name)} — ${fa(plan.priceIrr)} تومان</option>`).join('');
  const show=()=>{const plan=plans.find(item=>item.id===select.value);$('#plan-info').textContent=plan?`${fa(plan.trafficGb)} گیگ · ${fa(plan.durationDays)} روز · ${fa(plan.deviceLimit)} دستگاه · ${fa(plan.priceIrr)} تومان`:''};
  select.onchange=show;show();
}
function openBuy(){if(!plans.length)return toast('پلن فعالی برای خرید وجود ندارد.',true);fillPlans();$('#discount-code').value='';$('#buy-error').textContent='';$('#buy-dialog').showModal()}

function cardMarkup(){
  const card=config.cards?.[0];
  return card?`<div class="topup-card">${esc(String(card.card_number).replace(/(.{4})/g,'$1 ').trim())}<small>${esc(card.card_holder)}${card.bank_name?` · ${esc(card.bank_name)}`:''}</small></div>`:'<p class="error">کارت پرداخت تنظیم نشده است.</p>';
}
function openTopup(){
  $('#card-info').innerHTML=cardMarkup();$('#topup-dialog').showModal();
}
async function fileData(file){
  if(!file)throw new Error('تصویر رسید را انتخاب کنید.');
  if(file.size>4*1024*1024)throw new Error('حجم تصویر باید کمتر از ۴ مگابایت باشد.');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('فرمت تصویر رسید معتبر نیست.');
  const raw=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('خواندن تصویر ممکن نشد.'));reader.readAsDataURL(file)});return raw.split(',')[1];
}

async function openConversation(id){
  activeTicket=id;const dialog=$('#conversation-dialog');$('#conversation-title').textContent='در حال دریافت گفت‌وگو…';$('#conversation-messages').innerHTML='';if(!dialog.open)dialog.showModal();
  try{const ticket=await api(`/api/customer/tickets/${encodeURIComponent(id)}`);$('#conversation-title').textContent=ticket.subject;$('#conversation-messages').innerHTML=ticket.messages.map(message=>`<article class="message ${message.sender_role==='customer'?'mine':''}"><b>${message.sender_role==='customer'?'شما':'پشتیبانی Nivora'}</b><p>${esc(message.body)}</p><small>${date(message.created_at)}</small></article>`).join('');$('#reply-form').hidden=ticket.status==='closed';$('#conversation-messages').scrollTop=$('#conversation-messages').scrollHeight}
  catch(error){$('#conversation-messages').innerHTML=empty(errorText(error.message))}
}

async function load({afterLogin=false}={}){
  if(loading)return;loading=true;
  try{
    const [account,nextPlans,nextConfig,nextTickets]=await Promise.all([api('/api/customer/me'),api('/api/plans'),api('/api/store-config'),api('/api/customer/tickets')]);
    plans=nextPlans;config=nextConfig;ticketRows=nextTickets;window.NivoraNotifications?.publish(account.notifications);render(account);
  }catch(error){
    if(error.message==='UNAUTHORIZED'){token='';localStorage.removeItem('nivora_customer_token');$('#auth').hidden=false;$('#dashboard').hidden=true;$('#logout').hidden=true}
    else toast('ارتباط موقتاً برقرار نشد.',true);
    if(afterLogin)throw error;
  }finally{loading=false}
}

async function poll(){
  if(!token||document.hidden||loading||polling)return;polling=true;
  try{const account=await api('/api/customer/me');window.NivoraNotifications?.publish(account.notifications);render(account)}
  catch(error){if(error.message==='UNAUTHORIZED'){token='';localStorage.removeItem('nivora_customer_token');$('#auth').hidden=false;$('#dashboard').hidden=true;$('#logout').hidden=true}}
  finally{polling=false}
}

$$('.tabs button').forEach(button=>button.onclick=()=>setMode(button.dataset.mode));
$('#auth-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter||event.currentTarget.querySelector('[type="submit"]');setBusy(button,true,'در حال ورود…');$('#auth-error').textContent='';try{const data=await api(`/api/customer/${mode}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:$('#name').value.trim(),phone:$('#phone').value.trim(),password:$('#password').value})});token=data.token;localStorage.setItem('nivora_customer_token',token);void window.NivoraNotifications?.enable();await load({afterLogin:true})}catch(error){$('#auth-error').textContent=errorText(error.message)}finally{setBusy(button,false)}};
$('#buy-plan').onclick=openBuy;$$('[data-action="buy"]').forEach(button=>button.onclick=openBuy);
$('#validate-discount').onclick=async()=>{try{const data=await api('/api/customer/discount/validate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:$('#discount-code').value.trim()})});toast(`کد معتبر است: ${fa(data.percent)} درصد تخفیف`)}catch(error){toast(errorText(error.message),true)}};
$('#buy-form').onsubmit=async event=>{event.preventDefault();if(!confirm('خرید از کیف پول نهایی شود؟'))return;const button=event.submitter;setBusy(button,true,'در حال ساخت…');$('#buy-error').textContent='';try{const result=await api('/api/customer/wallet/purchase',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({planId:$('#plan').value,discountCode:$('#discount-code').value.trim()})});toast(result.discountToman?`${fa(result.discountToman)} تومان تخفیف اعمال شد.`:'اشتراک ساخته شد.');$('#buy-dialog').close();await load()}catch(error){$('#buy-error').textContent=errorText(error.message)}finally{setBusy(button,false)}};
$('#topup').onclick=openTopup;$$('[data-action="topup"]').forEach(button=>button.onclick=openTopup);
$('#topup-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;setBusy(button,true,'در حال ارسال…');try{const file=$('#topup-file').files[0],data=await fileData(file),receipt=await api('/api/receipts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mimeType:file.type,data})});await api('/api/customer/wallet/topups',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amountToman:Number($('#topup-amount').value),receiptReference:$('#topup-reference').value.trim(),receiptImageUrl:receipt.url})});event.target.reset();$('#topup-dialog').close();toast('درخواست شارژ ثبت شد.');await load()}catch(error){toast(errorText(error.message),true)}finally{setBusy(button,false)}};
$('#read-notifications').onclick=async()=>{try{await api('/api/customer/notifications/read',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});currentAccount.notifications.forEach(item=>item.read_at=item.read_at||new Date().toISOString());render(currentAccount);toast('اعلان‌ها خوانده شد.')}catch(error){toast(errorText(error.message),true)}};
$('#profile-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter,name=$('#profile-name').value.trim();setBusy(button,true,'در حال ذخیره…');try{await api('/api/customer/profile',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name})});currentAccount.name=name;render(currentAccount);toast('نام حساب با موفقیت تغییر کرد.')}catch(error){toast(error.message==='INVALID_NAME'?'نام باید بین ۳ تا ۸۰ کاراکتر باشد.':errorText(error.message),true)}finally{setBusy(button,false)}};
$('#new-ticket').onclick=()=>{$('#ticket-form').reset();$('#ticket-dialog').showModal()};
$('#ticket-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;setBusy(button,true,'در حال ارسال…');try{await api('/api/customer/tickets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subject:$('#ticket-subject').value.trim(),body:$('#ticket-body').value.trim()})});event.target.reset();$('#ticket-dialog').close();toast('تیکت ارسال شد.');await load()}catch(error){toast(errorText(error.message),true)}finally{setBusy(button,false)}};
$('#reply-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;setBusy(button,true,'در حال ارسال…');try{await api(`/api/customer/tickets/${encodeURIComponent(activeTicket)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:$('#reply-body').value.trim()})});$('#reply-body').value='';await openConversation(activeTicket);const next=await api('/api/customer/tickets');ticketRows=next;renderTickets();toast('پاسخ ارسال شد.')}catch(error){toast(errorText(error.message),true)}finally{setBusy(button,false)}};
$('#ios-open').onclick=event=>{if(event.currentTarget.getAttribute('aria-disabled')==='true')event.preventDefault()};
$('#ios-regenerate').onclick=event=>void prepareIosImport(event.currentTarget);
$$('dialog .close').forEach(button=>button.onclick=()=>button.closest('dialog').close());
$('#logout').onclick=()=>{localStorage.removeItem('nivora_customer_token');location.reload()};
if(token)load();setInterval(poll,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll()});
