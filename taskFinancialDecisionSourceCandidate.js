'use strict';

const { createHash } = require('node:crypto');
const { HASH, approvedDocument, categoryFor, scopeFor } = require('./gedPrivatePolicy');
const { hasExpectedBigQueryTableContract } = require('./bigQueryTableContract');

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(value);
const actor = value => typeof value === 'string' && value.trim() === value && value.length > 0 &&
  value.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const denied = () => Object.freeze({ status: 'unavailable', executable: false, productionChanged: false });

// Local simulation only. The injected authorities and all records are fictional;
// this function never grants access or authenticates a real decision.
async function reviewFictionalDecisionSource({ environment, tenantId, planId, decisionId, authority, documents } = {}) {
  if (environment !== 'fictitious' || tenantId !== '2sg' || !id(planId) || !id(decisionId) ||
      typeof authority?.read !== 'function' || typeof documents?.readVersion !== 'function') return denied();

  const valid = row => row && row.id === decisionId && row.tenant_id === tenantId &&
    row.operational_plan_id === planId && row.portfolio_id === 'PORT-2SG-GLOBAL' &&
    row.plan_function_id === 'finance' && row.portfolio_function_id === 'management_governance' &&
    row.scope === 'cross_function_operational_plan' && row.decider_person_id === 'PER-2SG-0001' &&
    row.decider_authorized === true && row.status === 'active' && id(row.revision) &&
    id(row.source_reference) && id(row.source_version) && digest(row.source_sha256);
  const fingerprint = row => JSON.stringify([row.id, row.tenant_id, row.operational_plan_id,
    row.portfolio_id, row.plan_function_id, row.portfolio_function_id, row.scope, row.decider_person_id,
    row.decider_authorized, row.status, row.revision, row.source_reference, row.source_version, row.source_sha256]);

  try {
    const decisions = await authority.read({ tenantId, decisionId });
    if (!Array.isArray(decisions) || decisions.length !== 1 || !valid(decisions[0])) return denied();
    const decision = { ...decisions[0] };
    const versions = await documents.readVersion({ tenantId, reference: decision.source_reference,
      version: decision.source_version });
    if (!Array.isArray(versions) || versions.length !== 1) return denied();
    const source = versions[0];
    if (!source || source.tenant_id !== tenantId || source.reference !== decision.source_reference ||
        source.version !== decision.source_version || source.status !== 'available' ||
        !Buffer.isBuffer(source.bytes) || source.bytes.length === 0 || source.bytes.length > 1024 * 1024 ||
        createHash('sha256').update(source.bytes).digest('hex') !== decision.source_sha256) return denied();
    const current = await authority.read({ tenantId, decisionId });
    if (!Array.isArray(current) || current.length !== 1 || !valid(current[0]) ||
        fingerprint(current[0]) !== fingerprint(decision)) return denied();
    return Object.freeze({ status: 'fictional_source_consistent_for_review', executable: false,
      productionChanged: false, humanReviewRequired: true,
      pending: Object.freeze(['qualify_real_authority_and_immutable_source', 'verify_actual_authority_and_access',
        'verify_native_plan_and_assignment', 'consider_chantal_response_when_received',
        'separate_authorisation_before_activation']) });
  } catch {
    return denied();
  }
}

// Candidate only: confirms document integrity and current GED revision, not decision authority.
// The caller must supply the authenticated principal and existing server-owned GED services.
async function inspectGedDecisionDocument({ policy, principal, register, storage, rootId, versionId, revision } = {}) {
  const unavailable = () => Object.freeze({ status: 'unavailable', decisionAuthorized: false, executable: false });
  try {
    if (!HASH.test(rootId || '') || !HASH.test(versionId || '') || !Number.isSafeInteger(revision) || revision < 0 ||
        typeof register?.lifecycle?.history !== 'function' || typeof register?.read !== 'function' ||
        typeof storage?.get !== 'function') return unavailable();
    const scope = scopeFor(policy, principal);
    if (categoryFor(approvedDocument(policy, rootId)) !== 'finance' ||
        categoryFor(approvedDocument(policy, versionId)) !== 'finance') return unavailable();
    const current = async () => {
      const events = await register.lifecycle.history(scope, rootId);
      if (!Array.isArray(events) || !events.length) return null;
      const last = events.at(-1);
      if (last.revision !== revision || last.current_document_id !== versionId || last.trashed !== false) return null;
      return last;
    };
    if (!await current()) return unavailable();
    const row = await register.read(scope, versionId);
    if (!row || row.tenant !== scope.tenant || row.owner_id !== scope.owner || row.document_id !== versionId ||
        !Number.isSafeInteger(row.byte_size) || !/^[1-9][0-9]{0,29}$/.test(row.generation || '')) return unavailable();
    const bytes = await storage.get({ key: `ged-private/v1/${scope.tenant}/${scope.owner}/${versionId}`,
      generation: row.generation, size: row.byte_size, sha256: versionId });
    approvedDocument(policy, versionId, bytes);
    if (!await current()) return unavailable();
    return Object.freeze({ status: 'document_verified_for_review', decisionAuthorized: false, executable: false });
  } catch { return unavailable(); }
}

