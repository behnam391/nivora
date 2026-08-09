import { randomUUID } from 'node:crypto';

export function createRequestGuard({ now = () => Date.now() } = {}) {
  const buckets=new Map();
  const rules=[
    {test:p=>p==='/api/customer/login'||p==='/api/customer/register'||p==='/api/reseller/login',limit:10,windowMs:10*60_000},
    {test:p=>p==='/api/receipts',limit:30,windowMs:60*60_000},
    {test:p=>p.startsWith('/api/admin/'),limit:300,windowMs:60_000},
    {test:p=>p.startsWith('/api/'),limit:180,windowMs:60_000}
  ];
  const ip=req=>String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
  return (req,res,path)=>{
    const requestId=String(req.headers['x-request-id']||randomUUID()).slice(0,100),started=now();
    res.setHeader('x-request-id',requestId);res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','same-origin');res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');res.setHeader('content-security-policy',"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if(path.startsWith('/api/'))res.setHeader('cache-control','no-store');
    const rule=rules.find(r=>r.test(path));if(rule){const key=`${ip(req)}:${rules.indexOf(rule)}`,time=now();let b=buckets.get(key);if(!b||time-b.start>=rule.windowMs)b={start:time,count:0};b.count++;buckets.set(key,b);res.setHeader('x-ratelimit-limit',rule.limit);res.setHeader('x-ratelimit-remaining',Math.max(rule.limit-b.count,0));if(b.count>rule.limit){res.setHeader('retry-after',Math.ceil((rule.windowMs-(time-b.start))/1000));return {blocked:true,requestId,started};}}
    if(buckets.size>10_000)for(const [key,b] of buckets)if(now()-b.start>60*60_000)buckets.delete(key);
    return {blocked:false,requestId,started};
  };
}
