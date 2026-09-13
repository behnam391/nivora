window.downloadOpenVpnResult=function(result){
  if(result.protocol!=='openvpn'||typeof result.content!=='string'||!result.content.startsWith('client\n'))throw new Error('INVALID_PROFILE');
  const file=new Blob([result.content],{type:'application/x-openvpn-profile'}),url=URL.createObjectURL(file),link=document.createElement('a');
  link.href=url;link.download=/^[A-Za-z0-9-]+\.ovpn$/.test(result.filename)?result.filename:'Nivora.ovpn';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  const dialog=document.createElement('dialog');
  dialog.innerHTML='<h3>فایل OpenVPN آماده شد</h3><p>فایل دانلودشده را فقط برای صاحب اشتراک بفرستید. در آیفون یا اندروید، آن را با OpenVPN Connect باز و Import کنید.</p><p>این فایل کلید خصوصی دارد؛ در گروه یا کانال عمومی منتشر نکنید. هم‌زمان فقط یک دستگاه می‌تواند متصل باشد.</p><button type="button">متوجه شدم</button>';
  dialog.querySelector('button').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
};
// Existing per-order controls remain the entry point, with a protocol-specific label.
new MutationObserver(()=>{
  if(typeof orders==='undefined')return;
  document.querySelectorAll('[data-admin-qr],[data-ios-qr]').forEach(button=>{
    const id=button.dataset.adminQr||button.dataset.iosQr,order=orders.find(o=>o.id===id);
    if(order?.protocol==='openvpn'&&button.textContent!=='فایل OpenVPN')button.textContent='فایل OpenVPN';
  });
}).observe(document.body,{childList:true,subtree:true});
