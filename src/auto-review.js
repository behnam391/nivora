// Nivora payment-review agent.
// A payment is approved automatically only when a real bank credit, its exact
// tracking code, its exact amount, and its time window agree. Amount-only
// matching is disabled by default and must be enabled explicitly.

import { randomUUID, createHash } from 'node:crypto';
import { parseBankMessage } from './bank-sms.js';
import { postWalletTransactionInTransaction } from './wallet.js';

const HOUR = 3_600_000;
const SAFE_PRE_REQUEST_WINDOW_MS = 15 * 60_000;
const MIN_AUTO_REVIEW_TRACKING_DIGITS = 6;

const boundedNumber = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

export function loadAutoReviewConfig(env = process.env) {
  return {
    enabled: env.AUTO_REVIEW_ENABLED === 'true',
    ocrEnabled: env.RECEIPT_OCR_ENABLED === 'true',
    allowAmountOnly: env.AUTO_REVIEW_ALLOW_AMOUNT_ONLY === 'true',
    trustedAgentOnly: env.AUTO_REVIEW_TRUSTED_AGENT_ONLY !== 'false',
    amountToleranceRial: Math.round(boundedNumber(env.AUTO_REVIEW_AMOUNT_TOLERANCE_RIAL, 0, 0, 10_000_000)),
    lookbackHours: Math.round(boundedNumber(env.AUTO_REVIEW_LOOKBACK_HOURS, 2, 1, 24)),
    defaultSmsUnit: env.BANK_SMS_DEFAULT_UNIT === 'toman' ? 'toman' : 'rial'
  };
}

export const normalizeTracking = code => {
  const digits = String(code || '').replace(/\D/g, '');
  // Four/five-digit values are too small to use as bearer proof. Some Iranian
  // banks issue six-digit trace numbers, so compatibility is kept at six while
  // the API additionally caps pending guesses, binds a one-use receipt upload,
  // requires the exact amount and uses a narrow time window.
  return digits.length >= MIN_AUTO_REVIEW_TRACKING_DIGITS && digits.length <= 20 ? digits : '';
};

const dedupeKey = ({ source, sender, receivedAt, message, providerEventId }) => createHash('sha256')
  .update(providerEventId ? `${source}|event|${providerEventId}` : `${source}|${sender}|${receivedAt}|${message}`)
  .digest('hex').slice(0, 32);

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

