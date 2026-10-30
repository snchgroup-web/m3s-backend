'use strict';

const { PERMISSIONS, ADMINISTRATION_TABLE_CONTRACTS } = require('./administrationRegistries');
const { normalizeTaskSourceLinks } = require('./taskExecutionContract');
const { hasExpectedBigQueryTableContract } = require('./bigQueryTableContract');
const RAILWAY_SOURCE = 'COR-88832bd5-2231-42f3-a7d6-4f4e13a8cbe3';
const FINANCE_PORTFOLIO = 'PORT-2SG-GLOBAL';
const FINANCE_FUNCTION = 'finance';
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(x);
const actor = x => typeof x === 'string' && x.trim() === x && x.length > 0 && x.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(x);
const approved = (row, tenant) => row && id(row.id) && row.tenant_id === tenant &&
  row.governance_status === 'approved' && row.status === 'active' &&
  typeof row.registration_reference === 'string' && row.registration_reference.trim().length > 0 &&
  row.registration_reference.length <= 500 && !/[\x00-\x1f\x7f-\x9f]/.test(row.registration_reference);

// Preparation only: no native ID, actor binding, registration or write is inferred.
function buildFinancialOperationRegistrationPreparation() {
  const prepared = { tenant_id: '2sg', id: null, governance_status: 'prepared_not_registered',
    status: 'inactive', registration_reference: null };
  return {
    statements: [], application_allowed: false,
    plan: { ...prepared, label: 'Suivi des charges de fonctionnement et des services 2SG',
      portfolio_id: FINANCE_PORTFOLIO, function_id: FINANCE_FUNCTION, dossier_id: null },
    assignment: { ...prepared, operational_plan_id: null, actor_user_id: null,
      assignee_agent_id: 'PER-2SG-0001', team_id: 'TZH', function_id: FINANCE_FUNCTION, module: 'FINANCES' },
    consultation: { person_id: 'PER-2SG-0002', role: 'financial_reference',
      status: 'response_recorded_recheck_required',
      correspondence_reference: 'COR-de403d44-4f7d-4926-ba0d-f3ac6e20687f',
      assignment_created: false, access_granted: false },
    source: { kind: 'correspondence', reference: RAILWAY_SOURCE },
    pending: ['native_plan_storage_contract_and_retention', 'portfolio_finance_compatibility',
      'native_finance_function_registration', 'recheck_consultation_source', 'verified_actor_binding', 'native_ids_and_duplicate_check',
      'approval_and_registration_evidence', 'governed_assignment_and_effective_access',
      'backup_review_and_separate_activation_authorisation']
  };
}

function validBinding(data, tenantId, actorId) {
  const { plan, portfolio, assignment, person, dossier } = data || {};
  return [plan, portfolio, assignment].every(row => approved(row, tenantId)) &&
    typeof plan.label === 'string' && plan.label.trim().length > 0 && plan.label.length <= 200 &&
    !/[\x00-\x1f\x7f-\x9f]/.test(plan.label) &&
    portfolio.id === FINANCE_PORTFOLIO && plan.portfolio_id === FINANCE_PORTFOLIO &&
    plan.function_id === FINANCE_FUNCTION &&
    assignment.operational_plan_id === plan.id && assignment.actor_user_id === actorId &&
    assignment.function_id === plan.function_id && assignment.module === 'FINANCES' &&
    id(assignment.team_id) && id(assignment.assignee_agent_id) &&
    person?.id === assignment.assignee_agent_id && person.active === true &&
    typeof person.label === 'string' && person.label.trim() === person.label && person.label.length > 0 &&
    person.label.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(person.label) &&
    person.team_id === assignment.team_id &&
    (plan.dossier_id == null || (approved(dossier, tenantId) && dossier.id === plan.dossier_id &&
      dossier.portfolio_id === portfolio.id));
}

