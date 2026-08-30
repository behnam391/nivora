(()=>{
  const $=selector=>document.querySelector(selector);
  document.querySelector('#ai')?.insertAdjacentHTML('beforeend','<section class="panel telegram-settings"><h3>مشاور هوشمند فروش</h3><p class="muted">تحلیل آمار تجمیعی ۳۰ روزه بدون اطلاعات شخصی مشتریان.</p><button id="ai-sales" class="ghost" type="button">پیشنهادهای فروش امروز</button><pre id="ai-sales-result" class="ai-summary-result"></pre></section>');
  function setStatus(config){
    const status=$('#ai-status');
    status.className=`status ${config.enabled&&config.tokenConfigured?'approved':'awaiting_receipt'}`;
    status.textContent=config.enabled&&config.tokenConfigured?'فعال':config.tokenConfigured?'آماده فعال‌سازی':'تنظیم نشده';
  }
  function fillModels(models,selected){
    const select=$('#ai-model'),values=[...new Set([...(models||[]),selected].filter(Boolean))];
    select.replaceChildren(...values.map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;return option}));
    if(selected)select.value=selected;
  }
  async function load(){
    const config=await api('/api/admin/ai-settings');
    $('#ai-enabled').checked=config.enabled;$('#ai-token').value='';fillModels([],config.model);setStatus(config);
    $('#ai-token-hint').textContent=config.tokenConfigured?`توکن فعلی محفوظ است (${config.tokenHint})؛ برای حفظ آن کادر را خالی بگذارید.`:'هنوز توکنی ذخیره نشده است.';
  }
  const original=window.showView;
  window.showView=id=>{original(id);if(id==='ai')load().catch(error=>{$('#ai-result').textContent=error.message})};
  $('#ai-form').onsubmit=async event=>{
    event.preventDefault();const body={enabled:$('#ai-enabled').checked,model:$('#ai-model').value};if($('#ai-token').value.trim())body.token=$('#ai-token').value.trim();
    try{await api('/api/admin/ai-settings',{method:'PATCH',body:JSON.stringify(body)});$('#ai-result').textContent='تنظیمات با موفقیت و به‌صورت رمزگذاری‌شده ذخیره شد.';toast('تنظیمات هوش مصنوعی ذخیره شد');await load()}catch(error){$('#ai-result').textContent=error.message==='AI_TOKEN_REQUIRED'?'ابتدا توکن را وارد کنید.':error.message==='INVALID_AI_TOKEN'?'ساختار توکن معتبر نیست.':'ذخیره تنظیمات انجام نشد.'}
  };
  $('#ai-test').onclick=async()=>{
    const button=$('#ai-test'),label=button.textContent;button.disabled=true;button.textContent='در حال اتصال…';$('#ai-result').textContent='';
    try{const result=await api('/api/admin/ai-settings/test',{method:'POST',body:'{}'});fillModels(result.models,result.models.includes($('#ai-model').value)?$('#ai-model').value:result.models[0]);$('#ai-result').textContent=result.models.length?`اتصال موفق بود؛ ${fa(result.models.length)} مدل فعال دریافت شد.`:'اتصال برقرار شد، اما هتزنر مدلی برنگرداند.';$('#ai-status').className='status approved';$('#ai-status').textContent='متصل'}catch(error){const messages={AI_TOKEN_REQUIRED:'ابتدا توکن را ذخیره کنید.',INVALID_AI_TOKEN:'توکن پذیرفته نشد.',AI_PROVIDER_TIMEOUT:'پاسخ هتزنر طول کشید؛ دوباره امتحان کنید.',AI_PROVIDER_UNAVAILABLE:'سرویس آزمایشی هتزنر در دسترس نیست.'};$('#ai-result').textContent=messages[error.message]||'آزمایش اتصال ناموفق بود.'}finally{button.disabled=false;button.textContent=label}
  };
  $('#ai-summary').onclick=async()=>{const button=$('#ai-summary'),label=button.textContent;button.disabled=true;button.textContent='در حال تحلیل…';$('#ai-summary-result').textContent='';try{const result=await api('/api/admin/ai/operations-summary',{method:'POST',body:'{}'});$('#ai-summary-result').textContent=result.summary}catch(error){const messages={AI_NOT_CONFIGURED:'ابتدا هوش مصنوعی را فعال و توکن را ذخیره کنید.',AI_RATE_LIMITED:'سقف موقت سرویس رایگان پر شده است.',AI_PROVIDER_UNAVAILABLE:'ظرفیت آزمایشی هتزنر فعلاً در دسترس نیست.'};$('#ai-summary-result').textContent=messages[error.message]||'تحلیل انجام نشد.'}finally{button.disabled=false;button.textContent=label}};
  $('#ai-sales').onclick=async()=>{const button=$('#ai-sales'),label=button.textContent;button.disabled=true;button.textContent='در حال تحلیل فروش…';$('#ai-sales-result').textContent='';try{const result=await api('/api/admin/ai/sales-advice',{method:'POST',body:'{}'});$('#ai-sales-result').textContent=result.advice}catch(error){const messages={AI_NOT_CONFIGURED:'ابتدا هوش مصنوعی را فعال کنید.',AI_RATE_LIMITED:'سقف موقت سرویس رایگان پر شده است.',AI_PROVIDER_UNAVAILABLE:'سرویس آزمایشی هتزنر فعلاً پاسخ نمی‌دهد.'};$('#ai-sales-result').textContent=messages[error.message]||'تحلیل فروش انجام نشد.'}finally{button.disabled=false;button.textContent=label}};
})();
