// Qualification contract; production routes remain disabled until storage and UI are ready.
const { normalizeExpenseAmounts } = require('./financeExpenseAmounts');

function normalizeIncomeAmounts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Income amounts required');
  const allowed = new Set(['original_currency', 'total_received', 'equivalent_chf', 'equivalent_cfa', 'conversion_source']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('Unsupported income amount field');
  const normalized = normalizeExpenseAmounts({
    original_currency: input.original_currency,
    total_paid: input.total_received,
    equivalent_chf: input.equivalent_chf,
    equivalent_cfa: input.equivalent_cfa,
    conversion_source: input.conversion_source,
  });
  return {
    original_currency: normalized.original_currency,
    total_received: normalized.total_paid,
    equivalent_chf: normalized.equivalent_chf,
    equivalent_cfa: normalized.equivalent_cfa,
    conversion_source: normalized.conversion_source,
    conversion_status: normalized.conversion_status,
  };
}

module.exports = { normalizeIncomeAmounts };
