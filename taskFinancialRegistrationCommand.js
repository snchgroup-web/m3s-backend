'use strict';

const { FINANCE_DECISION_SHA256, buildFinancialRegistrationPreview,
  buildFinancialStoragePlanCandidate } = require('./taskFinancialStoragePlanCandidate');
const { TASK_EXECUTION_CONTRACT_VERSION } = require('./taskExecutionContract');

const validText = value => typeof value === 'string' && value.trim() === value && value.length > 0 &&
  value.length <= 180 && !/[\x00-\x1f\x7f-\x9f]/.test(value);

// Assembles the one registration request without network access or execution.
// Syntax validation does not authenticate the actor or prove that approval,
// concurrent writers, backups, or all costs have been qualified.
function buildFinancialRegistrationCommand({ actorId, observedRevision, auditId, target } = {}) {
  if (!validText(actorId) || !Number.isSafeInteger(observedRevision) || observedRevision < 0 ||
      !validText(auditId) || !validText(`${auditId}-assignment`)) {
    throw Error('FINANCE_REGISTRATION_INPUT_INVALID');
  }
  const preview = buildFinancialRegistrationPreview(target);
  const design = buildFinancialStoragePlanCandidate();
  const { ids } = preview;
  const auditMetadata = JSON.stringify({ contract_version: TASK_EXECUTION_CONTRACT_VERSION,
    registration_reference: ids.registration, decision_sha256: FINANCE_DECISION_SHA256,
    approval_thread: design.existing_evidence.thread,
    approval_messages: design.existing_evidence.validation_messages,
    consultation_reference: design.existing_evidence.consultation_response_correspondence });
  const params = Object.freeze({ plan_id: ids.plan, assignment_id: ids.assignment,
    plan_source: ids.planSource, assignment_source: ids.assignmentSource,
    registration: ids.registration, label: design.prepared_plan.label,
    decision_reference: FINANCE_DECISION_SHA256, decision_sha256: FINANCE_DECISION_SHA256,
    decision_version: '0', finance_observed_revision: observedRevision,
    contract_version: TASK_EXECUTION_CONTRACT_VERSION, actor: actorId, audit_id: auditId,
    audit_metadata: auditMetadata });
  const types = Object.freeze(Object.fromEntries(Object.keys(params).map(key =>
    [key, key === 'finance_observed_revision' ? 'INT64' : 'STRING'])));
  return Object.freeze({ status: 'prepared_only', executable: false, sql: preview.sql, params, types,
    pending: Object.freeze([...preview.pending]) });
}

module.exports = { buildFinancialRegistrationCommand };
