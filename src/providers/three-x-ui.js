import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;

export function buildClientPayload(order, inboundId, extraInboundIds = [], limitIp = order.device_limit) {
  const safePhone = String(order.phone).replace(/\D/g, '');
  const suffix = String(order.id).replace(/-/g, '').slice(0, 8);
  const extras = Array.isArray(extraInboundIds) ? extraInboundIds : [extraInboundIds];
  const inboundIds = [order.panel_inbound_id || inboundId, order.panel_cdn_inbound_id, ...extras]
    .map(Number).filter(Number.isInteger).filter(value => value > 0);
  return {
    client: {
      email: `nivo-${safePhone}-${suffix}`,
      comment: `Nivora order ${order.id} - ${order.plan_name}`,
      totalGB: Number(order.traffic_gb) * GB,
      expiryTime: -(Number(order.duration_days) * DAY),
      tgId: 0,
      limitIp: Number(limitIp),
      enable: true,
      flow: 'xtls-rprx-vision'
      ,subId: randomUUID()
    },
    inboundIds: [...new Set(inboundIds)]
  };
}

export function buildCompatibleClientPayload(client, inboundIds, flow = '', limitIp = client.limitIp) {
  return {
    // A Cloudflare edge may legitimately change its source IP during one
    // customer session. Applying 3X-UI's source-IP limiter there creates
    // false sharing detections and intermittent disconnects.
    client: { ...client, flow, limitIp: Number(limitIp) },
    inboundIds: [...new Set((Array.isArray(inboundIds) ? inboundIds : [inboundIds])
      .map(Number).filter(value => Number.isInteger(value) && value > 0))]
  };
}

function nodeRequest({ url, method, token, body, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    let sent=false;
    const transportFailure=error=>{if(sent && method!=='GET')error.uncertain=true;reject(error)};
    const transport = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = transport.request(url, {
      method,
      rejectUnauthorized,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      },
      timeout: 15_000
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const data = raw ? JSON.parse(raw) : {};
          if (res.statusCode < 200 || res.statusCode >= 300) {const error=new Error(`3X-UI HTTP ${res.statusCode}`);return res.statusCode>=500?transportFailure(error):reject(error);}
          resolve(data);
        } catch { transportFailure(new Error('3X-UI returned invalid JSON')); }
      });
      res.on('aborted',()=>transportFailure(new Error('3X-UI response interrupted')));
      res.on('error',transportFailure);
    });
    req.on('timeout', () => req.destroy(new Error('3X-UI request timed out')));
    req.on('finish',()=>{sent=true});
    req.on('error', transportFailure);
    if (payload) req.write(payload);
    req.end();
  });
}

export function createThreeXuiProvisioner(config = {}, transport = nodeRequest) {
  const baseUrl = config.baseUrl || process.env.PANEL_BASE_URL;
  const apiToken = config.apiToken || process.env.PANEL_API_TOKEN;
  const inboundId = Number(config.inboundId || process.env.PANEL_INBOUND_ID);
  // These inbounds must all accept VLESS Vision. HTTP/UDP transports need
  // separately provisioned client records with a compatible (usually empty) flow.
  const extraInboundIds = String(config.visionInboundIds || process.env.PANEL_VISION_INBOUND_IDS || process.env.PANEL_EXTRA_INBOUND_IDS || process.env.PANEL_SECONDARY_INBOUND_ID || '')
    .split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value > 0);
  // CDN/HTTP transports cannot use xtls-rprx-vision. They receive a second
  // client record with the same UUID and subId, but an empty flow.
  const cdnInboundIds = String(config.cdnInboundIds || process.env.PANEL_CDN_INBOUND_IDS || '')
    .split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value > 0);
  // 3X-UI stores one logical client record across protocols. When that
  // identity is attached to a Hysteria v2 inbound, the panel creates and
  // persists the protocol-specific `auth` secret while retaining the same
  // email and subId, so the normal subscription URL includes both routes.
  const hysteriaInboundIds = String(config.hysteriaInboundIds || process.env.PANEL_HYSTERIA_INBOUND_IDS || '')
    .split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value > 0);
  // A single Nivora subscription is intentionally present in more than one
  // inbound. X-UI counts those parallel transports as separate source IPs,
  // including Cloudflare edges, so an IP limiter breaks automatic fallback.
  // Keep it opt-in: deployments that do not use multi-route subscriptions can
  // retain their legacy device limit.
  const disableIpLimit = config.disableIpLimit ?? process.env.PANEL_DISABLE_IP_LIMIT === 'true';
  const subscriptionBaseUrl = config.subscriptionBaseUrl || process.env.PANEL_SUBSCRIPTION_BASE_URL;
  const rejectUnauthorized = config.rejectUnauthorized ?? process.env.PANEL_TLS_REJECT_UNAUTHORIZED !== 'false';
  if (!baseUrl || !apiToken || !inboundId || !subscriptionBaseUrl) throw new Error('3X-UI provisioning configuration is incomplete');

  const call = async (method, path, body) => {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/panel/api/${path.replace(/^\//, '')}`);
    const result = await transport({ url, method, token: apiToken, body, rejectUnauthorized });
    if (result.success === false) throw new Error(result.msg || '3X-UI operation failed');
    return result.obj ?? result;
  };

  const provision = async order => {
    const payload = buildClientPayload(order, inboundId, extraInboundIds, disableIpLimit ? 0 : order.device_limit);
    const added = await call('POST', 'clients/add', payload);
    let client = added?.client || added;
    if (!client?.subId) client = payload.client;
    if (cdnInboundIds.length) {
      await call('POST', 'clients/add', buildCompatibleClientPayload(client, cdnInboundIds, '', 0));
    }
    if (hysteriaInboundIds.length) {
      await call('POST', 'clients/add', buildCompatibleClientPayload(client, hysteriaInboundIds, '', 0));
    }
    if (!client?.subId) {
      try {
        const obj = await call('GET', `clients/get/${encodeURIComponent(payload.client.email)}`);
        client = obj?.client || obj;
      } catch (error) {
        if (!client?.subId) throw error;
      }
    }
    if (!client?.subId) throw new Error('3X-UI did not return a subscription ID');
    return {
      panelClientId: payload.client.email,
      subscriptionUrl: `${subscriptionBaseUrl.replace(/\/$/, '')}/${client.subId}`
    };
  };
  provision.renew = async ({panelClientId,addDays,addTrafficGb}) => {
    const result=await call('POST','clients/bulkAdjust',{emails:[panelClientId],addDays:Number(addDays),addBytes:Number(addTrafficGb)*GB,flow:''});
    if(result?.adjusted!==undefined&&result.adjusted<1)throw new Error(result?.skipped?.[0]?.reason||'3X-UI did not adjust client');
    return result;
  };
  provision.suspend=async ({panelClientId})=>call('POST','clients/bulkDisable',{emails:[panelClientId]});
  provision.resume=async ({panelClientId})=>call('POST','clients/bulkEnable',{emails:[panelClientId]});
  provision.remove=async ({panelClientId})=>call('POST','clients/bulkDel',{emails:[panelClientId],keepTraffic:true});
  return provision;
}