// Injected source must resolve governed native records and re-read source evidence.
// This reader is not wired into the published Standardisation-only adapter.
function createFinancialOperationReferenceReader({ source }) {
  if (!source || typeof source.load !== 'function' || typeof source.readCorrespondence !== 'function') {
    throw new Error('TASK_FINANCIAL_SOURCE_INVALID');
  }
  return {
    async bindForActor({ tenantId, actorId, permissions }) {
      if (tenantId !== '2sg' || !actor(actorId) || !Array.isArray(permissions) ||
          !permissions.includes(PERMISSIONS.RESOURCES_READ) || !permissions.includes(PERMISSIONS.CORRESPONDENCE_READ) ||
          typeof source.verifyDecision !== 'function') return null;
      try {
        const loaded = await source.load({ tenantId, actorId });
        if (!validBinding(loaded, tenantId, actorId)) return null;
        const data = Object.fromEntries(['plan', 'portfolio', 'assignment', 'person', 'dossier']
          .map(key => [key, loaded[key] == null ? null : { ...loaded[key] }]));
        const { plan, portfolio, assignment, person, dossier } = data;
        const bindingKey = value => JSON.stringify([
          value.plan.id, value.plan.label, value.plan.registration_reference, value.plan.portfolio_id, value.plan.dossier_id ?? null,
          value.plan.decision_reference ?? null, value.plan.decision_version ?? null, value.plan.decision_sha256 ?? null,
          value.plan.function_id, value.portfolio.id, value.portfolio.registration_reference,
          value.assignment.id, value.assignment.registration_reference, value.assignment.actor_user_id,
          value.assignment.assignee_agent_id, value.assignment.team_id, value.assignment.function_id,
          value.assignment.module, value.person.id, value.person.team_id, value.person.label,
          value.dossier?.registration_reference ?? null
        ]);
        const originalKey = bindingKey(data);
        // A server-owned verifier must resolve the decision; a textual reference alone is insufficient.
        const decisionValid = async current => (await source.verifyDecision({ tenantId, actorId,
          plan: current.plan, portfolio: current.portfolio, assignment: current.assignment })) === true;
        if (!await decisionValid(data)) return null;
        const bindingStillValid = async () => {
          try {
            const current = await source.load({ tenantId, actorId });
            return validBinding(current, tenantId, actorId) && bindingKey(current) === originalKey &&
              await decisionValid(current);
          } catch { return false; }
        };
        const sourceValid = async () => {
          const row = await source.readCorrespondence({ tenantId, id: RAILWAY_SOURCE });
          return row?.id === RAILWAY_SOURCE && row.tenant_id === tenantId && row.direction === 'internal' &&
            ['internal', 'public'].includes(row.confidentiality) && row.not_deleted === true &&
            ['to_qualify', 'to_file_dms', 'in_progress', 'closed'].includes(row.status);
        };
        if (!await sourceValid()) return null;
        const catalogues = { operational_plan: [plan], portfolio: [portfolio],
          ...(plan.dossier_id != null ? { dossier: [dossier] } : {}) };
        return {
          financialWriteGuard: Object.freeze({ planId: plan.id, assignmentId: assignment.id,
            decisionReference: plan.decision_reference, decisionVersion: plan.decision_version,
            decisionSha256: plan.decision_sha256, registration: plan.registration_reference,
            sourceReference: RAILWAY_SOURCE, planSourceKey: plan.source_key, planLabel: plan.label,
            portfolioRegistration: portfolio.registration_reference }),
          choices: { operational_plans: [{ id: plan.id, label: plan.label, portfolio_id: portfolio.id,
              function_id: plan.function_id }],
            assignments: [{ id: assignment.id, label: person.label, assignee_agent_id: person.id, team_id: person.team_id,
              function_id: plan.function_id, module: assignment.module }] },
          catalogue: { async get(kind, nativeId, tenant) {
            if (!await bindingStillValid()) return null;
            const row = tenant === tenantId && catalogues[kind]?.find(item => item.id === nativeId);
            return row ? { ...row } : null;
          } },
          async resolveAssignment(input) {
            const context = input?.context;
            return context?.execution_kind === 'operation' && context.operational_plan_id === plan.id &&
              ['assignee_agent_id', 'team_id', 'function_id', 'module'].every(key => input[key] === assignment[key]) &&
              await bindingStillValid()
              ? { ...assignment, agent_display_name: person.label } : null;
          },
          async qualifySources({ source_links, source_origin, context }) {
            if (context?.execution_kind !== 'operation' || context.operational_plan_id !== plan.id) return false;
            let links, origin;
            try { links = normalizeTaskSourceLinks(source_links); origin = normalizeTaskSourceLinks([source_origin])[0]; }
            catch { return false; }
            if (origin.kind !== 'correspondence' || origin.reference !== RAILWAY_SOURCE ||
                !links.every(link => link.kind === origin.kind && link.reference === origin.reference)) return false;
            try { return await bindingStillValid() && await sourceValid(); } catch { return false; }
          }
        };
      } catch { return null; }
    }
  };
}