// Composes existing GED checks with a separately governed server authority.
// It is deliberately not installed in the published server or connected to a real authority.
function createFinancialDecisionVerifierCandidate({ policy, principal, register, storage, authority } = {}) {
  if (typeof authority?.readCurrent !== 'function') throw new Error('FINANCE_DECISION_AUTHORITY_UNAVAILABLE');
  return async function verifyDecision({ tenantId, actorId, plan, portfolio, assignment } = {}) {
    try {
      if (tenantId !== '2sg' || !actor(actorId) || !plan || !portfolio || !assignment ||
          plan.tenant_id !== tenantId || assignment.tenant_id !== tenantId || portfolio.tenant_id !== tenantId ||
          plan.portfolio_id !== 'PORT-2SG-GLOBAL' || portfolio.id !== plan.portfolio_id ||
          plan.function_id !== 'finance' || assignment.function_id !== 'finance' ||
          assignment.operational_plan_id !== plan.id || assignment.actor_user_id !== actorId ||
          !HASH.test(plan.decision_reference || '') || !HASH.test(plan.decision_sha256 || '') ||
          typeof plan.decision_version !== 'string' || !/^(0|[1-9][0-9]{0,3})$/.test(plan.decision_version)) return false;
      const revision = Number(plan.decision_version);
      const readAuthority = () => authority.readCurrent({ tenantId, planId: plan.id });
      const valid = decision => decision && decision.tenant_id === tenantId && decision.plan_id === plan.id &&
        decision.portfolio_id === portfolio.id && decision.function_id === 'finance' &&
        decision.decider_person_id === 'PER-2SG-0001' && decision.status === 'active' &&
        decision.reference === plan.decision_reference && decision.sha256 === plan.decision_sha256 &&
        decision.revision === revision && typeof decision.authority_revision === 'string' &&
        id(decision.authority_revision);
      const first = await readAuthority();
      if (!valid(first)) return false;
      const fingerprint = JSON.stringify(first);
      const inspected = await inspectGedDecisionDocument({ policy, principal, register, storage,
        rootId: plan.decision_reference, versionId: plan.decision_sha256, revision });
      if (inspected.status !== 'document_verified_for_review') return false;
      const last = await readAuthority();
      return !!valid(last) && JSON.stringify(last) === fingerprint;
    } catch { return false; }
  };
}

// The approved reading copy is a narrowly pinned business decision, not a general mandate.
// Plan status comes from BigQuery; document state and bytes are checked by the verifier.
function createPinnedFinancialAuthorityCandidate({ bigquery, projectId, datasetId, location = 'US',
  policy, principal, actorId, contract, anchor } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId || '') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId || '') ||
      typeof bigquery?.query !== 'function' || typeof bigquery?.dataset !== 'function' || !actor(actorId) ||
      !contract || !anchor || !id(anchor.planId) || !id(anchor.registration) || !HASH.test(anchor.sha256 || '') ||
      anchor.revision !== 0) throw Error('FINANCE_AUTHORITY_CONFIGURATION_INVALID');
  const fixed = Object.freeze({ ...anchor });
  return {
    async readCurrent({ tenantId, planId } = {}) {
      try {
        if (tenantId !== '2sg' || planId !== fixed.planId || principal?.id !== actorId || principal?.tenantId !== tenantId) return null;
        scopeFor(policy, principal);
        const [metadata] = await bigquery.dataset(datasetId).table('management_operational_plans').getMetadata();
        if (metadata.type !== 'TABLE' || metadata.expirationTime || metadata.timePartitioning?.expirationMs ||
            !hasExpectedBigQueryTableContract(metadata, contract)) return null;
        const [rows] = await bigquery.query({ query: `SELECT id,tenant_id,portfolio_id,function_id,governance_status,status,
          registration_reference,decision_reference,decision_version,decision_sha256 FROM \`${projectId}.${datasetId}.management_operational_plans\`
          WHERE tenant_id=@tenant AND id=@plan LIMIT 2`, params: { tenant: tenantId, plan: planId },
        location, maximumBytesBilled: '10485760' });
        if (!Array.isArray(rows) || rows.length !== 1) return null;
        const row = rows[0];
        if (row.id !== fixed.planId || row.tenant_id !== tenantId || row.portfolio_id !== 'PORT-2SG-GLOBAL' ||
            row.function_id !== 'finance' || row.governance_status !== 'approved' || row.status !== 'active' ||
            row.registration_reference !== fixed.registration || row.decision_reference !== fixed.sha256 ||
            row.decision_sha256 !== fixed.sha256 || row.decision_version !== String(fixed.revision)) return null;
        return Object.freeze({ tenant_id: tenantId, plan_id: row.id, portfolio_id: row.portfolio_id,
          function_id: row.function_id, decider_person_id: 'PER-2SG-0001', status: row.status,
          reference: row.decision_reference, sha256: row.decision_sha256, revision: fixed.revision,
          authority_revision: row.registration_reference });
      } catch { return null; }
    }
  };
}

module.exports = { reviewFictionalDecisionSource, inspectGedDecisionDocument, createFinancialDecisionVerifierCandidate,
  createPinnedFinancialAuthorityCandidate };
