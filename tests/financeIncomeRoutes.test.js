const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeFinanceTransaction } = require('../financeTransaction');
const { incomeQueryParams } = require('../financeIncomeStorage');

function fixture(ready = true, affected = 1) {
  const handlers = {};
  const queries = [];
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf("app.post('/api/finance/income',");
  const end = source.indexOf("app.delete('/api/finance/income/:id',", start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (_, ...args) => { handlers.post = args.at(-1); }, put: (_, ...args) => { handlers.put = args.at(-1); } },
    requireFinanceWrite() {}, requireResolvedFinanceSources() {}, incomeAmountsReady: ready,
    normalizeFinanceTransaction, incomeQueryParams,
    applyTeamAgentContract: async row => ({ row, warnings: [] }),
    financeTableRef: () => '`synthetic.finance.income`', financeSources: { location: 'EU' }, DATASET_LOCATION: 'EU',
    bigquery: {
      query: async query => { queries.push(query); },
      createQueryJob: async query => {
        queries.push(query);
        return [{ getQueryResults: async () => [], getMetadata: async () => [{ statistics: { query: { numDmlAffectedRows: String(affected) } } }] }];
      },
    }, console: { error() {} },
  });
  const invoke = async (method, body) => {
    const result = { status: 200 };
    const res = { status(code) { result.status = code; return this; }, json(value) { result.body = value; } };
    await handlers[method]({ body, params: { id: 'SYNTHETIC-1' } }, res);
    return result;
  };
  return { invoke, queries };
}

const body = { date: '2026-01-15', description: 'Synthetic receipt', amount_contract_version: 2,
  source_amounts: { original_currency: 'CHF', total_received: '2.50' } };

test('POST writes typed unknown equivalents, without any cloud access', async () => {
  const f = fixture();
  assert.equal((await f.invoke('post', body)).status, 201);
  assert.equal(f.queries[0].params.montant_chf, 2.5);
  assert.equal(f.queries[0].params.montant_cfa, null);
  assert.equal(f.queries[0].types.montant_cfa, 'FLOAT64');
  assert.match(f.queries[0].query, /AMOUNT_CONTRACT_VERSION,CONVERSION_SOURCE/);
  assert.match(f.queries[0].query, /CAST\(DATE\(@date\) AS STRING\)/);
});

test('schema gate refuses writes before querying', async () => {
  const f = fixture(false);
  for (const method of ['post', 'put']) assert.equal((await f.invoke(method, body)).status, 400);
  assert.equal(f.queries.length, 0);
});

test('PUT guards the version and confirms exactly one updated row', async () => {
  const f = fixture();
  assert.equal((await f.invoke('put', body)).status, 200);
  assert.match(f.queries[0].query, /AND AMOUNT_CONTRACT_VERSION = 2/);
  assert.match(f.queries[0].query, /PERIODE_REF=IF\(@taux_fx_reference > 0,CAST\(DATE\(@date\) AS STRING\),NULL\)/);
  const empty = fixture(true, 0);
  assert.equal((await empty.invoke('put', body)).status, 400);
});
