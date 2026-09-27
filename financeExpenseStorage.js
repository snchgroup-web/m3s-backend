const { normalizeExpenseAmounts } = require('./financeExpenseAmounts');

const columns = {
  ORIGINAL_CURRENCY: 'STRING', TOTAL_PAID: 'NUMERIC', PRINCIPAL: 'NUMERIC',
  FEES: 'NUMERIC', RECIPIENT_CURRENCY: 'STRING', RECIPIENT_AMOUNT: 'NUMERIC',
  CONVERSION_SOURCE: 'STRING', AMOUNT_CONTRACT_VERSION: 'INTEGER',
};
const fields = {
  ORIGINAL_CURRENCY: 'original_currency', TOTAL_PAID: 'total_paid', PRINCIPAL: 'principal',
  FEES: 'fees', RECIPIENT_CURRENCY: 'recipient_currency', RECIPIENT_AMOUNT: 'recipient_amount',
  CONVERSION_SOURCE: 'conversion_source', AMOUNT_CONTRACT_VERSION: 'amount_contract_version',
};
function supportsExpenseAmounts(schema) {
  return Object.entries(columns).every(([name, type]) => schema.some(f => f.name === name && f.type === type && f.mode !== 'REQUIRED'));
}
function expenseAmountParams(body) {
  const amounts = normalizeExpenseAmounts(body.source_amounts || {});
  return { ...amounts, amount_contract_version: 2, montant_origine: amounts.total_paid,
    devise_origine: amounts.original_currency, montant_chf: amounts.equivalent_chf,
    montant_cfa: amounts.equivalent_cfa,
    taux_fx: amounts.equivalent_chf && amounts.equivalent_cfa ? amounts.equivalent_cfa / amounts.equivalent_chf : null,
    taux_fx_applique: amounts.equivalent_chf && amounts.equivalent_cfa ? amounts.equivalent_cfa / amounts.equivalent_chf : null,
  };
}
function expenseQueryParams(row) {
  const params = { ...row };
  delete params.conversion_status;
  delete params.equivalent_chf;
  delete params.equivalent_cfa;
  const types = Object.fromEntries(Object.entries(fields).map(([column, param]) => [param, columns[column]]));
  // BigQuery cannot infer the type of null parameters.
  Object.assign(types, { montant_chf: 'FLOAT64', montant_cfa: 'FLOAT64', taux_fx: 'FLOAT64', taux_fx_applique: 'FLOAT64' });
  return { params, types };
}
const sourceAmountSelect = `AMOUNT_CONTRACT_VERSION AS amount_contract_version,
  IF(AMOUNT_CONTRACT_VERSION = 2, STRUCT(
    ORIGINAL_CURRENCY AS original_currency, CAST(TOTAL_PAID AS FLOAT64) AS total_paid,
    CAST(PRINCIPAL AS FLOAT64) AS principal, CAST(FEES AS FLOAT64) AS fees,
    RECIPIENT_CURRENCY AS recipient_currency, CAST(RECIPIENT_AMOUNT AS FLOAT64) AS recipient_amount,
    CHF AS equivalent_chf, CFA AS equivalent_cfa, CONVERSION_SOURCE AS conversion_source
  ), NULL) AS source_amounts`;
function maskIncompleteExpenseTotals(row) {
  return { ...row,
    known_expenses_chf: row.total_expenses,
    known_expenses_cfa: row.total_expenses_cfa,
    total_expenses: Number(row.expenses_missing_chf) > 0 ? null : row.total_expenses,
    total_expenses_cfa: Number(row.expenses_missing_cfa) > 0 ? null : row.total_expenses_cfa,
  };
}
module.exports = { columns, fields, supportsExpenseAmounts, expenseAmountParams, expenseQueryParams, sourceAmountSelect, maskIncompleteExpenseTotals };
