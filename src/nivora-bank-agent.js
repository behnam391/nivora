import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class BankAgentError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

const clean = value => String(value ?? '').trim();
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function bankAgentSigningPayload({ agentId, timestamp, nonce, eventId, sender, receivedAt, message }) {
  return [agentId, timestamp, nonce, eventId, sender, receivedAt, sha256(message)].map(clean).join('\n');
}

export function verifyBankAgentRequest({ headers, body, secret, expectedAgentId, now = Date.now(), maxClockSkewMs = 5 * 60_000 }) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new BankAgentError('BANK_AGENT_DISABLED', 503);
  const agentId = clean(headers['x-nivora-agent-id']);
  const timestamp = clean(headers['x-nivora-timestamp']);
  const nonce = clean(headers['x-nivora-nonce']);
  const signature = clean(headers['x-nivora-signature']).toLowerCase();
  if (!agentId || agentId !== expectedAgentId) throw new BankAgentError('BANK_AGENT_UNKNOWN', 401);
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > maxClockSkewMs) throw new BankAgentError('BANK_AGENT_TIMESTAMP', 401);
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) throw new BankAgentError('BANK_AGENT_SIGNATURE', 401);
  const eventId = clean(body?.eventId), sender = clean(body?.sender), receivedAt = clean(body?.receivedAt), message = clean(body?.message);
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(eventId) || !sender || sender.length > 100 || !message || message.length > 10_000 || !receivedAt) throw new BankAgentError('BANK_AGENT_EVENT_INVALID');
  const payload = bankAgentSigningPayload({ agentId, timestamp, nonce, eventId, sender, receivedAt, message });
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new BankAgentError('BANK_AGENT_SIGNATURE', 401);
  return { agentId, timestamp: Number(timestamp), nonce, eventId, sender, receivedAt, message };
}