// Read-only adapter for the existing native tables. It does not register or activate a plan.
function createNativeFinancialSourceCandidate({ bigquery, projectId, datasetId, location = 'US',
  planSourceKey, loadPerson, verifyDecision }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId || '') ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId || '') || !id(planSourceKey) ||
      typeof bigquery?.query !== 'function' || typeof bigquery?.dataset !== 'function' ||
      typeof loadPerson !== 'function' || typeof verifyDecision !== 'function') throw Error('TASK_FINANCIAL_SOURCE_INVALID');
  const field = (name, type = 'STRING', mode = 'REQUIRED') => ({ name, type, mode });
  const contracts = {
    management_operational_plans: { fields: [field('id'), field('tenant_id'), field('source_key'), field('label'),
      field('portfolio_id'), field('dossier_id', 'STRING', 'NULLABLE'), field('function_id'), field('governance_status'),
      field('status'), field('registration_reference'), field('decision_reference'), field('decision_version'),
      field('decision_sha256'), field('created_at', 'TIMESTAMP'), field('updated_at', 'TIMESTAMP')],
    clustering: ['tenant_id', 'source_key'] },
    management_operational_assignments: { fields: ['id', 'tenant_id', 'source_key', 'operational_plan_id',
      'actor_user_id', 'assignee_agent_id', 'team_id', 'function_id', 'module', 'governance_status', 'status',
      'registration_reference'].map(name => field(name)).concat([field('created_at', 'TIMESTAMP'), field('updated_at', 'TIMESTAMP')]),
    clustering: ['tenant_id', 'operational_plan_id', 'actor_user_id'] }
  };
  const table = name => `\`${projectId}.${datasetId}.${name}\``;
  const query = async (sql, params) => {
    const [rows] = await bigquery.query({ query: sql, params, location, maximumBytesBilled: '10485760' });
    if (!Array.isArray(rows)) throw Error('TASK_FINANCIAL_SOURCE_UNAVAILABLE');
    return rows;
  };
  const checkContracts = async () => {
    for (const [name, contract] of Object.entries(contracts)) {
      const [metadata] = await bigquery.dataset(datasetId).table(name).getMetadata();
      if (metadata.type !== 'TABLE' || metadata.expirationTime || metadata.timePartitioning?.expirationMs ||
          !hasExpectedBigQueryTableContract(metadata, contract)) throw Error('TASK_FINANCIAL_SOURCE_UNAVAILABLE');
    }
  };
  return {
    verifyDecision,
    async load({ tenantId, actorId }) {
      if (tenantId !== '2sg' || !actor(actorId)) return null;
      await checkContracts();
      const plans = await query(`SELECT * FROM ${table('management_operational_plans')} WHERE tenant_id=@tenant AND source_key=@source LIMIT 2`,
        { tenant: tenantId, source: planSourceKey });
      if (plans.length !== 1 || !id(plans[0].id)) return null;
      const plan = plans[0];
      const assignments = await query(`SELECT * FROM ${table('management_operational_assignments')} WHERE tenant_id=@tenant AND operational_plan_id=@plan AND actor_user_id=@actor LIMIT 2`,
        { tenant: tenantId, plan: plan.id, actor: actorId });
      const portfolios = await query(`SELECT tenant_id,portfolio_id,function_id,status,confidentiality,source_ref FROM ${table('management_portfolios')} WHERE tenant_id=@tenant AND portfolio_id=@portfolio LIMIT 2`,
        { tenant: tenantId, portfolio: FINANCE_PORTFOLIO });
      if (assignments.length !== 1 || portfolios.length !== 1) return null;
      const p = portfolios[0];
      if (p.tenant_id !== tenantId || p.portfolio_id !== FINANCE_PORTFOLIO || p.function_id !== 'management_governance' ||
          p.status !== 'active' || p.confidentiality !== 'internal' || typeof p.source_ref !== 'string' || !p.source_ref.trim()) return null;
      const person = await loadPerson({ tenantId, actorId, assigneeAgentId: assignments[0].assignee_agent_id });
      return { plan, assignment: assignments[0], person, dossier: null,
        portfolio: { id: p.portfolio_id, tenant_id: p.tenant_id, status: p.status,
          governance_status: 'approved', registration_reference: p.source_ref } };
    },
    async readCorrespondence({ tenantId, id: correspondenceId }) {
      if (tenantId !== '2sg' || correspondenceId !== RAILWAY_SOURCE) return null;
      const [metadata] = await bigquery.dataset(datasetId).table('administration_correspondence').getMetadata();
      if (metadata.type !== 'TABLE' || metadata.expirationTime || metadata.timePartitioning?.expirationMs ||
          !hasExpectedBigQueryTableContract(metadata, ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence)) return null;
      const rows = await query(`SELECT id,tenant_id,confidentiality,direction,status,deleted_at IS NULL AS not_deleted FROM ${table('administration_correspondence')} WHERE tenant_id=@tenant AND id=@id LIMIT 2`,
        { tenant: tenantId, id: correspondenceId });
      return rows.length === 1 ? rows[0] : null;
    }
  };
}

module.exports = { createFinancialOperationReferenceReader, buildFinancialOperationRegistrationPreparation,
  createNativeFinancialSourceCandidate, RAILWAY_SOURCE };
