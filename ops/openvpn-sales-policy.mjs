export const GB=1024**3, DAY=86400000;
export function limits(trafficGb,durationDays,deviceLimit=1) {
  if(!Number.isInteger(trafficGb)||trafficGb<0||trafficGb>100000||!Number.isInteger(durationDays)||durationDays<0||durationDays>100000)throw new Error('INVALID_LIMITS');
  if(deviceLimit!==1)throw new Error('OPENVPN_ONE_DEVICE_ONLY');
  return {totalBytes:trafficGb*GB,expiresAt:durationDays===0?0:Date.now()+durationDays*DAY};
}
export function permitted(c,now=Date.now()) {return !c.deleted&&c.enabled&&(!c.expiresAt||c.expiresAt>now)&&(!c.totalBytes||c.usedBytes<c.totalBytes);}
export function renew(c,days,gb,now=Date.now()) {
  limits(gb,days);
  return {...c,totalBytes:gb===0||c.totalBytes===0?0:c.totalBytes+gb*GB,expiresAt:days===0||c.expiresAt===0?0:Math.max(now,c.expiresAt)+days*DAY};
}
export function firewall(clients,live={}) {
  const lines=['add table inet nivora_ovpn_sales','add chain inet nivora_ovpn_sales forward { type filter hook forward priority -10; policy accept; }','flush chain inet nivora_ovpn_sales forward'];
  // The pre-existing pilot is explicitly isolated from paid client accounting.
  lines.push('add rule inet nivora_ovpn_sales forward iifname "nvovpn0" ip saddr 10.78.0.2 return','add rule inet nivora_ovpn_sales forward oifname "nvovpn0" ip daddr 10.78.0.2 return');
  for(const c of Object.values(clients)) {
    if(!/^ovpn-[a-f0-9]{32}$/.test(c.id)||!/^10\.78\.0\.\d+$/.test(c.address))throw new Error('INVALID_CLIENT');
    const q=c.id.replaceAll('-',''),total=c.totalBytes||Number.MAX_SAFE_INTEGER;
    if(!live[q]||live[q].bytes!==total) {
      if(live[q])lines.push(`delete quota inet nivora_ovpn_sales ${q}`);
      lines.push(`add quota inet nivora_ovpn_sales ${q} { over ${total} bytes used ${Math.min(c.usedBytes,total)} bytes; }`);
    }
    for(const [direction,field] of [['iifname','saddr'],['oifname','daddr']]) {
      const match=`${direction} "nvovpn0" ip ${field} ${c.address}`;
      if(!permitted(c)) lines.push(`add rule inet nivora_ovpn_sales forward ${match} drop`);
      else lines.push(`add rule inet nivora_ovpn_sales forward ${match} quota name "${q}" drop`,`add rule inet nivora_ovpn_sales forward ${match} return`);
    }
  }
  lines.push('add rule inet nivora_ovpn_sales forward iifname "nvovpn0" drop','add rule inet nivora_ovpn_sales forward oifname "nvovpn0" drop');
  return lines.join('\n')+'\n';
}
