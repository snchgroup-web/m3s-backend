const crypto = require('node:crypto');
const { hasExpectedBigQueryTableContract } = require('./bigQueryTableContract');
const { PERMISSIONS, ADMINISTRATION_TABLE_CONTRACTS } = require('./administrationRegistries');
const { TASK_EXECUTION_CONTRACT_VERSION, normalizeTaskExecutionContext,
  normalizeTaskSourceLinks, resolveTaskExecutionContext } = require('./taskExecutionContract');

const field = (name, type = 'STRING', mode = 'REQUIRED') => ({ name, type, mode });
const nullable = name => field(name, 'STRING', 'NULLABLE');
const DATA_FIELDS = [
  field('contract_version'), field('title'), nullable('description'), field('expected_result'),
  nullable('verification_criterion'), field('status'), field('priority'), field('module'),
  field('responsable'), field('assignee_agent_id'), nullable('team_id'), field('function_id'),
  field('progression', 'INTEGER', 'NULLABLE'),
  ...['planned_start_date', 'due_date', 'actual_start_date', 'actual_end_date'].map(name => field(name, 'DATE', 'NULLABLE')),
  field('execution_kind'), ...['phase_id', 'activity_id', 'project_id', 'dossier_id', 'portfolio_id',
    'operational_plan_id', 'recurrence_id', 'occurrence_key', 'occurrence_identity'].map(nullable),
  field('context_key'), field('source_links_json'), field('source_origin_json'), nullable('source_identity')
];
const DATA_NAMES = DATA_FIELDS.map(f => f.name);
const TASK_TABLE_CONTRACTS = Object.freeze({
  administration_tasks: {
    fields: [field('id'), field('tenant_id'), field('owner_user_id'), field('reference'), field('reference_key'),
      ...DATA_FIELDS, field('revision', 'INTEGER'), field('payload_hash'),
      field('created_at', 'TIMESTAMP'), field('updated_at', 'TIMESTAMP')],
    partitionField: 'created_at', clustering: ['tenant_id', 'owner_user_id', 'execution_kind', 'status']
  },
  administration_task_registry_state: {
    fields: [field('id'), field('revision', 'INTEGER'), field('contract_version')], clustering: []
  }
});
const INPUT_FIELDS = ['contract_version', 'title', 'description', 'expected_result', 'verification_criterion',
  'status', 'priority', 'module', 'assignee_agent_id', 'team_id', 'function_id', 'progression',
  'planned_start_date', 'due_date', 'actual_start_date', 'actual_end_date',
  'execution_context', 'source_links', 'source_origin'];
const STATUSES = new Set(['to_do', 'in_progress', 'done', 'blocked', 'cancelled']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const COMPLETED = "'TERMINÉ','TERMINE','DONE','ERLEDIGT'";
const CANCELLED = "'ANNULÉ','ANNULE','CANCELLED','CANCELED','ABGEBROCHEN'";
const BLOCKED = "'BLOQUÉ','BLOQUE','BLOCKED','BLOCKIERT'";
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizeKey = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const tablePrefix = ({ projectId, datasetId }) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(projectId)
    || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(datasetId)) throw fail('TASK_INVALID_TARGET');
  return name => `\`${projectId}.${datasetId}.${name}\``;
};

// Schema description only; migration/recovery and UI gates remain closed.
function buildTaskRegistrySchemaPlan(config) {
  tablePrefix(config);
  return { tables: Object.keys(TASK_TABLE_CONTRACTS), statements: [],
    contract_version: TASK_EXECUTION_CONTRACT_VERSION, application_allowed: false,
    code: 'TASK_MODEL_ALIGNMENT_REQUIRED',
    pending: ['governed_project_phase_and_operational_plan_sources',
      'controlled_backup_and_schema_application', 'frontend_contract_alignment'] };
}

