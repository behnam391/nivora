const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const fa=value=>new Intl.NumberFormat('fa-IR').format(Number(value)||0);
const esc=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const statusText={under_review:'در انتظار بررسی رسید',approved:'پرداخت تأیید شد',rejected:'پرداخت رد شد',awaiting_receipt:'منتظر ارسال رسید'};
const subscriptionText={active:'فعال و آماده اتصال',pending_provision:'در حال ساخت اشتراک',failed:'ساخت اشتراک ناموفق بود',expired:'اعتبار اشتراک تمام شده است'};
const errorText=code=>({INVALID_ORDER:'اطلاعات سفارش کامل نیست.',ORDER_NOT_FOUND:'سفارشی با این کد پیدا نشد.',SUBSCRIPTION_NOT_FOUND:'این اشتراک برای تمدید در دسترس نیست.',RECEIPT_REQUIRED:'تصویر یا شماره پیگیری رسید لازم است.',INVALID_RECEIPT:'فرمت تصویر رسید معتبر نیست.',PAYMENT_CARD_MISSING:'کارت پرداخت هنوز تنظیم نشده است.'}[code]||code||'ارتباط با سرویس برقرار نشد.');

let plans=[],config={},selected=null,selectedCard=null,renewParent=null;

function spaced(value){return String(value??'').replace(/(.{4})/g,'$1 ').trim()}
function toast(message,error=false){const node=$('#toast');node.textContent=message;node.classList.toggle('error',error);node.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove('show'),2400)}
async function copyText(value,label='کپی شد'){
  try{
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(String(value));
    else{const area=document.createElement('textarea');area.value=String(value);area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove()}
    toast(label);
  }catch{toast('کپی خودکار ممکن نشد.',true)}
}
async function json(url,options={}){
  const response=await fetch(url,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(errorText(data.error));
  return data;
}

async function boot(){
  try{
    [plans,config]=await Promise.all([json('/api/plans'),json('/api/store-config')]);
    renderPlans();renderPlanLocations();renderPaymentCards();initWizard();
    $('#support').textContent=config.supportId||'از داخل حساب کاربری';
  }catch(error){
    $('#plans-list').innerHTML=`<div class="loading">${esc(error.message||'دریافت پلن‌ها ممکن نشد.')}</div>`;
  }
}

function renderPlans(){
  $('#plans-list').innerHTML=plans.length?plans.map((plan,index)=>`<article class="plan"><span class="tag">${index===1?'پیشنهاد محبوب':'اشتراک Nivora'}</span><h3>${esc(plan.name)}</h3><p class="desc">${esc(plan.description||'اتصال سریع و پایدار')}</p><div class="price">${fa(plan.priceIrr)} <small>تومان</small></div><ul class="features"><li>${fa(plan.trafficGb)} گیگابایت حجم</li><li>${fa(plan.durationDays)} روز اعتبار</li><li>${fa(plan.deviceLimit)} دستگاه</li></ul><button class="cta buy" data-id="${esc(plan.id)}">انتخاب پلن</button></article>`).join(''):'<div class="loading">در حال حاضر پلن فعالی وجود ندارد.</div>';
  $$('.buy').forEach(button=>button.onclick=()=>{renewParent=null;openBuy(button.dataset.id)});
}

function renderPlanLocations(){
  $$('#plans-list .plan').forEach((card,index)=>{
    const names=(plans[index]?.locations||[]).map(location=>location.name).filter(Boolean).join('، ');
    if(names)card.querySelector('h3').insertAdjacentHTML('beforebegin',`<span class="tag">⌖ ${esc(names)}</span>`);
  });
}

function renderPaymentCards(){
  const box=$('.card-box'),cards=config.cards||[];
  selectedCard=cards[0]||null;
  box.className='payment-card-host';
  if(!cards.length){box.innerHTML='<div class="payment-unavailable"><b>کارت پرداخت تنظیم نشده است</b><small>برای خرید با پشتیبانی Nivora تماس بگیرید.</small></div>';return}
  const cardMarkup=card=>`<div class="visual-card"><header><b>${esc(card.bank_name||'کارت بانکی')}</b><span>Nivora</span></header><div class="card-chip"></div><div class="visual-number"><bdi dir="ltr">${esc(spaced(card.card_number))}</bdi></div><footer><div class="holder"><small>صاحب کارت</small><b>${esc(card.card_holder)}</b></div><button type="button" class="copy-card">کپی شماره کارت</button></footer></div>`;
  box.innerHTML=`<label class="bank-picker">انتخاب کارت<select id="card-select">${cards.map(card=>`<option value="${esc(card.id)}">${esc(card.bank_name||'کارت')} — ${esc(card.card_holder)}</option>`).join('')}</select></label><div id="visual-card-wrap">${cardMarkup(selectedCard)}</div>`;
  const bindCopy=()=>{$('.copy-card').onclick=()=>copyText(selectedCard.card_number,'شماره کارت کپی شد')};
  bindCopy();
  $('#card-select').onchange=event=>{selectedCard=cards.find(card=>card.id===event.target.value)||cards[0];$('#visual-card-wrap').innerHTML=cardMarkup(selectedCard);bindCopy()};
}

function initWizard(){
  const form=$('#buy-form'),head=form.querySelector('.modal-head'),submit=$('#submit-buy');
  const cardBox=$('.payment-card-host');
  if(!cardBox||$('.purchase-stepper'))return;
  cardBox.id='payment-card-step';
  head.insertAdjacentHTML('afterend','<div class="purchase-stepper"><span data-step="1">۱. انتخاب و پرداخت</span><span data-step="2">۲. اطلاعات و رسید</span></div>');
  cardBox.insertAdjacentHTML('afterend','<button type="button" id="next-step" class="cta full next-step">ادامه و ارسال رسید</button>');
  submit.insertAdjacentHTML('beforebegin','<div id="wizard-actions" class="wizard-actions"><button type="button" id="back-step" class="back-step">بازگشت</button></div>');
  $('#wizard-actions').appendChild(submit);
  $('#next-step').onclick=()=>selectedCard?setBuyStep(2):toast('کارت پرداخت هنوز تنظیم نشده است.',true);
  $('#back-step').onclick=()=>setBuyStep(1);
  setBuyStep(1);
}

function setBuyStep(step){
  const first=step===1;
  $('#payment-card-step')?.classList.toggle('wizard-hidden',!first);
  $('#next-step')?.classList.toggle('wizard-hidden',!first);
  $('#buy-form .form-grid').classList.toggle('wizard-hidden',first);
  $('#submit-buy').classList.toggle('wizard-hidden',first);
  $('#back-step')?.classList.toggle('wizard-hidden',first);
  $$('.purchase-stepper span').forEach(item=>item.classList.toggle('active',Number(item.dataset.step)===step));
}

function openBuy(id){
  selected=plans.find(plan=>plan.id===id);
  if(!selected)return toast('این پلن دیگر در دسترس نیست.',true);
  $('#buy-title').textContent=renewParent?`تمدید ${selected.name}`:selected.name;
  $('#selected-plan').textContent=`${fa(selected.trafficGb)} گیگ · ${fa(selected.durationDays)} روز · ${fa(selected.deviceLimit)} دستگاه`;
  $('#amount').value=selected.priceIrr;
  if(renewParent){$('#customer-name').value=renewParent.customerName||'';$('#phone').value=renewParent.phone||''}
  $('#buy-error').textContent='';setBuyStep(1);$('#buy-dialog').showModal();
}

async function fileData(file){
  if(!file)throw new Error('تصویر رسید را انتخاب کنید.');
  if(file.size>4*1024*1024)throw new Error('حجم تصویر بیشتر از ۴ مگابایت است.');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('فرمت تصویر رسید معتبر نیست.');
  const raw=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('خواندن تصویر ممکن نشد.'));reader.readAsDataURL(file)});
  return raw.split(',')[1];
}

