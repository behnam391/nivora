// Optional receipt OCR using the system `tesseract` binary (fas+eng).
// Runs fully offline and returns supplementary fields only — it is never the
// authoritative confirmation of a payment (that is the bank SMS feed).

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { extractFinancialFields } from './bank-sms.js';

// Map a stored receipt URL ("/receipts/<name>.jpg") to a path inside the receipts dir.
export function receiptPathFromUrl(url) {
  let pathname = String(url || '');
  try { pathname = new URL(pathname, 'http://receipt.local').pathname; } catch {}
  const match = pathname.match(/([a-f0-9-]+\.(?:jpe?g|png|webp))$/i);
  return match ? resolve('receipts', match[1]) : null;
}

export function runTesseract(imagePath, { lang = 'fas+eng', psm = 6, timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'tesseract',
      [imagePath, 'stdout', '-l', lang, '--psm', String(psm)],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolvePromise(String(stdout || '')))
    );
  });
}

// Extract amount/tracking/card from a receipt image. Returns { ok:false } on any
// failure so callers can safely ignore OCR when tesseract is missing.
export async function extractReceiptFields(imagePathOrUrl, options = {}) {
  const path = imagePathOrUrl?.startsWith('/receipts/') ? receiptPathFromUrl(imagePathOrUrl) : imagePathOrUrl;
  if (!path) return { ok: false, error: 'NO_IMAGE', amountRial: null, trackingCode: null, cardLast4: null };
  try {
    const text = await runTesseract(path, options);
    // Receipts frequently print the amount in Toman; treat a bare number as Toman.
    return { ok: true, text, ...extractFinancialFields(text, { defaultUnit: options.defaultUnit || 'toman' }) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), amountRial: null, trackingCode: null, cardLast4: null };
  }
}
