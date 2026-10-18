const { ADMINISTRATION_TABLE_CONTRACTS, PERMISSIONS } = require('./administrationRegistries');
const { hasExpectedBigQueryTableContract } = require('./bigQueryTableContract');
const { normalizeTaskSourceLinks } = require('./taskExecutionContract');

// Existing Agenda source of the approved Standardisation I18N work group.
const I18N_CORRESPONDENCE_ID = 'COR-3bce2789-dc3d-4685-a008-14baba98ddd2';
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
      const read = async () => {
        const [metadata] = await bigquery.dataset(datasetId).table('administration_correspondence').getMetadata();
        if (metadata.type !== 'TABLE' || metadata.expirationTime || metadata.timePartitioning?.expirationMs
          || !hasExpectedBigQueryTableContract(metadata, ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence)) return false;
        const [rows] = await bigquery.query({ query: `SELECT id,tenant_id,confidentiality,direction,status,
            deleted_at IS NULL AS not_deleted
          FROM \`${projectId}.${datasetId}.administration_correspondence\`
          WHERE tenant_id=@tenant_id AND id=@source_id AND deleted_at IS NULL
            AND confidentiality IN ('public','internal') LIMIT 2`,
        params: { tenant_id: tenantId, source_id: I18N_CORRESPONDENCE_ID }, location, maximumBytesBilled: '10485760' });
        return rows.length === 1 && rows[0].id === I18N_CORRESPONDENCE_ID && rows[0].tenant_id === tenantId
          && ['public', 'internal'].includes(rows[0].confidentiality) && rows[0].direction === 'internal'
          && rows[0].not_deleted === true && ['to_qualify', 'to_file_dms', 'in_progress', 'closed'].includes(rows[0].status);
      };
      try { if (!await read()) return null; } catch { return null; }
      return {
        async qualifySources({ source_links, source_origin, context }) {
          if (context?.execution_kind !== 'project' || context.project_id !== executionProjectId) return false;
          let links, origin;
          try {
            links = normalizeTaskSourceLinks(source_links);
            origin = normalizeTaskSourceLinks([source_origin])[0];
          } catch { return false; }
          const allowed = link => link.kind === 'correspondence' && link.reference === I18N_CORRESPONDENCE_ID;
          if (!allowed(origin) || !links.every(allowed)) return false;
          // Re-read at mutation time; an earlier preview is never an authority.
          try { return await read(); } catch { return false; }
        }
      };
    }
  };
}

module.exports = { createStandardisationEvidenceQualifier, I18N_CORRESPONDENCE_ID };
