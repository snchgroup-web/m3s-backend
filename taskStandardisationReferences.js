const { hasExpectedBigQueryTableContract } = require('./bigQueryTableContract');
const { PERMISSIONS } = require('./administrationRegistries');

// Source identities are not native IDs. The approved decision keeps its IDs null.
const DECISION_SHA256 = '694647f4a699774c46ddb1066aa9bc5442713c4be1b5718f0bc06551b01c2597';
const SOURCE_KEY = 'standardisation/2026-10-18';
const PROJECT_TITLE = 'Standardisation des modules m\u00e9tier M3S';
const PHASES = Object.freeze([
  ['Cadrage et contrat commun', 'Perimetre, champs, branches, responsabilites et criteres valides'],
  ['Adaptation et raccordement', 'Contrat applicatif, registre et indicateurs raccordes sans doublons'],
  ['Verification et livraison', 'Controles cibles, sauvegarde avant migration, revue et persistance verifiee apres livraison autorisee'],
  ['Stabilisation et capitalisation', 'Ecarts traites/transferts explicites, GED et competence actualisees, cloture humaine sur preuves']
].map(Object.freeze));
const field = (name, type = 'STRING') => ({ name, type, mode: 'REQUIRED' });
const common = ['id', 'tenant_id', 'source_key', 'governance_status', 'status',
  'approval_sha256', 'registration_reference'].map(n => field(n));
const STANDARDISATION_TABLE_CONTRACTS = Object.freeze({
  management_projects: { fields: [...common, field('dossier_id'), field('label')],
    clustering: ['tenant_id', 'source_key'] },
  management_project_phases: { fields: [...common, field('project_id'), field('phase_order', 'INTEGER'),
    field('label'), field('exit_criterion')], clustering: ['tenant_id', 'project_id'] },
  management_task_assignments: { fields: [...common, ...['project_id', 'actor_user_id',
    'assignee_agent_id', 'team_id', 'function_id', 'module'].map(n => field(n))],
    clustering: ['tenant_id', 'actor_user_id', 'project_id'] }
});
const emptyChoices = () => ({ phases: [], activities: [], operational_plans: [], assignments: [], recurrences: [] });
const unavailable = (status = 'unavailable') => ({ status, choices: emptyChoices() });
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(v);
const proof = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 500
  && !/[\x00-\x1f\x7f-\x9f]/.test(v);
const actor = v => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 200
  && !/[\x00-\x1f\x7f-\x9f]/.test(v);

function buildStandardisationRegistrationPreparation() {
  const prepared = source => ({ id: null, tenant_id: '2sg', source_key: `${SOURCE_KEY}/${source}`,
    governance_status: 'prepared_not_registered', status: 'inactive',
    approval_sha256: DECISION_SHA256, registration_reference: null });
  return { statements: [], application_allowed: false, tables: Object.keys(STANDARDISATION_TABLE_CONTRACTS),
    project: { ...prepared('project'), dossier_id: 'GD-006', label: PROJECT_TITLE },
    phases: PHASES.map(([label, exit_criterion], index) => ({ ...prepared(`phases/${index + 1}`),
      project_id: null, phase_order: index + 1, label, exit_criterion })),
    assignment: { ...prepared('pilot'), project_id: null, actor_user_id: null,
      assignee_agent_id: 'PER-2SG-0001', team_id: 'TZH', function_id: 'management_governance', module: 'ADMINISTRATION' },
    pending: ['controlled_backup_and_catalogue_schema_approval', 'canonical_ids_and_exact_source_collision_check',
      'governed_actor_project_assignment_and_registration_proof', 'canonical_evidence_resolution_and_live_verification'] };
}

