import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;

export function buildClientPayload(order, inboundId) {
  const safePhone = String(order.phone).replace(/\D/g, '');
  const suffix = String(order.id).replace(/-/g, '').slice(0, 8);
  return {
    client: {
      email: `nivo-${safePhone}-${suffix}`,
      comment: `Nivora order ${order.id} - ${order.plan_name}`,
      totalGB: Number(order.traffic_gb) * GB,
      expiryTime: -(Number(order.duration_days) * DAY),
      tgId: 0,
      limitIp: Number(order.device_limit),
      enable: true,
      flow: 'xtls-rprx-vision'
      ,subId: randomUUID()
    },
    inboundIds: [Number(order.panel_inbound_id || inboundId)]
  };
}

function nodeRequest({ url, method, token, body, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
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
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`3X-UI HTTP ${res.statusCode}`));
          resolve(data);
        } catch { reject(new Error('3X-UI returned invalid JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('3X-UI request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function createThreeXuiProvisioner(config = {}, transport = nodeRequest) {
  const baseUrl = config.baseUrl || process.env.PANEL_BASE_URL;
  const apiToken = config.apiToken || process.env.PANEL_API_TOKEN;
  const inboundId = Number(config.inboundId || process.env.PANEL_INBOUND_ID);
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
    const payload = buildClientPayload(order, inboundId);
    const added = await call('POST', 'clients/add', payload);
    let client = added?.client || added;
    if (!client?.subId) client = payload.client;
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
  return provision;
}
