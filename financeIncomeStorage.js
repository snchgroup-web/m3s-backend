const { normalizeIncomeAmounts } = require('./financeIncomeAmounts');

const columns = Object.freeze({ AMOUNT_CONTRACT_VERSION: 'INTEGER', CONVERSION_SOURCE: 'STRING' });
const amountColumns = ['MONTANT_SAISI', 'MONTANT_CHF', 'MONTANT_CFA', 'TAUX_FX_SAISI', 'TAUX_FX_APPLIQUE', 'TAUX_REF_AUTO'];
const numericTypes = new Set(['FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC']);

function supportsIncomeAmounts(schema) {
  if (!Array.isArray(schema)) return false;
  const nullableField = name => schema.find(field => field.name === name && (!field.mode || field.mode === 'NULLABLE'));
  return Object.entries(columns).every(([name, type]) => nullableField(name)?.type === type)
    && amountColumns.every(name => numericTypes.has(nullableField(name)?.type))
    && nullableField('DEVISE_SAISIE')?.type === 'STRING';
}

function incomeAmountParams(body) {
  if (body.amount_contract_version !== 2) throw new Error('Unsupported income amount contract');
  const amounts = normalizeIncomeAmounts(body.source_amounts);
  const rate = amounts.equivalent_chf !== null && amounts.equivalent_cfa !== null
    ? amounts.equivalent_cfa / amounts.equivalent_chf : null;
  return {
    amount_contract_version: 2,
    montant_origine: amounts.total_received,
    devise_origine: amounts.original_currency,
    montant_chf: amounts.equivalent_chf,
    montant_cfa: amounts.equivalent_cfa,
    taux_fx: rate,
    taux_fx_applique: rate,
    taux_fx_reference: null,
    conversion_source: amounts.conversion_source,
  };
}

function incomeQueryParams(row) {
  return {
    params: { ...row },
    types: {
      amount_contract_version: 'INT64', conversion_source: 'STRING',
      montant_origine: 'FLOAT64', montant_chf: 'FLOAT64', montant_cfa: 'FLOAT64',
      taux_fx: 'FLOAT64', taux_fx_applique: 'FLOAT64', taux_fx_reference: 'FLOAT64',
    },
  };
}

const incomeSourceAmountSelect = `AMOUNT_CONTRACT_VERSION AS amount_contract_version,
  IF(AMOUNT_CONTRACT_VERSION = 2, STRUCT(
    DEVISE_SAISIE AS original_currency, MONTANT_SAISI AS total_received,
    MONTANT_CHF AS equivalent_chf, MONTANT_CFA AS equivalent_cfa,
    CONVERSION_SOURCE AS conversion_source
  ), NULL) AS source_amounts`;

function maskIncompleteIncomeTotals(row) {
  return {
    ...row,
    known_income_chf: row.total_income,
    known_income_cfa: row.total_income_cfa,
    total_income: Number(row.income_missing_chf) > 0 ? null : row.total_income,
    total_income_cfa: Number(row.income_missing_cfa) > 0 ? null : row.total_income_cfa,
  };
}

// Produces SQL only, with no cloud client or execution path.
function planIncomeAmountMigration({ project, dataset, table, schema }) {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project || '')
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset || '')
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table || '') || !Array.isArray(schema)) {
    throw new Error('Resolved income table and schema required');
  }
  for (const [name, type] of Object.entries(columns)) {
    const field = schema.find(item => item.name === name);
    if (field && (field.type !== type || (field.mode && field.mode !== 'NULLABLE'))) throw new Error(`Incompatible column: ${name}`);
  }
  const targetSchema = [...schema, ...Object.entries(columns).filter(([name]) => !schema.some(field => field.name === name))
    .map(([name, type]) => ({ name, type, mode: 'NULLABLE' }))];
  if (!supportsIncomeAmounts(targetSchema)) throw new Error('Existing income amount columns are incompatible');
  const additions = Object.entries(columns).filter(([name]) => !schema.some(field => field.name === name));
  return {
    status: additions.length ? 'BACKUP_AND_RESTORE_VERIFICATION_REQUIRED' : 'NO_SCHEMA_CHANGE',
    target: `${project}.${dataset}.${table}`,
    additions: additions.map(([name]) => name),
    sql: additions.length ? `ALTER TABLE \`${project}.${dataset}.${table}\`\n  ${additions.map(([name, type]) => `ADD COLUMN IF NOT EXISTS ${name} ${type === 'INTEGER' ? 'INT64' : type}`).join(',\n  ')};` : null,
    executed: false,
  };
}

module.exports = { columns, supportsIncomeAmounts, incomeAmountParams, incomeQueryParams,
  incomeSourceAmountSelect, maskIncompleteIncomeTotals, planIncomeAmountMigration };