function createStandardisationReferenceReader({ bigquery, projectId, datasetId, location = 'US' }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId)
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId)) throw Error('TASK_INVALID_TARGET');
  const table = name => `\`${projectId}.${datasetId}.${name}\``;
  const run = async (name, where, params, limit) => {
    const columns = STANDARDISATION_TABLE_CONTRACTS[name].fields.map(f => f.name).join(',');
    const [rows] = await bigquery.query({ query: `SELECT ${columns} FROM ${table(name)} WHERE ${where} LIMIT ${limit}`,
      params, location, maximumBytesBilled: '33554432' });
    return rows;
  };
  return {
    async readForActor({ tenantId, actorId, permissions, dossiers, members }) {
      if (tenantId !== '2sg' || !actor(actorId) || !Array.isArray(permissions)
        || !permissions.includes(PERMISSIONS.RESOURCES_READ) || members?.status === 'forbidden') return unavailable('forbidden');
      const dossier = dossiers?.status === 'available' && dossiers.data.find(d => d.id === 'GD-006');
      const person = members?.status === 'available' && members.data.find(p => p.id === 'PER-2SG-0001');
      if (!dossier || dossier.status !== 'active' || dossier.portfolio_id !== 'PORT-2SG-GLOBAL'
        || !person || person.label !== 'Cheikh Ndiaye' || person.team_id !== 'TZH') return unavailable();
      try {
        for (const [name, contract] of Object.entries(STANDARDISATION_TABLE_CONTRACTS)) {
          const [metadata] = await bigquery.dataset(datasetId).table(name).getMetadata();
          if (metadata.type !== 'TABLE' || !hasExpectedBigQueryTableContract(metadata, contract) || metadata.expirationTime
            || metadata.timePartitioning?.expirationMs) return unavailable();
        }
        const params = { tenant_id: tenantId, project_source: `${SOURCE_KEY}/project` };
        const projects = await run('management_projects', 'tenant_id=@tenant_id AND source_key=@project_source', params, 2);
        const qualified = (r, source) => r && id(r.id) && r.tenant_id === tenantId
          && r.source_key === `${SOURCE_KEY}/${source}` && r.governance_status === 'approved'
          && r.status === 'active' && r.approval_sha256 === DECISION_SHA256 && proof(r.registration_reference);
        if (projects.length !== 1 || !qualified(projects[0], 'project')
          || projects[0].dossier_id !== dossier.id || projects[0].label !== PROJECT_TITLE) return unavailable();
        const project = projects[0];
        const scope = { tenant_id: tenantId, project_id: project.id };
        const phases = await run('management_project_phases', 'tenant_id=@tenant_id AND project_id=@project_id', scope, 5);
        if (phases.length !== 4) return unavailable();
        const ordered = [];
        for (let i = 0; i < PHASES.length; i++) {
          const found = phases.filter(r => String(r.phase_order?.value ?? r.phase_order) === String(i + 1));
          if (found.length !== 1 || !qualified(found[0], `phases/${i + 1}`)
            || found[0].project_id !== project.id || found[0].label !== PHASES[i][0]
            || found[0].exit_criterion !== PHASES[i][1]) return unavailable();
          ordered.push(found[0]);
        }
        const assignments = await run('management_task_assignments',
          'tenant_id=@tenant_id AND project_id=@project_id AND actor_user_id=@actor_user_id',
          { ...scope, actor_user_id: actorId }, 2);
        if (assignments.length !== 1) return unavailable();
        const assignment = assignments[0];
        if (!qualified(assignment, 'pilot') || assignment.project_id !== project.id
          || assignment.actor_user_id !== actorId || assignment.assignee_agent_id !== person.id
          || assignment.team_id !== person.team_id || assignment.function_id !== 'management_governance'
          || assignment.module !== 'ADMINISTRATION') return unavailable();
        const [parents] = await bigquery.query({ query: `SELECT tenant_id,portfolio_id,function_id,status,confidentiality
          FROM ${table('management_portfolios')} WHERE tenant_id=@tenant_id AND portfolio_id=@portfolio_id LIMIT 2`,
        params: { tenant_id: tenantId, portfolio_id: dossier.portfolio_id }, location, maximumBytesBilled: '10485760' });
        if (parents.length !== 1 || parents[0].tenant_id !== tenantId || parents[0].portfolio_id !== dossier.portfolio_id
          || parents[0].function_id !== assignment.function_id || parents[0].status !== 'active'
          || parents[0].confidentiality !== 'internal') return unavailable();
        const records = [project, ...ordered, assignment];
        if (new Set(records.map(r => r.id)).size !== records.length) return unavailable();
        const governed = record => ({ ...record, tenant_id: tenantId, governance_status: 'approved', status: 'active' });
        const catalogues = { portfolio: [governed({ id: dossier.portfolio_id })],
          dossier: [governed({ id: dossier.id, portfolio_id: dossier.portfolio_id })], project: [project], phase: ordered };
        return { status: 'available', scope: 'standardisation_project_only',
          choices: { ...emptyChoices(), phases: ordered.map(r => ({ id: r.id, label: r.label,
            project_id: project.id, dossier_id: dossier.id, portfolio_id: dossier.portfolio_id })),
          assignments: [{ id: assignment.id, label: person.label, assignee_agent_id: person.id,
            team_id: person.team_id, function_id: assignment.function_id, module: assignment.module }] },
          catalogue: { async get(kind, nativeId, tenant) {
            const row = tenant === tenantId && catalogues[kind]?.find(r => r.id === nativeId);
            return row ? { ...row } : null;
          } },
          async resolveAssignment(input) {
            const same = input?.context?.project_id === project.id && input.context.execution_kind === 'project'
              && ordered.some(p => p.id === input.context.phase_id)
              && ['assignee_agent_id', 'team_id', 'function_id', 'module'].every(k => input[k] === assignment[k]);
            return same ? { ...assignment, agent_display_name: person.label } : null;
          } };
      } catch { return unavailable(); }
    }
  };
}

module.exports = { createStandardisationReferenceReader, buildStandardisationRegistrationPreparation,
  STANDARDISATION_TABLE_CONTRACTS, DECISION_SHA256 };
