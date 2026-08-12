// Nivora auto-review agent.
// Confirms card-to-card receipts by matching pending orders against real bank
// deposits ingested from SMS. Policy is deliberately conservative: only
// unambiguous matches are auto-approved, clear reuse is auto-rejected, and
// everything else is left for a human (status stays `under_review`).

import { randomUUID, createHash } from 'node:crypto';
import { parseBankMessage } from './bank-sms.js';

const HOUR = 3_600_000;

export function loadAutoReviewConfig(env = process.env) {
  return {
    enabled: env.AUTO_REVIEW_ENABLED !== 'false',
    ocrEnabled: env.RECEIPT_OCR_ENABLED === 'true',
    amountToleranceRial: Math.max(0, Number(env.AUTO_REVIEW_AMOUNT_TOLERANCE_RIAL) || 0),
    lookbackHours: Math.max(1, Number(env.AUTO_REVIEW_LOOKBACK_HOURS) || 24),
    defaultSmsUnit: env.BANK_SMS_DEFAULT_UNIT === 'toman' ? 'toman' : 'rial'
  };
}

export const normalizeTracking = code => {
  const digits = String(code || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits : '';
};

const dedupeKey = (source, sender, receivedAt, message) =>
  createHash('sha256').update(`${source}|${sender}|${receivedAt}|${message}`).digest('hex').slice(0, 32);

// Accept ISO strings, epoch seconds or epoch milliseconds (forwarder apps vary).
export function toIsoTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    const n = Number(String(value).trim());
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Store one incoming bank message. Non-credit or amountless messages are kept as
// `ignored` for auditing but never used for matching.
export function ingestBankMessage(db, { message, receivedAt, sender = '', source = 'sms', defaultUnit = 'rial' }) {
  const parsed = parseBankMessage(message, { defaultUnit });
  const now = new Date().toISOString();
  const received = toIsoTimestamp(receivedAt) || now;
  const usable = parsed.direction === 'credit' && parsed.amountRial > 0;
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO bank_transactions
      (id,amount_rial,tracking_code,card_last4,bank,direction,raw_message,source,status,matched_order_id,received_at,created_at,dedupe_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, parsed.amountRial || 0, parsed.trackingCode, parsed.cardLast4, parsed.bank, parsed.direction,
      parsed.raw, source, usable ? 'unmatched' : 'ignored', null, received, now,
      dedupeKey(source, sender, received, message)
    );
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return { duplicate: true, parsed };
    throw error;
  }
  return { id, duplicate: false, usable, parsed };
}

function lastReview(db, orderId) {
  return db.prepare('SELECT * FROM order_reviews WHERE order_id=? ORDER BY created_at DESC LIMIT 1').get(orderId);
}

