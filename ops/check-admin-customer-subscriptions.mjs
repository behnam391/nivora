const base=process.env.NIVORA_LOCAL_URL||'http://127.0.0.1:8787';
const response=await fetch(`${base}/api/admin/accounts?role=customer&page=1&pageSize=10&includeSubscriptions=1`,{
  headers:{authorization:`Bearer ${process.env.ADMIN_TOKEN||''}`}
});
if(!response.ok)throw new Error(`Admin customer list returned ${response.status}`);
const data=await response.json();
const subscriptions=(data.items||[]).flatMap(item=>item.subscriptions||[]);
console.log(JSON.stringify({customersOnPage:data.items?.length||0,subscriptions:subscriptions.length,withStats:subscriptions.filter(item=>item.statsAvailable).length,withoutStats:subscriptions.filter(item=>!item.statsAvailable).length}));
