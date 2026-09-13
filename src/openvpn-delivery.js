// Must be called only inside the existing authenticated role gates.
export async function deliverOpenVpn({db,req,res,orderId,role,actorId,provisionerForLocation,audit}){
  const row=db.prepare(`SELECT o.id,o.account_id,o.reseller_id,o.location_id,o.order_kind,s.status,s.control_status,s.panel_client_id FROM orders o JOIN subscriptions s ON s.order_id=o.id WHERE o.id=?`).get(orderId);
  const respond=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  if(!row||(role==='reseller'&&row.reseller_id!==actorId)||(role==='customer'&&row.account_id!==actorId))return respond(404,{error:'SUBSCRIPTION_NOT_FOUND'});
  if(row.order_kind!=='purchase'||row.status!=='active'||(row.control_status||'active')!=='active')return respond(409,{error:'SUBSCRIPTION_INACTIVE'});
  if(!row.panel_client_id?.startsWith('ovpn-'))return respond(400,{error:'NOT_OPENVPN'});
  const p=provisionerForLocation(db.prepare('SELECT * FROM service_locations WHERE id=?').get(row.location_id));
  if(!p?.profile)return respond(503,{error:'NODE_UNAVAILABLE'});
  try{const result=await p.profile({panelClientId:row.panel_client_id});audit(actorId||'admin','download','openvpn_profile',row.id,{});return respond(200,{protocol:'openvpn',...result});}catch{return respond(503,{error:'PROFILE_UNAVAILABLE'});}
}
