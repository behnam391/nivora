const base=process.env.NIVORA_LOCAL_URL||'http://127.0.0.1:8787';
const response=await fetch(`${base}/api/admin/orders`,{headers:{authorization:`Bearer ${process.env.ADMIN_TOKEN||''}`}});
if(!response.ok)throw new Error(`Admin orders returned ${response.status}`);
const payload=await response.json();
const orders=Array.isArray(payload)?payload:Array.isArray(payload.items)?payload.items:[];
const summary={total:orders.length,byLocation:{},statsAvailable:0,statsMissing:0};
for(const row of orders){
  const location=row.location_name||row.locationName||'unknown';
  summary.byLocation[location]=(summary.byLocation[location]||0)+1;
  if(row.statsAvailable)summary.statsAvailable++;
  else summary.statsMissing++;
}
console.log(JSON.stringify(summary));
const alertsResponse=await fetch(`${base}/api/admin/notifications`,{headers:{authorization:`Bearer ${process.env.ADMIN_TOKEN||''}`}});
if(!alertsResponse.ok)throw new Error(`Admin notifications returned ${alertsResponse.status}`);
const alerts=await alertsResponse.json();
console.log(JSON.stringify({notificationCounts:alerts.counts,items:(alerts.items||[]).length,withId:(alerts.items||[]).filter(item=>item.id).length}));
const telegramResponse=await fetch(`${base}/api/admin/telegram-settings`,{headers:{authorization:`Bearer ${process.env.ADMIN_TOKEN||''}`}});
if(!telegramResponse.ok)throw new Error(`Telegram settings returned ${telegramResponse.status}`);
const telegram=await telegramResponse.json();
console.log(JSON.stringify({telegramEnabled:telegram.enabled,telegramTokenConfigured:telegram.tokenConfigured,telegramAdminCount:String(telegram.adminIds||'').split(',').filter(Boolean).length,webhookSecretConfigured:telegram.webhookSecretConfigured}));
