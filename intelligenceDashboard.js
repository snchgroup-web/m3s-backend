const crypto = require('crypto');

const TABLE_ID = 'intelligence_dashboard_editions';
const ARTIFACT_FIELDS = {
  html: 'html_content',
  pdf: 'pdf_base64',
  reference: 'reference_content'
};
const TABLE_SCHEMA = [
  { name: 'edition_date', type: 'STRING', mode: 'REQUIRED' },
  { name: 'generated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'published_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'source_version', type: 'STRING', mode: 'REQUIRED' },
  { name: 'html_content', type: 'STRING', mode: 'REQUIRED' },
  { name: 'pdf_base64', type: 'STRING', mode: 'REQUIRED' },
  { name: 'reference_content', type: 'STRING', mode: 'REQUIRED' },
  { name: 'html_sha256', type: 'STRING', mode: 'REQUIRED' },
  { name: 'pdf_sha256', type: 'STRING', mode: 'REQUIRED' },
  { name: 'reference_sha256', type: 'STRING', mode: 'REQUIRED' }
];

const hasExpectedTableSchema = metadata => {
  const fields = metadata?.schema?.fields;
  return Array.isArray(fields)
    && fields.length === TABLE_SCHEMA.length
    && TABLE_SCHEMA.every((expected, index) => {
      const actual = fields[index];
      return actual?.name === expected.name
        && String(actual.type || '').toUpperCase() === expected.type
        && String(actual.mode || 'NULLABLE').toUpperCase() === expected.mode;
    });
};

const assertExpectedTableSchema = async table => {
  const [metadata] = await table.getMetadata();
  if (hasExpectedTableSchema(metadata)) return;
  const error = new Error('Intelligence Dashboard schema is invalid');
  error.code = 'INTELLIGENCE_SCHEMA_INVALID';
  throw error;
};

const sha256 = (value) => crypto
  .createHash('sha256')
  .update(value)
  .digest('hex');

const isPublishKeyValid = (providedKey, configuredKey) => {
  if (!providedKey || !configuredKey) return false;
  const provided = Buffer.from(String(providedKey));
  const configured = Buffer.from(String(configuredKey));
  return provided.length === configured.length && crypto.timingSafeEqual(provided, configured);
};

const normalizePublication = (payload = {}) => {
  const editionDate = String(payload.editionDate || '').trim();
  const generatedAt = String(payload.generatedAt || '').trim();
  const sourceVersion = String(payload.sourceVersion || 'V4').trim();
  const html = String(payload.html || '');
  const pdfBase64 = String(payload.pdfBase64 || '');
  const reference = String(payload.reference || '');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(editionDate)) {
    throw new Error('editionDate doit utiliser le format YYYY-MM-DD');
  }
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error('generatedAt doit être une date ISO valide');
  }
  if (!html.toLowerCase().includes('<html')) {
    throw new Error('Le livrable HTML est invalide');
  }
  if (!pdfBase64 || !Buffer.from(pdfBase64, 'base64').subarray(0, 4).equals(Buffer.from('%PDF'))) {
    throw new Error('Le livrable PDF est invalide');
  }
  if (!reference.trim()) {
    throw new Error('Le référentiel est requis');
  }

  return {
    editionDate,
    generatedAt: new Date(generatedAt).toISOString(),
    sourceVersion,
    html,
    pdfBase64,
    reference,
    htmlSha256: sha256(html),
    pdfSha256: sha256(pdfBase64),
    referenceSha256: sha256(reference)
  };
};

const ensureIntelligenceDashboardSchema = async ({ bigquery, datasetId, location }) => {
  const table = bigquery.dataset(datasetId).table(TABLE_ID);
  const [exists] = await table.exists();
  if (exists) {
    await assertExpectedTableSchema(table);
    return { created: false, table: TABLE_ID };
  }
  try {
    await bigquery.dataset(datasetId).createTable(TABLE_ID, { schema: TABLE_SCHEMA, location });
    return { created: true, table: TABLE_ID };
  } catch (error) {
    if (!String(error?.message || '').toLowerCase().includes('already exists')) throw error;
    await assertExpectedTableSchema(table);
    return { created: false, table: TABLE_ID };
  }
};

