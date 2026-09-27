const { randomUUID } = require('node:crypto');
const { HASH, MAX_BYTES, SCAN_MAX_BYTES, fail } = require('./gedPrivatePolicy');

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

module.exports = { createRegister };
