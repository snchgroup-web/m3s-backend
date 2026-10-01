const { randomUUID } = require('node:crypto');
const { HASH, MAX_BYTES, SCAN_MAX_BYTES, approvedDocument, categoryFor, fail } = require('./gedPrivatePolicy');

const EXPENSE_DOCUMENT_ROLES = Object.freeze([
  'invoice', 'payment_receipt', 'transfer_receipt', 'credit_note', 'other'
]);
const expenseLinkKeys = Object.freeze(['documentId', 'documentRole', 'externalReference', 'versionId']);

function validateExpenseDocumentLink(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !expenseLinkKeys.includes(key)) ||
      !HASH.test(value.documentId) || !HASH.test(value.versionId) ||
      !EXPENSE_DOCUMENT_ROLES.includes(value.documentRole)) fail('GED_INVALID_COMMAND');
  const externalReference = value.externalReference === undefined ? null : value.externalReference;
  if (externalReference !== null && (typeof externalReference !== 'string' ||
      externalReference !== externalReference.trim() || externalReference.length < 1 || externalReference.length > 140 ||
      /[\x00-\x1f\x7f<>]/.test(externalReference))) fail('GED_INVALID_COMMAND');
  return Object.freeze({ documentId: value.documentId, versionId: value.versionId,
    documentRole: value.documentRole, externalReference });
}

const publicExpenseLink = row => Object.freeze({
  expenseId: row.expense_id,
  documentId: row.document_id,
  versionId: row.document_version_id,
  documentRole: row.document_role,
  externalReference: row.external_reference,
  revision: Number(row.revision)
});

