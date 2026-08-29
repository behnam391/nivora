(()=>{
  let discounts=[],tickets=[];

  function mount(){
    document.querySelector('nav').insertAdjacentHTML('beforeend','<button class="nav" id="discounts-nav">تخفیف‌ها</button><button class="nav" id="tickets-nav">پشتیبانی</button>');
    document.querySelector('main').insertAdjacentHTML('beforeend',`
      <section id="discounts" class="view hidden">
        <div class="panel-head standalone"><div><h2>کدهای تخفیف</h2><p>ساخت کد و مشاهده تعداد مصرف و مبلغ تخفیف</p></div><button id="new-discount" class="primary">+ کد جدید</button></div>
        <div id="discount-grid" class="reseller-grid"></div>
      </section>
      <section id="support" class="view hidden">
        <div class="panel-head standalone"><div><h2>تیکت‌های پشتیبانی</h2><p>گفت‌وگو با مشتریان و بستن درخواست</p></div></div>
        <div id="ticket-list" class="topup-list"></div>
      </section>`);
    document.body.insertAdjacentHTML('beforeend',`
      <dialog id="discount-dialog"><form id="discount-form">
        <div class="modal-head"><div><p class="eyebrow">DISCOUNT CODE</p><h2>کد تخفیف جدید</h2></div><button type="button" class="icon close-growth">×</button></div>
        <div class="form-grid">
          <label>کد<input id="discount-manage-code" dir="ltr" pattern="[A-Za-z0-9_-]{3,30}" required></label>
          <label>درصد<input id="discount-percent" type="number" min="1" max="100" required></label>
          <label>حداکثر مصرف (صفر نامحدود)<input id="discount-max" type="number" min="0" value="0"></label>
          <label>سقف هر مشتری<input id="discount-limit" type="number" min="1" value="1"></label>
          <label>تاریخ انقضا<input id="discount-expiry" type="datetime-local"></label>
        </div>
        <div class="modal-actions"><button type="button" class="ghost close-growth">انصراف</button><button class="primary">ساخت کد</button></div>
      </form></dialog>`);
    $('#discounts-nav').onclick=openDiscounts;
    $('#tickets-nav').onclick=openTickets;
    $('#new-discount').onclick=()=>$('#discount-dialog').showModal();
    document.querySelectorAll('.close-growth').forEach(button=>button.onclick=()=>$('#discount-dialog').close());
    $('#discount-form').onsubmit=createDiscount;
  }

  function activate(sectionId,navId,title){
    document.querySelectorAll('.view').forEach(view=>view.classList.add('hidden'));
    document.querySelectorAll('.nav').forEach(nav=>nav.classList.remove('active'));
    $(`#${sectionId}`).classList.remove('hidden');
    $(`#${navId}`).classList.add('active');
    $('#page-title').textContent=title;
  }

  async function openDiscounts(){
    activate('discounts','discounts-nav','مدیریت تخفیف‌ها');
    discounts=await api('/api/admin/discounts');
    $('#discount-grid').innerHTML=discounts.length?discounts.map(discount=>`
      <article class="reseller-card">
        <div class="reseller-person"><h3 dir="ltr">${esc(discount.code)}</h3><span class="status ${discount.active?'approved':'rejected'}">${discount.active?'فعال':'غیرفعال'}</span></div>
        <div class="wallet-balance"><small>میزان تخفیف</small><b>${fa(discount.percent)}٪</b></div>
        <p>مصرف: ${fa(discount.used_count)} ${discount.max_uses?`از ${fa(discount.max_uses)}`:'بار'}<br>تخفیف داده‌شده: ${fa(discount.total_discount_toman)} تومان</p>
        <button class="${discount.active?'danger':'primary'} toggle-discount" data-id="${esc(discount.id)}">${discount.active?'غیرفعال‌کردن':'فعال‌کردن'}</button>
      </article>`).join(''):'<div class="empty">کدی ساخته نشده است.</div>';
    document.querySelectorAll('.toggle-discount').forEach(button=>button.onclick=()=>toggleDiscount(button.dataset.id));
  }

  async function createDiscount(event){
    event.preventDefault();
    await api('/api/admin/discounts',{method:'POST',body:JSON.stringify({
      code:$('#discount-manage-code').value,
      percent:Number($('#discount-percent').value),
      maxUses:Number($('#discount-max').value),
      perCustomerLimit:Number($('#discount-limit').value),
      expiresAt:$('#discount-expiry').value?new Date($('#discount-expiry').value).toISOString():null
    })});
    event.target.reset();
    $('#discount-dialog').close();
    toast('کد تخفیف ساخته شد');
    await openDiscounts();
  }

  async function toggleDiscount(id){
    const discount=discounts.find(item=>item.id===id);
    if(!discount)return;
    await api(`/api/admin/discounts/${id}`,{method:'PATCH',body:JSON.stringify({active:!discount.active})});
    toast(discount.active?'کد تخفیف غیرفعال شد':'کد تخفیف فعال شد');
    await openDiscounts();
  }

  async function openTickets(){
    activate('support','tickets-nav','پشتیبانی مشتریان');
    tickets=await api('/api/admin/tickets');
    const labels={open:'باز',answered:'پاسخ داده‌شده',closed:'بسته'};
    $('#ticket-list').innerHTML=tickets.length?tickets.map(ticket=>`
      <article class="topup-row">
        <div><b>${esc(ticket.subject)}</b><small>${esc(ticket.customer_name)} · ${esc(ticket.phone)}</small></div>
        <div>${esc(ticket.last_message||'بدون پیام')}</div>
        <div><span class="status ${ticket.status==='closed'?'rejected':ticket.status==='answered'?'approved':'under_review'}">${esc(labels[ticket.status]||ticket.status)}</span></div>
        <div class="topup-actions"><button class="ghost ai-reply-ticket" data-id="${esc(ticket.id)}">پیشنهاد AI</button><button class="primary reply-ticket" data-id="${esc(ticket.id)}">پاسخ</button>${ticket.status!=='closed'?`<button class="danger close-ticket" data-id="${esc(ticket.id)}">بستن</button>`:''}</div>
      </article>`).join(''):'<div class="empty">تیکتی وجود ندارد.</div>';
    document.querySelectorAll('.reply-ticket').forEach(button=>button.onclick=()=>reply(button.dataset.id));
    document.querySelectorAll('.ai-reply-ticket').forEach(button=>button.onclick=()=>aiReply(button.dataset.id,button));
    document.querySelectorAll('.close-ticket').forEach(button=>button.onclick=()=>closeTicket(button.dataset.id));
  }

  async function reply(id){
    const detail=await api(`/api/admin/tickets/${id}`);
    const messages=Array.isArray(detail.messages)?detail.messages:[];
    const history=messages.map(message=>`${message.sender_role==='admin'?'مدیر':'مشتری'}: ${message.body}`).join('\n\n');
    const body=await adminPrompt({title:'پاسخ به تیکت',message:history,label:'پاسخ جدید',multiline:true,required:true,minLength:2,confirmText:'ارسال پاسخ'});
    if(!body)return;
    await api(`/api/admin/tickets/${id}`,{method:'POST',body:JSON.stringify({body})});
    toast('پاسخ ارسال شد');
    await openTickets();
  }

  async function aiReply(id,button){
    const label=button.textContent;button.disabled=true;button.textContent='در حال نوشتن…';
    try{
      const result=await api('/api/admin/ai/draft-ticket',{method:'POST',body:JSON.stringify({ticketId:id})});
      const body=await adminPrompt({title:'پیشنهاد هوش مصنوعی',message:'متن زیر پیش‌نویس است؛ قبل از ارسال آن را بررسی و در صورت نیاز ویرایش کنید.',label:'پاسخ پیشنهادی',value:result.draft,multiline:true,required:true,minLength:2,confirmText:'تأیید و ارسال'});
      if(!body)return;
      await api(`/api/admin/tickets/${id}`,{method:'POST',body:JSON.stringify({body})});toast('پاسخ تأییدشده ارسال شد');await openTickets();
    }catch(error){const messages={AI_NOT_CONFIGURED:'ابتدا هوش مصنوعی را در تنظیمات فعال کنید.',AI_RATE_LIMITED:'سقف موقت سرویس رایگان پر شده؛ کمی بعد دوباره امتحان کنید.',AI_PROVIDER_ERROR:'سرویس آزمایشی هتزنر پاسخ نداد.'};toast(messages[error.message]||'ساخت پاسخ پیشنهادی انجام نشد',true)}finally{button.disabled=false;button.textContent=label}
  }

  async function closeTicket(id){
    if(!await adminConfirm({title:'بستن تیکت',message:'پس از بستن، این گفت‌وگو برای پاسخ جدید غیرفعال می‌شود.',confirmText:'بستن تیکت',danger:true}))return;
    await api(`/api/admin/tickets/${id}`,{method:'POST',body:JSON.stringify({close:true})});
    toast('تیکت بسته شد');
    await openTickets();
  }

  document.addEventListener('DOMContentLoaded',mount);
})();
