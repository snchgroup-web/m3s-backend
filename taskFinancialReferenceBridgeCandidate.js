'use strict';

const { PERMISSIONS } = require('./administrationRegistries');
const { TASK_EXECUTION_CONTRACT_VERSION } = require('./taskExecutionContract');
const { createFinancialOperationReferenceReader, createNativeFinancialSourceCandidate, RAILWAY_SOURCE } = require('./taskFinancialOperationReferences');
const { createFinancialDecisionVerifierCandidate, createPinnedFinancialAuthorityCandidate } = require('./taskFinancialDecisionSourceCandidate');
const { buildFinancialStoragePlanCandidate, buildFinancialRegistrationPreview } = require('./taskFinancialStoragePlanCandidate');
const { scopeFor } = require('./gedPrivatePolicy');

const FINANCE_DECISION_SHA256 = 'd20804902d9632fe8d33dc4f5a73c683504de88b853a7e24f026327cc6ad99c2';

// Dependencies must be server-owned; principal is taken from an already authenticated request.
function createFinancialSourceForActorCandidate({ bigquery, projectId, datasetId, location = 'US',
  getGedServices, loadPerson, canReadFinance }) {
  if (typeof getGedServices !== 'function' || typeof loadPerson !== 'function' ||
      typeof canReadFinance !== 'function') throw Error('TASK_FINANCIAL_RUNTIME_INVALID');
  const ids = buildFinancialRegistrationPreview().ids;
  const contract = buildFinancialStoragePlanCandidate().tables[0];
  return async actor => {
    if (!actor?.principal || actor.principal.id !== actor.actorId || actor.principal.tenantId !== actor.tenantId ||
        actor.tenantId !== '2sg' || !await canReadFinance(actor.principal)) throw Error('TASK_FINANCIAL_ACCESS_DENIED');
    const { policy, register, storage } = await getGedServices(actor.principal);
    scopeFor(policy, actor.principal);
    const authority = createPinnedFinancialAuthorityCandidate({ bigquery, projectId, datasetId, location,
      policy, principal: actor.principal, actorId: actor.actorId, contract,
      anchor: { planId: ids.plan, registration: ids.registration, sha256: FINANCE_DECISION_SHA256, revision: 0 } });
    const verifyDecision = createFinancialDecisionVerifierCandidate({ policy, principal: actor.principal,
      register, storage, authority });
    return createNativeFinancialSourceCandidate({ bigquery, projectId, datasetId, location,
      planSourceKey: ids.planSource, loadPerson, verifyDecision });
  };
}

// Disabled unless explicitly injected by a server; no production source is constructed here.
function createFinancialReferenceBridgeCandidate({ standardSource, financialSourceForActor, enabled = false }) {
  if (typeof standardSource?.inspectForActor !== 'function' || typeof standardSource?.bindForActor !== 'function' ||
      (enabled && typeof financialSourceForActor !== 'function')) throw Error('TASK_FINANCIAL_BRIDGE_INVALID');
  const financeFor = async actor => {
    if (!enabled || !actor || !Array.isArray(actor.permissions) ||
        !actor.permissions.includes(PERMISSIONS.RESOURCES_READ) ||
        !actor.permissions.includes(PERMISSIONS.CORRESPONDENCE_READ)) return null;
    try {
      const source = await financialSourceForActor(actor);
      return await createFinancialOperationReferenceReader({ source }).bindForActor(actor);
    } catch { return null; }
  };
  return {
    // The personal-task endpoint remains scoped to its existing project assignment.
    async inspectForPersonalTasks(actor) { return standardSource.inspectForActor(actor); },
    async inspectForActor(actor) {
      const base = await standardSource.inspectForActor(actor);
      if (!enabled) return base;
      const finance = await financeFor(actor);
      if (!finance) return base;
      const origin = { kind: 'correspondence', reference: RAILWAY_SOURCE, label: 'Suivi Railway - facture et reçu' };
      const origins = Array.isArray(base.source_origins) ? base.source_origins : [];
      const assignments = [...base.choices.assignments, ...finance.choices.assignments];
      if (new Set(assignments.map(item => item.id)).size !== assignments.length) return base;
      return { ...base, choices: { ...base.choices,
        operational_plans: finance.choices.operational_plans,
        assignments },
        source_origins: origins.some(item => item.kind === origin.kind && item.reference === origin.reference)
          ? origins : [...origins, origin],
        execution_catalogue_ready: true, finance_catalogue_ready: true,
        execution_scope: base.execution_catalogue_ready === true ? 'standardisation_project_and_finance_operation' : 'finance_operation_only',
        missing: [],
        standardisation_writes_enabled: base.writes_enabled === true,
        finance_activation_enabled: true,
        activation_enabled: true,
        writes_enabled: base.writes_enabled === true || (actor.permissions.includes(PERMISSIONS.RESOURCES_WRITE) && enabled) };
    },
    async bindForActor(actor) {
      const base = await standardSource.bindForActor(actor);
      if (!enabled || !actor?.permissions?.includes(PERMISSIONS.RESOURCES_WRITE)) return base;
      const finance = await financeFor(actor);
      if (!finance) return base;
      return { contract_version: TASK_EXECUTION_CONTRACT_VERSION, writes_enabled: true,
        financialWriteGuard: finance.financialWriteGuard,
        catalogue: { async get(kind, nativeId, tenantId) {
          if (kind === 'operational_plan') return finance.catalogue.get(kind, nativeId, tenantId);
          if (kind === 'portfolio' || kind === 'dossier') {
            const row = await finance.catalogue.get(kind, nativeId, tenantId);
            if (row) return row;
          }
          return base?.catalogue?.get(kind, nativeId, tenantId) || null;
        } },
        async resolveAssignment(input) {
          if (input?.context?.execution_kind === 'operation') return finance.resolveAssignment(input);
          return base?.resolveAssignment?.(input) || null;
        },
        async qualifySources(input) {
          if (input?.context?.execution_kind === 'operation') return finance.qualifySources(input);
          return base?.qualifySources?.(input) || false;
        } };
    }
  };
}

module.exports = { createFinancialReferenceBridgeCandidate, createFinancialSourceForActorCandidate, FINANCE_DECISION_SHA256 };
