function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeBudgetReferenceResolver(records = [], options = {}) {
  const calls = [];
  const resolver = async query => {
    calls.push(clone(query));
    if (options.throwError) throw new Error('Fake source failure');
    if (options.available === false) return { available: false };
    return {
      available: true,
      records: records.filter(record => record.id === query.id).map(clone)
    };
  };
  resolver.calls = calls;
  return resolver;
}

module.exports = { createFakeBudgetReferenceResolver };
