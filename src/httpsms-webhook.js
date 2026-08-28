import { createHmac, timingSafeEqual } from 'node:crypto';

export const HTTPSMS_EVENT_TYPE = 'message.phone.received';

export class HttpSmsWebhookError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'HttpSmsWebhookError';
    this.code = code;
    this.status = status;
  }
}

const decodeJsonSegment = (segment, errorCode) => {
  if (!/^[A-Za-z0-9_-]+$/.test(segment || '')) throw new HttpSmsWebhookError(errorCode, 401);
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new HttpSmsWebhookError(errorCode, 401);
  }
};

const numericClaim = (claims, name) => {
  const value = Number(claims?.[name]);
  if (!Number.isFinite(value)) throw new HttpSmsWebhookError(`HTTPSMS_JWT_${name.toUpperCase()}_INVALID`, 401);
  return value;
};

// httpSMS signs webhook requests with a short-lived HS256 JWT.  The official
// sender uses issuer api.httpsms.com, the exact webhook URL as audience, and a
// ten-minute lifetime.  Do not accept algorithm negotiation or timeless tokens.
export function verifyHttpSmsJwt(token, {
  signingKey,
  audience,
  issuer = 'api.httpsms.com',
  expectedSubject = '',
  now = Date.now(),
  clockSkewSeconds = 90,
  maxLifetimeSeconds = 15 * 60
} = {}) {
  if (typeof signingKey !== 'string' || Buffer.byteLength(signingKey) < 32) {
    throw new HttpSmsWebhookError('HTTPSMS_SIGNING_KEY_NOT_CONFIGURED', 503);
  }
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new HttpSmsWebhookError('HTTPSMS_JWT_MALFORMED', 401);
  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeJsonSegment(encodedHeader, 'HTTPSMS_JWT_HEADER_INVALID');
  const claims = decodeJsonSegment(encodedPayload, 'HTTPSMS_JWT_PAYLOAD_INVALID');
  if (header.alg !== 'HS256' || (header.typ && header.typ !== 'JWT') || header.crit !== undefined) {
    throw new HttpSmsWebhookError('HTTPSMS_JWT_ALGORITHM_INVALID', 401);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(signature || '')) throw new HttpSmsWebhookError('HTTPSMS_JWT_SIGNATURE_INVALID', 401);
  const expected = createHmac('sha256', signingKey).update(`${encodedHeader}.${encodedPayload}`).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); }
  catch { throw new HttpSmsWebhookError('HTTPSMS_JWT_SIGNATURE_INVALID', 401); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new HttpSmsWebhookError('HTTPSMS_JWT_SIGNATURE_INVALID', 401);
  }

  if (claims.iss !== issuer) throw new HttpSmsWebhookError('HTTPSMS_JWT_ISSUER_INVALID', 401);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience || !audiences.includes(audience)) throw new HttpSmsWebhookError('HTTPSMS_JWT_AUDIENCE_INVALID', 401);
  if (typeof claims.sub !== 'string' || !claims.sub || (expectedSubject && claims.sub !== expectedSubject)) {
    throw new HttpSmsWebhookError('HTTPSMS_JWT_SUBJECT_INVALID', 401);
  }

  const nowSeconds = Math.floor(now / 1000), exp = numericClaim(claims, 'exp');
  const iat = numericClaim(claims, 'iat'), nbf = numericClaim(claims, 'nbf');
  if (exp <= nowSeconds - clockSkewSeconds) throw new HttpSmsWebhookError('HTTPSMS_JWT_EXPIRED', 401);
  if (nbf > nowSeconds + clockSkewSeconds || iat > nowSeconds + clockSkewSeconds) {
    throw new HttpSmsWebhookError('HTTPSMS_JWT_NOT_ACTIVE', 401);
  }
  if (exp <= iat || exp - iat > maxLifetimeSeconds) {
    throw new HttpSmsWebhookError('HTTPSMS_JWT_LIFETIME_INVALID', 401);
  }
  return claims;
}

export const normalizeHttpSmsOwner = value => String(value || '')
  .trim()
  .replace(/[\s\-()]/g, '')
  .replace(/^0098/, '+98')
  .replace(/^0(?=9\d{9}$)/, '+98');

// Convert the CloudEvents JSON emitted by httpSMS into the narrow shape used by
// the bank-message ingestion pipeline.  Only the received-message event is
// accepted; outgoing/delivery events can never enter financial matching.
export function parseHttpSmsEvent(body, { eventTypeHeader, expectedOwner = '' } = {}) {
  if (eventTypeHeader !== HTTPSMS_EVENT_TYPE) {
    throw new HttpSmsWebhookError('HTTPSMS_EVENT_IGNORED', 200);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.type !== HTTPSMS_EVENT_TYPE) {
    throw new HttpSmsWebhookError('HTTPSMS_EVENT_INVALID');
  }
  const eventId = String(body.id || '').trim();
  if (!eventId || eventId.length > 200) throw new HttpSmsWebhookError('HTTPSMS_EVENT_ID_INVALID');
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpSmsWebhookError('HTTPSMS_EVENT_DATA_INVALID');
  const owner = normalizeHttpSmsOwner(data.owner);
  const wantedOwner = normalizeHttpSmsOwner(expectedOwner);
  if (!owner || owner.length > 32 || (wantedOwner && owner !== wantedOwner)) {
    throw new HttpSmsWebhookError('HTTPSMS_OWNER_INVALID', 403);
  }
  const message = String(data.content ?? '');
  if (!message.trim() || message.length > 20_000) throw new HttpSmsWebhookError('HTTPSMS_MESSAGE_INVALID');
  const sender = String(data.contact || '').trim().slice(0, 100);
  const receivedAt = data.timestamp || body.time || null;
  if (receivedAt && Number.isNaN(new Date(receivedAt).getTime())) throw new HttpSmsWebhookError('HTTPSMS_TIMESTAMP_INVALID');
  const messageId = String(data.message_id || '').trim();
  const userId = String(data.user_id || '').trim();
  if (!messageId || messageId.length > 200) throw new HttpSmsWebhookError('HTTPSMS_MESSAGE_ID_INVALID');
  if (!userId || userId.length > 200) throw new HttpSmsWebhookError('HTTPSMS_USER_ID_INVALID');
  const sim = String(data.sim || '').trim().toUpperCase();
  if (sim && !['SIM1','SIM2'].includes(sim)) throw new HttpSmsWebhookError('HTTPSMS_SIM_INVALID');
  return {
    eventId,
    messageId,
    userId,
    message,
    sender,
    owner,
    sim,
    receivedAt,
    encrypted: data.encrypted === true
  };
}