const createIntelligenceDashboardRepository = ({ bigquery, projectId, datasetId, location }) => {
  const table = bigquery.dataset(datasetId).table(TABLE_ID);
  const tableName = `\`${projectId}.${datasetId}.${TABLE_ID}\``;

  const requireTable = async () => {
    const [exists] = await table.exists();
    if (!exists) {
      const error = new Error('Intelligence Dashboard schema is missing');
      error.code = 'INTELLIGENCE_SCHEMA_MISSING';
      throw error;
    }
    await assertExpectedTableSchema(table);
  };

  const publish = async (payload) => {
    const publication = normalizePublication(payload);
    await requireTable();
    await bigquery.query({
      location,
      query: `
        MERGE ${tableName} AS target
        USING (SELECT @editionDate AS edition_date) AS source
        ON target.edition_date = source.edition_date
        WHEN MATCHED THEN UPDATE SET
          generated_at = TIMESTAMP(@generatedAt),
          published_at = CURRENT_TIMESTAMP(),
          source_version = @sourceVersion,
          html_content = @html,
          pdf_base64 = @pdfBase64,
          reference_content = @reference,
          html_sha256 = @htmlSha256,
          pdf_sha256 = @pdfSha256,
          reference_sha256 = @referenceSha256
        WHEN NOT MATCHED THEN INSERT (
          edition_date, generated_at, published_at, source_version,
          html_content, pdf_base64, reference_content,
          html_sha256, pdf_sha256, reference_sha256
        ) VALUES (
          @editionDate, TIMESTAMP(@generatedAt), CURRENT_TIMESTAMP(), @sourceVersion,
          @html, @pdfBase64, @reference,
          @htmlSha256, @pdfSha256, @referenceSha256
        )
      `,
      params: publication
    });
    return {
      editionDate: publication.editionDate,
      generatedAt: publication.generatedAt,
      sourceVersion: publication.sourceVersion,
      htmlSha256: publication.htmlSha256,
      pdfSha256: publication.pdfSha256,
      referenceSha256: publication.referenceSha256
    };
  };

  const getLatestMetadata = async () => {
    await requireTable();
    const [rows] = await bigquery.query({
      location,
      query: `
        SELECT
          edition_date AS editionDate,
          generated_at AS generatedAt,
          published_at AS publishedAt,
          source_version AS sourceVersion,
          html_sha256 AS htmlSha256,
          pdf_sha256 AS pdfSha256,
          reference_sha256 AS referenceSha256,
          BYTE_LENGTH(html_content) AS htmlBytes,
          BYTE_LENGTH(FROM_BASE64(pdf_base64)) AS pdfBytes,
          BYTE_LENGTH(reference_content) AS referenceBytes
        FROM ${tableName}
        ORDER BY generated_at DESC
        LIMIT 1
      `
    });
    return rows[0] || null;
  };

  const getLatestArtifact = async (artifactType) => {
    const field = ARTIFACT_FIELDS[artifactType];
    if (!field) throw new Error('Type de livrable non pris en charge');
    await requireTable();
    const [rows] = await bigquery.query({
      location,
      query: `
        SELECT edition_date AS editionDate, source_version AS sourceVersion, ${field} AS content
        FROM ${tableName}
        ORDER BY generated_at DESC
        LIMIT 1
      `
    });
    return rows[0] || null;
  };

  return { requireTable, publish, getLatestMetadata, getLatestArtifact };
};

module.exports = {
  TABLE_ID,
  TABLE_SCHEMA,
  hasExpectedTableSchema,
  createIntelligenceDashboardRepository,
  ensureIntelligenceDashboardSchema,
  isPublishKeyValid,
  normalizePublication
};