function recordReview(db, { orderId, decision, confidence, reason, bankTxId = null, ocr = null }) {
  db.prepare(`INSERT INTO order_reviews(id,order_id,decision,confidence,reason,matched_bank_tx_id,ocr_amount_rial,ocr_tracking_code,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), orderId, decision, confidence, reason, bankTxId,
    ocr?.amountRial ?? null, ocr?.trackingCode ?? null, new Date().toISOString()
  );
}

// Evaluate a single order. `provisionApproved(orderId)` runs the shared
// provisioning path from app.js; `ocrExtract(imageUrl)` is optional.
export async function evaluateOrder(db, orderId, { config = loadAutoReviewConfig(), provisionApproved, ocrExtract, actor = 'agent' } = {}) {
  const order = db.prepare(`SELECT o.*, p.price_irr AS expected_rial
    FROM orders o JOIN plans p ON p.id=o.plan_id WHERE o.id=?`).get(orderId);
  if (!order) return { decision: 'skip', reason: 'ORDER_NOT_FOUND' };
  if (order.status !== 'under_review') return { decision: 'skip', reason: 'NOT_UNDER_REVIEW' };

  const expected = Number(order.expected_rial);
  const tolerance = config.amountToleranceRial;
  let submittedRef = normalizeTracking(order.receipt_reference);

  // Optional OCR — only to recover a missing tracking code and for the audit trail.
  let ocr = null;
  if (config.ocrEnabled && ocrExtract && order.receipt_image_url) {
    ocr = await ocrExtract(order.receipt_image_url).catch(() => null);
    if (!submittedRef && ocr?.trackingCode) submittedRef = normalizeTracking(ocr.trackingCode);
  }

  // Reuse / duplicate: the same tracking code already consumed by another order.
  if (submittedRef) {
    const reused = db.prepare(`SELECT id FROM bank_transactions
      WHERE status='matched' AND matched_order_id IS NOT NULL AND matched_order_id<>? AND REPLACE(tracking_code,' ','')=?`).get(order.id, submittedRef);
    const twinOrder = db.prepare(`SELECT id FROM orders WHERE id<>? AND status='approved' AND REPLACE(receipt_reference,' ','')=?`).get(order.id, submittedRef);
    if (reused || twinOrder) {
      db.prepare("UPDATE orders SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'")
        .run('کد پیگیری تکراری/استفاده‌شده', actor, new Date().toISOString(), order.id);
      recordReview(db, { orderId: order.id, decision: 'rejected', confidence: 90, reason: 'کد پیگیری قبلاً برای سفارش دیگری استفاده شده است', ocr });
      return { decision: 'rejected', confidence: 90, reason: 'DUPLICATE_TRACKING' };
    }
  }

  const now = Date.now();
  const windowStart = new Date(new Date(order.created_at).getTime() - config.lookbackHours * HOUR).toISOString();
  const nowIso = new Date(now).toISOString();
  const low = expected - tolerance, high = expected + tolerance;

  // Prefer an exact tracking-code match; fall back to a unique same-amount deposit.
  let chosen = null, confidence = 0, reason = '';
  if (submittedRef) {
    chosen = db.prepare(`SELECT * FROM bank_transactions
      WHERE status='unmatched' AND direction='credit' AND REPLACE(tracking_code,' ','')=?
        AND amount_rial BETWEEN ? AND ? AND received_at>=? AND received_at<=? ORDER BY received_at LIMIT 1`)
      .get(submittedRef, low, high, windowStart, nowIso);
    if (chosen) { confidence = 96; reason = 'کد پیگیری و مبلغ با واریز بانکی مطابقت دارد'; }
  }
  if (!chosen) {
    const amountMatches = db.prepare(`SELECT * FROM bank_transactions
      WHERE status='unmatched' AND direction='credit' AND amount_rial BETWEEN ? AND ?
        AND received_at>=? AND received_at<=? ORDER BY received_at`).all(low, high, windowStart, nowIso);
    if (amountMatches.length === 1) { chosen = amountMatches[0]; confidence = 82; reason = 'یک واریز بانکی هم‌مبلغ در بازه زمانی یافت شد'; }
    else if (amountMatches.length > 1) { confidence = 45; reason = 'چند واریز هم‌مبلغ یافت شد؛ نیاز به بررسی دستی'; }
    else { confidence = 0; reason = 'واریز متناظری در پیامک‌های بانکی یافت نشد'; }
  }

  if (!chosen) {
    // Manual: keep under_review; avoid writing an identical manual row repeatedly.
    const previous = lastReview(db, order.id);
    if (!previous || previous.decision !== 'manual' || previous.reason !== reason) {
      recordReview(db, { orderId: order.id, decision: 'manual', confidence, reason, ocr });
    }
    return { decision: 'manual', confidence, reason };
  }

  // Consume the deposit and approve the order atomically; provision after commit.
  db.exec('BEGIN IMMEDIATE');
  try {
    const consumed = db.prepare("UPDATE bank_transactions SET status='matched',matched_order_id=? WHERE id=? AND status='unmatched'").run(order.id, chosen.id);
    if (!consumed.changes) throw new Error('TX_ALREADY_CONSUMED');
    const approved = db.prepare("UPDATE orders SET status='approved',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'")
      .run(reason, actor, new Date().toISOString(), order.id);
    if (!approved.changes) throw new Error('ORDER_ALREADY_HANDLED');
    recordReview(db, { orderId: order.id, decision: 'approved', confidence, reason, bankTxId: chosen.id, ocr });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return { decision: 'manual', confidence: 0, reason: 'RACE_RETRY' };
  }

  if (provisionApproved) {
    try { await provisionApproved(order.id); }
    catch { /* order stays approved; provisioning can be retried by admin */ }
  }
  return { decision: 'approved', confidence, reason, bankTxId: chosen.id };
}

// Sweep every under_review purchase/renewal order still within the lookback window.
export async function sweepPendingOrders(db, deps = {}) {
  const config = deps.config || loadAutoReviewConfig();
  if (!config.enabled) return { evaluated: 0, approved: 0, rejected: 0 };
  const cutoff = new Date(Date.now() - config.lookbackHours * HOUR).toISOString();
  const orders = db.prepare("SELECT id FROM orders WHERE status='under_review' AND created_at>=? ORDER BY created_at").all(cutoff);
  let approved = 0, rejected = 0;
  for (const { id } of orders) {
    const result = await evaluateOrder(db, id, { ...deps, config });
    if (result.decision === 'approved') approved++;
    else if (result.decision === 'rejected') rejected++;
  }
  return { evaluated: orders.length, approved, rejected };
}