// Review output only. The application factory never executes this proposal.
function buildTaskActivationSchemaProposal(config) {
  const table = tablePrefix(config);
  const { STANDARDISATION_TABLE_CONTRACTS } = require('./taskStandardisationReferences');
  const contracts = { ...STANDARDISATION_TABLE_CONTRACTS, ...TASK_TABLE_CONTRACTS };
  return { application_allowed: false, cloud_access: false, tables: Object.keys(contracts),
    proposed_statements: Object.entries(contracts).map(([name, contract]) => {
      const fields = contract.fields.map(f => `${f.name} ${f.type}${f.mode === 'REQUIRED' ? ' NOT NULL' : ''}`).join(',\n  ');
      return `CREATE TABLE ${table(name)} (\n  ${fields}\n)`
        + (contract.partitionField ? `\nPARTITION BY DATE(${contract.partitionField})` : '')
        + (contract.clustering.length ? `\nCLUSTER BY ${contract.clustering.join(', ')}` : '')
        + `\nOPTIONS (expiration_timestamp = NULL${contract.partitionField ? ', partition_expiration_days = NULL' : ''})`;
    }),
    required_existing_table: 'administration_audit_log',
    pending: ['protected_backup_and_restore_control', 'explicit_target_and_schema_approval',
      'exact_table_absence_or_compatibility_preflight', 'governed_native_registration_and_actor_binding',
      'atomic_registry_state_initialisation_and_live_checks', 'explicit_limited_activation'],
    exclusions: ['existing_table_changes', 'historical_task_import', 'iam_changes', 'automatic_execution'] };
}

function normalizeTask(body, create = true) {
  if (!plain(body)) throw fail('TASK_INVALID');
  if (body.contract_version !== TASK_EXECUTION_CONTRACT_VERSION) throw fail('TASK_CONTRACT_MISMATCH');
  const allowed = new Set([...INPUT_FIELDS, ...(create ? ['reference'] : [])]);
  if (Object.keys(body).some(key => !allowed.has(key))) throw fail('TASK_INVALID');
  const text = (key, min, max, optional = false) => {
    const value = body[key];
    if (optional && (value == null || value === '')) return null;
    if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw fail('TASK_INVALID');
    const result = value.trim();
    if (result.length < min || result.length > max) throw fail('TASK_INVALID');
    return result;
  };
  const id = (key, optional = false) => {
    const result = text(key, 1, 180, optional);
    if (result !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result)) throw fail('TASK_INVALID');
    return result;
  };
  const task = { contract_version: TASK_EXECUTION_CONTRACT_VERSION,
    ...(create ? { reference: text('reference', 3, 180) } : {}),
    title: text('title', 3, 240), description: text('description', 1, 4000, true),
    expected_result: text('expected_result', 1, 2000),
    verification_criterion: text('verification_criterion', 1, 2000, true),
    status: body.status, priority: body.priority, module: text('module', 1, 100),
    assignee_agent_id: id('assignee_agent_id'), team_id: id('team_id', true), function_id: id('function_id'),
    progression: body.progression == null ? null : body.progression,
    execution_context: normalizeTaskExecutionContext(body.execution_context),
    source_links: normalizeTaskSourceLinks(body.source_links ?? []),
    source_origin: body.source_origin == null ? null : normalizeTaskSourceLinks([body.source_origin])[0] };
  if (!STATUSES.has(task.status) || !PRIORITIES.has(task.priority)
    || (task.progression !== null && (!Number.isInteger(task.progression)
      || task.progression < 0 || task.progression > 100))) throw fail('TASK_INVALID');
  for (const key of ['planned_start_date', 'due_date', 'actual_start_date', 'actual_end_date']) {
    const value = text(key, 10, 10, true);
    if (value !== null) {
      const date = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900
        || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw fail('TASK_INVALID');
    }
    task[key] = value;
  }
  if (task.planned_start_date && task.due_date && task.planned_start_date > task.due_date) throw fail('TASK_INVALID');
  if (task.actual_start_date && task.actual_end_date && task.actual_start_date > task.actual_end_date) throw fail('TASK_INVALID');
  if (task.source_origin?.kind === 'historical_task') throw fail('TASK_POTENTIAL_HISTORICAL_DUPLICATE', 409);
  return task;
}

