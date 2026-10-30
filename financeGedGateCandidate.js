'use strict';

const { randomUUID } = require('node:crypto');

const fail = () => Object.assign(new Error('FINANCE_GED_GATE_UNAVAILABLE'), { code: 'FINANCE_GED_GATE_UNAVAILABLE' });
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Candidate: no runtime wiring. Correctness requires all relevant writers to use this fence.
function createFinanceGedGateCandidate({ bigquery, projectId, datasetId, location = 'US' }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId || '') ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId || '') || typeof bigquery?.query !== 'function') throw fail();
  const table = name => `\`${projectId}.${datasetId}.${name}\``;
  const state = table('administration_task_registry_state'), audit = table('administration_audit_log');
  const run = (query, params) => bigquery.query({ query, params, location, maximumBytesBilled: '10485760' });

  async function freeze({ tenantId, actorId, documentId, expectedRevision }) {
    if (tenantId !== '2sg' || !identity(actorId) || !hash(documentId) ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 10000) throw fail();
    const operationId = `GATE-${randomUUID()}`;
    const [rows] = await run(`BEGIN TRANSACTION;
      UPDATE ${state} SET revision=-revision-1 WHERE id='registry' AND revision>=0
        AND revision<9007199254740990 AND contract_version=@contract_version;
      ASSERT @@row_count=1 AS 'FINANCE_GED_GATE_UNAVAILABLE';
      INSERT INTO ${audit} (id,tenant_id,actor_user_id,actor_name,entity_type,entity_id,action,event_at,metadata_json)
        SELECT @operation_id,@tenant_id,@actor_id,NULL,'finance_ged_gate',@document_id,'freeze',CURRENT_TIMESTAMP(),
          TO_JSON_STRING(STRUCT(@document_id AS document_sha256,@expected_revision AS expected_document_revision,
            @operation_id AS operation_id,revision AS frozen_revision)) FROM ${state} WHERE id='registry';
      CREATE TEMP TABLE gate_result AS SELECT revision FROM ${state} WHERE id='registry';
      COMMIT TRANSACTION;
      SELECT revision FROM gate_result;`, { contract_version: 'm3s.task-execution.v2', operation_id: operationId,
      tenant_id: tenantId, actor_id: actorId, document_id: documentId, expected_revision: expectedRevision });
    const raw = rows?.[0]?.revision?.value ?? rows?.[0]?.revision;
    const revision = Number(raw);
    if (!Array.isArray(rows) || rows.length !== 1 || raw == null || !Number.isSafeInteger(revision) || revision >= 0) throw fail();
    return Object.freeze({ revision, operationId, tenantId, actorId, documentId, expectedRevision });
  }

  async function thaw(token) {
    if (!token || token.tenantId !== '2sg' || !identity(token.actorId) || !hash(token.documentId) ||
        !Number.isSafeInteger(token.revision) || token.revision >= 0 ||
        !/^GATE-[0-9a-f-]{36}$/.test(token.operationId || '')) throw fail();
    const metadata = JSON.stringify({ document_sha256: token.documentId, operation_id: token.operationId });
    const [rows] = await run(`DECLARE released BOOL DEFAULT FALSE;
      BEGIN TRANSACTION;
      ASSERT (SELECT COUNT(*) FROM ${audit} WHERE id=@operation_id AND tenant_id=@tenant_id
        AND actor_user_id=@actor_id AND entity_type='finance_ged_gate' AND entity_id=@document_id AND action='freeze'
        AND SAFE_CAST(JSON_VALUE(metadata_json,'$.frozen_revision') AS INT64)=@frozen_revision)=1
        AS 'FINANCE_GED_GATE_UNAVAILABLE';
      UPDATE ${state} SET revision=-revision WHERE id='registry' AND revision=@frozen_revision
        AND contract_version=@contract_version;
      SET released=(@@row_count=1);
      IF released THEN
        INSERT INTO ${audit} (id,tenant_id,actor_user_id,actor_name,entity_type,entity_id,action,event_at,metadata_json)
          VALUES (@thaw_id,@tenant_id,@actor_id,NULL,'finance_ged_gate',@document_id,'thaw',CURRENT_TIMESTAMP(),@metadata);
      ELSE
        ASSERT (SELECT COUNT(*) FROM ${audit} WHERE id=@thaw_id AND tenant_id=@tenant_id AND actor_user_id=@actor_id
          AND entity_type='finance_ged_gate' AND entity_id=@document_id AND action='thaw')=1
          AS 'FINANCE_GED_GATE_UNAVAILABLE';
        ASSERT (SELECT COUNT(*) FROM ${state} WHERE id='registry' AND revision>=-@frozen_revision
          AND contract_version=@contract_version)=1 AS 'FINANCE_GED_GATE_UNAVAILABLE';
      END IF;
      CREATE TEMP TABLE gate_result AS SELECT revision FROM ${state} WHERE id='registry';
      COMMIT TRANSACTION;
      SELECT revision FROM gate_result;`, { contract_version: 'm3s.task-execution.v2', frozen_revision: token.revision,
      operation_id: token.operationId, thaw_id: `${token.operationId}-thaw`, tenant_id: token.tenantId, actor_id: token.actorId,
      document_id: token.documentId, metadata });
    const raw = rows?.[0]?.revision?.value ?? rows?.[0]?.revision;
    const revision = Number(raw);
    if (!Array.isArray(rows) || rows.length !== 1 || raw == null || !Number.isSafeInteger(revision) || revision < -token.revision) throw fail();
    return revision;
  }

  async function findFrozen({ tenantId, actorId, documentId }) {
    if (tenantId !== '2sg' || !identity(actorId) || !hash(documentId)) throw fail();
    const [rows] = await run(`SELECT s.revision,a.id AS operation_id,
        SAFE_CAST(JSON_VALUE(a.metadata_json,'$.expected_document_revision') AS INT64) AS expected_revision
      FROM ${state} s JOIN ${audit} a ON a.tenant_id=@tenant_id AND a.actor_user_id=@actor_id
        AND a.entity_type='finance_ged_gate' AND a.entity_id=@document_id AND a.action='freeze'
        AND SAFE_CAST(JSON_VALUE(a.metadata_json,'$.frozen_revision') AS INT64)=s.revision
      LEFT JOIN ${audit} done ON done.id=CONCAT(a.id,'-thaw') AND done.tenant_id=a.tenant_id
        AND done.entity_type='finance_ged_gate' AND done.action='thaw'
      WHERE s.id='registry' AND s.revision<0 AND s.contract_version=@contract_version
        AND done.id IS NULL
      LIMIT 2`, { tenant_id: tenantId, actor_id: actorId, document_id: documentId,
      contract_version: 'm3s.task-execution.v2' });
    const row = rows?.[0], raw = row?.revision?.value ?? row?.revision;
    const rawExpected = row?.expected_revision?.value ?? row?.expected_revision;
    const revision = Number(raw), expectedRevision = Number(rawExpected);
    if (!Array.isArray(rows) || rows.length !== 1 || raw == null || rawExpected == null ||
        !Number.isSafeInteger(revision) || revision >= 0 || !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 || expectedRevision > 10000 || !/^GATE-[0-9a-f-]{36}$/.test(row.operation_id || '')) throw fail();
    return Object.freeze({ revision, operationId: row.operation_id, tenantId, actorId, documentId, expectedRevision });
  }

  async function protectMutation(input, mutate) {
    if (typeof mutate !== 'function') throw fail();
    const token = await freeze(input);
    // Any uncertain mutation outcome leaves the gate closed for controlled recovery.
    let result;
    try { result = await mutate(async () => {
      const current = await findFrozen(input);
      if (current.revision !== token.revision || current.operationId !== token.operationId) throw fail();
    }); }
    catch (error) {
      if (error?.gedRollbackConfirmed === true) await thaw(token);
      throw error;
    }
    await thaw(token);
    return result;
  }
  return Object.freeze({ freeze, thaw, findFrozen, protectMutation });
}

function createFinancialDecisionMutationGuard({ gate, documentId, canManage }) {
  if (typeof gate?.protectMutation !== 'function' || typeof canManage !== 'function' || !hash(documentId)) throw fail();
  return (req, mutate) => {
    if (req.params?.id !== documentId) return mutate();
    if (canManage(req.user) !== true) throw Object.assign(Error('GED_ACCESS_DENIED'), { code: 'GED_ACCESS_DENIED' });
    if (!Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision < 0 || req.body.expectedRevision > 10000)
      throw Object.assign(Error('GED_VERSION_CONFLICT'), { code: 'GED_VERSION_CONFLICT' });
    return gate.protectMutation({ tenantId: req.user?.tenantId, actorId: req.user?.id,
      documentId, expectedRevision: req.body?.expectedRevision }, mutate);
  };
}

module.exports = { createFinanceGedGateCandidate, createFinancialDecisionMutationGuard };
