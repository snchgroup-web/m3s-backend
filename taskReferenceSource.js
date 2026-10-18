const { PERMISSIONS } = require('./administrationRegistries');
const { SERVICE_SOURCE_TYPES } = require('./managementPortfolio');
const seed = require('./referentiels/managementPortfolioSeed.json');
const { readDirectoryDocument, validateDirectoryDocument, isRoleAllowed } = require('./rh001Directory');
const { TASK_EXECUTION_CONTRACT_VERSION } = require('./taskExecutionContract');
const { createStandardisationReferenceReader } = require('./taskStandardisationReferences');
const { createStandardisationEvidenceQualifier, I18N_CORRESPONDENCE_ID } = require('./taskStandardisationEvidence');

const unavailable = status => ({ status, data: [] });
const text = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 2000 && !/[\x00-\x1f\x7f-\x9f]/.test(value);

// Existing documentary catalogues are not executable project/assignment records.
function createTaskReferenceSource({ bigquery, projectId, datasetId, location = 'US',
  directoryPath, directoryEnabled = false, directoryAllowedRoles = new Set(),
  readDirectory = readDirectoryDocument, activationEnabled = false }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId)
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId)) throw new Error('TASK_INVALID_TARGET');
  const dossierIds = Object.keys(SERVICE_SOURCE_TYPES);
  const executable = createStandardisationReferenceReader({ bigquery, projectId, datasetId, location });
  const evidenceSource = createStandardisationEvidenceQualifier({ bigquery, projectId, datasetId, location });
  const loadForActor = async ({ tenantId, actorId, permissions, role }) => {
      if (!tenantId || !actorId || !Array.isArray(permissions) || !permissions.includes(PERMISSIONS.RESOURCES_READ)) {
        throw Object.assign(new Error('TASK_FORBIDDEN'), { code: 'TASK_FORBIDDEN', status: 403 });
      }
      let dossiers = unavailable('unavailable'), members = unavailable('forbidden');
      try {
        const [rows] = await bigquery.query({ query: `SELECT tenant_id, portfolio_id, dossier_id, dossier_type,
            display_title, confidentiality, status, record_status, source_ref, verified_on
          FROM \`${projectId}.${datasetId}.management_dossiers\`
          WHERE tenant_id=@tenant_id AND portfolio_id=@portfolio_id AND dossier_id IN UNNEST(@dossier_ids)
            AND confidentiality='internal' AND record_status='validated_for_integration'
          ORDER BY dossier_id LIMIT 5`,
        params: { tenant_id: tenantId, portfolio_id: seed.portfolio.portfolio_id, dossier_ids: dossierIds }, location });
        const seen = new Set();
        const data = rows.map(row => {
          const date = row.verified_on?.value || row.verified_on;
          if (row.tenant_id !== tenantId || row.portfolio_id !== seed.portfolio.portfolio_id
            || !dossierIds.includes(row.dossier_id) || seen.has(row.dossier_id)
            || row.dossier_type !== SERVICE_SOURCE_TYPES[row.dossier_id]
            || row.confidentiality !== 'internal' || row.record_status !== 'validated_for_integration'
            || !text(row.display_title) || !text(row.source_ref) || !text(row.status)
            || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
            || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
            || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw Error('invalid');
          seen.add(row.dossier_id);
          return { id: row.dossier_id, label: row.display_title, portfolio_id: row.portfolio_id,
            source_reference: row.source_ref, verified_on: date, status: row.status };
        });
        dossiers = { status: 'available', data, source: 'management_dossiers', read_only: true };
      } catch { /* An unavailable catalogue is not an empty, qualified one. */ }
      if (directoryEnabled && tenantId === '2sg' && isRoleAllowed(role, directoryAllowedRoles)) {
        try {
          const doc = validateDirectoryDocument(await readDirectory(directoryPath));
          members = { status: 'available', source: 'rh001-directory-v1', read_only: true,
            verified_on: doc.approved_on,
            data: doc.records.filter(r => r.active).map(r => ({ id: r.person_id,
              label: r.display_name, team_id: r.team, position: r.position })) };
        } catch { members = unavailable('unavailable'); }
      }
      let execution = { status: 'unavailable' };
      try {
        execution = await executable.readForActor({ tenantId, actorId, permissions, dossiers, members });
      } catch { /* An absent registration never becomes a client-side catalogue. */ }
      const ready = execution.status === 'available';
      const evidence = ready ? await evidenceSource.bindForActor({ tenantId, actorId, permissions,
        executionProjectId: execution.choices.phases[0].project_id }) : null;
      const canBind = activationEnabled === true && Boolean(evidence) && permissions.includes(PERMISSIONS.RESOURCES_WRITE);
      return { execution, evidence, response: { contract_version: TASK_EXECUTION_CONTRACT_VERSION,
        sources: { dossiers, members, execution_references: { status: execution.status,
          data: [], scope: 'standardisation_project_only', read_only: true } },
        choices: ready ? execution.choices : { phases: [], activities: [], operational_plans: [], assignments: [], recurrences: [] },
        source_origins: evidence ? [{ kind: 'correspondence', reference: I18N_CORRESPONDENCE_ID,
          label: 'TAC-M3S-I18N-20261015-001' }] : [],
        execution_scope: 'standardisation_project_only', execution_catalogue_ready: ready,
        source_resolution_ready: Boolean(evidence), activation_enabled: activationEnabled === true, writes_enabled: canBind,
        missing: ready ? (evidence ? [] : ['canonical_source_resolution'])
          : ['project_phases', 'operational_plans', 'governed_assignments', 'canonical_source_resolution'] } };
  };
  return {
    async inspectForActor(actor) { return (await loadForActor(actor)).response; },
    async bindForActor(actor) {
      if (activationEnabled !== true || !Array.isArray(actor?.permissions)
        || !actor.permissions.includes(PERMISSIONS.RESOURCES_WRITE)) return null;
      try {
        const loaded = await loadForActor(actor);
        if (!loaded.response.writes_enabled) return null;
        return { contract_version: TASK_EXECUTION_CONTRACT_VERSION, writes_enabled: true,
          catalogue: loaded.execution.catalogue, resolveAssignment: loaded.execution.resolveAssignment,
          qualifySources: loaded.evidence.qualifySources };
      } catch { return null; }
    }
  };
}

module.exports = { createTaskReferenceSource };
