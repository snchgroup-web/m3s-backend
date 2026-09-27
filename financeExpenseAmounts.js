// Candidate contract. Keep disconnected from production writes until storage and reads support it.
const SCALE = { CHF: 2, USD: 2, EUR: 2, XOF: 0 };
const missing = (value) => value === undefined || value === null || value === '';

function currency(value) {
  const code = String(value || '').toUpperCase();
  const normalized = code === 'CFA' ? 'XOF' : code;
  if (!Object.hasOwn(SCALE, normalized)) throw new Error('Unsupported currency');
  return normalized;
}

function minorUnits(value, code, required = false) {
  if (missing(value)) {
    if (required) throw new Error('Amount required');
    return null;
  }
  if (!['string', 'number'].includes(typeof value)) throw new Error('Invalid amount');
  const text = String(value);
  const precision = SCALE[code];
  const expression = precision ? /^\d+(?:\.\d{1,2})?$/ : /^\d+$/;
  if (!expression.test(text)) throw new Error('Invalid amount or precision');
  const [whole, decimal = ''] = text.split('.');
  const units = Number(whole) * (10 ** precision) + Number(decimal.padEnd(precision, '0'));
  if (!Number.isSafeInteger(units)) throw new Error('Amount too large');
  return units;
}

const majorUnits = (units, code) => units === null ? null : units / (10 ** SCALE[code]);

function normalizeExpenseAmounts(input) {
  const originalCurrency = currency(input.original_currency);
  const total = minorUnits(input.total_paid, originalCurrency, true);
  if (total <= 0) throw new Error('Total paid must be positive');
  const principal = minorUnits(input.principal, originalCurrency);
  const fees = minorUnits(input.fees, originalCurrency);
  if ((principal === null) !== (fees === null)) throw new Error('Principal and fees must be supplied together');
  if (principal !== null && (principal <= 0 || principal > total || fees > total || principal !== total - fees)) {
    throw new Error('Principal plus fees must equal total paid');
  }

  const recipientCurrency = missing(input.recipient_currency) ? null : currency(input.recipient_currency);
  if ((recipientCurrency === null) !== missing(input.recipient_amount)) throw new Error('Recipient amount and currency must be supplied together');
  const recipient = recipientCurrency === null ? null : minorUnits(input.recipient_amount, recipientCurrency, true);
  if (recipient !== null && recipient <= 0) throw new Error('Recipient amount must be positive');

  // A delivered amount is NOT the accounting equivalent of the total paid, which includes fees.
  const equivalents = {};
  for (const code of ['CHF', 'XOF']) {
    const supplied = minorUnits(input[code === 'CHF' ? 'equivalent_chf' : 'equivalent_cfa'], code);
    if (supplied !== null && supplied <= 0) throw new Error('Equivalent must be positive');
    if (originalCurrency === code && supplied !== null && supplied !== total) throw new Error('Original currency equivalent must equal total paid');
    equivalents[code] = originalCurrency === code ? total : supplied;
  }
  const conversionSource = String(input.conversion_source || '').trim();
  const hasConversion = ['CHF', 'XOF'].some(code => code !== originalCurrency && equivalents[code] !== null);
  if (hasConversion && !conversionSource) throw new Error('Conversion source required');
  if (!hasConversion && conversionSource) throw new Error('Conversion source without conversion');
  if (conversionSource.length > 500) throw new Error('Conversion source too long');

  return {
    original_currency: originalCurrency,
    total_paid: majorUnits(total, originalCurrency),
    principal: majorUnits(principal, originalCurrency),
    fees: majorUnits(fees, originalCurrency),
    recipient_currency: recipientCurrency,
    recipient_amount: recipientCurrency === null ? null : majorUnits(recipient, recipientCurrency),
    equivalent_chf: majorUnits(equivalents.CHF, 'CHF'),
    equivalent_cfa: majorUnits(equivalents.XOF, 'XOF'),
    conversion_source: conversionSource || null,
    conversion_status: equivalents.CHF !== null && equivalents.XOF !== null ? 'complete' : 'incomplete',
  };
}

module.exports = { normalizeExpenseAmounts };
