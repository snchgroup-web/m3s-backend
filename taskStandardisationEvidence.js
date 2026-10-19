const { ADMINISTRATION_TABLE_CONTRACTS, PERMISSIONS } = require('./administrationRegistries');
const { hasExpectedBigQueryTableContract } = require('./bigQueryTableContract');
const { normalizeTaskSourceLinks } = require('./taskExecutionContract');

// Exact internal sources approved for this project; never a generic correspondence grant.
const I18N_CORRESPONDENCE_ID = 'COR-3bce2789-dc3d-4685-a008-14baba98ddd2';
const TOOLS_CORRESPONDENCE_ID = 'COR-0c2a6a1f-daa9-44c3-b4e5-32f41c1ae857';
const SOURCE_IDS = new Set([I18N_CORRESPONDENCE_ID, TOOLS_CORRESPONDENCE_ID]);
const validActor = value => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const nativeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(value);

function createStandardisationEvidenceQualifier({ bigquery, projectId, datasetId, location = 'US' }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId)
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId)) throw Error('TASK_INVALID_TARGET');
  return {
    async bindForActor({ tenantId, actorId, permissions, executionProjectId }) {
      if (tenantId !== '2sg' || !validActor(actorId) || !nativeId(executionProjectId)
        || !Array.isArray(permissions) || !permissions.includes(PERMISSIONS.RESOURCES_READ)
        || !permissions.includes(PERMISSIONS.CORRESPONDENCE_READ)) return null;
      const read = async (sourceId = I18N_CORRESPONDENCE_ID) => {
        const [metadata] = await bigquery.dataset(datasetId).table('administration_correspondence').getMetadata();
        if (metadata.type !== 'TABLE' || metadata.expirationTime || metadata.timePartitioning?.expirationMs
          || !hasExpectedBigQueryTableContract(metadata, ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence)) return false;
        const [rows] = await bigquery.query({ query: `SELECT id,tenant_id,confidentiality,direction,status,
            deleted_at IS NULL AS not_deleted
          FROM \`${projectId}.${datasetId}.administration_correspondence\`
          WHERE tenant_id=@tenant_id AND id=@source_id AND deleted_at IS NULL
            AND confidentiality IN ('public','internal') LIMIT 2`,
        params: { tenant_id: tenantId, source_id: sourceId }, location, maximumBytesBilled: '10485760' });
        return rows.length === 1 && rows[0].id === sourceId && rows[0].tenant_id === tenantId
          && ['public', 'internal'].includes(rows[0].confidentiality) && rows[0].direction === 'internal'
          && rows[0].not_deleted === true && ['to_qualify', 'to_file_dms', 'in_progress', 'closed'].includes(rows[0].status);
      };
      try { if (!await read()) return null; } catch { return null; }
      return {
        async readSourceOrigins() {
          const origins = [{ kind: 'correspondence', reference: I18N_CORRESPONDENCE_ID, label: 'TAC-M3S-I18N-20261015-001' }];
          try {
            if (await read(TOOLS_CORRESPONDENCE_ID)) origins.push({ kind: 'correspondence', reference: TOOLS_CORRESPONDENCE_ID,
              label: 'TAC-PROD-OUTILS-20261019-001' });
          } catch { /* Unavailable supplementary evidence must not replace the existing I18N source. */ }
          return origins;
        },
        async qualifySources({ source_links, source_origin, context }) {
          if (context?.execution_kind !== 'project' || context.project_id !== executionProjectId) return false;
          let links, origin;
          try {
            links = normalizeTaskSourceLinks(source_links);
            origin = normalizeTaskSourceLinks([source_origin])[0];
          } catch { return false; }
          const allowed = link => link.kind === 'correspondence' && SOURCE_IDS.has(link.reference)
            && link.reference === origin.reference;
          if (!allowed(origin) || !links.every(allowed)) return false;
          // Re-read at mutation time; an earlier preview is never an authority.
          try { return await read(origin.reference); } catch { return false; }
        }
      };
    }
  };
}

module.exports = { createStandardisationEvidenceQualifier, I18N_CORRESPONDENCE_ID, TOOLS_CORRESPONDENCE_ID };
