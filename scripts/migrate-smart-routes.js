import http from 'node:http';
import https from 'node:https';

const dryRun=process.argv.includes('--dry-run');
const ids=[process.env.PANEL_INBOUND_ID,process.env.PANEL_VISION_INBOUND_IDS,process.env.PANEL_CDN_INBOUND_IDS]
  .flatMap(value=>String(value||'').split(',')).map(value=>Number(value.trim())).filter(value=>Number.isInteger(value)&&value>0);
const targetIds=[...new Set(ids)];
if(!targetIds.length)throw new Error('No smart-route inbound IDs are configured');
const base=process.env.PANEL_BASE_URL?.replace(/\/$/,'');
const token=process.env.PANEL_API_TOKEN;
const request=(method,path,body)=>new Promise((resolve,reject)=>{const url=new URL(`${base}/panel/api/${path}`),data=body?JSON.stringify(body):null,req=(url.protocol==='https:'?https:http).request(url,{method,rejectUnauthorized:process.env.PANEL_TLS_REJECT_UNAUTHORIZED!=='false',headers:{authorization:`Bearer ${token}`,...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{const out=raw?JSON.parse(raw):{};if(res.statusCode<200||res.statusCode>=300||out.success===false)reject(new Error(out.msg||`HTTP ${res.statusCode}`));else resolve(out.obj??out)}catch(e){reject(e)}})});req.on('error',reject);if(data)req.write(data);req.end()});
const exported=await request('GET','clients/export');
const items=Array.isArray(exported)?exported:[];
const emails=[...new Set(items.map(item=>item?.client?.email).filter(Boolean))];
if(process.argv.includes('--inspect')){
  console.log(JSON.stringify({clients:emails.length,targetIds,current:items.slice(0,3).map(item=>({email:item.client?.email,inboundIds:item.inboundIds}))},null,2));
  process.exit(0);
}
const missingPairs=items.reduce((sum,item)=>sum+targetIds.filter(id=>!item.inboundIds?.includes(id)).length,0);
if(dryRun){console.log(JSON.stringify({clients:emails.length,targetIds,missingPairs,dryRun:true}));process.exit(0)}
const attachResult=await request('POST','clients/bulkAttach',{emails,inboundIds:targetIds});
const flowResult=await request('POST','clients/bulkAdjust',{emails,addDays:0,addBytes:0,flow:'xtls-rprx-vision'});
console.log(JSON.stringify({clients:emails.length,targetIds,missingPairs,dryRun:false,attachResult,flowResult}));
if(attachResult?.errors?.length||flowResult?.errors?.length)process.exitCode=1;