function createTaskRegistryHandlers({ bigquery, projectId, datasetId, location = 'US', referenceSource, historicalTenantId = '2sg',
  now = () => new Date().toISOString(), logger = console }) {
  const table = tablePrefix({ projectId, datasetId });
  const tasks = table('administration_tasks'), state = table('administration_task_registry_state');
  const audit = table('administration_audit_log');
  const run = (query, params = {}, types) => bigquery.query({ query, params, location, ...(types ? { types } : {}) });
  const identity = req => {
    const user = req.user;
    const tenant = String(user?.tenantId || user?.organizationId || '').trim();
    const owner = String(user?.id || '').trim();
    if (!tenant || !owner) throw fail('TASK_UNAUTHENTICATED', 401);
    const permissions = Array.isArray(user.permissions) ? [...user.permissions] : [];
    return { tenant_id: tenant, owner_user_id: owner, permissions, role: user.role,
      canRead: tenant === historicalTenantId && permissions.includes(PERMISSIONS.RESOURCES_READ),
      canWrite: tenant === historicalTenantId && permissions.includes(PERMISSIONS.RESOURCES_READ) && permissions.includes(PERMISSIONS.RESOURCES_WRITE) };
  };
  const noStore = res => res.set('Cache-Control', 'no-store');
  const respondError = (res, error) => {
    let code = /^(TASK_(INVALID|CONTRACT_MISMATCH|CONFLICT|DUPLICATE_REFERENCE|POTENTIAL_HISTORICAL_DUPLICATE|SOURCE_UNAVAILABLE|FORBIDDEN|UNAUTHENTICATED|CONTEXT_INVALID|CONTEXT_SOURCE_UNAVAILABLE|CONTEXT_REFERENCE_UNQUALIFIED|SOURCE_LINK_INVALID|SOURCE_LINK_DUPLICATE|ASSIGNMENT_UNQUALIFIED|SOURCE_UNQUALIFIED))$/.test(error.code || '')
      ? error.code : 'TASK_SOURCE_UNAVAILABLE';
    if (/TASK_DUPLICATE_REFERENCE/.test(error.message)) code = 'TASK_DUPLICATE_REFERENCE';
    else if (/TASK_CONFLICT|concurrent update|transaction.*aborted/i.test(error.message)) code = 'TASK_CONFLICT';
    const unavailable = ['TASK_SOURCE_UNAVAILABLE', 'TASK_CONTEXT_SOURCE_UNAVAILABLE'].includes(code);
    const status = error.status || (unavailable ? 503 : ['TASK_CONFLICT', 'TASK_DUPLICATE_REFERENCE'].includes(code) ? 409 : 400);
    logger.warn?.('Task registry request failed', code);
    return res.status(status).json({ success: false, code, error: code });
  };
  const sourceReady = async () => {
    try {
      for (const [name, contract] of Object.entries({ ...TASK_TABLE_CONTRACTS,
        administration_audit_log: ADMINISTRATION_TABLE_CONTRACTS.administration_audit_log })) {
        const [metadata] = await bigquery.dataset(datasetId).table(name).getMetadata();
        if (!hasExpectedBigQueryTableContract(metadata, contract) || metadata.expirationTime
          || metadata.timePartitioning?.expirationMs) return false;
      }
      const [rows] = await run(`SELECT COUNT(*) AS total,
        COUNTIF(id='registry' AND revision>=0 AND contract_version=@contract_version) AS valid,
        (SELECT COUNT(*) FROM ${tasks} WHERE contract_version!=@contract_version) AS invalid_task_versions FROM ${state}`,
      { contract_version: TASK_EXECUTION_CONTRACT_VERSION });
      return Number(rows[0]?.total) === 1 && Number(rows[0]?.valid) === 1
        && Number(rows[0]?.invalid_task_versions) === 0;
    } catch { return false; }
  };
  const bind = async actor => {
    if (!actor.canWrite || typeof referenceSource?.bindForActor !== 'function') return null;
    try {
      const bound = await referenceSource.bindForActor({ tenantId: actor.tenant_id,
        actorId: actor.owner_user_id, permissions: [...actor.permissions], role: actor.role });
      return bound?.contract_version === TASK_EXECUTION_CONTRACT_VERSION && bound.writes_enabled === true
        && typeof bound.catalogue?.get === 'function' && typeof bound.resolveAssignment === 'function'
        && typeof bound.qualifySources === 'function' ? bound : null;
    } catch { return null; }
  };
  const compatible = req => req.query?.contract_version === TASK_EXECUTION_CONTRACT_VERSION;
  const paramsFor = actor => ({ tenant_id: actor.tenant_id, owner_user_id: actor.owner_user_id,
    contract_version: TASK_EXECUTION_CONTRACT_VERSION });
  const PUBLIC_FIELDS = TASK_TABLE_CONTRACTS.administration_tasks.fields.filter(f =>
    !['tenant_id', 'owner_user_id', 'reference_key', 'payload_hash', 'context_key', 'source_identity'].includes(f.name));
  const selectField = f => f.type === 'DATE' || f.type === 'TIMESTAMP'
    ? `CAST(${f.name} AS STRING) AS ${f.name}`
    : f.name === 'progression' ? 'CAST(progression AS FLOAT64) AS progression' : f.name;
  const extraFields = ['source_start_date', 'source_due_date', 'projet', 'team', 'bu', 'annee'];
  const historical = fallback => {
    const raw = fallback ? {
      id: 'CAST(string_field_0 AS STRING)', reference: 'CAST(string_field_0 AS STRING)',
      title: 'COALESCE(string_field_1,string_field_0)', description: 'string_field_2',
      status: 'string_field_3', priority: 'string_field_4', source_start_date: 'CAST(string_field_5 AS STRING)'
    } : {
      id: 'CAST(source_id AS STRING)', reference: 'CAST(source_id AS STRING)', title: 'titre',
      description: 'description', status: 'statut', priority: 'priorite', responsable: 'responsable',
      module: 'module', progression: 'CAST(progression AS FLOAT64)', due_date: 'CAST(date_fin AS STRING)',
      source_start_date: 'CAST(date_debut AS STRING)', source_due_date: 'CAST(date_fin AS STRING)',
      projet: 'projet', team: 'team', bu: 'bu', annee: 'CAST(annee AS STRING)'
    };
    const values = PUBLIC_FIELDS.map(f => `${raw[f.name] || `CAST(NULL AS ${f.name === 'progression' ? 'FLOAT64' : f.type === 'INTEGER' ? 'INT64' : 'STRING'})`} AS ${f.name}`);
    return `SELECT ${[...values, ...extraFields.map(name => `${raw[name] || 'CAST(NULL AS STRING)'} AS ${name}`),
      "'historical' AS source_kind", 'FALSE AS can_edit'].join(',')}
      FROM ${table(fallback ? 'bdd_taches' : 'taches_propres')}${fallback ? " WHERE string_field_0 IS NOT NULL AND TRIM(string_field_0)!='' AND string_field_0!='Unnamed: 0'" : ''}`;
  };
  const operational = canWrite => `SELECT ${PUBLIC_FIELDS.map(selectField).join(',')},
    ${extraFields.map(name => `CAST(NULL AS STRING) AS ${name}`).join(',')},
    'operational' AS source_kind,${canWrite ? 'TRUE' : 'FALSE'} AS can_edit
    FROM ${tasks} WHERE tenant_id=@tenant_id AND owner_user_id=@owner_user_id AND contract_version=@contract_version`;
  const withHistoricalFallback = async factory => {
    try { return await factory(false); }
    catch (error) {
      if (!String(error.message).includes(`Not found: Table ${projectId}:${datasetId}.taches_propres`)
        && !String(error.message).includes(`Not found: Table ${projectId}.${datasetId}.taches_propres`)) throw error;
      return factory(true);
    }
  };
  const project = row => {
    if (row.source_kind === 'historical') return { ...row, source_id: row.id, titre: row.title,
      statut: row.status, priorite: row.priority, created_at: null,
      date_debut: row.source_start_date ?? null, date_fin: row.source_due_date ?? null, can_edit: false };
    try {
      const source_links = normalizeTaskSourceLinks(JSON.parse(row.source_links_json));
      const origin = JSON.parse(row.source_origin_json);
      const source_origin = origin === null ? null : normalizeTaskSourceLinks([origin])[0];
      const execution_context = normalizeTaskExecutionContext(Object.fromEntries([
        'execution_kind', 'phase_id', 'activity_id', 'operational_plan_id', 'recurrence_id', 'occurrence_key'
      ].map(key => [key, row[key] ?? null])));
      if (row.contract_version !== TASK_EXECUTION_CONTRACT_VERSION || !Number.isSafeInteger(Number(row.revision))
        || Number(row.revision) < 1) throw fail('TASK_SOURCE_UNAVAILABLE', 503);
      const { source_links_json, source_origin_json, ...record } = row;
      return { ...record, source_links, source_origin, execution_context,
        source_id: row.id, titre: row.title, statut: row.status, priorite: row.priority,
        date_debut: row.planned_start_date ?? null, date_fin: row.due_date ?? null,
        related_reference: source_origin?.reference ?? source_links[0]?.reference ?? null };
    } catch { throw fail('TASK_SOURCE_UNAVAILABLE', 503); }
  };
  const coverage = ready => ({ operational_available: ready,
    coverage: ready ? 'historical_and_current_account' : 'historical_only',
    contract_version: TASK_EXECUTION_CONTRACT_VERSION });
  const access = async (req, res) => {
    noStore(res);
    try {
      const actor = identity(req), ready = actor.canRead && await sourceReady();
      const bound = ready ? await bind(actor) : null;
      res.json({ success: true, enabled: ready, can_read: ready,
        can_write: Boolean(ready && bound && compatible(req)), scope: 'current_account',
        identity_scope: 'tenant_reference', write_contract_ready: Boolean(bound),
        client_contract_compatible: compatible(req), ...coverage(ready),
        ...(!ready ? { code: actor.canRead ? 'TASK_SOURCE_UNAVAILABLE' : 'TASK_FORBIDDEN' }
          : !bound ? { code: 'TASK_CONTEXT_SOURCE_UNAVAILABLE' }
            : !compatible(req) ? { code: 'TASK_CONTRACT_MISMATCH' } : {}) });
    } catch (error) { respondError(res, error); }
  };
  const references = async (req, res) => {
    noStore(res);
    try {
      const actor = identity(req);
      if (!actor.canRead) throw fail('TASK_FORBIDDEN', 403);
      if (typeof referenceSource?.inspectForActor !== 'function') throw fail('TASK_CONTEXT_SOURCE_UNAVAILABLE', 503);
      const data = await referenceSource.inspectForActor({ tenantId: actor.tenant_id,
        actorId: actor.owner_user_id, permissions: [...actor.permissions], role: req.user.role });
      if (data?.contract_version !== TASK_EXECUTION_CONTRACT_VERSION) throw fail('TASK_CONTEXT_SOURCE_UNAVAILABLE', 503);
      res.json({ success: true, ...data });
    } catch (error) { respondError(res, error); }
  };
  const list = async (req, res) => {
    noStore(res);
    try {
      const actor = identity(req);
      if (!actor.canRead) throw fail('TASK_FORBIDDEN', 403);
      const limit = req.query?.limit == null ? 100 : Number(req.query.limit);
      const offset = req.query?.offset == null ? 0 : Number(req.query.offset);
      const search = String(req.query?.search || '').trim();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset)
        || offset < 0 || offset > 100000 || search.length > 240) throw fail('TASK_INVALID');
      const ready = actor.canRead && await sourceReady();
      const editable = Boolean(ready && compatible(req) && await bind(actor));
      const [result] = await withHistoricalFallback(fallback => run(`WITH all_tasks AS (
        ${historical(fallback)} ${ready ? `UNION ALL ${operational(editable)}` : ''}
        ), filtered AS (SELECT * FROM all_tasks WHERE @search='' OR STRPOS(LOWER(CONCAT(
          COALESCE(title,''),' ',COALESCE(reference,''),' ',COALESCE(module,''))),LOWER(@search))>0)
        SELECT (SELECT COUNT(*) FROM filtered) AS total,
          ARRAY(SELECT AS STRUCT * FROM filtered ORDER BY
            COALESCE(SAFE_CAST(created_at AS TIMESTAMP),SAFE_CAST(source_start_date AS TIMESTAMP)) DESC,id
            LIMIT @limit OFFSET @offset) AS items`, { ...paramsFor(actor), search, limit, offset }));
      const row = result[0];
      if (!row || !Array.isArray(row.items) || row.total == null || !Number.isSafeInteger(Number(row.total))) throw fail('TASK_SOURCE_UNAVAILABLE', 503);
      res.json({ success: true, data: row.items.map(project), count: row.items.length,
        limit, offset, total: Number(row.total), ...coverage(ready), timestamp: now() });
    } catch (error) { respondError(res, error); }
  };
  const count = async (req, res) => {
    noStore(res);
    try {
      const actor = identity(req);
      if (!actor.canRead) throw fail('TASK_FORBIDDEN', 403);
      const ready = await sourceReady();
      const [rows] = await withHistoricalFallback(fallback => run(`WITH all_tasks AS (
        ${historical(fallback)} ${ready ? `UNION ALL ${operational(false)}` : ''}
        ), statuses AS (SELECT UPPER(TRIM(COALESCE(status,''))) AS status,source_kind FROM all_tasks)
        SELECT COUNT(*) AS total, COUNTIF(status IN (${COMPLETED})) AS completed,
          COUNTIF(status IN (${BLOCKED})) AS blocked, COUNTIF(status IN (${CANCELLED})) AS cancelled,
          COUNTIF(status NOT IN (${COMPLETED},${CANCELLED})) AS open,
          COUNTIF(source_kind='historical') AS historical_total,
          COUNTIF(source_kind='operational') AS operational_total FROM statuses`, paramsFor(actor)));
      const keys = ['total', 'completed', 'blocked', 'cancelled', 'open', 'historical_total', 'operational_total'];
      if (!rows[0] || keys.some(key => rows[0][key] == null || !Number.isSafeInteger(Number(rows[0][key])))) throw fail('TASK_SOURCE_UNAVAILABLE', 503);
      const counts = Object.fromEntries(keys.map(key => [key, Number(rows[0][key])]));
      res.json({ success: true, ...counts, ...(!ready ? { operational_total: null } : {}),
        ...coverage(ready), timestamp: now() });
    } catch (error) { respondError(res, error); }
  };
  const mine = async (req, res) => {
    noStore(res);
    try {
      const actor = identity(req);
      if (!actor.canRead) throw fail('TASK_FORBIDDEN', 403);
      if (!compatible(req) || Object.keys(req.query || {}).some(key =>
        !['limit', 'offset', 'search', 'contract_version'].includes(key))) throw fail('TASK_INVALID');
      const limit = req.query.limit == null ? 25 : Number(req.query.limit);
      const offset = req.query.offset == null ? 0 : Number(req.query.offset);
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset)
        || offset < 0 || offset > 100000 || search.length > 240
        || (req.query.search != null && typeof req.query.search !== 'string')) throw fail('TASK_INVALID');
      if (!await sourceReady() || typeof referenceSource?.inspectForActor !== 'function') throw fail('TASK_SOURCE_UNAVAILABLE', 503);
      const refs = await referenceSource.inspectForActor({ tenantId: actor.tenant_id,
        actorId: actor.owner_user_id, permissions: [...actor.permissions], role: actor.role });
      const assignment = refs?.choices?.assignments?.[0];
      const projectIds = new Set(refs?.choices?.phases?.map(phase => phase.project_id));
      if (refs?.contract_version !== TASK_EXECUTION_CONTRACT_VERSION || refs.execution_catalogue_ready !== true
        || refs.choices.assignments.length !== 1 || projectIds.size !== 1
        || ![assignment?.assignee_agent_id, assignment?.function_id, assignment?.module, [...projectIds][0]]
          .every(value => typeof value === 'string' && value.length > 0)) throw fail('TASK_CONTEXT_SOURCE_UNAVAILABLE', 503);
      // Reuse the actor-bound catalogue and existing owner boundary, never historical display names.
      const [result] = await run(`WITH assigned AS (SELECT * FROM (${operational(false)})
        WHERE assignee_agent_id=@assignee_agent_id AND project_id=@project_id
          AND function_id=@function_id AND module=@module AND IFNULL(team_id,'')=@team_id),
        filtered AS (SELECT * FROM assigned WHERE @search='' OR STRPOS(LOWER(CONCAT(
          COALESCE(title,''),' ',COALESCE(reference,''),' ',COALESCE(module,''))),LOWER(@search))>0)
        SELECT (SELECT COUNT(*) FROM filtered) AS total,
          ARRAY(SELECT AS STRUCT * FROM filtered ORDER BY created_at DESC,id LIMIT @limit OFFSET @offset) AS items`,
      { ...paramsFor(actor), assignee_agent_id: assignment.assignee_agent_id, project_id: [...projectIds][0],
        function_id: assignment.function_id, module: assignment.module, team_id: assignment.team_id ?? '', search, limit, offset });
      const row = result[0];
      if (!row || !Array.isArray(row.items) || row.items.length > limit || row.total == null
        || !Number.isSafeInteger(Number(row.total)) || Number(row.total) < 0) throw fail('TASK_SOURCE_UNAVAILABLE', 503);
      const data = row.items.map(project);
      if (data.some(task => task.source_kind !== 'operational' || task.can_edit !== false
        || task.assignee_agent_id !== assignment.assignee_agent_id || task.project_id !== [...projectIds][0]
        || task.function_id !== assignment.function_id || task.module !== assignment.module
        || (task.team_id ?? '') !== (assignment.team_id ?? ''))
        || new Set(data.map(task => task.id)).size !== data.length) throw fail('TASK_SOURCE_UNAVAILABLE', 503);
      res.json({ success: true, scope: 'current_account_assignments', read_only: true,
        coverage: 'owned_and_assigned_registered_project', historical_included: false,
        assignment: { assignee_agent_id: assignment.assignee_agent_id, project_id: [...projectIds][0] },
        data, count: data.length, total: Number(row.total), limit, offset,
        contract_version: TASK_EXECUTION_CONTRACT_VERSION, timestamp: now() });
    } catch (error) { respondError(res, error); }
  };
  const fence = `UPDATE ${state} SET revision=revision+1 WHERE id='registry' AND contract_version=@contract_version;
    ASSERT @@row_count=1 AS 'TASK_SOURCE_UNAVAILABLE';`;
  const auditInsert = action => `INSERT INTO ${audit}
    (id,tenant_id,actor_user_id,actor_name,entity_type,entity_id,action,event_at,metadata_json)
    VALUES (@audit_id,@tenant_id,@owner_user_id,NULL,'task',@id,'${action}',TIMESTAMP(@event_at),@metadata_json);`;
  const sqlValue = f => f.type === 'DATE' ? `CAST(@${f.name} AS DATE)` : `@${f.name}`;
  const mutate = update => async (req, res) => {
    noStore(res);
    try {
      const actor = identity(req);
      if (!actor.canWrite) throw fail('TASK_FORBIDDEN', 403);
      let expected_revision;
      if (update && (!plain(req.body) || Object.keys(req.body).some(key => !['expected_revision', 'task'].includes(key))
        || !Number.isSafeInteger(req.body.expected_revision) || req.body.expected_revision < 1
        || !/^TASK-[a-f0-9]{64}$/.test(req.params?.id || ''))) throw fail('TASK_INVALID');
      const task = normalizeTask(update ? req.body.task : req.body, !update);
      if (update) expected_revision = req.body.expected_revision;
      if (!await sourceReady()) throw fail('TASK_SOURCE_UNAVAILABLE', 503);
      const bound = await bind(actor);
      if (!bound) throw fail('TASK_CONTEXT_SOURCE_UNAVAILABLE', 503);
      const context = await resolveTaskExecutionContext(task.execution_context,
        { tenantId: actor.tenant_id, catalogue: bound.catalogue });
      let assignment, sourcesAllowed;
      try {
        assignment = await bound.resolveAssignment({ assignee_agent_id: task.assignee_agent_id,
          team_id: task.team_id, function_id: task.function_id, module: task.module, context });
        sourcesAllowed = await bound.qualifySources({ source_links: task.source_links, source_origin: task.source_origin, context });
      } catch { throw fail('TASK_CONTEXT_SOURCE_UNAVAILABLE', 503); }
      if (!plain(assignment) || assignment.tenant_id !== actor.tenant_id || assignment.governance_status !== 'approved'
        || assignment.status !== 'active' || assignment.assignee_agent_id !== task.assignee_agent_id
        || (assignment.team_id ?? null) !== task.team_id || assignment.function_id !== task.function_id
        || assignment.module !== task.module || typeof assignment.agent_display_name !== 'string'
        || !assignment.agent_display_name.trim() || assignment.agent_display_name.length > 160
        || /[\x00-\x1f\x7f-\x9f]/.test(assignment.agent_display_name)
        || (context.function_id !== null && context.function_id !== task.function_id)) throw fail('TASK_ASSIGNMENT_UNQUALIFIED');
      if (sourcesAllowed !== true) throw fail('TASK_SOURCE_UNQUALIFIED');
      const reference_key = update ? '' : normalizeKey(task.reference);
      const id = update ? req.params.id : `TASK-${digest([TASK_EXECUTION_CONTRACT_VERSION, actor.tenant_id, reference_key])}`;
      const source_identity = task.source_origin === null ? null : digest([
        TASK_EXECUTION_CONTRACT_VERSION, actor.tenant_id, task.source_origin.kind, task.source_origin.reference
      ]);
      const data = { ...task, ...context, contract_version: TASK_EXECUTION_CONTRACT_VERSION,
        function_id: task.function_id, responsable: assignment.agent_display_name.trim(),
        context_key: digest([context, source_identity]), source_links_json: JSON.stringify(task.source_links),
        source_origin_json: JSON.stringify(task.source_origin), source_identity };
      const persisted = Object.fromEntries(DATA_NAMES.map(key => [key, data[key]]));
      const params = { ...persisted, id, ...paramsFor(actor), reference_key,
        payload_hash: digest(persisted), event_at: now(), audit_id: `AUD-${crypto.randomUUID()}`,
        metadata_json: JSON.stringify({ contract_version: TASK_EXECUTION_CONTRACT_VERSION, changed_fields: DATA_NAMES }) };
      const types = Object.fromEntries(DATA_FIELDS.map(f => [f.name, f.type === 'INTEGER' ? 'INT64' : 'STRING']));
      const [duplicates] = await withHistoricalFallback(fallback => run(`SELECT id FROM (${historical(fallback)})
        WHERE LOWER(REGEXP_REPLACE(NORMALIZE(TRIM(reference),NFKC),r'\\s+',' '))=@reference_key
          OR (@check_title AND LOWER(REGEXP_REPLACE(NORMALIZE(TRIM(title),NFKC),r'\\s+',' '))=@title_key) LIMIT 1`,
      { reference_key, title_key: normalizeKey(task.title), check_title: !task.execution_context.recurrence_id }));
      if (duplicates.length) throw fail('TASK_POTENTIAL_HISTORICAL_DUPLICATE', 409);
      const claimConflict = `tenant_id=@tenant_id AND id!=@id AND (reference_key=@reference_key
        OR (@occurrence_identity IS NOT NULL AND occurrence_identity=@occurrence_identity)
        OR (@source_identity IS NOT NULL AND source_identity=@source_identity))`;
      const replayName = update ? 'update_replayed' : 'replayed';
      let command;
      if (update) {
        command = `SET update_replayed=EXISTS(SELECT 1 FROM ${tasks} WHERE tenant_id=@tenant_id
          AND owner_user_id=@owner_user_id AND id=@id AND revision=@expected_revision+1 AND payload_hash=@payload_hash);
          IF NOT update_replayed THEN
            UPDATE ${tasks} SET ${DATA_FIELDS.map(f => `${f.name}=${sqlValue(f)}`).join(',')},
              payload_hash=@payload_hash,revision=revision+1,updated_at=TIMESTAMP(@event_at)
            WHERE tenant_id=@tenant_id AND owner_user_id=@owner_user_id AND id=@id
              AND revision=@expected_revision AND context_key=@context_key;
            ASSERT @@row_count=1 AS 'TASK_CONFLICT';
            ${auditInsert('update')}
          END IF;`;
      } else {
        command = `ASSERT (SELECT COUNT(*) FROM ${tasks} WHERE tenant_id=@tenant_id AND id=@id)<=1 AS 'TASK_SOURCE_UNAVAILABLE';
          SET replayed=EXISTS(SELECT 1 FROM ${tasks} WHERE tenant_id=@tenant_id AND id=@id);
          IF replayed THEN
            ASSERT EXISTS(SELECT 1 FROM ${tasks} WHERE tenant_id=@tenant_id AND owner_user_id=@owner_user_id
              AND id=@id AND payload_hash=@payload_hash) AS 'TASK_DUPLICATE_REFERENCE';
          ELSE
            INSERT INTO ${tasks} (id,tenant_id,owner_user_id,reference,reference_key,${DATA_NAMES.join(',')},revision,payload_hash,created_at,updated_at)
            VALUES (@id,@tenant_id,@owner_user_id,@reference,@reference_key,${DATA_FIELDS.map(sqlValue).join(',')},1,@payload_hash,TIMESTAMP(@event_at),TIMESTAMP(@event_at));
            ${auditInsert('create')}
          END IF;`;
      }
      const [rows] = await run(`DECLARE ${replayName} BOOL DEFAULT FALSE;
        BEGIN TRANSACTION;
        ${fence}
        ASSERT NOT EXISTS(SELECT 1 FROM ${tasks} WHERE ${claimConflict}) AS 'TASK_DUPLICATE_REFERENCE';
        ${command}
        CREATE TEMP TABLE task_result AS SELECT scoped.*, ${replayName} AS replayed
          FROM (${operational(true)}) scoped WHERE id=@id;
        COMMIT TRANSACTION;
        SELECT * FROM task_result;`, { ...params, ...(update ? { expected_revision } : { reference: task.reference }) }, types);
      if (rows.length !== 1 || typeof rows[0]?.replayed !== 'boolean'
        || Number(rows[0].revision) !== (update ? expected_revision + 1 : 1)) throw fail('TASK_SOURCE_UNAVAILABLE', 503);
      const { replayed, ...row } = rows[0];
      res.status(update || replayed ? 200 : 201).json({ success: true, data: project(row), replayed });
    } catch (error) { respondError(res, error); }
  };
  return { access, references, list, count, mine, create: mutate(false), update: mutate(true) };
}

module.exports = { TASK_TABLE_CONTRACTS, buildTaskRegistrySchemaPlan, buildTaskActivationSchemaProposal, normalizeTask, createTaskRegistryHandlers };
