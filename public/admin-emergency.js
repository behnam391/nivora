(()=>{
  const $=selector=>document.querySelector(selector);
  const fa=value=>Number(value||0).toLocaleString('fa-IR');
  let loaded=false;

  function message(code){
    return ({
      INVALID_EMERGENCY_SOURCE:'یکی از لینک‌ها معتبر نیست؛ فقط لینک مستقیم GitHub Raw پذیرفته می‌شود.',
      EMERGENCY_SOURCE_UNAVAILABLE:'منبع عمومی در دسترس نبود؛ فهرست پالایش‌شده قبلی حفظ شد.',
      EMERGENCY_SOURCE_DNS_FAILED:'نشانی منبع به مقصد عمومی و امنی متصل نشد.',
      EMERGENCY_SOURCE_TIMEOUT:'دریافت منبع بیش از حد طول کشید.',
      EMERGENCY_SOURCE_TOO_LARGE:'حجم منبع بیشتر از حد مجاز است.',
      EMERGENCY_REFRESH_BACKOFF:'پس از خطای منبع، نوسازی خودکار کمی مکث کرده است؛ دریافت دستی را دوباره بزنید.',
      EMERGENCY_POOL_EMPTY:'هیچ مسیر ایمنی از این منابع باقی نماند.'
    })[code]||'عملیات اتصال اضطراری انجام نشد.';
  }

  function render(status){
    $('#emergency-enabled').checked=Boolean(status.enabled);
    $('#emergency-sources').value=(status.sources||[]).join('\n');
    $('#emergency-max-nodes').value=status.maxNodes||8;
    $('#emergency-refresh-minutes').value=status.refreshMinutes||30;
    const badge=$('#emergency-status');
    badge.className=`status ${status.ready?'approved':'awaiting_receipt'}`;
    badge.textContent=status.ready?'آماده':status.enabled?'نیازمند نوسازی':'غیرفعال';
    const summary=$('#emergency-summary');
    if(status.nodeCount>0){
      const updated=status.updatedAt?new Date(status.updatedAt).toLocaleString('fa-IR'):'—';
      summary.innerHTML=`<b>${fa(status.nodeCount)} مسیر آماده آزمایش در اپ</b><span>${fa(status.accepted)} مسیر پس از پالایش پذیرفته شد · ${fa(status.rejected)} مورد ناامن یا نامعتبر حذف شد · آخرین نوسازی: ${updated}</span>`;
    }else summary.innerHTML='<b>هنوز فهرست پالایش‌شده‌ای آماده نشده است.</b><span>تنظیمات را ذخیره و «دریافت و پالایش اکنون» را اجرا کنید.</span>';
    $('#emergency-result').textContent=status.lastError?message(status.lastError):'';
  }

  async function load(){
    try{render(await api('/api/admin/emergency-settings'));loaded=true;}
    catch(error){$('#emergency-result').textContent=message(error.code||error.message);}
  }

  const original=window.showView;
  window.showView=id=>{original(id);if(id==='emergency')load();};

  $('#emergency-form').onsubmit=async event=>{
    event.preventDefault();
    const button=event.submitter||$('#emergency-form button[type=submit]');
    button.disabled=true;$('#emergency-result').textContent='در حال ذخیره…';
    try{
      const status=await api('/api/admin/emergency-settings',{method:'PATCH',body:JSON.stringify({
        enabled:$('#emergency-enabled').checked,
        sources:$('#emergency-sources').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean),
        maxNodes:Number($('#emergency-max-nodes').value),
        refreshMinutes:Number($('#emergency-refresh-minutes').value)
      })});
      render(status);toast('تنظیمات اتصال اضطراری ذخیره شد');
    }catch(error){$('#emergency-result').textContent=message(error.code||error.message);}
    finally{button.disabled=false;}
  };

  $('#emergency-refresh').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;$('#emergency-result').textContent='در حال دریافت، پالایش و بررسی مسیرها…';
    try{const status=await api('/api/admin/emergency-settings/refresh',{method:'POST',body:'{}'});render(status);toast(`${fa(status.nodeCount)} مسیر برای آزمایش داخل اپ آماده شد`);}
    catch(error){$('#emergency-result').textContent=message(error.code||error.message);}
    finally{button.disabled=false;}
  };

  if(!loaded&&location.hash==='#emergency')load();
})();
