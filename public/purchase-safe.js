(()=>{
  const pending=new Map(),originalFetch=window.fetch.bind(window);
  const eligible=path=>/^\/api\/(customer|reseller)\/((?:wallet\/)?purchase|orders\/[^/]+\/renew)$/.test(path)||path==='/api/admin/sales';
  window.NivoraPurchaseFetch=async(url,options={})=>{
    const path=new URL(url,location.href).pathname;
    if(options.method!=='POST'||!eligible(path))return originalFetch(url,options);
    const headers=new Headers(options.headers),identity=[headers.get('authorization'),path,options.body||''].join('\n');
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity));
    const storageKey='nivora_purchase_'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    let key=pending.get(storageKey);try{key=key||localStorage.getItem(storageKey)}catch{}
    if(!key)key=crypto.randomUUID();pending.set(storageKey,key);try{localStorage.setItem(storageKey,key)}catch{}
    headers.set('Idempotency-Key',key);
    // On a timeout, abort, or unreadable response retain the key for a safe retry.
    const response=await originalFetch(url,{...options,headers});
    const result=await response.clone().json().catch(()=>null);
    if(result && (response.ok || result.refunded===true || (response.status>=400&&response.status<500&&!['PURCHASE_PENDING','PURCHASE_KEY_CONFLICT'].includes(result.error)))){
      pending.delete(storageKey);try{localStorage.removeItem(storageKey)}catch{}
    }
    return response;
  };
})();
