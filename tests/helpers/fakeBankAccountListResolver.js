'use strict';

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function wait(milliseconds, signal, ignoreSignal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    if (ignoreSignal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('Fictional list resolution aborted'));
    }, { once: true });
  });
}

function compareHandle(handle, after) {
  if (handle.internalLabelOrder !== after.internalLabelOrder) {
    return handle.internalLabelOrder > after.internalLabelOrder;
  }
  return handle.bankAccountId > after.bankAccountId;
}

function createFakeBankAccountListResolver(options = {}) {
  const records = options.records || [];
  const calls = [];
  const resolver = async query => {
    calls.push({
      query,
      snapshot: Object.freeze({
        tenantId: query.tenantId,
        actorId: query.actorId,
        operation: query.operation,
        requestAt: query.requestAt,
        filters: Object.freeze(clone(query.filters)),
        after: query.after === null ? null : Object.freeze(clone(query.after)),
        candidateLimit: query.candidateLimit
      })
    });
    await wait(options.delayMs || 0, query.signal, options.ignoreSignal === true);
    if (options.throwError) throw new Error('Fictional list source failure');
    if (typeof options.makeResult === 'function') return options.makeResult(query);
    if (options.available === false) {
      return {
        available: false,
        listRevision: options.listRevision || 'list-rev-fictional-1',
        records: [],
        hasMore: false,
        provenTotal: null
      };
    }
    const after = query.after;
    const remaining = after === null
      ? records
      : records.filter(record => compareHandle(record, after));
    const selected = remaining.slice(0, query.candidateLimit);
    return {
      available: true,
      listRevision: options.listRevision || 'list-rev-fictional-1',
      records: clone(selected),
      hasMore: options.hasMore ?? remaining.length > query.candidateLimit - 1,
      provenTotal: Object.hasOwn(options, 'provenTotal') ? clone(options.provenTotal) : null
    };
  };
  resolver.calls = calls;
  return resolver;
}

module.exports = { createFakeBankAccountListResolver };