export function ingestBankMessage(db, {
  message,
  receivedAt,
  sender = '',
  source = 'sms',
  defaultUnit = 'rial',
  providerEventId = null,
  providerMessageId = null,
  destination = null,
  forceIgnored = false,
  requireExplicitUnit = false
}) {
  const parsed = parseBankMessage(message, { defaultUnit });
  const now = new Date().toISOString(), received = toIsoTimestamp(receivedAt) || now;
  const usable = !forceIgnored && (!requireExplicitUnit || Boolean(parsed.unit)) && parsed.direction === 'credit' && parsed.amountRial > 0;
  const id = randomUUID(), eventId = String(providerEventId || '').trim() || null, messageId = String(providerMessageId || '').trim() || null;
  const redactedMessage = JSON.stringify({
    redacted: true,
    direction: parsed.direction,
    bank: parsed.bank,
    amountRial: parsed.amountRial || 0,
    trackingSuffix: parsed.trackingCode ? String(parsed.trackingCode).slice(-4) : null,
    cardLast4: parsed.cardLast4 || null
  });
  try {
    db.prepare(`INSERT INTO bank_transactions
      (id,amount_rial,tracking_code,card_last4,destination_card_last4,bank,direction,raw_message,source,status,matched_order_id,matched_topup_id,provider_event_id,provider_message_id,destination,received_at,created_at,dedupe_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, parsed.amountRial || 0, parsed.trackingCode, parsed.cardLast4, parsed.destinationCardLast4,
      parsed.bank, parsed.direction, redactedMessage, source, usable ? 'unmatched' : 'ignored', null, null,
      eventId, messageId, destination, received, now, dedupeKey({ source, sender, receivedAt: received, message, providerEventId: eventId })
    );
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return { duplicate: true, parsed, providerEventId: eventId };
    throw error;
  }
  return { id, duplicate: false, usable, parsed, providerEventId: eventId };
}

const lastOrderReview = (db, orderId) => db.prepare('SELECT * FROM order_reviews WHERE order_id=? ORDER BY created_at DESC LIMIT 1').get(orderId);
function recordOrderReview(db, { orderId, decision, confidence, reason, bankTxId = null, ocr = null }) {
  db.prepare(`INSERT INTO order_reviews(id,order_id,decision,confidence,reason,matched_bank_tx_id,ocr_amount_rial,ocr_tracking_code,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), orderId, decision, confidence, reason, bankTxId, ocr?.amountRial ?? null, ocr?.trackingCode ?? null, new Date().toISOString());
}

const lastTopupReview = (db, topupId) => db.prepare('SELECT * FROM wallet_topup_reviews WHERE topup_id=? ORDER BY created_at DESC LIMIT 1').get(topupId);
function recordTopupReview(db, { topupId, decision, confidence, reason, bankTxId = null }) {
  const previous = lastTopupReview(db, topupId);
  if (decision === 'manual' && previous?.decision === decision && previous?.reason === reason) return;
  db.prepare(`INSERT INTO wallet_topup_reviews(id,topup_id,decision,confidence,reason,matched_bank_tx_id,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), topupId, decision, confidence, reason, bankTxId, new Date().toISOString());
}

function destinationCardMatches(db, transaction) {
  if (!transaction?.destination_card_last4) return true;
  const cards = db.prepare('SELECT card_number FROM payment_cards WHERE active=1').all();
  if (!cards.length) return true;
  return cards.some(card => String(card.card_number || '').replace(/\D/g, '').endsWith(transaction.destination_card_last4));
}

function usedTrackingExists(db, tracking, entityType, entityId) {
  if (!tracking) return false;
  const bankUse = db.prepare(`SELECT id,matched_order_id,matched_topup_id FROM bank_transactions
    WHERE status='matched' AND REPLACE(COALESCE(tracking_code,''),' ','')=? LIMIT 1`).get(tracking);
  if (bankUse && (entityType !== 'order' || bankUse.matched_order_id !== entityId) &&
      (entityType !== 'wallet_topup' || bankUse.matched_topup_id !== entityId)) return true;
  const orderRefs = db.prepare("SELECT id,receipt_reference FROM orders WHERE status='approved' AND receipt_reference IS NOT NULL").all();
  if (orderRefs.some(row => !(entityType === 'order' && row.id === entityId) && normalizeTracking(row.receipt_reference) === tracking)) return true;
  const topupRefs = db.prepare("SELECT id,receipt_reference FROM wallet_topups WHERE status='approved' AND receipt_reference IS NOT NULL").all();
  return topupRefs.some(row => !(entityType === 'wallet_topup' && row.id === entityId) && normalizeTracking(row.receipt_reference) === tracking);
}

function hasOneUseReceiptBinding(db, imageUrl, entityType, entityId) {
  let filename = '';
  try {
    const pathname = new URL(String(imageUrl || ''), 'http://nivora.local').pathname;
    filename = pathname.match(/^\/receipts\/([a-f0-9-]+\.(?:jpg|jpeg|png|webp))$/i)?.[1] || '';
  } catch { return false; }
  if (!filename) return false;
  return Boolean(db.prepare(`SELECT 1 FROM receipt_uploads
    WHERE filename=? AND linked_entity_type=? AND linked_entity_id=?`).get(filename, entityType, entityId));
}

function selectBankMatch(db, { submittedRef, expectedRial, tolerance, windowStart, windowEnd, allowAmountOnly, trustedAgentOnly = true, uniqueEntityCount = 1 }) {
  const low = expectedRial - tolerance, high = expectedRial + tolerance;
  if (submittedRef) {
    const exact = db.prepare(`SELECT * FROM bank_transactions
      WHERE status='unmatched' AND direction='credit' AND REPLACE(COALESCE(tracking_code,''),' ','')=?
        AND amount_rial BETWEEN ? AND ? AND received_at>=? AND received_at<=? ORDER BY received_at`).all(submittedRef, low, high, windowStart, windowEnd);
    if (exact.length === 1) return { transaction: exact[0], confidence: 98, reason: 'کد پیگیری و مبلغ دقیقاً با واریز بانکی مطابقت دارد' };
    if (exact.length > 1) return { transaction: null, confidence: 40, reason: 'چند واریز با کد پیگیری یکسان یافت شد؛ نیاز به بررسی دستی' };
    return { transaction: null, confidence: 0, reason: 'کد پیگیری و مبلغ با هیچ واریز بانکی مطابقت ندارد' };
  }
  if (!allowAmountOnly) return { transaction: null, confidence: 0, reason: 'تأیید خودکار بدون کد پیگیری غیرفعال است' };
  const matches = db.prepare(`SELECT * FROM bank_transactions
    WHERE status='unmatched' AND direction='credit' AND amount_rial BETWEEN ? AND ?
      AND received_at>=? AND received_at<=? AND (?=0 OR source='nivora-agent') ORDER BY received_at`).all(low, high, windowStart, windowEnd,trustedAgentOnly?1:0);
  if (matches.length === 1 && uniqueEntityCount === 1) return { transaction: matches[0], confidence: 80, reason: 'واریز هم‌مبلغ یکتا با سیاست مبلغ‌محور صریح مطابقت دارد' };
  return { transaction: null, confidence: matches.length ? 35 : 0, reason: matches.length ? 'تطبیق مبلغ مبهم است؛ نیاز به بررسی دستی' : 'واریز هم‌مبلغی یافت نشد' };
}

export function approveWalletTopup(db, topupId, { actor = 'admin', note = 'تأیید بانکی', bankTxId = null, confidence = 100, reason = note } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const topup = db.prepare('SELECT * FROM wallet_topups WHERE id=?').get(topupId);
    if (!topup) throw new Error('TOPUP_NOT_FOUND');
    if (topup.status !== 'under_review') throw new Error('TOPUP_NOT_REVIEWABLE');
    if (bankTxId) {
      const consumed = db.prepare("UPDATE bank_transactions SET status='matched',matched_topup_id=? WHERE id=? AND status='unmatched'").run(topup.id, bankTxId);
      if (!consumed.changes) throw new Error('BANK_TRANSACTION_ALREADY_CONSUMED');
    }
    const now = new Date().toISOString();
    const approved = db.prepare("UPDATE wallet_topups SET status='approved',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'").run(note, actor, now, topup.id);
    if (!approved.changes) throw new Error('TOPUP_NOT_REVIEWABLE');
    const wallet = postWalletTransactionInTransaction(db, {
      accountId: topup.account_id,
      amountToman: topup.amount_toman,
      type: 'transfer_in',
      reference: `wallet-topup:${topup.id}`,
      actor,
      note: `شارژ کیف پول با رسید ${topup.receipt_reference || ''}`
    });
    recordTopupReview(db, { topupId: topup.id, decision: 'approved', confidence, reason, bankTxId });
    db.exec('COMMIT');
    return { ...topup, status: 'approved', balanceToman: wallet.balanceToman, walletTransactionId: wallet.id };
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error.message).includes('UNIQUE constraint failed')) throw new Error('TOPUP_ALREADY_CREDITED');
    throw error;
  }
}

export async function evaluateWalletTopup(db, topupId, { config = loadAutoReviewConfig(), ocrExtract, actor = 'httpsms-agent', onApproved } = {}) {
  const topup = db.prepare('SELECT * FROM wallet_topups WHERE id=?').get(topupId);
  if (!topup) return { decision: 'skip', reason: 'TOPUP_NOT_FOUND' };
  if (topup.status !== 'under_review') return { decision: 'skip', reason: 'TOPUP_NOT_REVIEWABLE' };
  const receiptBound=hasOneUseReceiptBinding(db, topup.receipt_image_url, 'wallet_topup', topup.id);
  if (!receiptBound && !config.allowAmountOnly) {
    const reason = 'تصویر رسید امن و یک‌بارمصرف به این درخواست متصل نیست؛ نیاز به بررسی دستی';
    recordTopupReview(db, { topupId: topup.id, decision: 'manual', confidence: 0, reason });
    return { decision: 'manual', confidence: 0, reason: 'RECEIPT_BINDING_REQUIRED' };
  }
  let submittedRef = normalizeTracking(topup.receipt_reference), ocr = null;
  if (!submittedRef && config.ocrEnabled && ocrExtract && topup.receipt_image_url) {
    ocr = await ocrExtract(topup.receipt_image_url).catch(() => null);
    submittedRef = normalizeTracking(ocr?.trackingCode);
  }
  if (usedTrackingExists(db, submittedRef, 'wallet_topup', topup.id)) {
    db.prepare("UPDATE wallet_topups SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'").run('کد پیگیری تکراری/استفاده‌شده', actor, new Date().toISOString(), topup.id);
    recordTopupReview(db, { topupId: topup.id, decision: 'rejected', confidence: 99, reason: 'کد پیگیری قبلاً استفاده شده است' });
    return { decision: 'rejected', confidence: 99, reason: 'DUPLICATE_TRACKING' };
  }
  const expectedRial = Number(topup.amount_toman) * 10, tolerance = config.amountToleranceRial;
  // A bank SMS may arrive shortly before the customer submits the receipt, but
  // an old credit must never be claimable hours later by pre-seeding a request.
  const windowStart = new Date(new Date(topup.created_at).getTime() - SAFE_PRE_REQUEST_WINDOW_MS).toISOString(), windowEnd = new Date().toISOString();
  const similarTopups = db.prepare(`SELECT COUNT(*) count FROM wallet_topups
    WHERE status='under_review' AND amount_toman*10 BETWEEN ? AND ? AND created_at>=? AND created_at<=?`).get(expectedRial - tolerance, expectedRial + tolerance, windowStart, windowEnd).count;
  let selected = selectBankMatch(db, { submittedRef, expectedRial, tolerance, windowStart, windowEnd, allowAmountOnly: config.allowAmountOnly, trustedAgentOnly:config.trustedAgentOnly, uniqueEntityCount: Number(similarTopups) });
  if (selected.transaction && !destinationCardMatches(db, selected.transaction)) selected = { transaction: null, confidence: 10, reason: 'کارت مقصد پیامک با کارت فعال سامانه مطابقت ندارد' };
  if (!selected.transaction) {
    recordTopupReview(db, { topupId: topup.id, decision: 'manual', confidence: selected.confidence, reason: selected.reason });
    return { decision: 'manual', confidence: selected.confidence, reason: selected.reason };
  }
  try {
    const approved = approveWalletTopup(db, topup.id, { actor, note: selected.reason, bankTxId: selected.transaction.id, confidence: selected.confidence, reason: selected.reason });
    try { await onApproved?.(approved); } catch { /* notification must not roll back money */ }
    return { decision: 'approved', confidence: selected.confidence, reason: selected.reason, bankTxId: selected.transaction.id, balanceToman: approved.balanceToman };
  } catch (error) {
    if (['TOPUP_NOT_REVIEWABLE','BANK_TRANSACTION_ALREADY_CONSUMED','TOPUP_ALREADY_CREDITED'].includes(error.message)) return { decision: 'manual', confidence: 0, reason: 'RACE_RETRY' };
    throw error;
  }
}

export async function evaluateOrder(db, orderId, { config = loadAutoReviewConfig(), provisionApproved, ocrExtract, actor = 'agent' } = {}) {
  const order = db.prepare(`SELECT o.*, p.price_irr AS expected_rial FROM orders o JOIN plans p ON p.id=o.plan_id WHERE o.id=?`).get(orderId);
  if (!order) return { decision: 'skip', reason: 'ORDER_NOT_FOUND' };
  if (order.status !== 'under_review') return { decision: 'skip', reason: 'NOT_UNDER_REVIEW' };
  const receiptBound=hasOneUseReceiptBinding(db, order.receipt_image_url, 'order', order.id);
  if (!receiptBound && !config.allowAmountOnly) {
    const reason = 'تصویر رسید امن و یک‌بارمصرف به این سفارش متصل نیست؛ نیاز به بررسی دستی';
    const previous = lastOrderReview(db, order.id);
    if (!previous || previous.decision !== 'manual' || previous.reason !== reason) {
      recordOrderReview(db, { orderId: order.id, decision: 'manual', confidence: 0, reason });
    }
    return { decision: 'manual', confidence: 0, reason: 'RECEIPT_BINDING_REQUIRED' };
  }
  const expected = Number(order.expected_rial), tolerance = config.amountToleranceRial;
  let submittedRef = normalizeTracking(order.receipt_reference), ocr = null;
  if (config.ocrEnabled && ocrExtract && order.receipt_image_url) {
    ocr = await ocrExtract(order.receipt_image_url).catch(() => null);
    if (!submittedRef && ocr?.trackingCode) submittedRef = normalizeTracking(ocr.trackingCode);
  }
  if (usedTrackingExists(db, submittedRef, 'order', order.id)) {
    db.prepare("UPDATE orders SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'").run('کد پیگیری تکراری/استفاده‌شده', actor, new Date().toISOString(), order.id);
    recordOrderReview(db, { orderId: order.id, decision: 'rejected', confidence: 99, reason: 'کد پیگیری قبلاً استفاده شده است', ocr });
    return { decision: 'rejected', confidence: 99, reason: 'DUPLICATE_TRACKING' };
  }
  const windowStart = new Date(new Date(order.created_at).getTime() - SAFE_PRE_REQUEST_WINDOW_MS).toISOString(), windowEnd = new Date().toISOString();
  const similarOrders = db.prepare(`SELECT COUNT(*) count FROM orders o JOIN plans p ON p.id=o.plan_id
    WHERE o.status='under_review' AND p.price_irr BETWEEN ? AND ? AND o.created_at>=? AND o.created_at<=?`).get(expected - tolerance, expected + tolerance, windowStart, windowEnd).count;
  let selected = selectBankMatch(db, { submittedRef, expectedRial: expected, tolerance, windowStart, windowEnd, allowAmountOnly: config.allowAmountOnly, trustedAgentOnly:config.trustedAgentOnly, uniqueEntityCount: Number(similarOrders) });
  if (selected.transaction && !destinationCardMatches(db, selected.transaction)) selected = { transaction: null, confidence: 10, reason: 'کارت مقصد پیامک با کارت فعال سامانه مطابقت ندارد' };
  if (!selected.transaction) {
    const previous = lastOrderReview(db, order.id);
    if (!previous || previous.decision !== 'manual' || previous.reason !== selected.reason) recordOrderReview(db, { orderId: order.id, decision: 'manual', confidence: selected.confidence, reason: selected.reason, ocr });
    return { decision: 'manual', confidence: selected.confidence, reason: selected.reason };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const consumed = db.prepare("UPDATE bank_transactions SET status='matched',matched_order_id=? WHERE id=? AND status='unmatched'").run(order.id, selected.transaction.id);
    if (!consumed.changes) throw new Error('TX_ALREADY_CONSUMED');
    const approved = db.prepare("UPDATE orders SET status='approved',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'").run(selected.reason, actor, new Date().toISOString(), order.id);
    if (!approved.changes) throw new Error('ORDER_ALREADY_HANDLED');
    recordOrderReview(db, { orderId: order.id, decision: 'approved', confidence: selected.confidence, reason: selected.reason, bankTxId: selected.transaction.id, ocr });
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    return { decision: 'manual', confidence: 0, reason: 'RACE_RETRY' };
  }
  if (provisionApproved) { try { await provisionApproved(order.id); } catch { /* admin can retry provisioning */ } }
  return { decision: 'approved', confidence: selected.confidence, reason: selected.reason, bankTxId: selected.transaction.id };
}

export async function sweepPendingTopups(db, deps = {}) {
  const config = deps.config || loadAutoReviewConfig();
  if (!config.enabled) return { evaluated: 0, approved: 0, rejected: 0 };
  const cutoff = new Date(Date.now() - config.lookbackHours * HOUR).toISOString();
  const rows = db.prepare("SELECT id FROM wallet_topups WHERE status='under_review' AND created_at>=? ORDER BY created_at").all(cutoff);
  let approved = 0, rejected = 0;
  for (const { id } of rows) {
    const result = await evaluateWalletTopup(db, id, { ...deps, config });
    if (result.decision === 'approved') approved++; else if (result.decision === 'rejected') rejected++;
  }
  // Missing or ambiguous bank evidence must never cause an automatic financial
  // rejection. Keep the request reviewable and escalate it to a human once.
  const expired = db.prepare("SELECT id,account_id,amount_toman FROM wallet_topups WHERE status='under_review' AND created_at<? ORDER BY created_at").all(cutoff);
  for (const topup of expired) {
    const reason = 'تطبیق خودکار کامل نشد؛ نیازمند بررسی دستی مدیر';
    const previous=lastTopupReview(db,topup.id);
    if(previous?.decision==='manual'&&previous?.reason===reason)continue;
    recordTopupReview(db, { topupId: topup.id, decision: 'manual', confidence: 0, reason });
    try { await deps.onManual?.({...topup,entityType:'wallet_topup',reason}); } catch { /* notification must not change money */ }
  }
  return { evaluated: rows.length + expired.length, approved, rejected };
}

export async function sweepPendingOrders(db, deps = {}) {
  const config = deps.config || loadAutoReviewConfig();
  if (!config.enabled) return { evaluated: 0, approved: 0, rejected: 0 };
  const cutoff = new Date(Date.now() - config.lookbackHours * HOUR).toISOString();
  const rows = db.prepare("SELECT id FROM orders WHERE status='under_review' AND created_at>=? ORDER BY created_at").all(cutoff);
  let approved = 0, rejected = 0;
  for (const { id } of rows) {
    const result = await evaluateOrder(db, id, { ...deps, config });
    if (result.decision === 'approved') approved++; else if (result.decision === 'rejected') rejected++;
  }
  const expired = db.prepare("SELECT id,account_id,customer_name FROM orders WHERE status='under_review' AND created_at<? ORDER BY created_at").all(cutoff);
  for (const order of expired) {
    const reason = 'تطبیق خودکار کامل نشد؛ نیازمند بررسی دستی مدیر';
    const previous=lastOrderReview(db,order.id);
    if(previous?.decision==='manual'&&previous?.reason===reason)continue;
    recordOrderReview(db, { orderId: order.id, decision: 'manual', confidence: 0, reason });
    try { await deps.onManual?.({...order,entityType:'order',reason}); } catch { /* notification must not change money */ }
  }
  return { evaluated: rows.length + expired.length, approved, rejected };
}

export async function sweepPendingPayments(db, deps = {}) {
  const config = deps.config || loadAutoReviewConfig();
  const topups = await sweepPendingTopups(db, { ...deps, config });
  const orders = await sweepPendingOrders(db, { ...deps, config });
  return { evaluated: topups.evaluated + orders.evaluated, approved: topups.approved + orders.approved, rejected: topups.rejected + orders.rejected, topups, orders };
}
