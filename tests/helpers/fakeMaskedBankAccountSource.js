'use strict';

const {
  CONTRACT_VERSION,
  DATA_CLASSIFICATION,
  ENVIRONMENT_CLASS,
  SOURCE_CAPABILITIES
} = require('../../bankAccountSourcePorts');

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function snapshotListQuery(query) {
  return Object.freeze({
    tenantId: query.tenantId,
    actorId: query.actorId,
    operation: query.operation,
    requestAt: query.requestAt,
    filters: Object.freeze(clone(query.filters)),
    after: query.after === null ? null : Object.freeze(clone(query.after)),
    candidateLimit: query.candidateLimit,
    aborted: query.signal.aborted
  });
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left, character => character.codePointAt(0));
  const rightPoints = Array.from(right, character => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function afterHandle(record, after) {
  if (after === null) return true;
  if (record.internalLabelOrder !== after.internalLabelOrder) {
    return compareCodePoints(record.internalLabelOrder, after.internalLabelOrder) > 0;
  }
  return record.bankAccountId > after.bankAccountId;
}

function createFakeMaskedBankAccountSource(options = {}) {
  const calls = {
    probe: [],
    account: [],
    entity: [],
    institution: [],
    agent: [],
    list: [],
    total: []
  };
  const accounts = options.accounts || [];
  const entities = options.entities || [];
  const institutions = options.institutions || [];
  const agents = options.agents || [];
  const handles = options.handles || [];

  function sourceProbe() {
    calls.probe.push(true);
    if (options.probeThrows) throw new Error('Fictional probe failure');
    if (Object.hasOwn(options, 'probeResult')) return options.probeResult;
    const available = options.probeAvailable !== false;
    return {
      sourceId: 'fictional-bank-account-source',
      contractVersion: CONTRACT_VERSION,
      dataClassification: DATA_CLASSIFICATION,
      environmentClass: ENVIRONMENT_CLASS,
      observedAt: '2026-09-12T12:00:00.000Z',
      available,
      capabilities: available ? [...SOURCE_CAPABILITIES] : []
    };
  }

  function resolver(kind, records, sourceOptions = {}) {
    return async query => {
      calls[kind].push(query);
      if (sourceOptions.mutateQuery) sourceOptions.mutateQuery(query);
      if (sourceOptions.throwError) throw new Error(`Fictional ${kind} failure`);
      if (Object.hasOwn(sourceOptions, 'result')) return sourceOptions.result;
      if (sourceOptions.available === false) return { available: false, records: [] };
      const selected = sourceOptions.returnAll
        ? records
        : records.filter(record => {
          const candidate = record.summary || record;
          if (kind === 'account') {
            return candidate.bankAccountId === query.bankAccountId
              && candidate.tenantId === query.tenantId;
          }
          return candidate.id === query.id
            && candidate.tenantId === query.tenantId
            && candidate.sourceRevision === query.sourceRevision;
        });
      return { available: true, records: clone(selected) };
    };
  }

  async function listSource(query) {
    calls.list.push({ query, snapshot: snapshotListQuery(query) });
    if (options.list?.mutateQuery) options.list.mutateQuery(query);
    if (options.list?.throwError) throw new Error('Fictional list failure');
    if (Object.hasOwn(options.list || {}, 'result')) return options.list.result;
    if (options.list?.available === false) {
      return { available: false, listRevision: null, records: [], hasMore: false };
    }
    const remaining = handles.filter(item => afterHandle(item, query.after));
    const selected = remaining.slice(0, query.candidateLimit);
    return {
      available: true,
      listRevision: options.listRevision || 'list-rev-fictional-1',
      records: clone(selected),
      hasMore: remaining.length >= query.candidateLimit
    };
  }

  async function totalSource(query) {
    calls.total.push(query);
    if (options.total?.mutateQuery) options.total.mutateQuery(query);
    if (options.total?.throwError) throw new Error('Fictional total failure');
    if (Object.hasOwn(options.total || {}, 'result')) return options.total.result;
    if (options.total?.available === false) return { available: false, provenTotal: null };
    if (!Object.hasOwn(options, 'totalCount')) return { available: true, provenTotal: null };
    return {
      available: true,
      provenTotal: {
        tenantId: query.tenantId,
        actorId: query.actorId,
        filters: clone(query.filters),
        listRevision: query.listRevision,
        sourceRevision: options.totalRevision || 'source-rev-fictional-1',
        scope: 'authorized_filtered',
        count: options.totalCount
      }
    };
  }

  return {
    options: {
      accountSource: resolver('account', accounts, options.account),
      relationSources: {
        entity: resolver('entity', entities, options.entity),
        institution: resolver('institution', institutions, options.institution),
        agent: resolver('agent', agents, options.agent)
      },
      listSource,
      totalSource,
      sourceProbe
    },
    calls
  };
}

module.exports = { createFakeMaskedBankAccountSource };
