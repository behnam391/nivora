(()=>{
  const q=selector=>document.querySelector(selector);
  let loaded=false;

  async function copyText(value,label){
    try{
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(value);
      else{const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove()}
      toast(label);
    }catch{toast('کپی خودکار انجام نشد')}
  }

  const formBody=()=>({
    enabled:q('#httpsms-enabled').checked,
    expectedOwner:q('#httpsms-owner').value.trim(),
    expectedSim:q('#httpsms-sim').value,
    expectedSubject:q('#httpsms-subject').value.trim(),
    allowedSenders:q('#httpsms-senders').value.split(/\r?\n|,/).map(value=>value.trim()).filter(Boolean),
    autoReviewEnabled:q('#httpsms-auto-review').checked,
    amountToleranceRial:0,
    lookbackHours:Number(q('#httpsms-lookback').value)
  });

  function render(data){
    q('#httpsms-enabled').checked=Boolean(data.enabled);
    q('#httpsms-owner').value=data.expectedOwner||'';
    q('#httpsms-sim').value=data.expectedSim||'';
    q('#httpsms-subject').value=data.expectedSubject||'';
    q('#httpsms-senders').value=(data.allowedSenders||[]).join('\n');
    q('#httpsms-auto-review').checked=Boolean(data.autoReviewEnabled);
    q('#httpsms-lookback').value=Number(data.lookbackHours)||2;
    q('#httpsms-webhook-url').value=data.webhookUrl||'';
    q('#httpsms-key-hint').textContent=data.signingKeyConfigured?`کلید امضا تنظیم شده است (${data.signingKeyHint}). مقدار کامل برای امنیت نمایش داده نمی‌شود.`:'هنوز کلید امضا ساخته نشده است.';
    const ready=data.enabled&&data.signingKeyConfigured&&data.expectedOwner&&(data.allowedSenders||[]).length;
    q('#httpsms-status').className=`status ${ready?'approved':'awaiting_receipt'}`;
    q('#httpsms-status').textContent=ready?'فعال و آماده':'غیرفعال / ناقص';
    const counts=data.counters||{};
    q('#httpsms-stats').innerHTML=`<article><span>کل رویدادها</span><strong>${fa(counts.total)}</strong></article><article><span>تطبیق‌شده</span><strong>${fa(counts.matched)}</strong></article><article><span>نیازمند بررسی</span><strong>${fa(counts.unmatched)}</strong></article><article><span>نادیده‌گرفته‌شده</span><strong>${fa(counts.ignored)}</strong></article>`;
    const latest=data.latest;
    q('#httpsms-latest').className=latest?'event-summary':'empty';
    q('#httpsms-latest').innerHTML=latest?`<span>زمان دریافت<b>${date(latest.received_at||latest.created_at)}</b></span><span>وضعیت<b>${esc(latest.status||'—')}</b></span><span>نوع تراکنش<b>${latest.direction==='credit'?'واریز':latest.direction==='debit'?'برداشت':'نامشخص'}</b></span><span>مبلغ ثبت‌شده<b>${latest.amount_rial?`${fa(latest.amount_rial)} ریال`:'نامشخص'}</b></span><span>منبع<b>httpSMS</b></span><span>آخرین ارتباط<b>${data.lastEventAt?date(data.lastEventAt):'—'}</b></span>`:'هنوز رویدادی از httpSMS دریافت نشده است.';
  }

  async function load(){
    const data=await api('/api/admin/httpsms-settings');
    render(data);loaded=true;
  }

  async function save(event){
    event.preventDefault();
    const button=event.submitter;button.disabled=true;q('#httpsms-result').textContent='';
    try{await api('/api/admin/httpsms-settings',{method:'PATCH',body:JSON.stringify(formBody())});toast('تنظیمات پیامک بانکی ذخیره شد');q('#httpsms-result').textContent='تنظیمات با موفقیت ذخیره شد.';await load()}
    catch(error){q('#httpsms-result').textContent=error.code==='HTTPSMS_SIGNING_KEY_REQUIRED'?'ابتدا کلید امضا بسازید.':error.code==='HTTPSMS_SOURCE_RESTRICTIONS_REQUIRED'?'برای فعال‌سازی، شماره مالک و حداقل یک فرستنده بانک لازم است.':'ذخیره تنظیمات انجام نشد.'}
    finally{button.disabled=false}
  }

  q('#httpsms-form').onsubmit=save;
  q('#httpsms-copy-webhook').onclick=()=>copyText(q('#httpsms-webhook-url').value,'نشانی وبهوک کپی شد');
  q('#httpsms-copy-key').onclick=()=>copyText(q('#httpsms-generated-key').value,'کلید امضا کپی شد');
  q('#httpsms-rotate-key').onclick=async()=>{
    const confirmed=await adminConfirm({title:'ساخت یا تعویض کلید امضا',message:'اگر قبلاً وبهوک httpSMS را متصل کرده‌اید، پس از تعویض باید کلید جدید را همان‌جا نیز ثبت کنید. کلید فقط یک‌بار نمایش داده می‌شود.',confirmText:'ساخت کلید جدید',danger:Boolean(q('#httpsms-key-hint').textContent.includes('تنظیم شده'))});
    if(!confirmed)return;
    const button=q('#httpsms-rotate-key');button.disabled=true;
    try{
      const result=await api('/api/admin/httpsms-settings',{method:'PATCH',body:JSON.stringify({rotateSigningKey:true})});
      q('#httpsms-generated-key').value=result.generatedSigningKey||'';q('#httpsms-generated').classList.remove('hidden');
      toast('کلید جدید ساخته شد؛ همین حالا آن را کپی کنید');await load();
    }catch{q('#httpsms-result').textContent='ساخت کلید انجام نشد.'}
    finally{button.disabled=false}
  };

  const original=window.showView;
  window.showView=id=>{original(id);if(id==='httpsms'&&!loaded)load().catch(()=>{q('#httpsms-result').textContent='دریافت وضعیت انجام نشد.'})};
})();
