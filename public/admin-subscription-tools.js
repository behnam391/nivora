// Delegated actions survive order-list refreshes.
document.addEventListener('click', async event => {
  const button=event.target.closest('[data-admin-qr],[data-admin-limits]');
  if(!button)return;
  const id=button.dataset.adminQr||button.dataset.adminLimits;
  button.disabled=true;
  try {
    if(button.dataset.adminQr){
      const result=await api(`/api/admin/orders/${encodeURIComponent(id)}/ios-import`,{method:'POST',body:'{}'});
      if(result.protocol==='openvpn'){window.downloadOpenVpnResult(result);return;}
      if(!/^data:image\/png;base64,/.test(result.qrDataUrl||''))throw new Error('INVALID_QR');
      const dialog=document.createElement('dialog');
      dialog.innerHTML=`<h3>افزودن در V2Box آیفون</h3><p>${esc(result.profileName)}</p><img alt="QR افزودن اشتراک" width="300" height="300"><p>تا ۵ دقیقه معتبر؛ حداکثر ۳ بار دریافت. این QR را فقط به صاحب حساب بدهید.</p><button>بستن</button>`;
      dialog.querySelector('img').src=result.qrDataUrl;dialog.querySelector('button').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
    }else{
      const dialog=document.createElement('dialog');
      dialog.innerHTML=`<form><h3>حجم و اعتبار ویژه این اشتراک</h3><p>صفر یعنی نامحدود. زمان جدید از همین لحظه محاسبه می‌شود؛ حجم، سقف کل با احتساب مصرف قبلی است. پلن دیگر مشتریان تغییر نمی‌کند.</p><label>حجم کل (گیگابایت)<input name="trafficGb" type="number" min="0" max="100000" required></label><label>اعتبار از امروز (روز)<input name="durationDays" type="number" min="0" max="100000" required></label><label>پیام ویژه<textarea name="specialMessage" maxlength="500" placeholder="این اشتراک ویژه شماست"></textarea></label><p role="alert"></p><button type="submit">اعمال روی سرور</button><button type="button">انصراف</button></form>`;
      dialog.querySelector('[type=button]').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
      dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const submit=e.submitter;submit.disabled=true;const data=new FormData(e.target);try{await api(`/api/admin/orders/${encodeURIComponent(id)}/limits`,{method:'POST',body:JSON.stringify({trafficGb:Number(data.get('trafficGb')),durationDays:Number(data.get('durationDays')),specialMessage:data.get('specialMessage')})});dialog.close();toast('محدودیت و پیام ویژه ذخیره شد');await load()}catch{dialog.querySelector('[role=alert]').textContent='ذخیره کامل نشد؛ وضعیت سرور را بررسی کنید.'}finally{submit.disabled=false}};
      document.body.append(dialog);dialog.showModal();
    }
  }catch{toast('عملیات کامل نشد؛ فعال‌بودن اشتراک و ارتباط سرور را بررسی کنید')}finally{button.disabled=false}
});
