import { randomUUID } from 'node:crypto';

export function createKeyedRateLimiter({ limit = 30, windowMs = 60_000, now = () => Date.now(), maxBuckets = 10_000 } = {}) {
  const buckets = new Map();
  return rawKey => {
    const key = String(rawKey || '').slice(0, 256);
    const time = now();
    let bucket = buckets.get(key);
    if (!bucket || time - bucket.start >= windowMs) bucket = { start: time, count: 0 };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > maxBuckets) {
      for (const [candidate, value] of buckets) {
        if (time - value.start >= windowMs) buckets.delete(candidate);
      }
    }
    return {
      blocked: bucket.count > limit,
      limit,
      remaining: Math.max(limit - bucket.count, 0),
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (time - bucket.start)) / 1000))
    };
  };
}

export function createRequestGuard({ now = () => Date.now() } = {}) {
  const buckets=new Map();
  const rules=[
    {test:p=>p==='/api/neuralmesh/manifest',limit:30,windowMs:10*60_000},
    {test:p=>p==='/api/customer/login'||p==='/api/customer/register'||p==='/api/customer/password-reset/request'||p==='/api/customer/password-reset/confirm'||p==='/api/reseller/login',bucket:p=>p,limit:60,windowMs:10*60_000},
    {test:p=>p==='/api/customer/change-password',bucket:()=>'/api/customer/change-password',limit:10,windowMs:10*60_000},
    {test:p=>p==='/api/device-recovery/request',bucket:()=>'/api/device-recovery/request',limit:20,windowMs:10*60_000},
    {test:p=>p==='/api/receipts',limit:30,windowMs:60*60_000},
    {test:p=>p.startsWith('/api/admin/'),limit:300,windowMs:60_000},
    // Emergency leases must not share the generic public-IP bucket: Iranian
    // mobile CGNAT can place many customers behind one address. app.js applies
    // a generous IP bucket only to failed pre-auth requests, then a strict
    // account+device bucket after successful authentication.
    {test:p=>p.startsWith('/api/')&&!['/api/customer/emergency/lease','/api/customer/emergency/subscription'].includes(p),limit:180,windowMs:60_000}
  ];
  const ip=req=>String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
  return (req,res,path)=>{
    const requestId=String(req.headers['x-request-id']||randomUUID()).slice(0,100),started=now();
    res.setHeader('x-request-id',requestId);res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','same-origin');res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');res.setHeader('content-security-policy',"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if(path.startsWith('/api/'))res.setHeader('cache-control','no-store');
    const rule=rules.find(r=>r.test(path));if(rule){const bucket=rule.bucket?.(path)??rules.indexOf(rule),key=`${ip(req)}:${bucket}`,time=now();let b=buckets.get(key);if(!b||time-b.start>=rule.windowMs)b={start:time,count:0};b.count++;buckets.set(key,b);res.setHeader('x-ratelimit-limit',rule.limit);res.setHeader('x-ratelimit-remaining',Math.max(rule.limit-b.count,0));if(b.count>rule.limit){res.setHeader('retry-after',Math.ceil((rule.windowMs-(time-b.start))/1000));return {blocked:true,requestId,started};}}
    if(buckets.size>10_000)for(const [key,b] of buckets)if(now()-b.start>60*60_000)buckets.delete(key);
    return {blocked:false,requestId,started};
  };
}
