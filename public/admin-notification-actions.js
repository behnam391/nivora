(()=>{
  let timer;
  const labels={device_recovery:'آزادسازی دستگاه',ticket:'تیکت پشتیبانی',topup:'شارژ کیف پول',order:'سفارش',password_reset:'بازیابی رمز'};
  async function refresh(){
    clearTimeout(timer);
    const list=document.querySelector('#admin-notification-actions');
    if(!list)return;
    if(!token){timer=setTimeout(refresh,4000);return;}
    try{
      const result=await api('/api/admin/notifications',{silent:true});
      list.innerHTML=result.items?.length?result.items.map(item=>`<article data-type="${esc(item.type)}" data-id="${esc(item.id)}"><b>${esc(labels[item.type]||item.title)}: ${esc(item.title)}</b><span>${esc(item.body)}</span><small>${date(item.created_at)}</small><div class="notification-actions">${item.type==='device_recovery'?'<button class="primary" data-action="approve">آزادسازی</button><button class="ghost" data-action="reject">رد با دلیل</button>':item.type==='ticket'?'<button class="primary" data-action="reply">پاسخ به مشتری</button>':item.type==='topup'?'<button class="ghost" data-action="topup">بررسی پرداخت</button>':item.type==='order'?'<button class="ghost" data-action="order">بررسی سفارش</button>':item.type==='password_reset'?'<button class="ghost" data-action="password_reset">بررسی بازیابی</button>':''}</div></article>`).join(''):'<div class="empty">درخواست منتظری وجود ندارد.</div>';
    }catch{list.innerHTML='<div class="empty">دریافت درخواست‌ها ممکن نشد.</div>';}
    finally{timer=setTimeout(refresh,30000);}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const old=document.querySelector('#admin-notification-list');
    if(!old)return;
    old.hidden=true;old.style.display='none';
    old.insertAdjacentHTML('beforebegin','<h3>درخواست‌های قابل پاسخ</h3><div id="admin-notification-actions" class="admin-notification-list"></div>');
    document.querySelector('#admin-notification-actions').addEventListener('click',async event=>{
      const button=event.target.closest('button[data-action]'),card=button?.closest('article[data-id]');if(!button||!card)return;
      const {action}=button.dataset,id=card.dataset.id;
      if(action==='topup'){document.querySelector('.nav[data-view="topups"]')?.click();return;}
      if(action==='order'){document.querySelector('.nav[data-view="orders"]')?.click();return;}
      if(action==='password_reset'){document.querySelector('#password-resets-nav')?.click();return;}
      let note='';
      if(action==='approve'){const yes=await adminConfirm({title:'آزادسازی دستگاه',message:'با تأیید، دستگاه قبلی این حساب آزاد می‌شود و نشست‌های قبلی پایان می‌یابند. مطمئن هستید؟',confirmText:'تأیید آزادسازی'});if(!yes)return;}
      if(action==='reject'){note=await adminPrompt({title:'رد درخواست آزادسازی',message:'دلیل رد برای مشتری نمایش داده می‌شود.',label:'دلیل رد',multiline:true,required:true,minLength:3,confirmText:'ثبت رد',danger:true});if(!note)return;}
      if(action==='reply'){note=await adminPrompt({title:'پاسخ به تیکت',message:'این پاسخ برای مشتری ارسال می‌شود.',label:'متن پاسخ',multiline:true,required:true,minLength:2,confirmText:'ارسال پاسخ'});if(!note)return;}
      button.disabled=true;
      try{await api(action==='reply'?`/api/admin/tickets/${encodeURIComponent(id)}`:`/api/admin/device-recovery-requests/${encodeURIComponent(id)}/${action}`,{method:'POST',body:JSON.stringify(action==='reply'?{body:note}:{note})});toast('پاسخ ثبت شد');await refresh();}
      catch(error){toast(error.message||'عملیات انجام نشد',true);button.disabled=false;}
    });
    refresh();
  });
})();