$('#buy-form').onsubmit=async event=>{
  event.preventDefault();
  const button=$('#submit-buy');button.disabled=true;button.textContent='در حال ثبت…';$('#buy-error').textContent='';
  try{
    if(!selectedCard)throw new Error('کارت پرداخت هنوز تنظیم نشده است.');
    const file=$('#receipt-file').files[0],data=await fileData(file);
    const receipt=await json('/api/receipts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mimeType:file.type,data})});
    const payload={customerName:$('#customer-name').value.trim(),phone:$('#phone').value.trim(),planId:selected.id,amountTransferredIrr:Number($('#amount').value),receiptReference:$('#receipt-ref').value.trim(),receiptImageUrl:receipt.url};
    const endpoint=renewParent?`/api/orders/${encodeURIComponent(renewParent.id)}/renew?token=${encodeURIComponent(renewParent.token)}`:'/api/orders';
    const order=await json(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    localStorage.setItem('nivora_last_order',JSON.stringify({id:order.id,token:order.trackingToken}));
    renewParent=null;$('#buy-dialog').close();$('#tracking-value').textContent=`${order.id}.${order.trackingToken}`;$('#success-dialog').showModal();event.target.reset();
  }catch(error){$('#buy-error').textContent=error.message}
  finally{button.disabled=false;button.textContent='ثبت سفارش و ارسال رسید'}
};

async function track(code){
  const [id,token]=String(code).trim().split('.');
  if(!id||!token)throw new Error('کد پیگیری معتبر نیست.');
  const order=await json(`/api/orders/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`);
  const subscription=order.subscription_status==='active'?'<div class="app-open-note"><b>اشتراک آماده اتصال است</b><small>برای اتصال امن، حساب خود را در اپ Nivora تازه‌سازی کنید.</small></div>':'';
  const renewal=order.order_kind==='purchase'&&order.subscription_status==='active'?'<button type="button" id="renew-subscription" class="cta renew-subscription">تمدید همین اشتراک</button>':'';
  const state=order.subscription_status?subscriptionText[order.subscription_status]||order.subscription_status:statusText[order.status]||order.status;
  $('#track-result').innerHTML=`<div class="track-card"><b>${esc(order.plan_name)}</b><br><small>${fa(order.traffic_gb)} گیگ · ${fa(order.duration_days)} روز · ${fa(order.device_limit)} دستگاه</small><br>وضعیت: ${esc(state)}${order.review_note?`<br>یادداشت: ${esc(order.review_note)}`:''}${subscription}${renewal}</div>`;
  if(renewal)$('#renew-subscription').onclick=()=>{renewParent={id:order.id,token,customerName:order.customer_name,phone:order.phone};$('#track-dialog').close();openBuy(order.plan_id)};
}

$('#track-form').onsubmit=async event=>{event.preventDefault();try{await track($('#tracking-code').value)}catch(error){$('#track-result').innerHTML=`<p class="error">${esc(error.message)}</p>`}};
$('#track-open').onclick=()=>{let last=null;try{last=JSON.parse(localStorage.getItem('nivora_last_order')||'null')}catch{localStorage.removeItem('nivora_last_order')}$('#tracking-code').value=last?.id&&last?.token?`${last.id}.${last.token}`:'';$('#track-result').innerHTML='';$('#track-dialog').showModal()};
$('#tracking-value').onclick=event=>copyText(event.currentTarget.textContent,'کد پیگیری کپی شد');
$('#success-done').onclick=()=>$('#success-dialog').close();
$('.close').onclick=()=>$('#buy-dialog').close();
$('.close-track').onclick=()=>$('#track-dialog').close();
boot();
