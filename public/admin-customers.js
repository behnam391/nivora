(()=>{
let customers=[],activeDeviceCustomer=null;

function mount(){
  document.querySelector('nav').insertAdjacentHTML('beforeend','<button class="nav" id="customers-nav">مشتریان</button>');
  document.querySelector('main').insertAdjacentHTML('beforeend',`<section id="customers" class="view hidden"><div class="panel-head standalone"><div><h2>مدیریت مشتریان</h2><p>حساب، موجودی، رمز و دستگاه‌های مجاز مشتری</p></div><button id="new-customer" class="primary">+ مشتری جدید</button></div><div id="customer-grid" class="reseller-grid"></div></section>`);
  document.body.insertAdjacentHTML('beforeend',`
    <dialog id="customer-dialog"><form id="customer-form"><div class="modal-head"><div><p class="eyebrow">CUSTOMER ACCOUNT</p><h2 id="customer-dialog-title">مشتری</h2></div><button type="button" class="icon close-customer">×</button></div><input id="customer-id" type="hidden"><div class="form-grid"><label>نام<input id="manage-customer-name" required></label><label>موبایل<input id="manage-customer-phone" inputmode="numeric" pattern="09[0-9]{9}" required></label><label class="span-2">رمز عبور جدید<input id="manage-customer-password" type="password" minlength="8" autocomplete="new-password"></label><label class="check"><input id="manage-customer-active" type="checkbox" checked> حساب فعال</label></div><div class="modal-actions"><button type="button" class="ghost close-customer">انصراف</button><button class="primary">ذخیره</button></div></form></dialog>
    <dialog id="customer-device-dialog" class="customer-device-dialog"><div class="dialog-body"><div class="modal-head"><div><p class="eyebrow">DEVICE ACCESS</p><h2 id="customer-device-title">دستگاه‌های مشتری</h2><p id="customer-device-caption" class="muted"></p></div><button type="button" class="icon close-customer-device">×</button></div><div id="customer-device-loading" class="device-loading">در حال دریافت دستگاه‌ها…</div><div id="customer-device-content" class="hidden"><section class="device-limit-card"><div><b>سقف دستگاه مجاز</b><small>پس از تکمیل ظرفیت، دستگاه تازه فقط با آزادکردن یکی از دستگاه‌های قبلی وارد می‌شود.</small></div><div class="device-limit-control"><input id="customer-device-limit" type="number" min="1" max="10" inputmode="numeric" aria-label="سقف دستگاه"><button id="save-customer-device-limit" type="button" class="primary">ذخیره سقف</button><button id="inherit-customer-device-limit" type="button" class="ghost">مطابق پلن</button></div></section><section id="customer-device-recovery" class="device-recovery-section hidden"><div class="device-list-head"><div><h3>درخواست دستگاه جدید</h3><p class="muted">مشتری با رمز صحیح از گوشی تازه درخواست داده است.</p></div></div><div id="customer-device-recovery-list" class="device-list"></div></section><div class="device-list-head"><div><h3>دستگاه‌های ثبت‌شده</h3><p id="customer-device-usage" class="muted"></p></div><button id="reset-all-customer-devices" type="button" class="danger">آزادسازی همه</button></div><div id="customer-device-list" class="device-list"></div></div><p id="customer-device-error" class="error" role="alert"></p></div></dialog>`);
  $('#customers-nav').onclick=open;
  $('#new-customer').onclick=()=>edit();
  document.querySelectorAll('.close-customer').forEach(button=>button.onclick=()=>$('#customer-dialog').close());
  document.querySelectorAll('.close-customer-device').forEach(button=>button.onclick=()=>$('#customer-device-dialog').close());
  $('#customer-form').onsubmit=save;
  $('#save-customer-device-limit').onclick=saveDeviceLimit;
  $('#inherit-customer-device-limit').onclick=inheritDeviceLimit;
  $('#reset-all-customer-devices').onclick=resetAllDevices;
}

async function open(){
  document.querySelectorAll('.view').forEach(view=>view.classList.add('hidden'));
  document.querySelectorAll('.nav').forEach(nav=>nav.classList.remove('active'));
  $('#customers').classList.remove('hidden');
  $('#customers-nav').classList.add('active');
  $('#page-title').textContent='مدیریت مشتریان';
  customers=await api('/api/admin/accounts?role=customer');
  render();
}

const deviceCount=customer=>{
  const value=Number(customer.device_count??customer.deviceCount);
  return Number.isInteger(value)&&value>=0?value:(customer.device_bound?1:0);
};
const deviceLimit=customer=>{
  const value=Number(customer.device_limit??customer.deviceLimit);
  return Number.isInteger(value)&&value>0?value:1;
};

function render(){
  $('#customer-grid').innerHTML=customers.length?customers.map(customer=>{
    const count=deviceCount(customer),limit=deviceLimit(customer);
    const pending=Number(customer.device_recovery_pending)||0;
    return `<article class="reseller-card"><div class="reseller-person"><div><h3>${esc(customer.name)}</h3><p>${esc(customer.phone)}</p></div><span class="status ${customer.status==='active'?'approved':'rejected'}">${customer.status==='active'?'فعال':'مسدود'}</span></div><div class="wallet-balance"><small>موجودی</small><b>${fa(customer.balance_toman)} تومان</b></div><div class="device-summary"><span>دستگاه‌های مجاز</span><b>${fa(count)} از ${fa(limit)}</b></div>${pending?`<div class="device-request-badge">${fa(pending)} درخواست دستگاه در انتظار</div>`:''}<div class="reseller-actions"><button class="ghost customer-wallet" data-id="${esc(customer.id)}">تغییر موجودی</button><button class="ghost customer-edit" data-id="${esc(customer.id)}">ویرایش و رمز</button><button class="${pending?'primary':'ghost'} customer-devices" data-id="${esc(customer.id)}">مدیریت دستگاه‌ها${pending?' · جدید':''}</button></div></article>`;
  }).join(''):'<div class="empty">مشتری ثبت‌شده‌ای وجود ندارد.</div>';
  document.querySelectorAll('.customer-edit').forEach(button=>button.onclick=()=>edit(button.dataset.id));
  document.querySelectorAll('.customer-wallet').forEach(button=>button.onclick=()=>wallet(button.dataset.id));
  document.querySelectorAll('.customer-devices').forEach(button=>button.onclick=()=>openDevices(button.dataset.id));
}

function edit(id){
  const customer=customers.find(item=>item.id===id);
  $('#customer-id').value=id||'';
  $('#customer-dialog-title').textContent=customer?'ویرایش مشتری':'مشتری جدید';
  $('#manage-customer-name').value=customer?.name||'';
  $('#manage-customer-phone').value=customer?.phone||'';
  $('#manage-customer-password').value='';
  $('#manage-customer-password').required=!customer;
  $('#manage-customer-active').checked=customer?.status!=='suspended';
  $('#customer-dialog').showModal();
}

async function save(event){
  event.preventDefault();
  const id=$('#customer-id').value,body={name:$('#manage-customer-name').value,phone:$('#manage-customer-phone').value,status:$('#manage-customer-active').checked?'active':'suspended'};
  if($('#manage-customer-password').value)body.password=$('#manage-customer-password').value;
  if(!id)body.role='customer';
  await api(id?`/api/admin/accounts/${id}`:'/api/admin/accounts',{method:id?'PATCH':'POST',body:JSON.stringify(body)});
  $('#customer-dialog').close();toast('حساب مشتری ذخیره شد');await open();
}

function normalizeDeviceState(raw){
  const allDevices=Array.isArray(raw)?raw:Array.isArray(raw?.devices)?raw.devices:[];
  const devices=allDevices.filter(device=>!device.status||device.status==='active');
  const rawLimit=Number(raw?.deviceLimit??raw?.device_limit??activeDeviceCustomer?.device_limit??activeDeviceCustomer?.deviceLimit??1);
  const recoveryRequests=Array.isArray(raw?.recoveryRequests)?raw.recoveryRequests:[];
  return {deviceLimit:Number.isInteger(rawLimit)&&rawLimit>0?rawLimit:1,deviceLimitOverride:raw?.deviceLimitOverride??raw?.device_limit_override??null,devices,recoveryRequests};
}
function deviceTime(device){return device.lastSeenAt??device.last_seen_at??device.boundAt??device.bound_at??device.createdAt??device.created_at??''}
function deviceName(device,index){return device.label??device.name??device.model??device.platform??`دستگاه ${fa(index+1)}`}
function deviceMeta(device){return [device.platform,device.model,device.appVersion??device.app_version].filter(Boolean).join(' · ')}

async function openDevices(id){
  activeDeviceCustomer=customers.find(customer=>customer.id===id);
  if(!activeDeviceCustomer)return;
  $('#customer-device-title').textContent=`دستگاه‌های ${activeDeviceCustomer.name}`;
  $('#customer-device-caption').textContent=activeDeviceCustomer.phone;
  $('#customer-device-error').textContent='';
  $('#customer-device-content').classList.add('hidden');
  $('#customer-device-loading').classList.remove('hidden');
  const dialog=$('#customer-device-dialog');if(!dialog.open)dialog.showModal();
  await loadDevices();
}

async function loadDevices(){
  if(!activeDeviceCustomer)return;
  $('#customer-device-error').textContent='';
  try{
    const state=normalizeDeviceState(await api(`/api/admin/accounts/${encodeURIComponent(activeDeviceCustomer.id)}/devices`));
    activeDeviceCustomer.device_limit=state.deviceLimit;activeDeviceCustomer.device_limit_override=state.deviceLimitOverride;activeDeviceCustomer.device_count=state.devices.length;activeDeviceCustomer.device_bound=state.devices.length>0;activeDeviceCustomer.device_recovery_pending=state.recoveryRequests.length;
    $('#customer-device-limit').value=state.deviceLimit;
    $('#customer-device-usage').textContent=`${fa(state.devices.length)} دستگاه از ${fa(state.deviceLimit)} جایگاه استفاده شده · ${state.deviceLimitOverride==null?'سقف پلن':'سقف اختصاصی'}`;
    $('#inherit-customer-device-limit').disabled=state.deviceLimitOverride==null;
    $('#reset-all-customer-devices').disabled=!state.devices.length;
    $('#customer-device-recovery').classList.toggle('hidden',!state.recoveryRequests.length);
    $('#customer-device-recovery-list').innerHTML=state.recoveryRequests.map(request=>`<article class="device-row recovery-row"><div class="device-icon">!</div><div><b>فعال‌سازی دستگاه تازه</b><small>درخواست ${esc(dateForDevice(request.requested_at||request.requestedAt))}</small></div><div class="recovery-actions"><button type="button" class="primary approve-device-recovery" data-request="${esc(request.id)}">تأیید</button><button type="button" class="danger reject-device-recovery" data-request="${esc(request.id)}">رد</button></div></article>`).join('');
    $('#customer-device-list').innerHTML=state.devices.length?state.devices.map((device,index)=>{const meta=deviceMeta(device),seen=deviceTime(device);return `<article class="device-row"><div class="device-icon">${fa(index+1)}</div><div><b>${esc(deviceName(device,index))}</b><small>${meta?esc(meta):'اپ Nivora'}${seen?` · آخرین فعالیت ${esc(dateForDevice(seen))}`:''}</small></div><button type="button" class="danger remove-customer-device" data-device="${esc(device.id)}">آزادسازی</button></article>`}).join(''):'<div class="device-empty"><b>دستگاهی ثبت نشده است</b><span>ورود بعدی مشتری، نخستین جایگاه را فعال می‌کند.</span></div>';
    document.querySelectorAll('.remove-customer-device').forEach(button=>button.onclick=()=>removeDevice(button.dataset.device));
    document.querySelectorAll('.approve-device-recovery').forEach(button=>button.onclick=()=>resolveRecovery(button.dataset.request,'approve'));
    document.querySelectorAll('.reject-device-recovery').forEach(button=>button.onclick=()=>resolveRecovery(button.dataset.request,'reject'));
    $('#customer-device-loading').classList.add('hidden');$('#customer-device-content').classList.remove('hidden');render();
  }catch(error){$('#customer-device-loading').classList.add('hidden');$('#customer-device-error').textContent=deviceErrorText(error.message)}
}

function dateForDevice(value){try{return new Date(value).toLocaleString('fa-IR',{dateStyle:'medium',timeStyle:'short'})}catch{return String(value)}}
function deviceErrorText(code){return ({INVALID_DEVICE_LIMIT:'سقف دستگاه باید یک عدد معتبر باشد.',DEVICE_LIMIT_INVALID:'سقف دستگاه باید یک عدد معتبر باشد.',DEVICE_LIMIT_BELOW_ACTIVE_COUNT:'ابتدا دستگاه‌های اضافه را آزاد کنید و سپس سقف را کاهش دهید.',DEVICE_LIMIT_BELOW_ACTIVE:'ابتدا دستگاه‌های اضافه را آزاد کنید و سپس سقف را کاهش دهید.',DEVICE_NOT_FOUND:'این دستگاه دیگر ثبت‌شده نیست.',ACCOUNT_NOT_FOUND:'حساب مشتری پیدا نشد.',UNAUTHORIZED:'نشست مدیریت منقضی شده است.'}[code]||'مدیریت دستگاه‌ها انجام نشد؛ دوباره تلاش کنید.')}

async function saveDeviceLimit(){
  if(!activeDeviceCustomer)return;
  const button=$('#save-customer-device-limit'),limit=Number($('#customer-device-limit').value);
  if(!Number.isInteger(limit)||limit<1||limit>10){$('#customer-device-error').textContent='سقف دستگاه باید بین ۱ تا ۱۰ باشد.';return}
  button.disabled=true;$('#customer-device-error').textContent='';
  try{await api(`/api/admin/accounts/${encodeURIComponent(activeDeviceCustomer.id)}/device-limit`,{method:'PATCH',body:JSON.stringify({deviceLimit:limit})});toast('سقف دستگاه مشتری ذخیره شد');await loadDevices()}
  catch(error){$('#customer-device-error').textContent=deviceErrorText(error.message)}finally{button.disabled=false}
}

async function inheritDeviceLimit(){
  if(!activeDeviceCustomer)return;
  const button=$('#inherit-customer-device-limit');button.disabled=true;$('#customer-device-error').textContent='';
  try{await api(`/api/admin/accounts/${encodeURIComponent(activeDeviceCustomer.id)}/device-limit`,{method:'PATCH',body:JSON.stringify({deviceLimit:null})});toast('سقف دستگاه از پلن مشتری خوانده می‌شود');await loadDevices()}
  catch(error){$('#customer-device-error').textContent=deviceErrorText(error.message);button.disabled=false}
}

async function removeDevice(deviceId){
  if(!activeDeviceCustomer||!await adminConfirm({title:'آزادسازی دستگاه',message:'این دستگاه از حساب خارج می‌شود و برای ورود دوباره باید یک جایگاه آزاد داشته باشد.',confirmText:'آزادسازی',danger:true}))return;
  try{await api(`/api/admin/accounts/${encodeURIComponent(activeDeviceCustomer.id)}/devices/${encodeURIComponent(deviceId)}`,{method:'DELETE'});toast('دستگاه انتخاب‌شده آزاد شد');await loadDevices()}
  catch(error){$('#customer-device-error').textContent=deviceErrorText(error.message)}
}

async function resetAllDevices(){
  if(!activeDeviceCustomer||!await adminConfirm({title:'آزادسازی همه دستگاه‌ها',message:`همه دستگاه‌ها و نشست‌های فعال ${activeDeviceCustomer.name} خارج می‌شوند.`,confirmText:'آزادسازی همه',danger:true}))return;
  try{await api(`/api/admin/accounts/${encodeURIComponent(activeDeviceCustomer.id)}/device-reset`,{method:'POST',body:'{}'});toast('همه دستگاه‌های مشتری آزاد شدند');await loadDevices()}
  catch(error){$('#customer-device-error').textContent=deviceErrorText(error.message)}
}

async function resolveRecovery(requestId,action){
  if(!await adminConfirm({title:action==='approve'?'تأیید دستگاه تازه':'رد درخواست دستگاه',message:action==='approve'?'قدیمی‌ترین جایگاه آزاد و این گوشی تأیید می‌شود؛ نشست‌های قبلی بسته خواهند شد.':'مشتری نتیجه رد درخواست را در برنامه می‌بیند.',confirmText:action==='approve'?'تأیید دستگاه':'رد درخواست',danger:action!=='approve'}))return;
  try{await api(`/api/admin/device-recovery-requests/${encodeURIComponent(requestId)}/${action}`,{method:'POST',body:'{}'});toast(action==='approve'?'دستگاه تازه تأیید شد':'درخواست رد شد');await loadDevices()}
  catch(error){$('#customer-device-error').textContent=deviceErrorText(error.message)}
}

async function wallet(id){
  const rawAmount=await adminPrompt({title:'تغییر موجودی مشتری',message:'برای شارژ عدد مثبت و برای برداشت عدد منفی وارد کنید.',label:'مبلغ (تومان)',type:'number',required:true,confirmText:'ادامه'});if(rawAmount===null)return;
  const amount=Number(rawAmount);if(!Number.isFinite(amount)||amount===0){toast('مبلغ معتبر و غیرصفر وارد کنید');return}
  const note=await adminPrompt({title:'توضیح تراکنش',label:'توضیح',value:'تغییر موجودی توسط مدیر',required:true,confirmText:'ثبت تراکنش'});if(note===null)return;
  await api(`/api/admin/accounts/${id}/wallet`,{method:'POST',body:JSON.stringify({amountToman:amount,note})});toast('موجودی تغییر کرد');await open();
}

document.addEventListener('DOMContentLoaded',mount);
})();
