import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBankMessage, extractFinancialFields, normalizeDigits } from '../src/bank-sms.js';

test('deposit SMS in Rial picks the transferred amount, not the balance', () => {
  const sms = 'بانک ملت\nواریز به حساب شما\nمبلغ: 250,000 ریال\nمانده: 1,200,000 ریال\nپیگیری: 123456789\n1403/05/20';
  const parsed = parseBankMessage(sms);
  assert.equal(parsed.direction, 'credit');
  assert.equal(parsed.amountRial, 250000);
  assert.equal(parsed.trackingCode, '123456789');
  assert.equal(parsed.bank, 'Mellat');
});

test('Toman amounts with Persian digits and separators are normalised to Rial', () => {
  const sms = 'کارت به کارت\nمبلغ ۱۲٬۰۰۰ تومان واریز شد\nکد رهگیری ۵۵۴۴۳۳';
  const parsed = parseBankMessage(sms);
  assert.equal(parsed.direction, 'credit');
  assert.equal(parsed.amountRial, 120000);
  assert.equal(parsed.trackingCode, '554433');
});

test('debit / withdrawal messages are marked as debit', () => {
  const parsed = parseBankMessage('خرید اینترنتی مبلغ 500,000 ریال از حساب شما برداشت شد');
  assert.equal(parsed.direction, 'debit');
  assert.equal(parsed.amountRial, 500000);
});

test('a message containing both credit and debit signals stays ambiguous', () => {
  const parsed = parseBankMessage('واریز 500,000 ریال انجام شد سپس همان مبلغ از حساب برداشت شد');
  assert.equal(parsed.direction, 'unknown');
});

test('Day Bank increase notifications are recognised as credit', () => {
  const parsed = parseBankMessage('Day Bank\nافزایش موجودی کارت\nمبلغ 500,000 ریال\nمانده 2,000,000 ریال');
  assert.equal(parsed.direction, 'credit');
  assert.equal(parsed.amountRial, 500000);
  assert.equal(parsed.bank, 'Day');
});

test('masked card number yields the last four digits', () => {
  const fields = extractFinancialFields('کارت ****1234 مبلغ 300,000 ریال واریز شد پیگیری 111222');
  assert.equal(fields.cardLast4, '1234');
  assert.equal(fields.amountRial, 300000);
  assert.equal(fields.trackingCode, '111222');
});

test('destination card is extracted only from an explicit destination label', () => {
  assert.equal(extractFinancialFields('واریز به کارت ****4697 مبلغ 300,000 ریال').destinationCardLast4,'4697');
  assert.equal(extractFinancialFields('کارت ****1234 مبلغ 300,000 ریال واریز شد').destinationCardLast4,null);
});

test('digit normalisation converts Persian and Arabic numerals', () => {
  assert.equal(normalizeDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
  assert.equal(normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
});
