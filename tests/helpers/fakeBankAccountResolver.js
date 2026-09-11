'use strict';

function clone(value) {
  return structuredClone(value);
}

function createFakeBankAccountResolver(records = [], options = {}) {
  const calls = [];
  const resolver = async query => {
    calls.push(clone(query));
    if (options.mutateQuery) options.mutateQuery(query);
    if (options.throwError) throw new Error('Fictional source failure');
    if (options.available === false) return { available: false, records: options.records };
    const selected = options.returnAll
      ? records
      : records.filter(record => {
        const candidate = record?.summary || record;
        return candidate.bankAccountId === query.bankAccountId || candidate.id === query.id;
      });
    return { available: true, records: clone(selected) };
  };
  resolver.calls = calls;
  return resolver;
}

module.exports = { createFakeBankAccountResolver };
