import {randomUUID} from 'node:crypto';
export function createOpenVpnProvisioner({baseUrl,apiToken},transport=fetch){
  const url=new URL(baseUrl);
  if(url.protocol!=='https:' && !(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('OPENVPN_HTTPS_REQUIRED');
  const call=async(action,body={})=>{
    const mutation=!['profile','stats','allstats','health'].includes(action);
    try{
      const response=await transport(new URL('/'+action,url),{method:'POST',headers:{authorization:'Bearer '+apiToken,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(mutation?45000:action==='profile'?10000:2500),redirect:'error'});
      const result=await response.json();
      if(!response.ok)throw Object.assign(new Error(result.error||'OPENVPN_NODE_ERROR'),{uncertain:mutation&&response.status>=500,definitive:response.status<500});
      return result;
    }catch(error){if(mutation&&!error.definitive)error.uncertain=true;throw error;}
  };
  const provision=async order=>{
    const id='ovpn-'+String(order.id).replaceAll('-','');
    await call('create',{id,trafficGb:Number(order.traffic_gb),durationDays:Number(order.duration_days),deviceLimit:Number(order.device_limit),operationId:'create:'+order.id});
    return {panelClientId:id,subscriptionUrl:'openvpn://'+id};
  };
  provision.renew=({panelClientId,addDays,addTrafficGb,operationId})=>call('renew',{id:panelClientId,durationDays:Number(addDays),trafficGb:Number(addTrafficGb),operationId:'renew:'+(operationId||randomUUID())});
  provision.setLimits=({panelClientId,trafficGb,durationDays})=>call('limits',{id:panelClientId,trafficGb,durationDays,operationId:'limits:'+randomUUID()});
  for(const action of ['suspend','resume','remove'])provision[action]=({panelClientId})=>call(action,{id:panelClientId,operationId:action+':'+randomUUID()});
  provision.profile=({panelClientId})=>call('profile',{id:panelClientId});
  provision.stats=({panelClientId})=>call('stats',{id:panelClientId});
  provision.health=()=>call('health');
  provision.statsAll=()=>call('allstats');
  return provision;
}
