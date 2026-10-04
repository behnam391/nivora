/* Main administrator overview only. No customer or reseller UI depends on this file. */
(()=>{
  const $=selector=>document.querySelector(selector);
  const number=value=>new Intl.NumberFormat('fa-IR').format(Number(value)||0);
  const safe=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const dayFormatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'});
  const dayKey=value=>{const timestamp=new Date(value);if(Number.isNaN(timestamp.getTime()))return '';const parts=Object.fromEntries(dayFormatter.formatToParts(timestamp).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`};
  const validOrders=()=>typeof orders==='undefined'?[]:orders;
  const paidAmount=order=>Math.max(0,Number(order.amount_transferred_irr)||0);
  function renderLocal(){
    const all=validOrders(),today=dayKey(Date.now()),approved=all.filter(order=>order.status==='approved');
    const todaySales=approved.filter(order=>dayKey(order.reviewed_at||order.created_at)===today).reduce((sum,order)=>sum+paidAmount(order),0);
    const active=all.filter(order=>order.order_kind==='purchase'&&order.subscription_status==='active'&&(!order.control_status||order.control_status==='active'));
    const expiring=active.filter(order=>order.statsAvailable&&!order.statsStale&&((order.duration_days>0&&!order.startsOnFirstUse&&Number(order.remainingDays)<=3)||(Number(order.totalBytes)>0&&Number(order.usagePercent)>=80)));
    $('#stat-sales-today').textContent=number(todaySales);
    $('#stat-active-subscriptions').textContent=number(active.length);
    $('#stat-expiring').textContent=number(expiring.length);
    renderChart(approved);
  }
  function renderChart(approved){
    const days=Array.from({length:7},(_,index)=>{const date=new Date(Date.now()-(6-index)*86400000);return {key:dayKey(date),label:new Intl.DateTimeFormat('fa-IR',{timeZone:'Asia/Tehran',weekday:'short'}).format(date),amount:0}});
    for(const order of approved){const bucket=days.find(day=>day.key===dayKey(order.reviewed_at||order.created_at));if(bucket)bucket.amount+=paidAmount(order)}
    const max=Math.max(...days.map(day=>day.amount),1),total=days.reduce((sum,day)=>sum+day.amount,0);
    $('#dashboard-week-total').textContent=`${number(total)} تومان`;
    $('#dashboard-sales-chart').innerHTML=days.map(day=>`<div class="dashboard-chart-day" title="${safe(day.label)}: ${number(day.amount)} تومان"><span class="dashboard-chart-value">${day.amount?number(day.amount):'—'}</span><span class="dashboard-chart-track"><span style="height:${day.amount?Math.max(8,Math.round(day.amount/max*100)):0}%"></span></span><span class="dashboard-chart-label">${safe(day.label)}</span></div>`).join('');
  }
  function nav(view){const target=document.querySelector(`.nav[data-view="${view}"]`);if(target)target.click();else if(typeof showView==='function'&&document.getElementById(view))showView(view)}
  const itemView={ticket:'tickets',order:'orders',topup:'topups',device_recovery:'admin-alert',password_reset:'password-resets'};
  async function loadActions(){if(typeof token==='undefined'||!token||$('#app')?.classList.contains('hidden'))return;try{
    const data=await api('/api/admin/notifications',{silent:true}),counts=data.counts||{},count=['openTickets','pendingOrders','pendingTopups','pendingResets','pendingDevices'].reduce((sum,key)=>sum+(Number(counts[key])||0),0);
    $('#stat-action-needed').textContent=number(count);
    const items=Array.isArray(data.items)?data.items.slice(0,5):[];
    $('#dashboard-action-list').innerHTML=items.length?items.map(item=>`<button type="button" class="dashboard-action-row" data-dashboard-go="${safe(itemView[item.type]||'admin-alert')}"><span class="dashboard-action-dot"></span><span><b>${safe(item.title)}</b><small>${safe(item.body)}</small></span><span class="dashboard-action-arrow" aria-hidden="true">←</span></button>`).join(''):'<div class="dashboard-empty-state"><span>✓</span><b>همه‌چیز رسیدگی شده</b><small>درخواست منتظری ندارید.</small></div>';
  }catch{ $('#stat-action-needed').textContent='—';$('#dashboard-action-list').innerHTML='<div class="dashboard-empty-state"><b>اعلان‌ها دریافت نشد</b><small>اتصال را بررسی کنید و دوباره تلاش کنید.</small></div>'}}
  async function loadNodes(){if(typeof token==='undefined'||!token||$('#app')?.classList.contains('hidden'))return;try{
    const data=await api('/api/admin/panel-nodes',{silent:true}),nodes=Array.isArray(data)?data:Array.isArray(data.nodes)?data.nodes:[];
    $('#dashboard-node-list').innerHTML=nodes.length?nodes.slice(0,6).map(node=>`<div class="dashboard-node-row"><span class="dashboard-node-icon">▣</span><span class="dashboard-node-name"><b>${safe(node.name)}</b><small>${number(node.locationCount)} لوکیشن · ${safe(node.panelType||'پنل')}</small></span><span class="dashboard-node-state ${!node.active?'off':node.ready?'ready':'attention'}">${!node.active?'غیرفعال':node.ready?'تنظیمات کامل':'نیازمند تنظیم'}</span></div>`).join(''):'<div class="dashboard-empty-state"><b>هنوز سروری ثبت نشده است</b><small>از بخش مدیریت سرورها شروع کنید.</small></div>';
  }catch{$('#dashboard-node-list').innerHTML='<div class="dashboard-empty-state"><b>فهرست سرورها دریافت نشد</b><small>از بخش مدیریت سرورها وضعیت را بررسی کنید.</small></div>'}}
  document.addEventListener('nivora-admin-data',renderLocal);
  document.addEventListener('click',event=>{const button=event.target.closest('[data-dashboard-go]');if(button)nav(button.dataset.dashboardGo)});
  document.addEventListener('DOMContentLoaded',()=>{if(!$('#overview'))return;const observer=new MutationObserver(()=>{if(!$('#app').classList.contains('hidden')){renderLocal();loadActions();loadNodes()}});observer.observe($('#app'),{attributes:true,attributeFilter:['class']});if(!$('#app').classList.contains('hidden')){renderLocal();loadActions();loadNodes()}setInterval(()=>{if(!$('#overview').classList.contains('hidden')){loadActions();loadNodes()}},60000)});
})();