function createRegister(pool, { lifecyclePolicy, maxBytes = MAX_BYTES } = {}) {
  if (![MAX_BYTES, SCAN_MAX_BYTES].includes(maxBytes)) fail('GED_REGISTER_UNAVAILABLE');
  if (typeof pool?.connect !== 'function') fail('GED_REGISTER_UNAVAILABLE');
  async function transaction(scope, work) {
    if (!scope || !HASH.test(scope.tenant) || !HASH.test(scope.owner)) fail('GED_ACCESS_DENIED');
    let client, broken = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SELECT set_config('m3s.tenant', $1, true), set_config('m3s.owner', $2, true)", [scope.tenant, scope.owner]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
      }
      if (['GED_VERSION_CONFLICT','GED_INVALID_COMMAND','GED_INVALID_TITLE','GED_DOCUMENT_TRASHED','GED_DOCUMENT_NOT_TRASHED',
        'GED_REVISION_LIMIT','GED_VERSION_NOT_APPROVED','GED_VERSION_ALREADY_LINKED','GED_VERSION_NOT_ROOT','GED_NOT_FOUND','GED_DOCUMENT_NOT_APPROVED'].includes(error?.code)) throw error;
      fail('GED_REGISTER_UNAVAILABLE');
    } finally { client?.release(broken); }
  }
  const validate = (row, scope) => {
    if (!row || row.tenant !== scope.tenant || row.owner_id !== scope.owner || !HASH.test(row.document_id) ||
        typeof row.filename !== 'string' || !Number.isInteger(row.byte_size) || row.byte_size < 10 || row.byte_size > maxBytes ||
        typeof row.generation !== 'string' || !/^[1-9][0-9]{0,29}$/.test(row.generation)) fail('GED_REGISTER_UNAVAILABLE');
    return row;
  };
  const read = async (client, scope, id) => {
    const result = await client.query(`SELECT tenant, owner_id, document_id, filename, byte_size, generation, created_at
      FROM ged_private.documents WHERE tenant=$1 AND owner_id=$2 AND document_id=$3`, [scope.tenant, scope.owner, id]);
    if (result.rows.length > 1) fail('GED_REGISTER_UNAVAILABLE');
    return result.rows.length ? validate(result.rows[0], scope) : null;
  };
  const event = (client, scope, id, action) => client.query(`INSERT INTO ged_private.events
    (event_id, tenant, owner_id, document_id, action) VALUES ($1,$2,$3,$4,$5)`,
  [randomUUID(), scope.tenant, scope.owner, id, action]);

  return Object.freeze({
    attachExpenseDocument: lifecyclePolicy ? (scope, expense, candidate) => {
      const link = validateExpenseDocumentLink(candidate);
      if (!expense || typeof expense.source !== 'string' || expense.source.length < 1 || expense.source.length > 256 ||
          typeof expense.id !== 'string' || expense.id.trim() !== expense.id || expense.id.length < 1 || expense.id.length > 128) {
        fail('GED_NOT_FOUND');
      }
      const rootEntry = approvedDocument(lifecyclePolicy, link.documentId);
      const versionEntry = approvedDocument(lifecyclePolicy, link.versionId);
      if (categoryFor(rootEntry) !== 'finance' || categoryFor(versionEntry) !== 'finance') fail('GED_VERSION_NOT_APPROVED');
      return transaction(scope, async client => {
        // The same owner lock serializes lifecycle mutations and expense-link revisions.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope.tenant + scope.owner]);
        const root = await read(client, scope, link.documentId);
        const version = await read(client, scope, link.versionId);
        if (!root || !version) fail('GED_NOT_FOUND');
        const alias = await client.query(`SELECT 1 FROM ged_private.revisions
          WHERE tenant=$1 AND owner_id=$2 AND current_document_id=$3 AND document_id<>$3 LIMIT 1`,
        [scope.tenant, scope.owner, link.documentId]);
        if (alias.rows.length) fail('GED_VERSION_NOT_ROOT');
        const lifecycle = await client.query(`SELECT current_document_id, trashed FROM ged_private.revisions
          WHERE tenant=$1 AND owner_id=$2 AND document_id=$3 ORDER BY revision DESC LIMIT 1`,
        [scope.tenant, scope.owner, link.documentId]);
        const current = lifecycle.rows[0] || { current_document_id: link.documentId, trashed: false };
        if (current.trashed === true) fail('GED_DOCUMENT_TRASHED');
        if (current.current_document_id !== link.versionId) fail('GED_VERSION_CONFLICT');
        const latestResult = await client.query(`SELECT expense_id, document_id, document_version_id, revision,
          document_role, external_reference, action FROM ged_private.expense_document_links
          WHERE tenant=$1 AND owner_id=$2 AND expense_source=$3 AND expense_id=$4 AND document_id=$5
          ORDER BY revision DESC LIMIT 1`,
        [scope.tenant, scope.owner, expense.source, expense.id, link.documentId]);
        const latest = latestResult.rows[0];
        if (latest?.action === 'attach' && latest.document_version_id === link.versionId &&
            latest.document_role === link.documentRole && latest.external_reference === link.externalReference) {
          return { created: false, link: publicExpenseLink(latest) };
        }
        const revision = latest ? Number(latest.revision) + 1 : 1;
        if (!Number.isSafeInteger(revision) || revision > 10000) fail('GED_REVISION_LIMIT');
        const result = await client.query(`INSERT INTO ged_private.expense_document_links
          (tenant, owner_id, expense_source, expense_id, document_id, document_version_id,
           revision, action, document_role, external_reference)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'attach',$8,$9)
          RETURNING expense_id, document_id, document_version_id, revision, document_role, external_reference`,
        [scope.tenant, scope.owner, expense.source, expense.id, link.documentId, link.versionId,
          revision, link.documentRole, link.externalReference]);
        if (result.rows.length !== 1) fail('GED_REGISTER_UNAVAILABLE');
        return { created: true, link: publicExpenseLink(result.rows[0]) };
      });
    } : null,
    expenseLinks: (scope, source, id) => transaction(scope, async client => {
      if (typeof source !== 'string' || !source || source.length > 256 || typeof id !== 'string' || !id || id.length > 128) fail('GED_NOT_FOUND');
      return (await client.query(`SELECT * FROM (
        SELECT DISTINCT ON (document_id) document_id, document_version_id, revision, action, document_role, external_reference
        FROM ged_private.expense_document_links
        WHERE tenant=$1 AND owner_id=$2 AND expense_source=$3 AND expense_id=$4
        ORDER BY document_id, revision DESC
      ) latest WHERE action='attach' ORDER BY document_id LIMIT 100`, [scope.tenant, scope.owner, source, id])).rows;
    }),
    lifecycle: lifecyclePolicy ? require('./gedLifecycle').createLifecycle({ transaction, read, policy: lifecyclePolicy }) : null,
    list: scope => transaction(scope, async client => {
      const { rows } = await client.query(`SELECT tenant, owner_id, document_id, filename, byte_size, generation, created_at
        FROM ged_private.documents WHERE tenant=$1 AND owner_id=$2 ORDER BY created_at, document_id LIMIT 100`, [scope.tenant, scope.owner]);
      return rows.map(row => validate(row, scope));
    }),
    read(scope, id) {
      if (!HASH.test(id)) fail('GED_DOCUMENT_NOT_APPROVED');
      return transaction(scope, client => read(client, scope, id));
    },
    create(scope, entry, generation) {
      if (!entry || !HASH.test(entry.sha256) || typeof generation !== 'string' || !/^[1-9][0-9]{0,29}$/.test(generation)) fail('GED_REGISTER_UNAVAILABLE');
      return transaction(scope, async client => {
        const result = await client.query(`INSERT INTO ged_private.documents
          (tenant, owner_id, document_id, filename, byte_size, generation) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (tenant, owner_id, document_id) DO NOTHING RETURNING document_id`,
        [scope.tenant, scope.owner, entry.sha256, entry.name, entry.size, generation]);
        const row = await read(client, scope, entry.sha256);
        if (!row || row.filename !== entry.name || row.byte_size !== entry.size || row.generation !== generation) fail('GED_REGISTER_UNAVAILABLE');
        if (result.rowCount === 1) await event(client, scope, entry.sha256, 'import');
        return { row, created: result.rowCount === 1 };
      });
    },
    auditDownload: (scope, id) => transaction(scope, client => event(client, scope, id, 'download'))
  });
}

module.exports = { EXPENSE_DOCUMENT_ROLES, validateExpenseDocumentLink, createRegister };
