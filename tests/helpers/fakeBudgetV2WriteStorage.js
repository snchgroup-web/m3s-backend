function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeBudgetV2WriteStorage(initialRecords = [], options = {}) {
  const records = new Map(initialRecords.map(record => [record.id, clone(record)]));
  const auditEvents = [];
  const calls = [];
  const promotionLinks = options.promotionLinks || [];

  function outcome(name, fallback) {
    const value = options[name];
    return typeof value === 'function' ? value() : (value ?? fallback);
  }

  return {
    state: { records, auditEvents, calls },

    async probe() {
      calls.push({ method: 'probe' });
      if (options.probeThrows) throw new Error('fake probe failure');
      return outcome('probeResult', { available: true });
    },

    async getCurrentDraft(query) {
      calls.push({ method: 'getCurrentDraft', query: clone(query) });
      if (options.getThrows) throw new Error('fake read failure');
      if (options.getResult) return options.getResult;
      const record = records.get(query.id);
      return { available: true, records: record ? [clone(record)] : [] };
    },

    async findPromotionLinks(query) {
      calls.push({ method: 'findPromotionLinks', query: clone(query) });
      if (options.linksThrow) throw new Error('fake link failure');
      if (options.linksResult) return options.linksResult;
      return {
        available: true,
        records: promotionLinks.filter(link => link.draftId === query.draftId).map(clone)
      };
    },

    async createCurrentDraft({ record, audit }) {
      calls.push({ method: 'createCurrentDraft', record: clone(record), audit: clone(audit) });
      if (options.createThrows) throw new Error('fake uncertain create');
      const forced = outcome('createOutcome', null);
      if (forced) return forced;
      if (records.has(record.id)) return { outcome: 'duplicate' };
      records.set(record.id, clone(record));
      auditEvents.push(clone(audit));
      if (options.mutateCreateArguments) {
        record.title = 'Mutation stockage';
        audit.action = 'mutation';
      }
      return { outcome: 'created', id: record.id, version: record.version };
    },

    async replaceCurrentDraft({
      id, tenantId, authorUserId, expectedVersion, nextRecord, audit
    }) {
      calls.push({
        method: 'replaceCurrentDraft', id, tenantId, authorUserId, expectedVersion,
        nextRecord: clone(nextRecord), audit: clone(audit)
      });
      if (options.replaceThrows) throw new Error('fake uncertain update');
      const forced = outcome('replaceOutcome', null);
      if (forced) return forced;
      const current = records.get(id);
      if (!current || current.tenantId !== tenantId || current.authorUserId !== authorUserId) {
        return { outcome: 'missing' };
      }
      if (current.version !== expectedVersion) return { outcome: 'conflict' };
      records.set(id, clone(nextRecord));
      auditEvents.push(clone(audit));
      if (options.mutateReplaceArguments) {
        nextRecord.title = 'Mutation stockage';
        audit.action = 'mutation';
      }
      return { outcome: 'updated', id, version: nextRecord.version };
    }
  };
}

module.exports = { createFakeBudgetV2WriteStorage };
