const crypto = require('node:crypto');

const TASK_EXECUTION_CONTRACT_VERSION = 'm3s.task-execution.v2';
const INPUT_FIELDS = Object.freeze(['execution_kind', 'phase_id', 'activity_id',
  'operational_plan_id', 'recurrence_id', 'occurrence_key']);
const SOURCE_KINDS = Object.freeze(['journal', 'correspondence', 'ged',
  'production_cycle', 'budget', 'transaction', 'historical_task']);
const fail = (code = 'TASK_CONTEXT_INVALID') => Object.assign(new Error(code), { code });
const plain = value => value && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const identifier = value => {
  if (typeof value !== 'string') throw fail();
  const result = value.normalize('NFKC').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(result)) throw fail();
  return result;
};
const optionalId = value => value == null ? null : identifier(value);

function normalizeTaskExecutionContext(input) {
  if (!plain(input) || Object.keys(input).some(key => !INPUT_FIELDS.includes(key))) throw fail();
  const context = {
    execution_kind: input.execution_kind,
    ...Object.fromEntries(INPUT_FIELDS.slice(1).map(key => [key, optionalId(input[key])]))
  };
  if (context.execution_kind === 'project') {
    if (!context.phase_id || context.operational_plan_id || context.recurrence_id
      || context.occurrence_key) throw fail();
  } else if (context.execution_kind === 'operation') {
    if (!context.operational_plan_id || context.phase_id || context.activity_id
      || Boolean(context.recurrence_id) !== Boolean(context.occurrence_key)) throw fail();
  } else throw fail();
  return context;
}

function normalizeTaskSourceLinks(input) {
  if (!Array.isArray(input) || input.length > 32) throw fail('TASK_SOURCE_LINK_INVALID');
  const seen = new Set();
  const links = input.map(link => {
    if (!plain(link) || Object.keys(link).some(key => !['kind', 'reference'].includes(key))
      || !SOURCE_KINDS.includes(link.kind) || typeof link.reference !== 'string') {
      throw fail('TASK_SOURCE_LINK_INVALID');
    }
    const reference = link.reference.normalize('NFKC').trim();
    if (!reference || reference.length > 500 || /[\x00-\x1f\x7f]/.test(reference)) {
      throw fail('TASK_SOURCE_LINK_INVALID');
    }
    const key = JSON.stringify([link.kind, reference]);
    if (seen.has(key)) throw fail('TASK_SOURCE_LINK_DUPLICATE');
    seen.add(key);
    return { kind: link.kind, reference };
  });
  return links.sort((a, b) => {
    const x = JSON.stringify([a.kind, a.reference]);
    const y = JSON.stringify([b.kind, b.reference]);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// The catalogue is a trusted server adapter, never a client-supplied proof.
// It must be bound to the authenticated actor and read only permitted, current
// governed records; this module performs no storage or grants.
async function resolveTaskExecutionContext(input, { tenantId, catalogue } = {}) {
  const context = normalizeTaskExecutionContext(input);
  const tenant = identifier(tenantId);
  if (!catalogue || typeof catalogue.get !== 'function') throw fail('TASK_CONTEXT_SOURCE_UNAVAILABLE');
  const get = async (kind, id) => {
    let record;
    try { record = await catalogue.get(kind, identifier(id), tenant); }
    catch { throw fail('TASK_CONTEXT_SOURCE_UNAVAILABLE'); }
    if (!plain(record) || record.id !== id || record.tenant_id !== tenant
      || record.governance_status !== 'approved' || record.status !== 'active') {
      throw fail('TASK_CONTEXT_REFERENCE_UNQUALIFIED');
    }
    return record;
  };
  const result = { ...context, project_id: null, dossier_id: null,
    portfolio_id: null, function_id: null, occurrence_identity: null };
  if (context.execution_kind === 'project') {
    const phase = await get('phase', context.phase_id);
    const project = await get('project', phase.project_id);
    const dossier = await get('dossier', project.dossier_id);
    const portfolio = await get('portfolio', dossier.portfolio_id);
    if (context.activity_id) {
      const activity = await get('activity', context.activity_id);
      if (activity.phase_id !== phase.id) throw fail('TASK_CONTEXT_REFERENCE_UNQUALIFIED');
    }
    return { ...result, project_id: project.id, dossier_id: dossier.id, portfolio_id: portfolio.id };
  }
  const plan = await get('operational_plan', context.operational_plan_id);
  const portfolio = await get('portfolio', plan.portfolio_id);
  result.portfolio_id = portfolio.id;
  result.function_id = identifier(plan.function_id);
  if (plan.dossier_id != null) {
    const dossier = await get('dossier', plan.dossier_id);
    if (dossier.portfolio_id !== portfolio.id) throw fail('TASK_CONTEXT_REFERENCE_UNQUALIFIED');
    result.dossier_id = dossier.id;
  }
  if (context.recurrence_id) {
    const recurrence = await get('recurrence', context.recurrence_id);
    if (recurrence.operational_plan_id !== plan.id || recurrence.cadence_validated !== true
      || typeof recurrence.cadence_reference !== 'string' || !recurrence.cadence_reference.trim()) {
      throw fail('TASK_CONTEXT_REFERENCE_UNQUALIFIED');
    }
    if (typeof catalogue.resolveOccurrenceKey !== 'function') throw fail('TASK_CONTEXT_SOURCE_UNAVAILABLE');
    let canonicalKey;
    try { canonicalKey = await catalogue.resolveOccurrenceKey(recurrence, context.occurrence_key, tenant); }
    catch { throw fail('TASK_CONTEXT_SOURCE_UNAVAILABLE'); }
    if (canonicalKey !== context.occurrence_key) throw fail('TASK_CONTEXT_REFERENCE_UNQUALIFIED');
    result.occurrence_identity = crypto.createHash('sha256').update(JSON.stringify([
      TASK_EXECUTION_CONTRACT_VERSION, tenant, plan.id, recurrence.id, canonicalKey
    ])).digest('hex');
  }
  return result;
}

module.exports = {
  TASK_EXECUTION_CONTRACT_VERSION, INPUT_FIELDS, SOURCE_KINDS,
  normalizeTaskExecutionContext, normalizeTaskSourceLinks, resolveTaskExecutionContext
};
