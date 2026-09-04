(()=>{
let selectedCustomer=null,customerPage=1,customerPages=1,searchTimer=null,salePlans=[];

function mount(){
  document.querySelector('#admin-nav').insertAdjacentHTML('beforeend','<button class="nav" id="admin-sales-nav" data-view="admin-sales">فروش مستقیم</button>');
  document.querySelector('main').insertAdjacentHTML('beforeend',`<section id="admin-sales" class="view hidden"><div class="panel-head standalone"><div><h2>فروش مستقیم و ساخت کانفیگ</h2><p>مشتری و پلن را انتخاب کنید؛ اشتراک روی سرور واقعی ساخته و در حساب مشتری ثبت می‌شود.</p></div></div><div class="admin-sales-layout"><section class="panel sale-customer-panel"><div class="panel-head"><div><h3>۱. انتخاب مشتری</h3><p>نام یا شماره موبایل را جست‌وجو کنید.</p></div></div><label class="admin-search"><span>⌕</span><input id="sale-customer-search" placeholder="نام یا شماره موبایل"></label><div id="sale-customer-list" class="sale-customer-list"></div><div id="sale-customer-pagination" class="pagination compact"></div></section><form id="admin-sale-form" class="panel sale-create-panel"><div class="panel-head"><div><h3>۲. ساخت اشتراک</h3><p id="sale-selected-customer">هنوز مشتری انتخاب نشده است.</p></div></div><label>پلن فروش<select id="admin-sale-plan" required></select></label><div id="admin-sale-plan-info" class="sale-plan-info"></div><label>مبلغ فروش ثبت‌شده (تومان)<input id="admin-sale-price" type="number" min="0" inputmode="numeric" required></label><div class="safety-note">از کیف پول مشتری یا نماینده مبلغی کسر نمی‌شود؛ این بخش فروش حضوری مدیر را ثبت می‌کند.</div><p id="admin-sale-error" class="error" role="alert"></p><button id="admin-sale-submit" class="primary wide" type="submit" disabled>ساخت اشتراک برای مشتری</button><div id="admin-sale-result"></div></form></div></section>`);
  $('#admin-sales-nav').onclick=open;
  $('#sale-customer-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{customerPage=1;void loadCustomers()},260)};
  $('#admin-sale-plan').onchange=syncPlan;
  $('#admin-sale-form').onsubmit=createSale;
}

async function open(){
  showSalesView();
  const result=await api('/api/admin/plans');salePlans=result.filter(plan=>plan.active);fillPlans();await loadCustomers();
}

function showSalesView(){
  document.querySelectorAll('.view').forEach(view=>view.classList.add('hidden'));document.querySelectorAll('.nav').forEach(nav=>nav.classList.remove('active'));
  $('#admin-sales').classList.remove('hidden');$('#admin-sales-nav').classList.add('active');$('#page-title').textContent='فروش مستقیم';window.scrollTo({top:0,behavior:'smooth'});
}

function fillPlans(){
  $('#admin-sale-plan').innerHTML=salePlans.length?salePlans.map(plan=>`<option value="${esc(plan.id)}">${esc(plan.name)}</option>`).join(''):'<option value="">پلن فعالی وجود ندارد</option>';syncPlan();
}

function syncPlan(){
  const plan=salePlans.find(item=>item.id===$('#admin-sale-plan').value);if(!plan){$('#admin-sale-plan-info').textContent='';return}
  $('#admin-sale-price').value=plan.priceIrr;$('#admin-sale-plan-info').textContent=`${fa(plan.trafficGb)} گیگ · ${fa(plan.durationDays)} روز · ${fa(plan.deviceLimit)} دستگاه · ${plan.locationMode==='multi'?`${fa(plan.bundleSize)} لوکیشن`:'یک لوکیشن'}`;
}

async function loadCustomers(){
  const query=$('#sale-customer-search').value.trim(),result=await api(`/api/admin/accounts?role=customer&page=${customerPage}&pageSize=6&q=${encodeURIComponent(query)}`);customerPage=result.page||1;customerPages=result.totalPages||1;renderCustomers(result.items||[],result.total||0);
}

function renderCustomers(items,total){
  $('#sale-customer-list').innerHTML=items.length?items.map(customer=>`<button type="button" class="sale-customer ${selectedCustomer?.id===customer.id?'selected':''}" data-id="${esc(customer.id)}"><span class="customer-avatar">${esc(customer.name.slice(0,1))}</span><span><b>${esc(customer.name)}</b><small>${esc(customer.phone)}</small></span><em>${customer.status==='active'?'انتخاب':'مسدود'}</em></button>`).join(''):'<div class="empty">مشتری پیدا نشد.</div>';
  document.querySelectorAll('.sale-customer').forEach((button,index)=>button.onclick=()=>selectCustomer(items[index]));
  $('#sale-customer-pagination').innerHTML=total?`<button type="button" id="sale-page-prev" class="ghost" ${customerPage<=1?'disabled':''}>قبلی</button><span>${fa(customerPage)} از ${fa(customerPages)}</span><button type="button" id="sale-page-next" class="ghost" ${customerPage>=customerPages?'disabled':''}>بعدی</button>`:'';
  $('#sale-page-prev')?.addEventListener('click',()=>{if(customerPage>1){customerPage--;void loadCustomers()}});$('#sale-page-next')?.addEventListener('click',()=>{if(customerPage<customerPages){customerPage++;void loadCustomers()}});
}

function selectCustomer(customer){
  selectedCustomer=customer;$('#sale-selected-customer').textContent=`${customer.name} · ${customer.phone}`;$('#admin-sale-submit').disabled=!salePlans.length;document.querySelectorAll('.sale-customer').forEach(button=>button.classList.toggle('selected',button.dataset.id===customer.id));$('#admin-sale-result').innerHTML='';$('#admin-sale-error').textContent='';
}

async function createSale(event){
  event.preventDefault();if(!selectedCustomer)return;const button=$('#admin-sale-submit'),label=button.textContent;button.disabled=true;button.textContent='در حال ساخت روی سرور…';$('#admin-sale-error').textContent='';$('#admin-sale-result').innerHTML='';
  try{
    const result=await api('/api/admin/sales',{method:'POST',body:JSON.stringify({customerId:selectedCustomer.id,planId:$('#admin-sale-plan').value,salePriceToman:Number($('#admin-sale-price').value)})});
    $('#admin-sale-result').innerHTML=`<div class="sale-success"><b>اشتراک با موفقیت ساخته شد</b><span>${fa(result.subscriptionCount)} سرویس فعال: ${(result.subscriptions||[]).map(item=>esc(item.locationName)).join('، ')}</span><small>اشتراک در حساب مشتری قرار گرفت و اعلان فعال‌سازی ارسال شد.</small></div>`;toast('فروش مدیر ثبت و کانفیگ ساخته شد');if(typeof load==='function')await load();
  }catch(error){const messages={INVALID_ADMIN_SALE:'مشتری یا پلن معتبر نیست.',INVALID_AMOUNT:'مبلغ فروش معتبر نیست.',NO_CAPACITY:'برای این پلن سرور فعال و دارای ظرفیت پیدا نشد.',PROVISION_FAILED:'ساخت کانفیگ روی سرور ناموفق بود؛ گزارش خطا در سفارش‌ها ثبت شد.'};$('#admin-sale-error').textContent=messages[error.message]||'ساخت اشتراک انجام نشد؛ دوباره تلاش کنید.'}
  finally{button.disabled=false;button.textContent=label}
}

async function openForCustomer(customer){if(!customer)return;showSalesView();selectedCustomer=customer;const result=await api('/api/admin/plans');salePlans=result.filter(plan=>plan.active);fillPlans();selectCustomer(customer);$('#sale-customer-list').innerHTML=`<button type="button" class="sale-customer selected"><span class="customer-avatar">${esc(customer.name.slice(0,1))}</span><span><b>${esc(customer.name)}</b><small>${esc(customer.phone)}</small></span><em>انتخاب‌شده</em></button>`;$('#sale-customer-pagination').innerHTML='';}

window.NivoraAdminSales={openForCustomer};document.addEventListener('DOMContentLoaded',mount);
})();
