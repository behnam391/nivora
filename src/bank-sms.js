// Parser for Iranian bank deposit SMS / receipt text.
// Extracts amount (normalised to Rial), tracking code, destination card last 4 digits
// and transaction direction. All monetary values are kept in RIAL to match the
// `price_irr` / `amount_transferred_irr` columns used across Nivora.

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function normalizeDigits(input) {
  return String(input ?? '')
    .replace(/[۰-۹]/g, d => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d)));
}

const BANKS = [
  ['ملت', 'Mellat'], ['ملی', 'Melli'], ['صادرات', 'Saderat'], ['تجارت', 'Tejarat'],
  ['سامان', 'Saman'], ['پاسارگاد', 'Pasargad'], ['پارسیان', 'Parsian'], ['سپه', 'Sepah'],
  ['رفاه', 'Refah'], ['کشاورزی', 'Keshavarzi'], ['اقتصاد نوین', 'EN'], ['اقتصادنوین', 'EN'],
  ['سینا', 'Sina'], ['شهر', 'Shahr'], ['دی', 'Day'], ['Day Bank', 'Day'], ['DAY BANK', 'Day'], ['آینده', 'Ayandeh'], ['بلو', 'Blu'],
  ['بلوبانک', 'Blu'], ['مسکن', 'Maskan'], ['کارآفرین', 'Karafarin'], ['گردشگری', 'Gardeshgari'],
  ['ایران زمین', 'IranZamin'], ['قوامین', 'Ghavamin'], ['رسالت', 'Resalat'], ['ملل', 'Melal']
];

const stripSeparators = value => normalizeDigits(value).replace(/[,٬،.\s]/g, '');

// Convert a raw number + optional unit into Rial. Toman is multiplied by 10.
function toRial(rawNumber, unit) {
  const digits = stripSeparators(rawNumber);
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return null;
  return /تومان|تومن/.test(unit || '') ? value * 10 : value;
}

const AMOUNT_WITH_UNIT = /([0-9][0-9,٬،.\s]{0,20}[0-9]|[0-9])\s*(ریال|ريال|تومان|تومن)/g;

// Find the transferred amount, deliberately skipping the account balance (موجودی/مانده).
function extractAmount(text, defaultUnit = 'rial') {
  const norm = normalizeDigits(text);
  const candidates = [];
  for (const match of norm.matchAll(AMOUNT_WITH_UNIT)) {
    const before = norm.slice(Math.max(0, match.index - 14), match.index);
    const isBalance = /موجودی|مانده|قابل ?برداشت/.test(before);
    const isCredit = /واریز|مبلغ|بستانکار|به حساب/.test(before);
    candidates.push({ rial: toRial(match[1], match[2]), unit: match[2], isBalance, isCredit, index: match.index });
  }
  const usable = candidates.filter(c => c.rial != null);
  const credit = usable.find(c => c.isCredit && !c.isBalance);
  const nonBalance = usable.find(c => !c.isBalance);
  const picked = credit || nonBalance || usable[0];
  if (picked) return { amountRial: picked.rial, unit: picked.unit };
  // Fallback: a number after مبلغ without an explicit unit.
  const bare = norm.match(/مبلغ[:\s]*([0-9][0-9,٬،.\s]{0,20}[0-9]|[0-9])/);
  if (bare) return { amountRial: toRial(bare[1], defaultUnit === 'toman' ? 'تومان' : ''), unit: null };
  return { amountRial: null, unit: null };
}

const TRACKING = /(?:کد\s*)?(?:پیگیری|رهگیری|مرجع|رسید|سریال|ref(?:erence)?|trace)\D{0,12}([0-9]{4,})/i;

function extractTracking(text) {
  const norm = normalizeDigits(text);
  const match = norm.match(TRACKING);
  return match ? match[1] : null;
}

function extractCardLast4(text) {
  const norm = normalizeDigits(text);
  const masked = norm.match(/[*xX••]{2,}[^\d]{0,3}(\d{4})(?!\d)/);
  if (masked) return masked[1];
  const labelled = norm.match(/کارت[^\d]{0,8}(?:\d[\d -]{0,20})?(\d{4})(?!\d)/);
  return labelled ? labelled[1] : null;
}

// Only treat a card as the destination when the surrounding label says so.
// A generic "کارت ****1234" can be the sender card and is therefore not safe
// enough to use as an automatic-approval constraint.
function extractDestinationCardLast4(text) {
  const norm = normalizeDigits(text);
  const match = norm.match(/(?:کارت\s*مقصد|به\s*کارت|واریز\s*به\s*کارت|کارت\s*شما)[^\d]{0,16}(?:\d[\d -]{0,20})?(\d{4})(?!\d)/);
  return match ? match[1] : null;
}

function extractBank(text) {
  for (const [needle, code] of BANKS) if (text.includes(needle)) return code;
  return '';
}

// Shared field extractor used by both SMS ingestion and receipt OCR.
export function extractFinancialFields(text, { defaultUnit = 'rial' } = {}) {
  const { amountRial, unit } = extractAmount(text, defaultUnit);
  return {
    amountRial,
    unit,
    trackingCode: extractTracking(text),
    cardLast4: extractCardLast4(text),
    destinationCardLast4: extractDestinationCardLast4(text)
  };
}

export function parseBankMessage(message, { defaultUnit = 'rial' } = {}) {
  const raw = String(message ?? '');
  const norm = normalizeDigits(raw);
  // Iranian banks do not use one vocabulary. In particular Day Bank uses
  // «افزایش» in some credit notifications instead of «واریز».
  const isCredit = /واریز|واريز|واریزی|بستانکار|افزایش|افزايش|دریافت|دريافت|deposit|credit|به حساب شما/i.test(norm);
  const isDebit = /برداشت|بدهکار|خرید|خريد|پرداخت از|کاهش|كاهش|withdraw|debit/i.test(norm);
  // A forwarded thread, notification summary, or malicious body may contain
  // both vocabularies. Ambiguous direction is never eligible for auto-credit.
  const direction = isCredit === isDebit ? 'unknown' : isCredit ? 'credit' : 'debit';
  const fields = extractFinancialFields(norm, { defaultUnit });
  return { direction, bank: extractBank(raw), raw, ...fields };
}
